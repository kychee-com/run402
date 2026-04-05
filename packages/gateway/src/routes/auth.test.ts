import { describe, it, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mockPoolQuery: (...args: any[]) => Promise<any>;
let mockSendEmail: (...args: unknown[]) => Promise<unknown>;
let mockCreateMagicLinkToken: (...args: unknown[]) => Promise<string>;
let mockVerifyMagicLinkToken: (...args: unknown[]) => Promise<unknown>;
let mockCheckRateLimit: (...args: unknown[]) => { allowed: boolean; reason?: string };
let mockValidateRedirectUrl: (...args: unknown[]) => Promise<boolean>;
let mockFireLifecycleHook: (...args: unknown[]) => void;
let mockProjectCacheGet: (id: string) => unknown;

mock.module("../db/pool.js", { namedExports: { pool: { query: (...args: unknown[]) => mockPoolQuery(...args) } } });
mock.module("../db/sql.js", { namedExports: { sql: (s: string) => s } });
mock.module("../config.js", { namedExports: { JWT_SECRET: "test-secret-key-for-unit-tests-32chars!!", GOOGLE_APP_CLIENT_ID: "", GOOGLE_APP_CLIENT_SECRET: "", PUBLIC_API_URL: "http://localhost:4022" } });
mock.module("../middleware/apikey.js", { namedExports: { apikeyAuth: (_r: unknown, _s: unknown, n: () => void) => n(), serviceKeyAuth: (_r: unknown, _s: unknown, n: () => void) => n() } });
mock.module("../middleware/demo.js", { namedExports: { demoSignupMiddleware: (_r: unknown, _s: unknown, n: () => void) => n(), getDemoCounters: () => ({ signups: 0 }) } });
mock.module("../services/google-oidc.js", { namedExports: { verifyGoogleIdToken: async () => ({}) } });
mock.module("../services/oauth.js", { namedExports: { validateRedirectUrl: (...a: unknown[]) => mockValidateRedirectUrl(...a), createOAuthTransaction: async () => ({ state: "s", nonce: "n" }), consumeOAuthTransaction: async () => null, resolveOAuthIdentity: async () => ({ action: "signup", userId: "u1" }), createAuthorizationCode: async () => "code", exchangeAuthorizationCode: async () => null } });
mock.module("../services/projects.js", { namedExports: { projectCache: { get: (id: string) => mockProjectCacheGet(id) } } });
mock.module("../services/functions.js", { namedExports: { fireLifecycleHook: (...a: unknown[]) => mockFireLifecycleHook(...a) } });
mock.module("../services/magic-link.js", { namedExports: { createMagicLinkToken: (...a: unknown[]) => mockCreateMagicLinkToken(...a), verifyMagicLinkToken: (...a: unknown[]) => mockVerifyMagicLinkToken(...a), checkMagicLinkRateLimit: (...a: unknown[]) => mockCheckRateLimit(...a), cleanupExpiredMagicLinkTokens: async () => {} } });
mock.module("../services/email-send.js", { namedExports: { sendEmail: (...a: unknown[]) => mockSendEmail(...a) } });

const bcryptMock = { hash: async (pw: string) => `hashed:${pw}`, compare: async (pw: string, hash: string) => hash === `hashed:${pw}` };
mock.module("bcryptjs", { defaultExport: bcryptMock, namedExports: bcryptMock });

const jwt = await import("jsonwebtoken");
const { default: router } = await import("./auth.js");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const JWT_SECRET = "test-secret-key-for-unit-tests-32chars!!";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fakeReq(overrides: Record<string, any> = {}) {
  const headers: Record<string, string> = overrides.headers || {};
  return { method: "POST", headers, header(n: string) { return headers[n.toLowerCase()]; }, query: {}, body: {}, project: { id: "proj1", name: "test", tier: "prototype" }, tokenPayload: { role: "anon" }, ...overrides };
}

function fakeRes() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const res: Record<string, any> = { _status: 200, _body: null, _headers: {} as Record<string, string>, headersSent: false, status(c: number) { res._status = c; return res; }, json(o: unknown) { res._body = o; return res; }, set(k: string, v: string) { res._headers[k] = v; return res; }, type() { return res; }, send() { return res; }, redirect() { return res; } };
  return res;
}

// Extract handler from Express router stack. Returns the asyncHandler wrapper.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function findHandler(method: string, path: string): any {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const layer of (router as any).stack) {
    if (layer.route && layer.route.path === path && layer.route.methods[method.toLowerCase()]) {
      return layer.route.stack[layer.route.stack.length - 1].handle;
    }
  }
  return null;
}

