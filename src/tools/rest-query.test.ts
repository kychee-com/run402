import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { handleRestQuery } from "./rest-query.js";
import { saveProject } from "../keystore.js";
import { _resetSdk } from "../sdk.js";

const originalFetch = globalThis.fetch;
let tempDir: string;
let storePath: string;

beforeEach(() => {
  _resetSdk();
  tempDir = mkdtempSync(join(tmpdir(), "run402-rest-test-"));
  storePath = join(tempDir, "projects.json");
  process.env.RUN402_CONFIG_DIR = tempDir;
  process.env.RUN402_API_BASE = "https://test-api.run402.com";
});

afterEach(() => {
  _resetSdk();
  globalThis.fetch = originalFetch;
  rmSync(tempDir, { recursive: true, force: true });
  delete process.env.RUN402_CONFIG_DIR;
  delete process.env.RUN402_API_BASE;
});

describe("rest_query tool", () => {
  it("constructs correct URL with params for GET", async () => {
    saveProject("proj-r1", {
      anon_key: "ak-r1",
      service_key: "sk-r1",
      tier: "prototype",
      lease_expires_at: "2026-03-06T00:00:00Z",
    }, storePath);

    let capturedUrl = "";
    globalThis.fetch = (async (url: string | URL | Request) => {
      capturedUrl = typeof url === "string" ? url : url.toString();
      return new Response(JSON.stringify([{ id: 1 }]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    await handleRestQuery({
      project_id: "proj-r1",
      table: "users",
      method: "GET",
      params: { select: "id,name", order: "id.asc" },
    });

    assert.ok(capturedUrl.includes("/rest/v1/users?"));
    assert.ok(capturedUrl.includes("select=id%2Cname"));
    assert.ok(capturedUrl.includes("order=id.asc"));
  });

  it("sends JSON body and Prefer header for POST", async () => {
    saveProject("proj-r2", {
      anon_key: "ak-r2",
      service_key: "sk-r2",
      tier: "prototype",
      lease_expires_at: "2026-03-06T00:00:00Z",
    }, storePath);

    let capturedHeaders: Record<string, string> = {};
    let capturedBody: string | undefined;
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      capturedHeaders = init?.headers as Record<string, string>;
      capturedBody = init?.body as string;
      return new Response(JSON.stringify([{ id: 1, name: "Alice" }]), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    await handleRestQuery({
      project_id: "proj-r2",
      table: "users",
      method: "POST",
      body: { name: "Alice" },
    });

    assert.equal(capturedHeaders["Prefer"], "return=representation");
    assert.deepEqual(JSON.parse(capturedBody!), { name: "Alice" });
  });

  it("forwards correct method for PATCH and DELETE", async () => {
    saveProject("proj-r3", {
      anon_key: "ak-r3",
      service_key: "sk-r3",
      tier: "prototype",
      lease_expires_at: "2026-03-06T00:00:00Z",
    }, storePath);

    let capturedMethod = "";
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      capturedMethod = init?.method || "GET";
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    await handleRestQuery({ project_id: "proj-r3", table: "users", method: "DELETE" });
    assert.equal(capturedMethod, "DELETE");

    await handleRestQuery({
      project_id: "proj-r3",
      table: "users",
      method: "PATCH",
      body: { name: "Updated" },
    });
    assert.equal(capturedMethod, "PATCH");
  });

  it("uses anon_key by default and service_key when specified", async () => {
    saveProject("proj-r4", {
      anon_key: "ak-anon",
      service_key: "sk-svc",
      tier: "prototype",
      lease_expires_at: "2026-03-06T00:00:00Z",
    }, storePath);

    let capturedHeaders: Record<string, string> = {};
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      capturedHeaders = init?.headers as Record<string, string>;
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    // Default = anon
    await handleRestQuery({ project_id: "proj-r4", table: "users" });
    assert.equal(capturedHeaders["apikey"], "ak-anon");
    assert.equal(capturedHeaders["Authorization"], "Bearer ak-anon");

    // Explicit service
    await handleRestQuery({
      project_id: "proj-r4",
      table: "users",
      key_type: "service",
    });
    assert.equal(capturedHeaders["apikey"], "sk-svc");
    assert.equal(capturedHeaders["Authorization"], "Bearer sk-svc");
  });

  it("returns isError when project not in keystore", async () => {
    const result = await handleRestQuery({
      project_id: "no-proj",
      table: "users",
    });
    assert.equal(result.isError, true);
    assert.ok(result.content[0]!.text.includes("not found in key store"));
  });
});
