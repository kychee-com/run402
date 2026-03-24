import { describe, it, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";

// ---------------------------------------------------------------------------
// Mock dependencies before importing the module under test
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
  getBillingAccount,
  getOrCreateBillingAccount,
  adminCredit,
  adminDebit,
  debitAllowance,
  getLedgerHistory,
  creditFromTopup,
} = await import("./billing.js");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NOW = "2026-01-15T00:00:00.000Z";

function makeAccountRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "acct-1",
    status: "active",
    currency: "USD",
    available_usd_micros: "5000000",
    held_usd_micros: "0",
    funding_policy: "allowance_then_wallet",
    low_balance_threshold_usd_micros: "1000000",
    primary_contact_email: null,
    tier: null,
    lease_started_at: null,
    lease_expires_at: null,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

function makeLedgerRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "ledger-1",
    billing_account_id: "acct-1",
    direction: "credit",
    kind: "admin_credit",
    amount_usd_micros: "1000000",
    balance_after_available: "6000000",
    balance_after_held: "0",
    reference_type: "admin",
    reference_id: "test-reason",
    idempotency_key: "idem-1",
    metadata: { reason: "test-reason" },
    created_at: NOW,
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
// getBillingAccount
// ---------------------------------------------------------------------------

describe("getBillingAccount", () => {
  beforeEach(() => {
    mockPoolQuery = async () => ({ rows: [] });
    mockPoolConnect = async () => makeFakeClient(async () => ({ rows: [] }));
  });

  it("returns account when found", async () => {
    const row = makeAccountRow();
    mockPoolQuery = async () => ({ rows: [row] });

    const account = await getBillingAccount("0xABC123");
    assert.ok(account);
    assert.equal(account.id, "acct-1");
    assert.equal(account.status, "active");
    assert.equal(account.available_usd_micros, 5000000);
    assert.equal(account.held_usd_micros, 0);
    assert.equal(account.currency, "USD");
    assert.equal(account.funding_policy, "allowance_then_wallet");
    assert.equal(account.low_balance_threshold_usd_micros, 1000000);
    assert.ok(account.created_at instanceof Date);
    assert.ok(account.updated_at instanceof Date);
  });

  it("returns null when not found", async () => {
    mockPoolQuery = async () => ({ rows: [] });

    const account = await getBillingAccount("0xNONEXISTENT");
    assert.equal(account, null);
  });

  it("normalizes wallet to lowercase", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let capturedParams: any[];
    mockPoolQuery = async (_sql: unknown, params: unknown[]) => {
      capturedParams = params;
      return { rows: [] };
    };

    await getBillingAccount("0xABCDEF");
    assert.equal(capturedParams![0], "0xabcdef");
  });

  it("maps row fields correctly including optional fields", async () => {
    const row = makeAccountRow({
      primary_contact_email: "test@example.com",
      tier: "pro",
      lease_started_at: "2026-01-01T00:00:00.000Z",
      lease_expires_at: "2026-02-01T00:00:00.000Z",
    });
    mockPoolQuery = async () => ({ rows: [row] });

    const account = await getBillingAccount("0xABC");
    assert.equal(account!.primary_contact_email, "test@example.com");
    assert.equal(account!.tier, "pro");
    assert.ok(account!.lease_started_at instanceof Date);
    assert.ok(account!.lease_expires_at instanceof Date);
  });
});

// ---------------------------------------------------------------------------
// getOrCreateBillingAccount
// ---------------------------------------------------------------------------

