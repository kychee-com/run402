import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { handleDeployFunction } from "./deploy-function.js";

const originalFetch = globalThis.fetch;
let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "run402-deploy-fn-test-"));
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

describe("deploy_function tool", () => {
  it("returns success on 201", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          name: "my-func",
          url: "https://test-api.run402.com/functions/v1/my-func",
          status: "deployed",
          runtime: "node22",
          timeout: 10,
          memory: 128,
          created_at: "2026-03-05T12:00:00Z",
        }),
        { status: 201, headers: { "Content-Type": "application/json" } },
      )) as typeof fetch;

    const result = await handleDeployFunction({
      project_id: "proj-001",
      name: "my-func",
      code: 'export default async (req) => new Response("hello")',
    });

    assert.equal(result.isError, undefined);
    assert.ok(result.content[0]!.text.includes("Function Deployed"));
    assert.ok(result.content[0]!.text.includes("my-func"));
    assert.ok(result.content[0]!.text.includes("functions/v1/my-func"));
  });

  it("returns error on 400 (bad name)", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ error: "Function name must be lowercase alphanumeric" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      )) as typeof fetch;

    const result = await handleDeployFunction({
      project_id: "proj-001",
      name: "Bad Name!",
      code: "export default async (req) => new Response('hi')",
    });

    assert.equal(result.isError, true);
    assert.ok(result.content[0]!.text.includes("lowercase"));
  });

  it("returns payment info (NOT isError) on 402", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ error: "Lease expired", renew_url: "/tiers/v1/prototype" }),
        { status: 402, headers: { "Content-Type": "application/json" } },
      )) as typeof fetch;

    const result = await handleDeployFunction({
      project_id: "proj-001",
      name: "my-func",
      code: "export default async (req) => new Response('hi')",
    });

    assert.equal(result.isError, undefined);
    assert.ok(result.content[0]!.text.includes("Payment Required"));
  });

  it("returns isError on 403 (quota exceeded)", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ error: "Function limit reached (5 for your tier)" }),
        { status: 403, headers: { "Content-Type": "application/json" } },
      )) as typeof fetch;

    const result = await handleDeployFunction({
      project_id: "proj-001",
      name: "my-func",
      code: "export default async (req) => new Response('hi')",
    });

    assert.equal(result.isError, true);
    assert.ok(result.content[0]!.text.includes("limit"));
  });

  it("returns isError when project not in keystore", async () => {
    const result = await handleDeployFunction({
      project_id: "nonexistent",
      name: "my-func",
      code: "export default async (req) => new Response('hi')",
    });

    assert.equal(result.isError, true);
    assert.ok(result.content[0]!.text.includes("not found in key store"));
  });
});
