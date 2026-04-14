import { describe, it, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";

// ---------------------------------------------------------------------------
// Mock dependencies before importing the module under test
// ---------------------------------------------------------------------------

let mockPoolQuery: (...args: any[]) => Promise<any>;

mock.module("../db/pool.js", {
  namedExports: {
    pool: {
      query: (...args: any[]) => mockPoolQuery(...args),
    },
  },
});

mock.module("../db/sql.js", {
  namedExports: {
    sql: (s: string) => s,
  },
});

let lastInvoke: { projectId: string; name: string; method: string; headers: Record<string, string>; body: string } | null = null;
mock.module("./functions.js", {
  namedExports: {
    invokeFunction: async (projectId: string, name: string, method: string, path: string, headers: Record<string, string>, body: string) => {
      lastInvoke = { projectId, name, method, headers, body };
      return { statusCode: 200, headers: {}, body: '{"ok":true}' };
    },
  },
});

mock.module("../middleware/metering.js", {
  namedExports: {
    incrementProjectCalls: () => {},
    getProjectCallCount: () => 0,
  },
});

mock.module("../config.js", {
  namedExports: {
    LAMBDA_ROLE_ARN: undefined,
    LAMBDA_LAYER_ARN: undefined,
    LAMBDA_SUBNET_IDS: undefined,
    LAMBDA_SG_ID: undefined,
    FUNCTIONS_LOG_GROUP: undefined,
    S3_REGION: "us-east-1",
    JWT_SECRET: "test-secret",
  },
});

const {
  isValidCron,
  getCronIntervalMinutes,
  registerSchedule,
  cancelSchedule,
  cancelAll,
  triggerFunction,
  startScheduler,
  stopScheduler,
  scheduledInvocationAllowed,
} = await import("./scheduler.js");

// ---------------------------------------------------------------------------
// isValidCron
// ---------------------------------------------------------------------------

describe("isValidCron", () => {
  it("accepts standard 5-field cron", () => {
    assert.ok(isValidCron("*/15 * * * *"));
    assert.ok(isValidCron("0 9 * * 1"));
    assert.ok(isValidCron("0 0 1 1 *"));
    assert.ok(isValidCron("* * * * *"));
  });

  it("rejects invalid expressions", () => {
    assert.ok(!isValidCron("not-a-cron"));
    assert.ok(!isValidCron(""));
    assert.ok(!isValidCron("60 * * * *"));
    assert.ok(!isValidCron("* * * *")); // only 4 fields
  });
});

// ---------------------------------------------------------------------------
// getCronIntervalMinutes
// ---------------------------------------------------------------------------

describe("getCronIntervalMinutes", () => {
  it("returns 15 for */15 * * * *", () => {
    const interval = getCronIntervalMinutes("*/15 * * * *");
    assert.equal(interval, 15);
  });

  it("returns 5 for */5 * * * *", () => {
    const interval = getCronIntervalMinutes("*/5 * * * *");
    assert.equal(interval, 5);
  });

  it("returns 1 for * * * * *", () => {
    const interval = getCronIntervalMinutes("* * * * *");
    assert.equal(interval, 1);
  });

  it("returns 60 for 0 * * * *", () => {
    const interval = getCronIntervalMinutes("0 * * * *");
    assert.equal(interval, 60);
  });

  it("returns 0 for invalid expression", () => {
    const interval = getCronIntervalMinutes("bad");
    assert.equal(interval, 0);
  });
});

// ---------------------------------------------------------------------------
// registerSchedule / cancelSchedule / cancelAll
// ---------------------------------------------------------------------------

describe("registerSchedule / cancelSchedule", () => {
  beforeEach(() => {
    cancelAll();
  });

  it("registers and cancels a schedule without error", () => {
    assert.doesNotThrow(() => registerSchedule("proj1", "fn1", "*/15 * * * *"));
    assert.doesNotThrow(() => cancelSchedule("proj1", "fn1"));
  });

  it("cancelAll stops all timers", () => {
    registerSchedule("proj1", "fn1", "*/15 * * * *");
    registerSchedule("proj2", "fn2", "0 * * * *");
    assert.doesNotThrow(() => cancelAll());
  });

  it("re-registering cancels the old timer", () => {
    registerSchedule("proj1", "fn1", "*/15 * * * *");
    assert.doesNotThrow(() => registerSchedule("proj1", "fn1", "*/5 * * * *"));
    cancelAll();
  });

  it("cancelling a non-existent schedule is a no-op", () => {
    assert.doesNotThrow(() => cancelSchedule("nonexistent", "nope"));
  });
});

// ---------------------------------------------------------------------------
// triggerFunction
// ---------------------------------------------------------------------------

describe("triggerFunction", () => {
  beforeEach(() => {
    lastInvoke = null;
    mockPoolQuery = async (query: string, params?: any[]) => {
      if (query.includes("SELECT schedule FROM internal.functions")) {
        return { rows: [{ schedule: "*/15 * * * *" }] };
      }
      // schedule_meta update
      return { rows: [] };
    };
  });

  it("invokes the function and returns status + body", async () => {
    const result = await triggerFunction("proj1", "send-reminders");
    assert.equal(result.status, 200);
    assert.equal(result.body, '{"ok":true}');
    assert.ok(lastInvoke);
    assert.equal(lastInvoke!.projectId, "proj1");
    assert.equal(lastInvoke!.name, "send-reminders");
    assert.equal(lastInvoke!.method, "POST");
    assert.equal(lastInvoke!.headers["x-run402-trigger"], "manual");
  });

  it("throws if function not found", async () => {
    mockPoolQuery = async () => ({ rows: [] });
    await assert.rejects(
      () => triggerFunction("proj1", "nonexistent"),
      { message: "Function not found" },
    );
  });
});

// ---------------------------------------------------------------------------
// startScheduler
// ---------------------------------------------------------------------------

describe("startScheduler", () => {
  beforeEach(() => {
    cancelAll();
  });

  it("loads scheduled functions from DB and registers timers", async () => {
    mockPoolQuery = async () => ({
      rows: [
        { project_id: "p1", name: "fn1", schedule: "*/15 * * * *" },
        { project_id: "p2", name: "fn2", schedule: "0 * * * *" },
      ],
    });

    await startScheduler();
    // Clean up
    stopScheduler();
  });

  it("handles empty result gracefully", async () => {
    mockPoolQuery = async () => ({ rows: [] });
    await startScheduler();
    stopScheduler();
  });
});

// ---------------------------------------------------------------------------
// Tier limit validation (tested indirectly via cron interval helpers)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// scheduledInvocationAllowed — lifecycle gating
// ---------------------------------------------------------------------------

describe("scheduledInvocationAllowed", () => {
  it("allows active, past_due, and frozen projects", () => {
    assert.equal(scheduledInvocationAllowed("active"), true);
    assert.equal(scheduledInvocationAllowed("past_due"), true);
    assert.equal(scheduledInvocationAllowed("frozen"), true);
  });

  it("blocks dormant projects (scheduled functions paused)", () => {
    assert.equal(scheduledInvocationAllowed("dormant"), false);
  });

  it("blocks terminal states (purging, purged, archived)", () => {
    assert.equal(scheduledInvocationAllowed("purging"), false);
    assert.equal(scheduledInvocationAllowed("purged"), false);
    assert.equal(scheduledInvocationAllowed("archived"), false);
  });

  it("blocks unknown statuses by default", () => {
    assert.equal(scheduledInvocationAllowed("deleted"), false);
    assert.equal(scheduledInvocationAllowed("expired"), false);
    assert.equal(scheduledInvocationAllowed(""), false);
  });
});

describe("tier limit enforcement helpers", () => {
  it("every-minute schedule has interval of 1", () => {
    assert.equal(getCronIntervalMinutes("* * * * *"), 1);
  });

  it("prototype tier minimum (15min) would reject */5", () => {
    const interval = getCronIntervalMinutes("*/5 * * * *");
    const prototypeMin = 15;
    assert.ok(interval < prototypeMin, `${interval} should be less than ${prototypeMin}`);
  });

  it("hobby tier minimum (5min) would accept */5", () => {
    const interval = getCronIntervalMinutes("*/5 * * * *");
    const hobbyMin = 5;
    assert.ok(interval >= hobbyMin, `${interval} should be >= ${hobbyMin}`);
  });

  it("team tier minimum (1min) would accept every minute", () => {
    const interval = getCronIntervalMinutes("* * * * *");
    const teamMin = 1;
    assert.ok(interval >= teamMin, `${interval} should be >= ${teamMin}`);
  });
});