describe("getOrCreateBillingAccount", () => {
  beforeEach(() => {
    mockPoolQuery = async () => ({ rows: [] });
    mockPoolConnect = async () => makeFakeClient(async () => ({ rows: [] }));
  });

  it("returns existing account without creating", async () => {
    const row = makeAccountRow();
    mockPoolQuery = async () => ({ rows: [row] });

    const account = await getOrCreateBillingAccount("0xABC");
    assert.equal(account.id, "acct-1");
    assert.equal(account.available_usd_micros, 5000000);
  });

  it("creates new account when not found (double-check misses too)", async () => {
    const row = makeAccountRow({ id: "new-acct" });
    let poolQueryCount = 0;
    mockPoolQuery = async () => {
      poolQueryCount++;
      // 1st call: initial lookup (not found)
      if (poolQueryCount === 1) return { rows: [] };
      // 2nd call: final SELECT after COMMIT
      return { rows: [row] };
    };

    let clientQueryCount = 0;
    const fakeClient = makeFakeClient(async () => {
      clientQueryCount++;
      // 1: BEGIN
      // 2: double-check SELECT (not found)
      if (clientQueryCount === 2) return { rows: [] };
      // 3: INSERT billing_accounts
      // 4: INSERT billing_account_wallets
      // 5: COMMIT
      return { rows: [] };
    });
    mockPoolConnect = async () => fakeClient;

    const account = await getOrCreateBillingAccount("0xNEW");
    assert.equal(account.id, "new-acct");
    assert.ok(clientQueryCount >= 5, "Should have run BEGIN, recheck, 2 inserts, COMMIT");
  });

  it("returns account from double-check inside transaction", async () => {
    const row = makeAccountRow({ id: "race-acct" });
    let poolQueryCount = 0;
    mockPoolQuery = async () => {
      poolQueryCount++;
      // 1st: initial lookup (not found)
      if (poolQueryCount === 1) return { rows: [] };
      return { rows: [] };
    };

    let clientQueryCount = 0;
    const fakeClient = makeFakeClient(async () => {
      clientQueryCount++;
      // 1: BEGIN
      // 2: double-check SELECT (found this time — race condition)
      if (clientQueryCount === 2) return { rows: [row] };
      // 3: COMMIT
      return { rows: [] };
    });
    mockPoolConnect = async () => fakeClient;

    const account = await getOrCreateBillingAccount("0xRACE");
    assert.equal(account.id, "race-acct");
  });

  it("rolls back and rethrows on error", async () => {
    mockPoolQuery = async () => ({ rows: [] }); // initial lookup: not found

    const queries: string[] = [];
    const fakeClient = makeFakeClient(async (q: string) => {
      queries.push(typeof q === "string" ? q : "tagged");
      if (queries.length === 2) return { rows: [] }; // double-check: not found
      if (queries.length === 3) throw new Error("insert failed");
      return { rows: [] };
    });
    mockPoolConnect = async () => fakeClient;

    await assert.rejects(() => getOrCreateBillingAccount("0xFAIL"), {
      message: "insert failed",
    });
  });
});

// ---------------------------------------------------------------------------
// adminCredit
// ---------------------------------------------------------------------------

