import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { handleInvokeFunction } from "./invoke-function.js";

const originalFetch = globalThis.fetch;
let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "run402-invoke-fn-test-"));
  process.env.RUN402_CONFIG_DIR = tempDir;
  process.env.RUN402_API_BASE = "https://test-api.run402.com";

  const store = {
    projects: {
      "proj-001": {
        anon_key: "ak-123",
        service_key: "sk-456",
        tier: "prototype",
        lease_expires_at: "2030-01-01T00:00:00Z",
      },
    },
  };
  writeFileSync(join(tempDir, "projects.json"), JSON.stringify(store));
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  rmSync(tempDir, { recursive: true, force: true });
  delete process.env.RUN402_CONFIG_DIR;
  delete process.env.RUN402_API_BASE;
});

describe("invoke_function tool", () => {
  it("returns function response on 200", async () => {
    let seenIdempotency: string | null = null;
    globalThis.fetch = (async (_url, init) => {
      seenIdempotency = (init?.headers as Record<string, string>)["Idempotency-Key"] ?? null;
      return new Response(
        JSON.stringify({ result: "ok", users: [{ id: 1 }] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    const result = await handleInvokeFunction({
      project_id: "proj-001",
      name: "my-func",
      body: { test: true },
      idempotency_key: "paid-call-1",
    });

    assert.equal(result.isError, undefined);
    assert.ok(result.content[0]!.text.includes("Function Response"));
    assert.ok(result.content[0]!.text.includes("200"));
    assert.equal(seenIdempotency, "paid-call-1");
  });

  it("waits on a paid run handle and replays with the same idempotency key", async () => {
    const calls: Array<{ url: string; method: string; idempotency: string | null }> = [];
    globalThis.fetch = (async (url, init) => {
      const call = {
        url: String(url),
        method: init?.method ?? "GET",
        idempotency: (init?.headers as Record<string, string>)["Idempotency-Key"] ?? null,
      };
      calls.push(call);
      if (call.method === "POST" && call.url.endsWith("/functions/v1/my-func") && calls.length === 1) {
        return new Response(
          JSON.stringify({
            code: "idempotency_in_progress",
            state: "in_progress",
            run_id: "fnrun_paid",
            operation_id: "fnrun_paid",
            next_actions: [{ type: "poll", path: "/functions/v1/runs/fnrun_paid" }],
          }),
          { status: 202, headers: { "Content-Type": "application/json" } },
        );
      }
      if (call.method === "GET" && call.url.endsWith("/functions/v1/runs/fnrun_paid")) {
        return new Response(
          JSON.stringify({
            run_id: "fnrun_paid",
            function_name: "my-func",
            event_type: "paid.invoke",
            status: "succeeded",
            terminal: true,
            generation: 1,
            run_at: "2026-07-09T00:00:00.000Z",
            source: {},
            attempts: { current: 1, max: 1, total: 1 },
            created_at: "2026-07-09T00:00:00.000Z",
            updated_at: "2026-07-09T00:00:01.000Z",
            completed_at: "2026-07-09T00:00:01.000Z",
            next_actions: [],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({ result: "ok" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    const result = await handleInvokeFunction({
      project_id: "proj-001",
      name: "my-func",
      body: { test: true },
      idempotency_key: "paid-call-1",
      wait: true,
      timeout_ms: 1000,
      poll_interval_ms: 0,
    });

    assert.equal(result.isError, undefined);
    assert.equal(calls.length, 3);
    assert.equal(calls[0]!.idempotency, "paid-call-1");
    assert.equal(calls[2]!.idempotency, "paid-call-1");
    assert.ok(result.content[0]!.text.includes("200"));
    assert.ok(result.content[0]!.text.includes("\"ok\""));
  });

  it("supports GET method", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ items: [] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as typeof fetch;

    const result = await handleInvokeFunction({
      project_id: "proj-001",
      name: "list-items",
      method: "GET",
    });

    assert.equal(result.isError, undefined);
  });

  it("returns isError with stable code on 402", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          error: "payment_required",
          message: "Insufficient allowance",
          code: "insufficient_allowance",
          next_actions: [{ type: "submit_payment" }],
        }),
        { status: 402, headers: { "Content-Type": "application/json" } },
      )) as typeof fetch;

    const result = await handleInvokeFunction({
      project_id: "proj-001",
      name: "my-func",
    });

    assert.equal(result.isError, true);
    assert.ok(result.content[0]!.text.includes("insufficient_allowance"));
    assert.ok(result.content[0]!.text.includes("submit_payment"));
  });

  it("returns isError on 404", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ error: "Function not found" }),
        { status: 404, headers: { "Content-Type": "application/json" } },
      )) as typeof fetch;

    const result = await handleInvokeFunction({
      project_id: "proj-001",
      name: "nonexistent",
    });

    assert.equal(result.isError, true);
    assert.ok(result.content[0]!.text.includes("not found"));
  });

  it("returns isError when project not in keystore", async () => {
    const result = await handleInvokeFunction({
      project_id: "nonexistent",
      name: "my-func",
    });

    assert.equal(result.isError, true);
    assert.ok(result.content[0]!.text.includes("not found in key store"));
  });
});
