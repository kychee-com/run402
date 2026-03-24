import { describe, it, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import { TIERS, getTierLimits } from "@run402/shared";
import type { TierName } from "@run402/shared";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mockPoolQuery: (...args: any[]) => Promise<any>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mockPoolConnect: () => Promise<any>;

mock.module("../db/pool.js", {
  namedExports: {
    pool: {
      query: (...args: any[]) => mockPoolQuery(...args),
      connect: () => mockPoolConnect(),
    },
  },
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mockGetOrCreateBillingAccount: (...args: any[]) => Promise<any>;

mock.module("./billing.js", {
  namedExports: {
    getOrCreateBillingAccount: (...args: any[]) => mockGetOrCreateBillingAccount(...args),
  },
});

let CapturedHttpError: any;

mock.module("../utils/async-handler.js", {
  namedExports: {
    HttpError: class HttpError extends Error {
      public statusCode: number;
      public body?: Record<string, unknown>;
      constructor(statusCode: number, message: string, body?: Record<string, unknown>) {
        super(message);
        this.name = "HttpError";
        this.statusCode = statusCode;
        this.body = body;
      }
    },
  },
});

// Import AFTER mocks
const {
  isWalletTierActive,
  calculateUpgradePrice,
  getWalletTier,
  getWalletPoolUsage,
  subscribeTier,
  renewTier,
  upgradeTier,
  setTier,
} = await import("./wallet-tiers.js");

// Grab the mocked HttpError so we can instanceof-check
const { HttpError } = await import("../utils/async-handler.js");
CapturedHttpError = HttpError;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeBillingAccount(overrides: Record<string, unknown> = {}) {
  return {
    id: "acc-1",
    status: "active",
    currency: "USD",
    available_usd_micros: 5_000_000,
    held_usd_micros: 0,
    funding_policy: "allowance_then_wallet",
    low_balance_threshold_usd_micros: 1_000_000,
    primary_contact_email: null,
    tier: null,
    lease_started_at: null,
    lease_expires_at: null,
    created_at: new Date("2026-01-01"),
    updated_at: new Date("2026-01-01"),
    ...overrides,
  };
}

/** Row shape as it comes back from the DB (values are strings/nulls). */
function makeAccountRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "acc-1",
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
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeFakeClient() {
  const queries: { sql: string; params?: any[] }[] = [];
  return {
    queries,
    query: async (sql: string, params?: any[]) => {
      queries.push({ sql: String(sql), params });
      return { rows: [] };
    },
    release: () => {},
  };
}

// ---------------------------------------------------------------------------
// isWalletTierActive — pure function
// ---------------------------------------------------------------------------

describe("isWalletTierActive", () => {
  it("returns true when tier is set and lease has not expired", () => {
    const future = new Date(Date.now() + 86_400_000);
    const account = makeBillingAccount({ tier: "hobby", lease_expires_at: future });
    assert.equal(isWalletTierActive(account as any), true);
  });

  it("returns false when tier is null", () => {
    const future = new Date(Date.now() + 86_400_000);
    const account = makeBillingAccount({ tier: null, lease_expires_at: future });
    assert.equal(isWalletTierActive(account as any), false);
  });

  it("returns false when lease_expires_at is null", () => {
    const account = makeBillingAccount({ tier: "hobby", lease_expires_at: null });
    assert.equal(isWalletTierActive(account as any), false);
  });

  it("returns false when lease has expired", () => {
    const past = new Date(Date.now() - 86_400_000);
    const account = makeBillingAccount({ tier: "hobby", lease_expires_at: past });
    assert.equal(isWalletTierActive(account as any), false);
  });

  it("returns false when both tier and lease_expires_at are null", () => {
    const account = makeBillingAccount({ tier: null, lease_expires_at: null });
    assert.equal(isWalletTierActive(account as any), false);
  });
});

// ---------------------------------------------------------------------------
// calculateUpgradePrice — pure function
// ---------------------------------------------------------------------------

describe("calculateUpgradePrice", () => {
  it("returns prototype tier price", () => {
    assert.equal(calculateUpgradePrice("prototype"), TIERS.prototype.priceUsdMicros);
    assert.equal(calculateUpgradePrice("prototype"), 100_000);
  });

  it("returns hobby tier price", () => {
    assert.equal(calculateUpgradePrice("hobby"), TIERS.hobby.priceUsdMicros);
    assert.equal(calculateUpgradePrice("hobby"), 5_000_000);
  });

  it("returns team tier price", () => {
    assert.equal(calculateUpgradePrice("team"), TIERS.team.priceUsdMicros);
    assert.equal(calculateUpgradePrice("team"), 20_000_000);
  });
});

// ---------------------------------------------------------------------------
// getWalletPoolUsage
// ---------------------------------------------------------------------------

describe("getWalletPoolUsage", () => {
  beforeEach(() => {
    mockPoolQuery = async () => ({ rows: [] });
  });

  it("returns zeroes when no projects and no billing account", async () => {
    let callCount = 0;
    mockPoolQuery = async () => {
      callCount++;
      if (callCount === 1) {
        // Projects aggregate
        return { rows: [{ projects: 0, total_api_calls: "0", total_storage_bytes: "0" }] };
      }
      // Billing account tier lookup
      return { rows: [] };
    };

    const usage = await getWalletPoolUsage("0xABC");
    assert.equal(usage.projects, 0);
    assert.equal(usage.total_api_calls, 0);
    assert.equal(usage.total_storage_bytes, 0);
    assert.equal(usage.api_calls_limit, 0);
    assert.equal(usage.storage_bytes_limit, 0);
  });

  it("aggregates usage and applies tier limits", async () => {
    let callCount = 0;
    mockPoolQuery = async () => {
      callCount++;
      if (callCount === 1) {
        return { rows: [{ projects: 3, total_api_calls: "12345", total_storage_bytes: "9999" }] };
      }
      return { rows: [{ tier: "hobby" }] };
    };

    const usage = await getWalletPoolUsage("0xABC");
    assert.equal(usage.projects, 3);
    assert.equal(usage.total_api_calls, 12345);
    assert.equal(usage.total_storage_bytes, 9999);

    const hobbyLimits = getTierLimits("hobby");
    assert.equal(usage.api_calls_limit, hobbyLimits.apiCalls);
    assert.equal(usage.storage_bytes_limit, hobbyLimits.storageBytes);
  });

  it("normalizes wallet address to lowercase", async () => {
    let capturedParams: any[] = [];
    mockPoolQuery = async (_sql: any, params?: any[]) => {
      if (params) capturedParams = params;
      return { rows: [{ projects: 0, total_api_calls: "0", total_storage_bytes: "0" }] };
    };

    await getWalletPoolUsage("0xABCDEF");
    assert.equal(capturedParams[0], "0xabcdef");
  });

  it("falls back to zeroes when projects query returns no rows", async () => {
    let callCount = 0;
    mockPoolQuery = async () => {
      callCount++;
      if (callCount === 1) return { rows: [] };
      return { rows: [] };
    };

    const usage = await getWalletPoolUsage("0xABC");
    assert.equal(usage.projects, 0);
    assert.equal(usage.total_api_calls, 0);
    assert.equal(usage.total_storage_bytes, 0);
  });
});

// ---------------------------------------------------------------------------
// getWalletTier
// ---------------------------------------------------------------------------

describe("getWalletTier", () => {
  beforeEach(() => {
    mockPoolQuery = async () => ({ rows: [] });
  });

  it("returns inactive info when no billing account found", async () => {
    // All pool queries return empty
    mockPoolQuery = async () => ({ rows: [] });

    const info = await getWalletTier("0xABC");
    assert.equal(info.wallet, "0xabc");
    assert.equal(info.tier, null);
    assert.equal(info.active, false);
    assert.equal(info.lease_started_at, null);
    assert.equal(info.lease_expires_at, null);
    assert.equal(info.pool_usage.projects, 0);
  });

  it("returns active tier info when account has valid lease", async () => {
    const now = new Date();
    const future = new Date(now.getTime() + 86_400_000);
    let callCount = 0;
    mockPoolQuery = async () => {
      callCount++;
      if (callCount === 1) {
        // billing_accounts join query (for getWalletTier)
        return {
          rows: [{
            tier: "hobby",
            lease_started_at: now.toISOString(),
            lease_expires_at: future.toISOString(),
          }],
        };
      }
      if (callCount === 2) {
        // projects aggregate (for getWalletPoolUsage)
        return { rows: [{ projects: 2, total_api_calls: "100", total_storage_bytes: "200" }] };
      }
      // tier lookup (for getWalletPoolUsage)
      return { rows: [{ tier: "hobby" }] };
    };

    const info = await getWalletTier("0xABC");
    assert.equal(info.wallet, "0xabc");
    assert.equal(info.tier, "hobby");
    assert.equal(info.active, true);
    assert.equal(info.pool_usage.projects, 2);
  });

  it("returns inactive when lease has expired", async () => {
    const past = new Date(Date.now() - 86_400_000);
    const older = new Date(Date.now() - 2 * 86_400_000);
    let callCount = 0;
    mockPoolQuery = async () => {
      callCount++;
      if (callCount === 1) {
        return {
          rows: [{
            tier: "hobby",
            lease_started_at: older.toISOString(),
            lease_expires_at: past.toISOString(),
          }],
        };
      }
      // pool usage queries
      return { rows: [{ projects: 0, total_api_calls: "0", total_storage_bytes: "0" }] };
    };

    const info = await getWalletTier("0xABC");
    assert.equal(info.tier, "hobby");
    assert.equal(info.active, false);
  });
});

// ---------------------------------------------------------------------------
// subscribeTier
// ---------------------------------------------------------------------------

describe("subscribeTier", () => {
  it("sets tier and lease on billing account within a transaction", async () => {
    const account = makeBillingAccount();
    mockGetOrCreateBillingAccount = async () => account;

    const fakeClient = makeFakeClient();
    mockPoolConnect = async () => fakeClient;

    const updatedRow = makeAccountRow({
      tier: "hobby",
      lease_started_at: new Date().toISOString(),
      lease_expires_at: new Date(Date.now() + 30 * 86_400_000).toISOString(),
    });
    mockPoolQuery = async () => ({ rows: [updatedRow] });

    const result = await subscribeTier("0xABC", "hobby");

    // Verify transaction structure
    const sqlStrings = fakeClient.queries.map(q => q.sql);
    assert.ok(sqlStrings[0].includes("BEGIN"), "Should start transaction");
    assert.ok(sqlStrings[1].includes("UPDATE internal.billing_accounts"), "Should update account");
    assert.ok(sqlStrings[2].includes("INSERT INTO internal.allowance_ledger"), "Should insert ledger");
    assert.ok(sqlStrings[3].includes("COMMIT"), "Should commit transaction");

    // Verify returned account
    assert.equal(result.tier, "hobby");
  });

  it("normalizes wallet address to lowercase", async () => {
    let capturedWallet: string | undefined;
    mockGetOrCreateBillingAccount = async (w: string) => {
      capturedWallet = w;
      return makeBillingAccount();
    };

    const fakeClient = makeFakeClient();
    mockPoolConnect = async () => fakeClient;
    mockPoolQuery = async () => ({
      rows: [makeAccountRow({ tier: "prototype" })],
    });

    await subscribeTier("0xABCDEF", "prototype");
    assert.equal(capturedWallet, "0xabcdef");
  });

  it("rolls back on error", async () => {
    mockGetOrCreateBillingAccount = async () => makeBillingAccount();

    let rolledBack = false;
    let released = false;
    const fakeClient = {
      query: async (sql: string) => {
        if (String(sql).includes("UPDATE")) throw new Error("DB down");
        if (String(sql).includes("ROLLBACK")) rolledBack = true;
        return { rows: [] };
      },
      release: () => { released = true; },
    };
    mockPoolConnect = async () => fakeClient;

    await assert.rejects(() => subscribeTier("0xABC", "hobby"), { message: "DB down" });
    assert.ok(rolledBack, "Should have rolled back");
    assert.ok(released, "Should have released client");
  });

  it("uses correct lease duration for each tier", async () => {
    for (const tier of ["prototype", "hobby", "team"] as TierName[]) {
      const account = makeBillingAccount();
      mockGetOrCreateBillingAccount = async () => account;

      const fakeClient = makeFakeClient();
      mockPoolConnect = async () => fakeClient;
      mockPoolQuery = async () => ({
        rows: [makeAccountRow({ tier })],
      });

      await subscribeTier("0xABC", tier);

      // The UPDATE query params should include expiresAt as the 3rd param
      const updateQuery = fakeClient.queries.find(q => q.sql.includes("UPDATE"));
      assert.ok(updateQuery, `Should have UPDATE query for tier ${tier}`);
      const expiresAt = updateQuery!.params![2] as Date;
      const leaseStarted = updateQuery!.params![1] as Date;
      const diffMs = expiresAt.getTime() - leaseStarted.getTime();
      const expectedMs = TIERS[tier].leaseDays * 24 * 60 * 60 * 1000;
      // Allow small tolerance for execution time
      assert.ok(Math.abs(diffMs - expectedMs) < 1000, `Lease duration should be ~${TIERS[tier].leaseDays} days for ${tier}`);
    }
  });
});

// ---------------------------------------------------------------------------
// renewTier
// ---------------------------------------------------------------------------

describe("renewTier", () => {
  it("extends from current expiry when lease is still active", async () => {
    const futureExpiry = new Date(Date.now() + 5 * 86_400_000); // 5 days from now
    const account = makeBillingAccount({
      tier: "hobby",
      lease_expires_at: futureExpiry,
      lease_started_at: new Date(),
    });
    mockGetOrCreateBillingAccount = async () => account;

    const fakeClient = makeFakeClient();
    mockPoolConnect = async () => fakeClient;
    mockPoolQuery = async () => ({
      rows: [makeAccountRow({ tier: "hobby" })],
    });

    await renewTier("0xABC", "hobby");

    const updateQuery = fakeClient.queries.find(q => q.sql.includes("UPDATE"));
    assert.ok(updateQuery);
    const newExpiry = updateQuery!.params![2] as Date;
    // Should extend from futureExpiry, not from now
    const expectedMs = futureExpiry.getTime() + TIERS.hobby.leaseDays * 24 * 60 * 60 * 1000;
    assert.ok(Math.abs(newExpiry.getTime() - expectedMs) < 1000,
      "Should extend from current expiry");
  });

  it("extends from now when lease has expired", async () => {
    const pastExpiry = new Date(Date.now() - 86_400_000); // yesterday
    const account = makeBillingAccount({
      tier: "hobby",
      lease_expires_at: pastExpiry,
      lease_started_at: new Date(Date.now() - 31 * 86_400_000),
    });
    mockGetOrCreateBillingAccount = async () => account;

    const fakeClient = makeFakeClient();
    mockPoolConnect = async () => fakeClient;
    mockPoolQuery = async () => ({
      rows: [makeAccountRow({ tier: "hobby" })],
    });

    const before = Date.now();
    await renewTier("0xABC", "hobby");
    const after = Date.now();

    const updateQuery = fakeClient.queries.find(q => q.sql.includes("UPDATE"));
    assert.ok(updateQuery);
    const newExpiry = updateQuery!.params![2] as Date;
    const expectedMin = before + TIERS.hobby.leaseDays * 24 * 60 * 60 * 1000;
    const expectedMax = after + TIERS.hobby.leaseDays * 24 * 60 * 60 * 1000;
    assert.ok(newExpiry.getTime() >= expectedMin && newExpiry.getTime() <= expectedMax,
      "Should extend from now when expired");
  });

  it("extends from now when lease_expires_at is null", async () => {
    const account = makeBillingAccount({
      tier: null,
      lease_expires_at: null,
      lease_started_at: null,
    });
    mockGetOrCreateBillingAccount = async () => account;

    const fakeClient = makeFakeClient();
    mockPoolConnect = async () => fakeClient;
    mockPoolQuery = async () => ({
      rows: [makeAccountRow({ tier: "prototype" })],
    });

    const before = Date.now();
    await renewTier("0xABC", "prototype");
    const after = Date.now();

    const updateQuery = fakeClient.queries.find(q => q.sql.includes("UPDATE"));
    const newExpiry = updateQuery!.params![2] as Date;
    const expectedMin = before + TIERS.prototype.leaseDays * 24 * 60 * 60 * 1000;
    const expectedMax = after + TIERS.prototype.leaseDays * 24 * 60 * 60 * 1000;
    assert.ok(newExpiry.getTime() >= expectedMin && newExpiry.getTime() <= expectedMax);
  });

  it("inserts tier_renew ledger entry", async () => {
    const account = makeBillingAccount();
    mockGetOrCreateBillingAccount = async () => account;

    const fakeClient = makeFakeClient();
    mockPoolConnect = async () => fakeClient;
    mockPoolQuery = async () => ({
      rows: [makeAccountRow()],
    });

    await renewTier("0xABC", "hobby");

    const ledgerQuery = fakeClient.queries.find(q => q.sql.includes("allowance_ledger"));
    assert.ok(ledgerQuery, "Should insert ledger entry");
    assert.ok(String(ledgerQuery!.sql).includes("tier_renew"));
  });

  it("rolls back on error", async () => {
    mockGetOrCreateBillingAccount = async () => makeBillingAccount();

    let rolledBack = false;
    let released = false;
    const fakeClient = {
      query: async (sql: string) => {
        if (String(sql).includes("UPDATE")) throw new Error("DB error");
        if (String(sql).includes("ROLLBACK")) rolledBack = true;
        return { rows: [] };
      },
      release: () => { released = true; },
    };
    mockPoolConnect = async () => fakeClient;

    await assert.rejects(() => renewTier("0xABC", "hobby"), { message: "DB error" });
    assert.ok(rolledBack);
    assert.ok(released);
  });
});

// ---------------------------------------------------------------------------
// upgradeTier
// ---------------------------------------------------------------------------

describe("upgradeTier", () => {
  it("calculates prorated refund for remaining old tier time", async () => {
    const now = Date.now();
    const leaseStart = new Date(now - 15 * 86_400_000); // 15 days ago
    const leaseExpiry = new Date(now + 15 * 86_400_000); // 15 days left
    const account = makeBillingAccount({
      tier: "hobby",
      lease_started_at: leaseStart,
      lease_expires_at: leaseExpiry,
      available_usd_micros: 1_000_000,
    });
    mockGetOrCreateBillingAccount = async () => account;

    const fakeClient = {
      queries: [] as any[],
      query: async (sql: string, params?: any[]) => {
        fakeClient.queries.push({ sql: String(sql), params });
        // SELECT ... FOR UPDATE
        if (String(sql).includes("FOR UPDATE")) {
          return {
            rows: [{
              available_usd_micros: "1000000",
              held_usd_micros: "0",
            }],
          };
        }
        return { rows: [] };
      },
      release: () => {},
    };
    mockPoolConnect = async () => fakeClient;
    mockPoolQuery = async () => ({
      rows: [makeAccountRow({ tier: "team", available_usd_micros: "3500000" })],
    });

    const result = await upgradeTier("0xABC", "team");

    // Should have refund ledger entry
    const refundQuery = fakeClient.queries.find(q =>
      String(q.sql).includes("tier_upgrade_refund"));
    assert.ok(refundQuery, "Should insert refund ledger entry");

    // Refund should be approximately half of hobby price (15/30 days remaining)
    const refundAmount = refundQuery!.params![2];
    const expectedRefund = Math.floor(0.5 * TIERS.hobby.priceUsdMicros);
    // Allow 5% tolerance since timing isn't exact
    assert.ok(
      Math.abs(refundAmount - expectedRefund) < expectedRefund * 0.05,
      `Refund ${refundAmount} should be ~${expectedRefund}`,
    );
  });

  it("skips refund when old tier has no lease info", async () => {
    const account = makeBillingAccount({
      tier: null,
      lease_started_at: null,
      lease_expires_at: null,
    });
    mockGetOrCreateBillingAccount = async () => account;

    const fakeClient = {
      queries: [] as any[],
      query: async (sql: string, params?: any[]) => {
        fakeClient.queries.push({ sql: String(sql), params });
        if (String(sql).includes("FOR UPDATE")) {
          return { rows: [{ available_usd_micros: "0", held_usd_micros: "0" }] };
        }
        return { rows: [] };
      },
      release: () => {},
    };
    mockPoolConnect = async () => fakeClient;
    mockPoolQuery = async () => ({
      rows: [makeAccountRow({ tier: "hobby" })],
    });

    await upgradeTier("0xABC", "hobby");

    const refundQuery = fakeClient.queries.find(q =>
      String(q.sql).includes("tier_upgrade_refund"));
    assert.equal(refundQuery, undefined, "Should not insert refund when no old tier");
  });

  it("skips refund when old tier lease has expired", async () => {
    const account = makeBillingAccount({
      tier: "prototype",
      lease_started_at: new Date(Date.now() - 14 * 86_400_000),
      lease_expires_at: new Date(Date.now() - 7 * 86_400_000), // expired 7 days ago
    });
    mockGetOrCreateBillingAccount = async () => account;

    const fakeClient = {
      queries: [] as any[],
      query: async (sql: string, params?: any[]) => {
        fakeClient.queries.push({ sql: String(sql), params });
        if (String(sql).includes("FOR UPDATE")) {
          return { rows: [{ available_usd_micros: "0", held_usd_micros: "0" }] };
        }
        return { rows: [] };
      },
      release: () => {},
    };
    mockPoolConnect = async () => fakeClient;
    mockPoolQuery = async () => ({
      rows: [makeAccountRow({ tier: "hobby" })],
    });

    await upgradeTier("0xABC", "hobby");

    const refundQuery = fakeClient.queries.find(q =>
      String(q.sql).includes("tier_upgrade_refund"));
    assert.equal(refundQuery, undefined, "Should not insert refund when lease expired");
  });

  it("credits refund to available balance", async () => {
    const now = Date.now();
    const account = makeBillingAccount({
      tier: "hobby",
      lease_started_at: new Date(now - 10 * 86_400_000),
      lease_expires_at: new Date(now + 20 * 86_400_000), // 20/30 days remain
      available_usd_micros: 2_000_000,
    });
    mockGetOrCreateBillingAccount = async () => account;

    const fakeClient = {
      queries: [] as any[],
      query: async (sql: string, params?: any[]) => {
        fakeClient.queries.push({ sql: String(sql), params });
        if (String(sql).includes("FOR UPDATE")) {
          return { rows: [{ available_usd_micros: "2000000", held_usd_micros: "0" }] };
        }
        return { rows: [] };
      },
      release: () => {},
    };
    mockPoolConnect = async () => fakeClient;
    mockPoolQuery = async () => ({
      rows: [makeAccountRow({ tier: "team" })],
    });

    await upgradeTier("0xABC", "team");

    // The UPDATE query should set available_usd_micros = 2_000_000 + refund
    const updateQuery = fakeClient.queries.find(q =>
      String(q.sql).includes("UPDATE internal.billing_accounts") &&
      String(q.sql).includes("available_usd_micros = $4"));
    assert.ok(updateQuery, "Should update available balance");
    const newAvailable = updateQuery!.params![3];
    assert.ok(newAvailable > 2_000_000, "Available balance should increase by refund amount");
  });

  it("rolls back on error and releases client", async () => {
    mockGetOrCreateBillingAccount = async () => makeBillingAccount({ tier: "hobby" });

    let rolledBack = false;
    let released = false;
    const fakeClient = {
      query: async (sql: string) => {
        if (String(sql).includes("FOR UPDATE")) throw new Error("lock fail");
        if (String(sql).includes("ROLLBACK")) rolledBack = true;
        return { rows: [] };
      },
      release: () => { released = true; },
    };
    mockPoolConnect = async () => fakeClient;

    await assert.rejects(() => upgradeTier("0xABC", "team"), { message: "lock fail" });
    assert.ok(rolledBack);
    assert.ok(released);
  });
});

// ---------------------------------------------------------------------------
// setTier — orchestrator
// ---------------------------------------------------------------------------

describe("setTier", () => {
  beforeEach(() => {
    mockPoolQuery = async () => ({ rows: [] });
  });

  it("subscribes when account has no tier", async () => {
    const account = makeBillingAccount({ tier: null });
    mockGetOrCreateBillingAccount = async () => account;

    const fakeClient = makeFakeClient();
    mockPoolConnect = async () => fakeClient;
    mockPoolQuery = async () => ({
      rows: [makeAccountRow({ tier: "hobby" })],
    });

    const result = await setTier("0xABC", "hobby");
    assert.equal(result.action, "subscribe");
    assert.equal(result.previous_tier, null);
  });

  it("subscribes when tier has expired", async () => {
    const pastExpiry = new Date(Date.now() - 86_400_000);
    const account = makeBillingAccount({
      tier: "prototype",
      lease_expires_at: pastExpiry,
      lease_started_at: new Date(Date.now() - 8 * 86_400_000),
    });
    mockGetOrCreateBillingAccount = async () => account;

    const fakeClient = makeFakeClient();
    mockPoolConnect = async () => fakeClient;
    mockPoolQuery = async () => ({
      rows: [makeAccountRow({ tier: "hobby" })],
    });

    const result = await setTier("0xABC", "hobby");
    assert.equal(result.action, "subscribe");
    assert.equal(result.previous_tier, "prototype");
  });

  it("renews when same tier is still active", async () => {
    const futureExpiry = new Date(Date.now() + 10 * 86_400_000);
    const account = makeBillingAccount({
      tier: "hobby",
      lease_expires_at: futureExpiry,
      lease_started_at: new Date(),
    });
    mockGetOrCreateBillingAccount = async () => account;

    const fakeClient = makeFakeClient();
    mockPoolConnect = async () => fakeClient;
    mockPoolQuery = async () => ({
      rows: [makeAccountRow({ tier: "hobby" })],
    });

    const result = await setTier("0xABC", "hobby");
    assert.equal(result.action, "renew");
    assert.equal(result.previous_tier, "hobby");
  });

  it("upgrades when new tier is higher", async () => {
    const futureExpiry = new Date(Date.now() + 10 * 86_400_000);
    const account = makeBillingAccount({
      tier: "prototype",
      lease_expires_at: futureExpiry,
      lease_started_at: new Date(),
      available_usd_micros: 0,
    });
    mockGetOrCreateBillingAccount = async () => account;

    const fakeClient = {
      queries: [] as any[],
      query: async (sql: string, params?: any[]) => {
        fakeClient.queries.push({ sql: String(sql), params });
        if (String(sql).includes("FOR UPDATE")) {
          return { rows: [{ available_usd_micros: "0", held_usd_micros: "0" }] };
        }
        return { rows: [] };
      },
      release: () => {},
    };
    mockPoolConnect = async () => fakeClient;
    mockPoolQuery = async () => ({
      rows: [makeAccountRow({ tier: "team" })],
    });

    const result = await setTier("0xABC", "team");
    assert.equal(result.action, "upgrade");
    assert.equal(result.previous_tier, "prototype");
  });

  it("downgrades when new tier is lower and usage fits", async () => {
    const futureExpiry = new Date(Date.now() + 10 * 86_400_000);
    const account = makeBillingAccount({
      tier: "team",
      lease_expires_at: futureExpiry,
      lease_started_at: new Date(),
      available_usd_micros: 0,
    });
    mockGetOrCreateBillingAccount = async () => account;

    let poolCallCount = 0;
    mockPoolQuery = async () => {
      poolCallCount++;
      // getWalletPoolUsage calls: 1=projects aggregate, 2=tier lookup
      // then upgradeTier uses pool.connect for transaction, then pool.query for final SELECT
      if (poolCallCount === 1) {
        return { rows: [{ projects: 1, total_api_calls: "100", total_storage_bytes: "100" }] };
      }
      if (poolCallCount === 2) {
        return { rows: [{ tier: "team" }] };
      }
      // Final SELECT after upgradeTier commit
      return { rows: [makeAccountRow({ tier: "hobby" })] };
    };

    const fakeClient = {
      queries: [] as any[],
      query: async (sql: string, params?: any[]) => {
        fakeClient.queries.push({ sql: String(sql), params });
        if (String(sql).includes("FOR UPDATE")) {
          return { rows: [{ available_usd_micros: "0", held_usd_micros: "0" }] };
        }
        return { rows: [] };
      },
      release: () => {},
    };
    mockPoolConnect = async () => fakeClient;

    const result = await setTier("0xABC", "hobby");
    assert.equal(result.action, "downgrade");
    assert.equal(result.previous_tier, "team");
  });

  it("rejects downgrade when storage usage exceeds new tier limit", async () => {
    const futureExpiry = new Date(Date.now() + 10 * 86_400_000);
    const account = makeBillingAccount({
      tier: "team",
      lease_expires_at: futureExpiry,
      lease_started_at: new Date(),
    });
    mockGetOrCreateBillingAccount = async () => account;

    const protoLimits = getTierLimits("prototype");
    // Storage exceeds prototype limit
    const excessiveStorage = protoLimits.storageBytes + 1;

    let poolCallCount = 0;
    mockPoolQuery = async () => {
      poolCallCount++;
      if (poolCallCount === 1) {
        return {
          rows: [{
            projects: 1,
            total_api_calls: "100",
            total_storage_bytes: String(excessiveStorage),
          }],
        };
      }
      // tier lookup
      return { rows: [{ tier: "team" }] };
    };

    await assert.rejects(
      () => setTier("0xABC", "prototype"),
      (err: any) => {
        assert.ok(err instanceof CapturedHttpError);
        assert.equal(err.statusCode, 400);
        assert.ok(err.message.includes("Cannot downgrade"));
        return true;
      },
    );
  });

  it("normalizes wallet address for all paths", async () => {
    let capturedWallet: string | undefined;
    mockGetOrCreateBillingAccount = async (w: string) => {
      capturedWallet = w;
      return makeBillingAccount({ tier: null });
    };

    const fakeClient = makeFakeClient();
    mockPoolConnect = async () => fakeClient;
    mockPoolQuery = async () => ({
      rows: [makeAccountRow({ tier: "prototype" })],
    });

    await setTier("0xABCDEF", "prototype");
    assert.equal(capturedWallet, "0xabcdef");
  });
});
