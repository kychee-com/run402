import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { handleSetUserPassword } from "./set-user-password.js";
import { saveProject } from "../keystore.js";

const originalFetch = globalThis.fetch;
let tempDir: string;
let storePath: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "run402-set-password-test-"));
  storePath = join(tempDir, "projects.json");
  process.env.RUN402_CONFIG_DIR = tempDir;
  process.env.RUN402_API_BASE = "https://test-api.run402.com";
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  rmSync(tempDir, { recursive: true, force: true });
  delete process.env.RUN402_CONFIG_DIR;
  delete process.env.RUN402_API_BASE;
});

describe("set_user_password tool", () => {
  it("sends apikey header equal to anon_key and keeps user access_token as Bearer", async () => {
    saveProject("proj-sp1", {
      anon_key: "ak-anon",
      service_key: "sk-svc",
      tier: "prototype",
      lease_expires_at: "2026-03-06T00:00:00Z",
    }, storePath);

    let capturedHeaders: Record<string, string> = {};
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      capturedHeaders = init?.headers as Record<string, string>;
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    await handleSetUserPassword({
      project_id: "proj-sp1",
      access_token: "user-jwt-token",
      new_password: "new-pass",
    });

    // apikey identifies the project to apikeyAuth middleware
    assert.equal(capturedHeaders["apikey"], "ak-anon");
    // Bearer remains the user's access_token
    assert.equal(capturedHeaders["Authorization"], "Bearer user-jwt-token");
  });

  it("returns isError when project not in keystore", async () => {
    const result = await handleSetUserPassword({
      project_id: "no-proj",
      access_token: "t",
      new_password: "p",
    });
    assert.equal(result.isError, true);
    assert.ok(result.content[0]!.text.includes("not found in key store"));
  });
});
