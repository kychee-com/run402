import { describe, it, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import { privateKeyToAccount } from "viem/accounts";
import { createSIWxPayload, encodeSIWxHeader } from "@x402/extensions/sign-in-with-x";
import type { CompleteSIWxInfo } from "@x402/extensions/sign-in-with-x";

// Test account (first Hardhat/Foundry test account — deterministic)
const TEST_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;
const testAccount = privateKeyToAccount(TEST_KEY);

// ---------------------------------------------------------------------------
// Mock DB dependencies before importing the module under test
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mockGetBillingAccount: (wallet: string) => any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mockIsWalletTierActive: (account: any) => boolean;
let recordedWallets: { address: string; source: string }[];

mock.module("../services/billing.js", {
  namedExports: {
    getBillingAccount: (wallet: string) => mockGetBillingAccount(wallet),
  },
});

mock.module("../services/wallet-tiers.js", {
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

const { walletAuth, invalidateWalletTierCache } = await import("./wallet-auth.js");

// ---------------------------------------------------------------------------
// SIWX header helpers
// ---------------------------------------------------------------------------

async function createSIWxTestHeader(overrides: Partial<CompleteSIWxInfo> = {}): Promise<string> {
  const now = new Date();
  const info: CompleteSIWxInfo = {
    domain: "localhost",
    uri: "http://localhost/ping/v1",
    statement: "Sign in to Run402",
    version: "1",
    nonce: Math.random().toString(36).slice(2),
    issuedAt: now.toISOString(),
    expirationTime: new Date(now.getTime() + 5 * 60 * 1000).toISOString(),
    chainId: "eip155:84532",
    type: "eip191",
    ...overrides,
  };
  const payload = await createSIWxPayload(info, testAccount);
  return encodeSIWxHeader(payload);
}

// ---------------------------------------------------------------------------
// Fake Express req/res helpers
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fakeReq(overrides: Record<string, any> = {}): any {
  const headers: Record<string, string> = {};
  return {
    headers,
    hostname: "localhost",
    path: "/ping/v1",
    originalUrl: "/ping/v1",
    protocol: "http",
    get(name: string) {
      return headers[name.toLowerCase()];
    },
    ...overrides,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fakeRes(): any {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const res: Record<string, any> = {
    _status: 200,
    _body: null,
    status(code: number) {
      res._status = code;
      return res;
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    json(obj: any) {
      res._body = obj;
      return res;
    },
  };
  return res;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("walletAuth middleware — SIWX", () => {
  beforeEach(() => {
    recordedWallets = [];
    invalidateWalletTierCache(testAccount.address);
    // Default: wallet has active tier
    mockGetBillingAccount = async () => ({
      tier: "hobby",
      lease_expires_at: new Date(Date.now() + 86400000),
    });
    mockIsWalletTierActive = () => true;
  });

  it("accepts valid SIWX header and sets req.walletAddress", async () => {
    const header = await createSIWxTestHeader();
    const req = fakeReq({ headers: { "sign-in-with-x": header } });
    const res = fakeRes();
    let nextCalled = false;

    const middleware = walletAuth(false);
    await middleware(req, res, () => { nextCalled = true; });

    assert.ok(nextCalled, "next() should be called");
    assert.equal(req.walletAddress, testAccount.address.toLowerCase());
    assert.equal(req.walletTier, "hobby");
  });

  it("returns 401 when SIGN-IN-WITH-X header is missing", async () => {
    const req = fakeReq();
    const res = fakeRes();
    let nextCalled = false;

    const middleware = walletAuth(false);
    await middleware(req, res, () => { nextCalled = true; });

    assert.ok(!nextCalled, "next() should not be called");
    assert.equal(res._status, 401);
    assert.ok(res._body.error.includes("SIGN-IN-WITH-X"));
  });

  it("returns 401 when SIWX header is invalid base64", async () => {
    const req = fakeReq({ headers: { "sign-in-with-x": "not-valid-base64!!!" } });
    const res = fakeRes();
    let nextCalled = false;

    const middleware = walletAuth(false);
    await middleware(req, res, () => { nextCalled = true; });

    assert.ok(!nextCalled, "next() should not be called");
    assert.equal(res._status, 401);
  });

  it("returns 401 when SIWX signature is invalid", async () => {
    // Create a valid header then corrupt the signature
    const header = await createSIWxTestHeader();
    const decoded = JSON.parse(Buffer.from(header, "base64").toString());
    decoded.signature = "0x" + "ab".repeat(65);
    const corrupted = Buffer.from(JSON.stringify(decoded)).toString("base64");

    const req = fakeReq({ headers: { "sign-in-with-x": corrupted } });
    const res = fakeRes();
    let nextCalled = false;

    const middleware = walletAuth(false);
    await middleware(req, res, () => { nextCalled = true; });

    assert.ok(!nextCalled, "next() should not be called");
    assert.equal(res._status, 401);
  });

  it("returns 401 when SIWX message is expired", async () => {
    const past = new Date(Date.now() - 10 * 60 * 1000); // 10 min ago
    const header = await createSIWxTestHeader({
      issuedAt: new Date(Date.now() - 15 * 60 * 1000).toISOString(),
      expirationTime: past.toISOString(),
    });
    const req = fakeReq({ headers: { "sign-in-with-x": header } });
    const res = fakeRes();
    let nextCalled = false;

    const middleware = walletAuth(false);
    await middleware(req, res, () => { nextCalled = true; });

    assert.ok(!nextCalled, "next() should not be called");
    assert.equal(res._status, 401);
    assert.ok(res._body.error.includes("expired"));
  });

  it("returns 401 when SIWX message issuedAt is too old", async () => {
    const header = await createSIWxTestHeader({
      issuedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(), // 10 min ago
      expirationTime: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
    });
    const req = fakeReq({ headers: { "sign-in-with-x": header } });
    const res = fakeRes();
    let nextCalled = false;

    const middleware = walletAuth(false);
    await middleware(req, res, () => { nextCalled = true; });

    assert.ok(!nextCalled, "next() should not be called");
    assert.equal(res._status, 401);
    assert.ok(res._body.error.includes("too old"));
  });

  it("returns 200 with valid SIWX + active tier when requireTier=true", async () => {
    const header = await createSIWxTestHeader();
    const req = fakeReq({ headers: { "sign-in-with-x": header } });
    const res = fakeRes();
    let nextCalled = false;

    const middleware = walletAuth(true);
    await middleware(req, res, () => { nextCalled = true; });

    assert.ok(nextCalled, "next() should be called");
    assert.equal(req.walletAddress, testAccount.address.toLowerCase());
  });

  it("returns 402 with valid SIWX + expired tier when requireTier=true", async () => {
    mockGetBillingAccount = async () => ({
      tier: "hobby",
      lease_expires_at: new Date(Date.now() - 86400000),
    });
    mockIsWalletTierActive = () => false;

    const header = await createSIWxTestHeader();
    const req = fakeReq({ headers: { "sign-in-with-x": header } });
    const res = fakeRes();
    let nextCalled = false;

    invalidateWalletTierCache(testAccount.address);

    const middleware = walletAuth(true);
    await middleware(req, res, () => { nextCalled = true; });

    assert.ok(!nextCalled, "next() should not be called");
    assert.equal(res._status, 402);
    assert.ok(res._body.error.includes("tier"));
  });

  it("returns 200 with valid SIWX + no tier when requireTier=false", async () => {
    mockGetBillingAccount = async () => null;
    mockIsWalletTierActive = () => false;

    const header = await createSIWxTestHeader();
    const req = fakeReq({ headers: { "sign-in-with-x": header } });
    const res = fakeRes();
    let nextCalled = false;

    invalidateWalletTierCache(testAccount.address);

    const middleware = walletAuth(false);
    await middleware(req, res, () => { nextCalled = true; });

    assert.ok(nextCalled, "next() should be called");
    assert.equal(req.walletAddress, testAccount.address.toLowerCase());
    assert.equal(req.walletTier, null);
  });

  it("records wallet sighting with source 'siwx'", async () => {
    const header = await createSIWxTestHeader();
    const req = fakeReq({ headers: { "sign-in-with-x": header } });
    const res = fakeRes();

    const middleware = walletAuth(false);
    await middleware(req, res, () => {});

    assert.equal(recordedWallets.length, 1);
    assert.equal(recordedWallets[0].source, "siwx");
    assert.equal(recordedWallets[0].address, testAccount.address.toLowerCase());
  });

  it("returns 401 when domain does not match", async () => {
    const header = await createSIWxTestHeader({ domain: "evil.com" });
    const req = fakeReq({ headers: { "sign-in-with-x": header } });
    const res = fakeRes();
    let nextCalled = false;

    const middleware = walletAuth(false);
    await middleware(req, res, () => { nextCalled = true; });

    assert.ok(!nextCalled, "next() should not be called");
    assert.equal(res._status, 401);
    assert.ok(res._body.error.includes("domain"));
  });
});
