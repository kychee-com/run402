import { describe, it, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

let mockRegister: (...args: unknown[]) => Promise<unknown>;
let mockGetStatus: (...args: unknown[]) => Promise<unknown>;
let mockRemove: (...args: unknown[]) => Promise<unknown>;
let mockEnableInbound: (...args: unknown[]) => Promise<unknown>;
let mockDisableInbound: (...args: unknown[]) => Promise<unknown>;

mock.module("../db/pool.js", { namedExports: { pool: { query: async () => ({ rows: [], rowCount: 0 }) } } });
mock.module("../db/sql.js", { namedExports: { sql: (s: string) => s } });

mock.module("../services/email-domains.js", {
  namedExports: {
    registerSenderDomain: (...args: unknown[]) => mockRegister(...args),
    getSenderDomainStatus: (...args: unknown[]) => mockGetStatus(...args),
    removeSenderDomain: (...args: unknown[]) => mockRemove(...args),
    enableInbound: (...args: unknown[]) => mockEnableInbound(...args),
    disableInbound: (...args: unknown[]) => mockDisableInbound(...args),
    getVerifiedSenderDomain: async () => null,
  },
});

mock.module("../middleware/apikey.js", {
  namedExports: {
    serviceKeyAuth: (_r: unknown, _s: unknown, n: () => void) => n(),
  },
});

const { default: router } = await import("./email-domains.js");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fakeReq(overrides: Record<string, any> = {}) {
  return {
    method: "POST",
    body: {},
    project: { id: "proj1", name: "test", tier: "prototype", walletAddress: "0xwallet1" },
    ...overrides,
  };
}

function fakeRes() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const res: Record<string, any> = {
    _status: 200, _body: null, _headers: {} as Record<string, string>,
    status(c: number) { res._status = c; return res; },
    json(o: unknown) { res._body = o; return res; },
    set(k: string, v: string) { res._headers[k] = v; return res; },
  };
  return res;
}

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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function call(method: string, path: string, req: any, res: any): Promise<any> {
  const handler = findHandler(method, path);
  assert.ok(handler, `handler for ${method} ${path} should exist`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let error: any = undefined;
  const next = (e?: unknown) => { error = e; };
  handler(req, res, next);
  await new Promise(r => setTimeout(r, 50));
  return error;
}

// ---------------------------------------------------------------------------
// POST /email/v1/domains
// ---------------------------------------------------------------------------
describe("POST /email/v1/domains", () => {
  beforeEach(() => {
    mockRegister = async () => ({ domain: "mybrand.com", status: "pending", dns_records: [], instructions: "Add CNAME records" });
  });

  it("returns 201 with DNS records for valid domain", async () => {
    const req = fakeReq({ body: { domain: "mybrand.com" } });
    const res = fakeRes();
    await call("post", "/email/v1/domains", req, res);
    assert.equal(res._status, 201);
    assert.equal(res._body.domain, "mybrand.com");
  });

  it("returns 400 for missing domain", async () => {
    const req = fakeReq({ body: {} });
    const res = fakeRes();
    const err = await call("post", "/email/v1/domains", req, res);
    assert.ok(err);
    assert.equal(err.statusCode, 400);
  });

  it("returns error status from service (blocklist, invalid, etc.)", async () => {
    mockRegister = async () => ({ error: true, message: "Domain not allowed (blocklist)" });
    const req = fakeReq({ body: { domain: "gmail.com" } });
    const res = fakeRes();
    await call("post", "/email/v1/domains", req, res);
    assert.equal(res._status, 400);
    assert.ok(res._body.error);
  });

  it("returns 409 for ownership conflict", async () => {
    mockRegister = async () => ({ error: true, message: "Domain is registered by another wallet" });
    const req = fakeReq({ body: { domain: "taken.com" } });
    const res = fakeRes();
    await call("post", "/email/v1/domains", req, res);
    assert.equal(res._status, 409);
  });
});

// ---------------------------------------------------------------------------
// GET /email/v1/domains
// ---------------------------------------------------------------------------
describe("GET /email/v1/domains", () => {
  it("returns domain with status when registered", async () => {
    mockGetStatus = async () => ({ domain: "mybrand.com", status: "pending", dkim_records: [], verified_at: null });
    const req = fakeReq();
    const res = fakeRes();
    await call("get", "/email/v1/domains", req, res);
    assert.equal(res._status, 200);
    assert.equal(res._body.domain, "mybrand.com");
  });

  it("returns { domain: null } when no domain", async () => {
    mockGetStatus = async () => null;
    const req = fakeReq();
    const res = fakeRes();
    await call("get", "/email/v1/domains", req, res);
    assert.equal(res._status, 200);
    assert.equal(res._body.domain, null);
  });
});

// ---------------------------------------------------------------------------
// DELETE /email/v1/domains
// ---------------------------------------------------------------------------
describe("DELETE /email/v1/domains", () => {
  it("returns 200 on successful removal", async () => {
    mockRemove = async () => true;
    const req = fakeReq();
    const res = fakeRes();
    await call("delete", "/email/v1/domains", req, res);
    assert.equal(res._status, 200);
  });

  it("returns 404 when no domain", async () => {
    mockRemove = async () => false;
    const req = fakeReq();
    const res = fakeRes();
    const err = await call("delete", "/email/v1/domains", req, res);
    assert.ok(err);
    assert.equal(err.statusCode, 404);
  });
});

// ---------------------------------------------------------------------------
// POST /email/v1/domains/inbound
// ---------------------------------------------------------------------------
describe("POST /email/v1/domains/inbound", () => {
  it("returns 200 with mx_record on success", async () => {
    mockEnableInbound = async () => ({ status: "enabled", mx_record: "10 inbound-smtp.us-east-1.amazonaws.com" });
    const req = fakeReq({ body: { domain: "kysigned.com" } });
    const res = fakeRes();
    await call("post", "/email/v1/domains/inbound", req, res);
    assert.equal(res._status, 200);
    assert.equal(res._body.status, "enabled");
    assert.ok(res._body.mx_record);
  });

  it("returns 400 when domain missing", async () => {
    const req = fakeReq({ body: {} });
    const res = fakeRes();
    const err = await call("post", "/email/v1/domains/inbound", req, res);
    assert.ok(err);
    assert.equal(err.statusCode, 400);
  });

  it("returns 409 when domain not verified", async () => {
    mockEnableInbound = async () => ({ error: true, message: "Domain must be DKIM-verified before enabling inbound" });
    const req = fakeReq({ body: { domain: "kysigned.com" } });
    const res = fakeRes();
    await call("post", "/email/v1/domains/inbound", req, res);
    assert.equal(res._status, 409);
  });
});

// ---------------------------------------------------------------------------
// DELETE /email/v1/domains/inbound
// ---------------------------------------------------------------------------
describe("DELETE /email/v1/domains/inbound", () => {
  it("returns 200 on success", async () => {
    mockDisableInbound = async () => ({ status: "disabled" });
    const req = fakeReq({ body: { domain: "kysigned.com" } });
    const res = fakeRes();
    await call("delete", "/email/v1/domains/inbound", req, res);
    assert.equal(res._status, 200);
    assert.equal(res._body.status, "disabled");
  });

  it("returns 404 when domain not found", async () => {
    mockDisableInbound = async () => ({ error: true, message: "Domain not found for this project" });
    const req = fakeReq({ body: { domain: "nonexistent.com" } });
    const res = fakeRes();
    await call("delete", "/email/v1/domains/inbound", req, res);
    assert.equal(res._status, 404);
  });
});
