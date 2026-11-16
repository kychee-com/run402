/**
 * `@run402/sdk/node` fills `functions.<name>.tools` from every function
 * source a deploy reads, and fails before any request on a declaration it
 * cannot carry. Loading the Node entry is what installs the reader.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Deploy, isDeployError, normalizeDeployManifest } from "./index.js";
import { installedFunctionToolLifter } from "../function-tools.js";
import type { Client, RequestOptions } from "../kernel.js";
import type { ReleaseSpec } from "../namespaces/deploy.types.js";

interface Recorded {
  path: string;
  body?: unknown;
}

function wiring(): { deploy: Deploy; requests: Recorded[] } {
  const requests: Recorded[] = [];
  const client = {
    apiBase: "https://test.run402.test",
    request: async <T>(path: string, opts: RequestOptions): Promise<T> => {
      requests.push({ path, body: opts.body });
      if (path.startsWith("/apply/v1/plans")) {
        return { plan_id: "plan_1", operation_id: "op_1", base_release_id: null, manifest_digest: "d", missing_content: [], diff: {}, warnings: [] } as T;
      }
      throw new Error(`unexpected ${path}`);
    },
    getProjectCredentials: async () => ({ anon_key: "ak", service_key: "sk" }),
    credentials: { getAuth: async () => null, getProjectCredentials: async () => ({ anon_key: "ak", service_key: "sk" }) },
    fetch: (async () => new Response("")) as typeof globalThis.fetch,
  } as unknown as Client;
  return { deploy: new Deploy(client), requests };
}

type Planned = Record<string, Record<string, unknown>>;
async function plannedFunctions(spec: ReleaseSpec, target: "replace" | "set" = "replace"): Promise<Planned> {
  const { deploy, requests } = wiring();
  await deploy.plan(spec);
  const planned = requests.find((req) => req.path.startsWith("/apply/v1/plans"));
  assert.ok(planned, "expected a plan request");
  const fns = (planned.body as { spec: { functions: { replace?: Planned; patch?: { set?: Planned } } } }).spec.functions;
  return (target === "replace" ? fns.replace : fns.patch?.set) ?? {};
}

const ONE = `import type { ToolDeclaration } from "@run402/functions";
export const tool = {
  description: "Cancel one of the caller's bookings.",
  input: { type: "object", properties: { booking_id: { type: "string" } }, required: ["booking_id"] },
} satisfies ToolDeclaration;
export default async (req: Request) => new Response("ok");
`;
const SEVERAL = `export const tools = {
  list_events: { description: "List events.", input: { type: "object" } },
  create_event: { description: "Create an event.", input: { type: "object", properties: { title: { type: "string" } }, required: ["title"] } },
};
export default async (req) => new Response("ok");
`;
const NONE = `export default async (req) => new Response("ok");\n`;

let dir: string;
before(() => {
  dir = mkdtempSync(join(tmpdir(), "run402-tool-lift-"));
});
after(() => {
  rmSync(dir, { recursive: true, force: true });
});

function fileSource(name: string, content: string): { __source: "fs-file"; path: string } {
  const path = join(dir, name);
  writeFileSync(path, content);
  return { __source: "fs-file", path };
}

describe("@run402/sdk/node reads a function's tools from its source", () => {
  it("installs the reader when the Node entry loads", () => {
    assert.equal(typeof installedFunctionToolLifter(), "function");
  });

  it("sends one entry, as written, for a file with one `tool`", async () => {
    const fns = await plannedFunctions({ project_id: "prj_test", functions: { replace: { cancel: { source: ONE } } } });
    assert.equal(
      JSON.stringify(fns.cancel!.tools),
      JSON.stringify([{
        description: "Cancel one of the caller's bookings.",
        input: { type: "object", properties: { booking_id: { type: "string" } }, required: ["booking_id"] },
      }]),
    );
  });

  it("sends one entry per key for a file with `tools`", async () => {
    const fns = await plannedFunctions({ project_id: "prj_test", functions: { replace: { portal: { source: SEVERAL } } } });
    assert.equal(
      JSON.stringify(fns.portal!.tools),
      JSON.stringify([
        { name: "list_events", description: "List events.", input: { type: "object" } },
        { name: "create_event", description: "Create an event.", input: { type: "object", properties: { title: { type: "string" } }, required: ["title"] } },
      ]),
    );
  });

  it("sends `tools: []` for a source that declares none", async () => {
    const fns = await plannedFunctions({ project_id: "prj_test", functions: { replace: { plain: { source: NONE } } } });
    assert.deepEqual(fns.plain!.tools, []);
  });

  it("reads a source file, bytes, a wrapped source, and a patch.set entry", async () => {
    const fns = await plannedFunctions({
      project_id: "prj_test",
      functions: {
        patch: {
          set: {
            from_file: { source: fileSource("cancel.ts", ONE) },
            from_bytes: { source: new TextEncoder().encode(SEVERAL) },
            wrapped: { source: { data: NONE, contentType: "text/javascript; charset=utf-8" } },
          },
        },
      },
    }, "set");
    assert.equal((fns.from_file!.tools as unknown[]).length, 1);
    assert.deepEqual((fns.from_bytes!.tools as Array<{ name: string }>).map((t) => t.name), ["list_events", "create_event"]);
    assert.deepEqual(fns.wrapped!.tools, []);
  });

  it("reads the entrypoint of a multi-file function", async () => {
    const fns = await plannedFunctions({
      project_id: "prj_test",
      functions: {
        replace: {
          multi: { files: { "lib/util.mjs": "export const tool = 1;", "index.mjs": fileSource("index.mjs", SEVERAL) }, entrypoint: "index.mjs" },
        },
      },
    });
    assert.deepEqual((fns.multi!.tools as Array<{ name: string }>).map((t) => t.name), ["list_events", "create_event"]);
  });

  it("sends a stated `tools` as written and does not read the source for it", async () => {
    const stated = [{ name: "from_spec", description: "Carried as data.", input: { type: "object" } }];
    const fns = await plannedFunctions({
      project_id: "prj_test",
      functions: { replace: { a: { source: ONE, tools: stated }, b: { source: `export const tool = notStatic();`, tools: [] } } },
    });
    assert.deepEqual(fns.a!.tools, stated);
    assert.deepEqual(fns.b!.tools, []);
  });

  it("sends no `tools` for a source it does not read, or an entry with no source", async () => {
    const fns = await plannedFunctions({
      project_id: "prj_test",
      functions: {
        patch: {
          set: {
            in_cas: { source: { sha256: "a".repeat(64), size: 10 } },
            schedule_only: { triggers: [{ type: "schedule", cron: "0 9 * * *" }] },
          },
        },
      },
    }, "set");
    assert.equal("tools" in fns.in_cas!, false);
    assert.equal("tools" in fns.schedule_only!, false);
  });

  it("fails before any request on a declaration that is not static, with the file and the line", async () => {
    const { deploy, requests } = wiring();
    const source = fileSource("report.ts", `const schema = { type: "object" };\nexport const tool = {\n  description: "d",\n  input: schema,\n};\n`);
    await assert.rejects(
      deploy.apply({ project_id: "prj_test", functions: { replace: { report: { source } } } }),
      (err: unknown) => {
        assert.ok(isDeployError(err));
        assert.equal(err.code, "MCP_TOOL_NOT_STATIC");
        assert.equal(err.resource, "functions.report.tools");
        assert.deepEqual(err.details, { function: "report", file: source.path, line: 4, field_path: "tool.input" });
        assert.equal(err.nextActions?.[0]?.type, "edit_request");
        assert.ok(err.message.includes(`${source.path}:4`));
        return true;
      },
    );
    assert.deepEqual(requests, []);
  });

  it("names the spec field for an inline source", async () => {
    const { deploy, requests } = wiring();
    await assert.rejects(
      deploy.plan({ project_id: "prj_test", functions: { patch: { set: { api: { source: `export const tool = { description: "d" };` } } } } }),
      (err: unknown) => {
        assert.ok(isDeployError(err));
        assert.equal(err.code, "MCP_TOOL_SCHEMA_INVALID");
        assert.ok(err.message.includes("functions.patch.set.api.source:1"));
        assert.deepEqual(err.details, { function: "api", file: null, source_field: "functions.patch.set.api.source", line: 1, field_path: "tool.input" });
        return true;
      },
    );
    assert.deepEqual(requests, []);
  });

  it("refuses two functions whose sources declare the same tool name", async () => {
    const { deploy, requests } = wiring();
    await assert.rejects(
      deploy.plan({
        project_id: "prj_test",
        functions: {
          replace: {
            list_events: { source: `export const tool = { description: "d", input: { type: "object" } };` },
            portal: { source: SEVERAL },
          },
        },
      }),
      (err: unknown) => isDeployError(err) && err.code === "MCP_TOOL_NAME_DUPLICATE" && /`list_events` and `portal`/.test(err.message),
    );
    assert.deepEqual(requests, []);
  });
});

describe("the manifest adapter accepts `tools`", () => {
  it("carries `tools` written in a manifest onto the function entry", async () => {
    const stated = [{ name: "list_notes", method: "GET", path: "/api/notes", description: "List notes.", input: { type: "object" } }];
    const { spec } = await normalizeDeployManifest({
      project_id: "prj_test",
      functions: { replace: { api: { source: { data: NONE }, tools: stated } } },
    } as never);
    assert.deepEqual(spec.functions?.replace?.api?.tools, stated);
  });

  it("leaves `tools` off an entry that names none, so a deploy reads the source", async () => {
    const { spec } = await normalizeDeployManifest({ project_id: "prj_test", functions: { replace: { api: { source: { data: ONE } } } } } as never);
    assert.equal("tools" in (spec.functions?.replace?.api ?? {}), false);
    const fns = await plannedFunctions(spec);
    assert.equal((fns.api!.tools as unknown[]).length, 1);
  });

  it("refuses `tools` that is not an array", async () => {
    await assert.rejects(
      normalizeDeployManifest({ project_id: "prj_test", functions: { replace: { api: { source: { data: NONE }, tools: {} } } } } as never),
      /tools must be an array/,
    );
  });
});
