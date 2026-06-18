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

const WALLET_UPPER = "0xABCDEF0123456789ABCDEF0123456789ABCDEF01";
const WALLET_LOWER = "0xabcdef0123456789abcdef0123456789abcdef01";
const ACCOUNT_ID = "00000000-0000-4000-8000-000000000001";

/** The canonical account-detail projection the gateway returns (accountDetailJson). */
function accountDetail(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    org_id: ACCOUNT_ID,
    available_usd_micros: 0,
    email_credits_remaining: 0,
    tier: "prototype",
    lease_expires_at: "2026-05-07T14:49:10.884Z",
    auto_recharge_enabled: false,
    auto_recharge_threshold: 2000,
    ...overrides,
  };
}

/**
 * Mock for history flows: a wallet/email identifier first hits the
 * `?wallet=`/`?email=` lookup (→ account detail), then `/history` (→ the
 * ledger envelope). An org-id identifier skips straight to `/history`.
 */
function historyMock(entries: unknown[] = []) {
  return mockFetch((call) =>
    call.url.includes("/history")
      ? jsonResponse({ org_id: ACCOUNT_ID, entries, has_more: false, next_cursor: null })
      : jsonResponse(accountDetail()),
  );
}

describe("billing.checkBalance / getAccount", () => {
  it("resolves a wallet through the ?wallet= lookup, sends SIWX, and returns the detail", async () => {
    const { fetch, calls } = mockFetch(() => jsonResponse(accountDetail()));
    const sdk = makeSdk(fetch);
    const result = await sdk.billing.checkBalance(WALLET_UPPER);

    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, `https://api.example.test/orgs/v1/lookup?wallet=${WALLET_LOWER}`);
    assert.equal(calls[0]!.method, "GET");
    assert.equal(calls[0]!.headers["SIGN-IN-WITH-X"], "test-siwx");

    assert.equal(result.org_id, ACCOUNT_ID);
    assert.equal(result.available_usd_micros, 0);
    assert.equal(result.email_credits_remaining, 0);
    assert.equal(result.tier, "prototype");
    assert.equal(result.lease_expires_at, "2026-05-07T14:49:10.884Z");
    assert.equal(result.auto_recharge_enabled, false);
    assert.equal(result.auto_recharge_threshold, 2000);
  });

  it("resolves an email through the ?email= lookup and preserves null tier/lease", async () => {
    const { fetch, calls } = mockFetch(() =>
      jsonResponse(accountDetail({ available_usd_micros: 1000000, tier: null, lease_expires_at: null, auto_recharge_threshold: 0 })),
    );
    const sdk = makeSdk(fetch);
    const result = await sdk.billing.getOrganization("user@example.com");

    assert.equal(calls[0]!.url, "https://api.example.test/orgs/v1/lookup?email=user%40example.com");
    assert.equal(result.tier, null);
    assert.equal(result.lease_expires_at, null);
    assert.equal(result.org_id, ACCOUNT_ID);
  });

  it("reads an organization id (UUID) directly without a lookup", async () => {
    const { fetch, calls } = mockFetch(() => jsonResponse(accountDetail()));
    const sdk = makeSdk(fetch);
    await sdk.billing.getOrganization(ACCOUNT_ID);

    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, `https://api.example.test/orgs/v1/${ACCOUNT_ID}/billing`);
    assert.equal(calls[0]!.method, "GET");
    assert.equal(calls[0]!.headers["SIGN-IN-WITH-X"], "test-siwx");
  });

  it("URL-encodes email identifiers with reserved characters", async () => {
    const { fetch, calls } = mockFetch(() => jsonResponse(accountDetail()));
    const sdk = makeSdk(fetch);
    await sdk.billing.getOrganization("billing+team@example.com");

    assert.equal(calls[0]!.url, "https://api.example.test/orgs/v1/lookup?email=billing%2Bteam%40example.com");
  });

  it("rejects malformed balance identifiers before requesting", async () => {
    const invalid = [123, "not an email", "0xabc"];

    for (const identifier of invalid) {
      const { fetch, calls } = mockFetch(() => {
        throw new Error("unexpected fetch for malformed billing identifier");
      });
      const sdk = makeSdk(fetch);

      await assert.rejects(
        sdk.billing.checkBalance(identifier as any),
        (err: unknown) =>
          err instanceof LocalError &&
          err.context === "checking balance",
      );
      assert.equal(calls.length, 0);
    }
  });
});

