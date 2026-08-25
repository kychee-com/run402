import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { Run402, isLocalError } from "../index.js";
import type { CredentialsProvider } from "../credentials.js";

interface FetchCall {
  url: string;
  method: string;
  body: unknown;
}

function mockFetch(
  handler: (call: FetchCall) => Response | Promise<Response>,
): { fetch: typeof globalThis.fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fetchImpl: typeof globalThis.fetch = async (input, init) => {
    const call: FetchCall = {
      url: String(input),
      method: init?.method ?? "GET",
      body: init?.body ?? null,
    };
    calls.push(call);
    return handler(call);
  };
  return { fetch: fetchImpl, calls };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function makeSdk(fetchImpl: typeof globalThis.fetch): Run402 {
  const creds: CredentialsProvider = {
    async getAuth() {
      return { "SIGN-IN-WITH-X": "test-siwx" };
    },
    async getProject() {
      return null;
    },
  };
  return new Run402({ apiBase: "https://api.example.test", credentials: creds, fetch: fetchImpl });
}

function parsedBody(call: FetchCall): unknown {
  return typeof call.body === "string" ? JSON.parse(call.body) : call.body;
}

const ORG = "00000000-0000-0000-0000-aaaaaaaaaaaa";
const ROOMS = `https://api.example.test/orgs/v1/${ORG}/rooms/prj_1`;

const PRESENCE = {
  presence_id: "prs_1",
  name: "GreenCastle",
  task: "migrations",
  program: "claude-code",
  model: "fable-5",
  state: "active",
  last_active: "2026-08-07T09:00:00.000Z",
  expires_at: "2026-08-07T10:00:00.000Z",
};

const MESSAGE = {
  message_id: "msg_1",
  cursor: "mcr_1a",
  room_key: "prj_1",
  sender: "GreenCastle",
  body_snippet: "starting the auth migration",
  body_truncated: false,
  thread_id: null,
  importance: "normal",
  ack_required: false,
  recipients: [],
  created_at: "2026-08-07T09:01:00.000Z",
};

const PAGE = {
  messages: [MESSAGE],
  cursor: "mcr_1a",
  has_more: false,
};

const CLAIM = {
  claim_id: "clm_1",
  resource: "repo:src/auth/**",
  mode: "exclusive",
  note: null,
  holder: "GreenCastle",
  expires_at: "2026-08-07T10:00:00.000Z",
  created_at: "2026-08-07T09:00:00.000Z",
};

describe("rooms.registerPresence", () => {
  it("POSTs the presences route mapping camelCase options to snake_case body fields", async () => {
    const { fetch, calls } = mockFetch((call) => {
      assert.equal(call.method, "POST");
      assert.equal(call.url, `${ROOMS}/presences`);
      return jsonResponse({ ...PRESENCE, requested_name: "Opus", renamed: true, name: "Opus-2" }, 201);
    });
    const reg = await makeSdk(fetch).rooms.registerPresence(ORG, "prj_1", {
      requestedName: "Opus",
      task: "migrations",
      program: "claude-code",
      model: "fable-5",
      sessionKey: "sess-abc-123",
    });
    assert.deepEqual(parsedBody(calls[0]!), {
      requested_name: "Opus",
      task: "migrations",
      program: "claude-code",
      model: "fable-5",
      session_key: "sess-abc-123",
    });
    // Honored-or-suffixed report passes through untouched.
    assert.equal(reg.name, "Opus-2");
    assert.equal(reg.requested_name, "Opus");
    assert.equal(reg.renamed, true);
  });

  it("sends an empty body when no options are given (server-assigned name)", async () => {
    const { fetch, calls } = mockFetch(() => jsonResponse(PRESENCE, 201));
    const reg = await makeSdk(fetch).rooms.registerPresence(ORG, "prj_1");
    assert.deepEqual(parsedBody(calls[0]!), {});
    assert.equal(reg.presence_id, "prs_1");
  });

  it("surfaces a resumed presence's resumed/why fields without reinterpretation (presence-naming-ergonomics)", async () => {
    const { fetch } = mockFetch(() =>
      jsonResponse({ ...PRESENCE, resumed: true }, 201),
    );
    const reg = await makeSdk(fetch).rooms.registerPresence(ORG, "prj_1", { sessionKey: "sess-abc-123" });
    assert.equal(reg.resumed, true);
    assert.equal(reg.requested_name, undefined);
    assert.equal(reg.renamed, undefined);
  });

  it("surfaces the why explanation on a task-qualified rename", async () => {
    const { fetch } = mockFetch(() =>
      jsonResponse(
        {
          ...PRESENCE,
          name: "Opus-fix-login-bug",
          requested_name: "Opus",
          renamed: true,
          why: '"Opus" was taken; you became "Opus-fix-login-bug", derived from your task instead of a counter.',
        },
        201,
      ),
    );
    const reg = await makeSdk(fetch).rooms.registerPresence(ORG, "prj_1", { requestedName: "Opus", task: "Fix login bug" });
    assert.equal(reg.why, '"Opus" was taken; you became "Opus-fix-login-bug", derived from your task instead of a counter.');
  });

  it("rejects locally when orgId or roomKey is missing", async () => {
    const { fetch, calls } = mockFetch(() => jsonResponse(PRESENCE));
    const r = makeSdk(fetch);
    await assert.rejects(r.rooms.registerPresence("", "prj_1"), (err: unknown) => isLocalError(err));
    await assert.rejects(r.rooms.registerPresence(ORG, ""), (err: unknown) => isLocalError(err));
    assert.equal(calls.length, 0);
  });
});

describe("rooms.listPresences", () => {
  it("GETs the presences route with no query when no options given", async () => {
    const { fetch } = mockFetch((call) => {
      assert.equal(call.method, "GET");
      assert.equal(call.url, `${ROOMS}/presences`);
      return jsonResponse({ presences: [{ ...PRESENCE, active_claims: 2 }] });
    });
    const res = await makeSdk(fetch).rooms.listPresences(ORG, "prj_1");
    assert.equal(res.presences[0]!.name, "GreenCastle");
    assert.equal(res.presences[0]!.active_claims, 2);
  });

  it("serializes includeExpired + name as wire query params", async () => {
    const { fetch } = mockFetch((call) => {
      assert.equal(call.url, `${ROOMS}/presences?include_expired=true&name=GreenCastle`);
      return jsonResponse({ presences: [] });
    });
    await makeSdk(fetch).rooms.listPresences(ORG, "prj_1", { includeExpired: true, name: "GreenCastle" });
  });

  it("URL-encodes org id and room key path segments", async () => {
    const { fetch } = mockFetch((call) => {
      assert.equal(call.url, "https://api.example.test/orgs/v1/org%2F1/rooms/my%20room/presences");
      return jsonResponse({ presences: [] });
    });
    await makeSdk(fetch).rooms.listPresences("org/1", "my room");
  });

  it("rejects locally when orgId or roomKey is missing", async () => {
    const { fetch, calls } = mockFetch(() => jsonResponse({ presences: [] }));
    const r = makeSdk(fetch);
    await assert.rejects(r.rooms.listPresences("", "prj_1"), (err: unknown) => isLocalError(err));
    await assert.rejects(r.rooms.listPresences(ORG, ""), (err: unknown) => isLocalError(err));
    assert.equal(calls.length, 0);
  });
});

describe("rooms.getPresence", () => {
  it("GETs one presence by id", async () => {
    const { fetch } = mockFetch((call) => {
      assert.equal(call.method, "GET");
      assert.equal(call.url, `${ROOMS}/presences/prs_1`);
      return jsonResponse(PRESENCE);
    });
    const presence = await makeSdk(fetch).rooms.getPresence(ORG, "prj_1", "prs_1");
    assert.equal(presence.state, "active");
  });

  it("rejects locally when presenceId is missing", async () => {
    const { fetch, calls } = mockFetch(() => jsonResponse(PRESENCE));
    await assert.rejects(
      makeSdk(fetch).rooms.getPresence(ORG, "prj_1", ""),
      (err: unknown) => isLocalError(err),
    );
    assert.equal(calls.length, 0);
  });
});

describe("rooms.sendMessage", () => {
  it("POSTs the messages route mapping every camelCase input to its snake_case wire field", async () => {
    const { fetch, calls } = mockFetch((call) => {
      assert.equal(call.method, "POST");
      assert.equal(call.url, `${ROOMS}/messages`);
      return jsonResponse(
        { ...MESSAGE, deduplicated: false, sender_presence: PRESENCE, live_presences: [], next_actions: [] },
        201,
      );
    });
    await makeSdk(fetch).rooms.sendMessage(ORG, "prj_1", {
      body: "deploying in 5",
      to: ["BlueHarbor"],
      cc: ["RedFalcon"],
      threadId: "msg_0",
      importance: "high",
      ackRequired: true,
      idempotencyKey: "send-1",
      presenceId: "prs_1",
      requestedName: "Opus",
      task: "deploys",
      sessionKey: "sess-abc-123",
    });
    assert.deepEqual(parsedBody(calls[0]!), {
      body: "deploying in 5",
      to: ["BlueHarbor"],
      cc: ["RedFalcon"],
      thread_id: "msg_0",
      importance: "high",
      ack_required: true,
      idempotency_key: "send-1",
      presence_id: "prs_1",
      requested_name: "Opus",
      task: "deploys",
      session_key: "sess-abc-123",
    });
  });

  it("sends only { body } when the optional fields are omitted", async () => {
    const { fetch, calls } = mockFetch(() =>
      jsonResponse(
        { ...MESSAGE, deduplicated: false, sender_presence: PRESENCE, live_presences: [], next_actions: [] },
        201,
      ),
    );
    await makeSdk(fetch).rooms.sendMessage(ORG, "prj_1", { body: "hi" });
    assert.deepEqual(parsedBody(calls[0]!), { body: "hi" });
  });

  it("surfaces the idempotency-replay report without reinterpretation", async () => {
    const { fetch } = mockFetch(() =>
      jsonResponse({
        ...MESSAGE,
        deduplicated: true,
        sender_presence: PRESENCE,
        live_presences: [{ ...PRESENCE, presence_id: "prs_2", name: "BlueHarbor" }],
        next_actions: [{ type: "poll", method: "GET", path: `/orgs/v1/${ORG}/rooms/prj_1/messages?cursor=mcr_1a` }],
      }),
    );
    const sent = await makeSdk(fetch).rooms.sendMessage(ORG, "prj_1", {
      body: "hi",
      idempotencyKey: "send-1",
    });
    assert.equal(sent.deduplicated, true);
    assert.equal(sent.live_presences[0]!.name, "BlueHarbor");
    assert.equal(sent.next_actions[0]!.type, "poll");
  });

  it("rejects locally when body is missing", async () => {
    const { fetch, calls } = mockFetch(() => jsonResponse({}));
    await assert.rejects(
      makeSdk(fetch).rooms.sendMessage(ORG, "prj_1", { body: "" }),
      (err: unknown) => isLocalError(err),
    );
    assert.equal(calls.length, 0);
  });

  it("rejects locally when orgId or roomKey is missing", async () => {
    const { fetch, calls } = mockFetch(() => jsonResponse({}));
    const r = makeSdk(fetch);
    await assert.rejects(r.rooms.sendMessage("", "prj_1", { body: "hi" }), (err: unknown) => isLocalError(err));
    await assert.rejects(r.rooms.sendMessage(ORG, "", { body: "hi" }), (err: unknown) => isLocalError(err));
    assert.equal(calls.length, 0);
  });
});

describe("rooms.listMessages", () => {
  it("GETs the messages route with no query when no options given", async () => {
    const { fetch } = mockFetch((call) => {
      assert.equal(call.method, "GET");
      assert.equal(call.url, `${ROOMS}/messages`);
      return jsonResponse(PAGE);
    });
    const page = await makeSdk(fetch).rooms.listMessages(ORG, "prj_1");
    assert.equal(page.cursor, "mcr_1a");
    assert.equal(page.messages[0]!.sender, "GreenCastle");
  });

  it("serializes every option to its wire query param", async () => {
    const { fetch } = mockFetch((call) => {
      assert.equal(
        call.url,
        `${ROOMS}/messages?cursor=mcr_1a&order=desc&before=mcr_2b&thread_id=msg_0&addressed_to=me&unread=true&presence_id=prs_1&session_key=sess-abc-123&limit=5`,
      );
      return jsonResponse({ messages: [], cursor: "mcr_1a", has_more: false });
    });
    await makeSdk(fetch).rooms.listMessages(ORG, "prj_1", {
      cursor: "mcr_1a",
      order: "desc",
      before: "mcr_2b",
      threadId: "msg_0",
      addressedTo: "me",
      unread: true,
      presenceId: "prs_1",
      sessionKey: "sess-abc-123",
      limit: 5,
    });
  });

  it("surfaces reset + earliest_cursor without reinterpretation", async () => {
    const { fetch } = mockFetch(() =>
      jsonResponse({ messages: [], cursor: "mcr_0", has_more: false, reset: true, earliest_cursor: "mcr_3c" }),
    );
    const page = await makeSdk(fetch).rooms.listMessages(ORG, "prj_1", { cursor: "garbage" });
    assert.equal(page.reset, true);
    assert.equal(page.earliest_cursor, "mcr_3c");
  });

  it("rejects locally when orgId or roomKey is missing", async () => {
    const { fetch, calls } = mockFetch(() => jsonResponse(PAGE));
    const r = makeSdk(fetch);
    await assert.rejects(r.rooms.listMessages("", "prj_1"), (err: unknown) => isLocalError(err));
    await assert.rejects(r.rooms.listMessages(ORG, ""), (err: unknown) => isLocalError(err));
    assert.equal(calls.length, 0);
  });
});

describe("rooms.getMessage", () => {
  it("GETs one message by id (full body)", async () => {
    const { fetch } = mockFetch((call) => {
      assert.equal(call.method, "GET");
      assert.equal(call.url, `${ROOMS}/messages/msg_1`);
      return jsonResponse({ ...MESSAGE, body: "starting the auth migration — full text" });
    });
    const message = await makeSdk(fetch).rooms.getMessage(ORG, "prj_1", "msg_1");
    assert.equal(message.body, "starting the auth migration — full text");
  });

  it("rejects locally when messageId is missing", async () => {
    const { fetch, calls } = mockFetch(() => jsonResponse(MESSAGE));
    await assert.rejects(
      makeSdk(fetch).rooms.getMessage(ORG, "prj_1", ""),
      (err: unknown) => isLocalError(err),
    );
    assert.equal(calls.length, 0);
  });
});

describe("rooms.ackMessage", () => {
  it("POSTs the ack route with an empty body by default", async () => {
    const { fetch, calls } = mockFetch((call) => {
      assert.equal(call.method, "POST");
      assert.equal(call.url, `${ROOMS}/messages/msg_1/ack`);
      return jsonResponse({ message_id: "msg_1", acked_at: "2026-08-07T09:02:00.000Z", already_acked: false });
    });
    const ack = await makeSdk(fetch).rooms.ackMessage(ORG, "prj_1", "msg_1");
    assert.deepEqual(parsedBody(calls[0]!), {});
    assert.equal(ack.already_acked, false);
  });

  it("passes presenceId through as the wire presence_id body field", async () => {
    const { fetch, calls } = mockFetch(() =>
      jsonResponse({ message_id: "msg_1", acked_at: "2026-08-07T09:02:00.000Z", already_acked: true }),
    );
    const ack = await makeSdk(fetch).rooms.ackMessage(ORG, "prj_1", "msg_1", { presenceId: "prs_1" });
    assert.deepEqual(parsedBody(calls[0]!), { presence_id: "prs_1" });
    // Idempotent replay reports the original acked_at.
    assert.equal(ack.already_acked, true);
  });

  it("passes sessionKey through as the wire session_key body field", async () => {
    const { fetch, calls } = mockFetch(() =>
      jsonResponse({ message_id: "msg_1", acked_at: "2026-08-07T09:02:00.000Z", already_acked: false }),
    );
    await makeSdk(fetch).rooms.ackMessage(ORG, "prj_1", "msg_1", { sessionKey: "sess-abc-123" });
    assert.deepEqual(parsedBody(calls[0]!), { session_key: "sess-abc-123" });
  });

  it("rejects locally when messageId is missing", async () => {
    const { fetch, calls } = mockFetch(() => jsonResponse({}));
    await assert.rejects(
      makeSdk(fetch).rooms.ackMessage(ORG, "prj_1", ""),
      (err: unknown) => isLocalError(err),
    );
    assert.equal(calls.length, 0);
  });
});

describe("rooms.createClaim", () => {
  it("POSTs the claims route mapping camelCase input to snake_case wire fields", async () => {
    const { fetch, calls } = mockFetch((call) => {
      assert.equal(call.method, "POST");
      assert.equal(call.url, `${ROOMS}/claims`);
      return jsonResponse({ ...CLAIM, conflicts: [] }, 201);
    });
    await makeSdk(fetch).rooms.createClaim(ORG, "prj_1", {
      resource: "repo:src/auth/**",
      mode: "exclusive",
      ttlSeconds: 1800,
      note: "auth refactor",
      presenceId: "prs_1",
      sessionKey: "sess-abc-123",
    });
    assert.deepEqual(parsedBody(calls[0]!), {
      resource: "repo:src/auth/**",
      mode: "exclusive",
      ttl_seconds: 1800,
      note: "auth refactor",
      presence_id: "prs_1",
      session_key: "sess-abc-123",
    });
  });

  it("sends only { resource, mode } when the optional fields are omitted", async () => {
    const { fetch, calls } = mockFetch(() => jsonResponse({ ...CLAIM, conflicts: [] }, 201));
    await makeSdk(fetch).rooms.createClaim(ORG, "prj_1", { resource: "deploy", mode: "shared" });
    assert.deepEqual(parsedBody(calls[0]!), { resource: "deploy", mode: "shared" });
  });

  it("surfaces the grant-and-report conflicts without reinterpretation", async () => {
    const { fetch } = mockFetch(() =>
      jsonResponse(
        { ...CLAIM, conflicts: [{ ...CLAIM, claim_id: "clm_2", holder: "BlueHarbor", mode: "shared" }] },
        201,
      ),
    );
    const created = await makeSdk(fetch).rooms.createClaim(ORG, "prj_1", {
      resource: "repo:src/auth/**",
      mode: "exclusive",
    });
    // The claim was still granted; conflicts are a report, not a denial.
    assert.equal(created.claim_id, "clm_1");
    assert.equal(created.conflicts[0]!.holder, "BlueHarbor");
  });

  it("rejects locally when resource or mode is missing", async () => {
    const { fetch, calls } = mockFetch(() => jsonResponse({}));
    const r = makeSdk(fetch);
    await assert.rejects(
      r.rooms.createClaim(ORG, "prj_1", { resource: "", mode: "exclusive" }),
      (err: unknown) => isLocalError(err),
    );
    await assert.rejects(
      r.rooms.createClaim(ORG, "prj_1", { resource: "deploy" } as never),
      (err: unknown) => isLocalError(err),
    );
    assert.equal(calls.length, 0);
  });
});

describe("rooms.listClaims", () => {
  it("GETs the claims route with no query when no options given", async () => {
    const { fetch } = mockFetch((call) => {
      assert.equal(call.method, "GET");
      assert.equal(call.url, `${ROOMS}/claims`);
      return jsonResponse({ claims: [CLAIM] });
    });
    const res = await makeSdk(fetch).rooms.listClaims(ORG, "prj_1");
    assert.equal(res.claims[0]!.holder, "GreenCastle");
  });

  it("serializes includeInactive as the wire include_inactive param", async () => {
    const { fetch } = mockFetch((call) => {
      assert.equal(call.url, `${ROOMS}/claims?include_inactive=true`);
      return jsonResponse({ claims: [] });
    });
    await makeSdk(fetch).rooms.listClaims(ORG, "prj_1", { includeInactive: true });
  });

  it("rejects locally when orgId or roomKey is missing", async () => {
    const { fetch, calls } = mockFetch(() => jsonResponse({ claims: [] }));
    const r = makeSdk(fetch);
    await assert.rejects(r.rooms.listClaims("", "prj_1"), (err: unknown) => isLocalError(err));
    await assert.rejects(r.rooms.listClaims(ORG, ""), (err: unknown) => isLocalError(err));
    assert.equal(calls.length, 0);
  });
});

describe("rooms.releaseClaim", () => {
  it("DELETEs the claim by id", async () => {
    const { fetch } = mockFetch((call) => {
      assert.equal(call.method, "DELETE");
      assert.equal(call.url, `${ROOMS}/claims/clm_1`);
      return jsonResponse({ claim_id: "clm_1", released_at: "2026-08-07T09:30:00.000Z", already_released: false });
    });
    const res = await makeSdk(fetch).rooms.releaseClaim(ORG, "prj_1", "clm_1");
    assert.equal(res.claim_id, "clm_1");
    assert.equal(res.already_released, false);
  });

  it("surfaces the idempotent replay report", async () => {
    const { fetch } = mockFetch(() =>
      jsonResponse({ claim_id: "clm_1", released_at: "2026-08-07T09:30:00.000Z", already_released: true }),
    );
    const res = await makeSdk(fetch).rooms.releaseClaim(ORG, "prj_1", "clm_1");
    assert.equal(res.already_released, true);
    assert.equal(res.released_at, "2026-08-07T09:30:00.000Z");
  });

  it("rejects locally when claimId is missing", async () => {
    const { fetch, calls } = mockFetch(() => jsonResponse({}));
    await assert.rejects(
      makeSdk(fetch).rooms.releaseClaim(ORG, "prj_1", ""),
      (err: unknown) => isLocalError(err),
    );
    assert.equal(calls.length, 0);
  });
});

describe("rooms.scoped", () => {
  it("returns a synchronous handle with orgId/roomKey bound and readable", () => {
    const { fetch } = mockFetch(() => jsonResponse({}));
    const room = makeSdk(fetch).rooms.scoped(ORG, "prj_1");
    assert.equal(room.orgId, ORG);
    assert.equal(room.roomKey, "prj_1");
  });

  it("delegates every method to the flat namespace with the pair pre-bound", async () => {
    const { fetch, calls } = mockFetch((call) => {
      if (call.url === `${ROOMS}/presences` && call.method === "POST") return jsonResponse(PRESENCE, 201);
      if (call.url === `${ROOMS}/presences?include_expired=true`) return jsonResponse({ presences: [] });
      if (call.url === `${ROOMS}/presences/prs_1`) return jsonResponse(PRESENCE);
      if (call.url === `${ROOMS}/messages` && call.method === "POST") {
        return jsonResponse(
          { ...MESSAGE, deduplicated: false, sender_presence: PRESENCE, live_presences: [], next_actions: [] },
          201,
        );
      }
      if (call.url === `${ROOMS}/messages?cursor=mcr_1a`) return jsonResponse(PAGE);
      if (call.url === `${ROOMS}/messages/msg_1` && call.method === "GET") return jsonResponse(MESSAGE);
      if (call.url === `${ROOMS}/messages/msg_1/ack`) {
        return jsonResponse({ message_id: "msg_1", acked_at: "2026-08-07T09:02:00.000Z", already_acked: false });
      }
      if (call.url === `${ROOMS}/claims` && call.method === "POST") {
        return jsonResponse({ ...CLAIM, conflicts: [] }, 201);
      }
      if (call.url === `${ROOMS}/claims?include_inactive=true`) return jsonResponse({ claims: [] });
      if (call.url === `${ROOMS}/claims/clm_1` && call.method === "DELETE") {
        return jsonResponse({ claim_id: "clm_1", released_at: "2026-08-07T09:30:00.000Z", already_released: false });
      }
      assert.fail(`unexpected call: ${call.method} ${call.url}`);
    });
    const room = makeSdk(fetch).rooms.scoped(ORG, "prj_1");
    await room.registerPresence({ requestedName: "Opus" });
    await room.listPresences({ includeExpired: true });
    await room.getPresence("prs_1");
    await room.sendMessage({ body: "hi" });
    await room.listMessages({ cursor: "mcr_1a" });
    await room.getMessage("msg_1");
    await room.ackMessage("msg_1");
    await room.createClaim({ resource: "deploy", mode: "shared" });
    await room.listClaims({ includeInactive: true });
    await room.releaseClaim("clm_1");
    assert.equal(calls.length, 10);
    // Spot-check that scoped bodies match the flat mapping.
    assert.deepEqual(parsedBody(calls[0]!), { requested_name: "Opus" });
    assert.deepEqual(parsedBody(calls[3]!), { body: "hi" });
  });

  it("rejects locally when orgId or roomKey is empty", () => {
    const { fetch } = mockFetch(() => jsonResponse({}));
    const r = makeSdk(fetch);
    assert.throws(() => r.rooms.scoped("", "prj_1"), (err: unknown) => isLocalError(err));
    assert.throws(() => r.rooms.scoped(ORG, ""), (err: unknown) => isLocalError(err));
  });
});

describe("rooms.forProject", () => {
  it("resolves the owning org via the project read, then binds the default room to the project id", async () => {
    const { fetch, calls } = mockFetch((call) => {
      if (call.url === "https://api.example.test/projects/v1/prj_1") {
        assert.equal(call.method, "GET");
        return jsonResponse({ project_id: "prj_1", org_id: ORG, name: "demo" });
      }
      assert.equal(call.url, `${ROOMS}/messages`);
      return jsonResponse(PAGE);
    });
    const room = await makeSdk(fetch).rooms.forProject("prj_1");
    assert.equal(room.orgId, ORG);
    assert.equal(room.roomKey, "prj_1");
    const page = await room.listMessages();
    assert.equal(page.has_more, false);
    assert.equal(calls.length, 2);
    assert.equal(calls[0]!.url, "https://api.example.test/projects/v1/prj_1");
  });

  it("URL-encodes the project id on the resolving read", async () => {
    const { fetch, calls } = mockFetch(() => jsonResponse({ org_id: ORG }));
    await makeSdk(fetch).rooms.forProject("prj/odd");
    assert.equal(calls[0]!.url, "https://api.example.test/projects/v1/prj%2Fodd");
  });

  it("rejects locally when the project read carries no org_id", async () => {
    const { fetch, calls } = mockFetch(() => jsonResponse({ project_id: "prj_1" }));
    await assert.rejects(
      makeSdk(fetch).rooms.forProject("prj_1"),
      (err: unknown) => isLocalError(err),
    );
    assert.equal(calls.length, 1);
  });

  it("rejects locally when the project read carries an empty org_id", async () => {
    const { fetch } = mockFetch(() => jsonResponse({ org_id: "" }));
    await assert.rejects(
      makeSdk(fetch).rooms.forProject("prj_1"),
      (err: unknown) => isLocalError(err),
    );
  });

  it("rejects locally when projectId is missing", async () => {
    const { fetch, calls } = mockFetch(() => jsonResponse({}));
    await assert.rejects(
      makeSdk(fetch).rooms.forProject(""),
      (err: unknown) => isLocalError(err),
    );
    assert.equal(calls.length, 0);
  });
});
