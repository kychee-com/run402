/**
 * rooms-shared.ts's session-identity wiring (presence-naming-ergonomics).
 *
 * harness-context.ts's resolution chain is unit-tested on its own
 * (../harness-context.test.ts). This file proves the layer ABOVE it: that
 * withPresenceRetry actually THREADS the resolved session key onto every
 * call — the (presenceId, sessionKey) pair its callback receives, and the
 * SAME pair on the PRESENCE_EXPIRED retry path — and that it resolves the
 * key ONCE per server process (getSessionKey's memoization) rather than
 * re-deriving it on every tool call.
 */
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";

const FIXED_SESSION_KEY = "test-fixed-mcp-session-key-123";

let registerCalls: Array<{ orgId: string; roomKey: string; opts: unknown }> = [];
let registerImpl: () => Promise<unknown> = async () => ({ presence_id: "prs_1", name: "GreenCastle", state: "active" });

mock.module("../sdk.js", {
  namedExports: {
    getSdk: () => ({
      rooms: {
        registerPresence: async (orgId: string, roomKey: string, opts: unknown) => {
          registerCalls.push({ orgId, roomKey, opts });
          return registerImpl();
        },
      },
    }),
  },
});

const { withPresenceRetry, forgetPresence } = await import("./rooms-shared.js");
const { _resetSessionKeyForTests } = await import("../harness-context.js");

const ROOM = { orgId: "aaaaaaaa-1111-1111-1111-aaaaaaaaaaaa", roomKey: "prj_1" };
const originalEnv = { ...process.env };

beforeEach(() => {
  registerCalls = [];
  registerImpl = async () => ({ presence_id: "prs_1", name: "GreenCastle", state: "active" });
  process.env.RUN402_SESSION_KEY = FIXED_SESSION_KEY;
  delete process.env.RUN402_PRESENCE_ID;
  delete process.env.CLAUDE_CODE_SESSION_ID;
  delete process.env.CODEX_THREAD_ID;
  _resetSessionKeyForTests();
});

afterEach(() => {
  forgetPresence(ROOM);
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key];
  }
  Object.assign(process.env, originalEnv);
  _resetSessionKeyForTests();
});

describe("withPresenceRetry hands the resolved session key to every call", () => {
  it("passes (presenceId, sessionKey) to the callback — no cache yet, presenceId is undefined", async () => {
    let seen: { presenceId: string | undefined; sessionKey: string } | undefined;
    await withPresenceRetry(ROOM, (presenceId, sessionKey) => {
      seen = { presenceId, sessionKey };
      return Promise.resolve({ ok: true });
    });
    assert.deepEqual(seen, { presenceId: undefined, sessionKey: FIXED_SESSION_KEY });
  });

  it("resolves the session key ONCE per server process — two calls in different rooms carry the identical value", async () => {
    let firstKey: string | undefined;
    let secondKey: string | undefined;
    await withPresenceRetry(ROOM, (_presenceId, sessionKey) => {
      firstKey = sessionKey;
      return Promise.resolve(null);
    });
    await withPresenceRetry({ orgId: ROOM.orgId, roomKey: "prj_2" }, (_presenceId, sessionKey) => {
      secondKey = sessionKey;
      return Promise.resolve(null);
    });
    assert.equal(firstKey, FIXED_SESSION_KEY);
    assert.equal(secondKey, FIXED_SESSION_KEY);
  });

  it("on PRESENCE_EXPIRED with NO cached presenceId, the error propagates instead of retrying (nothing to retry with)", async () => {
    let attempt = 0;
    const retrySeen: Array<{ presenceId: string | undefined; sessionKey: string }> = [];
    await assert.rejects(
      () => withPresenceRetry({ orgId: ROOM.orgId, roomKey: "prj_3" }, (presenceId, sessionKey) => {
        attempt += 1;
        retrySeen.push({ presenceId, sessionKey });
        const err = new Error("presence expired") as Error & { body: { code: string } };
        err.body = { code: "PRESENCE_EXPIRED" };
        throw err;
      }),
      /presence expired/,
    );
    // Ran exactly once — the retry branch requires a truthy cached
    // presenceId, so with none the thrown error just propagates.
    assert.equal(attempt, 1);
    assert.equal(retrySeen[0]?.sessionKey, FIXED_SESSION_KEY);
    assert.equal(registerCalls.length, 0, "no re-registration attempt without a presenceId to have expired");
  });

  it("on PRESENCE_EXPIRED with a cached presenceId, the callback runs twice, both times carrying the same session key", async () => {
    const { rememberPresence } = await import("./rooms-shared.js");
    const room = { orgId: ROOM.orgId, roomKey: "prj_4" };
    rememberPresence(room, { presence_id: "prs_stale" });
    registerImpl = async () => ({ presence_id: "prs_fresh", name: "GreenCastle-2", state: "active" });

    let attempt = 0;
    const retrySeen: Array<{ presenceId: string | undefined; sessionKey: string }> = [];
    const result = await withPresenceRetry(room, (presenceId, sessionKey) => {
      attempt += 1;
      retrySeen.push({ presenceId, sessionKey });
      if (attempt === 1) {
        const err = new Error("presence expired") as Error & { body: { code: string } };
        err.body = { code: "PRESENCE_EXPIRED" };
        throw err;
      }
      return Promise.resolve({ ok: true });
    });

    assert.equal(attempt, 2, "the callback ran once, failed, then ran again after re-registration");
    assert.deepEqual(result, { ok: true });
    assert.equal(retrySeen[0]?.sessionKey, FIXED_SESSION_KEY);
    assert.equal(retrySeen[1]?.sessionKey, FIXED_SESSION_KEY);
    assert.equal(retrySeen[0]?.presenceId, "prs_stale");
    assert.equal(retrySeen[1]?.presenceId, "prs_fresh");
    assert.equal(registerCalls.length, 1);
    assert.equal((registerCalls[0]?.opts as { sessionKey?: string })?.sessionKey, FIXED_SESSION_KEY);
  });
});
