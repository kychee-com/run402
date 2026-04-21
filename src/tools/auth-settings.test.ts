import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { handleAuthSettings } from "./auth-settings.js";
import { saveProject } from "../keystore.js";

const originalFetch = globalThis.fetch;
let tempDir: string;
let storePath: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "run402-auth-settings-test-"));
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

describe("auth_settings tool", () => {
  it("sends apikey header equal to anon_key and keeps service_key as Bearer", async () => {
    saveProject("proj-s1", {
      anon_key: "ak-anon",
      service_key: "sk-svc",
      tier: "prototype",
      lease_expires_at: "2026-03-06T00:00:00Z",
    }, storePath);

    let capturedHeaders: Record<string, string> = {};
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      capturedHeaders = init?.headers as Record<string, string>;
      return new Response(JSON.stringify({ allow_password_set: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    await handleAuthSettings({
      project_id: "proj-s1",
      allow_password_set: true,
    });

    // apikey identifies the project to apikeyAuth middleware
    assert.equal(capturedHeaders["apikey"], "ak-anon");
    // Bearer service_key still needed for the settings-change authorization
    assert.equal(capturedHeaders["Authorization"], "Bearer sk-svc");
  });

  it("returns isError when project not in keystore", async () => {
    const result = await handleAuthSettings({
      project_id: "no-proj",
      allow_password_set: true,
    });
    assert.equal(result.isError, true);
    assert.ok(result.content[0]!.text.includes("not found in key store"));
  });
});
