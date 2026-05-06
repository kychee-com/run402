import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Run402 } from "../index.js";
import { LocalError } from "../errors.js";
import type { CredentialsProvider } from "../credentials.js";

function creds(): CredentialsProvider {
  return {
    async getAuth() { return { "SIGN-IN-WITH-X": "t" }; },
    async getProject() { return null; },
  };
}

interface Call { url: string; method: string; headers: Record<string, string>; body: unknown }
function mockFetch(h: (c: Call) => Response): { fetch: typeof globalThis.fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const call: Call = {
      url: String(input),
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body ?? null,
    };
    calls.push(call);
    return h(call);
  };
  return { fetch, calls };
}

function sdk(f: typeof globalThis.fetch): Run402 {
  return new Run402({ apiBase: "https://api.test", credentials: creds(), fetch: f });
}

function json(b: unknown, s = 200): Response {
  return new Response(JSON.stringify(b), { status: s, headers: { "content-type": "application/json" } });
}

function contactEnvelope(overrides: Record<string, unknown> = {}) {
  return {
    wallet: "0xtest",
    name: "test-agent",
    email: "ops@example.com",
    webhook: null,
    email_verification_status: "pending",
    passkey_binding_status: "none",
    assurance_level: "email_pending",
    email_verified_at: null,
    email_verified_message_id: null,
    email_challenge_sent_at: "2026-05-06T12:00:00Z",
    passkey_bound_at: null,
    active_operator_passkey_id: null,
    updated_at: "2026-05-06T12:00:00Z",
    ...overrides,
  };
}

describe("admin.sendMessage", () => {
  it("POSTs /message/v1 with the message body", async () => {
    const { fetch, calls } = mockFetch(() => json({ status: "sent" }));
    await sdk(fetch).admin.sendMessage("hello there");
    assert.equal(calls[0]!.url, "https://api.test/message/v1");
    assert.equal(calls[0]!.method, "POST");
    assert.deepEqual(JSON.parse(calls[0]!.body as string), { message: "hello there" });
  });

  it("returns the gateway envelope with status", async () => {
    const { fetch } = mockFetch(() => json({ status: "sent" }));
    const result = await sdk(fetch).admin.sendMessage("hi");
    assert.equal(result.status, "sent");
  });
});

describe("admin agent contact assurance", () => {
  it("sets contact info and returns assurance fields", async () => {
    const { fetch, calls } = mockFetch(() => json(contactEnvelope()));

    const result = await sdk(fetch).admin.setAgentContact({
      name: "test-agent",
      email: "ops@example.com",
    });

    assert.equal(calls[0]!.url, "https://api.test/agent/v1/contact");
    assert.equal(calls[0]!.method, "POST");
    assert.deepEqual(JSON.parse(calls[0]!.body as string), {
      name: "test-agent",
      email: "ops@example.com",
    });
    assert.equal(result.assurance_level, "email_pending");
    assert.equal(result.email_verification_status, "pending");
  });

  it("gets contact status", async () => {
    const { fetch, calls } = mockFetch(() => json(contactEnvelope({
      email_verification_status: "verified",
      assurance_level: "email_verified",
    })));

    const result = await sdk(fetch).admin.getAgentContactStatus();

    assert.equal(calls[0]!.url, "https://api.test/agent/v1/contact/status");
    assert.equal(calls[0]!.method, "GET");
    assert.equal(result.assurance_level, "email_verified");
  });

  it("starts email verification", async () => {
    const { fetch, calls } = mockFetch(() => json(contactEnvelope({
      verification_retry_after_seconds: 60,
    })));

    const result = await sdk(fetch).admin.verifyAgentContactEmail();

    assert.equal(calls[0]!.url, "https://api.test/agent/v1/contact/verify-email");
    assert.equal(calls[0]!.method, "POST");
    assert.equal(result.verification_retry_after_seconds, 60);
  });

  it("starts operator passkey enrollment", async () => {
    const { fetch, calls } = mockFetch(() => json(contactEnvelope({
      passkey_binding_status: "pending",
      assurance_level: "passkey_pending",
      enrollment_sent_to: "ops@example.com",
    })));

    const result = await sdk(fetch).admin.startOperatorPasskeyEnrollment();

    assert.equal(calls[0]!.url, "https://api.test/agent/v1/contact/passkey/enroll");
    assert.equal(calls[0]!.method, "POST");
    assert.equal(result.enrollment_sent_to, "ops@example.com");
  });
});

describe("admin.getProjectFinance", () => {
  it("GETs the admin finance project endpoint with window and optional cookie", async () => {
    const { fetch, calls } = mockFetch(() => json({
      project_id: "prj_known",
      project_name: "Test Project",
      window: "7d",
      revenue_usd_micros: 6_650_000,
      direct_cost_usd_micros: 1_650_000,
      direct_margin_usd_micros: 5_000_000,
      revenue_breakdown: {
        tier_fees_usd_micros: 5_000_000,
        email_packs_usd_micros: 0,
        kms_rental_usd_micros: 1_200_000,
        kms_sign_fees_usd_micros: 450_000,
        per_call_sku_usd_micros: 0,
      },
      direct_cost_breakdown: [
        { category: "KMS wallet rental", cost_usd_micros: 1_200_000 },
        { category: "Chain gas passthrough", cost_usd_micros: 450_000 },
      ],
      notes: "Direct costs only.",
    }));

    const result = await sdk(fetch).admin.getProjectFinance("prj_known", {
      window: "7d",
      cookie: "run402_admin=session",
    });

    assert.equal(
      calls[0]!.url,
      "https://api.test/admin/api/finance/project/prj_known?window=7d",
    );
    assert.equal(calls[0]!.method, "GET");
    assert.equal(calls[0]!.headers.Cookie, "run402_admin=session");
    assert.equal(calls[0]!.headers["X-Admin-Mode"], "1");
    assert.equal(calls[0]!.headers["SIGN-IN-WITH-X"], "t");
    assert.equal(result.direct_cost_usd_micros, 1_650_000);
    assert.equal(result.direct_cost_breakdown[0]!.category, "KMS wallet rental");
  });

  it("defaults to 30d", async () => {
    const { fetch, calls } = mockFetch(() => json({
      project_id: "prj_known",
      project_name: "Test Project",
      window: "30d",
      revenue_usd_micros: 0,
      direct_cost_usd_micros: 0,
      direct_margin_usd_micros: 0,
      revenue_breakdown: {
        tier_fees_usd_micros: 0,
        email_packs_usd_micros: 0,
        kms_rental_usd_micros: 0,
        kms_sign_fees_usd_micros: 0,
        per_call_sku_usd_micros: 0,
      },
      direct_cost_breakdown: [],
      notes: "Direct costs only.",
    }));

    await sdk(fetch).admin.getProjectFinance("prj_known");

    assert.equal(
      calls[0]!.url,
      "https://api.test/admin/api/finance/project/prj_known?window=30d",
    );
    assert.equal(calls[0]!.headers.Cookie, undefined);
    assert.equal(calls[0]!.headers["X-Admin-Mode"], "1");
    assert.equal(calls[0]!.headers["SIGN-IN-WITH-X"], "t");
  });

  it("rejects invalid windows before making a request", async () => {
    const { fetch, calls } = mockFetch(() => json({}));

    await assert.rejects(
      sdk(fetch).admin.getProjectFinance("prj_known", { window: "1y" as "30d" }),
      LocalError,
    );
    assert.equal(calls.length, 0);
  });
});
