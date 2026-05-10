import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { handleGetFunctionLogs } from "./get-function-logs.js";

const originalFetch = globalThis.fetch;
let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "run402-logs-fn-test-"));
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

describe("get_function_logs tool", () => {
  it("returns formatted logs on 200", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          logs: [
            {
              timestamp: "2026-03-05T12:00:00Z",
              message: "Processing webhook",
              event_id: "evt-1",
              log_stream_name: "stream-a",
              ingestion_time: "2026-03-05T12:00:01Z",
              request_id: "req_abc123",
            },
            { timestamp: "2026-03-05T12:00:01Z", message: "Done" },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as typeof fetch;

    const result = await handleGetFunctionLogs({
      project_id: "proj-001",
      name: "my-func",
    });

    assert.equal(result.isError, undefined);
    assert.ok(result.content[0]!.text.includes("Function Logs: my-func"));
    assert.ok(result.content[0]!.text.includes("Processing webhook"));
    assert.ok(result.content[0]!.text.includes("request_id=req_abc123"));
    assert.ok(result.content[0]!.text.includes("event_id=evt-1"));
    assert.ok(result.content[0]!.text.includes("stream=stream-a"));
    assert.ok(result.content[0]!.text.includes("2 log entries"));
  });

  it("returns empty message when no logs", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ logs: [] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as typeof fetch;

    const result = await handleGetFunctionLogs({
      project_id: "proj-001",
      name: "my-func",
    });

    assert.equal(result.isError, undefined);
    assert.ok(result.content[0]!.text.includes("No logs found"));
  });

  it("returns isError on 404", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ error: "Function not found" }),
        { status: 404, headers: { "Content-Type": "application/json" } },
      )) as typeof fetch;

    const result = await handleGetFunctionLogs({
      project_id: "proj-001",
      name: "nonexistent",
    });

    assert.equal(result.isError, true);
  });

  it("returns isError when project not in keystore", async () => {
    const result = await handleGetFunctionLogs({
      project_id: "nonexistent",
      name: "my-func",
    });

    assert.equal(result.isError, true);
    assert.ok(result.content[0]!.text.includes("not found in key store"));
  });

  it("passes since as epoch ms query param", async () => {
    let capturedUrl = "";
    globalThis.fetch = (async (url: string) => {
      capturedUrl = url;
      return new Response(
        JSON.stringify({ logs: [] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    await handleGetFunctionLogs({
      project_id: "proj-001",
      name: "my-func",
      since: "2026-03-29T14:00:00.001Z",
    });

    assert.ok(capturedUrl.includes("since="), "URL should contain since param");
    const sinceMs = new URL(capturedUrl).searchParams.get("since");
    assert.equal(sinceMs, String(new Date("2026-03-29T14:00:00.001Z").getTime()));
  });

  it("passes request_id as requestId query param", async () => {
    let capturedUrl = "";
    globalThis.fetch = (async (url: string) => {
      capturedUrl = url;
      return new Response(
        JSON.stringify({ logs: [] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    await handleGetFunctionLogs({
      project_id: "proj-001",
      name: "my-func",
      request_id: "req_abc123",
    });

    assert.equal(new URL(capturedUrl).searchParams.get("request_id"), "req_abc123");
  });

  it("rejects invalid since before fetch", async () => {
    let fetchCalled = false;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      return new Response(JSON.stringify({ logs: [] }), { status: 200 });
    }) as typeof fetch;

    const result = await handleGetFunctionLogs({
      project_id: "proj-001",
      name: "my-func",
      since: "not-a-date",
    });

    assert.equal(result.isError, true);
    assert.equal(fetchCalled, false);
    assert.ok(result.content[0]!.text.includes("Invalid functions.logs since timestamp"));
  });

  it("omits since param when not provided", async () => {
    let capturedUrl = "";
    globalThis.fetch = (async (url: string) => {
      capturedUrl = url;
      return new Response(
        JSON.stringify({ logs: [] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    await handleGetFunctionLogs({
      project_id: "proj-001",
      name: "my-func",
    });

    assert.ok(!capturedUrl.includes("since="), "URL should not contain since param");
  });
});
