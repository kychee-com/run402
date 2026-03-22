import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  demoRestMiddleware,
  demoSignupMiddleware,
  demoStorageMiddleware,
  demoFunctionInvokeMiddleware,
  demoBlockedMiddleware,
  resetDemoCounters,
  getDemoCounters,
  setDemoMaintenance,
} from "./demo.js";
import { DEFAULT_DEMO_CONFIG } from "@run402/shared";
import type { ProjectInfo, DemoConfig } from "@run402/shared";

// ---------------------------------------------------------------------------
// Helpers — minimal Express req/res fakes
// ---------------------------------------------------------------------------

function fakeProject(overrides: Partial<ProjectInfo> = {}): ProjectInfo {
  return {
    id: "prj_demo_001",
    name: "demo-test",
    schemaSlot: "p0001",
    tier: "prototype",
    status: "active",
    anonKey: "",
    serviceKey: "",
    apiCalls: 0,
    storageBytes: 0,
    pinned: true,
    createdAt: new Date(),
    demoMode: true,
    demoConfig: { ...DEFAULT_DEMO_CONFIG },
    demoSourceVersionId: "av_test123",
    demoLastResetAt: new Date(),
    ...overrides,
  };
}

function fakeReq(method = "GET", project?: ProjectInfo) {
  return {
    method,
    project: project || fakeProject(),
  } as any;
}

function fakeRes(): any {
  const res: Record<string, any> = {
    _status: 0,
    _headers: {} as Record<string, string>,
    _body: null as any,
    status(code: number) { res._status = code; return res; },
    set(k: string, v: string) { res._headers[k] = v; return res; },
    json(obj: any) { res._body = obj; return res; },
  };
  return res;
}

let nextCalled: boolean;
function fakeNext() { nextCalled = true; }

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("demo middleware — REST routes", () => {
  beforeEach(() => {
    nextCalled = false;
    resetDemoCounters("prj_demo_001");
    setDemoMaintenance("prj_demo_001", false);
  });

  it("passes through for non-demo projects", () => {
    const req = fakeReq("POST", fakeProject({ demoMode: false }));
    const res = fakeRes();
    demoRestMiddleware(req, res, fakeNext);
    assert.ok(nextCalled);
    assert.equal(res._status, 0);
  });

  it("allows GET requests without counting", () => {
    const req = fakeReq("GET");
    const res = fakeRes();
    demoRestMiddleware(req, res, fakeNext);
    assert.ok(nextCalled);
    const c = getDemoCounters("prj_demo_001");
    assert.equal(c.inserts, 0);
  });

  it("counts POST inserts", () => {
    const req = fakeReq("POST");
    const res = fakeRes();
    demoRestMiddleware(req, res, fakeNext);
    assert.ok(nextCalled);
    assert.equal(getDemoCounters("prj_demo_001").inserts, 1);
  });

  it("blocks POST when insert limit reached", () => {
    const project = fakeProject({ demoConfig: { ...DEFAULT_DEMO_CONFIG, max_row_inserts: 2 } });
    // Use up the limit
    getDemoCounters("prj_demo_001").inserts = 2;

    const req = fakeReq("POST", project);
    const res = fakeRes();
    demoRestMiddleware(req, res, fakeNext);

    assert.ok(!nextCalled);
    assert.equal(res._status, 429);
    assert.equal(res._body.code, "DEMO_ROW_INSERT_LIMIT");
    assert.equal(res._body.current, 2);
    assert.equal(res._body.max, 2);
    assert.ok(res._headers["Retry-After"]);
  });

  it("counts DELETE requests", () => {
    const req = fakeReq("DELETE");
    const res = fakeRes();
    demoRestMiddleware(req, res, fakeNext);
    assert.ok(nextCalled);
    assert.equal(getDemoCounters("prj_demo_001").deletes, 1);
  });

  it("blocks DELETE when delete limit reached", () => {
    const project = fakeProject({ demoConfig: { ...DEFAULT_DEMO_CONFIG, max_row_deletes: 3 } });
    getDemoCounters("prj_demo_001").deletes = 3;

    const req = fakeReq("DELETE", project);
    const res = fakeRes();
    demoRestMiddleware(req, res, fakeNext);

    assert.ok(!nextCalled);
    assert.equal(res._status, 429);
    assert.equal(res._body.code, "DEMO_ROW_DELETE_LIMIT");
  });

  it("blocks DELETE when allow_deletes is false", () => {
    const project = fakeProject({ demoConfig: { ...DEFAULT_DEMO_CONFIG, allow_deletes: false } });
    const req = fakeReq("DELETE", project);
    const res = fakeRes();
    demoRestMiddleware(req, res, fakeNext);

    assert.ok(!nextCalled);
    assert.equal(res._status, 429);
    assert.equal(res._body.code, "DEMO_BLOCKED");
  });

  it("allows PATCH when allow_edits is true", () => {
    const req = fakeReq("PATCH");
    const res = fakeRes();
    demoRestMiddleware(req, res, fakeNext);
    assert.ok(nextCalled);
  });

  it("blocks PATCH when allow_edits is false", () => {
    const project = fakeProject({ demoConfig: { ...DEFAULT_DEMO_CONFIG, allow_edits: false } });
    const req = fakeReq("PATCH", project);
    const res = fakeRes();
    demoRestMiddleware(req, res, fakeNext);

    assert.ok(!nextCalled);
    assert.equal(res._status, 429);
    assert.equal(res._body.code, "DEMO_BLOCKED");
  });

  it("returns 503 during maintenance", () => {
    setDemoMaintenance("prj_demo_001", true);
    const req = fakeReq("GET");
    const res = fakeRes();
    demoRestMiddleware(req, res, fakeNext);

    assert.ok(!nextCalled);
    assert.equal(res._status, 503);
    assert.equal(res._headers["Retry-After"], "30");
  });
});

