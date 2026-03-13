import { describe, it, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";

// ---------------------------------------------------------------------------
// Mock DB pool before importing the module under test
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mockPoolQuery: (...args: any[]) => Promise<any>;

mock.module("../db/pool.js", {
  namedExports: {
    pool: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      query: (...args: any[]) => mockPoolQuery(...args),
    },
  },
});

// Wallet util — we need to mock extractWalletFromPaymentHeader + recordWallet
let mockExtractWallet: (header: string) => string | null;
let recordedWallets: { address: string; source: string }[];

mock.module("../utils/wallet.js", {
  namedExports: {
    extractWalletFromPaymentHeader: (h: string) => mockExtractWallet(h),
    recordWallet: (address: string, source: string) => {
      recordedWallets.push({ address, source });
    },
  },
});

// Import after mocks are set up
const { default: router } = await import("./contact.js");

// ---------------------------------------------------------------------------
// Fake Express req/res helpers
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fakeReq(overrides: Record<string, any> = {}) {
  const headers: Record<string, string> = {};
  return {
    method: "PUT",
    headers,
    header(name: string) {
      return headers[name.toLowerCase()];
    },
    body: {},
    ...overrides,
    // Allow setting headers after construction
    _setHeader(k: string, v: string) {
      headers[k.toLowerCase()] = v;
    },
  };
}

function fakeRes() {
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
// Route handler extraction: find PUT and GET handlers from the router
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function findHandler(method: string, path: string): any {
  // Express Router stores routes in router.stack
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const layer of (router as any).stack) {
    if (
      layer.route &&
      layer.route.path === path &&
      layer.route.methods[method.toLowerCase()]
    ) {
      // Return the last handler (after any middleware)
      return layer.route.stack[layer.route.stack.length - 1].handle;
    }
  }
  throw new Error(`No handler found for ${method} ${path}`);
}

const putHandler = findHandler("PUT", "/v1/agent/contact");
const getHandler = findHandler("GET", "/v1/agent/contact");

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GET /v1/agent/contact", () => {
  it("returns endpoint description", () => {
    const req = fakeReq();
    const res = fakeRes();
    getHandler(req, res);
    assert.equal(res._body.method, "PUT");
    assert.ok(res._body.description.includes("contact"));
    assert.ok(res._body.body.name);
  });
});

