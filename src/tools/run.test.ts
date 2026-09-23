import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { handleRun, RUN_MAX_CONCURRENT, type RunResult } from "./run.js";
import { _resetResultStore, expandResult } from "../result-store.js";
import { _resetSdk } from "../sdk.js";
import { runOutputSchema, toolErrorSchema } from "../structured.js";

const originalFetch = globalThis.fetch;
const originalConsoleError = console.error;
let tempDir: string;
let requests: Array<{ url: string; headers: Headers }>;
let stderr: string[];

/** A well-known test key (never funded); only its address is read here. */
const TEST_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const TEST_ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

/**
 * The envelope a run printed. Every call also checks the structured channel:
 * `structuredContent` is the same object as the fenced JSON, and it satisfies
 * the declared output schema (and, on failure, the shared error schema).
 */
function envelope(result: { content: Array<{ text: string }>; structuredContent?: Record<string, unknown>; isError?: boolean }): RunResult {
  const text = result.content[0]!.text;
  const blocks = [...text.matchAll(/```json\n([\s\S]*?)\n```/g)];
  const parsed = JSON.parse(blocks[blocks.length - 1]![1]!) as RunResult;
  assert.deepEqual(result.structuredContent, parsed, "structuredContent is the fenced envelope");
  runOutputSchema.parse(result.structuredContent);
  if (parsed.status === "error") {
    assert.equal(result.isError, true);
    toolErrorSchema.parse(parsed.error);
  }
  return parsed;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function mockGateway(opts: { delayMs?: number } = {}): void {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    // Only gateway traffic is recorded; the paid-fetch wrapper's chain RPC reads are not the snippet's.
    if (!url.startsWith("https://test-api.run402.com/")) {
      const rpc = typeof init?.body === "string" ? JSON.parse(init.body) as { id?: unknown } : {};
      return jsonResponse({ jsonrpc: "2.0", id: rpc.id ?? 1, result: "0x0" });
    }
    requests.push({ url, headers: new Headers(init?.headers) });
    if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
    const path = new URL(url).pathname;
    if (path === "/projects/v1/admin/prj_1/functions") {
      return jsonResponse({ functions: [{ name: "hello", runtime: "node22" }, { name: "cron", runtime: "node22" }] });
    }
    return jsonResponse({ error: "No such thing", code: "NOT_FOUND", next_actions: [{ type: "check_usage", why: "test" }] }, 404);
  }) as typeof fetch;
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "run402-run-tool-test-"));
  process.env.RUN402_CONFIG_DIR = tempDir;
  process.env.RUN402_API_BASE = "https://test-api.run402.com";
  delete process.env.RUN402_WALLET;
  writeFileSync(join(tempDir, "projects.json"), JSON.stringify({
    projects: { prj_1: { anon_key: "ak-1", service_key: "sk-1", tier: "prototype", lease_expires_at: "2030-01-01T00:00:00Z" } },
  }));
  writeFileSync(join(tempDir, "wallet.json"), JSON.stringify({ address: TEST_ADDRESS, privateKey: TEST_KEY, created: "2026-01-01T00:00:00.000Z", funded: false, rail: "x402" }), { mode: 0o600 });
  requests = [];
  stderr = [];
  console.error = (...args: unknown[]) => { stderr.push(args.map(String).join(" ")); };
  _resetSdk();
  _resetResultStore();
  mockGateway();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  console.error = originalConsoleError;
  _resetSdk();
  _resetResultStore();
  rmSync(tempDir, { recursive: true, force: true });
  delete process.env.RUN402_CONFIG_DIR;
  delete process.env.RUN402_API_BASE;
});

