/**
 * `functions.<name>.tools` through the isomorphic deploy engine.
 *
 * This file never loads `@run402/sdk/node`, so no source reader is installed:
 * `tools` is data the caller passes, checked before any request and forwarded
 * as written. (The Node entry's reading of a function's source is covered by
 * `node/tool-lift.test.ts`.)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { Deploy } from "./deploy.js";
import { isDeployError } from "../errors.js";
import { installedFunctionToolLifter } from "../function-tools.js";
import type { Client, RequestOptions } from "../kernel.js";
import type { FunctionToolSpec, PlanResponse, ReleaseSpec } from "./deploy.types.js";

interface Recorded {
  path: string;
  body?: unknown;
}

function wiring(plan: Record<string, unknown> = {}): { deploy: Deploy; requests: Recorded[] } {
  const requests: Recorded[] = [];
  const client = {
    apiBase: "https://test.run402.test",
    request: async <T>(path: string, opts: RequestOptions): Promise<T> => {
      requests.push({ path, body: opts.body });
      if (path.startsWith("/apply/v1/plans")) {
        return { plan_id: "plan_1", operation_id: "op_1", base_release_id: null, manifest_digest: "d", missing_content: [], diff: {}, warnings: [], ...plan } as T;
      }
      throw new Error(`unexpected ${path}`);
    },
    getProjectCredentials: async () => ({ anon_key: "ak", service_key: "sk" }),
    credentials: { getAuth: async () => null, getProjectCredentials: async () => ({ anon_key: "ak", service_key: "sk" }) },
    fetch: (async () => new Response("")) as typeof globalThis.fetch,
  } as unknown as Client;
  return { deploy: new Deploy(client), requests };
}

type PlannedFunctions = { replace?: Record<string, { tools?: unknown }>; patch?: { set?: Record<string, { tools?: unknown }> } };
function plannedFunctions(requests: Recorded[]): PlannedFunctions {
  const planned = requests.find((req) => req.path.startsWith("/apply/v1/plans"));
  assert.ok(planned, "expected a plan request");
  return (planned.body as { spec: { functions: PlannedFunctions } }).spec.functions;
}

const SOURCE = `export const tool = { description: "Declared in source.", input: { type: "object" } };\nexport default async () => new Response("ok");`;
const LIST: FunctionToolSpec = { name: "list_notes", description: "List notes.", input: { type: "object", properties: { tag: { type: "string" } } }, method: "GET", path: "/api/notes" };
const ADD: FunctionToolSpec = { name: "add_note", title: "Add", description: "Add a note.", input: { type: "object" }, annotations: { destructiveHint: false } };

async function refusal(spec: ReleaseSpec): Promise<{ code: string | undefined; resource: string | null; requests: number; details: unknown; message: string }> {
  const { deploy, requests } = wiring();
  try {
    await deploy.plan(spec);
  } catch (err) {
    assert.ok(isDeployError(err), String(err));
    return { code: err.code, resource: err.resource, requests: requests.length, details: err.details, message: err.message };
  }
  assert.fail("expected the plan to be refused");
}

describe("functions.<name>.tools as data", () => {
  it("has no source reader installed in the isomorphic entry", () => {
    assert.equal(installedFunctionToolLifter(), null);
  });

  it("forwards `tools` as written, on replace and on patch.set", async () => {
    const { deploy, requests } = wiring();
    await deploy.plan({
      project_id: "prj_test",
      functions: {
        replace: { ssr: { source: "export default 1;", tools: [LIST, ADD] } },
        patch: { set: { cron: { source: "export default 2;", tools: [] } } },
      },
    });
    const fns = plannedFunctions(requests);
    assert.deepEqual(fns.replace?.ssr?.tools, [LIST, ADD]);
    assert.deepEqual(fns.patch?.set?.cron?.tools, []);
  });

  it("sends no `tools` when the caller names none: an export in the source is not read here", async () => {
    const { deploy, requests } = wiring();
    await deploy.plan({ project_id: "prj_test", functions: { replace: { api: { source: SOURCE } } } });
    assert.equal("tools" in (plannedFunctions(requests).replace?.api ?? {}), false);
  });

  it("refuses `tools` that is not an array", async () => {
    const r = await refusal({ project_id: "prj_test", functions: { replace: { api: { source: SOURCE, tools: { a: LIST } as never } } } });
    assert.equal(r.code, "INVALID_SPEC");
    assert.equal(r.resource, "functions.replace.api.tools");
    assert.equal(r.requests, 0);
  });

  it("refuses a bad entry with the gateway's code, before any request", async () => {
    const cases: Array<[Record<string, unknown>, string, string]> = [
      [{ input: { type: "object" } }, "MCP_TOOL_SCHEMA_INVALID", "functions.replace.api.tools[0].description"],
      [{ description: "d", input: { type: "array" } }, "MCP_TOOL_SCHEMA_INVALID", "functions.replace.api.tools[0].input.type"],
      [{ description: "d", input: { type: "object" }, inputSchema: {} }, "MCP_TOOL_SCHEMA_INVALID", "functions.replace.api.tools[0].inputSchema"],
      [{ description: "d", input: { type: "object" }, method: "HEAD" }, "MCP_TOOL_SCHEMA_INVALID", "functions.replace.api.tools[0].method"],
      [{ description: "d", input: { type: "object" }, annotations: { readOnlyHint: 1 } }, "MCP_TOOL_SCHEMA_INVALID", "functions.replace.api.tools[0].annotations.readOnlyHint"],
      [{ name: "has space", description: "d", input: { type: "object" } }, "MCP_TOOL_NAME_INVALID", "functions.replace.api.tools[0].name"],
      [{ description: "d", input: { type: "object" }, path: "/files/*" }, "MCP_TOOL_PATH_UNSUPPORTED", "functions.replace.api.tools[0].path"],
    ];
    for (const [entry, code, fieldPath] of cases) {
      const r = await refusal({ project_id: "prj_test", functions: { replace: { api: { source: SOURCE, tools: [entry as never] } } } });
      assert.equal(r.code, code, JSON.stringify(entry));
      assert.equal((r.details as { field_path?: string }).field_path, fieldPath);
      assert.equal((r.details as { function?: string }).function, "api");
      assert.equal(r.requests, 0);
    }
  });

  it("refuses two tools of one spec that share a name, naming both functions", async () => {
    const r = await refusal({
      project_id: "prj_test",
      functions: {
        replace: { search: { source: SOURCE, tools: [{ description: "Unnamed: takes the function name.", input: { type: "object" } }] } },
        patch: { set: { portal: { source: SOURCE, tools: [LIST, { ...ADD, name: "search" }] } } },
      },
    });
    assert.equal(r.code, "MCP_TOOL_NAME_DUPLICATE");
    assert.equal(r.resource, "functions.portal.tools.search");
    assert.deepEqual((r.details as { functions?: string[] }).functions, ["search", "portal"]);
    assert.match(r.message, /`search` and `portal`/);
    assert.equal(r.requests, 0);
  });
});

describe("plan responses carry the tools bucket", () => {
  const bucket = { added: ["add_note"], removed: [], changed: ["list_notes"] };

  it("folds the flat envelope's `tools` into `diff.tools`", async () => {
    const { deploy } = wiring({
      kind: "plan_response",
      is_noop: false,
      summary: "1 tool added",
      functions: { added: [], removed: [], changed: [{ name: "ssr", fields_changed: ["tools"] }] },
      tools: bucket,
    });
    const { plan } = await deploy.plan({ project_id: "prj_test", functions: { replace: { ssr: { source: "export default 1;", tools: [LIST, ADD] } } } });
    assert.deepEqual((plan as PlanResponse).diff.tools, bucket);
    assert.deepEqual(plan.tools, bucket);
    assert.deepEqual(plan.diff.functions?.changed[0]?.fields_changed, ["tools"]);
  });

  it("reads a bucket nested under `diff` the same way", async () => {
    const { deploy } = wiring({ kind: "plan_response", is_noop: false, summary: "", diff: { tools: bucket } });
    const { plan } = await deploy.plan({ project_id: "prj_test", functions: { replace: { ssr: { source: "export default 1;", tools: [LIST] } } } });
    assert.deepEqual(plan.diff.tools, bucket);
  });

  it("leaves `diff.tools` off when the gateway sends none", async () => {
    const { deploy } = wiring({ kind: "plan_response", is_noop: true, summary: "" });
    const { plan } = await deploy.plan({ project_id: "prj_test", functions: { replace: { ssr: { source: "export default 1;", tools: [] } } } });
    assert.equal("tools" in plan.diff, false);
  });
});
