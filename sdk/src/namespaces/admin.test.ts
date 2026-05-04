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

describe("admin.getProjectFinance", () => {
  it("GETs the admin finance project endpoint with window and cookie", async () => {
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
