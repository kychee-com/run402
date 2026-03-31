import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { handleAddCustomDomain } from "./add-custom-domain.js";
import { handleListCustomDomains } from "./list-custom-domains.js";
import { handleCheckDomainStatus } from "./check-domain-status.js";
import { handleRemoveCustomDomain } from "./remove-custom-domain.js";
import { saveProject } from "../keystore.js";

const originalFetch = globalThis.fetch;
let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "run402-domain-test-"));
  process.env.RUN402_CONFIG_DIR = tempDir;
  process.env.RUN402_API_BASE = "https://test-api.run402.com";
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  rmSync(tempDir, { recursive: true, force: true });
  delete process.env.RUN402_CONFIG_DIR;
  delete process.env.RUN402_API_BASE;
});

describe("add_custom_domain tool", () => {
  it("returns success with DNS instructions on 201", async () => {
    saveProject("proj-1", {
      anon_key: "ak",
      service_key: "sk-key",
      tier: "prototype",
      lease_expires_at: "2026-04-01T00:00:00Z",
    });

    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          domain: "example.com",
          subdomain_name: "myapp",
          url: "https://example.com",
          subdomain_url: "https://myapp.run402.com",
          status: "pending",
          dns_instructions: {
            cname_target: "domains.run402.com",
            txt_name: "_cf-custom-hostname.example.com",
            txt_value: "verify-token-123",
          },
          project_id: "proj-1",
          created_at: "2026-04-01T00:00:00Z",
        }),
        { status: 201, headers: { "Content-Type": "application/json" } },
      )) as typeof fetch;

    const result = await handleAddCustomDomain({
      domain: "example.com",
      subdomain_name: "myapp",
      project_id: "proj-1",
    });

    assert.equal(result.isError, undefined);
    const text = result.content[0]!.text;
    assert.ok(text.includes("example.com"));
    assert.ok(text.includes("myapp.run402.com"));
    assert.ok(text.includes("DNS Configuration Required"));
    assert.ok(text.includes("domains.run402.com"));
    assert.ok(text.includes("verify-token-123"));
  });

  it("returns isError when project not in keystore", async () => {
    const result = await handleAddCustomDomain({
      domain: "example.com",
      subdomain_name: "myapp",
      project_id: "no-such-proj",
    });

    assert.equal(result.isError, true);
    assert.ok(result.content[0]!.text.includes("not found in key store"));
  });

  it("returns isError on 400 invalid domain", async () => {
    saveProject("proj-2", {
      anon_key: "ak",
      service_key: "sk",
      tier: "prototype",
      lease_expires_at: "2026-04-01T00:00:00Z",
    });

    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ error: "Invalid domain format" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      )) as typeof fetch;

    const result = await handleAddCustomDomain({
      domain: "not a domain",
      subdomain_name: "myapp",
      project_id: "proj-2",
    });

    assert.equal(result.isError, true);
  });
});