describe("adminCredit", () => {
  beforeEach(() => {
    mockPoolQuery = async () => ({ rows: [] });
    mockPoolConnect = async () => makeFakeClient(async () => ({ rows: [] }));
  });

  it("returns existing entry on idempotency hit", async () => {
    const accountRow = makeAccountRow();
    const ledgerRow = makeLedgerRow();

    // pool.query calls: getOrCreateBillingAccount lookup, getBillingAccount post-commit
    let poolQueryCount = 0;
    mockPoolQuery = async () => {
      poolQueryCount++;
      return { rows: [accountRow] };
    };

    let clientQueryCount = 0;
    const fakeClient = makeFakeClient(async () => {
      clientQueryCount++;
      // 1: BEGIN
      // 2: idempotency check — found
      if (clientQueryCount === 2) return { rows: [{ id: "dup-ledger" }] };
      // 3: SELECT full ledger entry
      if (clientQueryCount === 3) return { rows: [ledgerRow] };
      // 4: COMMIT
      return { rows: [] };
    });
    mockPoolConnect = async () => fakeClient;

    const result = await adminCredit("0xABC", 1000000, "test", "existing-key");
    assert.equal(result.ledger_entry.id, "ledger-1");
    assert.equal(result.account.id, "acct-1");
  });

  it("credits account successfully", async () => {
    const accountRow = makeAccountRow({ available_usd_micros: "5000000" });
    const updatedAccountRow = makeAccountRow({ available_usd_micros: "6000000" });
    const ledgerRow = makeLedgerRow({ balance_after_available: "6000000" });

    let poolQueryCount = 0;
    mockPoolQuery = async () => {
      poolQueryCount++;
      // 1: getOrCreateBillingAccount initial lookup
      if (poolQueryCount === 1) return { rows: [accountRow] };
      // 2: getBillingAccount post-commit
      if (poolQueryCount === 2) return { rows: [updatedAccountRow] };
      // 3: SELECT ledger entry by id
      return { rows: [ledgerRow] };
    };

    let clientQueryCount = 0;
    const fakeClient = makeFakeClient(async () => {
      clientQueryCount++;
      // 1: BEGIN
      // 2: idempotency check (not found)
      if (clientQueryCount === 2) return { rows: [] };
      // 3: lock account
      if (clientQueryCount === 3) return { rows: [accountRow] };
      // 4: UPDATE balance
      // 5: INSERT ledger
      // 6: COMMIT
      return { rows: [] };
    });
    mockPoolConnect = async () => fakeClient;

    const result = await adminCredit("0xABC", 1000000, "bonus credit", "credit-key-1");
    assert.equal(result.account.available_usd_micros, 6000000);
    assert.equal(result.ledger_entry.direction, "credit");
    assert.equal(result.ledger_entry.kind, "admin_credit");
    assert.equal(result.ledger_entry.balance_after_available, 6000000);
  });

  it("rolls back on error", async () => {
    const accountRow = makeAccountRow();
    mockPoolQuery = async () => ({ rows: [accountRow] });

    const queries: string[] = [];
    let clientQueryCount = 0;
    const fakeClient = makeFakeClient(async (q: string) => {
      clientQueryCount++;
      queries.push(typeof q === "string" ? q : "tagged");
      // 1: BEGIN
      // 2: idempotency check (not found)
      if (clientQueryCount === 2) return { rows: [] };
      // 3: lock account — fail
      if (clientQueryCount === 3) throw new Error("lock failed");
      return { rows: [] };
    });
    mockPoolConnect = async () => fakeClient;

    await assert.rejects(() => adminCredit("0xABC", 1000000, "test"), {
      message: "lock failed",
    });
  });
});

// ---------------------------------------------------------------------------
// adminDebit
// ---------------------------------------------------------------------------

