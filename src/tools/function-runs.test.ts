import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  handleCancelFunctionRun,
  handleCreateFunctionRun,
  handleGetFunctionRun,
  handleGetFunctionRunLogs,
  handleListFunctionRuns,
  handleRedriveFunctionRun,
} from "./function-runs.js";

const originalFetch = globalThis.fetch;
let tempDir: string;
let calls: Array<{ url: string; method: string; headers: Record<string, string>; body: unknown }> = [];

const queuedRun = {
  run_id: "fnrun_abc123",
  function_name: "worker",
  event_type: "kysigned.forward.process",
  status: "queued",
  terminal: false,
  generation: 1,
  run_at: "2026-07-01T12:00:00.000Z",
  source: { type: "api" },
  attempts: { current: 0, max: 5, total: 0 },
  created_at: "2026-07-01T12:00:00.000Z",
  updated_at: "2026-07-01T12:00:00.000Z",
  next_actions: [],
};

beforeEach(() => {
  calls = [];
  tempDir = mkdtempSync(join(tmpdir(), "run402-function-runs-tool-test-"));
  process.env.RUN402_CONFIG_DIR = tempDir;
  process.env.RUN402_API_BASE = "https://test-api.run402.com";

  writeFileSync(join(tempDir, "projects.json"), JSON.stringify({
    projects: {
      "proj-001": {
        anon_key: "ak-123",
        service_key: "sk-456",
        tier: "prototype",
        lease_expires_at: "2030-01-01T00:00:00Z",
      },
    },
  }));
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  rmSync(tempDir, { recursive: true, force: true });
  delete process.env.RUN402_CONFIG_DIR;
  delete process.env.RUN402_API_BASE;
});

describe("function run tools", () => {
  it("creates delayed runs with idempotency and service-key auth", async () => {
    globalThis.fetch = mockFetch(() => json({ ...queuedRun, status: "scheduled" }, 202));

    const result = await handleCreateFunctionRun({
      project_id: "proj-001",
      name: "worker",
      event_type: "kysigned.forward.process",
      payload: { message_id: "msg_123" },
      delay: "10m",
      expires_after: "1d",
      idempotency_key: "reply:msg_123",
      retry: { max_attempts: 3 },
    });

    assert.equal(result.isError, undefined);
    assert.ok(result.content[0]!.text.includes("Function Run Created"));
    assert.ok(result.content[0]!.text.includes("fnrun_abc123"));
    assert.equal(calls[0]!.url, "https://test-api.run402.com/functions/v1/worker/runs");
    assert.equal(calls[0]!.method, "POST");
    assert.equal(calls[0]!.headers.authorization, "Bearer sk-456");
    assert.equal(calls[0]!.headers["idempotency-key"], "reply:msg_123");
    assert.deepEqual(JSON.parse(calls[0]!.body as string), {
      event_type: "kysigned.forward.process",
      payload: { message_id: "msg_123" },
      delay_seconds: 600,
      expires_at: JSON.parse(calls[0]!.body as string).expires_at,
      idempotency_key: "reply:msg_123",
      retry: { preset: "standard", max_attempts: 3 },
    });
  });

  it("lists, gets, logs, cancels, and redrives runs", async () => {
    globalThis.fetch = mockFetch((call) => {
      if (call.url.includes("/logs")) return json({ logs: [{ timestamp: "2026-07-01T12:00:01.000Z", message: "ok" }] });
      if (call.url.endsWith("/cancel")) return json({ ...queuedRun, status: "cancelled", terminal: true });
      if (call.url.endsWith("/redrive")) return json({ ...queuedRun, generation: 2 });
      if (call.url.includes("/worker/runs?")) return json({ runs: [queuedRun], next_cursor: "c2" });
      return json(queuedRun);
    });

    const listed = await handleListFunctionRuns({
      project_id: "proj-001",
      name: "worker",
      status: "queued",
      event_type: "kysigned.forward.process",
      limit: 10,
    });
    const got = await handleGetFunctionRun({ project_id: "proj-001", run_id: "fnrun_abc123" });
    const logs = await handleGetFunctionRunLogs({ project_id: "proj-001", run_id: "fnrun_abc123", tail: 10 });
    const cancelled = await handleCancelFunctionRun({ project_id: "proj-001", run_id: "fnrun_abc123" });
    const redriven = await handleRedriveFunctionRun({
      project_id: "proj-001",
      run_id: "fnrun_abc123",
      retry: { max_attempts: 2 },
    });

    assert.ok(listed.content[0]!.text.includes("next_cursor"));
    assert.ok(got.content[0]!.text.includes("Function Run"));
    assert.ok(logs.content[0]!.text.includes("ok"));
    assert.ok(cancelled.content[0]!.text.includes("cancelled"));
    assert.ok(redriven.content[0]!.text.includes("Function Run Redriven"));
    assert.equal(new URL(calls[0]!.url).pathname, "/functions/v1/worker/runs");
    assert.equal(new URL(calls[0]!.url).searchParams.get("event_type"), "kysigned.forward.process");
    assert.equal(calls[3]!.url, "https://test-api.run402.com/functions/v1/runs/fnrun_abc123/cancel");
    assert.deepEqual(JSON.parse(calls[4]!.body as string), {
      retry: { preset: "standard", max_attempts: 2 },
    });
  });

  it("returns isError when project is missing before fetch", async () => {
    globalThis.fetch = mockFetch(() => {
      throw new Error("unexpected fetch");
    });

    const result = await handleGetFunctionRun({
      project_id: "missing",
      run_id: "fnrun_abc123",
    });

    assert.equal(result.isError, true);
    assert.equal(calls.length, 0);
    assert.ok(result.content[0]!.text.includes("not found in key store"));
  });
});

function mockFetch(handler: (call: { url: string; method: string }) => Response): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const call = {
      url,
      method: (init?.method ?? "GET").toUpperCase(),
      headers,
      body: init?.body ?? null,
    };
    calls.push(call);
    return handler(call);
  }) as typeof fetch;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
