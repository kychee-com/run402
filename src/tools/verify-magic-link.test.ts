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

  it("exchanges a challenge handle and six-digit email code", async () => {
    saveProject("proj-code", {
      anon_key: "ak-anon",
      service_key: "sk-svc",
      tier: "prototype",
      lease_expires_at: "2026-03-06T00:00:00Z",
    }, storePath);
    const challengeId = "123e4567-e89b-42d3-a456-426614174000";
    let capturedUrl = "";
    let capturedBody: Record<string, unknown> = {};
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      capturedUrl = typeof input === "string" ? input : input instanceof Request ? input.url : String(input);
      capturedBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({
        access_token: "access-token-abcdefghijklmnopqrstuv",
        refresh_token: "refresh-abcdefgh",
        token_type: "bearer",
        expires_in: 3600,
        user: { id: "u1", email: "u@example.com" },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;

    const result = await handleVerifyMagicLink({
      project_id: "proj-code",
      challenge_id: challengeId,
      code: "042731",
    });

    assert.match(capturedUrl, /grant_type=email_code$/);
    assert.deepEqual(capturedBody, { challenge_id: challengeId, code: "042731" });
    assert.match(result.content[0]!.text, /Email Code Verified/);
  });

  it("rejects mixed and partial credential shapes before requesting", async () => {
    let fetchCount = 0;
    globalThis.fetch = (async () => {
      fetchCount++;
      return new Response("{}");
    }) as typeof fetch;

    const mixed = await handleVerifyMagicLink({
      project_id: "proj-v1",
      token: "token",
      challenge_id: "123e4567-e89b-42d3-a456-426614174000",
      code: "042731",
    });
    const partial = await handleVerifyMagicLink({
      project_id: "proj-v1",
      challenge_id: "123e4567-e89b-42d3-a456-426614174000",
    });

    assert.equal(mixed.isError, true);
    assert.equal(partial.isError, true);
    assert.equal(fetchCount, 0);
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
