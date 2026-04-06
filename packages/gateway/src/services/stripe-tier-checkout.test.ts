import { describe, it, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mockStripeSessionsCreate: (args: any) => Promise<any>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mockStripeCustomersCreate: (args: any) => Promise<any>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mockStripeCustomersSearch: (args: any) => Promise<any>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mockPoolQuery: (...args: any[]) => Promise<any>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mockGetOrCreateByWallet: (wallet: string) => Promise<any>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mockGetOrCreateByEmail: (email: string) => Promise<any>;

mock.module("stripe", {
  defaultExport: class Stripe {
    checkout = {
      sessions: {
        create: (args: unknown) => mockStripeSessionsCreate(args),
      },
    };
    customers = {
      create: (args: unknown) => mockStripeCustomersCreate(args),
      search: (args: unknown) => mockStripeCustomersSearch(args),
    };
    webhooks = {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      constructEvent: (..._args: any[]) => ({}),
    };
  },
});

mock.module("../db/pool.js", {
  namedExports: {
    pool: { query: (...args: unknown[]) => mockPoolQuery(...args) },
  },
});

mock.module("../db/sql.js", {
  namedExports: { sql: (s: string) => s },
});

mock.module("../config.js", {
  namedExports: {
    STRIPE_SECRET_KEY: "sk_test_dummy",
    STRIPE_WEBHOOK_SECRET: "whsec_test",
    STRIPE_WEBHOOK_SECRET_LIVE: "",
    STRIPE_PRICE_PROTOTYPE: "price_proto",
    STRIPE_PRICE_HOBBY: "price_hobby",
    STRIPE_PRICE_TEAM: "price_team",
    STRIPE_PRICE_EMAIL_PACK: "price_pack",
  },
});

mock.module("./billing.js", {
  namedExports: {
    getOrCreateBillingAccount: (wallet: string) => mockGetOrCreateByWallet(wallet),
    getOrCreateBillingAccountByEmail: (email: string) => mockGetOrCreateByEmail(email),
  },
});

mock.module("../utils/async-handler.js", {
  namedExports: {
    HttpError: class HttpError extends Error {
      public statusCode: number;
      constructor(statusCode: number, message: string) {
        super(message);
        this.statusCode = statusCode;
        this.name = "HttpError";
      }
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    asyncHandler: (fn: any) => fn,
  },
});

const { createTierCheckout } = await import("./stripe-tier-checkout.js");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAccount(overrides: Record<string, unknown> = {}) {
  return {
    id: "acct-1",
    status: "active",
    currency: "USD",
    available_usd_micros: 0,
    held_usd_micros: 0,
    funding_policy: "allowance_then_wallet",
    low_balance_threshold_usd_micros: 1000000,
    primary_contact_email: null,
    tier: null,
    lease_started_at: null,
    lease_expires_at: null,
    email_credits_remaining: 0,
    auto_recharge_enabled: false,
    auto_recharge_threshold: 2000,
    auto_recharge_failure_count: 0,
    stripe_customer_id: null,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// createTierCheckout
// ---------------------------------------------------------------------------

describe("createTierCheckout", () => {
  beforeEach(() => {
    mockPoolQuery = async () => ({ rows: [], rowCount: 1 });
    mockStripeSessionsCreate = async () => ({ id: "cs_test_123", url: "https://checkout.stripe.com/pay/cs_test_123" });
    mockStripeCustomersSearch = async () => ({ data: [] });
    mockStripeCustomersCreate = async () => ({ id: "cus_test_123" });
    mockGetOrCreateByWallet = async (wallet: string) => makeAccount({ id: "acct-wallet", primary_contact_email: null });
    mockGetOrCreateByEmail = async (email: string) => makeAccount({ id: "acct-email", primary_contact_email: email });
  });

  it("creates checkout session for wallet identifier (subscribe)", async () => {
    let sessionArgs: Record<string, unknown> | null = null;
    mockStripeSessionsCreate = async (args: Record<string, unknown>) => {
      sessionArgs = args;
      return { id: "cs_1", url: "https://checkout.stripe.com/cs_1" };
    };

    const result = await createTierCheckout(
      { type: "wallet", value: "0x1234567890abcdef1234567890abcdef12345678" },
      "hobby",
    );

    assert.ok(result.checkout_url);
    assert.ok(result.topup_id);
    assert.ok(sessionArgs, "Stripe session should be created");
    const args = sessionArgs as { line_items: Array<{ price: string; quantity: number }>; mode: string };
    assert.equal(args.line_items[0].price, "price_hobby");
    assert.equal(args.mode, "payment");
  });

  it("creates checkout session for email identifier", async () => {
    let usedEmail = false;
    mockGetOrCreateByEmail = async (email: string) => {
      usedEmail = true;
      return makeAccount({ id: "acct-email", primary_contact_email: email });
    };

    const result = await createTierCheckout(
      { type: "email", value: "user@example.com" },
      "hobby",
    );

    assert.ok(result.checkout_url);
    assert.ok(usedEmail, "should call email-based account lookup");
  });

  it("uses correct Stripe price ID per tier", async () => {
    const prices: string[] = [];
    mockStripeSessionsCreate = async (args: Record<string, unknown>) => {
      const items = args.line_items as Array<{ price: string }>;
      prices.push(items[0].price);
      return { id: "cs_x", url: "https://checkout.stripe.com/x" };
    };

    await createTierCheckout({ type: "wallet", value: "0x1234567890abcdef1234567890abcdef12345678" }, "prototype");
    await createTierCheckout({ type: "wallet", value: "0x1234567890abcdef1234567890abcdef12345678" }, "hobby");
    await createTierCheckout({ type: "wallet", value: "0x1234567890abcdef1234567890abcdef12345678" }, "team");

    assert.equal(prices[0], "price_proto");
    assert.equal(prices[1], "price_hobby");
    assert.equal(prices[2], "price_team");
  });

  it("stores topup row with topup_type='tier' and tier_name", async () => {
    const inserts: Array<{ sql: string; params: unknown[] }> = [];
    mockPoolQuery = async (sqlStr: string, params?: unknown[]) => {
      if (sqlStr.includes("INSERT") && sqlStr.includes("billing_topups")) {
        inserts.push({ sql: sqlStr, params: params || [] });
      }
      return { rows: [], rowCount: 1 };
    };

    await createTierCheckout({ type: "wallet", value: "0x1234567890abcdef1234567890abcdef12345678" }, "hobby");

    assert.equal(inserts.length, 1, "should INSERT exactly one topup row");
    const insertSql = inserts[0].sql;
    assert.ok(insertSql.includes("topup_type"), "INSERT should set topup_type");
    assert.ok(insertSql.includes("tier_name"), "INSERT should set tier_name");
  });

  it("throws 400 for invalid tier name", async () => {
    await assert.rejects(
      async () => await createTierCheckout(
        { type: "wallet", value: "0x1234567890abcdef1234567890abcdef12345678" },
        "enterprise" as unknown as "hobby",
      ),
      (err: unknown) => (err as { statusCode?: number }).statusCode === 400,
    );
  });

  it("includes metadata with billing_account_id, topup_id, tier_name", async () => {
    let metadata: Record<string, string> | null = null;
    mockStripeSessionsCreate = async (args: Record<string, unknown>) => {
      metadata = args.metadata as Record<string, string>;
      return { id: "cs_meta", url: "https://checkout.stripe.com/cs_meta" };
    };

    await createTierCheckout({ type: "wallet", value: "0x1234567890abcdef1234567890abcdef12345678" }, "team");

    assert.ok(metadata);
    const m = metadata as Record<string, string>;
    assert.ok(m.billing_account_id);
    assert.ok(m.topup_id);
    assert.equal(m.topup_type, "tier");
    assert.equal(m.tier_name, "team");
  });
});