describe("list_custom_domains tool", () => {
  it("returns formatted table when domains exist", async () => {
    saveProject("proj-1", {
      anon_key: "ak",
      service_key: "sk",
      tier: "prototype",
      lease_expires_at: "2026-04-01T00:00:00Z",
    });

    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          domains: [
            {
              domain: "example.com",
              subdomain_name: "myapp",
              url: "https://example.com",
              subdomain_url: "https://myapp.run402.com",
              status: "active",
              created_at: "2026-04-01T00:00:00Z",
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as typeof fetch;

    const result = await handleListCustomDomains({ project_id: "proj-1" });

    assert.equal(result.isError, undefined);
    const text = result.content[0]!.text;
    assert.ok(text.includes("example.com"));
    assert.ok(text.includes("active"));
  });

  it("returns guidance when no domains", async () => {
    saveProject("proj-2", {
      anon_key: "ak",
      service_key: "sk",
      tier: "prototype",
      lease_expires_at: "2026-04-01T00:00:00Z",
    });

    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ domains: [] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as typeof fetch;

    const result = await handleListCustomDomains({ project_id: "proj-2" });

    assert.equal(result.isError, undefined);
    assert.ok(result.content[0]!.text.includes("No custom domains"));
  });

  it("returns isError when project not in keystore", async () => {
    const result = await handleListCustomDomains({ project_id: "nope" });

    assert.equal(result.isError, true);
    assert.ok(result.content[0]!.text.includes("not found in key store"));
  });
});

describe("check_domain_status tool", () => {
  it("returns active status", async () => {
    saveProject("proj-1", {
      anon_key: "ak",
      service_key: "sk",
      tier: "prototype",
      lease_expires_at: "2026-04-01T00:00:00Z",
    });

    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          domain: "example.com",
          subdomain_name: "myapp",
          url: "https://example.com",
          subdomain_url: "https://myapp.run402.com",
          status: "active",
          dns_instructions: null,
          created_at: "2026-04-01T00:00:00Z",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as typeof fetch;

    const result = await handleCheckDomainStatus({
      domain: "example.com",
      project_id: "proj-1",
    });

    assert.equal(result.isError, undefined);
    const text = result.content[0]!.text;
    assert.ok(text.includes("active"));
    assert.ok(text.includes("example.com"));
  });

  it("returns pending status with DNS instructions", async () => {
    saveProject("proj-2", {
      anon_key: "ak",
      service_key: "sk",
      tier: "prototype",
      lease_expires_at: "2026-04-01T00:00:00Z",
    });

    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          domain: "example.com",
          subdomain_name: "myapp",
          url: "https://example.com",
          subdomain_url: "https://myapp.run402.com",
          status: "pending",
          dns_instructions: {
            cname_target: "domains.run402.com",
          },
          created_at: "2026-04-01T00:00:00Z",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as typeof fetch;

    const result = await handleCheckDomainStatus({
      domain: "example.com",
      project_id: "proj-2",
    });

    assert.equal(result.isError, undefined);
    const text = result.content[0]!.text;
    assert.ok(text.includes("pending"));
    assert.ok(text.includes("domains.run402.com"));
  });

  it("returns isError on 404", async () => {
    saveProject("proj-3", {
      anon_key: "ak",
      service_key: "sk",
      tier: "prototype",
      lease_expires_at: "2026-04-01T00:00:00Z",
    });

    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ error: "Domain not found" }),
        { status: 404, headers: { "Content-Type": "application/json" } },
      )) as typeof fetch;

    const result = await handleCheckDomainStatus({
      domain: "nope.com",
      project_id: "proj-3",
    });

    assert.equal(result.isError, true);
  });

  it("returns isError when project not in keystore", async () => {
    const result = await handleCheckDomainStatus({
      domain: "example.com",
      project_id: "nope",
    });

    assert.equal(result.isError, true);
    assert.ok(result.content[0]!.text.includes("not found in key store"));
  });
});

describe("remove_custom_domain tool", () => {
  it("returns success on 200", async () => {
    saveProject("proj-1", {
      anon_key: "ak",
      service_key: "sk",
      tier: "prototype",
      lease_expires_at: "2026-04-01T00:00:00Z",
    });

    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ status: "deleted", domain: "example.com" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as typeof fetch;

    const result = await handleRemoveCustomDomain({
      domain: "example.com",
      project_id: "proj-1",
    });

    assert.equal(result.isError, undefined);
    assert.ok(result.content[0]!.text.includes("Removed"));
    assert.ok(result.content[0]!.text.includes("example.com"));
  });

  it("returns isError on 404", async () => {
    saveProject("proj-2", {
      anon_key: "ak",
      service_key: "sk",
      tier: "prototype",
      lease_expires_at: "2026-04-01T00:00:00Z",
    });

    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ error: "Domain not found" }),
        { status: 404, headers: { "Content-Type": "application/json" } },
      )) as typeof fetch;

    const result = await handleRemoveCustomDomain({
      domain: "nope.com",
      project_id: "proj-2",
    });

    assert.equal(result.isError, true);
  });

  it("returns isError when project not in keystore", async () => {
    const result = await handleRemoveCustomDomain({
      domain: "example.com",
      project_id: "nope",
    });

    assert.equal(result.isError, true);
    assert.ok(result.content[0]!.text.includes("not found in key store"));
  });
});
