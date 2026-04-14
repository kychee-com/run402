/**
 * Scenario (multi-tick) tests for the lifecycle state machine.
 *
 * The existing project-lifecycle.test.ts covers each transition in isolation.
 * This file exercises the full composite flow — creating a project, walking
 * it through past_due → frozen → dormant → purged, and the reactivation
 * branch — using a stateful in-memory "DB" mock so we can verify the
 * sequencing and final-state assertions across many calls to advanceLifecycle().
 *
 * Time is simulated by directly mutating the timer columns on the mock rows
 * (e.g. set past_due_since to 15 days ago) rather than waiting real seconds.
 * This is exactly what a real-Postgres integration test would do.
 *
 * Scope: logic and sequencing only. Real Postgres integration (verifying the
 * actual SQL executes correctly against the real schema) is tracked as future
 * work — see tasks.md 10.7/10.8 notes.
 */

import { describe, it, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";

// ---------------------------------------------------------------------------
// Stateful in-memory DB: a minimal, query-pattern-matching simulator for the
// internal.projects and internal.subdomains tables. Only the queries that
// advanceLifecycle actually issues are handled.
// ---------------------------------------------------------------------------

interface ProjectRow {
  id: string;
  name: string;
  status: string;
  pinned: boolean;
  wallet_address: string;
  lease_expires_at: Date | null;
  past_due_since: Date | null;
  frozen_at: Date | null;
  dormant_at: Date | null;
  scheduled_purge_at: Date | null;
  purge_warning_sent_at: Date | null;
}

interface SubdomainRow {
  name: string;
  project_id: string;
  reserved_for_project_id: string | null;
  reserved_until: Date | null;
}

const projects = new Map<string, ProjectRow>();
const subdomains = new Map<string, SubdomainRow>();
const purgeCalls: string[] = [];

function reset(): void {
  projects.clear();
  subdomains.clear();
  purgeCalls.length = 0;
}

function setupProject(partial: Partial<ProjectRow> & { id: string }): void {
  projects.set(partial.id, {
    id: partial.id,
    name: partial.name ?? "TestProject",
    status: partial.status ?? "active",
    pinned: partial.pinned ?? false,
    wallet_address: partial.wallet_address ?? "0xwallet",
    lease_expires_at: partial.lease_expires_at ?? null,
    past_due_since: partial.past_due_since ?? null,
    frozen_at: partial.frozen_at ?? null,
    dormant_at: partial.dormant_at ?? null,
    scheduled_purge_at: partial.scheduled_purge_at ?? null,
    purge_warning_sent_at: partial.purge_warning_sent_at ?? null,
  });
}

// ---------------------------------------------------------------------------
// Query dispatcher: pattern-match the SQL that advanceLifecycle issues and
// apply the corresponding side effect against the mock state.
// ---------------------------------------------------------------------------

interface QueryResult { rows: unknown[]; rowCount: number }

function runQuery(sqlText: string, params?: unknown[]): QueryResult {
  const sqlNorm = sqlText.replace(/\s+/g, " ").trim();

  // --- active → past_due (wallet lease expired, non-pinned) ------------------
  if (sqlNorm.includes("status = 'past_due'") && sqlNorm.includes("past_due_since = NOW()") && sqlNorm.includes("RETURNING")) {
    const now = new Date();
    const changed: ProjectRow[] = [];
    for (const p of projects.values()) {
      if (p.status !== "active") continue;
      if (p.pinned) continue;
      if (!p.lease_expires_at || p.lease_expires_at.getTime() >= now.getTime()) continue;
      p.status = "past_due";
      p.past_due_since = now;
      changed.push({ ...p });
    }
    return { rows: changed, rowCount: changed.length };
  }

  // --- past_due → frozen (past_due_since < NOW() - 14 days) ------------------
  if (sqlNorm.includes("status = 'frozen'") && sqlNorm.includes("frozen_at = NOW()") && sqlNorm.includes("RETURNING")) {
    const cutoff = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
    const changed: ProjectRow[] = [];
    for (const p of projects.values()) {
      if (p.status !== "past_due") continue;
      if (!p.past_due_since || p.past_due_since.getTime() >= cutoff.getTime()) continue;
      p.status = "frozen";
      p.frozen_at = new Date();
      changed.push({ ...p });
    }
    return { rows: changed, rowCount: changed.length };
  }

  // --- frozen transition writes subdomain reservations -----------------------
  if (sqlNorm.includes("UPDATE internal.subdomains") && sqlNorm.includes("reserved_for_project_id = $1") &&
      sqlNorm.includes("reserved_until = NOW() + INTERVAL '104 days'")) {
    const projectId = params?.[0] as string;
    for (const s of subdomains.values()) {
      if (s.project_id === projectId) {
        s.reserved_for_project_id = projectId;
        s.reserved_until = new Date(Date.now() + 104 * 24 * 60 * 60 * 1000);
      }
    }
    return { rows: [], rowCount: 0 };
  }

  // --- frozen → dormant (frozen_at < NOW() - 30 days) ------------------------
  if (sqlNorm.includes("status = 'dormant'") && sqlNorm.includes("scheduled_purge_at = NOW() + INTERVAL '60 days'") && sqlNorm.includes("RETURNING")) {
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const changed: ProjectRow[] = [];
    for (const p of projects.values()) {
      if (p.status !== "frozen") continue;
      if (!p.frozen_at || p.frozen_at.getTime() >= cutoff.getTime()) continue;
      p.status = "dormant";
      p.dormant_at = new Date();
      p.scheduled_purge_at = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000);
      changed.push({ ...p });
    }
    return { rows: changed, rowCount: changed.length };
  }

  // --- dormant final warning (< 24h to purge, not yet warned) ----------------
  if (sqlNorm.includes("purge_warning_sent_at = NOW()") && sqlNorm.includes("RETURNING")) {
    const soon = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const changed: ProjectRow[] = [];
    for (const p of projects.values()) {
      if (p.status !== "dormant") continue;
      if (!p.scheduled_purge_at || p.scheduled_purge_at.getTime() >= soon.getTime()) continue;
      if (p.purge_warning_sent_at) continue;
      p.purge_warning_sent_at = new Date();
      changed.push({ ...p });
    }
    return { rows: changed, rowCount: changed.length };
  }

  // --- dormant → purging claim -----------------------------------------------
  if (sqlNorm.includes("status = 'purging'") && sqlNorm.includes("WHERE status = 'dormant'") && sqlNorm.includes("RETURNING")) {
    const now = Date.now();
    const changed: ProjectRow[] = [];
    for (const p of projects.values()) {
      if (p.status !== "dormant") continue;
      if (!p.scheduled_purge_at || p.scheduled_purge_at.getTime() > now) continue;
      p.status = "purging";
      changed.push({ ...p });
    }
    return { rows: changed, rowCount: changed.length };
  }

  // --- reactivation: → active, clear timers ---------------------------------
  if (sqlNorm.includes("status = 'active'") && sqlNorm.includes("past_due_since = NULL") &&
      sqlNorm.includes("status IN ('past_due', 'frozen', 'dormant')") && sqlNorm.includes("RETURNING")) {
    const id = params?.[0] as string;
    const p = projects.get(id);
    if (!p) return { rows: [], rowCount: 0 };
    if (p.status !== "past_due" && p.status !== "frozen" && p.status !== "dormant") {
      return { rows: [], rowCount: 0 };
    }
    p.status = "active";
    p.past_due_since = null;
    p.frozen_at = null;
    p.dormant_at = null;
    p.scheduled_purge_at = null;
    p.purge_warning_sent_at = null;
    return { rows: [{ id }], rowCount: 1 };
  }

  // --- clear subdomain reservations on reactivation --------------------------
  if (sqlNorm.includes("UPDATE internal.subdomains") && sqlNorm.includes("reserved_for_project_id = NULL") &&
      sqlNorm.includes("reserved_until = NULL")) {
    const id = params?.[0] as string;
    for (const s of subdomains.values()) {
      if (s.reserved_for_project_id === id) {
        s.reserved_for_project_id = null;
        s.reserved_until = null;
      }
    }
    return { rows: [], rowCount: 0 };
  }

  // --- wallet-scoped lookup (for advanceLifecycleForWallet) ------------------
  if (sqlNorm.includes("SELECT id FROM internal.projects") && sqlNorm.includes("LOWER(wallet_address) = LOWER($1)") &&
      sqlNorm.includes("past_due', 'frozen', 'dormant'")) {
    const wallet = (params?.[0] as string).toLowerCase();
    const matched: Array<{ id: string }> = [];
    for (const p of projects.values()) {
      if (p.wallet_address.toLowerCase() !== wallet) continue;
      if (p.status === "past_due" || p.status === "frozen" || p.status === "dormant") {
        matched.push({ id: p.id });
      }
    }
    return { rows: matched, rowCount: matched.length };
  }

  // --- billing email lookup (no email in these scenarios) --------------------
  if (sqlNorm.includes("primary_contact_email")) {
    return { rows: [], rowCount: 0 };
  }

  // BEGIN / COMMIT / ROLLBACK are no-ops in the mock
  if (/^(BEGIN|COMMIT|ROLLBACK)/.test(sqlNorm)) return { rows: [], rowCount: 0 };

  // Any unexpected query should fail loudly so we catch regressions
  throw new Error(`Unmatched query in scenario mock: ${sqlNorm.slice(0, 200)}`);
}

