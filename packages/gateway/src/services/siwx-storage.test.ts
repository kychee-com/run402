import { describe, it, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";

// ---------------------------------------------------------------------------
// Mock DB dependencies before importing the module under test
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mockGetBillingAccount: (wallet: string) => any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mockIsWalletTierActive: (account: any) => boolean;
let recordedWallets: { address: string; source: string }[];

mock.module("./billing.js", {
  namedExports: {
    getBillingAccount: (wallet: string) => mockGetBillingAccount(wallet),
  },
});

mock.module("./wallet-tiers.js", {
  namedExports: {
    isWalletTierActive: (account: unknown) => mockIsWalletTierActive(account),
  },
});

mock.module("../utils/wallet.js", {
  namedExports: {
    recordWallet: (address: string, source: string) => {
      recordedWallets.push({ address, source });
    },
  },
});

mock.module("../db/pool.js", {
  namedExports: {
    pool: { query: async () => ({ rows: [] }) },
  },
});

const { siwxStorage, invalidateSIWxTierCache } = await import("./siwx-storage.js");

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("siwxStorage.hasPaid", () => {
  beforeEach(() => {
    recordedWallets = [];
    invalidateSIWxTierCache("0xabc");
  });

  it("returns true when wallet has active tier", async () => {
    mockGetBillingAccount = async () => ({ tier: "hobby", lease_expires_at: new Date(Date.now() + 86400000) });
    mockIsWalletTierActive = () => true;

    const result = await siwxStorage.hasPaid("POST /projects/v1", "0xABC");
    assert.equal(result, true);
  });

  it("returns false when wallet has no account", async () => {
    mockGetBillingAccount = async () => null;
    mockIsWalletTierActive = () => false;

    const result = await siwxStorage.hasPaid("POST /projects/v1", "0xDEF");
    assert.equal(result, false);
  });

  it("returns false when tier is expired", async () => {
    mockGetBillingAccount = async () => ({ tier: "hobby", lease_expires_at: new Date(Date.now() - 86400000) });
    mockIsWalletTierActive = () => false;

    const result = await siwxStorage.hasPaid("POST /projects/v1", "0x123");
    assert.equal(result, false);
  });

  it("caches results for 60s", async () => {
    let callCount = 0;
    mockGetBillingAccount = async () => {
      callCount++;
      return { tier: "hobby", lease_expires_at: new Date(Date.now() + 86400000) };
    };
    mockIsWalletTierActive = () => true;

    await siwxStorage.hasPaid("resource", "0xCACHE");
    await siwxStorage.hasPaid("resource", "0xCACHE");

    assert.equal(callCount, 1, "DB should only be called once due to caching");
  });

  it("normalizes address to lowercase", async () => {
    let queriedWallet: string | undefined;
    mockGetBillingAccount = async (w: string) => {
      queriedWallet = w;
      return null;
    };
    mockIsWalletTierActive = () => false;

    await siwxStorage.hasPaid("resource", "0xABCDEF");
    assert.equal(queriedWallet, "0xabcdef");
  });
});

describe("siwxStorage.recordPayment", () => {
  beforeEach(() => {
    recordedWallets = [];
  });

  it("calls recordWallet with source 'siwx'", async () => {
    await siwxStorage.recordPayment("POST /tiers/v1/hobby", "0xABC123");
    assert.equal(recordedWallets.length, 1);
    assert.equal(recordedWallets[0].address, "0xabc123");
    assert.equal(recordedWallets[0].source, "siwx");
  });
});

describe("invalidateSIWxTierCache", () => {
  beforeEach(() => {
    recordedWallets = [];
  });

  it("forces re-query after invalidation", async () => {
    let callCount = 0;
    mockGetBillingAccount = async () => {
      callCount++;
      return { tier: "hobby", lease_expires_at: new Date(Date.now() + 86400000) };
    };
    mockIsWalletTierActive = () => true;

    await siwxStorage.hasPaid("resource", "0xINVAL");
    assert.equal(callCount, 1);

    invalidateSIWxTierCache("0xINVAL");

    await siwxStorage.hasPaid("resource", "0xINVAL");
    assert.equal(callCount, 2, "DB should be re-queried after cache invalidation");
  });
});
