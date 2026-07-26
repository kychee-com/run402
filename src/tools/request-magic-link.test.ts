import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { handleRequestMagicLink } from "./request-magic-link.js";
import { saveProject } from "../keystore.js";

const originalFetch = globalThis.fetch;
let tempDir: string;
let storePath: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "run402-magic-link-test-"));
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

describe("request_magic_link tool", () => {
  it("sends apikey header equal to anon_key", async () => {
    saveProject("proj-ml1", {
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

    await handleRequestMagicLink({
      project_id: "proj-ml1",
      email: "user@example.com",
      redirect_url: "https://app.example.com/cb",
    });

    assert.equal(capturedHeaders["apikey"], "ak-anon");
    // Keep Authorization header where it was — don't drop it
    assert.equal(capturedHeaders["Authorization"], "Bearer ak-anon");
  });

  it("reports request acceptance without claiming delivery or account creation", async () => {
    saveProject("proj-ml2", {
      anon_key: "ak-anon",
      service_key: "sk-svc",
      tier: "prototype",
      lease_expires_at: "2026-03-06T00:00:00Z",
    }, storePath);
    globalThis.fetch = (async () => new Response(JSON.stringify({
      message: "Email authentication request accepted.",
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })) as typeof fetch;

    const result = await handleRequestMagicLink({
      project_id: "proj-ml2",
      email: "unknown@example.com",
      redirect_url: "https://app.example.com/cb",
    });
    const text = result.content[0]!.text;

    assert.match(text, /accepted/i);
    assert.doesNotMatch(text, /sent|delivered|will receive/i);
    assert.doesNotMatch(text, /account.*created|created automatically/i);
  });

  it("supports code-only delivery without a redirect and returns only the opaque handle", async () => {
    saveProject("proj-code", {
      anon_key: "ak-anon",
      service_key: "sk-svc",
      tier: "prototype",
      lease_expires_at: "2026-03-06T00:00:00Z",
    }, storePath);
    const challengeId = "123e4567-e89b-42d3-a456-426614174000";
    let capturedBody: Record<string, unknown> = {};
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      capturedBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({
        message: "Email authentication request accepted.",
        challenge_id: challengeId,
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;

    const result = await handleRequestMagicLink({
      project_id: "proj-code",
      email: "user@example.com",
      delivery: "code",
    });

    assert.deepEqual(capturedBody, { email: "user@example.com", delivery: "code" });
    assert.match(result.content[0]!.text, new RegExp(challengeId));
    assert.doesNotMatch(result.content[0]!.text, /\b\d{6}\b/);
  });

  it("rejects both delivery without a redirect before requesting", async () => {
    let fetchCount = 0;
    globalThis.fetch = (async () => {
      fetchCount++;
      return new Response("{}");
    }) as typeof fetch;
    const result = await handleRequestMagicLink({
      project_id: "proj-code",
      email: "user@example.com",
      delivery: "both",
    });
    assert.equal(result.isError, true);
    assert.equal(fetchCount, 0);
  });

  it("returns isError when project not in keystore", async () => {
    const result = await handleRequestMagicLink({
      project_id: "no-proj",
      email: "user@example.com",
      redirect_url: "https://app.example.com/cb",
    });
    assert.equal(result.isError, true);
    assert.ok(result.content[0]!.text.includes("not found in key store"));
  });
});
