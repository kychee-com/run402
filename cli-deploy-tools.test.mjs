/**
 * `run402 deploy` and a function's MCP tools.
 *
 * A function file declares its tools beside the handler; the deploy reads the
 * export by parsing the source and sends it as `functions.<name>.tools`. The
 * plan then shows what would change (`diff.tools`), and a declaration that
 * cannot be carried fails here, before any request.
 */
import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const tempDir = mkdtempSync(join(tmpdir(), "run402-cli-tools-"));
const API = "https://test-api.run402.com";
process.env.RUN402_CONFIG_DIR = tempDir;
process.env.RUN402_API_BASE = API;

const originalFetch = globalThis.fetch;
const originalLog = console.log;
const originalError = console.error;
const originalExit = process.exit;
const ciEnvKeys = ["GITHUB_ACTIONS", "ACTIONS_ID_TOKEN_REQUEST_URL", "ACTIONS_ID_TOKEN_REQUEST_TOKEN", "RUN402_GRANT_KEY"];
let stdout = [];
let stderr = [];
let calls = [];
let planResponse = null;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

function plan(extra = {}) {
  return {
    kind: "plan_response",
    schema_version: "agent-deploy-observability.v1",
    plan_id: "plan_tools",
    operation_id: null,
    base_release_id: "rel_base",
    manifest_digest: "b".repeat(64),
    plan_fingerprint: "run402-reviewed-plan-v1:" + "a".repeat(64),
    plan_expires_at: "2026-11-16T13:00:00.000Z",
    is_noop: false,
    summary: "2 tools added",
    warnings: [],
    expected_events: [],
    missing_content: [],
    payment_required: null,
    migrations: { new: [], noop: [] },
    site: { added: [], removed: [], changed: [] },
    functions: { added: [], removed: [], changed: [{ name: "portal", fields_changed: ["code_hash", "tools"] }] },
    secrets: { added: [], removed: [] },
    subdomains: { added: [], removed: [] },
    routes: { added: [], removed: [], changed: [] },
    ...extra,
  };
}

async function mockFetch(input, init) {
  const url = typeof input === "string" ? input : input instanceof Request ? input.url : String(input);
  const method = (init?.method || (input instanceof Request ? input.method : "GET") || "GET").toUpperCase();
  const parsed = new URL(url);
  const path = parsed.origin === API ? `${parsed.pathname}${parsed.search}` : url;
  const rawBody = input instanceof Request ? await input.clone().text().catch(() => undefined) : init?.body;
  const body = typeof rawBody === "string" && rawBody.length > 0 ? JSON.parse(rawBody) : rawBody;
  calls.push({ method, path, body });
  if (path === "/apply/v1/plans" && method === "POST") return json(planResponse ?? plan(), 201);
  return json({ ok: true });
}

