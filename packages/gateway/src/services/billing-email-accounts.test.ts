import { describe, it, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";

// ---------------------------------------------------------------------------
// Mock dependencies before importing billing.js
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mockPoolQuery: (...args: any[]) => Promise<any>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mockPoolConnect: () => Promise<any>;

mock.module("../db/pool.js", {
  namedExports: {
    pool: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      query: (...args: any[]) => mockPoolQuery(...args),
      connect: () => mockPoolConnect(),
    },
  },
});

mock.module("../utils/async-handler.js", {
  namedExports: {
    HttpError: class HttpError extends Error {
      public statusCode: number;
      public body?: Record<string, unknown>;
      constructor(statusCode: number, message: string, body?: Record<string, unknown>) {
        super(message);
        this.statusCode = statusCode;
        this.name = "HttpError";
        this.body = body;
      }
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    asyncHandler: (fn: any) => fn,
  },
});

const {
  getOrCreateBillingAccountByEmail,
  getBillingAccountByEmail,
  linkWalletToEmailAccount,
} = await import("./billing.js");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NOW = "2026-04-06T00:00:00.000Z";

function makeAccountRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "acct-1",
    status: "active",
    currency: "USD",
    available_usd_micros: "0",
    held_usd_micros: "0",
    funding_policy: "allowance_then_wallet",
    low_balance_threshold_usd_micros: "1000000",
    primary_contact_email: null,
    tier: null,
    lease_started_at: null,
    lease_expires_at: null,
    email_credits_remaining: 0,
    auto_recharge_enabled: false,
    auto_recharge_threshold: 2000,
    auto_recharge_failure_count: 0,
    stripe_customer_id: null,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeFakeClient(queryHandler: (...args: any[]) => Promise<any>) {
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    query: (...args: any[]) => queryHandler(...args),
    release: () => {},
  };
}

// ---------------------------------------------------------------------------
// getBillingAccountByEmail
// ---------------------------------------------------------------------------

describe("getBillingAccountByEmail", () => {
  beforeEach(() => {
    mockPoolQuery = async () => ({ rows: [] });
    mockPoolConnect = async () => makeFakeClient(async () => ({ rows: [] }));
  });

  it("returns account when email found", async () => {
    mockPoolQuery = async () => ({ rows: [makeAccountRow()] });
    const account = await getBillingAccountByEmail("user@example.com");
    assert.ok(account);
    assert.equal(account.id, "acct-1");
    assert.equal(account.email_credits_remaining, 0);
  });

  it("returns null when email not found", async () => {
    mockPoolQuery = async () => ({ rows: [] });
    const account = await getBillingAccountByEmail("missing@example.com");
    assert.equal(account, null);
  });

  it("normalizes email to lowercase before lookup", async () => {
    const queries: string[] = [];
    const params: unknown[][] = [];
    mockPoolQuery = async (_sql: string, p: unknown[]) => {
      params.push(p);
      return { rows: [] };
    };
    await getBillingAccountByEmail("USER@EXAMPLE.COM");
    assert.equal(params[0]?.[0], "user@example.com");
  });
});

// ---------------------------------------------------------------------------
// getOrCreateBillingAccountByEmail
// ---------------------------------------------------------------------------

