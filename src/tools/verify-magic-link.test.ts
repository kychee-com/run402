import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { handleVerifyMagicLink } from "./verify-magic-link.js";
import { saveProject } from "../keystore.js";

const originalFetch = globalThis.fetch;
let tempDir: string;
let storePath: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "run402-verify-test-"));
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

describe("verify_magic_link tool", () => {
  it("sends apikey header equal to anon_key", async () => {
    saveProject("proj-v1", {
      anon_key: "ak-anon",
      service_key: "sk-svc",
      tier: "prototype",
      lease_expires_at: "2026-03-06T00:00:00Z",
    }, storePath);

    let capturedHeaders: Record<string, string> = {};
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      capturedHeaders = init?.headers as Record<string, string>;
      return new Response(
        JSON.stringify({
          access_token: "access-token-abcdefghijklmnopqrstuv",
          refresh_token: "refresh-abcdefgh",
          token_type: "bearer",
          expires_in: 3600,
          user: { id: "u1", email: "u@example.com" },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    await handleVerifyMagicLink({
      project_id: "proj-v1",
      token: "magic-token-123",
    });

    assert.equal(capturedHeaders["apikey"], "ak-anon");
    assert.equal(capturedHeaders["Authorization"], "Bearer ak-anon");
  });

  it("returns isError when project not in keystore", async () => {
    const result = await handleVerifyMagicLink({
      project_id: "no-proj",
      token: "t",
    });
    assert.equal(result.isError, true);
    assert.ok(result.content[0]!.text.includes("not found in key store"));
  });
});
