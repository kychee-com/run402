import { describe, it, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";

// ---------------------------------------------------------------------------
// Mock dependencies before importing the module under test
// ---------------------------------------------------------------------------

const projectCacheStore = new Map<string, { id: string; status: string }>();
mock.module("../services/projects.js", {
  namedExports: {
    projectCache: {
      get: (id: string) => projectCacheStore.get(id),
    },
    getProjectById: async (id: string) => projectCacheStore.get(id) ?? null,
    isServingStatus: (s: string) =>
      s === "active" || s === "past_due" || s === "frozen" || s === "dormant",
  },
});

mock.module("../services/project-lifecycle.js", {
  namedExports: {
    PAST_DUE_DURATION_MS: 14 * 24 * 60 * 60 * 1000,
    FROZEN_DURATION_MS: 30 * 24 * 60 * 60 * 1000,
  },
});

const timerRows = new Map<string, Record<string, unknown>>();
mock.module("../db/pool.js", {
  namedExports: {
    pool: {
      async query(_sql: string, params?: unknown[]) {
        const id = params?.[0] as string;
        const row = timerRows.get(id);
        return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
      },
    },
  },
});

mock.module("../db/sql.js", {
  namedExports: {
    sql: (s: string) => s,
  },
});

const { lifecycleGate } = await import("./lifecycle-gate.js");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type ResStub = { statusCode: number; body: unknown; status: (n: number) => { json: (b: unknown) => void }; json: (b: unknown) => void };

function makeReq(
  method: string,
  opts: { projectId?: string; isAdmin?: boolean; params?: Record<string, string>; body?: unknown } = {},
): Record<string, unknown> {
  return {
    method,
    headers: {},
    params: opts.params ?? (opts.projectId ? { id: opts.projectId } : {}),
    project: opts.projectId ? projectCacheStore.get(opts.projectId) : undefined,
    tokenPayload: undefined,
    isAdmin: !!opts.isAdmin,
    body: opts.body ?? null,
  };
}

function makeRes(): ResStub {
  const res = {
    statusCode: 0,
    body: null as unknown,
    status(n: number) { res.statusCode = n; return { json: (b: unknown) => { res.body = b; } }; },
    json(b: unknown) { res.body = b; },
  } as ResStub;
  return res;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("lifecycleGate", () => {
  beforeEach(() => {
    projectCacheStore.clear();
    timerRows.clear();
  });

  it("allows mutating request on active project", async () => {
    projectCacheStore.set("prj_a", { id: "prj_a", status: "active" });
    const res = makeRes();
    let nextCalled = false;
    await lifecycleGate(makeReq("POST", { projectId: "prj_a" }) as never, res as never, () => { nextCalled = true; });
    assert.equal(nextCalled, true);
    assert.equal(res.statusCode, 0);
  });

  it("blocks mutating request on past_due project with 402", async () => {
    projectCacheStore.set("prj_b", { id: "prj_b", status: "past_due" });
    timerRows.set("prj_b", { past_due_since: "2026-04-01T00:00:00Z", frozen_at: null, dormant_at: null, scheduled_purge_at: null });
    const res = makeRes();
    let nextCalled = false;
    await lifecycleGate(makeReq("POST", { projectId: "prj_b" }) as never, res as never, () => { nextCalled = true; });
    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 402);
    const body = res.body as Record<string, unknown>;
    assert.equal(body["lifecycle_state"], "past_due");
    assert.equal(body["entered_state_at"], "2026-04-01T00:00:00Z");
    assert.ok(typeof body["next_transition_at"] === "string", "should include next transition timestamp");
  });

  it("blocks mutating request on frozen project with 402", async () => {
    projectCacheStore.set("prj_c", { id: "prj_c", status: "frozen" });
    timerRows.set("prj_c", { past_due_since: null, frozen_at: "2026-04-10T00:00:00Z", dormant_at: null, scheduled_purge_at: null });
    const res = makeRes();
    let nextCalled = false;
    await lifecycleGate(makeReq("POST", { projectId: "prj_c" }) as never, res as never, () => { nextCalled = true; });
    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 402);
    assert.equal((res.body as Record<string, unknown>)["lifecycle_state"], "frozen");
  });

  it("blocks mutating request on dormant project with 402 and dormant's scheduled_purge_at as next_transition_at", async () => {
    projectCacheStore.set("prj_d", { id: "prj_d", status: "dormant" });
    timerRows.set("prj_d", { past_due_since: null, frozen_at: null, dormant_at: "2026-04-01T00:00:00Z", scheduled_purge_at: "2026-06-01T00:00:00Z" });
    const res = makeRes();
    await lifecycleGate(makeReq("POST", { projectId: "prj_d" }) as never, res as never, () => {});
    assert.equal(res.statusCode, 402);
    const body = res.body as Record<string, unknown>;
    assert.equal(body["lifecycle_state"], "dormant");
    assert.equal(body["next_transition_at"], new Date("2026-06-01T00:00:00Z").toISOString());
  });

  it("bypasses gate on GET requests even for non-active projects", async () => {
    projectCacheStore.set("prj_e", { id: "prj_e", status: "frozen" });
    const res = makeRes();
    let nextCalled = false;
    await lifecycleGate(makeReq("GET", { projectId: "prj_e" }) as never, res as never, () => { nextCalled = true; });
    assert.equal(nextCalled, true);
    assert.equal(res.statusCode, 0);
  });

  it("bypasses gate on HEAD and OPTIONS requests", async () => {
    projectCacheStore.set("prj_f", { id: "prj_f", status: "dormant" });
    for (const method of ["HEAD", "OPTIONS"]) {
      const res = makeRes();
      let nextCalled = false;
      await lifecycleGate(makeReq(method, { projectId: "prj_f" }) as never, res as never, () => { nextCalled = true; });
      assert.equal(nextCalled, true, `${method} must bypass gate`);
      assert.equal(res.statusCode, 0);
    }
  });

  it("bypasses gate when caller is admin (req.isAdmin=true) even on frozen project", async () => {
    projectCacheStore.set("prj_g", { id: "prj_g", status: "frozen" });
    const res = makeRes();
    let nextCalled = false;
    await lifecycleGate(makeReq("POST", { projectId: "prj_g", isAdmin: true }) as never, res as never, () => { nextCalled = true; });
    assert.equal(nextCalled, true);
    assert.equal(res.statusCode, 0);
  });

  it("passes through when no project id can be resolved from req", async () => {
    const res = makeRes();
    let nextCalled = false;
    await lifecycleGate(makeReq("POST", { params: {} }) as never, res as never, () => { nextCalled = true; });
    assert.equal(nextCalled, true);
    assert.equal(res.statusCode, 0);
  });

  it("resolves project id from req.params.projectId as alternative to req.params.id", async () => {
    projectCacheStore.set("prj_h", { id: "prj_h", status: "past_due" });
    timerRows.set("prj_h", { past_due_since: "2026-04-01T00:00:00Z", frozen_at: null, dormant_at: null, scheduled_purge_at: null });
    const res = makeRes();
    await lifecycleGate(
      makeReq("POST", { params: { projectId: "prj_h" } }) as never,
      res as never,
      () => {},
    );
    assert.equal(res.statusCode, 402);
  });
});