describe("PUT /v1/agent/contact", () => {
  beforeEach(() => {
    recordedWallets = [];
    mockExtractWallet = () => "0xabc123";
    mockPoolQuery = async () => ({
      rows: [{
        wallet_address: "0xabc123",
        name: "my-agent",
        email: "ops@example.com",
        webhook: "https://example.com/hook",
        updated_at: "2026-03-12T00:00:00Z",
      }],
    });
  });

  it("returns 401 when no payment header", async () => {
    const req = fakeReq({ body: { name: "my-agent" } });
    const res = fakeRes();
    let nextErr: Error | undefined;
    await putHandler(req, res, (err?: Error) => { nextErr = err; });
    assert.ok(nextErr);
    assert.equal((nextErr as any).statusCode, 401);
    assert.ok(nextErr.message.includes("payment header"));
  });

  it("returns 401 when wallet extraction fails", async () => {
    mockExtractWallet = () => null;
    const req = fakeReq({ body: { name: "my-agent" } });
    req._setHeader("x-402-payment", "badheader");
    const res = fakeRes();
    let nextErr: Error | undefined;
    await putHandler(req, res, (err?: Error) => { nextErr = err; });
    assert.ok(nextErr);
    assert.equal((nextErr as any).statusCode, 401);
  });

  it("returns 400 when name is missing", async () => {
    const req = fakeReq({ body: {} });
    req._setHeader("x-402-payment", "validheader");
    const res = fakeRes();
    let nextErr: Error | undefined;
    await putHandler(req, res, (err?: Error) => { nextErr = err; });
    assert.ok(nextErr);
    assert.equal((nextErr as any).statusCode, 400);
    assert.ok(nextErr.message.includes("name"));
  });

  it("returns 400 when name is empty string", async () => {
    const req = fakeReq({ body: { name: "   " } });
    req._setHeader("x-402-payment", "validheader");
    const res = fakeRes();
    let nextErr: Error | undefined;
    await putHandler(req, res, (err?: Error) => { nextErr = err; });
    assert.ok(nextErr);
    assert.equal((nextErr as any).statusCode, 400);
  });

  it("returns 400 when name is not a string", async () => {
    const req = fakeReq({ body: { name: 42 } });
    req._setHeader("x-402-payment", "validheader");
    const res = fakeRes();
    let nextErr: Error | undefined;
    await putHandler(req, res, (err?: Error) => { nextErr = err; });
    assert.ok(nextErr);
    assert.equal((nextErr as any).statusCode, 400);
  });

  it("returns 400 when email is invalid", async () => {
    const req = fakeReq({ body: { name: "my-agent", email: "not-an-email" } });
    req._setHeader("x-402-payment", "validheader");
    const res = fakeRes();
    let nextErr: Error | undefined;
    await putHandler(req, res, (err?: Error) => { nextErr = err; });
    assert.ok(nextErr);
    assert.equal((nextErr as any).statusCode, 400);
    assert.ok(nextErr.message.includes("email"));
  });

  it("returns 400 when webhook is not https", async () => {
    const req = fakeReq({ body: { name: "my-agent", webhook: "http://insecure.com/hook" } });
    req._setHeader("x-402-payment", "validheader");
    const res = fakeRes();
    let nextErr: Error | undefined;
    await putHandler(req, res, (err?: Error) => { nextErr = err; });
    assert.ok(nextErr);
    assert.equal((nextErr as any).statusCode, 400);
    assert.ok(nextErr.message.includes("webhook"));
  });

  it("accepts valid request with all fields", async () => {
    const req = fakeReq({
      body: { name: "my-agent", email: "ops@example.com", webhook: "https://example.com/hook" },
    });
    req._setHeader("x-402-payment", "validheader");
    const res = fakeRes();
    await putHandler(req, res, () => {});
    assert.equal(res._body.wallet, "0xabc123");
    assert.equal(res._body.name, "my-agent");
    assert.equal(res._body.email, "ops@example.com");
    assert.equal(res._body.webhook, "https://example.com/hook");
    assert.ok(res._body.updated_at);
  });

  it("accepts valid request with name only", async () => {
    mockPoolQuery = async () => ({
      rows: [{
        wallet_address: "0xabc123",
        name: "minimal-agent",
        email: null,
        webhook: null,
        updated_at: "2026-03-12T00:00:00Z",
      }],
    });
    const req = fakeReq({ body: { name: "minimal-agent" } });
    req._setHeader("x-402-payment", "validheader");
    const res = fakeRes();
    await putHandler(req, res, () => {});
    assert.equal(res._body.name, "minimal-agent");
    assert.equal(res._body.email, null);
    assert.equal(res._body.webhook, null);
  });

  it("records wallet sighting with source 'contact'", async () => {
    const req = fakeReq({ body: { name: "my-agent" } });
    req._setHeader("x-402-payment", "validheader");
    const res = fakeRes();
    await putHandler(req, res, () => {});
    assert.equal(recordedWallets.length, 1);
    assert.equal(recordedWallets[0].address, "0xabc123");
    assert.equal(recordedWallets[0].source, "contact");
  });

  it("passes correct values to pool.query upsert", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let capturedParams: any[];
    mockPoolQuery = async (_sql: string, params: any[]) => {
      capturedParams = params;
      return {
        rows: [{
          wallet_address: params[0],
          name: params[1],
          email: params[2],
          webhook: params[3],
          updated_at: "2026-03-12T00:00:00Z",
        }],
      };
    };

    const req = fakeReq({
      body: { name: "  padded-name  ", email: "a@b.com", webhook: "https://x.com/h" },
    });
    req._setHeader("x-402-payment", "validheader");
    const res = fakeRes();
    await putHandler(req, res, () => {});
    assert.equal(capturedParams![0], "0xabc123");       // wallet
    assert.equal(capturedParams![1], "padded-name");    // trimmed name
    assert.equal(capturedParams![2], "a@b.com");        // email
    assert.equal(capturedParams![3], "https://x.com/h"); // webhook
  });

  it("passes null for optional fields when omitted", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let capturedParams: any[];
    mockPoolQuery = async (_sql: string, params: any[]) => {
      capturedParams = params;
      return {
        rows: [{
          wallet_address: params[0],
          name: params[1],
          email: null,
          webhook: null,
          updated_at: "2026-03-12T00:00:00Z",
        }],
      };
    };

    const req = fakeReq({ body: { name: "my-agent" } });
    req._setHeader("x-402-payment", "validheader");
    const res = fakeRes();
    await putHandler(req, res, () => {});
    assert.equal(capturedParams![2], null); // email
    assert.equal(capturedParams![3], null); // webhook
  });

  it("extracts wallet from x-402-payment header", async () => {
    let extractedHeader: string | undefined;
    mockExtractWallet = (h: string) => {
      extractedHeader = h;
      return "0xabc123";
    };
    const req = fakeReq({ body: { name: "my-agent" } });
    req._setHeader("x-402-payment", "payment-header");
    const res = fakeRes();
    await putHandler(req, res, () => {});
    assert.equal(extractedHeader, "payment-header");
  });
});