describe("adminDebit", () => {
  beforeEach(() => {
    mockPoolQuery = async () => ({ rows: [] });
    mockPoolConnect = async () => makeFakeClient(async () => ({ rows: [] }));
  });

  it("returns existing entry on idempotency hit", async () => {
    const accountRow = makeAccountRow();
    const ledgerRow = makeLedgerRow({ direction: "debit", kind: "admin_debit" });

    mockPoolQuery = async () => ({ rows: [accountRow] });

    let clientQueryCount = 0;
    const fakeClient = makeFakeClient(async () => {
      clientQueryCount++;
      if (clientQueryCount === 2) return { rows: [{ id: "dup-ledger" }] };
      if (clientQueryCount === 3) return { rows: [ledgerRow] };
      return { rows: [] };
    });
    mockPoolConnect = async () => fakeClient;

    const result = await adminDebit("0xABC", 1000000, "fee", "existing-debit-key");
    assert.equal(result.ledger_entry.id, "ledger-1");
  });

  it("throws HttpError 402 on insufficient funds", async () => {
    const accountRow = makeAccountRow({ available_usd_micros: "500000" }); // 0.50 USD

    mockPoolQuery = async () => ({ rows: [accountRow] });

    let clientQueryCount = 0;
    const fakeClient = makeFakeClient(async () => {
      clientQueryCount++;
      // 1: BEGIN
      // 2: idempotency check (not found)
      if (clientQueryCount === 2) return { rows: [] };
      // 3: lock account (low balance)
      if (clientQueryCount === 3) return { rows: [accountRow] };
      return { rows: [] };
    });
    mockPoolConnect = async () => fakeClient;

    try {
      await adminDebit("0xABC", 1000000, "too expensive");
      assert.fail("Should have thrown");
    } catch (err) {
      assert.equal((err as { statusCode: number }).statusCode, 402);
      assert.ok((err as Error).message.includes("Insufficient balance"));
    }
  });

  it("debits account successfully", async () => {
    const accountRow = makeAccountRow({ available_usd_micros: "5000000" });
    const updatedAccountRow = makeAccountRow({ available_usd_micros: "4000000" });
    const ledgerRow = makeLedgerRow({
      direction: "debit",
      kind: "admin_debit",
      amount_usd_micros: "1000000",
      balance_after_available: "4000000",
    });

    let poolQueryCount = 0;
    mockPoolQuery = async () => {
      poolQueryCount++;
      if (poolQueryCount === 1) return { rows: [accountRow] };
      if (poolQueryCount === 2) return { rows: [updatedAccountRow] };
      return { rows: [ledgerRow] };
    };

    let clientQueryCount = 0;
    const fakeClient = makeFakeClient(async () => {
      clientQueryCount++;
      if (clientQueryCount === 2) return { rows: [] }; // idempotency: not found
      if (clientQueryCount === 3) return { rows: [accountRow] }; // lock
      return { rows: [] };
    });
    mockPoolConnect = async () => fakeClient;

    const result = await adminDebit("0xABC", 1000000, "platform fee", "debit-key-1");
    assert.equal(result.account.available_usd_micros, 4000000);
    assert.equal(result.ledger_entry.direction, "debit");
    assert.equal(result.ledger_entry.kind, "admin_debit");
  });

  it("rolls back on error", async () => {
    const accountRow = makeAccountRow();
    mockPoolQuery = async () => ({ rows: [accountRow] });

    let clientQueryCount = 0;
    const fakeClient = makeFakeClient(async () => {
      clientQueryCount++;
      if (clientQueryCount === 2) return { rows: [] };
      if (clientQueryCount === 3) throw new Error("db error");
      return { rows: [] };
    });
    mockPoolConnect = async () => fakeClient;

    await assert.rejects(() => adminDebit("0xABC", 1000000, "test"), {
      message: "db error",
    });
  });
});

// ---------------------------------------------------------------------------
// debitAllowance
// ---------------------------------------------------------------------------