describe("billing.lookupOrganization", () => {
  it("resolves a wallet to its account via ?wallet=", async () => {
    const { fetch, calls } = mockFetch(() => jsonResponse(accountDetail()));
    const sdk = makeSdk(fetch);
    const result = await sdk.billing.lookupOrganization(WALLET_UPPER);

    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, `https://api.example.test/orgs/v1/lookup?wallet=${WALLET_LOWER}`);
    assert.equal(calls[0]!.headers["SIGN-IN-WITH-X"], "test-siwx");
    assert.equal(result.org_id, ACCOUNT_ID);
  });

  it("resolves an email to its account via ?email=", async () => {
    const { fetch, calls } = mockFetch(() => jsonResponse(accountDetail()));
    const sdk = makeSdk(fetch);
    await sdk.billing.lookupOrganization("user@example.com");

    assert.equal(calls[0]!.url, "https://api.example.test/orgs/v1/lookup?email=user%40example.com");
  });

  it("reads an organization id (UUID) directly", async () => {
    const { fetch, calls } = mockFetch(() => jsonResponse(accountDetail()));
    const sdk = makeSdk(fetch);
    await sdk.billing.lookupOrganization(ACCOUNT_ID);

    assert.equal(calls[0]!.url, `https://api.example.test/orgs/v1/${ACCOUNT_ID}/billing`);
  });

  it("rejects malformed identifiers before requesting", async () => {
    const { fetch, calls } = mockFetch(() => {
      throw new Error("unexpected fetch for malformed lookup identifier");
    });
    const sdk = makeSdk(fetch);

    await assert.rejects(
      sdk.billing.lookupOrganization("nonsense" as any),
      (err: unknown) =>
        err instanceof LocalError &&
        err.context === "looking up organization",
    );
    assert.equal(calls.length, 0);
  });
});

