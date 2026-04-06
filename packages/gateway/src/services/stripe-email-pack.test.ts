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
let mockPoolConnect: () => Promise<any>;
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeFakeClient(queryHandler: (...args: any[]) => Promise<any>) {
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    query: (...args: any[]) => queryHandler(...args),
    release: () => {},
  };
}

mock.module("../db/pool.js", {
  namedExports: {
    pool: {
      query: (...args: unknown[]) => mockPoolQuery(...args),
      connect: () => mockPoolConnect(),
    },
  },
});

mock.module("../db/sql.js", {
  namedExports: { sql: (s: string) => s },
});

mock.module("../config.js", {
  namedExports: {
    STRIPE_SECRET_KEY: "sk_test_dummy",
    STRIPE_PRICE_EMAIL_PACK: "price_pack_test",
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

const { createEmailPackCheckout, creditEmailPackFromTopup, EMAIL_PACK_SIZE } = await import("./stripe-email-pack.js");

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
// EMAIL_PACK_SIZE constant
// ---------------------------------------------------------------------------

describe("EMAIL_PACK_SIZE", () => {
  it("is 10000 emails", () => {
    assert.equal(EMAIL_PACK_SIZE, 10000);
  });
});

// ---------------------------------------------------------------------------
// createEmailPackCheckout
// ---------------------------------------------------------------------------

describe("createEmailPackCheckout", () => {
  beforeEach(() => {
    mockPoolQuery = async () => ({ rows: [], rowCount: 1 });
    mockPoolConnect = async () => makeFakeClient(async () => ({ rows: [], rowCount: 1 }));
    mockStripeSessionsCreate = async () => ({ id: "cs_pack_1", url: "https://checkout.stripe.com/cs_pack_1" });
    mockStripeCustomersSearch = async () => ({ data: [] });
    mockStripeCustomersCreate = async () => ({ id: "cus_test_123" });
    mockGetOrCreateByWallet = async () => makeAccount({ id: "acct-wallet" });
    mockGetOrCreateByEmail = async (email: string) => makeAccount({ id: "acct-email", primary_contact_email: email });
  });

  it("creates checkout session for wallet identifier", async () => {
    let sessionArgs: Record<string, unknown> | null = null;
    mockStripeSessionsCreate = async (args: Record<string, unknown>) => {
      sessionArgs = args;
      return { id: "cs_p", url: "https://checkout.stripe.com/cs_p" };
    };

    const result = await createEmailPackCheckout({
      type: "wallet",
      value: "0x1234567890abcdef1234567890abcdef12345678",
    });

    assert.ok(result.checkout_url);
    assert.ok(result.topup_id);
    assert.ok(sessionArgs);
    const args = sessionArgs as { line_items: Array<{ price: string }>; mode: string };
    assert.equal(args.line_items[0].price, "price_pack_test");
    assert.equal(args.mode, "payment");
  });

  it("creates checkout session for email identifier", async () => {
    let usedEmail = false;
    mockGetOrCreateByEmail = async (email: string) => {
      usedEmail = true;
      return makeAccount({ id: "acct-email", primary_contact_email: email });
    };

    await createEmailPackCheckout({ type: "email", value: "user@example.com" });
    assert.ok(usedEmail, "should use email-based account lookup");
  });

  it("stores topup row with topup_type='email_pack', funded_email_credits=10000", async () => {
    const inserts: Array<{ sql: string; params: unknown[] }> = [];
    mockPoolQuery = async (sqlStr: string, params?: unknown[]) => {
      if (sqlStr.includes("INSERT") && sqlStr.includes("billing_topups")) {
        inserts.push({ sql: sqlStr, params: params || [] });
      }
      return { rows: [], rowCount: 1 };
    };

    await createEmailPackCheckout({ type: "wallet", value: "0x1234567890abcdef1234567890abcdef12345678" });

    assert.equal(inserts.length, 1);
    const sqlText = inserts[0].sql;
    assert.ok(sqlText.includes("topup_type"));
    assert.ok(sqlText.includes("funded_email_credits"));
    // Verify params contain 'email_pack' and 10000
    const params = inserts[0].params as unknown[];
    assert.ok(params.includes("email_pack"), "should set topup_type='email_pack'");
    assert.ok(params.includes(10000), "should set funded_email_credits=10000");
  });

  it("includes metadata identifying topup_type='email_pack'", async () => {
    let metadata: Record<string, string> | null = null;
    mockStripeSessionsCreate = async (args: Record<string, unknown>) => {
      metadata = args.metadata as Record<string, string>;
      return { id: "cs_x", url: "https://checkout.stripe.com/cs_x" };
    };

    await createEmailPackCheckout({ type: "wallet", value: "0x1234567890abcdef1234567890abcdef12345678" });
    const m = metadata as Record<string, string> | null;
    assert.ok(m);
    assert.equal(m!.topup_type, "email_pack");
    assert.ok(m!.billing_account_id);
    assert.ok(m!.topup_id);
  });
});

// ---------------------------------------------------------------------------
// creditEmailPackFromTopup
// ---------------------------------------------------------------------------

describe("creditEmailPackFromTopup", () => {
  beforeEach(() => {
    mockPoolQuery = async () => ({ rows: [], rowCount: 1 });
    mockPoolConnect = async () => makeFakeClient(async () => ({ rows: [{ email_credits_remaining: 0 }], rowCount: 1 }));
  });

  it("credits pack credits to account and updates topup status", async () => {
    const queries: Array<{ sql: string; params: unknown[] }> = [];
    const handler = async (sqlStr: string, params?: unknown[]) => {
      queries.push({ sql: sqlStr, params: params || [] });
      if (sqlStr.includes("SELECT") && sqlStr.includes("billing_topups")) {
        return {
          rows: [{
            id: "topup-pack",
            billing_account_id: "acct-pack",
            topup_type: "email_pack",
            funded_email_credits: 10000,
            status: "paid",
          }],
          rowCount: 1,
        };
      }
      if (sqlStr.includes("SELECT") && sqlStr.includes("billing_accounts") && sqlStr.includes("FOR UPDATE")) {
        return {
          rows: [{ id: "acct-pack", email_credits_remaining: 0, available_usd_micros: "0", held_usd_micros: "0" }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 1 };
    };
    mockPoolQuery = handler;
    mockPoolConnect = async () => makeFakeClient(handler);

    await creditEmailPackFromTopup("topup-pack", "evt_test_123");

    // Verify UPDATE to increment email_credits_remaining
    const updateCredits = queries.find(q =>
      q.sql.includes("UPDATE") &&
      q.sql.includes("billing_accounts") &&
      q.sql.includes("email_credits_remaining")
    );
    assert.ok(updateCredits, "should UPDATE email_credits_remaining");

    // Verify ledger entry
    const ledgerInsert = queries.find(q =>
      q.sql.includes("INSERT") &&
      q.sql.includes("allowance_ledger") &&
      (q.params as unknown[]).some(p => p === "email_pack_purchase"),
    );
    assert.ok(ledgerInsert, "should INSERT email_pack_purchase ledger entry");

    // Verify topup status updated to credited
    const updateTopup = queries.find(q =>
      q.sql.includes("UPDATE") &&
      q.sql.includes("billing_topups") &&
      (q.params as unknown[]).some(p => p === "credited"),
    );
    assert.ok(updateTopup, "should UPDATE topup status to credited");
  });

  it("is idempotent — returns without double-crediting if topup already credited", async () => {
    const queries: Array<{ sql: string; params: unknown[] }> = [];
    const handler = async (sqlStr: string, params?: unknown[]) => {
      queries.push({ sql: sqlStr, params: params || [] });
      if (sqlStr.includes("SELECT") && sqlStr.includes("billing_topups")) {
        return {
          rows: [{
            id: "topup-pack-dupe",
            billing_account_id: "acct-pack",
            topup_type: "email_pack",
            funded_email_credits: 10000,
            status: "credited", // Already credited
          }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    };
    mockPoolQuery = handler;
    mockPoolConnect = async () => makeFakeClient(handler);

    await creditEmailPackFromTopup("topup-pack-dupe", "evt_dupe");

    // No UPDATE to email_credits_remaining should have happened
    const creditUpdate = queries.find(q =>
      q.sql.includes("UPDATE") &&
      q.sql.includes("billing_accounts") &&
      q.sql.includes("email_credits_remaining")
    );
    assert.equal(creditUpdate, undefined, "should NOT update credits for already-credited topup");
  });

  it("throws if topup not found", async () => {
    mockPoolQuery = async () => ({ rows: [], rowCount: 0 });
    await assert.rejects(
      async () => await creditEmailPackFromTopup("missing", "evt_x"),
      /not found/,
    );
  });

  it("throws if topup_type is not 'email_pack'", async () => {
    mockPoolQuery = async (sqlStr: string) => {
      if (sqlStr.includes("SELECT") && sqlStr.includes("billing_topups")) {
        return {
          rows: [{
            id: "topup-wrong",
            billing_account_id: "acct-x",
            topup_type: "tier",
            funded_email_credits: 0,
            status: "paid",
          }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    };
    await assert.rejects(
      async () => await creditEmailPackFromTopup("topup-wrong", "evt_y"),
      /topup_type/,
    );
  });
});
