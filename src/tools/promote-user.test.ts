import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { handlePromoteUser } from "./promote-user.js";

const originalFetch = globalThis.fetch;
let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "run402-promote-test-"));
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

describe("promote_user tool", () => {
  it("returns success on 200", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ status: "ok", email: "admin@example.com", is_admin: true }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as typeof fetch;

    const result = await handlePromoteUser({
      project_id: "proj-001",
      email: "admin@example.com",
    });

    assert.equal(result.isError, undefined);
    assert.ok(result.content[0]!.text.includes("User Promoted"));
    assert.ok(result.content[0]!.text.includes("admin@example.com"));
  });

  it("returns isError when project not in keystore", async () => {
    const result = await handlePromoteUser({
      project_id: "nonexistent",
      email: "admin@example.com",
    });

    assert.equal(result.isError, true);
    assert.ok(result.content[0]!.text.includes("not found in key store"));
  });

  it("returns isError on API error", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ error: "User not found" }),
        { status: 404, headers: { "Content-Type": "application/json" } },
      )) as typeof fetch;

    const result = await handlePromoteUser({
      project_id: "proj-001",
      email: "nobody@example.com",
    });

    assert.equal(result.isError, true);
    assert.ok(result.content[0]!.text.includes("404"));
  });
});
