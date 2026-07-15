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

const PAGE = {
  events: [
    {
      id: "evc_2c",
      event_type: "deploy_activated",
      class: "lifecycle",
      occurred_at: "2026-07-11T09:14:03.000Z",
      payload: { release_id: "rel_1", operation_id: "op_1" },
      next_actions: [{ type: "check_release", method: "GET", path: "/apply/v1/operations/op_1" }],
    },
  ],
  cursor: "evc_2c",
  has_more: false,
  reset: false,
};

describe("events.list", () => {
  it("GETs the project events route with no query when no options given", async () => {
    const { fetch } = mockFetch((call) => {
      assert.equal(call.method, "GET");
      assert.equal(call.url, "https://api.example.test/projects/v1/prj_1/events");
      return jsonResponse(PAGE);
    });
    const page = await makeSdk(fetch).events.list("prj_1");
    assert.equal(page.cursor, "evc_2c");
    assert.equal(page.events[0]!.event_type, "deploy_activated");
  });

  it("passes cursor + limit through opaquely as query params", async () => {
    const { fetch } = mockFetch((call) => {
      assert.equal(call.url, "https://api.example.test/projects/v1/prj_1/events?cursor=evc_1a2b&limit=5");
      return jsonResponse({ events: [], cursor: "evc_1a2b", has_more: false, reset: false });
    });
    const page = await makeSdk(fetch).events.list("prj_1", { cursor: "evc_1a2b", limit: 5 });
    // Empty page echoes the caller's cursor unchanged.
    assert.equal(page.cursor, "evc_1a2b");
  });

  it("surfaces reset + earliest_cursor without reinterpretation", async () => {
    const { fetch } = mockFetch(() =>
      jsonResponse({ events: [], cursor: "evc_0", has_more: false, reset: true, earliest_cursor: "evc_3b" }),
    );
    const page = await makeSdk(fetch).events.list("prj_1", { cursor: "garbage" });
    assert.equal(page.reset, true);
    assert.equal(page.earliest_cursor, "evc_3b");
  });

  it("rejects locally when projectId is missing", async () => {
    const { fetch, calls } = mockFetch(() => jsonResponse(PAGE));
    await assert.rejects(
      makeSdk(fetch).events.list(""),
      (err: unknown) => isLocalError(err),
    );
    assert.equal(calls.length, 0);
  });

  it("is available project-scoped with the id pre-bound", async () => {
    const { fetch } = mockFetch((call) => {
      assert.equal(call.url, "https://api.example.test/projects/v1/prj_9/events?cursor=evc_2");
      return jsonResponse(PAGE);
    });
    const scoped = await makeSdk(fetch).project("prj_9");
    const page = await scoped.events.list({ cursor: "evc_2" });
    assert.equal(page.has_more, false);
  });

  it("passes source through as the wire `source` param", async () => {
    const { fetch } = mockFetch((call) => {
      assert.equal(call.url, "https://api.example.test/projects/v1/prj_1/events?source=app");
      return jsonResponse({ events: [], cursor: "evc_0", has_more: false, reset: false });
    });
    await makeSdk(fetch).events.list("prj_1", { source: "app" });
  });

  it("serializes a single eventType string as the wire `event_type` param", async () => {
    const { fetch } = mockFetch((call) => {
      assert.equal(
        call.url,
        "https://api.example.test/projects/v1/prj_1/events?event_type=signature_completed",
      );
      return jsonResponse({ events: [], cursor: "evc_0", has_more: false, reset: false });
    });
    await makeSdk(fetch).events.list("prj_1", { eventType: "signature_completed" });
  });

  it("serializes an eventType array as a comma-joined `event_type` param", async () => {
    const { fetch } = mockFetch((call) => {
      assert.equal(
        call.url,
        "https://api.example.test/projects/v1/prj_1/events?event_type=signature_completed%2Cbooking_created",
      );
      return jsonResponse({ events: [], cursor: "evc_0", has_more: false, reset: false });
    });
    await makeSdk(fetch).events.list("prj_1", {
      eventType: ["signature_completed", "booking_created"],
    });
  });

  it("composes source + eventType with cursor/limit unchanged", async () => {
    const { fetch } = mockFetch((call) => {
      assert.equal(
        call.url,
        "https://api.example.test/projects/v1/prj_1/events?cursor=evc_1a2b&limit=5&source=platform&event_type=deploy_activated",
      );
      return jsonResponse({ events: [], cursor: "evc_1a2b", has_more: false, reset: false });
    });
    await makeSdk(fetch).events.list("prj_1", {
      cursor: "evc_1a2b",
      limit: 5,
      source: "platform",
      eventType: "deploy_activated",
    });
  });
});

describe("events.listForOrg", () => {
  it("GETs the org events route", async () => {
    const { fetch } = mockFetch((call) => {
      assert.equal(call.method, "GET");
      assert.equal(
        call.url,
        "https://api.example.test/orgs/v1/00000000-0000-0000-0000-aaaaaaaaaaaa/events?limit=10",
      );
      return jsonResponse({ events: [], cursor: "evc_0", has_more: false, reset: false });
    });
    const page = await makeSdk(fetch).events.listForOrg("00000000-0000-0000-0000-aaaaaaaaaaaa", { limit: 10 });
    assert.equal(page.reset, false);
  });

  it("rejects locally when orgId is missing", async () => {
    const { fetch, calls } = mockFetch(() => jsonResponse(PAGE));
    await assert.rejects(
      makeSdk(fetch).events.listForOrg(""),
      (err: unknown) => isLocalError(err),
    );
    assert.equal(calls.length, 0);
  });

  it("passes source + eventType through on the org-wide union", async () => {
    const { fetch } = mockFetch((call) => {
      assert.equal(
        call.url,
        "https://api.example.test/orgs/v1/00000000-0000-0000-0000-aaaaaaaaaaaa/events?source=app&event_type=signature_completed",
      );
      return jsonResponse({ events: [], cursor: "evc_0", has_more: false, reset: false });
    });
    await makeSdk(fetch).events.listForOrg("00000000-0000-0000-0000-aaaaaaaaaaaa", {
      source: "app",
      eventType: "signature_completed",
    });
  });
});