function capture() {
  stdout = [];
  stderr = [];
  console.log = (...args) => stdout.push(args.map(String).join(" "));
  console.error = (...args) => stderr.push(args.map(String).join(" "));
  const previous = new Map(ciEnvKeys.map((key) => [key, process.env[key]]));
  for (const key of ciEnvKeys) delete process.env[key];
  return () => {
    console.log = originalLog;
    console.error = originalError;
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

async function succeed(fn) {
  const restore = capture();
  try {
    await fn();
  } catch (err) {
    err.message = `${err.message}\nstdout:\n${stdout.join("\n")}\nstderr:\n${stderr.join("\n")}`;
    throw err;
  } finally {
    restore();
  }
  return JSON.parse(stdout.join("\n"));
}

async function failExit1(fn) {
  const restore = capture();
  let threw = null;
  try {
    await fn();
  } catch (err) {
    threw = err;
  } finally {
    restore();
  }
  assert.equal(threw?.message, "process.exit(1)", `stdout:\n${stdout.join("\n")}\nstderr:\n${stderr.join("\n")}`);
  const line = stderr.filter((s) => s.trim().startsWith("{")).find((s) => JSON.parse(s).status === "error");
  assert.ok(line, `expected a JSON error on stderr, got: ${stderr.join("\n")}`);
  return JSON.parse(line);
}

function writeApp(root, functions) {
  mkdirSync(join(root, "functions"), { recursive: true });
  const replace = {};
  for (const [name, source] of Object.entries(functions)) {
    writeFileSync(join(root, "functions", `${name}.ts`), source);
    replace[name] = { source: { path: `functions/${name}.ts` } };
  }
  const manifestPath = join(root, "run402.json");
  writeFileSync(manifestPath, JSON.stringify({
    project_id: "prj_test123",
    functions: { replace },
    routes: { replace: Object.keys(functions).map((name) => ({ pattern: `/api/${name}`, methods: ["POST"], target: { type: "function", name } })) },
  }, null, 2));
  return manifestPath;
}

const PORTAL = `import type { ToolDeclarations } from "@run402/functions";

export const tools = {
  list_events: {
    description: "List the portal's upcoming events.",
    input: { type: "object", properties: { limit: { type: "integer" } } },
    annotations: { readOnlyHint: true },
  },
  create_event: {
    description: "Create an event.",
    input: { type: "object", properties: { title: { type: "string" } }, required: ["title"] },
  },
} satisfies ToolDeclarations;

export default async (req: Request) => Response.json({ tool: req.headers.get("x-run402-mcp-tool") });
`;

before(async () => {
  globalThis.fetch = mockFetch;
  process.exit = (code) => { throw new Error(`process.exit(${code})`); };
  const { saveProject, setActiveProjectId } = await import("./cli/core-dist/keystore.js");
  saveProject("prj_test123", { anon_key: "anon_test_key", service_key: "svc_test_key" });
  setActiveProjectId("prj_test123");
  const { saveWallet } = await import("./cli/lib/config.mjs");
  saveWallet({
    address: "0x0000000000000000000000000000000000000001",
    privateKey: "0x" + "11".repeat(32),
    rail: "x402",
    funded: true,
    created: "2026-06-30T00:00:00.000Z",
  });
});

after(() => {
  globalThis.fetch = originalFetch;
  console.log = originalLog;
  console.error = originalError;
  process.exit = originalExit;
  delete process.env.RUN402_CONFIG_DIR;
  delete process.env.RUN402_API_BASE;
  rmSync(tempDir, { recursive: true, force: true });
});

beforeEach(() => {
  calls = [];
  planResponse = null;
});

describe("run402 deploy carries a function's MCP tools", () => {
  it("--plan sends the tools read from the source and prints diff.tools", async () => {
    const root = mkdtempSync(join(tmpdir(), "run402-cli-tools-app-"));
    try {
      const manifestPath = writeApp(root, { portal: PORTAL, plain: `export default async () => new Response("ok");\n` });
      planResponse = plan({ tools: { added: ["list_events", "create_event"], removed: [], changed: [] } });
      const { run } = await import("./cli/lib/deploy.mjs");
      const printed = await succeed(() => run(["--manifest", manifestPath, "--plan"]));

      const planned = calls.filter((call) => call.path === "/apply/v1/plans");
      assert.equal(planned.length, 1);
      const fns = planned[0].body.spec.functions.replace;
      assert.deepEqual(fns.portal.tools, [
        {
          name: "list_events",
          description: "List the portal's upcoming events.",
          input: { type: "object", properties: { limit: { type: "integer" } } },
          annotations: { readOnlyHint: true },
        },
        {
          name: "create_event",
          description: "Create an event.",
          input: { type: "object", properties: { title: { type: "string" } }, required: ["title"] },
        },
      ]);
      assert.deepEqual(fns.plain.tools, [], "a source that declares no tool sends tools: []");

      assert.deepEqual(printed.diff.tools, { added: ["list_events", "create_event"], removed: [], changed: [] });
      assert.deepEqual(printed.diff.functions.changed, [{ name: "portal", fields_changed: ["code_hash", "tools"] }]);
      assert.equal(calls.some((call) => /\/commit$/.test(call.path)), false, "--plan must not commit");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("sends `tools` written in the manifest as written, without reading the source for them", async () => {
    const root = mkdtempSync(join(tmpdir(), "run402-cli-tools-data-"));
    try {
      const manifestPath = writeApp(root, { portal: PORTAL });
      const stated = [{ name: "from_manifest", method: "POST", path: "/api/portal", description: "Carried as data.", input: { type: "object" } }];
      const manifest = JSON.parse((await import("node:fs")).readFileSync(manifestPath, "utf8"));
      manifest.functions.replace.portal.tools = stated;
      writeFileSync(manifestPath, JSON.stringify(manifest));
      const { run } = await import("./cli/lib/deploy.mjs");
      await succeed(() => run(["--manifest", manifestPath, "--plan"]));
      const planned = calls.find((call) => call.path === "/apply/v1/plans");
      assert.deepEqual(planned.body.spec.functions.replace.portal.tools, stated);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails before any gateway call on a declaration that is not static, naming the file and the line", async () => {
    const root = mkdtempSync(join(tmpdir(), "run402-cli-tools-bad-"));
    try {
      const manifestPath = writeApp(root, {
        report: `const schema = { type: "object" };\nexport const tool = {\n  description: "Run the report.",\n  input: schema,\n};\nexport default async () => new Response("ok");\n`,
      });
      const { run } = await import("./cli/lib/deploy.mjs");
      const err = await failExit1(() => run(["--manifest", manifestPath, "--plan"]));
      assert.equal(err.code, "MCP_TOOL_NOT_STATIC");
      assert.equal(err.resource, "functions.report.tools");
      assert.equal(err.details.function, "report");
      assert.equal(err.details.file, join(root, "functions", "report.ts"));
      assert.equal(err.details.line, 4);
      assert.equal(err.details.field_path, "tool.input");
      assert.equal(err.next_actions[0].type, "edit_request");
      assert.equal(err.next_actions[0].line, 4);
      assert.match(err.message, /`schema` refers to a variable/);
      assert.equal(calls.some((call) => call.path.startsWith("/apply/")), false, "nothing is sent");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("surfaces a gateway refusal of a tool unchanged: code, resource and edit_request", async () => {
    const root = mkdtempSync(join(tmpdir(), "run402-cli-tools-422-"));
    const previous = globalThis.fetch;
    try {
      const manifestPath = writeApp(root, { portal: PORTAL });
      globalThis.fetch = async (input, init) => {
        const url = typeof input === "string" ? input : input instanceof Request ? input.url : String(input);
        if (new URL(url).pathname === "/apply/v1/plans") {
          return json({
            error: "Tool `list_events` names a request nothing answers.",
            message: "Tool `list_events` names a request nothing answers.",
            code: "MCP_TOOL_ROUTE_MISSING",
            category: "validation",
            retryable: false,
            resource: "functions.portal.tools.list_events",
            details: { function: "portal", tool: "list_events" },
            next_actions: [{ type: "edit_request", why: "Give the function one exact POST route, or name a path it answers." }],
          }, 422);
        }
        return previous(input, init);
      };
      const { run } = await import("./cli/lib/deploy.mjs");
      const err = await failExit1(() => run(["--manifest", manifestPath, "--plan"]));
      assert.equal(err.code, "MCP_TOOL_ROUTE_MISSING");
      assert.equal(err.resource, "functions.portal.tools.list_events");
      assert.equal(err.next_actions[0].type, "edit_request");
      assert.equal(err.details.tool, "list_events");
    } finally {
      globalThis.fetch = previous;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
