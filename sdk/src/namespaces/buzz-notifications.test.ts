import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { Run402, isLocalError } from "../index.js";
import type { CredentialsProvider } from "../credentials.js";
import type { BuzzRouteDelivery, BuzzRouteTestDelivery } from "./buzz-notifications.types.js";

interface FetchCall {
  url: string;
  method: string;
  body: unknown;
  headers: Headers;
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
      headers: new Headers(init?.headers),
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

// org_id is a BARE dashed UUID on the wire — never org_-prefixed.
const ORG = "00000000-0000-0000-0000-aaaaaaaaaaaa";
const ROUTE_ID = `buzzper_${"1".repeat(32)}`;
const DELIVERY_ID = `buzzped_${"2".repeat(32)}`;
const BASE = "https://api.example.test/buzz-project-event-routes/v1";

const ROUTE = {
  buzz_project_event_route_id: ROUTE_ID,
  org_id: ORG,
  buzz_community_installation_id: `buzzci_${"3".repeat(32)}`,
  route_name: "deploys",
  buzz_channel_id: "chan-1",
  project_ids: ["prj_a"],
  event_types: null,
  event_classes: null,
  status: "active",
  pause_reason: null,
  paused_at: null,
  revision: 1,
  start_after_event_id: 100,
  consecutive_hard_failures: 0,
  notification_principal_id: `buzznp_${"4".repeat(32)}`,
  notification_pubkey: "ab".repeat(32),
  signing_generation: 1,
  created_at: "2026-08-12T10:00:00.000Z",
  updated_at: "2026-08-12T10:00:00.000Z",
  revoked_at: null,
};

const QUEUED_DELIVERY = {
  buzz_project_event_delivery_id: DELIVERY_ID,
  kind: "test",
  status: "queued",
  event_type: "buzz_route_test",
  project_id: "prj_a",
  project_event_id: null,
  occurred_at: "2026-08-12T10:01:00.000Z",
  nostr_event_id: "ev1",
  projection_hash: "ph",
  signing_generation: 1,
  attempt_count: 0,
  next_attempt_at: "2026-08-12T10:01:00.000Z",
  last_error: null,
  suppressed_reason: null,
  created_at: "2026-08-12T10:01:00.000Z",
  delivered_at: null,
  terminal_at: null,
};

describe("buzz.notifications.createRoute", () => {
  it("POSTs the snake_case body with an auto Idempotency-Key and returns the authorization block", async () => {
    const { fetch, calls } = mockFetch(() =>
      jsonResponse({
        ...ROUTE,
        status: "pending_authorization",
        authorization: {
          status: "pending_buzz_authorization",
          notification_pubkey: ROUTE.notification_pubkey,
          connect_command: `buzz-admin add-member --pubkey ${ROUTE.notification_pubkey}`,
          instructions: "Ask a community owner or admin to add this pubkey as a relay member…",
          verify_path: `/buzz-project-event-routes/v1/${ROUTE_ID}/test`,
        },
      }, 201),
    );
    const out = await makeSdk(fetch).buzz.notifications.createRoute(ORG, {
      installationId: ROUTE.buzz_community_installation_id,
      routeName: "deploys",
      buzzChannelId: "chan-1",
      projectIds: ["prj_a", "prj_b"],
      eventTypes: ["deploy_activated"],
    });
    assert.equal(calls[0]!.url, BASE);
    assert.equal(calls[0]!.method, "POST");
    assert.ok(calls[0]!.headers.get("Idempotency-Key"), "every route mutation is idempotent — the key is auto-generated");
    assert.deepEqual(parsedBody(calls[0]!), {
      org_id: ORG,
      buzz_community_installation_id: ROUTE.buzz_community_installation_id,
      route_name: "deploys",
      buzz_channel_id: "chan-1",
      project_ids: ["prj_a", "prj_b"],
      event_types: ["deploy_activated"],
    });
    assert.equal(out.authorization.status, "pending_buzz_authorization");
  });

  it("passes an explicit null filter (clear back to every registered type) but omits undefined", async () => {
    const { fetch, calls } = mockFetch(() => jsonResponse({ ...ROUTE, authorization: { status: "authorized", notification_pubkey: ROUTE.notification_pubkey } }, 201));
    await makeSdk(fetch).buzz.notifications.createRoute(ORG, {
      installationId: ROUTE.buzz_community_installation_id,
      routeName: "deploys",
      buzzChannelId: "chan-1",
      projectIds: ["prj_a"],
      eventClasses: null,
    });
    const body = parsedBody(calls[0]!) as Record<string, unknown>;
    assert.equal(body.event_classes, null);
    assert.ok(!("event_types" in body), "an unset filter is omitted, never fabricated");
  });

  it("honors a caller-supplied idempotency key", async () => {
    const { fetch, calls } = mockFetch(() => jsonResponse({ ...ROUTE, authorization: { status: "authorized", notification_pubkey: "x" } }, 201));
    await makeSdk(fetch).buzz.notifications.createRoute(ORG, {
      installationId: ROUTE.buzz_community_installation_id,
      routeName: "deploys",
      buzzChannelId: "chan-1",
      projectIds: ["prj_a"],
      idempotencyKey: "route-1",
    });
    assert.equal(calls[0]!.headers.get("Idempotency-Key"), "route-1");
  });

  it("refuses locally without an orgId or with an empty project scope", async () => {
    const { fetch, calls } = mockFetch(() => jsonResponse({}));
    const sdk = makeSdk(fetch);
    await assert.rejects(
      () => sdk.buzz.notifications.createRoute("", { installationId: "buzzci_x", routeName: "r", buzzChannelId: "c", projectIds: ["p"] }),
      (err: unknown) => isLocalError(err),
    );
    await assert.rejects(
      () => sdk.buzz.notifications.createRoute(ORG, { installationId: "buzzci_x", routeName: "r", buzzChannelId: "c", projectIds: [] }),
      (err: unknown) => isLocalError(err),
    );
    assert.equal(calls.length, 0, "local validation failures never reach the network");
  });
});

describe("buzz.notifications reads", () => {
  it("list GETs by bare-uuid org_id and unwraps the plural key", async () => {
    const { fetch, calls } = mockFetch(() => jsonResponse({ buzz_project_event_routes: [ROUTE] }));
    const out = await makeSdk(fetch).buzz.notifications.list(ORG);
    assert.equal(calls[0]!.url, `${BASE}?org_id=${encodeURIComponent(ORG)}`);
    assert.equal(calls[0]!.method, "GET");
    assert.equal(out.length, 1);
  });

  it("get returns the detail with health derived from state, not queue emptiness", async () => {
    const { fetch, calls } = mockFetch(() =>
      jsonResponse({
        ...ROUTE,
        health: "signing_unavailable",
        notification_principal_status: "revoked",
        delivery_counts: { queued: 0, retryable: 0, delivered: 3, suppressed: 0, dead_letter: 0, cancelled: 0 },
        oldest_pending_created_at: null,
        newest_project_event_id: 100,
        consumer_cursor: null,
      }),
    );
    const out = await makeSdk(fetch).buzz.notifications.get(ROUTE_ID);
    assert.equal(calls[0]!.url, `${BASE}/${ROUTE_ID}`);
    assert.equal(out.health, "signing_unavailable");
    assert.equal(out.consumer_cursor, null, "a consumer position is never fabricated");
  });

  it("deliveries maps limit/cursor/deliveryId onto the query and carries the keyset envelope", async () => {
    const { fetch, calls } = mockFetch(() =>
      jsonResponse({ buzz_project_event_deliveries: [QUEUED_DELIVERY], has_more: true, next_cursor: "cur_2" }),
    );
    const out = await makeSdk(fetch).buzz.notifications.deliveries(ROUTE_ID, { limit: 10, cursor: "cur_1", deliveryId: DELIVERY_ID });
    assert.match(calls[0]!.url, /limit=10/);
    assert.match(calls[0]!.url, /cursor=cur_1/);
    assert.match(calls[0]!.url, new RegExp(`delivery_id=${DELIVERY_ID}`));
    assert.equal(out.has_more, true);
    assert.equal(out.next_cursor, "cur_2");
  });

  it("requires a routeId locally", async () => {
    const { fetch, calls } = mockFetch(() => jsonResponse({}));
    await assert.rejects(
      () => makeSdk(fetch).buzz.notifications.get(""),
      (err: unknown) => isLocalError(err),
    );
    assert.equal(calls.length, 0);
  });
});

describe("buzz.notifications lifecycle mutations", () => {
  it("update PATCHes only the touched fields plus expected_revision, idempotently", async () => {
    const { fetch, calls } = mockFetch(() => jsonResponse({ ...ROUTE, revision: 2 }));
    const out = await makeSdk(fetch).buzz.notifications.update(ROUTE_ID, { routeName: "renamed", eventTypes: null }, 1);
    assert.equal(calls[0]!.url, `${BASE}/${ROUTE_ID}`);
    assert.equal(calls[0]!.method, "PATCH");
    assert.ok(calls[0]!.headers.get("Idempotency-Key"));
    assert.deepEqual(parsedBody(calls[0]!), { expected_revision: 1, route_name: "renamed", event_types: null });
    assert.equal(out.revision, 2);
  });

  it("update refuses a non-integer expectedRevision locally", async () => {
    const { fetch, calls } = mockFetch(() => jsonResponse({}));
    await assert.rejects(
      () => makeSdk(fetch).buzz.notifications.update(ROUTE_ID, { routeName: "x" }, 1.5),
      (err: unknown) => isLocalError(err),
    );
    assert.equal(calls.length, 0);
  });

  it("pause and resume POST the literal lifecycle paths", async () => {
    const { fetch, calls } = mockFetch(() => jsonResponse(ROUTE));
    const sdk = makeSdk(fetch);
    await sdk.buzz.notifications.pause(ROUTE_ID);
    await sdk.buzz.notifications.resume(ROUTE_ID);
    assert.equal(calls[0]!.url, `${BASE}/${ROUTE_ID}/pause`);
    assert.equal(calls[1]!.url, `${BASE}/${ROUTE_ID}/resume`);
    assert.equal(calls[0]!.method, "POST");
    assert.equal(calls[1]!.method, "POST");
  });

  it("revoke DELETEs and reports whether the credential died with its last route", async () => {
    const { fetch, calls } = mockFetch(() =>
      jsonResponse({ ...ROUTE, status: "revoked", revoked_at: "2026-08-12T11:00:00.000Z", notification_credential_destroyed: true }),
    );
    const out = await makeSdk(fetch).buzz.notifications.revoke(ROUTE_ID, "revoke-1");
    assert.equal(calls[0]!.method, "DELETE");
    assert.equal(calls[0]!.url, `${BASE}/${ROUTE_ID}`);
    assert.equal(calls[0]!.headers.get("Idempotency-Key"), "revoke-1");
    assert.equal(out.notification_credential_destroyed, true);
  });

  it("rotate returns the staged 202 rotation block — the swap is NOT active yet", async () => {
    const { fetch, calls } = mockFetch(() =>
      jsonResponse({
        buzz_project_event_route_id: ROUTE_ID,
        rotation: {
          status: "pending_buzz_authorization",
          next_signing_generation: 2,
          next_notification_pubkey: "cd".repeat(32),
          authorize_hint: "Ask a community owner or admin to add the NEXT pubkey…",
          verify_path: `/buzz-project-event-routes/v1/${ROUTE_ID}/test`,
        },
      }, 202),
    );
    const out = await makeSdk(fetch).buzz.notifications.rotate(ROUTE_ID);
    assert.equal(calls[0]!.url, `${BASE}/${ROUTE_ID}/rotate`);
    assert.equal(out.rotation.status, "pending_buzz_authorization");
    assert.equal(out.rotation.next_signing_generation, 2);
  });
});

describe("buzz.notifications.test / testAndWait", () => {
  it("test POSTs and returns the queued 202 with its poll pointer", async () => {
    const { fetch, calls } = mockFetch(() =>
      jsonResponse({ ...QUEUED_DELIVERY, poll: { path: `/buzz-project-event-routes/v1/${ROUTE_ID}/deliveries?delivery_id=${DELIVERY_ID}` } }, 202),
    );
    const out = await makeSdk(fetch).buzz.notifications.test(ROUTE_ID);
    assert.equal(calls[0]!.url, `${BASE}/${ROUTE_ID}/test`);
    assert.equal(out.status, "queued", "the 202 is queued-not-delivered — Faithful");
    assert.ok(out.poll.path.includes(DELIVERY_ID));
  });

  it("testAndWait gives onPoll the 202 first and skips polling when already terminal", async () => {
    const { fetch, calls } = mockFetch(() =>
      jsonResponse({ ...QUEUED_DELIVERY, status: "delivered", delivered_at: "now", terminal_at: "now", poll: { path: "p" } }, 202),
    );
    const seen: string[] = [];
    const out = await makeSdk(fetch).buzz.notifications.testAndWait(ROUTE_ID, {
      onPoll: (s: BuzzRouteTestDelivery | BuzzRouteDelivery) => seen.push(s.status),
    });
    assert.equal(out.status, "delivered");
    assert.deepEqual(seen, ["delivered"], "the 202 response is the first observed state");
    assert.equal(calls.length, 1, "a terminal 202 never triggers a deliveries poll");
  });

  it("testAndWait polls the delivery by id until it settles", async () => {
    let polls = 0;
    const { fetch } = mockFetch((call) => {
      if (call.method === "POST") {
        return jsonResponse({ ...QUEUED_DELIVERY, poll: { path: "p" } }, 202);
      }
      assert.match(call.url, new RegExp(`delivery_id=${DELIVERY_ID}`), "the wait polls the SPECIFIC delivery");
      polls++;
      return jsonResponse({
        buzz_project_event_deliveries: [
          polls >= 2
            ? { ...QUEUED_DELIVERY, status: "delivered", delivered_at: "now", terminal_at: "now" }
            : QUEUED_DELIVERY,
        ],
        has_more: false,
      });
    });
    const seen: string[] = [];
    const out = await makeSdk(fetch).buzz.notifications.testAndWait(ROUTE_ID, {
      pollMs: 2_000,
      timeoutMs: 30_000,
      onPoll: (s: BuzzRouteTestDelivery | BuzzRouteDelivery) => seen.push(s.status),
    });
    assert.equal(out.status, "delivered");
    assert.equal(seen[0], "queued", "the 202 leads the narration");
    assert.equal(seen[seen.length - 1], "delivered");
  });

  it("testAndWait returns the still-queued delivery on timeout rather than throwing — the tick cadence is not failure", async () => {
    const { fetch } = mockFetch((call) =>
      call.method === "POST"
        ? jsonResponse({ ...QUEUED_DELIVERY, poll: { path: "p" } }, 202)
        : jsonResponse({ buzz_project_event_deliveries: [QUEUED_DELIVERY], has_more: false }),
    );
    const out = await makeSdk(fetch).buzz.notifications.testAndWait(ROUTE_ID, { pollMs: 2_000, timeoutMs: 1 });
    assert.equal(out.status, "queued", "an unsettled wait is reported, never converted into an exception");
  });
});
