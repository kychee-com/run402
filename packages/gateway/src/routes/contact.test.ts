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

// Wallet util — stub to prevent side-effects during import
mock.module("../utils/wallet.js", {
  namedExports: {
    extractWalletFromPaymentHeader: () => null,
    recordWallet: () => {},
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
    method: "POST",
    headers,
    header(name: string) {
      return headers[name.toLowerCase()];
    },
    body: {},
    walletAddress: "0xabc123",
    ...overrides,
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

const putHandler = findHandler("POST", "/agent/v1/contact");
const getHandler = findHandler("GET", "/agent/v1/contact");

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GET /agent/v1/contact", () => {
  it("returns endpoint description", () => {
    const req = fakeReq();
    const res = fakeRes();
    getHandler(req, res);
    assert.equal(res._body.method, "POST");
    assert.ok(res._body.description.includes("contact"));
    assert.ok(res._body.body.name);
  });
});

describe("POST /agent/v1/contact", () => {
  beforeEach(() => {
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

  it("returns 400 when name is missing", async () => {
    const req = fakeReq({ body: {} });
    const res = fakeRes();
    let nextErr: Error | undefined;
    await putHandler(req, res, (err?: Error) => { nextErr = err; });
    assert.ok(nextErr);
    assert.equal((nextErr as any).statusCode, 400);
    assert.ok(nextErr.message.includes("name"));
  });

  it("returns 400 when name is empty string", async () => {
    const req = fakeReq({ body: { name: "   " } });
    const res = fakeRes();
    let nextErr: Error | undefined;
    await putHandler(req, res, (err?: Error) => { nextErr = err; });
    assert.ok(nextErr);
    assert.equal((nextErr as any).statusCode, 400);
  });

  it("returns 400 when name is not a string", async () => {
    const req = fakeReq({ body: { name: 42 } });
    const res = fakeRes();
    let nextErr: Error | undefined;
    await putHandler(req, res, (err?: Error) => { nextErr = err; });
    assert.ok(nextErr);
    assert.equal((nextErr as any).statusCode, 400);
  });

  it("returns 400 when email is invalid", async () => {
    const req = fakeReq({ body: { name: "my-agent", email: "not-an-email" } });
    const res = fakeRes();
    let nextErr: Error | undefined;
    await putHandler(req, res, (err?: Error) => { nextErr = err; });
    assert.ok(nextErr);
    assert.equal((nextErr as any).statusCode, 400);
    assert.ok(nextErr.message.includes("email"));
  });

  it("returns 400 when webhook is not https", async () => {
    const req = fakeReq({ body: { name: "my-agent", webhook: "http://insecure.com/hook" } });
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
    const res = fakeRes();
    await putHandler(req, res, () => {});
    assert.equal(res._body.name, "minimal-agent");
    assert.equal(res._body.email, null);
    assert.equal(res._body.webhook, null);
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
    const res = fakeRes();
    await putHandler(req, res, () => {});
    assert.equal(capturedParams![2], null); // email
    assert.equal(capturedParams![3], null); // webhook
  });
});