describe("demo middleware — signup", () => {
  beforeEach(() => {
    nextCalled = false;
    resetDemoCounters("prj_demo_001");
    setDemoMaintenance("prj_demo_001", false);
  });

  it("passes through for non-demo projects", () => {
    const req = fakeReq("POST", fakeProject({ demoMode: false }));
    const res = fakeRes();
    demoSignupMiddleware(req, res, fakeNext);
    assert.ok(nextCalled);
  });

  it("counts signups", () => {
    const req = fakeReq("POST");
    const res = fakeRes();
    demoSignupMiddleware(req, res, fakeNext);
    assert.ok(nextCalled);
    assert.equal(getDemoCounters("prj_demo_001").signups, 1);
  });

  it("blocks signup when limit reached", () => {
    const project = fakeProject({ demoConfig: { ...DEFAULT_DEMO_CONFIG, max_auth_users: 2 } });
    getDemoCounters("prj_demo_001").signups = 2;

    const req = fakeReq("POST", project);
    const res = fakeRes();
    demoSignupMiddleware(req, res, fakeNext);

    assert.ok(!nextCalled);
    assert.equal(res._status, 429);
    assert.equal(res._body.code, "DEMO_AUTH_USER_LIMIT");
    assert.equal(res._body.max, 2);
  });
});

describe("demo middleware — storage", () => {
  beforeEach(() => {
    nextCalled = false;
    resetDemoCounters("prj_demo_001");
    setDemoMaintenance("prj_demo_001", false);
  });

  it("passes through for non-demo projects", () => {
    const req = fakeReq("POST", fakeProject({ demoMode: false }));
    const res = fakeRes();
    demoStorageMiddleware(req, res, fakeNext);
    assert.ok(nextCalled);
  });

  it("allows GET requests without counting", () => {
    const req = fakeReq("GET");
    const res = fakeRes();
    demoStorageMiddleware(req, res, fakeNext);
    assert.ok(nextCalled);
    assert.equal(getDemoCounters("prj_demo_001").storageFiles, 0);
  });

  it("counts POST uploads", () => {
    const req = fakeReq("POST");
    const res = fakeRes();
    demoStorageMiddleware(req, res, fakeNext);
    assert.ok(nextCalled);
    assert.equal(getDemoCounters("prj_demo_001").storageFiles, 1);
  });

  it("blocks upload when limit reached", () => {
    const project = fakeProject({ demoConfig: { ...DEFAULT_DEMO_CONFIG, max_storage_files: 1 } });
    getDemoCounters("prj_demo_001").storageFiles = 1;

    const req = fakeReq("POST", project);
    const res = fakeRes();
    demoStorageMiddleware(req, res, fakeNext);

    assert.ok(!nextCalled);
    assert.equal(res._status, 429);
    assert.equal(res._body.code, "DEMO_STORAGE_FILE_LIMIT");
  });
});

describe("demo middleware — function invocations", () => {
  beforeEach(() => {
    nextCalled = false;
    resetDemoCounters("prj_demo_001");
    setDemoMaintenance("prj_demo_001", false);
  });

  it("passes through for non-demo projects", () => {
    const req = fakeReq("POST", fakeProject({ demoMode: false }));
    const res = fakeRes();
    demoFunctionInvokeMiddleware(req, res, fakeNext);
    assert.ok(nextCalled);
  });

  it("counts invocations", () => {
    const req = fakeReq("POST");
    const res = fakeRes();
    demoFunctionInvokeMiddleware(req, res, fakeNext);
    assert.ok(nextCalled);
    assert.equal(getDemoCounters("prj_demo_001").functionInvocations, 1);
  });

  it("blocks when limit reached", () => {
    const project = fakeProject({ demoConfig: { ...DEFAULT_DEMO_CONFIG, max_function_invocations: 5 } });
    getDemoCounters("prj_demo_001").functionInvocations = 5;

    const req = fakeReq("POST", project);
    const res = fakeRes();
    demoFunctionInvokeMiddleware(req, res, fakeNext);

    assert.ok(!nextCalled);
    assert.equal(res._status, 429);
    assert.equal(res._body.code, "DEMO_FUNCTION_INVOCATION_LIMIT");
  });
});

