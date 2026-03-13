import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { handleClaimSubdomain, handleDeleteSubdomain } from "./subdomain.js";
import { saveProject } from "../keystore.js";

const originalFetch = globalThis.fetch;
let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "run402-subdomain-test-"));
  process.env.RUN402_CONFIG_DIR = tempDir;
  process.env.RUN402_API_BASE = "https://test-api.run402.com";
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  rmSync(tempDir, { recursive: true, force: true });
  delete process.env.RUN402_CONFIG_DIR;
  delete process.env.RUN402_API_BASE;
});

describe("claim_subdomain tool", () => {
  it("returns success with subdomain URL on 201", async () => {
    saveProject("proj-1", {
      anon_key: "ak",
      service_key: "sk-the-key",
      tier: "prototype",
      expires_at: "2026-03-06T00:00:00Z",
    });

    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          name: "myapp",
          deployment_id: "dpl_1709337600000_a1b2c3",
          url: "https://myapp.run402.com",
          deployment_url: "https://dpl-1709337600000-a1b2c3.sites.run402.com",
          project_id: "proj-1",
          created_at: "2026-03-04T00:00:00Z",
          updated_at: "2026-03-04T00:00:00Z",
        }),
        { status: 201, headers: { "Content-Type": "application/json" } },
      )) as typeof fetch;

    const result = await handleClaimSubdomain({
      name: "myapp",
      deployment_id: "dpl_1709337600000_a1b2c3",
      project_id: "proj-1",
    });

    assert.equal(result.isError, undefined);
    const text = result.content[0]!.text;
    assert.ok(text.includes("myapp.run402.com"));
    assert.ok(text.includes("dpl_1709337600000_a1b2c3"));
  });

  it("returns isError when project not in keystore", async () => {
    const result = await handleClaimSubdomain({
      name: "myapp",
      deployment_id: "dpl_123",
      project_id: "no-such-proj",
    });

    assert.equal(result.isError, true);
    assert.ok(result.content[0]!.text.includes("not found in key store"));
  });

  it("returns isError on 400 validation error", async () => {
    saveProject("proj-2", {
      anon_key: "ak",
      service_key: "sk",
      tier: "prototype",
      expires_at: "2026-03-06T00:00:00Z",
    });

    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ error: "Subdomain must be 3-63 characters" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      )) as typeof fetch;

    const result = await handleClaimSubdomain({
      name: "ab",
      deployment_id: "dpl_123",
      project_id: "proj-2",
    });

    assert.equal(result.isError, true);
    assert.ok(result.content[0]!.text.includes("3-63"));
  });

  it("returns isError on 403 ownership conflict", async () => {
    saveProject("proj-3", {
      anon_key: "ak",
      service_key: "sk",
      tier: "prototype",
      expires_at: "2026-03-06T00:00:00Z",
    });

    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ error: "Subdomain owned by different project" }),
        { status: 403, headers: { "Content-Type": "application/json" } },
      )) as typeof fetch;

    const result = await handleClaimSubdomain({
      name: "taken",
      deployment_id: "dpl_123",
      project_id: "proj-3",
    });

    assert.equal(result.isError, true);
    assert.ok(result.content[0]!.text.includes("owned by different project"));
  });

  it("sends correct headers", async () => {
    saveProject("proj-4", {
      anon_key: "ak",
      service_key: "sk-auth-key",
      tier: "prototype",
      expires_at: "2026-03-06T00:00:00Z",
    });

    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      capturedUrl = url as string;
      capturedInit = init;
      return new Response(
        JSON.stringify({
          name: "test",
          deployment_id: "dpl_123",
          url: "https://test.run402.com",
          deployment_url: "https://dpl-123.sites.run402.com",
          project_id: "proj-4",
          created_at: "2026-03-04T00:00:00Z",
          updated_at: "2026-03-04T00:00:00Z",
        }),
        { status: 201, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    await handleClaimSubdomain({
      name: "test",
      deployment_id: "dpl_123",
      project_id: "proj-4",
    });

    assert.ok(capturedUrl.includes("/subdomains/v1"));
    const headers = capturedInit?.headers as Record<string, string>;
    assert.equal(headers["Authorization"], "Bearer sk-auth-key");
    assert.equal(headers["Content-Type"], "application/json");
    const body = JSON.parse(capturedInit?.body as string);
    assert.equal(body.name, "test");
    assert.equal(body.deployment_id, "dpl_123");
  });
});

describe("delete_subdomain tool", () => {
  it("returns success on 200", async () => {
    saveProject("proj-5", {
      anon_key: "ak",
      service_key: "sk",
      tier: "prototype",
      expires_at: "2026-03-06T00:00:00Z",
    });

    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ status: "deleted", name: "myapp" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as typeof fetch;

    const result = await handleDeleteSubdomain({
      name: "myapp",
      project_id: "proj-5",
    });

    assert.equal(result.isError, undefined);
    assert.ok(result.content[0]!.text.includes("Released"));
    assert.ok(result.content[0]!.text.includes("myapp"));
  });

  it("returns isError on 404", async () => {
    saveProject("proj-6", {
      anon_key: "ak",
      service_key: "sk",
      tier: "prototype",
      expires_at: "2026-03-06T00:00:00Z",
    });

    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ error: "Subdomain not found" }),
        { status: 404, headers: { "Content-Type": "application/json" } },
      )) as typeof fetch;

    const result = await handleDeleteSubdomain({
      name: "nope",
      project_id: "proj-6",
    });

    assert.equal(result.isError, true);
    assert.ok(result.content[0]!.text.includes("not found"));
  });

  it("returns isError when project not in keystore", async () => {
    const result = await handleDeleteSubdomain({
      name: "myapp",
      project_id: "no-such-proj",
    });

    assert.equal(result.isError, true);
    assert.ok(result.content[0]!.text.includes("not found in key store"));
  });
});
