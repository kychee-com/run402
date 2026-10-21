import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { Run402, isApiError, isLocalError } from "../index.js";
import type { CredentialsProvider } from "../credentials.js";

interface FetchCall {
  url: string;
  method: string;
  headers: Record<string, string>;
}

function mockFetch(handler: (call: FetchCall) => Response): { fetch: typeof globalThis.fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fetchImpl: typeof globalThis.fetch = async (input, init) => {
    const call: FetchCall = {
      url: String(input),
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
    };
    calls.push(call);
    return handler(call);
  };
  return { fetch: fetchImpl, calls };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function makeSdk(fetch: typeof globalThis.fetch, capabilities?: { returnSecrets: boolean }): Run402 {
  const creds: CredentialsProvider = {
    async getAuth() {
      return { "SIGN-IN-WITH-X": "test-siwx" };
    },
    async getProjectCredentials(id) {
      throw new Error(`unexpected local project credential lookup for ${id}`);
    },
  };
  return new Run402({ apiBase: "https://api.example.test", credentials: creds, fetch, ...(capabilities ? { capabilities } : {}) });
}

const BASE = "https://api.example.test/projects/v1/prj_kiwi/push";

const OUTCOMES = { queued: 0, retrying: 0, accepted: 2, removed: 0, failed: 0 };

const STATUS = {
  project_id: "prj_kiwi",
  subscriptions: {
    total: 2,
    users: [
      {
        user_id: "6f1c2b4e-0000-4000-8000-000000000001",
        phones: [
          { subscription_id: "psub_1", push_service: "web.push.apple.com", created_at: "2026-10-21T08:00:00.000Z", last_confirmed_at: "2026-10-21T08:00:00.000Z", last_accepted_at: null },
          { subscription_id: "psub_2", push_service: "fcm.googleapis.com", created_at: "2026-10-21T08:05:00.000Z", last_confirmed_at: "2026-10-21T08:05:00.000Z", last_accepted_at: "2026-10-21T09:00:01.000Z" },
        ],
      },
    ],
    users_shown: 1,
    users_total: 1,
    has_more: false,
  },
  usage: { deliveries_today: 12, limit: 100, resets_at: "2026-10-22T00:00:00.000Z", scope: "organization", org_id: "5f0a7c2e-6f0a-4a7e-9d1a-1a2b3c4d5e6f" },
  messages: [{ message_id: "pmsg_1", created_at: "2026-10-21T09:00:00.000Z", status: "completed", devices: 2, outcomes: OUTCOMES }],
};

const MESSAGE = {
  message_id: "pmsg_1",
  project_id: "prj_kiwi",
  created_at: "2026-10-21T09:00:00.000Z",
  status: "completed",
  devices: 2,
  title: "Kiwi",
  body: "4 hours since the last pee",
  url: "/",
  tag: "potty",
  to: null,
  outcomes: OUTCOMES,
  deliveries: [
    { subscription_id: "psub_2", user_id: "6f1c2b4e-0000-4000-8000-000000000001", push_service: "fcm.googleapis.com", status: "accepted", attempts: 1, last_status: 201, last_error: null, updated_at: "2026-10-21T09:00:01.000Z" },
  ],
  deliveries_shown: 1,
  has_more: false,
};

describe("push SDK", () => {
  it("status GETs the project's push route with the caller's auth and returns the typed read", async () => {
    const { fetch, calls } = mockFetch((call) => {
      assert.equal(call.url, BASE);
      assert.equal(call.method, "GET");
      assert.equal(call.headers["SIGN-IN-WITH-X"], "test-siwx");
      return jsonResponse(STATUS);
    });
    const status = await makeSdk(fetch).push.status("prj_kiwi");
    assert.equal(status.subscriptions.total, 2);
    assert.equal(status.subscriptions.users[0]!.phones[0]!.push_service, "web.push.apple.com");
    assert.equal(status.usage.limit, 100);
    assert.equal(status.usage.scope, "organization");
    assert.equal(status.messages[0]!.outcomes.accepted, 2);
    assert.equal(calls.length, 1);
  });

  it("getMessage GETs one message, encoding the id", async () => {
    const { fetch } = mockFetch((call) => {
      assert.equal(call.url, `${BASE}/messages/pmsg_1`);
      assert.equal(call.method, "GET");
      return jsonResponse(MESSAGE);
    });
    const message = await makeSdk(fetch).push.getMessage("prj_kiwi", "pmsg_1");
    assert.equal(message.title, "Kiwi");
    assert.equal(message.to, null);
    assert.equal(message.deliveries[0]!.last_status, 201);
    assert.equal(message.deliveries[0]!.status, "accepted");
  });

  it("an unknown message id surfaces the gateway's 404 code as an ApiError", async () => {
    const { fetch } = mockFetch(() => jsonResponse({ code: "RESOURCE_NOT_FOUND", message: "No such push message in this project." }, 404));
    await assert.rejects(
      () => makeSdk(fetch).push.getMessage("prj_kiwi", "pmsg_other"),
      (err: unknown) => {
        assert.ok(isApiError(err));
        assert.equal((err as { status?: number }).status, 404);
        assert.equal((err as { code?: string }).code, "RESOURCE_NOT_FOUND");
        return true;
      },
    );
  });

  it("refuses a missing project or message id locally, before any request", async () => {
    const { fetch, calls } = mockFetch(() => jsonResponse({}));
    const r = makeSdk(fetch);
    await assert.rejects(() => r.push.status(""), (err: unknown) => isLocalError(err));
    await assert.rejects(() => r.push.getMessage("prj_kiwi", ""), (err: unknown) => isLocalError(err));
    assert.equal(calls.length, 0);
  });

  it("is project-scoped as r.project(id).push", async () => {
    const { fetch, calls } = mockFetch((call) => jsonResponse(call.url.endsWith("/push") ? STATUS : MESSAGE));
    const p = makeSdk(fetch).project("prj_kiwi");
    assert.equal((await p.push.status()).project_id, "prj_kiwi");
    assert.equal((await p.push.getMessage("pmsg_1")).message_id, "pmsg_1");
    assert.deepEqual(calls.map((c) => c.url), [BASE, `${BASE}/messages/pmsg_1`]);
  });

  it("runs on the MCP sandbox surface: neither read carries a one-time secret", async () => {
    const { fetch, calls } = mockFetch((call) => jsonResponse(call.url.endsWith("/push") ? STATUS : MESSAGE));
    const r = makeSdk(fetch, { returnSecrets: false });
    await r.push.status("prj_kiwi");
    await r.push.getMessage("prj_kiwi", "pmsg_1");
    assert.equal(calls.length, 2);
  });
});
