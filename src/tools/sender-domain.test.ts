import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { handleRegisterSenderDomain } from "./register-sender-domain.js";
import { handleSenderDomainStatus } from "./sender-domain-status.js";
import { handleRemoveSenderDomain } from "./remove-sender-domain.js";
import { handleEnableInbound } from "./enable-inbound.js";
import { handleDisableInbound } from "./disable-inbound.js";
import { saveProject } from "../keystore.js";

const originalFetch = globalThis.fetch;
let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "run402-sender-test-"));
  process.env.RUN402_CONFIG_DIR = tempDir;
  process.env.RUN402_API_BASE = "https://test-api.run402.com";
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  rmSync(tempDir, { recursive: true, force: true });
  delete process.env.RUN402_CONFIG_DIR;
  delete process.env.RUN402_API_BASE;
});

describe("register_sender_domain tool", () => {
  it("sends Authorization: Bearer <service_key> header and no apikey header", async () => {
    saveProject("proj-sd1", {
      anon_key: "ak-sd1",
      service_key: "sk-sd1",
      tier: "prototype",
      lease_expires_at: "2026-04-01T00:00:00Z",
    });

    let capturedHeaders: Record<string, string> = {};
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      capturedHeaders = init?.headers as Record<string, string>;
      return new Response(
        JSON.stringify({
          domain: "example.com",
          status: "pending",
          dns_records: [{ type: "CNAME", name: "mail.example.com", value: "dkim.run402.com" }],
          instructions: "Add the DNS records above.",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    await handleRegisterSenderDomain({
      project_id: "proj-sd1",
      domain: "example.com",
    });

    assert.equal(capturedHeaders["Authorization"], "Bearer sk-sd1");
    assert.equal(capturedHeaders["apikey"], undefined);
  });
});

describe("sender_domain_status tool", () => {
  it("sends Authorization: Bearer <service_key> header and no apikey header", async () => {
    saveProject("proj-sd2", {
      anon_key: "ak-sd2",
      service_key: "sk-sd2",
      tier: "prototype",
      lease_expires_at: "2026-04-01T00:00:00Z",
    });

    let capturedHeaders: Record<string, string> = {};
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      capturedHeaders = init?.headers as Record<string, string>;
      return new Response(
        JSON.stringify({ domain: "example.com", status: "verified", verified_at: "2026-04-01T00:00:00Z" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    await handleSenderDomainStatus({ project_id: "proj-sd2" });

    assert.equal(capturedHeaders["Authorization"], "Bearer sk-sd2");
    assert.equal(capturedHeaders["apikey"], undefined);
  });
});

describe("remove_sender_domain tool", () => {
  it("sends Authorization: Bearer <service_key> header and no apikey header", async () => {
    saveProject("proj-sd3", {
      anon_key: "ak-sd3",
      service_key: "sk-sd3",
      tier: "prototype",
      lease_expires_at: "2026-04-01T00:00:00Z",
    });

    let capturedHeaders: Record<string, string> = {};
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      capturedHeaders = init?.headers as Record<string, string>;
      return new Response(
        JSON.stringify({ status: "deleted" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    await handleRemoveSenderDomain({ project_id: "proj-sd3" });

    assert.equal(capturedHeaders["Authorization"], "Bearer sk-sd3");
    assert.equal(capturedHeaders["apikey"], undefined);
  });
});

describe("enable_inbound tool", () => {
  it("sends Authorization: Bearer <service_key> header and no apikey header", async () => {
    saveProject("proj-sd4", {
      anon_key: "ak-sd4",
      service_key: "sk-sd4",
      tier: "prototype",
      lease_expires_at: "2026-04-01T00:00:00Z",
    });

    let capturedHeaders: Record<string, string> = {};
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      capturedHeaders = init?.headers as Record<string, string>;
      return new Response(
        JSON.stringify({ status: "enabled", mx_record: "10 mx.run402.com" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    await handleEnableInbound({ project_id: "proj-sd4", domain: "example.com" });

    assert.equal(capturedHeaders["Authorization"], "Bearer sk-sd4");
    assert.equal(capturedHeaders["apikey"], undefined);
  });
});

describe("disable_inbound tool", () => {
  it("sends Authorization: Bearer <service_key> header and no apikey header", async () => {
    saveProject("proj-sd5", {
      anon_key: "ak-sd5",
      service_key: "sk-sd5",
      tier: "prototype",
      lease_expires_at: "2026-04-01T00:00:00Z",
    });

    let capturedHeaders: Record<string, string> = {};
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      capturedHeaders = init?.headers as Record<string, string>;
      return new Response(
        JSON.stringify({ status: "disabled" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    await handleDisableInbound({ project_id: "proj-sd5", domain: "example.com" });

    assert.equal(capturedHeaders["Authorization"], "Bearer sk-sd5");
    assert.equal(capturedHeaders["apikey"], undefined);
  });
});
