import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { Run402, isLocalError } from "../index.js";
import type { CredentialsProvider } from "../credentials.js";
import { fromBase64url } from "./gitvault.crypto.js";
import { computeRoomInviteAuthHash, deriveRoomInviteAuthSecret, uuidToBytes } from "../node/bearer-claim-key.js";

interface FetchCall {
  url: string;
  method: string;
  body: unknown;
  headers: Record<string, string>;
}

function headersToObject(h: HeadersInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!h) return out;
  if (h instanceof Headers) {
    h.forEach((v, k) => (out[k.toLowerCase()] = v));
    return out;
  }
  for (const [k, v] of Object.entries(h as Record<string, string>)) out[k.toLowerCase()] = v;
  return out;
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
      headers: headersToObject(init?.headers),
    };
    calls.push(call);
    return handler(call);
  };
  return { fetch: fetchImpl, calls };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function makeSdk(fetchImpl: typeof globalThis.fetch, withCachedSession = true): Run402 {
  const creds: CredentialsProvider = {
    async getAuth() {
      // Simulate a cached control-plane session/SIWX credential — proves
      // `rooms.join`'s claim request never attaches it (design D5:
      // `withAuth: false`), even though one is available.
      return withCachedSession ? { "SIGN-IN-WITH-X": "test-siwx", Authorization: "Bearer cached-session-token" } : null;
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
const ROOM_KEY = "prj_1";

describe("rooms.invite", () => {
  it("mints locally (invite_id + master_secret), sends the correct auth_hash, and returns the key exactly once", async () => {
    let sentInviteId: string | undefined;
    let sentAuthHash: string | undefined;
    const { fetch, calls } = mockFetch((call) => {
      assert.equal(call.method, "POST");
      assert.equal(call.url, `https://api.example.test/orgs/v1/${ORG}/rooms/${ROOM_KEY}/invites`);
      const body = parsedBody(call) as { invite_id: string; auth_hash: string; note?: string; inviter_presence_id?: string; expires_in_seconds?: number };
      sentInviteId = body.invite_id;
      sentAuthHash = body.auth_hash;
      assert.equal(body.note, "working on #42");
      assert.equal(body.inviter_presence_id, "prs_inviter");
      assert.equal(body.expires_in_seconds, 1800);
      // The gateway never receives master_secret — only the id and the hash.
      assert.equal(Object.keys(body).sort().join(","), "auth_hash,expires_in_seconds,invite_id,inviter_presence_id,note");
      return jsonResponse({
        invite_id: body.invite_id,
        kind: "room",
        role: "viewer",
        room: { org_id: ORG, room_key: ROOM_KEY },
        expires_at: "2026-09-06T01:00:00.000Z",
        warning: "Whoever claims this key first becomes a viewer of this org, permanently, and can read every room in it. The key works once and expires at 2026-09-06T01:00:00.000Z.",
        warnings: [{ code: "ROOM_INVITE_KEY_CONFERS_SEAT", message: "…" }],
      }, 201);
    });

    const result = await makeSdk(fetch).rooms.invite(ORG, ROOM_KEY, {
      note: "working on #42",
      inviterPresenceId: "prs_inviter",
      expiresInSeconds: 1800,
    });

    assert.equal(calls.length, 1);
    assert.ok(result.key.startsWith("kri1_"));
    assert.equal(result.key.length, 69);
    assert.equal(result.invite_id, sentInviteId);
    assert.equal(result.kind, "room");
    assert.equal(result.role, "viewer");
    assert.deepEqual(result.room, { org_id: ORG, room_key: ROOM_KEY });
    assert.equal(result.warnings[0]!.code, "ROOM_INVITE_KEY_CONFERS_SEAT");

    // Cross-check: the auth_hash the mint sent is exactly what re-deriving
    // from the assembled key's own bytes would produce.
    const keyBody = result.key.slice("kri1_".length);
    const decoded = fromBase64url(keyBody, "test key body");
    const idBytes = decoded.subarray(0, 16);
    const masterSecret = decoded.subarray(16);
    assert.deepEqual([...idBytes], [...uuidToBytes(sentInviteId!)]);
    const expectedHash = computeRoomInviteAuthHash(deriveRoomInviteAuthSecret(idBytes, masterSecret));
    assert.equal(sentAuthHash, expectedHash);
  });

  it("sends no note/inviter_presence_id/expires_in_seconds when omitted", async () => {
    const { fetch, calls } = mockFetch((call) => {
      const body = parsedBody(call) as Record<string, unknown>;
      return jsonResponse({
        invite_id: body.invite_id,
        kind: "room",
        role: "viewer",
        room: { org_id: ORG, room_key: ROOM_KEY },
        expires_at: "2026-09-06T01:00:00.000Z",
        warning: "…",
        warnings: [],
      }, 201);
    });
    await makeSdk(fetch).rooms.invite(ORG, ROOM_KEY, {});
    const body = parsedBody(calls[0]!) as Record<string, unknown>;
    assert.equal(Object.keys(body).sort().join(","), "auth_hash,invite_id");
  });

  it("throws ROOM_INVITE_ID_MISMATCH when the gateway echoes a different invite_id than requested", async () => {
    const { fetch } = mockFetch((call) => {
      const body = parsedBody(call) as { invite_id: string };
      return jsonResponse({
        invite_id: "11111111-1111-4111-8111-111111111111", // deliberately NOT body.invite_id
        kind: "room",
        role: "viewer",
        room: { org_id: ORG, room_key: ROOM_KEY },
        expires_at: "2026-09-06T01:00:00.000Z",
        warning: "…",
        warnings: [],
      }, 201);
    });
    await assert.rejects(
      () => makeSdk(fetch).rooms.invite(ORG, ROOM_KEY, {}),
      (e: unknown) => isLocalError(e) && (e as { code?: string }).code === "ROOM_INVITE_ID_MISMATCH",
    );
  });

  it("requires both orgId and roomKey", async () => {
    const { fetch } = mockFetch(() => jsonResponse({}));
    const sdk = makeSdk(fetch);
    await assert.rejects(() => sdk.rooms.invite("", ROOM_KEY, {}), (e: unknown) => isLocalError(e));
    await assert.rejects(() => sdk.rooms.invite(ORG, "", {}), (e: unknown) => isLocalError(e));
  });
});

describe("rooms.join (key form)", () => {
  const INVITE_ID = "22222222-2222-4222-8222-222222222222";

  async function mintTestKey(): Promise<string> {
    const { assembleRoomInviteKey } = await import("../node/bearer-claim-key.js");
    return assembleRoomInviteKey(INVITE_ID).key;
  }

  it("claims through the paid fetch WITHOUT a bearer credential, even when one is cached", async () => {
    const key = await mintTestKey();
    const { fetch, calls } = mockFetch((call) => {
      assert.equal(call.method, "POST");
      assert.equal(call.url, `https://api.example.test/rooms/v1/invites/${INVITE_ID}/claim`);
      // Design D5: no SIGN-IN-WITH-X, no Authorization — even though this
      // SDK instance's credentials provider WOULD hand both out.
      assert.equal(call.headers["sign-in-with-x"], undefined);
      assert.equal(call.headers["authorization"], undefined);
      return jsonResponse({
        invite_id: INVITE_ID,
        kind: "room",
        deduplicated: false,
        org_id: ORG,
        membership: { org_id: ORG, role: "viewer", status: "active" },
        room: { org_id: ORG, room_key: ROOM_KEY },
        inviter: { presence_id: "prs_1", name: "Opus", program: "claude-code", model: "fable-5", state: "active", last_active: "2026-09-06T00:00:00.000Z" },
        live_presences: [],
        cursor: "mcr_1",
        recent_messages: [],
        note: "working on #42",
        seat: { sku: "room_seat", amount_usd_micros: 10_000, network: "base-sepolia", charge_id: "chg_1" },
        expires_at: "2026-09-06T01:00:00.000Z",
      });
    });
    const result = await makeSdk(fetch).rooms.join(key);
    assert.equal(calls.length, 1);
    assert.equal(result.invite_id, INVITE_ID);
    assert.equal(result.membership.role, "viewer");
    assert.equal(result.deduplicated, false);
    assert.equal(result.seat.sku, "room_seat");
  });

  it("sends auth_secret as base64url, matching the key's own derivation", async () => {
    const key = await mintTestKey();
    const { parseRoomInviteKey, deriveRoomInviteAuthSecret } = await import("../node/bearer-claim-key.js");
    const parsed = parseRoomInviteKey(key);
    const expectedSecret = deriveRoomInviteAuthSecret(parsed.invite_id_bytes, parsed.master_secret);
    const { toBase64url } = await import("./gitvault.crypto.js");

    const { fetch, calls } = mockFetch((call) => {
      const body = parsedBody(call) as { auth_secret: string };
      assert.equal(body.auth_secret, toBase64url(expectedSecret));
      return jsonResponse({
        invite_id: INVITE_ID, kind: "room", deduplicated: false, org_id: ORG,
        membership: { org_id: ORG, role: "viewer", status: "active" },
        room: { org_id: ORG, room_key: ROOM_KEY }, inviter: null, live_presences: [],
        cursor: "mcr_1", recent_messages: [], note: null,
        seat: { sku: "room_seat", amount_usd_micros: 10_000, network: "base-sepolia", charge_id: null },
        expires_at: "2026-09-06T01:00:00.000Z",
      });
    });
    await makeSdk(fetch).rooms.join(key);
    assert.equal(calls.length, 1);
  });

  it("refuses a kgi1_ (gitvault invite) key by name, naming `run402 repos join`, before any network call", async () => {
    const { assembleInviteKey } = await import("../node/gitvault-handoff.js");
    const { key } = assembleInviteKey("33333333-3333-4333-8333-333333333333");
    const { fetch, calls } = mockFetch(() => jsonResponse({}));
    await assert.rejects(
      () => makeSdk(fetch).rooms.join(key),
      (e: unknown) => {
        const err = e as { code?: string; details?: { kind?: string } };
        return err.code === "ROOM_INVITE_KEY_WRONG_KIND" && err.details?.kind === "invite";
      },
    );
    assert.equal(calls.length, 0, "the gateway must never be contacted for a wrong-kind key");
  });

  it("refuses a kgh1_ (gitvault handoff) key by name, naming `run402 repos resume`, before any network call", async () => {
    const { assembleHandoffKey } = await import("../node/gitvault-handoff.js");
    const { key } = assembleHandoffKey("44444444-4444-4444-8444-444444444444");
    const { fetch, calls } = mockFetch(() => jsonResponse({}));
    await assert.rejects(
      () => makeSdk(fetch).rooms.join(key),
      (e: unknown) => {
        const err = e as { code?: string; details?: { kind?: string } };
        return err.code === "ROOM_INVITE_KEY_WRONG_KIND" && err.details?.kind === "handoff";
      },
    );
    assert.equal(calls.length, 0);
  });

  it("requires a key", async () => {
    const { fetch } = mockFetch(() => jsonResponse({}));
    await assert.rejects(() => makeSdk(fetch).rooms.join(""), (e: unknown) => isLocalError(e));
  });
});

describe("ScopedRoom.invite", () => {
  it("pre-binds orgId/roomKey", async () => {
    const { fetch, calls } = mockFetch((call) => {
      const body = parsedBody(call) as { invite_id: string };
      return jsonResponse({
        invite_id: body.invite_id, kind: "room", role: "viewer",
        room: { org_id: ORG, room_key: ROOM_KEY }, expires_at: "2026-09-06T01:00:00.000Z",
        warning: "…", warnings: [],
      }, 201);
    });
    const scoped = makeSdk(fetch).rooms.scoped(ORG, ROOM_KEY);
    const result = await scoped.invite({ note: "hi" });
    assert.equal(calls[0]!.url, `https://api.example.test/orgs/v1/${ORG}/rooms/${ROOM_KEY}/invites`);
    assert.deepEqual(result.room, { org_id: ORG, room_key: ROOM_KEY });
  });
});
