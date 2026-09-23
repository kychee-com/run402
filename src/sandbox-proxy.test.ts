import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { run402 as createNodeSdk } from "../sdk/dist/node/index.js";
import { ChainHost, sdkPrivateMembers } from "./sandbox-proxy.js";
import { runInSandbox } from "./sandbox.js";

const API = "https://test-api.run402.com";
let tempDir: string;
let requests: Array<{ method: string; url: string }>;

/** A hermetic provider: project keys for prj_1 and prj_active, an active project, no wallet. */
function credentials() {
  const keys = { anon_key: "anon-test", service_key: "service-test" };
  return {
    getAuth: async () => ({ "SIGN-IN-WITH-X": "test-siwx" }),
    getProject: async (id: string) => (id === "prj_1" || id === "prj_active" ? keys : null),
    getActiveProject: async () => "prj_active",
  };
}

function client(fetchImpl: typeof fetch) {
  return createNodeSdk({ surface: "sandbox", apiBase: API, credentials: credentials(), fetch: fetchImpl });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const recordingFetch: typeof fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  requests.push({ method: init?.method ?? "GET", url });
  if (/\/projects\/v1\/admin\/prj_[a-z0-9_]+\/functions$/.test(new URL(url).pathname)) {
    const project = new URL(url).pathname.split("/")[4];
    return jsonResponse({ functions: [{ name: `fn-of-${project}`, runtime: "node22" }] });
  }
  if (new URL(url).pathname.endsWith("/tiers/v1/prototype")) {
    return jsonResponse({ error: "payment required", code: "PAYMENT_REQUIRED" }, 402);
  }
  return jsonResponse({ error: "not found", code: "NOT_FOUND" }, 404);
}) as typeof fetch;

async function runChain(code: string, fetchImpl: typeof fetch = recordingFetch) {
  const host = new ChainHost(client(fetchImpl));
  const outcome = await runInSandbox({ code, timeoutMs: 10_000, extensions: [host.extension()] });
  return { outcome, host, value: outcome.value_json === undefined ? undefined : JSON.parse(outcome.value_json) };
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "run402-sandbox-proxy-test-"));
  process.env.RUN402_CONFIG_DIR = tempDir;
  requests = [];
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
  delete process.env.RUN402_CONFIG_DIR;
});

describe("chain replay", () => {
  it("replays a scoped chain on the host and returns the SDK's JSON", async () => {
    const { outcome, host, value } = await runChain('return await r.project("prj_1").functions.list()');
    assert.equal(outcome.status, "ok", JSON.stringify(outcome.error));
    assert.deepEqual(value.functions.map((f: { name: string }) => f.name), ["fn-of-prj_1"]);
    assert.equal(host.calls.length, 1);
    assert.equal(host.calls[0]!.path, "project.functions.list");
    assert.equal(host.calls[0]!.ok, true);
    assert.equal(requests.length, 1);
  });

  it("carries a non-JSON intermediate as a handle and resolves the next chain through it", async () => {
    const { outcome, host, value } = await runChain("const p = await r.project();\nreturn await p.functions.list()");
    assert.equal(outcome.status, "ok", JSON.stringify(outcome.error));
    assert.deepEqual(value.functions.map((f: { name: string }) => f.name), ["fn-of-prj_active"]);
    assert.deepEqual(host.calls.map((c) => c.path), ["project", "project.functions.list"]);
  });

  it("returns an un-awaited chain as the last expression", async () => {
    const { value } = await runChain('r.project("prj_1").functions.list()');
    assert.equal(value.functions.length, 1);
  });

  it("lets a snippet compose several calls", async () => {
    const { value, host } = await runChain(
      'const [a, b] = await Promise.all([r.project("prj_1").functions.list(), r.project("prj_active").functions.list()]);\n' +
      "[...a.functions, ...b.functions].map((f) => f.name)",
    );
    assert.deepEqual(value, ["fn-of-prj_1", "fn-of-prj_active"]);
    assert.equal(host.calls.length, 2);
  });
});