// ---------------------------------------------------------------------------
// Wire the mock into pool.connect / pool.query
// ---------------------------------------------------------------------------

const fakeClient = {
  async query(s: string, params?: unknown[]) { return runQuery(s, params); },
  release() {},
};

mock.module("../db/pool.js", {
  namedExports: {
    pool: {
      connect: async () => fakeClient,
      async query(s: string, params?: unknown[]) { return runQuery(s, params); },
    },
  },
});

mock.module("../db/sql.js", {
  namedExports: { sql: (s: string) => s },
});

// purgeProject records the call AND simulates the cascade
// (for scenario purposes: set status to 'purged' and drop the row's schema data).
mock.module("./projects.js", {
  namedExports: {
    purgeProject: async (id: string) => {
      purgeCalls.push(id);
      const p = projects.get(id);
      if (p) p.status = "purged";
      // In the real cascade, subdomains for this project are released.
      // Simulate: remove reservation, drop the project_id mapping.
      for (const s of subdomains.values()) {
        if (s.project_id === id) {
          s.reserved_for_project_id = null;
          s.reserved_until = null;
        }
      }
      return true;
    },
    projectCache: {
      get: () => undefined,
      delete: () => {},
      set: () => {},
    },
  },
});

mock.module("./platform-mail.js", {
  namedExports: {
    sendPlatformEmail: async () => { /* no-op in scenarios */ },
  },
});

