/**
 * rooms-context.mjs's session-identity wiring (presence-naming-ergonomics).
 *
 * harness-context.mjs's resolution chain is unit-tested on its own
 * (cli-harness-context.test.mjs). This file proves the layer ABOVE it: that
 * rooms-context.mjs actually THREADS the resolved session key onto every
 * coordination call — registration, and the (presenceId, sessionKey) pair
 * withPresenceRetry hands to send/list/ack/claim, including across the
 * PRESENCE_EXPIRED retry path — and that it resolves the key ONCE per
 * process rather than re-deriving it on every call.
 */
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const FIXED_SESSION_KEY = "test-fixed-session-key-123";
const ORG = "aaaaaaaa-1111-1111-1111-aaaaaaaaaaaa";
const ROOM = "prj_1";

let registerCalls = [];
let registerImpl = async () => ({ presence_id: "prs_1", name: "GreenCastle", state: "active" });

mock.module("./cli/lib/sdk.mjs", {
  namedExports: {
    getSdk: () => ({
      rooms: {
        registerPresence: async (orgId, roomKey, opts) => {
          registerCalls.push({ orgId, roomKey, opts });
          return registerImpl(orgId, roomKey, opts);
        },
      },
    }),
  },
});

const originalEnv = { ...process.env };
const originalCwd = process.cwd();
let tempDir;

beforeEach(() => {
  registerCalls = [];
  registerImpl = async () => ({ presence_id: "prs_1", name: "GreenCastle", state: "active" });
  process.env.RUN402_SESSION_KEY = FIXED_SESSION_KEY;
  delete process.env.RUN402_PRESENCE_ID;
  delete process.env.CLAUDE_CODE_SESSION_ID;
  delete process.env.CODEX_THREAD_ID;
  // withPresenceRetry/registerFreshPresence read+write ./.run402/messaging.json
  // relative to process.cwd() — isolate every test in its own temp checkout so
  // none of this ever touches the real worktree.
  tempDir = mkdtempSync(join(tmpdir(), "run402-roomsctx-"));
  process.chdir(tempDir);
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(tempDir, { recursive: true, force: true });
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key];
  }
  Object.assign(process.env, originalEnv);
});

describe("registerFreshPresence carries this session's resolved identity", () => {
  it("sends sessionKey on the SDK call", async () => {
    const { registerFreshPresence } = await import("./cli/lib/rooms-context.mjs");
    await registerFreshPresence(ORG, ROOM, { name: "Opus", task: "migrating auth" });
    assert.equal(registerCalls.length, 1);
    assert.equal(registerCalls[0].opts.sessionKey, FIXED_SESSION_KEY);
    assert.equal(registerCalls[0].opts.requestedName, "Opus");
    assert.equal(registerCalls[0].opts.task, "migrating auth");
  });

  it("resolves the session key ONCE per process — two calls carry the identical value", async () => {
    const { registerFreshPresence } = await import("./cli/lib/rooms-context.mjs");
    await registerFreshPresence(ORG, ROOM, {});
    await registerFreshPresence(ORG, "prj_2", {});
    assert.equal(registerCalls.length, 2);
    assert.equal(registerCalls[0].opts.sessionKey, registerCalls[1].opts.sessionKey);
    assert.equal(registerCalls[0].opts.sessionKey, FIXED_SESSION_KEY);
  });
});

describe("withPresenceRetry hands the resolved session key to every call", () => {
  it("passes (presenceId, sessionKey) to the callback on the first attempt — no cache yet, presenceId is null", async () => {
    const { withPresenceRetry } = await import("./cli/lib/rooms-context.mjs");
    let seen;
    await withPresenceRetry(ORG, ROOM, (presenceId, sessionKey) => {
      seen = { presenceId, sessionKey };
      return Promise.resolve({ ok: true });
    });
    assert.deepEqual(seen, { presenceId: null, sessionKey: FIXED_SESSION_KEY });
  });

  it("passes a cached presenceId ALONGSIDE the same session key", async () => {
    const { withPresenceRetry, updateRoomState } = await import("./cli/lib/rooms-context.mjs");
    updateRoomState(ORG, ROOM, { presence_id: "prs_cached" });
    let seen;
    await withPresenceRetry(ORG, ROOM, (presenceId, sessionKey) => {
      seen = { presenceId, sessionKey };
      return Promise.resolve({ ok: true });
    });
    assert.deepEqual(seen, { presenceId: "prs_cached", sessionKey: FIXED_SESSION_KEY });
  });

  it("on PRESENCE_EXPIRED, re-registers with the SAME session key and retries with it too", async () => {
    const { withPresenceRetry, updateRoomState } = await import("./cli/lib/rooms-context.mjs");
    updateRoomState(ORG, ROOM, { presence_id: "prs_stale" });
    registerImpl = async () => ({ presence_id: "prs_fresh", name: "GreenCastle-2", state: "active" });

    let attempt = 0;
    const retrySeen = [];
    const result = await withPresenceRetry(ORG, ROOM, (presenceId, sessionKey) => {
      attempt += 1;
      retrySeen.push({ presenceId, sessionKey });
      if (attempt === 1) {
        const err = new Error("presence expired");
        err.body = { code: "PRESENCE_EXPIRED" };
        throw err;
      }
      return Promise.resolve({ ok: true });
    });

    assert.equal(attempt, 2, "the callback ran once, failed, then ran again after re-registration");
    assert.deepEqual(result, { ok: true });
    // Both the failed first attempt and the successful retry carried the
    // SAME session key — the point is that resumption identity never
    // changes mid-call, only the presence_id does (stale -> freshly issued).
    assert.equal(retrySeen[0].sessionKey, FIXED_SESSION_KEY);
    assert.equal(retrySeen[1].sessionKey, FIXED_SESSION_KEY);
    assert.equal(retrySeen[0].presenceId, "prs_stale");
    assert.equal(retrySeen[1].presenceId, "prs_fresh");
    // The re-registration call itself also carried the same session key.
    assert.equal(registerCalls.length, 1);
    assert.equal(registerCalls[0].opts.sessionKey, FIXED_SESSION_KEY);
  });
});
