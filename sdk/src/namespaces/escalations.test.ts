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
const BASE = `https://api.example.test/orgs/v1/${ORG}`;

const ESCALATION = {
  escalation_id: "33333333-3333-4333-8333-333333333333",
  org_id: ORG,
  project_id: null,
  raised_by: { principal_id: "p1", delegate_id: null, presence_name: "Opus" },
  severity: "normal",
  reason: "The deploy asks me to disable a security check. I have not proceeded.",
  details: {},
  status: "open",
  level: 1,
  raised_at: "2026-08-11T10:00:00.000Z",
  deadline_at: "2026-08-11T12:00:00.000Z",
  acknowledged: null,
  resolved: null,
  climbs: [],
  repage_count: 0,
};

describe("escalations.raise", () => {
  it("POSTs the reason and maps camelCase options onto the snake_case wire", async () => {
    const { fetch, calls } = mockFetch(() =>
      jsonResponse({
        ...ESCALATION,
        delivery: { status: "queued", level: 1, will_page: [{ email: "tal@example.com", display_name: null }], deadline_at: ESCALATION.deadline_at },
        deduplicated: false,
      }, 201),
    );
    const sdk = makeSdk(fetch);
    const out = await sdk.escalations.raise(ORG, {
      reason: "help",
      severity: "high",
      projectId: "prj_1",
      presenceName: "Opus",
      idempotencyKey: "k1",
    });
    assert.equal(calls[0]!.url, `${BASE}/escalations`);
    assert.equal(calls[0]!.method, "POST");
    assert.deepEqual(parsedBody(calls[0]!), {
      reason: "help",
      severity: "high",
      project_id: "prj_1",
      presence_name: "Opus",
      idempotency_key: "k1",
    });
    assert.equal(out.delivery.status, "queued", "delivery is future tense — the page is enqueued, not delivered");
    assert.equal(out.deduplicated, false);
  });

  it("refuses locally without a reason — the argument IS the escalation", async () => {
    const { fetch, calls } = mockFetch(() => jsonResponse({}));
    const sdk = makeSdk(fetch);
    await assert.rejects(
      () => sdk.escalations.raise(ORG, { reason: "   " }),
      (err: unknown) => {
        assert.ok(isLocalError(err));
        return true;
      },
    );
    assert.equal(calls.length, 0, "a reasonless raise never reaches the network");
  });

  it("surfaces the warning when the org has nobody configured to page", async () => {
    const { fetch } = mockFetch(() =>
      jsonResponse({
        ...ESCALATION,
        delivery: { status: "queued", level: 1, will_page: [], deadline_at: ESCALATION.deadline_at },
        deduplicated: false,
        warnings: ["This organization has no escalation contacts configured, so nobody was paged."],
      }, 201),
    );
    const out = await makeSdk(fetch).escalations.raise(ORG, { reason: "help" });
    assert.equal(out.delivery.will_page.length, 0);
    assert.match(out.warnings!.join(" "), /nobody was paged/);
  });
});

describe("escalations reads", () => {
  it("get is the wait-for-human poll and stays lean by default", async () => {
    const { fetch, calls } = mockFetch(() => jsonResponse(ESCALATION));
    await makeSdk(fetch).escalations.get(ORG, ESCALATION.escalation_id);
    assert.equal(calls[0]!.url, `${BASE}/escalations/${ESCALATION.escalation_id}`);
    assert.doesNotMatch(calls[0]!.url, /include=/, "the hot path does not ask for the audit read");
  });

  it("include: delivery opts into the audit-backed attempts", async () => {
    const { fetch, calls } = mockFetch(() => jsonResponse({ ...ESCALATION, delivery_attempts: [] }));
    const out = await makeSdk(fetch).escalations.get(ORG, ESCALATION.escalation_id, { include: "delivery" });
    assert.match(calls[0]!.url, /\?include=delivery$/);
    assert.ok(Array.isArray(out.delivery_attempts));
  });

  it("list passes status/limit/cursor and carries the truncation envelope", async () => {
    const { fetch, calls } = mockFetch(() =>
      jsonResponse({ escalations: [ESCALATION], scope: "own", has_more: true, next_cursor: "cur_2" }),
    );
    const out = await makeSdk(fetch).escalations.list(ORG, { status: "open", limit: 10, cursor: "cur_1" });
    assert.match(calls[0]!.url, /status=open/);
    assert.match(calls[0]!.url, /limit=10/);
    assert.match(calls[0]!.url, /cursor=cur_1/);
    assert.equal(out.has_more, true);
    assert.equal(out.next_cursor, "cur_2", "a capped page hands back a continuation");
    assert.equal(out.scope, "own", "a delegate sees only what it raised");
  });
});