// Call Express route handler, capture error via next()
// asyncHandler wraps: fn(req,res,next).catch(next)
// On success: response is sent, next() not called
// On error: next(err) is called
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function call(method: string, path: string, req: any, res: any): Promise<any> {
  const handler = findHandler(method, path);
  assert.ok(handler, `handler for ${method} ${path} should exist`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let error: any = undefined;
  const next = (e?: unknown) => { error = e; };
  // The handler is the asyncHandler wrapper which returns a sync function
  // that internally calls fn().catch(next). We need to wait for the internal promise.
  handler(req, res, next);
  // Give the internal async function time to complete
  await new Promise(r => setTimeout(r, 50));
  return error;
}

// ---------------------------------------------------------------------------
// POST /auth/v1/magic-link
// ---------------------------------------------------------------------------
describe("POST /auth/v1/magic-link", () => {
  beforeEach(() => {
    mockPoolQuery = async () => ({ rows: [{ id: "mb1" }], rowCount: 1 });
    mockCreateMagicLinkToken = async () => "test-token";
    mockSendEmail = async () => ({ messageId: "m1" });
    mockValidateRedirectUrl = async () => true;
    mockCheckRateLimit = () => ({ allowed: true });
    mockProjectCacheGet = () => ({ allowPasswordSet: false, demoMode: false });
  });

  it("returns 200 with generic message", async () => {
    const req = fakeReq({ body: { email: "user@example.com", redirect_url: "https://app.run402.com/cb" } });
    const res = fakeRes();
    const err = await call("post", "/auth/v1/magic-link", req, res);
    assert.equal(err, undefined);
    assert.equal(res._status, 200);
    assert.ok(res._body.message.includes("magic link"));
  });

  it("returns 400 for missing email", async () => {
    const req = fakeReq({ body: { redirect_url: "https://app.run402.com/cb" } });
    const res = fakeRes();
    const err = await call("post", "/auth/v1/magic-link", req, res);
    assert.ok(err);
    assert.equal(err.statusCode, 400);
  });

  it("returns 400 for missing redirect_url", async () => {
    const req = fakeReq({ body: { email: "user@example.com" } });
    const res = fakeRes();
    const err = await call("post", "/auth/v1/magic-link", req, res);
    assert.ok(err);
    assert.equal(err.statusCode, 400);
  });

  it("returns 400 for disallowed redirect_url", async () => {
    mockValidateRedirectUrl = async () => false;
    const req = fakeReq({ body: { email: "user@example.com", redirect_url: "https://evil.com" } });
    const res = fakeRes();
    const err = await call("post", "/auth/v1/magic-link", req, res);
    assert.ok(err);
    assert.equal(err.statusCode, 400);
  });

  it("returns 429 when rate limited", async () => {
    mockCheckRateLimit = () => ({ allowed: false, reason: "per_email" });
    const req = fakeReq({ body: { email: "user@example.com", redirect_url: "https://app.run402.com/cb" } });
    const res = fakeRes();
    await call("post", "/auth/v1/magic-link", req, res);
    assert.equal(res._status, 429);
  });

  it("same response for existing and non-existing email (no enumeration)", async () => {
    const req1 = fakeReq({ body: { email: "a@test.com", redirect_url: "https://app.run402.com/cb" } });
    const res1 = fakeRes();
    await call("post", "/auth/v1/magic-link", req1, res1);

    const req2 = fakeReq({ body: { email: "b@test.com", redirect_url: "https://app.run402.com/cb" } });
    const res2 = fakeRes();
    await call("post", "/auth/v1/magic-link", req2, res2);

    assert.equal(res1._status, res2._status);
    assert.equal(res1._body.message, res2._body.message);
  });
});

// ---------------------------------------------------------------------------
// POST /auth/v1/token?grant_type=magic_link
// ---------------------------------------------------------------------------
describe("POST /auth/v1/token?grant_type=magic_link", () => {
  beforeEach(() => {
    mockFireLifecycleHook = () => {};
    mockProjectCacheGet = () => ({ allowPasswordSet: false, demoMode: false });
  });

  it("returns tokens for valid magic link (existing user)", async () => {
    mockVerifyMagicLinkToken = async () => ({ email: "u@test.com", projectId: "proj1", redirectUrl: "https://app.run402.com" });
    mockPoolQuery = async (sql: string) => {
      if (sql.includes("SELECT") && sql.includes("internal.users")) return { rows: [{ id: "u1", email: "u@test.com", is_admin: false, email_verified_at: new Date() }], rowCount: 1 };
      if (sql.includes("UPDATE")) return { rows: [], rowCount: 1 };
      if (sql.includes("INSERT INTO internal.refresh_tokens")) return { rows: [], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    };
    const req = fakeReq({ query: { grant_type: "magic_link" }, body: { token: "valid" } });
    const res = fakeRes();
    const err = await call("post", "/auth/v1/token", req, res);
    assert.equal(err, undefined);
    assert.equal(res._status, 200);
    assert.ok(res._body.access_token);
    assert.ok(res._body.refresh_token);
    assert.equal(res._body.token_type, "bearer");
  });

  it("auto-creates user for new email", async () => {
    mockVerifyMagicLinkToken = async () => ({ email: "new@test.com", projectId: "proj1", redirectUrl: "https://app.run402.com" });
    let inserted = false;
    mockPoolQuery = async (sql: string) => {
      if (sql.includes("SELECT") && sql.includes("internal.users") && !sql.includes("INSERT")) return { rows: [], rowCount: 0 };
      if (sql.includes("INSERT INTO internal.users")) { inserted = true; return { rows: [{ id: "u2", email: "new@test.com", is_admin: false, email_verified_at: new Date() }], rowCount: 1 }; }
      if (sql.includes("INSERT INTO internal.refresh_tokens")) return { rows: [], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    };
    const req = fakeReq({ query: { grant_type: "magic_link" }, body: { token: "valid" } });
    const res = fakeRes();
    await call("post", "/auth/v1/token", req, res);
    assert.ok(inserted, "user INSERT should happen");
    assert.equal(res._status, 200);
  });

  it("fires on-signup hook for new user", async () => {
    mockVerifyMagicLinkToken = async () => ({ email: "hook@test.com", projectId: "proj1", redirectUrl: "https://app.run402.com" });
    let hookFired = false;
    mockFireLifecycleHook = () => { hookFired = true; };
    mockPoolQuery = async (sql: string) => {
      if (sql.includes("SELECT") && sql.includes("internal.users") && !sql.includes("INSERT")) return { rows: [], rowCount: 0 };
      if (sql.includes("INSERT INTO internal.users")) return { rows: [{ id: "u3", email: "hook@test.com", is_admin: false, email_verified_at: new Date() }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    };
    const req = fakeReq({ query: { grant_type: "magic_link" }, body: { token: "valid" } });
    const res = fakeRes();
    await call("post", "/auth/v1/token", req, res);
    assert.ok(hookFired);
  });

  it("returns 401 for invalid token", async () => {
    mockVerifyMagicLinkToken = async () => null;
    const req = fakeReq({ query: { grant_type: "magic_link" }, body: { token: "bad" } });
    const res = fakeRes();
    const err = await call("post", "/auth/v1/token", req, res);
    assert.ok(err);
    assert.equal(err.statusCode, 401);
  });

  it("returns 400 for missing token", async () => {
    const req = fakeReq({ query: { grant_type: "magic_link" }, body: {} });
    const res = fakeRes();
    const err = await call("post", "/auth/v1/token", req, res);
    assert.ok(err);
    assert.equal(err.statusCode, 400);
  });
});

// ---------------------------------------------------------------------------
// PUT /auth/v1/user/password
// ---------------------------------------------------------------------------
describe("PUT /auth/v1/user/password", () => {
  function makeToken(sub: string) {
    return jwt.default.sign({ sub, role: "authenticated", project_id: "proj1", email: "u@test.com" }, JWT_SECRET, { expiresIn: "1h" });
  }

  beforeEach(() => { mockProjectCacheGet = () => ({ allowPasswordSet: false }); });

  it("changes password with correct current_password", async () => {
    mockPoolQuery = async (sql: string) => {
      if (sql.includes("SELECT") && sql.includes("password_hash")) return { rows: [{ id: "u1", password_hash: "hashed:old" }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    };
    const req = fakeReq({ headers: { authorization: `Bearer ${makeToken("u1")}` }, body: { current_password: "old", new_password: "new" } });
    const res = fakeRes();
    const err = await call("put", "/auth/v1/user/password", req, res);
    assert.equal(err, undefined);
    assert.equal(res._status, 200);
  });

  it("rejects wrong current_password", async () => {
    mockPoolQuery = async (sql: string) => {
      if (sql.includes("SELECT") && sql.includes("password_hash")) return { rows: [{ id: "u1", password_hash: "hashed:correct" }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    };
    const req = fakeReq({ headers: { authorization: `Bearer ${makeToken("u1")}` }, body: { current_password: "wrong", new_password: "new" } });
    const res = fakeRes();
    const err = await call("put", "/auth/v1/user/password", req, res);
    assert.ok(err);
    assert.equal(err.statusCode, 401);
  });

  it("allows password reset (no current_password, has existing password)", async () => {
    mockPoolQuery = async (sql: string) => {
      if (sql.includes("SELECT") && sql.includes("password_hash")) return { rows: [{ id: "u1", password_hash: "hashed:old" }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    };
    const req = fakeReq({ headers: { authorization: `Bearer ${makeToken("u1")}` }, body: { new_password: "reset" } });
    const res = fakeRes();
    const err = await call("put", "/auth/v1/user/password", req, res);
    assert.equal(err, undefined);
    assert.equal(res._status, 200);
  });

  it("denies password set when allow_password_set=false", async () => {
    mockPoolQuery = async (sql: string) => {
      if (sql.includes("SELECT") && sql.includes("password_hash")) return { rows: [{ id: "u1", password_hash: null }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    };
    const req = fakeReq({ headers: { authorization: `Bearer ${makeToken("u1")}` }, body: { new_password: "new" } });
    const res = fakeRes();
    const err = await call("put", "/auth/v1/user/password", req, res);
    assert.ok(err);
    assert.equal(err.statusCode, 403);
  });

  it("allows password set when allow_password_set=true", async () => {
    mockProjectCacheGet = () => ({ allowPasswordSet: true });
    mockPoolQuery = async (sql: string) => {
      if (sql.includes("SELECT") && sql.includes("password_hash")) return { rows: [{ id: "u1", password_hash: null }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    };
    const req = fakeReq({ headers: { authorization: `Bearer ${makeToken("u1")}` }, body: { new_password: "new" } });
    const res = fakeRes();
    const err = await call("put", "/auth/v1/user/password", req, res);
    assert.equal(err, undefined);
    assert.equal(res._status, 200);
  });

  it("rejects unauthenticated request", async () => {
    const req = fakeReq({ headers: {}, body: { new_password: "new" } });
    const res = fakeRes();
    const err = await call("put", "/auth/v1/user/password", req, res);
    assert.ok(err);
    assert.equal(err.statusCode, 401);
  });
});

// ---------------------------------------------------------------------------
// GET /auth/v1/providers
// ---------------------------------------------------------------------------
describe("GET /auth/v1/providers", () => {
  it("includes magic_link and password_set", async () => {
    mockProjectCacheGet = () => ({ allowPasswordSet: false });
    const req = fakeReq({ project: { id: "proj1", name: "test" } });
    const res = fakeRes();
    await call("get", "/auth/v1/providers", req, res);
    assert.equal(res._body.magic_link.enabled, true);
    assert.equal(res._body.password_set.enabled, false);
  });

  it("reflects allow_password_set=true", async () => {
    mockProjectCacheGet = () => ({ allowPasswordSet: true });
    const req = fakeReq({ project: { id: "proj1", name: "test" } });
    const res = fakeRes();
    await call("get", "/auth/v1/providers", req, res);
    assert.equal(res._body.password_set.enabled, true);
  });
});

// ---------------------------------------------------------------------------
// PATCH /auth/v1/settings
// ---------------------------------------------------------------------------
describe("PATCH /auth/v1/settings", () => {
  it("updates with service_key", async () => {
    mockPoolQuery = async () => ({ rows: [], rowCount: 1 });
    mockProjectCacheGet = () => ({ allowPasswordSet: false });
    const req = fakeReq({ tokenPayload: { role: "service_role" }, body: { allow_password_set: true } });
    const res = fakeRes();
    const err = await call("patch", "/auth/v1/settings", req, res);
    assert.equal(err, undefined);
    assert.equal(res._status, 200);
    assert.equal(res._body.allow_password_set, true);
  });

  it("rejects non-service_key", async () => {
    const req = fakeReq({ tokenPayload: { role: "anon" }, body: { allow_password_set: true } });
    const res = fakeRes();
    const err = await call("patch", "/auth/v1/settings", req, res);
    assert.ok(err);
    assert.equal(err.statusCode, 403);
  });
});
