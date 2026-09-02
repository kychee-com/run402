/**
 * `run402 messages wait` — the agent's ear (kygit-invite design D7).
 *
 * The SDK is mocked: what is under test is the CLI surface — argument
 * parsing, room resolution, presence arrival, output shaping (one JSON
 * document on stdout, narration on stderr), cursor persistence, and exit
 * code 0 on silence. Two `rooms.waitForMessages` fixtures stand in for the
 * two gateways the design names: one that HOLDS (settles with a message
 * after a short simulated delay, `waited_ms` present) and one that ANSWERS
 * AT ONCE (an older gateway — silence, `waited_ms` present but small,
 * matching what `rooms.waitForMessages` itself already normalizes both
 * shapes into before the CLI ever sees them). The CLI's own contract is
 * identical either way: one JSON document, narrated, exit 0.
 */
import { after, before, beforeEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const originalLog = console.log;
const originalError = console.error;
const originalExit = process.exit;
const originalCwd = process.cwd();

const ORG = "57035b1e-ec41-4ce6-a7a5-a5b2560efdd7";
const ROOM = "prj_fresh";

let stdout = [];
let stderr = [];
let calls = [];
let impl = {};

function presenceRegistration(overrides = {}) {
  return {
    presence_id: "prs_me", name: "Opus", task: null, program: "claude-code", model: null,
    state: "active", last_active: "2026-09-02T10:00:00.000Z", expires_at: "2026-09-02T11:00:00.000Z",
    ...overrides,
  };
}

function settledWaitResult(overrides = {}) {
  return {
    messages: [{
      message_id: "msg_1", cursor: "mcr_2", room_key: ROOM, sender: "Fable",
      body_snippet: "hey, joined and looking at the auth flow", body_truncated: false,
      thread_id: null, importance: "normal", ack_required: false, recipients: [], created_at: "2026-09-02T10:00:05.000Z",
    }],
    cursor: "mcr_2", has_more: false, settled: true, waited_ms: 3120,
    live_presences: [{ presence_id: "prs_other", name: "Fable", task: null, program: "codex", model: null, state: "active", last_active: "2026-09-02T10:00:05.000Z", expires_at: "2026-09-02T11:00:00.000Z" }],
    ...overrides,
  };
}

function silentWaitResult(overrides = {}) {
  return {
    messages: [], cursor: "mcr_1", has_more: false, settled: false, waited_ms: 120000,
    live_presences: [],
    ...overrides,
  };
}

mock.module("./cli/lib/sdk.mjs", {
  namedExports: {
    getSdk: () => ({
      rooms: {
        registerPresence: async (orgId, roomKey, opts) => {
          calls.push({ method: "rooms.registerPresence", orgId, roomKey, opts });
          return (impl.registerPresence ?? (async () => presenceRegistration()))(orgId, roomKey, opts);
        },
        getPresence: async (orgId, roomKey, presenceId) => {
          calls.push({ method: "rooms.getPresence", orgId, roomKey, presenceId });
          return (impl.getPresence ?? (async () => { throw Object.assign(new Error("not found"), { status: 404 }); }))(orgId, roomKey, presenceId);
        },
        waitForMessages: async (orgId, roomKey, opts) => {
          calls.push({ method: "rooms.waitForMessages", orgId, roomKey, opts });
          return (impl.waitForMessages ?? (async () => silentWaitResult()))(orgId, roomKey, opts);
        },
      },
    }),
  },
});

const { run } = await import("./cli/lib/messages.mjs");

function captureStart() {
  stdout = [];
  stderr = [];
  console.log = (...args) => stdout.push(args.map(String).join(" "));
  console.error = (...args) => stderr.push(args.map(String).join(" "));
}
function captureStop() {
  console.log = originalLog;
  console.error = originalError;
}

async function ok(sub, args = []) {
  captureStart();
  try {
    await run(sub, args);
  } finally {
    captureStop();
  }
  return JSON.parse(stdout.join("\n"));
}

async function expectFailure(sub, args = []) {
  captureStart();
  process.exit = (code) => { throw new Error(`process.exit(${code})`); };
  try {
    await assert.rejects(() => run(sub, args), /process\.exit/);
  } finally {
    captureStop();
    process.exit = originalExit;
  }
  return JSON.parse(stderr[stderr.length - 1]);
}

let scratch;
before(() => {
  scratch = mkdtempSync(join(tmpdir(), "run402-messages-wait-"));
});
after(() => {
  process.chdir(originalCwd);
  console.log = originalLog;
  console.error = originalError;
  process.exit = originalExit;
  rmSync(scratch, { recursive: true, force: true });
});
beforeEach(() => {
  calls = [];
  impl = {};
  process.chdir(scratch);
  // Fresh per-checkout messaging state each test — `.run402/messaging.json`
  // is what carries the persisted cursor across `wait` calls.
  rmSync(join(scratch, ".run402"), { recursive: true, force: true });
});

const ROOM_ARGS = ["--org", ORG, "--room", ROOM];

describe("run402 messages wait — a holding gateway (settles with a message)", () => {
  it("calls rooms.waitForMessages with the default 120s timeout, registers a presence, and prints one JSON document", async () => {
    impl.waitForMessages = async () => settledWaitResult();
    const payload = await ok("wait", ROOM_ARGS);
    const call = calls.find((c) => c.method === "rooms.waitForMessages");
    assert.ok(call, "rooms.waitForMessages must be called");
    assert.equal(call.orgId, ORG);
    assert.equal(call.roomKey, ROOM);
    assert.equal(call.opts.timeoutMs, 120_000);
    assert.equal(call.opts.presenceId, "prs_me");
    assert.deepEqual(payload, {
      messages: settledWaitResult().messages,
      cursor: "mcr_2",
      has_more: false,
      settled: true,
      waited_ms: 3120,
      live_presences: settledWaitResult().live_presences,
    });
  });

  it("registers this session's presence BEFORE waiting and narrates its name and the timeout on stderr", async () => {
    impl.waitForMessages = async () => settledWaitResult();
    await ok("wait", ROOM_ARGS);
    assert.ok(calls.find((c) => c.method === "rooms.registerPresence"));
    assert.ok(stderr.some((l) => l.includes(`waiting in ${ROOM} as Opus (timeout 120s)`)));
  });

  it("narrates how many messages arrived on stderr", async () => {
    impl.waitForMessages = async () => settledWaitResult();
    await ok("wait", ROOM_ARGS);
    assert.ok(stderr.some((l) => l === "1 message(s) arrived."));
  });

  it("persists the returned cursor so the NEXT wait resumes past it, with no --cursor flag", async () => {
    impl.waitForMessages = async () => settledWaitResult();
    await ok("wait", ROOM_ARGS);
    let secondCallCursor = null;
    impl.waitForMessages = async (orgId, roomKey, opts) => {
      secondCallCursor = opts.cursor;
      return silentWaitResult({ cursor: "mcr_2" });
    };
    await ok("wait", ROOM_ARGS);
    assert.equal(secondCallCursor, "mcr_2", "the second wait must resume from the cursor the first one returned");
  });

  it("--cursor overrides the stored cursor", async () => {
    impl.waitForMessages = async () => settledWaitResult();
    await ok("wait", ROOM_ARGS); // persists mcr_2
    let secondCallCursor = null;
    impl.waitForMessages = async (orgId, roomKey, opts) => {
      secondCallCursor = opts.cursor;
      return silentWaitResult();
    };
    await ok("wait", [...ROOM_ARGS, "--cursor", "mcr_explicit"]);
    assert.equal(secondCallCursor, "mcr_explicit");
  });

  it("--thread threads through as threadId", async () => {
    impl.waitForMessages = async () => settledWaitResult();
    await ok("wait", [...ROOM_ARGS, "--thread", "thr_1"]);
    const call = calls.find((c) => c.method === "rooms.waitForMessages");
    assert.equal(call.opts.threadId, "thr_1");
  });

  it("--addressed-to me threads through as addressedTo", async () => {
    impl.waitForMessages = async () => settledWaitResult();
    await ok("wait", [...ROOM_ARGS, "--addressed-to", "me"]);
    const call = calls.find((c) => c.method === "rooms.waitForMessages");
    assert.equal(call.opts.addressedTo, "me");
  });

  it("--addressed-to with any other value is refused locally, before the SDK is ever called", async () => {
    const envelope = await expectFailure("wait", [...ROOM_ARGS, "--addressed-to", "someone"]);
    assert.equal(envelope.code, "BAD_FLAG");
    assert.equal(calls.find((c) => c.method === "rooms.waitForMessages"), undefined);
  });

  it("--timeout threads through as timeoutMs (seconds * 1000)", async () => {
    impl.waitForMessages = async () => settledWaitResult();
    await ok("wait", [...ROOM_ARGS, "--timeout", "45"]);
    const call = calls.find((c) => c.method === "rooms.waitForMessages");
    assert.equal(call.opts.timeoutMs, 45_000);
    assert.ok(stderr.some((l) => l.includes("(timeout 45s)")));
  });

  it("--timeout above 600 (the coding-harness shell-call ceiling) is refused locally", async () => {
    const envelope = await expectFailure("wait", [...ROOM_ARGS, "--timeout", "601"]);
    assert.equal(envelope.code, "BAD_FLAG");
    assert.equal(calls.find((c) => c.method === "rooms.waitForMessages"), undefined);
  });

  it("--timeout of 0 or below is refused locally", async () => {
    const envelope = await expectFailure("wait", [...ROOM_ARGS, "--timeout", "0"]);
    assert.equal(envelope.code, "BAD_FLAG");
  });
});

describe("run402 messages wait — an older gateway that answers at once (silence)", () => {
  it("exits 0 with an empty messages[], settled:false, the SAME cursor, and live_presences on stdout — never an error", async () => {
    impl.waitForMessages = async (orgId, roomKey, opts) => silentWaitResult({ cursor: opts.cursor ?? "mcr_1" });
    const payload = await ok("wait", ROOM_ARGS);
    assert.deepEqual(payload.messages, []);
    assert.equal(payload.settled, false);
    assert.equal(payload.cursor, "mcr_1");
    assert.deepEqual(payload.live_presences, []);
  });

  it("narrates silence with who is still live", async () => {
    impl.waitForMessages = async () => silentWaitResult({
      live_presences: [{ presence_id: "prs_other", name: "Fable", task: null, program: null, model: null, state: "active", last_active: "x", expires_at: "y" }],
    });
    await ok("wait", ROOM_ARGS);
    assert.ok(stderr.some((l) => l.includes("silence") && l.includes("Fable")));
  });

  it("narrates silence with nobody live when live_presences is empty", async () => {
    impl.waitForMessages = async () => silentWaitResult({ live_presences: [] });
    await ok("wait", ROOM_ARGS);
    assert.ok(stderr.some((l) => l.includes("nobody else is currently live")));
  });

  it("never sets a non-zero exit code on silence", async () => {
    impl.waitForMessages = async () => silentWaitResult();
    const originalExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      await ok("wait", ROOM_ARGS);
      assert.equal(process.exitCode, undefined);
    } finally {
      process.exitCode = originalExitCode;
    }
  });
});

describe("run402 messages wait — --help", () => {
  it("teaches the wait verb without any other docs", async () => {
    captureStart();
    process.exit = () => { throw new Error("process.exit"); };
    try {
      await assert.rejects(() => run("wait", ["--help"]));
    } finally {
      captureStop();
      process.exit = originalExit;
    }
    const text = stdout.join("\n");
    assert.match(text, /messages wait/);
  });
});
