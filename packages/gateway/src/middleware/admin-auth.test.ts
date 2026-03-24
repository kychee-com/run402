import { describe, it, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

// ---------------------------------------------------------------------------
// Mock dependencies before importing module under test
// ---------------------------------------------------------------------------

const ADMIN_KEY = "test-admin-key-12345";
const SESSION_SECRET = "test-session-secret";

mock.module("../config.js", {
  namedExports: {
    ADMIN_KEY,
    ADMIN_SESSION_SECRET: SESSION_SECRET,
  },
});

let adminWallets = new Set<string>();
mock.module("../services/admin-wallets.js", {
  namedExports: {
    isAdminWallet: (address: string) => adminWallets.has(address.toLowerCase()),
  },
});

// Mock serviceKeyAuth — calls next() on success, sends 401 on failure
let serviceKeyAuthResult: "pass" | "fail" = "fail";
mock.module("./apikey.js", {
  namedExports: {
    serviceKeyAuth: (_req: unknown, res: { status: (n: number) => { json: (b: unknown) => void } }, next: (err?: unknown) => void) => {
      if (serviceKeyAuthResult === "pass") { next(); return; }
      res.status(401).json({ error: "Invalid token" });
    },
  },
});

// Mock walletAuth — returns middleware that calls next() on success
let walletAuthResult: "pass" | "fail" = "fail";
mock.module("./wallet-auth.js", {
  namedExports: {
    walletAuth: () => (_req: unknown, res: { status: (n: number) => { json: (b: unknown) => void } }, next: (err?: unknown) => void) => {
      if (walletAuthResult === "pass") { next(); return; }
      res.status(401).json({ error: "Missing SIGN-IN-WITH-X header" });
    },
  },
});

// SIWx mock — skip signature verification in unit tests
mock.module("@x402/extensions/sign-in-with-x", {
  namedExports: {
    parseSIWxHeader: (header: string) => JSON.parse(Buffer.from(header, "base64").toString()),
    verifySIWxSignature: async (payload: { address?: string }) => ({
      valid: !!payload.address,
      address: payload.address || null,
    }),
  },
});

const { adminAuth, serviceKeyOrAdmin, walletAuthOrAdmin } = await import("./admin-auth.js");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeReq(headers: Record<string, string> = {}): Record<string, unknown> {
  return { headers, isAdmin: undefined, walletAddress: undefined };
}

function makeRes(): { statusCode: number; body: unknown; headersSent: boolean; status: (n: number) => { json: (b: unknown) => void; end: () => void }; json: (b: unknown) => void } {
  const res = {
    statusCode: 0,
    body: null as unknown,
    headersSent: false,
    status(n: number) { res.statusCode = n; res.headersSent = true; return { json: (b: unknown) => { res.body = b; }, end: () => {} }; },
    json(b: unknown) { res.body = b; },
  };
  return res;
}

function makeSessionCookie(email: string, name: string, expired = false): string {
  const exp = expired ? Date.now() - 1000 : Date.now() + 86400_000;
  const payload = JSON.stringify({ email, name, exp });
  const b64 = Buffer.from(payload).toString("base64url");
  const sig = crypto.createHmac("sha256", SESSION_SECRET).update(b64).digest("hex");
  return `run402_admin=${b64}.${sig}`;
}

// ---------------------------------------------------------------------------
// Tests: adminAuth
// ---------------------------------------------------------------------------

describe("adminAuth", () => {
  beforeEach(() => {
    adminWallets = new Set();
  });

  it("detects admin via ADMIN_KEY header", async () => {
    const req = makeReq({ authorization: `Bearer ${ADMIN_KEY}` });
    const res = makeRes();
    let called = false;
    await adminAuth(req as never, res as never, () => { called = true; });
    assert.equal(called, true);
    assert.equal(req.isAdmin, true);
  });

  it("does not set isAdmin for wrong ADMIN_KEY", async () => {
    const req = makeReq({ authorization: "Bearer wrong-key" });
    const res = makeRes();
    let called = false;
    await adminAuth(req as never, res as never, () => { called = true; });
    assert.equal(called, true);
    assert.equal(req.isAdmin, undefined);
  });

  it("detects admin via session cookie", async () => {
    const cookie = makeSessionCookie("admin@kychee.com", "Admin");
    const req = makeReq({ cookie });
    const res = makeRes();
    let called = false;
    await adminAuth(req as never, res as never, () => { called = true; });
    assert.equal(called, true);
    assert.equal(req.isAdmin, true);
  });

  it("rejects expired session cookie", async () => {
    const cookie = makeSessionCookie("admin@kychee.com", "Admin", true);
    const req = makeReq({ cookie });
    const res = makeRes();
    let called = false;
    await adminAuth(req as never, res as never, () => { called = true; });
    assert.equal(called, true);
    assert.equal(req.isAdmin, undefined);
  });

  it("ADMIN_KEY wins over session cookie (detection order)", async () => {
    const cookie = makeSessionCookie("admin@kychee.com", "Admin");
    const req = makeReq({ authorization: `Bearer ${ADMIN_KEY}`, cookie });
    const res = makeRes();
    await adminAuth(req as never, res as never, () => {});
    assert.equal(req.isAdmin, true);
  });

  it("non-admin request passes through without isAdmin", async () => {
    const req = makeReq({});
    const res = makeRes();
    let called = false;
    await adminAuth(req as never, res as never, () => { called = true; });
    assert.equal(called, true);
    assert.equal(req.isAdmin, undefined);
  });
});

// ---------------------------------------------------------------------------
// Tests: serviceKeyOrAdmin
// ---------------------------------------------------------------------------

describe("serviceKeyOrAdmin", () => {
  beforeEach(() => {
    serviceKeyAuthResult = "fail";
  });

  it("passes when service_key is valid", async () => {
    serviceKeyAuthResult = "pass";
    const req = makeReq({});
    const res = makeRes();
    let called = false;
    await serviceKeyOrAdmin(req as never, res as never, () => { called = true; });
    assert.equal(called, true);
    assert.equal(req.isAdmin, undefined); // service_key, not admin
  });

  it("passes when ADMIN_KEY is provided", async () => {
    serviceKeyAuthResult = "fail";
    const req = makeReq({ authorization: `Bearer ${ADMIN_KEY}` });
    const res = makeRes();
    let called = false;
    await serviceKeyOrAdmin(req as never, res as never, () => { called = true; });
    assert.equal(called, true);
    assert.equal(req.isAdmin, true);
  });

  it("returns 401 when neither service_key nor admin", async () => {
    serviceKeyAuthResult = "fail";
    const req = makeReq({});
    const res = makeRes();
    let nextCalled = false;
    await serviceKeyOrAdmin(req as never, res as never, () => { nextCalled = true; });
    // serviceKeyAuth sends 401 (not via next), so next is not called
    assert.equal(res.statusCode, 401);
  });
});

// ---------------------------------------------------------------------------
// Tests: walletAuthOrAdmin
// ---------------------------------------------------------------------------

describe("walletAuthOrAdmin", () => {
  beforeEach(() => {
    walletAuthResult = "fail";
  });

  it("passes when wallet auth is valid", async () => {
    walletAuthResult = "pass";
    const req = makeReq({});
    const res = makeRes();
    let called = false;
    await walletAuthOrAdmin(req as never, res as never, () => { called = true; });
    assert.equal(called, true);
  });

  it("passes when ADMIN_KEY is provided", async () => {
    walletAuthResult = "fail";
    const req = makeReq({ authorization: `Bearer ${ADMIN_KEY}` });
    const res = makeRes();
    let called = false;
    await walletAuthOrAdmin(req as never, res as never, () => { called = true; });
    assert.equal(called, true);
    assert.equal(req.isAdmin, true);
  });

  it("returns 401 when neither wallet nor admin", async () => {
    walletAuthResult = "fail";
    const req = makeReq({});
    const res = makeRes();
    await walletAuthOrAdmin(req as never, res as never, () => {});
    assert.equal(res.statusCode, 401);
  });
});
