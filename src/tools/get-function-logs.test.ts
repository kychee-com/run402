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
            { timestamp: "2026-03-05T12:00:00Z", message: "Processing webhook" },
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
});