describe("run tool", () => {
  it("runs a snippet against the SDK and reports value, calls, and wallet", async () => {
    const result = await handleRun({ code: '(await r.project("prj_1").functions.list()).functions.map((f) => f.name)' });
    assert.equal(result.isError, undefined);
    const run = envelope(result);
    assert.equal(run.status, "ok");
    assert.deepEqual(run.value, ["hello", "cron"]);
    assert.equal(run.shown, run.total);
    assert.match(run.value_ref ?? "", /^res_[0-9a-f]{16}$/);
    assert.deepEqual(run.calls.map((c) => [c.path, c.ok]), [["project.functions.list", true]]);
    assert.deepEqual(run.wallet, { local_label: "default", address: "0xf39F…2266" });
    assert.equal(typeof run.duration_ms, "number");
  });

  it("tags its gateway requests with client metadata surface sandbox", async () => {
    await handleRun({ code: 'await r.project("prj_1").functions.list()' });
    assert.equal(requests.length, 1);
    assert.match(requests[0]!.headers.get("Run402-Client") ?? "", /surface="sandbox"/);
  });

  it("windows a large value and stores it whole, line-wise", async () => {
    const run = envelope(await handleRun({ code: "Array.from({ length: 5000 }, (_, i) => ({ i }))" }));
    assert.equal(run.status, "ok");
    assert.equal(run.shown, 200);
    assert.ok(run.total > 5000);
    assert.equal(run.value, undefined, "a windowed value is not inlined in the envelope");
    const rest = expandResult(run.value_ref!, { offset: 200, limit: 10 });
    assert.ok(rest);
    assert.equal(rest!.kind, "run_value");
    assert.equal(rest!.total, run.total);
  });

  it("reports undefined as null data with value_kind undefined", async () => {
    const run = envelope(await handleRun({ code: "let x = 1" }));
    assert.equal(run.status, "ok");
    assert.equal(run.value, null);
    assert.equal(run.value_kind, "undefined");
    assert.equal(run.value_ref, null);
  });

  it("captures logs, 50 inline and the rest behind logs_ref", async () => {
    const run = envelope(await handleRun({ code: "for (let i = 0; i < 60; i++) console.log('line', i);\n'done'" }));
    assert.equal(run.logs.length, 50);
    assert.deepEqual(run.logs[0], { level: "log", line: "line 0" });
    const rest = expandResult(run.logs_ref!, { offset: 50 });
    assert.equal(rest!.total, 60);
  });

  it("refuses a secret-returning call with the CLI command, before any request", async () => {
    const result = await handleRun({
      code: "await r.project('prj_1').grants.create({ wallet: '0x1111111111111111111111111111111111111111', capability: 'deploy', key: true })",
    });
    assert.equal(result.isError, true);
    const run = envelope(result);
    assert.equal(run.error?.code, "SECRET_REQUIRES_CLI");
    assert.deepEqual(run.error?.next_actions.map((a) => [a.type, a.command]), [
      ["run_cli_command", "run402 grants create 0x1111111111111111111111111111111111111111 --capability deploy --key --project prj_1"],
    ]);
    assert.equal(requests.length, 0);
    assert.equal(run.calls[0]?.code, "SECRET_REQUIRES_CLI");
  });

  it("passes an SDK error through with its own code and next_actions", async () => {
    const run = envelope(await handleRun({ code: "await r.project('prj_1').functions.delete('nope')" }));
    assert.equal(run.status, "error");
    assert.equal(run.error?.code, "NOT_FOUND");
    assert.deepEqual(run.error?.next_actions, [{ type: "check_usage", why: "test" }]);
    assert.equal(run.calls[0]?.ok, false);
    assert.equal(run.calls[0]?.code, "NOT_FOUND");
  });

  it("names the line and column of a syntax error, with one edit_request", async () => {
    const run = envelope(await handleRun({ code: "const a = 1;\nconst b = (;" }));
    assert.equal(run.error?.code, "RUN_SYNTAX_ERROR");
    assert.equal(run.error?.line, 2);
    assert.equal(run.error?.next_actions.length, 1);
    assert.equal(run.error?.next_actions[0]?.type, "edit_request");
    assert.equal(run.error?.next_actions[0]?.line, 2);
  });

  it("refuses a non-cloneable argument before any request", async () => {
    const run = envelope(await handleRun({ code: "await r.project('prj_1').functions.list({ cb: () => 1 })" }));
    assert.equal(run.error?.code, "RUN_ARGUMENT_NOT_CLONEABLE");
    assert.equal(requests.length, 0);
  });

  it("reports a timeout with the calls that completed before it", async () => {
    const run = envelope(await handleRun({ code: "await r.project('prj_1').functions.list();\nfor (;;) {}", timeout_seconds: 1 }));
    assert.equal(run.error?.code, "RUN_TIMEOUT");
    assert.deepEqual(run.calls.map((c) => [c.path, c.ok]), [["project.functions.list", true]]);
    assert.equal(run.error?.next_actions[0]?.type, "edit_request");
  });

  it(`answers RUN_BUSY past ${RUN_MAX_CONCURRENT} concurrent runs`, async () => {
    mockGateway({ delayMs: 300 });
    const inflight = Array.from({ length: RUN_MAX_CONCURRENT }, () => handleRun({ code: "await r.project('prj_1').functions.list()" }));
    await new Promise((r) => setTimeout(r, 100));
    const busy = envelope(await handleRun({ code: "1" }));
    assert.equal(busy.error?.code, "RUN_BUSY");
    assert.deepEqual(busy.error?.next_actions.map((a) => a.type), ["retry"]);
    for (const r of await Promise.all(inflight)) assert.equal(envelope(r).status, "ok");
    assert.equal(envelope(await handleRun({ code: "1" })).status, "ok");
  });

  it("logs one stderr line per run, never the source or values", async () => {
    await handleRun({ code: "const secretish = 'do-not-log';\nsecretish" });
    const lines = stderr.filter((l) => l.startsWith("run402-mcp run "));
    assert.equal(lines.length, 1);
    assert.match(lines[0]!, /^run402-mcp run run_[0-9a-f]{12} duration_ms=\d+ calls=0 outcome=ok$/);
    assert.ok(!stderr.join("\n").includes("do-not-log"));
  });
});