mock.module("../config.js", {
  namedExports: { LIFECYCLE_ENABLED: true },
});

const {
  advanceLifecycle,
  advanceLifecycleForWallet,
} = await import("./project-lifecycle.js");

// ---------------------------------------------------------------------------
// Helpers to simulate time travel
// ---------------------------------------------------------------------------

function rewind(projectId: string, field: keyof ProjectRow, daysAgo: number): void {
  const p = projects.get(projectId);
  if (!p) throw new Error(`unknown project ${projectId}`);
  const past = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
  (p as unknown as Record<string, unknown>)[field] = past;
}

function expireLease(projectId: string): void {
  const p = projects.get(projectId);
  if (!p) throw new Error(`unknown project ${projectId}`);
  p.lease_expires_at = new Date(Date.now() - 1000); // 1s ago
}

function setScheduledPurgeToPast(projectId: string): void {
  const p = projects.get(projectId);
  if (!p) throw new Error(`unknown project ${projectId}`);
  p.scheduled_purge_at = new Date(Date.now() - 1000);
}

// ---------------------------------------------------------------------------
// Scenario 1 (task 10.8): full purge path
// ---------------------------------------------------------------------------

describe("SCENARIO: full purge path (10.8)", () => {
  beforeEach(reset);

  it("walks a project from active through all grace states to purged, releasing the subdomain", async () => {
    // Setup: an active project with a claimed subdomain
    setupProject({ id: "prj_purge", name: "Doomed", status: "active" });
    subdomains.set("doomed", {
      name: "doomed", project_id: "prj_purge",
      reserved_for_project_id: null, reserved_until: null,
    });

    // Tick 1: lease still valid → no change
    await advanceLifecycle();
    assert.equal(projects.get("prj_purge")!.status, "active");

    // Tick 2: expire lease → active → past_due
    expireLease("prj_purge");
    await advanceLifecycle();
    assert.equal(projects.get("prj_purge")!.status, "past_due");
    assert.ok(projects.get("prj_purge")!.past_due_since, "past_due_since must be stamped");
    assert.equal(subdomains.get("doomed")!.reserved_for_project_id, null, "not yet reserved at past_due");

    // Tick 3: 15 days later → past_due → frozen, subdomain gets reserved
    rewind("prj_purge", "past_due_since", 15);
    await advanceLifecycle();
    assert.equal(projects.get("prj_purge")!.status, "frozen");
    assert.ok(projects.get("prj_purge")!.frozen_at, "frozen_at must be stamped");
    assert.equal(subdomains.get("doomed")!.reserved_for_project_id, "prj_purge", "subdomain must be reserved on frozen");
    assert.ok(subdomains.get("doomed")!.reserved_until, "reserved_until must be stamped");

    // Tick 4: 31 days later → frozen → dormant, scheduled_purge_at gets stamped
    rewind("prj_purge", "frozen_at", 31);
    await advanceLifecycle();
    assert.equal(projects.get("prj_purge")!.status, "dormant");
    assert.ok(projects.get("prj_purge")!.scheduled_purge_at, "scheduled_purge_at must be stamped");

    // Tick 5: 23h before purge → final warning email stamped, no status change
    const beforeStatus = projects.get("prj_purge")!.status;
    // To simulate "23h before purge", set scheduled_purge_at to NOW + 23h
    projects.get("prj_purge")!.scheduled_purge_at = new Date(Date.now() + 23 * 60 * 60 * 1000);
    await advanceLifecycle();
    assert.equal(projects.get("prj_purge")!.status, beforeStatus, "still dormant after final warning");
    assert.ok(projects.get("prj_purge")!.purge_warning_sent_at, "warning must be stamped");

    // Tick 6: purge time elapsed → dormant → purging → purgeProject invoked
    setScheduledPurgeToPast("prj_purge");
    await advanceLifecycle();
    assert.deepEqual(purgeCalls, ["prj_purge"], "purgeProject must be called exactly once");
    assert.equal(projects.get("prj_purge")!.status, "purged", "final state");
  });

  it("does not double-purge on a second tick after the project is already purged", async () => {
    setupProject({
      id: "prj_done", status: "dormant",
      scheduled_purge_at: new Date(Date.now() - 1000),
    });
    await advanceLifecycle();
    assert.equal(projects.get("prj_done")!.status, "purged");
    assert.equal(purgeCalls.length, 1);

    // Second tick — purged rows must not match any transition
    await advanceLifecycle();
    assert.equal(purgeCalls.length, 1, "no double purge");
  });

  it("skips pinned projects entirely even with an expired lease", async () => {
    setupProject({
      id: "prj_pinned", status: "active", pinned: true,
      lease_expires_at: new Date(Date.now() - 1000),
    });
    // Tick many times
    for (let i = 0; i < 5; i++) await advanceLifecycle();
    assert.equal(projects.get("prj_pinned")!.status, "active", "pinned must stay active");
  });
});