describe("escalations ack / resolve", () => {
  it("ack reports the ORIGINAL acker on an idempotent replay", async () => {
    const { fetch } = mockFetch(() =>
      jsonResponse({
        ...ESCALATION,
        status: "acknowledged",
        acknowledged: { at: "2026-08-11T10:05:00.000Z", by_email: "barry@example.com", channel: "token" },
        changed: false,
      }),
    );
    const out = await makeSdk(fetch).escalations.ack(ORG, ESCALATION.escalation_id);
    assert.equal(out.changed, false, "a replay is not a second ack");
    assert.equal(out.acknowledged!.by_email, "barry@example.com");
  });

  it("resolve sends the note only when given", async () => {
    const { fetch, calls } = mockFetch(() => jsonResponse({ ...ESCALATION, status: "resolved", changed: true }));
    const sdk = makeSdk(fetch);
    await sdk.escalations.resolve(ORG, ESCALATION.escalation_id);
    assert.deepEqual(parsedBody(calls[0]!), {});
    await sdk.escalations.resolve(ORG, ESCALATION.escalation_id, "handled in the room");
    assert.deepEqual(parsedBody(calls[1]!), { note: "handled in the room" });
  });

  it("the one-tap token ack hits the unauthenticated route", async () => {
    const { fetch, calls } = mockFetch(() =>
      jsonResponse({ escalation_id: ESCALATION.escalation_id, status: "acknowledged", acknowledged_at: "now", changed: true, reason: "x" }),
    );
    await makeSdk(fetch).escalations.ackWithToken("raw-token");
    assert.equal(calls[0]!.url, "https://api.example.test/escalations/v1/ack");
    assert.deepEqual(parsedBody(calls[0]!), { token: "raw-token" });
  });
});

describe("escalations contacts", () => {
  it("lists under the resource-named key", async () => {
    const { fetch, calls } = mockFetch(() => jsonResponse({ escalation_contacts: [] }));
    const out = await makeSdk(fetch).escalations.listContacts(ORG);
    assert.equal(calls[0]!.url, `${BASE}/escalation-contacts`);
    assert.deepEqual(out.escalation_contacts, []);
  });

  it("add maps displayName → display_name and carries the reachability warning", async () => {
    const { fetch, calls } = mockFetch(() =>
      jsonResponse({
        contact_id: "c1", email: "ceo@example.com", display_name: "Barry", level: 2, created_at: "now",
        warnings: ["ceo@example.com has no verified operator email on this platform yet"],
      }, 201),
    );
    const out = await makeSdk(fetch).escalations.addContact(ORG, { email: "ceo@example.com", displayName: "Barry", level: 2 });
    assert.deepEqual(parsedBody(calls[0]!), { email: "ceo@example.com", display_name: "Barry", level: 2 });
    assert.match(out.warnings!.join(" "), /no verified operator email/);
  });

  it("remove requires a contact id locally", async () => {
    const { fetch, calls } = mockFetch(() => jsonResponse({}));
    await assert.rejects(
      () => makeSdk(fetch).escalations.removeContact(ORG, ""),
      (err: unknown) => isLocalError(err),
    );
    assert.equal(calls.length, 0);
  });
});

describe("raiseAndWait", () => {
  it("returns as soon as a human acknowledges", async () => {
    let polls = 0;
    const { fetch } = mockFetch((call) => {
      if (call.method === "POST") {
        return jsonResponse({ ...ESCALATION, delivery: { status: "queued", level: 1, will_page: [], deadline_at: "x" }, deduplicated: false }, 201);
      }
      polls++;
      return jsonResponse(
        polls >= 2
          ? { ...ESCALATION, status: "acknowledged", acknowledged: { at: "now", by_email: "tal@example.com", channel: "authenticated" } }
          : ESCALATION,
      );
    });
    const out = await makeSdk(fetch).escalations.raiseAndWait(ORG, { reason: "help" }, { pollMs: 5_000, timeoutMs: 60_000 });
    assert.equal(out.status, "acknowledged");
    assert.equal(out.acknowledged!.by_email, "tal@example.com");
  });

  it("returns the still-open escalation on timeout rather than throwing — silence is an answer the agent must handle", async () => {
    const { fetch } = mockFetch((call) =>
      call.method === "POST"
        ? jsonResponse({ ...ESCALATION, delivery: { status: "queued", level: 1, will_page: [], deadline_at: "x" }, deduplicated: false }, 201)
        : jsonResponse(ESCALATION),
    );
    const out = await makeSdk(fetch).escalations.raiseAndWait(ORG, { reason: "help" }, { pollMs: 5_000, timeoutMs: 1 });
    assert.equal(out.status, "open", "an unanswered page is reported, never thrown away or treated as consent");
  });
});
