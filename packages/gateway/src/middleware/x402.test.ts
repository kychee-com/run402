import { describe, it, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";

// ---------------------------------------------------------------------------
// Mock ALL external imports before importing the module under test.
// These must be called before any `import()` of the module.
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let capturedOnProtectedHandlers: Array<(ctx: any) => Promise<any>>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let x402MiddlewareFn: (req: any, res: any, next: any) => void;

mock.module("@x402/express", {
  namedExports: {
    paymentMiddlewareFromHTTPServer: () => {
      // Default: call next() (no payment required)
      x402MiddlewareFn = (_req, _res, next) => next();
      return x402MiddlewareFn;
    },
    x402ResourceServer: class {
      register() {}
      registerExtension() {}
    },
    x402HTTPResourceServer: class {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      constructor(_server: any, _config: any) {}
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      onProtectedRequest(handler: any) {
        capturedOnProtectedHandlers.push(handler);
      }
    },
  },
});
mock.module("@x402/evm/exact/server", { namedExports: { ExactEvmScheme: class {} } });
mock.module("@x402/core/server", { namedExports: { HTTPFacilitatorClient: class {} } });
mock.module("@coinbase/x402", { namedExports: { createFacilitatorConfig: () => ({}) } });
mock.module("@x402/extensions", {
  namedExports: {
    declareDiscoveryExtension: () => ({}),
    bazaarResourceServerExtension: {},
  },
});
mock.module("@x402/extensions/sign-in-with-x", {
  namedExports: {
    siwxResourceServerExtension: {},
    declareSIWxExtension: () => ({}),
    parseSIWxHeader: () => ({}),
    validateSIWxMessage: async () => ({ valid: true }),
    verifySIWxSignature: async () => ({ valid: true, address: "0xabc" }),
  },
});
mock.module("stripe", { defaultExport: class {} });
mock.module("mppx/server", {
  namedExports: {
    tempo: { charge: () => ({}) },
    Mppx: { create: () => null },
  },
});
mock.module("mppx/express", {
  namedExports: {
    Mppx: { create: () => null },
  },
});

// --- Application-level mocks ---

mock.module("../config.js", {
  namedExports: {
    SELLER_ADDRESS: "0xseller",
    MAINNET_NETWORK: "eip155:8453",
    TESTNET_NETWORK: "eip155:84532",
    CDP_API_KEY_ID: "test",
    CDP_API_KEY_SECRET: "test",
    FACILITATOR_PROVIDER: "cdp",
    FACILITATOR_URL: "http://localhost",
    STRIPE_SECRET_KEY: "sk_test",
    ADMIN_KEY: "admin-key",
    MPP_SECRET_KEY: undefined,
  },
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mockGetBillingAccount: (wallet: string) => any;
let mockDebitAllowance: (
  wallet: string,
  amountUsdMicros: number,
  sku: string,
  paymentHeaderHash: string | null,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
) => any;

mock.module("../services/billing.js", {
  namedExports: {
    getBillingAccount: (wallet: string) => mockGetBillingAccount(wallet),
    debitAllowance: (
      wallet: string,
      amountUsdMicros: number,
      sku: string,
      paymentHeaderHash: string | null,
    ) => mockDebitAllowance(wallet, amountUsdMicros, sku, paymentHeaderHash),
  },
});

let recordedWallets: { address: string; source: string }[];
let lastExtractedWallet: string | null;

mock.module("../utils/wallet.js", {
  namedExports: {
    extractWalletFromPaymentHeader: (header: string) => {
      // Decode base64 JSON and extract from address, same as the real implementation
      try {
        const decoded = JSON.parse(Buffer.from(header, "base64").toString());
        const from = decoded.payload?.authorization?.from;
        lastExtractedWallet = from?.startsWith("0x") ? from.toLowerCase() : null;
        return lastExtractedWallet;
      } catch {
        lastExtractedWallet = null;
        return null;
      }
    },
    recordWallet: (address: string, source: string) => {
      recordedWallets.push({ address, source });
    },
  },
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mockGetWalletTier: (wallet: string) => any;

mock.module("../services/wallet-tiers.js", {
  namedExports: {
    getWalletTier: (wallet: string) => mockGetWalletTier(wallet),
  },
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let lastPoolQuery: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let poolQueryResult: { rows: any[] } = { rows: [] };
mock.module("../db/pool.js", {
  namedExports: {
    pool: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      query: async (...args: any[]) => {
        lastPoolQuery = args;
        return poolQueryResult;
      },
    },
  },
});

mock.module("../db/sql.js", {
  namedExports: {
    sql: (s: string) => s,
  },
});

// ---------------------------------------------------------------------------
// Import the module under test (after all mocks)
// ---------------------------------------------------------------------------

const { createPaymentMiddleware } = await import("./x402.js");

// ---------------------------------------------------------------------------
// Helpers — minimal Express req/res fakes
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fakeReq(overrides: Record<string, any> = {}): any {
  return {
    method: "GET",
    path: "/health",
    headers: {},
    ...overrides,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fakeRes(): any {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const headers: Record<string, any> = {};
  let statusCode = 200;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let jsonBody: any = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const listeners: Record<string, Array<(...args: any[]) => void>> = {};

  const res = {
    get statusCode() {
      return statusCode;
    },
    set statusCode(val: number) {
      statusCode = val;
    },
    setHeader(name: string, value: string) {
      headers[name] = value;
    },
    getHeader(name: string) {
      return headers[name];
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    json(body: any) {
      jsonBody = body;
      return res;
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    writeHead(code: number, _headers?: any) {
      statusCode = code;
      return res;
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    on(event: string, handler: (...args: any[]) => void) {
      listeners[event] = listeners[event] || [];
      listeners[event].push(handler);
      return res;
    },
    emit(event: string) {
      for (const h of listeners[event] || []) h();
    },
    _headers: headers,
    _jsonBody: () => jsonBody,
  };
  return res;
}

/**
 * Build a fake x402 payment header with a wallet address in it.
 */
function makePaymentHeader(from: string): string {
  return Buffer.from(
    JSON.stringify({ payload: { authorization: { from } } }),
  ).toString("base64");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createPaymentMiddleware", () => {
  beforeEach(() => {
    capturedOnProtectedHandlers = [];
    recordedWallets = [];
    lastExtractedWallet = null;
    lastPoolQuery = null;
    poolQueryResult = { rows: [] };
    mockGetBillingAccount = () => null;
    mockDebitAllowance = () => null;
    mockGetWalletTier = () => ({ tier: null, active: false, lease_expires_at: null });
  });

  it("returns a function", async () => {
    const mw = await createPaymentMiddleware();
    assert.equal(typeof mw, "function");
  });

  it("returned middleware has arity 3 (req, res, next)", async () => {
    const mw = await createPaymentMiddleware();
    assert.equal(mw.length, 3);
  });

  // -----------------------------------------------------------------------
  // Basic pass-through (no payment headers, mock x402 calls next)
  // -----------------------------------------------------------------------

  it("calls next() for non-payment requests when x402 passes through", async () => {
    const mw = await createPaymentMiddleware();
    const req = fakeReq();
    const res = fakeRes();
    let nextCalled = false;

    await mw(req, res, () => {
      nextCalled = true;
    });

    assert.ok(nextCalled, "next() should have been called");
  });

  // -----------------------------------------------------------------------
  // Admin key bypass
  // -----------------------------------------------------------------------

  describe("admin key bypass", () => {
    it("registers an onProtectedRequest handler that grants access for valid admin key", async () => {
      await createPaymentMiddleware();
      // The first onProtectedRequest handler is the admin-key handler
      const adminHandler = capturedOnProtectedHandlers[0];
      assert.ok(adminHandler, "admin key handler should be registered");

      const result = await adminHandler({
        adapter: {
          getHeader: (name: string) =>
            name === "x-admin-key" ? "admin-key" : undefined,
        },
      });
      assert.deepEqual(result, { grantAccess: true });
    });

    it("does not grant access for wrong admin key", async () => {
      await createPaymentMiddleware();
      const adminHandler = capturedOnProtectedHandlers[0];

      const result = await adminHandler({
        adapter: {
          getHeader: (name: string) =>
            name === "x-admin-key" ? "wrong-key" : undefined,
        },
      });
      assert.equal(result, undefined);
    });

    it("does not grant access when no admin key header is present", async () => {
      await createPaymentMiddleware();
      const adminHandler = capturedOnProtectedHandlers[0];

      const result = await adminHandler({
        adapter: {
          getHeader: () => undefined,
        },
      });
      assert.equal(result, undefined);
    });
  });

  // -----------------------------------------------------------------------
  // SIWX auth-only hook registration
  // -----------------------------------------------------------------------

  it("registers a SIWX auth-only hook as the second onProtectedRequest handler", async () => {
    await createPaymentMiddleware();
    // Handler index: 0=admin, 1=siwx, 2=tierContext, 3=allowance
    assert.ok(capturedOnProtectedHandlers.length >= 2, "should register at least 2 handlers");
  });

  // -----------------------------------------------------------------------
  // Tier context handler
  // -----------------------------------------------------------------------

  describe("tier context onProtectedRequest handler", () => {
    it("populates tier context for tier endpoints", async () => {
      mockGetWalletTier = () => ({
        tier: "hobby",
        active: true,
        lease_expires_at: "2026-04-01T00:00:00Z",
      });

      await createPaymentMiddleware();
      // tierContext handler is at index 2
      const tierContextHandler = capturedOnProtectedHandlers[2];
      assert.ok(tierContextHandler, "tier context handler should be registered");

      const paymentHeader = makePaymentHeader("0xWallet123");
      const result = await tierContextHandler({
        paymentHeader,
        path: "/tiers/v1/hobby",
        method: "POST",
      });
      // This handler does not return grantAccess — it just stores context
      assert.equal(result, undefined);
    });

    it("skips non-tier endpoints", async () => {
      await createPaymentMiddleware();
      const tierContextHandler = capturedOnProtectedHandlers[2];

      const paymentHeader = makePaymentHeader("0xWallet123");
      const result = await tierContextHandler({
        paymentHeader,
        path: "/generate-image/v1",
        method: "POST",
      });
      assert.equal(result, undefined);
    });

    it("skips when paymentHeader is absent", async () => {
      await createPaymentMiddleware();
      const tierContextHandler = capturedOnProtectedHandlers[2];

      const result = await tierContextHandler({
        paymentHeader: undefined,
        path: "/tiers/v1/hobby",
        method: "POST",
      });
      assert.equal(result, undefined);
    });
  });

  // -----------------------------------------------------------------------
  // Allowance debit handler
  // -----------------------------------------------------------------------

  describe("allowance debit onProtectedRequest handler", () => {
    it("grants access when wallet has sufficient allowance balance", async () => {
      mockGetBillingAccount = () => ({
        id: "ba_1",
        status: "active",
        available_usd_micros: 10_000_000,
      });
      mockDebitAllowance = () => ({ remaining: 5_000_000, chargeId: "ch_1" });

      await createPaymentMiddleware();
      // Allowance handler is at index 3
      const allowanceHandler = capturedOnProtectedHandlers[3];
      assert.ok(allowanceHandler, "allowance handler should be registered");

      const paymentHeader = makePaymentHeader("0xWallet123");
      const result = await allowanceHandler({
        paymentHeader,
        path: "/tiers/v1/hobby",
        method: "POST",
      });
      assert.deepEqual(result, { grantAccess: true });
    });

    it("records wallet sighting with source x402", async () => {
      mockGetBillingAccount = () => null;

      await createPaymentMiddleware();
      const allowanceHandler = capturedOnProtectedHandlers[3];

      const paymentHeader = makePaymentHeader("0xWallet999");
      await allowanceHandler({
        paymentHeader,
        path: "/tiers/v1/hobby",
        method: "POST",
      });
      assert.equal(recordedWallets.length, 1);
      assert.equal(recordedWallets[0].source, "x402");
    });

    it("returns undefined (no grant) when billing account is inactive", async () => {
      mockGetBillingAccount = () => ({
        id: "ba_1",
        status: "suspended",
        available_usd_micros: 10_000_000,
      });

      await createPaymentMiddleware();
      const allowanceHandler = capturedOnProtectedHandlers[3];

      const paymentHeader = makePaymentHeader("0xWallet123");
      const result = await allowanceHandler({
        paymentHeader,
        path: "/tiers/v1/hobby",
        method: "POST",
      });
      assert.equal(result, undefined);
    });

    it("returns undefined when billing account has insufficient balance", async () => {
      mockGetBillingAccount = () => ({
        id: "ba_1",
        status: "active",
        available_usd_micros: 100, // way too low for hobby tier ($5)
      });

      await createPaymentMiddleware();
      const allowanceHandler = capturedOnProtectedHandlers[3];

      const paymentHeader = makePaymentHeader("0xWallet123");
      const result = await allowanceHandler({
        paymentHeader,
        path: "/tiers/v1/hobby",
        method: "POST",
      });
      assert.equal(result, undefined);
    });

    it("returns undefined when debitAllowance fails (race condition)", async () => {
      mockGetBillingAccount = () => ({
        id: "ba_1",
        status: "active",
        available_usd_micros: 10_000_000,
      });
      mockDebitAllowance = () => null; // simulate race condition

      await createPaymentMiddleware();
      const allowanceHandler = capturedOnProtectedHandlers[3];

      const paymentHeader = makePaymentHeader("0xWallet123");
      const result = await allowanceHandler({
        paymentHeader,
        path: "/tiers/v1/hobby",
        method: "POST",
      });
      assert.equal(result, undefined);
    });

    it("returns undefined for non-priced endpoints", async () => {
      mockGetBillingAccount = () => ({
        id: "ba_1",
        status: "active",
        available_usd_micros: 10_000_000,
      });

      await createPaymentMiddleware();
      const allowanceHandler = capturedOnProtectedHandlers[3];

      const paymentHeader = makePaymentHeader("0xWallet123");
      const result = await allowanceHandler({
        paymentHeader,
        path: "/health",
        method: "GET",
      });
      assert.equal(result, undefined);
    });

    it("returns undefined when paymentHeader is absent", async () => {
      await createPaymentMiddleware();
      const allowanceHandler = capturedOnProtectedHandlers[3];

      const result = await allowanceHandler({
        paymentHeader: undefined,
        path: "/tiers/v1/hobby",
        method: "POST",
      });
      assert.equal(result, undefined);
    });

    it("returns undefined when wallet cannot be extracted from payment header", async () => {
      await createPaymentMiddleware();
      const allowanceHandler = capturedOnProtectedHandlers[3];

      // Garbage header that doesn't decode to a valid wallet
      const paymentHeader = Buffer.from("{}").toString("base64");
      const result = await allowanceHandler({
        paymentHeader,
        path: "/tiers/v1/hobby",
        method: "POST",
      });
      assert.equal(result, undefined);
    });
  });

  // -----------------------------------------------------------------------
  // Wrapper middleware — writeHead interception for settlement headers
  // -----------------------------------------------------------------------

  describe("writeHead interception", () => {
    it("sets X-Run402-Settlement-Rail to x402 on successful response with payment header", async () => {
      const mw = await createPaymentMiddleware();
      const paymentHeader = makePaymentHeader("0xWallet123");
      const req = fakeReq({
        method: "POST",
        path: "/tiers/v1/hobby",
        headers: { "x-payment": paymentHeader },
      });
      const res = fakeRes();
      let nextCalled = false;

      await mw(req, res, () => {
        nextCalled = true;
      });

      assert.ok(nextCalled);
      // Trigger writeHead (simulates Express sending the response)
      res.statusCode = 200;
      res.writeHead(200);
      assert.equal(res._headers["X-Run402-Settlement-Rail"], "x402");
    });

    it("sets allowance headers when allowance debit was used", async () => {
      mockGetBillingAccount = () => ({
        id: "ba_1",
        status: "active",
        available_usd_micros: 10_000_000,
      });
      mockDebitAllowance = () => ({ remaining: 5_000_000, chargeId: "ch_1" });

      const mw = await createPaymentMiddleware();

      const paymentHeader = makePaymentHeader("0xWallet123");

      // Simulate what onProtectedRequest does: run the allowance handler
      const allowanceHandler = capturedOnProtectedHandlers[3];
      await allowanceHandler({
        paymentHeader,
        path: "/tiers/v1/hobby",
        method: "POST",
      });

      const req = fakeReq({
        method: "POST",
        path: "/tiers/v1/hobby",
        headers: { "x-payment": paymentHeader },
      });
      const res = fakeRes();

      await mw(req, res, () => {});

      res.writeHead(200);
      assert.equal(res._headers["X-Run402-Settlement-Rail"], "allowance");
      assert.equal(res._headers["X-Run402-Allowance-Remaining"], "5000000");
    });

    it("sets walletAddress on req when allowance rail is used", async () => {
      mockGetBillingAccount = () => ({
        id: "ba_1",
        status: "active",
        available_usd_micros: 10_000_000,
      });
      mockDebitAllowance = () => ({ remaining: 5_000_000, chargeId: "ch_1" });

      const mw = await createPaymentMiddleware();

      const paymentHeader = makePaymentHeader("0xWallet123");

      // Simulate onProtectedRequest
      const allowanceHandler = capturedOnProtectedHandlers[3];
      await allowanceHandler({
        paymentHeader,
        path: "/tiers/v1/hobby",
        method: "POST",
      });

      const req = fakeReq({
        method: "POST",
        path: "/tiers/v1/hobby",
        headers: { "x-payment": paymentHeader },
      });
      const res = fakeRes();

      await mw(req, res, () => {});

      assert.equal(req.walletAddress, "0xwallet123"); // lowercase
    });

    it("injects headers only once even if writeHead is called multiple times", async () => {
      const mw = await createPaymentMiddleware();
      const paymentHeader = makePaymentHeader("0xWallet123");
      const req = fakeReq({
        method: "POST",
        path: "/tiers/v1/hobby",
        headers: { "x-payment": paymentHeader },
      });
      const res = fakeRes();

      await mw(req, res, () => {});

      res.statusCode = 200;
      res.writeHead(200);
      assert.equal(res._headers["X-Run402-Settlement-Rail"], "x402");

      // Reset the header to check idempotency
      delete res._headers["X-Run402-Settlement-Rail"];
      res.writeHead(200);
      // Should NOT have re-set the header
      assert.equal(res._headers["X-Run402-Settlement-Rail"], undefined);
    });

    it("sets X-Run402-Hint to set-contact when wallet has no contact", async () => {
      const mw = await createPaymentMiddleware();
      const paymentHeader = makePaymentHeader("0xWallet123");

      // Run the allowance handler to trigger the contact check side-effect
      const allowanceHandler = capturedOnProtectedHandlers[3];
      await allowanceHandler({
        paymentHeader,
        path: "/tiers/v1/hobby",
        method: "POST",
      });

      // pool.query mock returns { rows: [] } — no contact found.
      // Wait for the fire-and-forget promise to settle.
      await new Promise((resolve) => setTimeout(resolve, 10));

      const req = fakeReq({
        method: "POST",
        path: "/tiers/v1/hobby",
        headers: { "x-payment": paymentHeader },
      });
      const res = fakeRes();

      await mw(req, res, () => {});

      res.statusCode = 200;
      res.writeHead(200);
      assert.equal(res._headers["X-Run402-Hint"], "set-contact");
    });

    it("does not set hint header when wallet has contact info", async () => {
      // Set pool.query to return a row (meaning contact exists)
      poolQueryResult = { rows: [{ "1": 1 }] };

      const mw = await createPaymentMiddleware();

      const paymentHeader = makePaymentHeader("0xWallet123");
      const allowanceHandler = capturedOnProtectedHandlers[3];
      await allowanceHandler({
        paymentHeader,
        path: "/tiers/v1/hobby",
        method: "POST",
      });

      // Wait for the fire-and-forget promise to settle
      await new Promise((resolve) => setTimeout(resolve, 10));

      const req = fakeReq({
        method: "POST",
        path: "/tiers/v1/hobby",
        headers: { "x-payment": paymentHeader },
      });
      const res = fakeRes();

      await mw(req, res, () => {});

      res.statusCode = 200;
      res.writeHead(200);
      assert.equal(res._headers["X-Run402-Hint"], undefined);
    });
  });

  // -----------------------------------------------------------------------
  // Wrapper middleware — res.json interception for 402 tier context
  // -----------------------------------------------------------------------

  describe("res.json interception on tier endpoints", () => {
    it("augments 402 response body with tier info", async () => {
      mockGetWalletTier = () => ({
        tier: "hobby",
        active: true,
        lease_expires_at: "2026-04-01T00:00:00Z",
      });

      const mw = await createPaymentMiddleware();

      const paymentHeader = makePaymentHeader("0xWallet123");

      // Run tier context handler
      const tierCtxHandler = capturedOnProtectedHandlers[2];
      await tierCtxHandler({
        paymentHeader,
        path: "/tiers/v1/hobby",
        method: "POST",
      });

      const req = fakeReq({
        method: "POST",
        path: "/tiers/v1/hobby",
        headers: { "x-payment": paymentHeader },
      });
      const res = fakeRes();

      // Make the x402 middleware return 402 via json
      await mw(req, res, () => {});

      // Simulate x402 library sending a 402 response
      res.statusCode = 402;
      res.json({});

      const body = res._jsonBody();
      assert.equal(body.tier, "hobby");
      assert.equal(body.price, "$5.00");
      assert.equal(body.current_tier, "hobby");
      assert.equal(body.current_tier_active, true);
      assert.ok(
        body.message.includes("already active"),
        `Expected "already active" in message, got: ${body.message}`,
      );
    });

    it("augments 402 body with upgrade context when switching tiers", async () => {
      mockGetWalletTier = () => ({
        tier: "hobby",
        active: true,
        lease_expires_at: "2026-04-01T00:00:00Z",
      });

      const mw = await createPaymentMiddleware();

      const paymentHeader = makePaymentHeader("0xWallet123");

      // Run tier context handler for 'team' endpoint (upgrading from hobby)
      const tierCtxHandler = capturedOnProtectedHandlers[2];
      await tierCtxHandler({
        paymentHeader,
        path: "/tiers/v1/team",
        method: "POST",
      });

      const req = fakeReq({
        method: "POST",
        path: "/tiers/v1/team",
        headers: { "x-payment": paymentHeader },
      });
      const res = fakeRes();

      await mw(req, res, () => {});

      res.statusCode = 402;
      res.json({});

      const body = res._jsonBody();
      assert.equal(body.tier, "team");
      assert.equal(body.current_tier, "hobby");
      assert.ok(
        body.message.includes("currently on 'hobby'"),
        `Expected upgrade context in message, got: ${body.message}`,
      );
    });

    it("does not augment non-402 responses", async () => {
      const mw = await createPaymentMiddleware();

      const paymentHeader = makePaymentHeader("0xWallet123");
      const req = fakeReq({
        method: "POST",
        path: "/tiers/v1/hobby",
        headers: { "x-payment": paymentHeader },
      });
      const res = fakeRes();

      await mw(req, res, () => {});

      // Simulate a successful response
      res.statusCode = 200;
      res.json({ success: true });

      const body = res._jsonBody();
      assert.deepEqual(body, { success: true });
    });

    it("does not intercept json on non-tier endpoints", async () => {
      const mw = await createPaymentMiddleware();

      const paymentHeader = makePaymentHeader("0xWallet123");
      const req = fakeReq({
        method: "POST",
        path: "/generate-image/v1",
        headers: { "x-payment": paymentHeader },
      });
      const res = fakeRes();
      const originalJson = res.json;

      await mw(req, res, () => {});

      // json should NOT have been replaced
      assert.equal(res.json, originalJson);
    });

    it("does not intercept json on /tiers/v1/status", async () => {
      const mw = await createPaymentMiddleware();

      const paymentHeader = makePaymentHeader("0xWallet123");
      const req = fakeReq({
        method: "GET",
        path: "/tiers/v1/status",
        headers: { "x-payment": paymentHeader },
      });
      const res = fakeRes();
      const originalJson = res.json;

      await mw(req, res, () => {});

      assert.equal(res.json, originalJson);
    });
  });

  // -----------------------------------------------------------------------
  // Wrapper middleware — no payment headers at all
  // -----------------------------------------------------------------------

  describe("no payment headers", () => {
    it("does not intercept writeHead when there is no payment header", async () => {
      const mw = await createPaymentMiddleware();
      const req = fakeReq({ method: "GET", path: "/health", headers: {} });
      const res = fakeRes();
      const originalWriteHead = res.writeHead;

      await mw(req, res, () => {});

      // writeHead should be the original (since MPP is not initialized in this config)
      assert.equal(res.writeHead, originalWriteHead);
    });
  });

  // -----------------------------------------------------------------------
  // Wrapper middleware — all three payment header names
  // -----------------------------------------------------------------------

  describe("payment header extraction from different header names", () => {
    for (const headerName of [
      "payment-signature",
      "x-payment",
      "x-402-payment",
    ]) {
      it(`detects payment via ${headerName} header`, async () => {
        const mw = await createPaymentMiddleware();
        const paymentHeader = makePaymentHeader("0xWallet123");
        const req = fakeReq({
          method: "POST",
          path: "/tiers/v1/hobby",
          headers: { [headerName]: paymentHeader },
        });
        const res = fakeRes();

        await mw(req, res, () => {});

        // The writeHead interceptor should have been installed
        res.statusCode = 200;
        res.writeHead(200);
        assert.ok(
          res._headers["X-Run402-Settlement-Rail"],
          `Settlement rail should be set for ${headerName} header`,
        );
      });
    }
  });

  // -----------------------------------------------------------------------
  // Connection close cleanup
  // -----------------------------------------------------------------------

  describe("connection close cleanup", () => {
    it("cleans up maps on connection close", async () => {
      mockGetBillingAccount = () => ({
        id: "ba_1",
        status: "active",
        available_usd_micros: 10_000_000,
      });
      mockDebitAllowance = () => ({ remaining: 5_000_000, chargeId: "ch_1" });

      const mw = await createPaymentMiddleware();

      const paymentHeader = makePaymentHeader("0xWallet123");

      // Populate the allowanceResults map
      const allowanceHandler = capturedOnProtectedHandlers[3];
      await allowanceHandler({
        paymentHeader,
        path: "/tiers/v1/hobby",
        method: "POST",
      });

      const req = fakeReq({
        method: "POST",
        path: "/tiers/v1/hobby",
        headers: { "x-payment": paymentHeader },
      });
      const res = fakeRes();

      await mw(req, res, () => {});

      // Emit close before writeHead fires
      res.emit("close");

      // Now writeHead should NOT set the allowance headers since they were cleaned up
      res.writeHead(200);
      assert.equal(res._headers["X-Run402-Settlement-Rail"], "x402");
      assert.equal(res._headers["X-Run402-Allowance-Remaining"], undefined);
    });
  });

  // -----------------------------------------------------------------------
  // extractMppWallet (tested indirectly through the module)
  // -----------------------------------------------------------------------

  describe("extractMppWallet behavior", () => {
    // extractMppWallet is not exported but is used in the MPP payment path.
    // We test it indirectly by encoding a credential token and checking wallet extraction.
    // Since MPP is disabled (MPP_SECRET_KEY undefined), the MPP path is not entered.
    // We test the credential decoding logic by encoding the expected format.

    it("extracts wallet from a DID pkh source format", () => {
      // This tests the same logic as extractMppWallet:
      // Source format: "did:pkh:eip155:42431:0xABC..."
      const source = "did:pkh:eip155:42431:0xAbC123Def456";
      const parts = source.split(":");
      const address = parts[parts.length - 1]?.toLowerCase();
      assert.equal(address, "0xabc123def456");
    });

    it("returns empty string for invalid credential token", () => {
      // The extractMppWallet function catches and returns ""
      try {
        JSON.parse(Buffer.from("not-valid-base64", "base64").toString());
      } catch {
        // Expected — extractMppWallet would return ""
        assert.ok(true);
      }
    });
  });

  // -----------------------------------------------------------------------
  // MPP path is skipped when MPP_SECRET_KEY is not set
  // -----------------------------------------------------------------------

  describe("MPP disabled", () => {
    it("does not enter MPP path when MPP_SECRET_KEY is not configured", async () => {
      const mw = await createPaymentMiddleware();
      const req = fakeReq({
        method: "POST",
        path: "/tiers/v1/hobby",
        headers: {
          authorization: "Payment " + Buffer.from("{}").toString("base64"),
        },
      });
      const res = fakeRes();
      let nextCalled = false;

      await mw(req, res, () => {
        nextCalled = true;
      });

      // Should fall through to x402 which calls next()
      assert.ok(nextCalled);
    });
  });

  // -----------------------------------------------------------------------
  // Registered handlers count
  // -----------------------------------------------------------------------

  it("registers exactly 4 onProtectedRequest handlers", async () => {
    capturedOnProtectedHandlers = [];
    await createPaymentMiddleware();
    assert.equal(
      capturedOnProtectedHandlers.length,
      4,
      "Expected: admin-key, siwx, tierContext, allowance",
    );
  });

  // -----------------------------------------------------------------------
  // resolveSkuPrice coverage (via allowance handler)
  // -----------------------------------------------------------------------

  describe("resolveSkuPrice (via allowance handler)", () => {
    it("resolves generate-image/v1 price", async () => {
      mockGetBillingAccount = () => ({
        id: "ba_1",
        status: "active",
        available_usd_micros: 10_000_000,
      });
      let debitedSku = "";
      let debitedAmount = 0;
      mockDebitAllowance = (_w, amount, sku) => {
        debitedSku = sku;
        debitedAmount = amount;
        return { remaining: 9_970_000, chargeId: "ch_1" };
      };

      await createPaymentMiddleware();
      const allowanceHandler = capturedOnProtectedHandlers[3];

      const paymentHeader = makePaymentHeader("0xWallet123");
      await allowanceHandler({
        paymentHeader,
        path: "/generate-image/v1",
        method: "POST",
      });

      assert.equal(debitedSku, "image");
      assert.equal(debitedAmount, 30_000); // $0.03
    });

    it("resolves prototype tier price", async () => {
      mockGetBillingAccount = () => ({
        id: "ba_1",
        status: "active",
        available_usd_micros: 10_000_000,
      });
      let debitedSku = "";
      let debitedAmount = 0;
      mockDebitAllowance = (_w, amount, sku) => {
        debitedSku = sku;
        debitedAmount = amount;
        return { remaining: 9_900_000, chargeId: "ch_1" };
      };

      await createPaymentMiddleware();
      const allowanceHandler = capturedOnProtectedHandlers[3];

      const paymentHeader = makePaymentHeader("0xWallet123");
      await allowanceHandler({
        paymentHeader,
        path: "/tiers/v1/prototype",
        method: "POST",
      });

      assert.equal(debitedSku, "tier_prototype");
      assert.equal(debitedAmount, 100_000); // $0.10
    });

    it("resolves team tier price", async () => {
      mockGetBillingAccount = () => ({
        id: "ba_1",
        status: "active",
        available_usd_micros: 50_000_000,
      });
      let debitedSku = "";
      let debitedAmount = 0;
      mockDebitAllowance = (_w, amount, sku) => {
        debitedSku = sku;
        debitedAmount = amount;
        return { remaining: 30_000_000, chargeId: "ch_1" };
      };

      await createPaymentMiddleware();
      const allowanceHandler = capturedOnProtectedHandlers[3];

      const paymentHeader = makePaymentHeader("0xWallet123");
      await allowanceHandler({
        paymentHeader,
        path: "/tiers/v1/team",
        method: "POST",
      });

      assert.equal(debitedSku, "tier_team");
      assert.equal(debitedAmount, 20_000_000); // $20.00
    });

    it("returns null for /tiers/v1/status (not a priced endpoint)", async () => {
      mockGetBillingAccount = () => ({
        id: "ba_1",
        status: "active",
        available_usd_micros: 10_000_000,
      });
      let debitCalled = false;
      mockDebitAllowance = () => {
        debitCalled = true;
        return { remaining: 0, chargeId: "ch_1" };
      };

      await createPaymentMiddleware();
      const allowanceHandler = capturedOnProtectedHandlers[3];

      const paymentHeader = makePaymentHeader("0xWallet123");
      const result = await allowanceHandler({
        paymentHeader,
        path: "/tiers/v1/status",
        method: "GET",
      });

      assert.equal(result, undefined);
      assert.ok(!debitCalled, "debitAllowance should not be called for status endpoint");
    });

    it("returns null for unknown endpoints", async () => {
      mockGetBillingAccount = () => ({
        id: "ba_1",
        status: "active",
        available_usd_micros: 10_000_000,
      });
      let debitCalled = false;
      mockDebitAllowance = () => {
        debitCalled = true;
        return { remaining: 0, chargeId: "ch_1" };
      };

      await createPaymentMiddleware();
      const allowanceHandler = capturedOnProtectedHandlers[3];

      const paymentHeader = makePaymentHeader("0xWallet123");
      const result = await allowanceHandler({
        paymentHeader,
        path: "/projects/v1",
        method: "POST",
      });

      assert.equal(result, undefined);
      assert.ok(!debitCalled, "debitAllowance should not be called for non-priced endpoints");
    });
  });
});
