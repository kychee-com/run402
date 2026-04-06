import { describe, it, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mockPoolQuery: (...args: any[]) => Promise<any>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mockPoolConnect: () => Promise<any>;
let mockGetVerifiedSenderDomain: (projectId: string) => Promise<string | null>;

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

mock.module("./email-domains.js", {
  namedExports: {
    getVerifiedSenderDomain: (projectId: string) => mockGetVerifiedSenderDomain(projectId),
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

const { tryConsumePackCredit } = await import("./billing-email-overage.js");

// ---------------------------------------------------------------------------
// tryConsumePackCredit
// ---------------------------------------------------------------------------

describe("tryConsumePackCredit", () => {
  beforeEach(() => {
    mockPoolQuery = async () => ({ rows: [], rowCount: 0 });
    mockPoolConnect = async () => makeFakeClient(async () => ({ rows: [], rowCount: 0 }));
    mockGetVerifiedSenderDomain = async () => null;
  });

  it("rejects when project has no verified custom domain", async () => {
    mockGetVerifiedSenderDomain = async () => null;

    const result = await tryConsumePackCredit("prj_test");
    assert.equal(result.allowed, false);
    assert.equal(result.reason, "no_custom_domain");
  });

  it("rejects when project has no billing account (no wallet)", async () => {
    mockGetVerifiedSenderDomain = async () => "kysigned.com";
    mockPoolQuery = async (sqlStr: string) => {
      // Project lookup: wallet is null
      if (sqlStr.includes("SELECT") && sqlStr.includes("projects") && sqlStr.includes("wallet_address")) {
        return { rows: [{ wallet_address: null }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    };

    const result = await tryConsumePackCredit("prj_no_wallet");
    assert.equal(result.allowed, false);
    assert.equal(result.reason, "no_billing_account");
  });

  it("rejects when billing account has zero pack credits", async () => {
    mockGetVerifiedSenderDomain = async () => "kysigned.com";
    mockPoolQuery = async (sqlStr: string) => {
      if (sqlStr.includes("SELECT") && sqlStr.includes("projects") && sqlStr.includes("wallet_address")) {
        return { rows: [{ wallet_address: "0xabc" }], rowCount: 1 };
      }
      if (sqlStr.includes("SELECT") && sqlStr.includes("billing_account_wallets")) {
        return {
          rows: [{ billing_account_id: "acct-1", email_credits_remaining: 0 }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    };
    mockPoolConnect = async () => makeFakeClient(async () => ({ rows: [{ email_credits_remaining: 0 }], rowCount: 1 }));

    const result = await tryConsumePackCredit("prj_zero_credits");
    assert.equal(result.allowed, false);
    assert.equal(result.reason, "no_credits");
  });

  it("successfully decrements credits when all conditions met", async () => {
    mockGetVerifiedSenderDomain = async () => "kysigned.com";
    const updates: Array<{ sql: string; params: unknown[] }> = [];
    const handler = async (sqlStr: string, params?: unknown[]) => {
      if (sqlStr.includes("SELECT") && sqlStr.includes("projects") && sqlStr.includes("wallet_address")) {
        return { rows: [{ wallet_address: "0xabc" }], rowCount: 1 };
      }
      if (sqlStr.includes("SELECT") && sqlStr.includes("billing_account_wallets")) {
        return {
          rows: [{ billing_account_id: "acct-1", email_credits_remaining: 100 }],
          rowCount: 1,
        };
      }
      if (sqlStr.includes("SELECT") && sqlStr.includes("FOR UPDATE")) {
        return { rows: [{ email_credits_remaining: 100 }], rowCount: 1 };
      }
      if (sqlStr.includes("UPDATE") && sqlStr.includes("email_credits_remaining")) {
        updates.push({ sql: sqlStr, params: params || [] });
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    };
    mockPoolQuery = handler;
    mockPoolConnect = async () => makeFakeClient(handler);

    const result = await tryConsumePackCredit("prj_good");
    assert.equal(result.allowed, true);
    if (result.allowed) {
      assert.equal(result.remaining, 99);
    }
    assert.ok(updates.length >= 1, "should UPDATE email_credits_remaining");
  });

  it("handles concurrent decrement — FOR UPDATE race protection", async () => {
    mockGetVerifiedSenderDomain = async () => "kysigned.com";
    let forUpdateCalls = 0;
    const handler = async (sqlStr: string) => {
      if (sqlStr.includes("SELECT") && sqlStr.includes("projects")) {
        return { rows: [{ wallet_address: "0xabc" }], rowCount: 1 };
      }
      if (sqlStr.includes("SELECT") && sqlStr.includes("billing_account_wallets")) {
        return {
          rows: [{ billing_account_id: "acct-1", email_credits_remaining: 1 }],
          rowCount: 1,
        };
      }
      if (sqlStr.includes("SELECT") && sqlStr.includes("FOR UPDATE")) {
        forUpdateCalls++;
        // Second concurrent caller sees 0 credits (first already consumed the last one)
        return { rows: [{ email_credits_remaining: forUpdateCalls === 1 ? 1 : 0 }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    };
    mockPoolQuery = handler;
    mockPoolConnect = async () => makeFakeClient(handler);

    const result1 = await tryConsumePackCredit("prj_race");
    const result2 = await tryConsumePackCredit("prj_race");

    assert.equal(result1.allowed, true);
    assert.equal(result2.allowed, false);
  });
});
