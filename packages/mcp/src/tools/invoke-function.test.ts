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
        expires_at: "2030-01-01T00:00:00Z",
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
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ result: "ok", users: [{ id: 1 }] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as typeof fetch;

    const result = await handleInvokeFunction({
      project_id: "proj-001",
      name: "my-func",
      body: { test: true },
    });

    assert.equal(result.isError, undefined);
    assert.ok(result.content[0]!.text.includes("Function Response"));
    assert.ok(result.content[0]!.text.includes("200"));
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

  it("returns payment info on 402", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ error: "API call limit exceeded" }),
        { status: 402, headers: { "Content-Type": "application/json" } },
      )) as typeof fetch;

    const result = await handleInvokeFunction({
      project_id: "proj-001",
      name: "my-func",
    });

    assert.equal(result.isError, undefined);
    assert.ok(result.content[0]!.text.includes("Payment Required"));
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
