/**
 * `r.rooms.waitForMessages` — the agent's ear (kygit-invite design D6/D7).
 *
 * Exercises the three load-bearing behaviors against a fake gateway (mocked
 * fetch, the same pattern `gitvault-resume-errors.test.ts` and `rooms.test.ts`
 * use):
 *  - SETTLES the instant a page carries a message, whether the gateway held
 *    the read or not.
 *  - TIMES OUT cleanly — never throws, returns the last observed (empty)
 *    page with `settled: false`.
 *  - DEGRADES to bounded client-side polling the moment a page comes back
 *    with NO `waited_ms` (an older gateway that ignored `wait`), and never
 *    reverts back to a zero-sleep loop even if the SDK is not otherwise told
 *    which gateway it's talking to.
 *
 * Run: node --test --import tsx sdk/src/namespaces/rooms-wait.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { Run402 } from "../index.js";
import type { CredentialsProvider } from "../credentials.js";

const ORG = "57035b1e-ec41-4ce6-a7a5-a5b2560efdd7";
const ROOM = "prj_fresh";

function makeCreds(): CredentialsProvider {
  return {
    async getAuth() {
      return { "SIGN-IN-WITH-X": "test-siwx" };
    },
    async getProject() {
      return null;
    },
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function makeSdk(fetchImpl: typeof globalThis.fetch): Run402 {
  return new Run402({ apiBase: "https://api.example.test", credentials: makeCreds(), fetch: fetchImpl });
}

function emptyPage(cursor: string, extra: Record<string, unknown> = {}) {
  return { messages: [], cursor, has_more: false, ...extra };
}

function pageWithOneMessage(cursor: string, extra: Record<string, unknown> = {}) {
  return {
    messages: [{
      message_id: "msg_1", cursor, room_key: ROOM, sender: "Opus",
      body_snippet: "hello", body_truncated: false, thread_id: null,
      importance: "normal", ack_required: false, recipients: [], created_at: "2026-09-02T10:00:00.000Z",
    }],
    cursor, has_more: false, ...extra,
  };
}

describe("rooms.waitForMessages — settles the instant a message is visible", () => {
  it("a held-gateway page (carries waited_ms) with a message settles on the FIRST call — no sleep, no second fetch", async () => {
    let calls = 0;
    const fetchImpl: typeof globalThis.fetch = async () => {
      calls++;
      return jsonResponse(pageWithOneMessage("mcr_2", { waited_ms: 3000, live_presences: [{ presence_id: "prs_1", name: "Opus", task: null, program: null, model: null, state: "active", last_active: "x", expires_at: "y" }] }));
    };
    const r = makeSdk(fetchImpl);
    const result = await r.rooms.waitForMessages(ORG, ROOM, { cursor: "mcr_1", timeoutMs: 30_000 });
    assert.equal(calls, 1);
    assert.equal(result.settled, true);
    assert.equal(result.messages.length, 1);
    assert.equal(result.cursor, "mcr_2");
    assert.equal(result.live_presences.length, 1);
    assert.equal(result.live_presences[0]!.name, "Opus");
    assert.ok(typeof result.waited_ms === "number" && result.waited_ms >= 0);
  });

  it("a message arriving on the SECOND held read still settles, using the page's own live_presences", async () => {
    let calls = 0;
    const fetchImpl: typeof globalThis.fetch = async () => {
      calls++;
      if (calls === 1) return jsonResponse(emptyPage("mcr_1", { waited_ms: 1000, live_presences: [] }));
      return jsonResponse(pageWithOneMessage("mcr_2", { waited_ms: 500, live_presences: [{ presence_id: "prs_1", name: "Fable", task: null, program: null, model: null, state: "active", last_active: "x", expires_at: "y" }] }));
    };
    const r = makeSdk(fetchImpl);
    const result = await r.rooms.waitForMessages(ORG, ROOM, { cursor: "mcr_1", timeoutMs: 30_000 });
    assert.equal(calls, 2, "held reads re-fetch with no extra sleep between them");
    assert.equal(result.settled, true);
    assert.equal(result.live_presences[0]!.name, "Fable");
  });
});

describe("rooms.waitForMessages — silence is an answer, never a throw", () => {
  it("times out cleanly with the SAME cursor, settled:false, and a waited_ms that tracks real elapsed time", async () => {
    // A REAL held read genuinely blocks the caller for up to `waitSeconds` —
    // simulate that with a small real delay per call (rather than a fake
    // `waited_ms` figure with no matching delay, which would make a
    // zero-sleep held-read loop spin thousands of times before a mocked
    // 60-real-second timeout ever elapsed).
    // A held read is the gateway sleeping on the caller's behalf, so the
    // fake honors the `wait` it is asked for (in real seconds — the gateway
    // clamps to >= 1 s, so a sub-second budget cannot be spent as a hold).
    const fetchImpl: typeof globalThis.fetch = async (input) => {
      const wait = Number(new URL(String(input)).searchParams.get("wait"));
      await new Promise((resolve) => setTimeout(resolve, wait * 1000));
      return jsonResponse(emptyPage("mcr_1", { waited_ms: wait * 1000, live_presences: [] }));
    };
    const r = makeSdk(fetchImpl);
    const start = Date.now();
    const result = await r.rooms.waitForMessages(ORG, ROOM, { cursor: "mcr_1", timeoutMs: 2200, waitSeconds: 25 });
    const elapsed = Date.now() - start;
    assert.equal(result.settled, false);
    assert.deepEqual(result.messages, []);
    assert.equal(result.cursor, "mcr_1");
    assert.ok(result.waited_ms >= 1900, `expected roughly the whole-second part of the budget spent, got ${result.waited_ms}`);
    assert.ok(result.waited_ms < 2500, `expected no overshoot past the budget, got ${result.waited_ms}`);
    // The real wall-clock elapsed time should track the reported waited_ms —
    // proving this is not a busy loop.
    assert.ok(elapsed >= 1900);
  });

  it("never throws even when every page is empty across the full timeout budget", async () => {
    const fetchImpl: typeof globalThis.fetch = async () => jsonResponse(emptyPage("mcr_1", { waited_ms: 5 }));
    const r = makeSdk(fetchImpl);
    await assert.doesNotReject(r.rooms.waitForMessages(ORG, ROOM, { cursor: "mcr_1", timeoutMs: 60 }));
  });
});

describe("rooms.waitForMessages — degrades to polling when the gateway does not hold", () => {
  // `pollMs` is floored at 1000ms — the SAME anti-hammering guard the shared
  // `waitFor` helper applies ("clamped to >=1s so a tight loop cannot hammer
  // the API"). These two tests therefore run for a couple of real seconds
  // rather than mocking the clock, so they exercise the real setTimeout path.

  it("a page with NO waited_ms is evidence of an older gateway — the next read sleeps (>=1s floor) before re-fetching", async () => {
    const calledAt: number[] = [];
    const fetchImpl: typeof globalThis.fetch = async (input) => {
      // Only the messages route counts as a "poll" — the end-of-wait
      // best-effort live_presences fallback read (no page here ever carries
      // its own live_presences) hits a DIFFERENT route and fires right
      // after the loop settles, which is not the timing under test.
      if (String(input).includes("/presences")) return jsonResponse({ presences: [] });
      calledAt.push(Date.now());
      // No `waited_ms` on ANY page — an older gateway that ignores `wait`
      // and always answers immediately.
      return jsonResponse(emptyPage("mcr_1"));
    };
    const r = makeSdk(fetchImpl);
    const result = await r.rooms.waitForMessages(ORG, ROOM, { cursor: "mcr_1", timeoutMs: 2500, pollMs: 1000 });
    assert.equal(result.settled, false);
    assert.ok(calledAt.length >= 2, `expected at least 2 polls in 2500ms at the 1000ms floor, got ${calledAt.length}`);
    for (let i = 1; i < calledAt.length; i++) {
      const gap = calledAt[i]! - calledAt[i - 1]!;
      assert.ok(gap >= 900, `poll ${i} fired only ${gap}ms after the previous one — expected the >=1000ms floor`);
    }
  });

  it("a message arriving on a POLLED (non-held) read still settles, live_presences falls back to a listPresences read", async () => {
    let calls = 0;
    const fetchImpl: typeof globalThis.fetch = async (input) => {
      calls++;
      const url = String(input);
      if (url.includes("/presences")) {
        return jsonResponse({ presences: [{ presence_id: "prs_2", name: "Opus", task: null, program: null, model: null, state: "active", last_active: "x", expires_at: "y" }] });
      }
      if (calls === 1) return jsonResponse(emptyPage("mcr_1")); // no waited_ms: not held
      return jsonResponse(pageWithOneMessage("mcr_2")); // still no waited_ms
    };
    const r = makeSdk(fetchImpl);
    const result = await r.rooms.waitForMessages(ORG, ROOM, { cursor: "mcr_1", timeoutMs: 5_000, pollMs: 1000 });
    assert.equal(result.settled, true);
    assert.equal(result.live_presences.length, 1, "falls back to a listPresences read when no page ever carried live_presences");
    assert.equal(result.live_presences[0]!.name, "Opus");
  });
});

describe("rooms.waitForMessages — request shape", () => {
  it("sends wait as a query param clamped 1..25 (with budget to spare), and never sends order=desc", async () => {
    const urls: string[] = [];
    const fetchImpl: typeof globalThis.fetch = async (input) => {
      urls.push(String(input));
      // Settles on the first read, so the 60 s budget is never actually spent.
      return jsonResponse(pageWithOneMessage("mcr_2", { waited_ms: 1 }));
    };
    const r = makeSdk(fetchImpl);
    await r.rooms.waitForMessages(ORG, ROOM, { cursor: "mcr_1", timeoutMs: 60_000, waitSeconds: 999 });
    assert.ok(urls[0]!.includes("wait=25"), `expected wait clamped to 25, got ${urls[0]}`);
    assert.equal(urls[0]!.includes("order=desc"), false);
  });

  it("a budget under one second still issues exactly one minimal hold (wait=1), never zero and never more", async () => {
    const urls: string[] = [];
    const fetchImpl: typeof globalThis.fetch = async (input) => {
      urls.push(String(input));
      // live_presences on the page, so no trailing presences read muddies the count.
      return jsonResponse(emptyPage("mcr_1", { waited_ms: 1, live_presences: [] }));
    };
    const r = makeSdk(fetchImpl);
    await r.rooms.waitForMessages(ORG, ROOM, { cursor: "mcr_1", timeoutMs: 1, waitSeconds: 999 });
    const reads = urls.filter((u) => u.includes("/messages?"));
    assert.equal(reads.length, 1);
    assert.ok(reads[0]!.includes("wait=1"), `expected the minimal hold, got ${reads[0]}`);
  });

  it("clamps each read's hold to the budget that is LEFT — a held read never overshoots timeoutMs by a whole hold", async () => {
    // A gateway that genuinely holds: it sleeps for the requested `wait`
    // seconds before answering an empty held page. With a 2.5 s budget the
    // first read may hold at most 2 s (floor of the remaining budget), and
    // the ~0.5 s left afterwards cannot be expressed as a hold, so the
    // wait returns — total elapsed stays under the budget instead of
    // running a full 25 s hold with 2.5 s of budget.
    const waits: number[] = [];
    const fetchImpl: typeof globalThis.fetch = async (input) => {
      const wait = Number(new URL(String(input)).searchParams.get("wait"));
      waits.push(wait);
      await new Promise((resolve) => setTimeout(resolve, wait * 1000));
      return jsonResponse(emptyPage("mcr_1", { waited_ms: wait * 1000, live_presences: [] }));
    };
    const r = makeSdk(fetchImpl);
    const startedAt = Date.now();
    const result = await r.rooms.waitForMessages(ORG, ROOM, { cursor: "mcr_1", timeoutMs: 2500, waitSeconds: 25 });
    const elapsed = Date.now() - startedAt;
    assert.deepEqual(waits, [2], `expected one read holding 2 s, got ${JSON.stringify(waits)}`);
    assert.ok(elapsed < 2500 + 250, `expected to return inside the 2.5 s budget, took ${elapsed} ms`);
    assert.equal(result.settled, false);
    assert.equal(result.cursor, "mcr_1");
  });

  it("threads cursor/threadId/addressedTo/presenceId/sessionKey onto every read", async () => {
    const urls: string[] = [];
    const fetchImpl: typeof globalThis.fetch = async (input) => {
      urls.push(String(input));
      return jsonResponse(emptyPage("mcr_1", { waited_ms: 1 }));
    };
    const r = makeSdk(fetchImpl);
    await r.rooms.waitForMessages(ORG, ROOM, {
      cursor: "mcr_1", threadId: "thr_1", addressedTo: "me", presenceId: "prs_1", sessionKey: "sess_1", timeoutMs: 1,
    });
    const url = urls[0]!;
    assert.ok(url.includes("cursor=mcr_1"));
    assert.ok(url.includes("thread_id=thr_1"));
    assert.ok(url.includes("addressed_to=me"));
    assert.ok(url.includes("presence_id=prs_1"));
    assert.ok(url.includes("session_key=sess_1"));
  });
});

describe("ScopedRoom.waitForMessages — delegates with (orgId, roomKey) pre-bound", () => {
  it("reaches the same route with no explicit org/room arguments", async () => {
    const urls: string[] = [];
    const fetchImpl: typeof globalThis.fetch = async (input) => {
      urls.push(String(input));
      return jsonResponse(emptyPage("mcr_1", { waited_ms: 1 }));
    };
    const r = makeSdk(fetchImpl);
    const scoped = r.rooms.scoped(ORG, ROOM);
    const result = await scoped.waitForMessages({ cursor: "mcr_1", timeoutMs: 1 });
    assert.equal(result.settled, false);
    assert.ok(urls[0]!.includes(`/orgs/v1/${ORG}/rooms/${ROOM}/messages`));
  });
});