describe("billing.history / getHistory", () => {
  it("resolves a wallet to its organization id, then reads history by id with SIWX on both", async () => {
    const { fetch, calls } = historyMock([
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
    ]);
    const sdk = makeSdk(fetch);
    const result = await sdk.billing.history(WALLET_UPPER);

    assert.equal(calls.length, 2);
    // 1) lookup wallet → org_id
    assert.equal(calls[0]!.url, `https://api.example.test/orgs/v1/lookup?wallet=${WALLET_LOWER}`);
    assert.equal(calls[0]!.headers["SIGN-IN-WITH-X"], "test-siwx");
    // 2) history keyed by the resolved organization id
    assert.equal(calls[1]!.url, `https://api.example.test/orgs/v1/${ACCOUNT_ID}/billing/history`);
    assert.equal(calls[1]!.method, "GET");
    assert.equal(calls[1]!.headers["SIGN-IN-WITH-X"], "test-siwx");

    assert.equal(result.org_id, ACCOUNT_ID);
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

  it("reads history by organization id (UUID) in a single request", async () => {
    const { fetch, calls } = historyMock([]);
    const sdk = makeSdk(fetch);
    await sdk.billing.getHistory(ACCOUNT_ID);

    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, `https://api.example.test/orgs/v1/${ACCOUNT_ID}/billing/history`);
  });

  it("threads ?after=<cursor> onto the history request and surfaces has_more/next_cursor", async () => {
    const { fetch, calls } = mockFetch((call) =>
      call.url.includes("/history")
        ? jsonResponse({ org_id: ACCOUNT_ID, entries: [], has_more: true, next_cursor: "cur_9" })
        : jsonResponse(accountDetail()),
    );
    const sdk = makeSdk(fetch);
    const result = await sdk.billing.getHistory(ACCOUNT_ID, { limit: 10, after: "cur_8" });

    assert.equal(calls[0]!.url, `https://api.example.test/orgs/v1/${ACCOUNT_ID}/billing/history?limit=10&after=cur_8`);
    assert.equal(result.has_more, true);
    assert.equal(result.next_cursor, "cur_9");
  });

  it("appends ?limit=N on the history request (wallet flow)", async () => {
    const { fetch, calls } = historyMock([]);
    const sdk = makeSdk(fetch);
    await sdk.billing.history(WALLET_UPPER, { limit: 50 });

    assert.equal(calls[1]!.url, `https://api.example.test/orgs/v1/${ACCOUNT_ID}/billing/history?limit=50`);
  });

  it("appends ?limit=1 on the by-id history request", async () => {
    const { fetch, calls } = historyMock([]);
    const sdk = makeSdk(fetch);
    await sdk.billing.getHistory(ACCOUNT_ID, { limit: 1 });

    assert.equal(calls[0]!.url, `https://api.example.test/orgs/v1/${ACCOUNT_ID}/billing/history?limit=1`);
  });

  it("throws LocalError and does not request for invalid limits", async () => {
    const invalidLimits = [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1];

    for (const limit of invalidLimits) {
      const { fetch, calls } = mockFetch(() => {
        throw new Error(`unexpected fetch for limit ${String(limit)}`);
      });
      const sdk = makeSdk(fetch);

      await assert.rejects(
        sdk.billing.history(WALLET_UPPER, { limit }),
        (err: unknown) =>
          err instanceof LocalError &&
          err.context === "fetching billing history" &&
          /limit.*positive safe integer/i.test(err.message),
      );
      assert.equal(calls.length, 0, `limit ${String(limit)} should not request`);
    }
  });

  it("offers getHistory as a generic identifier alias (email flow)", async () => {
    const { fetch, calls } = historyMock([]);
    const sdk = makeSdk(fetch);
    await sdk.billing.getHistory("user@example.com", { limit: 25 });

    assert.equal(calls[0]!.url, "https://api.example.test/orgs/v1/lookup?email=user%40example.com");
    assert.equal(calls[1]!.url, `https://api.example.test/orgs/v1/${ACCOUNT_ID}/billing/history?limit=25`);
  });

  it("preserves null reference_type and reference_id for entries without references", async () => {
    const { fetch } = historyMock([
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
    ]);
    const sdk = makeSdk(fetch);
    const result = await sdk.billing.getHistory(ACCOUNT_ID);

    const entry = result.entries[0]!;
    assert.equal(entry.reference_type, null);
    assert.equal(entry.reference_id, null);
    assert.equal(entry.direction, "debit");
    assert.deepEqual(entry.metadata, {});
  });

  it("rejects malformed history identifiers before requesting", async () => {
    const { fetch, calls } = mockFetch(() => {
      throw new Error("unexpected fetch for malformed billing history identifier");
    });
    const sdk = makeSdk(fetch);

    await assert.rejects(
      sdk.billing.history(123 as any),
      (err: unknown) =>
        err instanceof LocalError &&
        err.context === "fetching billing history",
    );
    assert.equal(calls.length, 0);
  });
});

describe("billing.createCheckout", () => {
  it("creates an org balance top-up checkout", async () => {
    const { fetch, calls } = mockFetch(() =>
      jsonResponse({
        org_id: "org_123",
        product: "balance_topup",
        checkout_url: "https://checkout.example.com",
        topup_id: "top_1",
      }),
    );
    const sdk = makeSdk(fetch);

    await sdk.billing.createCheckout("org/../tiers", {
      product: "balance_topup",
      amountUsdMicros: 500_000,
    });

    assert.equal(calls[0]!.url, "https://api.example.test/orgs/v1/org%2F..%2Ftiers/checkouts");
    assert.equal(calls[0]!.headers["SIGN-IN-WITH-X"], "test-siwx");
    assert.deepEqual(JSON.parse(calls[0]!.body as string), {
      product: "balance_topup",
      amount_usd_micros: 500_000,
    });
  });

  it("creates tier and email-pack checkouts through the same endpoint", async () => {
    const { fetch, calls } = mockFetch(() =>
      jsonResponse({
        org_id: "org_123",
        product: "tier",
        checkout_url: "https://checkout.example.com",
        topup_id: "top_1",
      }),
    );
    const sdk = makeSdk(fetch);

    await sdk.billing.createCheckout("org_123", {
      product: "tier",
      tier: "hobby",
      successUrl: "https://run402.com/billing/success",
    });
    await sdk.billing.createCheckout("org_123", { product: "email_pack" });

    assert.deepEqual(JSON.parse(calls[0]!.body as string), {
      product: "tier",
      tier: "hobby",
      success_url: "https://run402.com/billing/success",
    });
    assert.deepEqual(JSON.parse(calls[1]!.body as string), {
      product: "email_pack",
    });
  });

  it("rejects invalid checkout bodies before requesting", async () => {
    const { fetch, calls } = mockFetch(() => {
      throw new Error("unexpected fetch for invalid checkout");
    });
    const sdk = makeSdk(fetch);
    const invalidCalls = [
      () => sdk.billing.createCheckout("", { product: "email_pack" }),
      () => sdk.billing.createCheckout("org_123", null as any),
      () => sdk.billing.createCheckout("org_123", { product: "balance_topup", amountUsdMicros: -1 }),
      () => sdk.billing.createCheckout("org_123", { product: "balance_topup", amountUsdMicros: 0.5 }),
      () => sdk.billing.createCheckout("org_123", { product: "balance_topup", amountUsdMicros: Number.NaN }),
      () => sdk.billing.createCheckout("org_123", { product: "balance_topup", amountUsdMicros: Number.MAX_SAFE_INTEGER + 1 }),
      () => sdk.billing.createCheckout("org_123", { product: "balance_topup", amountUsdMicros: 499_999 }),
      () => sdk.billing.createCheckout("org_123", { product: "balance_topup", amountUsdMicros: 500_001 }),
      () => sdk.billing.createCheckout("org_123", { product: "tier", tier: "../status" } as any),
      () => sdk.billing.createCheckout("org_123", { product: "sku" } as any),
    ];

    for (const runInvalid of invalidCalls) {
      await assert.rejects(
        runInvalid(),
        (err: unknown) =>
          err instanceof LocalError &&
          err.context === "creating checkout",
      );
    }
    assert.equal(calls.length, 0);
  });
});

describe("billing.createEmailOrganization", () => {
  it("rejects malformed emails before requesting", async () => {
    const { fetch, calls } = mockFetch(() => {
      throw new Error("unexpected fetch for malformed email organization");
    });
    const sdk = makeSdk(fetch);

    await assert.rejects(
      sdk.billing.createEmailOrganization("not an email"),
      (err: unknown) =>
        err instanceof LocalError &&
        err.context === "creating email organization",
    );
    assert.equal(calls.length, 0);
  });
});

describe("billing.linkWallet", () => {
  it("URL-encodes organization ids and lowercases wallets", async () => {
    const { fetch, calls } = mockFetch(() => jsonResponse({ status: "ok" }));
    const sdk = makeSdk(fetch);

    await sdk.billing.linkWallet("org/../tiers", WALLET_UPPER);

    assert.equal(
      calls[0]!.url,
      "https://api.example.test/orgs/v1/org%2F..%2Ftiers/wallets",
    );
    assert.equal(calls[0]!.headers["SIGN-IN-WITH-X"], "test-siwx");
    assert.deepEqual(JSON.parse(calls[0]!.body as string), { wallet: WALLET_LOWER });
  });

  it("rejects malformed wallet addresses before requesting", async () => {
    const { fetch, calls } = mockFetch(() => {
      throw new Error("unexpected fetch for malformed linked wallet");
    });
    const sdk = makeSdk(fetch);

    await assert.rejects(
      sdk.billing.linkWallet("org_123", "not-a-wallet"),
      (err: unknown) =>
        err instanceof LocalError &&
        err.context === "linking wallet",
    );
    assert.equal(calls.length, 0);
  });

  it("returns the v1.46 pool_implications block when the gateway includes it", async () => {
    const { fetch } = mockFetch(() =>
      jsonResponse({
        status: "linked",
        org_id: "org_test",
        wallet: WALLET_LOWER,
        pool_implications: {
          tier: "hobby",
          projects_in_pool_count: 3,
          organization_api_calls_current: 12345,
          organization_storage_bytes_current: 314572800,
          tier_limits: { api_calls: 5000000, storage_bytes: 5368709120 },
          over_limit: false,
        },
      }),
    );
    const sdk = makeSdk(fetch);

    const result = await sdk.billing.linkWallet("org_test", WALLET_LOWER);

    assert.equal(result.status, "linked");
    assert.equal(result.org_id, "org_test");
    assert.equal(result.wallet, WALLET_LOWER);
    assert.equal(result.pool_implications?.tier, "hobby");
    assert.equal(result.pool_implications?.projects_in_pool_count, 3);
    assert.equal(result.pool_implications?.organization_api_calls_current, 12345);
    assert.equal(result.pool_implications?.over_limit, false);
    assert.equal(result.pool_implications?.tier_limits.api_calls, 5000000);
    assert.equal(result.pool_implications?.tier_limits.storage_bytes, 5368709120);
  });

  it("returns the pre-v1.46 envelope unchanged when pool_implications is absent", async () => {
    const { fetch } = mockFetch(() => jsonResponse({ status: "ok" }));
    const sdk = makeSdk(fetch);

    const result = await sdk.billing.linkWallet("org_test", WALLET_LOWER);

    assert.equal(result.status, "ok");
    assert.equal(result.pool_implications, undefined);
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
          organizationId: "org_123",
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
      organizationId: "org_zero",
      enabled: true,
      threshold: 0,
    });
    await sdk.billing.setAutoRecharge({
      organizationId: "org_positive",
      enabled: true,
      threshold: 2000,
    });

    assert.equal(calls.length, 2);
    assert.equal(calls[0]!.headers["SIGN-IN-WITH-X"], "test-siwx");
    assert.equal(calls[1]!.headers["SIGN-IN-WITH-X"], "test-siwx");
    assert.equal(calls[0]!.url, "https://api.example.test/orgs/v1/org_zero/billing/auto-recharge");
    assert.equal(calls[1]!.url, "https://api.example.test/orgs/v1/org_positive/billing/auto-recharge");
    assert.equal(calls[0]!.method, "PATCH");
    assert.equal(calls[1]!.method, "PATCH");
    assert.deepEqual(JSON.parse(calls[0]!.body as string), {
      enabled: true,
      threshold: 0,
    });
    assert.deepEqual(JSON.parse(calls[1]!.body as string), {
      enabled: true,
      threshold: 2000,
    });
  });
});
