import { describe, it, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import jwt from "jsonwebtoken";

// ---------------------------------------------------------------------------
// Mock dependencies before importing module under test
// ---------------------------------------------------------------------------

const JWT_SECRET = "test-jwt-secret-32chars!!";

mock.module("../config.js", {
  namedExports: { JWT_SECRET },
});

const projectStore = new Map<string, { id: string; status: string; schema_slot: string }>();
mock.module("../services/projects.js", {
  namedExports: {
    projectCache: {
      get: (id: string) => projectStore.get(id),
    },
  },
});

const { projectAdminAuth, serviceKeyOrProjectAdmin } = await import("./apikey.js");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PROJECT_ID = "prj_123_0001";

function makeToken(payload: Record<string, unknown>, secret = JWT_SECRET): string {
  return jwt.sign(payload, secret, { expiresIn: "1h" });
}

function makeReq(headers: Record<string, string> = {}, params: Record<string, string> = {}): Record<string, unknown> {
  return { headers, params, project: undefined, tokenPayload: undefined, isProjectAdmin: undefined, projectAdminUserId: undefined };
}

function makeRes(): { statusCode: number; body: unknown; status: (n: number) => { json: (b: unknown) => void }; json: (b: unknown) => void } {
  const res = {
    statusCode: 0,
    body: null as unknown,
    status(n: number) { res.statusCode = n; return { json: (b: unknown) => { res.body = b; } }; },
    json(b: unknown) { res.body = b; },
  };
  return res;
}

beforeEach(() => {
  projectStore.clear();
  projectStore.set(PROJECT_ID, { id: PROJECT_ID, status: "active", schema_slot: "p0001" });
});

// ---------------------------------------------------------------------------
// projectAdminAuth
// ---------------------------------------------------------------------------

describe("projectAdminAuth", () => {
  it("accepts valid project_admin JWT", () => {
    const token = makeToken({ sub: "user-1", role: "project_admin", project_id: PROJECT_ID });
    const req = makeReq({ authorization: `Bearer ${token}` }, { id: PROJECT_ID });
    const res = makeRes();
    let called = false;

    projectAdminAuth(req as never, res as never, () => { called = true; });

    assert.ok(called, "next() should be called");
    assert.equal(req.isProjectAdmin, true);
    assert.equal(req.projectAdminUserId, "user-1");
  });

  it("rejects expired JWT", () => {
    const token = jwt.sign({ sub: "user-1", role: "project_admin", project_id: PROJECT_ID }, JWT_SECRET, { expiresIn: "-1s" });
    const req = makeReq({ authorization: `Bearer ${token}` }, { id: PROJECT_ID });
    const res = makeRes();
    let called = false;

    projectAdminAuth(req as never, res as never, () => { called = true; });

    assert.ok(!called, "next() should not be called");
    assert.equal(res.statusCode, 401);
  });

  it("rejects project_id mismatch", () => {
    const token = makeToken({ sub: "user-1", role: "project_admin", project_id: "prj_other_0002" });
    const req = makeReq({ authorization: `Bearer ${token}` }, { id: PROJECT_ID });
    const res = makeRes();
    let called = false;

    projectAdminAuth(req as never, res as never, () => { called = true; });

    assert.ok(!called, "next() should not be called");
    assert.equal(res.statusCode, 401);
  });

  it("rejects authenticated role (not project_admin)", () => {
    const token = makeToken({ sub: "user-1", role: "authenticated", project_id: PROJECT_ID });
    const req = makeReq({ authorization: `Bearer ${token}` }, { id: PROJECT_ID });
    const res = makeRes();
    let called = false;

    projectAdminAuth(req as never, res as never, () => { called = true; });

    assert.ok(!called, "next() should not be called");
    assert.equal(res.statusCode, 401);
  });

  it("rejects missing Bearer token", () => {
    const req = makeReq({}, { id: PROJECT_ID });
    const res = makeRes();
    let called = false;

    projectAdminAuth(req as never, res as never, () => { called = true; });

    assert.ok(!called);
    assert.equal(res.statusCode, 401);
  });
});

// ---------------------------------------------------------------------------
// serviceKeyOrProjectAdmin
// ---------------------------------------------------------------------------

describe("serviceKeyOrProjectAdmin", () => {
  it("accepts service_role JWT", () => {
    const token = makeToken({ role: "service_role", project_id: PROJECT_ID });
    const req = makeReq({ authorization: `Bearer ${token}` }, { id: PROJECT_ID });
    const res = makeRes();
    let called = false;

    serviceKeyOrProjectAdmin(req as never, res as never, () => { called = true; });

    assert.ok(called, "next() should be called for service_role");
  });

  it("accepts project_admin JWT", () => {
    const token = makeToken({ sub: "user-1", role: "project_admin", project_id: PROJECT_ID });
    const req = makeReq({ authorization: `Bearer ${token}` }, { id: PROJECT_ID });
    const res = makeRes();
    let called = false;

    serviceKeyOrProjectAdmin(req as never, res as never, () => { called = true; });

    assert.ok(called, "next() should be called for project_admin");
    assert.equal(req.isProjectAdmin, true);
  });

  it("rejects authenticated JWT", () => {
    const token = makeToken({ sub: "user-1", role: "authenticated", project_id: PROJECT_ID });
    const req = makeReq({ authorization: `Bearer ${token}` }, { id: PROJECT_ID });
    const res = makeRes();
    let called = false;

    serviceKeyOrProjectAdmin(req as never, res as never, () => { called = true; });

    assert.ok(!called, "next() should not be called for authenticated");
    assert.equal(res.statusCode, 401);
  });

  it("rejects missing token", () => {
    const req = makeReq({}, { id: PROJECT_ID });
    const res = makeRes();
    let called = false;

    serviceKeyOrProjectAdmin(req as never, res as never, () => { called = true; });

    assert.ok(!called);
    assert.equal(res.statusCode, 401);
  });
});
