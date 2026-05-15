/**
 * Unit tests for the `billing` namespace. Mirrors the projects.test.ts pattern:
 * mocks `fetch` per call, asserts URL/method/headers, and verifies that the
 * declared TypeScript shapes match the runtime envelopes the gateway returns.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { Run402 } from "../index.js";
import { LocalError } from "../errors.js";
import type { CredentialsProvider } from "../credentials.js";

interface FetchCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function mockFetch(
  handler: (call: FetchCall) => Response | Promise<Response>,
): { fetch: typeof globalThis.fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fetchImpl: typeof globalThis.fetch = async (input, init) => {
    const call: FetchCall = {
      url: String(input),
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body ?? null,
    };
    calls.push(call);
    return handler(call);
  };
  return { fetch: fetchImpl, calls };
}

function makeCreds(
  overrides: Partial<CredentialsProvider> = {},
): CredentialsProvider {
  return {
    async getAuth() {
      return { "SIGN-IN-WITH-X": "test-siwx" };
    },
    async getProject() {
      return null;
    },
    ...overrides,
  };
}

function makeSdk(fetchImpl: typeof globalThis.fetch): Run402 {
  return new Run402({
    apiBase: "https://api.example.test",
    credentials: makeCreds(),
    fetch: fetchImpl,
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("billing.checkBalance", () => {
  it("GETs /billing/v1/accounts/:wallet without auth and returns the runtime shape", async () => {
    const { fetch, calls } = mockFetch(() =>
      jsonResponse({
        available_usd_micros: 0,
        email_credits_remaining: 0,
        tier: "prototype",
        lease_expires_at: "2026-05-07T14:49:10.884Z",
        auto_recharge_enabled: false,
        auto_recharge_threshold: 2000,
        identifier_type: "wallet",
      }),
    );
    const sdk = makeSdk(fetch);
    const result = await sdk.billing.checkBalance("0xABC");

    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, "https://api.example.test/billing/v1/accounts/0xabc");
    assert.equal(calls[0]!.method, "GET");
    assert.equal(calls[0]!.headers["SIGN-IN-WITH-X"], undefined);

    assert.equal(result.identifier_type, "wallet");
    assert.equal(result.available_usd_micros, 0);
    assert.equal(result.email_credits_remaining, 0);
    assert.equal(result.tier, "prototype");
    assert.equal(result.lease_expires_at, "2026-05-07T14:49:10.884Z");
    assert.equal(result.auto_recharge_enabled, false);
    assert.equal(result.auto_recharge_threshold, 2000);
  });

  it("preserves null tier and lease_expires_at for unleased accounts", async () => {
    const { fetch, calls } = mockFetch(() =>
      jsonResponse({
        available_usd_micros: 1000000,
        email_credits_remaining: 0,
        tier: null,
        lease_expires_at: null,
        auto_recharge_enabled: false,
        auto_recharge_threshold: 0,
        identifier_type: "email",
      }),
    );
    const sdk = makeSdk(fetch);
    const result = await sdk.billing.checkBalance("user@example.com");

    assert.equal(calls[0]!.url, "https://api.example.test/billing/v1/accounts/user%40example.com");
    assert.equal(result.tier, null);
    assert.equal(result.lease_expires_at, null);
    assert.equal(result.identifier_type, "email");
  });

  it("offers getAccount as a generic identifier alias", async () => {
    const { fetch, calls } = mockFetch(() =>
      jsonResponse({
        available_usd_micros: 1000000,
        email_credits_remaining: 0,
        tier: null,
        lease_expires_at: null,
        auto_recharge_enabled: false,
        auto_recharge_threshold: 0,
        identifier_type: "email",
      }),
    );
    const sdk = makeSdk(fetch);
    await sdk.billing.getAccount("billing+team@example.com");

    assert.equal(calls[0]!.url, "https://api.example.test/billing/v1/accounts/billing%2Bteam%40example.com");
  });
});

describe("billing.history", () => {
  it("GETs /billing/v1/accounts/:wallet/history and returns identifier-keyed envelope", async () => {
    const { fetch, calls } = mockFetch(() =>
      jsonResponse({
        identifier: "0xabc",
        identifier_type: "wallet",
        entries: [
          {
            id: "ent_1",
            direction: "credit",
            kind: "stripe_topup",
            amount_usd_micros: 5000000,
            balance_after_available: 5000000,
            balance_after_held: 0,
            reference_type: "stripe_session",
            reference_id: "cs_test_123",
            metadata: { source: "checkout" },
            created_at: "2026-04-30T10:00:00.000Z",
          },
        ],
      }),
    );
    const sdk = makeSdk(fetch);
    const result = await sdk.billing.history("0xABC");

    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, "https://api.example.test/billing/v1/accounts/0xabc/history");
    assert.equal(calls[0]!.method, "GET");

    assert.equal(result.identifier, "0xabc");
    assert.equal(result.identifier_type, "wallet");
    assert.equal(result.entries.length, 1);

    const entry = result.entries[0]!;
    assert.equal(entry.id, "ent_1");
    assert.equal(entry.direction, "credit");
    assert.equal(entry.kind, "stripe_topup");
    assert.equal(entry.amount_usd_micros, 5000000);
    assert.equal(entry.balance_after_available, 5000000);
    assert.equal(entry.balance_after_held, 0);
    assert.equal(entry.reference_type, "stripe_session");
    assert.equal(entry.reference_id, "cs_test_123");
    assert.deepEqual(entry.metadata, { source: "checkout" });
    assert.equal(entry.created_at, "2026-04-30T10:00:00.000Z");
  });

  it("appends ?limit=N when limit is provided", async () => {
    const { fetch, calls } = mockFetch(() =>
      jsonResponse({ identifier: "0xabc", identifier_type: "wallet", entries: [] }),
    );
    const sdk = makeSdk(fetch);
    await sdk.billing.history("0xABC", 50);

    assert.equal(calls[0]!.url, "https://api.example.test/billing/v1/accounts/0xabc/history?limit=50");
  });

  it("appends ?limit=1 when the minimum valid limit is provided", async () => {
    const { fetch, calls } = mockFetch(() =>
      jsonResponse({ identifier: "0xabc", identifier_type: "wallet", entries: [] }),
    );
    const sdk = makeSdk(fetch);
    await sdk.billing.history("0xABC", 1);

    assert.equal(calls[0]!.url, "https://api.example.test/billing/v1/accounts/0xabc/history?limit=1");
  });

  it("throws LocalError and does not request for invalid limits", async () => {
    const invalidLimits = [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1];

    for (const limit of invalidLimits) {
      const { fetch, calls } = mockFetch(() => {
        throw new Error(`unexpected fetch for limit ${String(limit)}`);
      });
      const sdk = makeSdk(fetch);

      await assert.rejects(
        sdk.billing.history("0xABC", limit),
        (err: unknown) =>
          err instanceof LocalError &&
          err.context === "fetching billing history" &&
          /limit.*positive safe integer/i.test(err.message),
      );
      assert.equal(calls.length, 0, `limit ${String(limit)} should not request`);
    }
  });

  it("offers getHistory as a generic identifier alias", async () => {
    const { fetch, calls } = mockFetch(() =>
      jsonResponse({ identifier: "user@example.com", identifier_type: "email", entries: [] }),
    );
    const sdk = makeSdk(fetch);
    await sdk.billing.getHistory("user@example.com", 25);

    assert.equal(calls[0]!.url, "https://api.example.test/billing/v1/accounts/user%40example.com/history?limit=25");
  });

  it("preserves null reference_type and reference_id for entries without references", async () => {
    const { fetch } = mockFetch(() =>
      jsonResponse({
        identifier: "0xabc",
        identifier_type: "wallet",
        entries: [
          {
            id: "ent_2",
            direction: "debit",
            kind: "api_call",
            amount_usd_micros: 100,
            balance_after_available: 999900,
            balance_after_held: 0,
            reference_type: null,
            reference_id: null,
            metadata: {},
            created_at: "2026-04-30T10:01:00.000Z",
          },
        ],
      }),
    );
    const sdk = makeSdk(fetch);
    const result = await sdk.billing.history("0xABC");

    const entry = result.entries[0]!;
    assert.equal(entry.reference_type, null);
    assert.equal(entry.reference_id, null);
    assert.equal(entry.direction, "debit");
    assert.deepEqual(entry.metadata, {});
  });
});

describe("billing tier checkout identifiers", () => {
  it("rejects both email and wallet before requesting", async () => {
    const { fetch, calls } = mockFetch(() => {
      throw new Error("unexpected fetch for ambiguous tier checkout identifier");
    });
    const sdk = makeSdk(fetch);

    await assert.rejects(
      sdk.billing.tierCheckout("hobby", {
        email: "user@example.com",
        wallet: "0xabc",
      }),
      (err: unknown) =>
        err instanceof LocalError &&
        err.context === "creating tier checkout" &&
        /either `email` or `wallet`/i.test(err.message),
    );
    assert.equal(calls.length, 0);
  });
});

describe("billing email pack checkout identifiers", () => {
  it("rejects both email and wallet before requesting", async () => {
    const { fetch, calls } = mockFetch(() => {
      throw new Error("unexpected fetch for ambiguous email pack identifier");
    });
    const sdk = makeSdk(fetch);

    await assert.rejects(
      sdk.billing.buyEmailPack({
        email: "user@example.com",
        wallet: "0xabc",
      }),
      (err: unknown) =>
        err instanceof LocalError &&
        err.context === "creating email pack checkout" &&
        /either `email` or `wallet`/i.test(err.message),
    );
    assert.equal(calls.length, 0);
  });
});

describe("billing.setAutoRecharge", () => {
  it("rejects invalid thresholds before requesting", async () => {
    const invalidThresholds = [Number.NaN, 1.5, -1, Number.POSITIVE_INFINITY];

    for (const threshold of invalidThresholds) {
      const { fetch, calls } = mockFetch(() => {
        throw new Error(`unexpected fetch for threshold ${String(threshold)}`);
      });
      const sdk = makeSdk(fetch);

      await assert.rejects(
        sdk.billing.setAutoRecharge({
          billingAccountId: "acct_123",
          enabled: true,
          threshold,
        }),
        (err: unknown) =>
          err instanceof LocalError &&
          err.context === "setting auto-recharge" &&
          /threshold.*non-negative safe integer/i.test(err.message),
      );
      assert.equal(calls.length, 0, `threshold ${String(threshold)} should not request`);
    }
  });

  it("allows zero and positive safe integer thresholds", async () => {
    const { fetch, calls } = mockFetch(() => jsonResponse({ status: "ok" }));
    const sdk = makeSdk(fetch);

    await sdk.billing.setAutoRecharge({
      billingAccountId: "acct_zero",
      enabled: true,
      threshold: 0,
    });
    await sdk.billing.setAutoRecharge({
      billingAccountId: "acct_positive",
      enabled: true,
      threshold: 2000,
    });

    assert.equal(calls.length, 2);
    assert.deepEqual(JSON.parse(calls[0]!.body as string), {
      billing_account_id: "acct_zero",
      enabled: true,
      threshold: 0,
    });
    assert.deepEqual(JSON.parse(calls[1]!.body as string), {
      billing_account_id: "acct_positive",
      enabled: true,
      threshold: 2000,
    });
  });
});