describe("getOrCreateBillingAccountByEmail", () => {
  beforeEach(() => {
    mockPoolConnect = async () => makeFakeClient(async () => ({ rows: [] }));
  });

  it("returns existing account when email already has one", async () => {
    const existingRow = makeAccountRow({ id: "acct-existing" });
    mockPoolQuery = async () => ({ rows: [existingRow] });
    mockPoolConnect = async () => makeFakeClient(async () => ({ rows: [] }));

    const account = await getOrCreateBillingAccountByEmail("user@example.com");
    assert.equal(account.id, "acct-existing");
  });

  it("creates new account when email not found", async () => {
    // Initial query: no existing account
    mockPoolQuery = async (sqlStr: string) => {
      if (sqlStr.includes("SELECT") && sqlStr.includes("billing_account_emails")) {
        return { rows: [] };
      }
      // After creation, SELECT by ID
      if (sqlStr.includes("billing_accounts WHERE id")) {
        return { rows: [makeAccountRow({ id: "acct-new" })] };
      }
      return { rows: [] };
    };

    const queries: string[] = [];
    mockPoolConnect = async () => makeFakeClient(async (sqlStr: string) => {
      queries.push(sqlStr);
      // Double-check SELECT inside transaction
      if (sqlStr.includes("SELECT") && sqlStr.includes("billing_account_emails")) {
        return { rows: [] };
      }
      return { rows: [] };
    });

    const account = await getOrCreateBillingAccountByEmail("new@example.com");
    assert.equal(account.id, "acct-new");
    // Verify BEGIN, INSERT billing_accounts, INSERT billing_account_emails, COMMIT
    const hasInsertAccount = queries.some(q => q.includes("INSERT INTO internal.billing_accounts"));
    const hasInsertEmail = queries.some(q => q.includes("INSERT INTO internal.billing_account_emails"));
    assert.ok(hasInsertAccount, "should INSERT billing_accounts");
    assert.ok(hasInsertEmail, "should INSERT billing_account_emails");
  });

  it("is idempotent — double-check inside transaction returns existing account", async () => {
    const existingRow = makeAccountRow({ id: "acct-race" });
    // First SELECT: not found
    // Transaction double-check: found (race condition)
    mockPoolQuery = async () => ({ rows: [] });
    mockPoolConnect = async () => makeFakeClient(async (sqlStr: string) => {
      if (sqlStr.includes("SELECT") && sqlStr.includes("billing_account_emails")) {
        return { rows: [existingRow] };
      }
      return { rows: [] };
    });

    const account = await getOrCreateBillingAccountByEmail("race@example.com");
    assert.equal(account.id, "acct-race");
  });

  it("rolls back on insert failure", async () => {
    mockPoolQuery = async () => ({ rows: [] });
    let rollbackCalled = false;
    mockPoolConnect = async () => makeFakeClient(async (sqlStr: string) => {
      if (sqlStr === "ROLLBACK") { rollbackCalled = true; return { rows: [] }; }
      if (sqlStr.includes("INSERT INTO internal.billing_accounts")) {
        throw new Error("insert failed");
      }
      if (sqlStr.includes("SELECT") && sqlStr.includes("billing_account_emails")) {
        return { rows: [] };
      }
      return { rows: [] };
    });

    await assert.rejects(
      async () => await getOrCreateBillingAccountByEmail("fail@example.com"),
      /insert failed/,
    );
    assert.ok(rollbackCalled, "should rollback transaction");
  });
});

// ---------------------------------------------------------------------------
// linkWalletToEmailAccount
// ---------------------------------------------------------------------------

describe("linkWalletToEmailAccount", () => {
  beforeEach(() => {
    mockPoolQuery = async () => ({ rows: [] });
    mockPoolConnect = async () => makeFakeClient(async () => ({ rows: [] }));
  });

  it("links wallet to existing email account", async () => {
    const queries: string[] = [];
    mockPoolQuery = async (sqlStr: string) => {
      queries.push(sqlStr);
      // Wallet not yet linked
      if (sqlStr.includes("SELECT") && sqlStr.includes("billing_account_wallets")) {
        return { rows: [] };
      }
      // Account exists
      if (sqlStr.includes("SELECT") && sqlStr.includes("billing_accounts") && sqlStr.includes("WHERE id")) {
        return { rows: [makeAccountRow({ id: "acct-1" })] };
      }
      return { rows: [], rowCount: 1 };
    };

    await linkWalletToEmailAccount("acct-1", "0x1234567890abcdef1234567890abcdef12345678");
    const hasInsert = queries.some(q => q.includes("INSERT INTO internal.billing_account_wallets"));
    assert.ok(hasInsert, "should INSERT into billing_account_wallets");
  });

  it("throws 409 when wallet already linked to another account", async () => {
    mockPoolQuery = async (sqlStr: string) => {
      // Wallet is already linked
      if (sqlStr.includes("SELECT") && sqlStr.includes("billing_account_wallets")) {
        return { rows: [{ wallet_address: "0xabc", billing_account_id: "acct-other" }] };
      }
      return { rows: [] };
    };

    await assert.rejects(
      async () => await linkWalletToEmailAccount("acct-1", "0x1234567890abcdef1234567890abcdef12345678"),
      (err: unknown) => (err as { statusCode?: number }).statusCode === 409,
    );
  });

  it("throws 404 when target email account does not exist", async () => {
    mockPoolQuery = async (sqlStr: string) => {
      // Wallet not linked
      if (sqlStr.includes("SELECT") && sqlStr.includes("billing_account_wallets")) {
        return { rows: [] };
      }
      // Account does not exist
      if (sqlStr.includes("SELECT") && sqlStr.includes("billing_accounts") && sqlStr.includes("WHERE id")) {
        return { rows: [] };
      }
      return { rows: [] };
    };

    await assert.rejects(
      async () => await linkWalletToEmailAccount("acct-missing", "0x1234567890abcdef1234567890abcdef12345678"),
      (err: unknown) => (err as { statusCode?: number }).statusCode === 404,
    );
  });
});