describe("debitAllowance", () => {
  beforeEach(() => {
    mockPoolQuery = async () => ({ rows: [] });
    mockPoolConnect = async () => makeFakeClient(async () => ({ rows: [] }));
  });

  it("returns null when no account found", async () => {
    let clientQueryCount = 0;
    const fakeClient = makeFakeClient(async () => {
      clientQueryCount++;
      // 1: BEGIN
      // 2: SELECT account via wallet (not found)
      if (clientQueryCount === 2) return { rows: [] };
      // 3: ROLLBACK
      return { rows: [] };
    });
    mockPoolConnect = async () => fakeClient;

    const result = await debitAllowance("0xABC", 1000000, "sku-1", null);
    assert.equal(result, null);
  });

  it("returns null when insufficient funds", async () => {
    const accountRow = makeAccountRow({ available_usd_micros: "500000" }); // 0.50 USD

    let clientQueryCount = 0;
    const fakeClient = makeFakeClient(async () => {
      clientQueryCount++;
      if (clientQueryCount === 2) return { rows: [accountRow] }; // account found but low balance
      return { rows: [] };
    });
    mockPoolConnect = async () => fakeClient;

    const result = await debitAllowance("0xABC", 1000000, "sku-1", null);
    assert.equal(result, null);
  });

  it("debits allowance and returns remaining balance with charge id", async () => {
    const accountRow = makeAccountRow({ available_usd_micros: "5000000", held_usd_micros: "0" });

    let clientQueryCount = 0;
    const fakeClient = makeFakeClient(async () => {
      clientQueryCount++;
      // 1: BEGIN
      // 2: SELECT account (found with sufficient balance)
      if (clientQueryCount === 2) return { rows: [accountRow] };
      // 3: UPDATE balance
      // 4: INSERT ledger
      // 5: INSERT charge_authorization
      // 6: COMMIT
      return { rows: [] };
    });
    mockPoolConnect = async () => fakeClient;

    const result = await debitAllowance("0xABC", 1000000, "project-provision", "hash-abc");
    assert.ok(result);
    assert.equal(result.remaining, 4000000);
    assert.ok(typeof result.chargeId === "string");
    assert.ok(result.chargeId.length > 0);
  });

  it("normalizes wallet to lowercase", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let capturedParams: any[] = [];
    let clientQueryCount = 0;
    const fakeClient = makeFakeClient(async (_q: unknown, params?: unknown[]) => {
      clientQueryCount++;
      if (clientQueryCount === 2) {
        capturedParams = params as unknown[];
        return { rows: [] }; // no account
      }
      return { rows: [] };
    });
    mockPoolConnect = async () => fakeClient;

    await debitAllowance("0xABCDEF", 100, "sku", null);
    assert.equal(capturedParams[0], "0xabcdef");
  });

  it("rolls back and rethrows on error", async () => {
    const accountRow = makeAccountRow({ available_usd_micros: "5000000" });

    let clientQueryCount = 0;
    const fakeClient = makeFakeClient(async () => {
      clientQueryCount++;
      if (clientQueryCount === 2) return { rows: [accountRow] };
      if (clientQueryCount === 3) throw new Error("update failed");
      return { rows: [] };
    });
    mockPoolConnect = async () => fakeClient;

    await assert.rejects(() => debitAllowance("0xABC", 1000000, "sku-1", null), {
      message: "update failed",
    });
  });
});

// ---------------------------------------------------------------------------
// getLedgerHistory
// ---------------------------------------------------------------------------

describe("getLedgerHistory", () => {
  beforeEach(() => {
    mockPoolQuery = async () => ({ rows: [] });
  });

  it("returns mapped ledger entries", async () => {
    const rows = [
      makeLedgerRow({ id: "l1", direction: "credit", kind: "admin_credit" }),
      makeLedgerRow({ id: "l2", direction: "debit", kind: "purchase_debit" }),
    ];
    mockPoolQuery = async () => ({ rows });

    const entries = await getLedgerHistory("0xABC");
    assert.equal(entries.length, 2);
    assert.equal(entries[0].id, "l1");
    assert.equal(entries[0].direction, "credit");
    assert.equal(entries[1].id, "l2");
    assert.equal(entries[1].direction, "debit");
    assert.equal(entries[0].amount_usd_micros, 1000000);
    assert.ok(entries[0].created_at instanceof Date);
  });

  it("returns empty array when no entries", async () => {
    mockPoolQuery = async () => ({ rows: [] });

    const entries = await getLedgerHistory("0xABC");
    assert.deepEqual(entries, []);
  });

  it("normalizes wallet and passes limit", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let capturedParams: any[];
    mockPoolQuery = async (_sql: unknown, params: unknown[]) => {
      capturedParams = params;
      return { rows: [] };
    };

    await getLedgerHistory("0xABCDEF", 10);
    assert.equal(capturedParams![0], "0xabcdef");
    assert.equal(capturedParams![1], 10);
  });

  it("uses default limit of 50", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let capturedParams: any[];
    mockPoolQuery = async (_sql: unknown, params: unknown[]) => {
      capturedParams = params;
      return { rows: [] };
    };

    await getLedgerHistory("0xABC");
    assert.equal(capturedParams![1], 50);
  });
});