describe("demo middleware — blocked endpoints", () => {
  beforeEach(() => {
    nextCalled = false;
    resetDemoCounters("prj_demo_001");
    setDemoMaintenance("prj_demo_001", false);
  });

  it("passes through for non-demo projects", () => {
    const middleware = demoBlockedMiddleware("SQL execution");
    const req = fakeReq("POST", fakeProject({ demoMode: false }));
    const res = fakeRes();
    middleware(req, res, fakeNext);
    assert.ok(nextCalled);
  });

  it("blocks demo projects with 429", () => {
    const middleware = demoBlockedMiddleware("SQL execution");
    const req = fakeReq("POST");
    const res = fakeRes();
    middleware(req, res, fakeNext);

    assert.ok(!nextCalled);
    assert.equal(res._status, 429);
    assert.equal(res._body.code, "DEMO_BLOCKED");
    assert.ok(res._body.message.includes("SQL execution"));
  });

  it("includes fork info in blocked response", () => {
    const middleware = demoBlockedMiddleware("Secret management");
    const req = fakeReq("POST");
    const res = fakeRes();
    middleware(req, res, fakeNext);

    assert.equal(res._body.fork.version_id, "av_test123");
    assert.ok(res._body.fork.fork_url.includes("av_test123"));
  });
});

describe("demo middleware — response format", () => {
  beforeEach(() => {
    nextCalled = false;
    resetDemoCounters("prj_demo_001");
    setDemoMaintenance("prj_demo_001", false);
  });

  it("includes Retry-After header", () => {
    getDemoCounters("prj_demo_001").inserts = 50;
    const req = fakeReq("POST");
    const res = fakeRes();
    demoRestMiddleware(req, res, fakeNext);

    assert.ok(res._headers["Retry-After"]);
    const seconds = parseInt(res._headers["Retry-After"], 10);
    assert.ok(seconds > 0, "Retry-After is a positive number");
  });

  it("includes resets_at timestamp", () => {
    getDemoCounters("prj_demo_001").inserts = 50;
    const req = fakeReq("POST");
    const res = fakeRes();
    demoRestMiddleware(req, res, fakeNext);

    assert.ok(res._body.resets_at);
    const resetsAt = new Date(res._body.resets_at);
    assert.ok(resetsAt > new Date(), "resets_at is in the future");
  });

  it("includes fork info with version_id and fork_url", () => {
    getDemoCounters("prj_demo_001").inserts = 50;
    const req = fakeReq("POST");
    const res = fakeRes();
    demoRestMiddleware(req, res, fakeNext);

    assert.equal(res._body.fork.version_id, "av_test123");
    assert.equal(res._body.fork.fork_url, "https://run402.com/apps#av_test123");
  });

  it("omits fork info when no source version", () => {
    const project = fakeProject({ demoSourceVersionId: undefined });
    getDemoCounters("prj_demo_001").inserts = 50;
    const req = fakeReq("POST", project);
    const res = fakeRes();
    demoRestMiddleware(req, res, fakeNext);

    assert.equal(res._body.fork, undefined);
  });
});

describe("demo middleware — counter reset", () => {
  it("resetDemoCounters clears all counters", () => {
    const c = getDemoCounters("prj_demo_001");
    c.inserts = 10;
    c.deletes = 5;
    c.signups = 2;
    c.storageFiles = 3;
    c.functionInvocations = 7;

    resetDemoCounters("prj_demo_001");

    const fresh = getDemoCounters("prj_demo_001");
    assert.equal(fresh.inserts, 0);
    assert.equal(fresh.deletes, 0);
    assert.equal(fresh.signups, 0);
    assert.equal(fresh.storageFiles, 0);
    assert.equal(fresh.functionInvocations, 0);
  });
});

describe("demo middleware — maintenance mode", () => {
  beforeEach(() => {
    nextCalled = false;
    setDemoMaintenance("prj_demo_001", false);
  });

  it("returns 503 for all middleware during maintenance", () => {
    setDemoMaintenance("prj_demo_001", true);
    const project = fakeProject();

    const middlewares = [
      demoRestMiddleware,
      demoSignupMiddleware,
      demoStorageMiddleware,
      demoFunctionInvokeMiddleware,
    ];

    for (const mw of middlewares) {
      nextCalled = false;
      const req = fakeReq("POST", project);
      const res = fakeRes();
      mw(req, res, fakeNext);

      assert.ok(!nextCalled, `${mw.name} should not call next during maintenance`);
      assert.equal(res._status, 503, `${mw.name} should return 503`);
      assert.equal(res._headers["Retry-After"], "30");
    }
  });

  it("clears maintenance mode", () => {
    setDemoMaintenance("prj_demo_001", true);
    setDemoMaintenance("prj_demo_001", false);

    const req = fakeReq("GET");
    const res = fakeRes();
    demoRestMiddleware(req, res, fakeNext);
    assert.ok(nextCalled);
  });
});
