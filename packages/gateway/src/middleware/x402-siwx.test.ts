import { describe, it, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import { privateKeyToAccount } from "viem/accounts";
import { createSIWxPayload, encodeSIWxHeader } from "@x402/extensions/sign-in-with-x";
import type { CompleteSIWxInfo } from "@x402/extensions/sign-in-with-x";

// Test account (first Hardhat/Foundry test account — deterministic)
const TEST_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;
const testAccount = privateKeyToAccount(TEST_KEY);

// ---------------------------------------------------------------------------
// Mock DB dependencies
// ---------------------------------------------------------------------------
let recordedWallets: { address: string; source: string }[];

mock.module("../utils/wallet.js", {
  namedExports: {
    recordWallet: (address: string, source: string) => {
      recordedWallets.push({ address, source });
    },
    extractWalletFromPaymentHeader: () => null,
  },
});

mock.module("../db/pool.js", {
  namedExports: {
    pool: { query: async () => ({ rows: [] }) },
  },
});

const { createSIWxAuthOnlyHook } = await import("./x402.js");

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
// Fake context helpers
// ---------------------------------------------------------------------------

function fakeContext(method: string, path: string, headers: Record<string, string> = {}) {
  const lowered: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    lowered[k.toLowerCase()] = v;
  }
  return {
    method,
    path,
    adapter: {
      getHeader: (name: string) => lowered[name.toLowerCase()],
      getUrl: () => `http://localhost${path}`,
    },
  };
}

// ---------------------------------------------------------------------------
// Resource configs for testing
// ---------------------------------------------------------------------------

const resourceConfig = {
  // Auth-only route
  "GET /ping/v1": {
    accepts: [],
    description: "Auth-only ping",
  },
  "POST /projects/v1": {
    accepts: [],
    description: "Create project",
  },
  // Paid route — should NOT be handled by the auth-only hook
  "POST /tiers/v1/hobby": {
    accepts: [{ scheme: "exact", price: "$5.00", network: "eip155:84532", payTo: "0x123" }],
    description: "Set hobby tier",
  },
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createSIWxAuthOnlyHook", () => {
  beforeEach(() => {
    recordedWallets = [];
  });

  it("grants access with valid SIWX on auth-only route", async () => {
    const hook = createSIWxAuthOnlyHook(resourceConfig);
    const header = await createSIWxTestHeader({ uri: "http://localhost/ping/v1" });
    const ctx = fakeContext("GET", "/ping/v1", { "sign-in-with-x": header });

    const result = await hook(ctx);
    assert.deepEqual(result, { grantAccess: true });
  });

  it("records wallet sighting with source 'siwx'", async () => {
    const hook = createSIWxAuthOnlyHook(resourceConfig);
    const header = await createSIWxTestHeader({ uri: "http://localhost/ping/v1" });
    const ctx = fakeContext("GET", "/ping/v1", { "sign-in-with-x": header });

    await hook(ctx);
    assert.equal(recordedWallets.length, 1);
    assert.equal(recordedWallets[0].source, "siwx");
    assert.equal(recordedWallets[0].address, testAccount.address.toLowerCase());
  });

  it("returns undefined (no grant) when SIWX header is missing on auth-only route", async () => {
    const hook = createSIWxAuthOnlyHook(resourceConfig);
    const ctx = fakeContext("GET", "/ping/v1");

    const result = await hook(ctx);
    assert.equal(result, undefined);
  });

  it("returns undefined for paid routes (accepts has entries)", async () => {
    const hook = createSIWxAuthOnlyHook(resourceConfig);
    const header = await createSIWxTestHeader({ uri: "http://localhost/tiers/v1/hobby" });
    const ctx = fakeContext("POST", "/tiers/v1/hobby", { "sign-in-with-x": header });

    const result = await hook(ctx);
    assert.equal(result, undefined);
  });

  it("returns undefined for routes not in resourceConfig", async () => {
    const hook = createSIWxAuthOnlyHook(resourceConfig);
    const header = await createSIWxTestHeader({ uri: "http://localhost/unknown" });
    const ctx = fakeContext("GET", "/unknown", { "sign-in-with-x": header });

    const result = await hook(ctx);
    assert.equal(result, undefined);
  });

  it("returns undefined when SIWX signature is invalid", async () => {
    const hook = createSIWxAuthOnlyHook(resourceConfig);
    const header = await createSIWxTestHeader({ uri: "http://localhost/ping/v1" });
    const decoded = JSON.parse(Buffer.from(header, "base64").toString());
    decoded.signature = "0x" + "ab".repeat(65);
    const corrupted = Buffer.from(JSON.stringify(decoded)).toString("base64");

    const ctx = fakeContext("GET", "/ping/v1", { "sign-in-with-x": corrupted });
    const result = await hook(ctx);
    assert.equal(result, undefined);
  });

  it("returns undefined when SIWX domain mismatches", async () => {
    const hook = createSIWxAuthOnlyHook(resourceConfig);
    const header = await createSIWxTestHeader({
      domain: "evil.com",
      uri: "http://localhost/ping/v1",
    });
    const ctx = fakeContext("GET", "/ping/v1", { "sign-in-with-x": header });

    const result = await hook(ctx);
    assert.equal(result, undefined);
  });

  it("returns undefined when SIWX message is expired", async () => {
    const hook = createSIWxAuthOnlyHook(resourceConfig);
    const header = await createSIWxTestHeader({
      uri: "http://localhost/ping/v1",
      issuedAt: new Date(Date.now() - 15 * 60 * 1000).toISOString(),
      expirationTime: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
    });
    const ctx = fakeContext("GET", "/ping/v1", { "sign-in-with-x": header });

    const result = await hook(ctx);
    assert.equal(result, undefined);
  });

  it("returns undefined when SIWX header is garbage", async () => {
    const hook = createSIWxAuthOnlyHook(resourceConfig);
    const ctx = fakeContext("GET", "/ping/v1", { "sign-in-with-x": "not-valid-base64!!!" });

    const result = await hook(ctx);
    assert.equal(result, undefined);
  });

  it("handles case-insensitive SIGN-IN-WITH-X header", async () => {
    const hook = createSIWxAuthOnlyHook(resourceConfig);
    const header = await createSIWxTestHeader({ uri: "http://localhost/ping/v1" });
    const ctx = fakeContext("GET", "/ping/v1", { "SIGN-IN-WITH-X": header });

    const result = await hook(ctx);
    assert.deepEqual(result, { grantAccess: true });
  });

  it("handles POST auth-only routes", async () => {
    const hook = createSIWxAuthOnlyHook(resourceConfig);
    const header = await createSIWxTestHeader({ uri: "http://localhost/projects/v1" });
    const ctx = fakeContext("POST", "/projects/v1", { "sign-in-with-x": header });

    const result = await hook(ctx);
    assert.deepEqual(result, { grantAccess: true });
  });

  it("is case-insensitive on HTTP method", async () => {
    const hook = createSIWxAuthOnlyHook(resourceConfig);
    const header = await createSIWxTestHeader({ uri: "http://localhost/ping/v1" });
    const ctx = fakeContext("get", "/ping/v1", { "sign-in-with-x": header });

    const result = await hook(ctx);
    assert.deepEqual(result, { grantAccess: true });
  });
});