// ---------------------------------------------------------------------------
// creditFromTopup
// ---------------------------------------------------------------------------

describe("creditFromTopup", () => {
  beforeEach(() => {
    mockPoolQuery = async () => ({ rows: [] });
    mockPoolConnect = async () => makeFakeClient(async () => ({ rows: [] }));
  });

  it("returns existing account on idempotency hit", async () => {
    const accountRow = makeAccountRow({ available_usd_micros: "10000000" });

    let poolQueryCount = 0;
    mockPoolQuery = async () => {
      poolQueryCount++;
      // post-commit: SELECT billing_accounts
      return { rows: [accountRow] };
    };

    let clientQueryCount = 0;
    const fakeClient = makeFakeClient(async () => {
      clientQueryCount++;
      // 1: BEGIN
      // 2: idempotency check (found)
      if (clientQueryCount === 2) return { rows: [{ id: "existing-ledger" }] };
      // 3: SELECT topup for billing_account_id
      if (clientQueryCount === 3) return { rows: [{ billing_account_id: "acct-1" }] };
      // 4: COMMIT
      return { rows: [] };
    });
    mockPoolConnect = async () => fakeClient;

    const account = await creditFromTopup("topup-1", "evt-1");
    assert.equal(account.id, "acct-1");
    assert.equal(account.available_usd_micros, 10000000);
  });

  it("throws when topup not found", async () => {
    let clientQueryCount = 0;
    const fakeClient = makeFakeClient(async () => {
      clientQueryCount++;
      // 1: BEGIN
      // 2: idempotency check (not found)
      if (clientQueryCount === 2) return { rows: [] };
      // 3: SELECT topup (not found)
      if (clientQueryCount === 3) return { rows: [] };
      // 4: ROLLBACK
      return { rows: [] };
    });
    mockPoolConnect = async () => fakeClient;

    await assert.rejects(() => creditFromTopup("bad-topup", "evt-2"), {
      message: "Topup not found: bad-topup",
    });
  });

  it("credits from topup successfully", async () => {
    const topupRow = {
      id: "topup-1",
      billing_account_id: "acct-1",
      funded_usd_micros: "2000000",
      status: "pending",
    };
    const lockedRow = makeAccountRow({ available_usd_micros: "5000000", held_usd_micros: "0" });
    const finalRow = makeAccountRow({ available_usd_micros: "7000000" });

    mockPoolQuery = async () => ({ rows: [finalRow] });

    let clientQueryCount = 0;
    const fakeClient = makeFakeClient(async () => {
      clientQueryCount++;
      // 1: BEGIN
      // 2: idempotency check (not found)
      if (clientQueryCount === 2) return { rows: [] };
      // 3: SELECT topup
      if (clientQueryCount === 3) return { rows: [topupRow] };
      // 4: lock account
      if (clientQueryCount === 4) return { rows: [lockedRow] };
      // 5: UPDATE balance
      // 6: INSERT ledger
      // 7: UPDATE topup status
      // 8: COMMIT
      return { rows: [] };
    });
    mockPoolConnect = async () => fakeClient;

    const account = await creditFromTopup("topup-1", "evt-3");
    assert.equal(account.id, "acct-1");
    assert.equal(account.available_usd_micros, 7000000);
    assert.ok(clientQueryCount >= 8, "Should have run all transaction queries");
  });

  it("rolls back and rethrows on error", async () => {
    let clientQueryCount = 0;
    const fakeClient = makeFakeClient(async () => {
      clientQueryCount++;
      if (clientQueryCount === 2) return { rows: [] }; // idempotency: not found
      if (clientQueryCount === 3) throw new Error("topup query failed");
      return { rows: [] };
    });
    mockPoolConnect = async () => fakeClient;

    await assert.rejects(() => creditFromTopup("topup-1", "evt-4"), {
      message: "topup query failed",
    });
  });
});
