import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { handleSetSecret } from "./set-secret.js";

const originalFetch = globalThis.fetch;
let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "run402-secret-test-"));
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

describe("set_secret tool", () => {
  it("returns success on 200", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ status: "set", key: "STRIPE_SECRET_KEY" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as typeof fetch;

    const result = await handleSetSecret({
      project_id: "proj-001",
      key: "STRIPE_SECRET_KEY",
      value: "sk_test_123",
    });

    assert.equal(result.isError, undefined);
    assert.ok(result.content[0]!.text.includes("Secret Set"));
    assert.ok(result.content[0]!.text.includes("STRIPE_SECRET_KEY"));
    assert.ok(result.content[0]!.text.includes("process.env.STRIPE_SECRET_KEY"));
  });

  it("returns isError on 400 (bad key format)", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ error: "Secret key must be uppercase" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      )) as typeof fetch;

    const result = await handleSetSecret({
      project_id: "proj-001",
      key: "bad-key",
      value: "value",
    });

    assert.equal(result.isError, true);
    assert.ok(result.content[0]!.text.includes("Secret key must match"));
  });

  it("returns isError on 403 (quota exceeded)", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ error: "Secrets limit reached (10 for your tier)" }),
        { status: 403, headers: { "Content-Type": "application/json" } },
      )) as typeof fetch;

    const result = await handleSetSecret({
      project_id: "proj-001",
      key: "NEW_KEY",
      value: "value",
    });

    assert.equal(result.isError, true);
    assert.ok(result.content[0]!.text.includes("limit"));
  });

  it("returns isError when project not in keystore", async () => {
    const result = await handleSetSecret({
      project_id: "nonexistent",
      key: "KEY",
      value: "value",
    });

    assert.equal(result.isError, true);
    assert.ok(result.content[0]!.text.includes("not found in key store"));
  });
});