// ---------------------------------------------------------------------------
// Scenario 2 (task 10.7): topup reactivates a grace-state project
// ---------------------------------------------------------------------------

describe("SCENARIO: topup-before-purge reactivation (10.7)", () => {
  beforeEach(reset);

  it("reactivates a frozen project, clearing timers and subdomain reservations", async () => {
    setupProject({ id: "prj_rescue", status: "active", wallet_address: "0xOwner" });
    subdomains.set("rescue", {
      name: "rescue", project_id: "prj_rescue",
      reserved_for_project_id: null, reserved_until: null,
    });

    // Drive into frozen state
    expireLease("prj_rescue");
    await advanceLifecycle();
    rewind("prj_rescue", "past_due_since", 15);
    await advanceLifecycle();
    assert.equal(projects.get("prj_rescue")!.status, "frozen");
    assert.equal(subdomains.get("rescue")!.reserved_for_project_id, "prj_rescue");

    // Owner pays → simulate tier renewal by firing advanceLifecycleForWallet
    await advanceLifecycleForWallet("0xOwner");

    // Assert reactivated
    const after = projects.get("prj_rescue")!;
    assert.equal(after.status, "active", "status should be active");
    assert.equal(after.past_due_since, null, "past_due_since cleared");
    assert.equal(after.frozen_at, null, "frozen_at cleared");
    assert.equal(after.dormant_at, null, "dormant_at cleared");
    assert.equal(after.scheduled_purge_at, null, "scheduled_purge_at cleared");
    assert.equal(after.purge_warning_sent_at, null, "purge_warning_sent_at cleared");
    assert.equal(subdomains.get("rescue")!.reserved_for_project_id, null, "subdomain reservation cleared");
    assert.equal(subdomains.get("rescue")!.reserved_until, null);
  });

  it("reactivates a dormant project even after the final warning was sent", async () => {
    // Owner paid on day 89 of 90
    setupProject({
      id: "prj_last_minute", status: "dormant", wallet_address: "0xLate",
      dormant_at: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000),
      scheduled_purge_at: new Date(Date.now() + 12 * 60 * 60 * 1000),
      purge_warning_sent_at: new Date(Date.now() - 11 * 60 * 60 * 1000),
    });

    await advanceLifecycleForWallet("0xLate");

    const after = projects.get("prj_last_minute")!;
    assert.equal(after.status, "active");
    assert.equal(after.scheduled_purge_at, null);
    assert.equal(after.purge_warning_sent_at, null, "final warning timestamp cleared too");
    assert.equal(purgeCalls.length, 0, "purge must not have fired");
  });

  it("reactivation with no projects in grace is a safe no-op", async () => {
    setupProject({ id: "prj_fine", status: "active", wallet_address: "0xHappy" });
    await advanceLifecycleForWallet("0xHappy");
    assert.equal(projects.get("prj_fine")!.status, "active");
  });
});

// ---------------------------------------------------------------------------
// Scenario 3: concurrent-tick race guard (the UPDATE ... RETURNING single-winner
// semantics are enforced in real Postgres; here we verify that a second tick
// observing already-transitioned state is a no-op).
// ---------------------------------------------------------------------------

describe("SCENARIO: idempotent ticks", () => {
  beforeEach(reset);

  it("a second tick on a project that just transitioned is a no-op", async () => {
    setupProject({ id: "prj_idem", status: "active", lease_expires_at: new Date(Date.now() - 1000) });

    await advanceLifecycle();
    assert.equal(projects.get("prj_idem")!.status, "past_due");
    const stampFirst = projects.get("prj_idem")!.past_due_since!.getTime();

    await advanceLifecycle();
    // past_due_since should not be rewritten — the row no longer matches status='active'
    assert.equal(projects.get("prj_idem")!.past_due_since!.getTime(), stampFirst);
  });
});
