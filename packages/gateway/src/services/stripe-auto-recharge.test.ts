import { describe, it, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mockPoolQuery: (...args: any[]) => Promise<any>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mockPoolConnect: () => Promise<any>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mockStripePaymentIntentsCreate: (args: any) => Promise<any>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mockStripeCustomersRetrieve: (id: string) => Promise<any>;

mock.module("stripe", {
  defaultExport: class Stripe {
    customers = {
      retrieve: (id: string) => mockStripeCustomersRetrieve(id),
      search: async () => ({ data: [] }),
      create: async () => ({ id: "cus_x" }),
    };
    paymentIntents = {
      create: (args: unknown) => mockStripePaymentIntentsCreate(args),
    };
    checkout = { sessions: { create: async () => ({ id: "cs_x", url: "https://x" }) } };
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
    STRIPE_PRICE_EMAIL_PACK: "price_pack",
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

mock.module("./billing.js", {
  namedExports: {
    getOrCreateBillingAccount: async () => ({ id: "acct-1" }),
    getOrCreateBillingAccountByEmail: async () => ({ id: "acct-1" }),
  },
});

const { triggerAutoRecharge, setAutoRecharge } = await import("./stripe-auto-recharge.js");

// ---------------------------------------------------------------------------
// setAutoRecharge
// ---------------------------------------------------------------------------

describe("setAutoRecharge", () => {
  beforeEach(() => {
    mockPoolQuery = async () => ({ rows: [], rowCount: 1 });
  });

  it("enables auto-recharge with custom threshold", async () => {
    const updates: Array<{ sql: string; params: unknown[] }> = [];
    mockPoolQuery = async (sqlStr: string, params?: unknown[]) => {
      if (sqlStr.includes("UPDATE") && sqlStr.includes("billing_accounts")) {
        updates.push({ sql: sqlStr, params: params || [] });
      }
      return { rows: [], rowCount: 1 };
    };

    await setAutoRecharge("acct-1", true, 3000);
    assert.equal(updates.length, 1);
    const params = updates[0].params as unknown[];
    assert.ok(params.includes(true));
    assert.ok(params.includes(3000));
  });

  it("disables auto-recharge", async () => {
    const updates: Array<{ sql: string; params: unknown[] }> = [];
    mockPoolQuery = async (sqlStr: string, params?: unknown[]) => {
      if (sqlStr.includes("UPDATE") && sqlStr.includes("billing_accounts")) {
        updates.push({ sql: sqlStr, params: params || [] });
      }
      return { rows: [], rowCount: 1 };
    };

    await setAutoRecharge("acct-1", false);
    assert.equal(updates.length, 1);
    const params = updates[0].params as unknown[];
    assert.ok(params.includes(false));
  });
});

// ---------------------------------------------------------------------------
// triggerAutoRecharge
// ---------------------------------------------------------------------------

describe("triggerAutoRecharge", () => {
  beforeEach(() => {
    mockPoolQuery = async () => ({ rows: [], rowCount: 1 });
    mockPoolConnect = async () => makeFakeClient(async () => ({ rows: [], rowCount: 1 }));
    mockStripePaymentIntentsCreate = async () => ({
      id: "pi_success",
      status: "succeeded",
    });
    mockStripeCustomersRetrieve = async () => ({
      id: "cus_test",
      invoice_settings: { default_payment_method: "pm_test_abc" },
    });
  });

  it("charges Stripe off-session when payment method available", async () => {
    const piArgs: Array<Record<string, unknown>> = [];
    mockStripePaymentIntentsCreate = async (args: Record<string, unknown>) => {
      piArgs.push(args);
      return { id: "pi_ok", status: "succeeded" };
    };

    const handler = async (sqlStr: string) => {
      if (sqlStr.includes("SELECT") && sqlStr.includes("billing_accounts") && !sqlStr.includes("FOR UPDATE")) {
        return { rows: [{ id: "acct-1", stripe_customer_id: "cus_test", auto_recharge_failure_count: 0 }], rowCount: 1 };
      }
      // FOR UPDATE lock inside transaction
      if (sqlStr.includes("SELECT") && sqlStr.includes("FOR UPDATE")) {
        return { rows: [{ email_credits_remaining: 100, available_usd_micros: "0", held_usd_micros: "0" }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    };
    mockPoolQuery = handler;
    mockPoolConnect = async () => makeFakeClient(handler);

    const result = await triggerAutoRecharge("acct-1");
    assert.equal(result.success, true);
    assert.equal(piArgs.length, 1);
    assert.equal(piArgs[0].confirm, true);
    assert.equal(piArgs[0].off_session, true);
  });

  it("increments failure count on card decline", async () => {
    mockStripePaymentIntentsCreate = async () => {
      const err = new Error("Your card was declined") as Error & { code?: string };
      err.code = "card_declined";
      throw err;
    };
    mockPoolQuery = async (sqlStr: string) => {
      if (sqlStr.includes("SELECT") && sqlStr.includes("billing_accounts")) {
        return { rows: [{ id: "acct-1", stripe_customer_id: "cus_test", auto_recharge_failure_count: 0 }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    };

    const result = await triggerAutoRecharge("acct-1");
    assert.equal(result.success, false);
  });

  it("disables auto-recharge after 3 consecutive failures", async () => {
    mockStripePaymentIntentsCreate = async () => {
      const err = new Error("Card declined") as Error & { code?: string };
      err.code = "card_declined";
      throw err;
    };
    const updates: Array<{ sql: string; params: unknown[] }> = [];
    mockPoolQuery = async (sqlStr: string, params?: unknown[]) => {
      if (sqlStr.includes("SELECT") && sqlStr.includes("billing_accounts")) {
        return { rows: [{ id: "acct-1", stripe_customer_id: "cus_test", auto_recharge_failure_count: 2 }], rowCount: 1 };
      }
      if (sqlStr.includes("UPDATE") && sqlStr.includes("billing_accounts")) {
        updates.push({ sql: sqlStr, params: params || [] });
      }
      return { rows: [], rowCount: 1 };
    };

    await triggerAutoRecharge("acct-1");
    // Should UPDATE auto_recharge_enabled = false
    const disabledUpdate = updates.find(u => u.sql.includes("auto_recharge_enabled"));
    assert.ok(disabledUpdate, "should disable auto_recharge_enabled");
    const params = disabledUpdate!.params as unknown[];
    assert.ok(params.includes(false), "should set auto_recharge_enabled = false");
  });

  it("returns failure if no saved payment method", async () => {
    mockPoolQuery = async (sqlStr: string) => {
      if (sqlStr.includes("SELECT") && sqlStr.includes("billing_accounts")) {
        return { rows: [{ id: "acct-1", stripe_customer_id: null, auto_recharge_failure_count: 0 }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    };

    const result = await triggerAutoRecharge("acct-1");
    assert.equal(result.success, false);
  });
});