describe("errors cross intact", () => {
  it("passes an SDK error through with its code and next_actions, and marks the call", async () => {
    const { outcome, host } = await runChain(
      "try { await r.project('prj_1').functions.list(); } catch (e) { return 'unexpected' }\n" +
      "await r.tier.set('prototype')",
    );
    assert.equal(outcome.status, "error");
    const failing = host.calls.find((c) => !c.ok);
    assert.ok(failing, "the failing call is marked");
    assert.equal(failing!.path, "tier.set");
    const original = host.errorFor(outcome.error?.thrown?.error_ref) as { code?: string } | undefined;
    assert.ok(original, "the original SDK error is retrievable by its ref");
    assert.equal(original!.code, outcome.error?.thrown?.code);
  });

  it("lets the snippet read code and next_actions on a caught SDK error", async () => {
    const { value } = await runChain(
      "try { await r.project('prj_1').grants.create({ wallet: '0x1111111111111111111111111111111111111111', capability: 'deploy', key: true }); }\n" +
      "catch (e) { return { code: e.code, next_actions: e.next_actions } }",
    );
    assert.equal(value.code, "SECRET_REQUIRES_CLI");
    assert.equal(value.next_actions.length, 1);
    assert.equal(value.next_actions[0].type, "run_cli_command");
    assert.equal(
      value.next_actions[0].command,
      "run402 grants create 0x1111111111111111111111111111111111111111 --capability deploy --key --project prj_1",
    );
  });

  it("passes SECRET_REQUIRES_CLI through before any request", async () => {
    const { outcome, host } = await runChain(
      "await r.project('prj_1').grants.create({ wallet: '0x1111111111111111111111111111111111111111', capability: 'deploy', key: true })",
    );
    assert.equal(outcome.status, "error");
    assert.equal(outcome.error?.thrown?.code, "SECRET_REQUIRES_CLI");
    assert.equal(requests.length, 0, "no request was made");
    assert.deepEqual(host.calls.map((c) => [c.path, c.ok, c.code]), [["project.grants.create", false, "SECRET_REQUIRES_CLI"]]);
  });
});

describe("arguments", () => {
  it("refuses a function argument before any request, naming it", async () => {
    const { outcome, host } = await runChain("await r.project('prj_1').functions.list({ onEvent() {} })");
    assert.equal(outcome.status, "error");
    assert.equal(outcome.error?.thrown?.code, "RUN_ARGUMENT_NOT_CLONEABLE");
    assert.match(outcome.error?.message ?? "", /argument 1\.onEvent/);
    assert.equal(host.calls.length, 0);
    assert.equal(requests.length, 0);
  });

  it("refuses an un-awaited chain and a class instance", async () => {
    for (const code of ["await r.project(r.projects.list())", "await r.project(new URL('https://a.example'))"]) {
      const { outcome } = await runChain(code);
      assert.equal(outcome.error?.thrown?.code, "RUN_ARGUMENT_NOT_CLONEABLE", code);
    }
  });

  it("carries undefined, Date, bytes, Map, and Set across", async () => {
    let seen: unknown[] = [];
    const host = new ChainHost({ echo: { take: (...args: unknown[]) => { seen = args; return "ok"; } } });
    const outcome = await runInSandbox({
      code: "await r.echo.take(undefined, new Date(0), new Uint8Array([1, 2]), new Map([['a', 1]]), new Set([2]), 3n)",
      timeoutMs: 5_000,
      extensions: [host.extension()],
    });
    assert.equal(outcome.status, "ok");
    assert.equal(seen[0], undefined);
    assert.ok(seen[1] instanceof Date && (seen[1] as Date).getTime() === 0);
    assert.deepEqual(seen[2], new Uint8Array([1, 2]));
    assert.deepEqual(seen[3], new Map([["a", 1]]));
    assert.deepEqual(seen[4], new Set([2]));
    assert.equal(seen[5], 3n);
  });
});

describe("the replay walks only the public SDK surface", () => {
  const refused = [
    ["the host Function constructor", "await r.constructor.constructor('return process')()"],
    ["a prototype walk", "await r.projects.__proto__"],
    ["the kernel client", "await r.projects.client"],
    ["a private helper that returns a service key", "await r.email.webhooks.resolveMailbox('prj_1')"],
    ["an internal engine", "await r._applyEngine"],
    ["Function.prototype.call", "await r.projects.list.call"],
    ["Object.prototype members", "await r.projects.hasOwnProperty('list')"],
  ] as const;
  for (const [what, code] of refused) {
    it(`refuses ${what}`, async () => {
      const { outcome } = await runChain(code);
      assert.equal(outcome.status, "error", code);
      assert.equal(outcome.error?.code, "RUN_EXCEPTION", code);
      assert.match(outcome.error?.message ?? "", /not part of the SDK surface|private to the SDK/, code);
      assert.equal(requests.length, 0);
    });
  }

  it("reads private member names from the SDK's declaration files", () => {
    const privates = sdkPrivateMembers();
    assert.ok(privates.get("Projects")?.has("client"));
    assert.ok(privates.get("Webhooks")?.has("resolveMailbox"));
  });

  it("navigates returned data by its own properties only", async () => {
    const { value } = await runChain("await r.project('prj_1').functions.list().functions[0].name");
    assert.equal(value, "fn-of-prj_1");
  });
});
