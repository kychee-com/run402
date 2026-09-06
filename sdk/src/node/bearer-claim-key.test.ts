import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash, hkdfSync } from "node:crypto";
import {
  HANDOFF_KEY_PREFIXES,
  assembleHandoffKey,
  assembleInviteKey,
  assembleRoomInviteKey,
  computeRoomInviteAuthHash,
  deriveHandoffSecrets,
  deriveInviteSecrets,
  deriveRoomInviteAuthSecret,
  parseClaimKey,
  parseHandoffKey,
  parseInviteKey,
  parseRoomInviteKey,
  randomClaimId,
  uuidToBytes,
} from "./bearer-claim-key.js";
import { randomBytes } from "../namespaces/gitvault.crypto.js";

const HANDOFF_ID = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
const INVITE_ID = "4fa85f64-5717-4562-b3fc-2c963f66afa7";
const ROOM_INVITE_ID = "5fa85f64-5717-4562-b3fc-2c963f66afa8";

// ─── Registry shape ──────────────────────────────────────────────────────────

describe("HANDOFF_KEY_PREFIXES — three rows (add-room-invite design D3)", () => {
  it("kgh1_/handoff/resume, kgi1_/invite/join, kri1_/room/join, in that order", () => {
    assert.equal(HANDOFF_KEY_PREFIXES.length, 3);
    assert.equal(HANDOFF_KEY_PREFIXES[0]!.prefix, "kgh1_");
    assert.equal(HANDOFF_KEY_PREFIXES[0]!.kind, "handoff");
    assert.equal(HANDOFF_KEY_PREFIXES[0]!.verb, "resume");
    assert.equal(HANDOFF_KEY_PREFIXES[1]!.prefix, "kgi1_");
    assert.equal(HANDOFF_KEY_PREFIXES[1]!.kind, "invite");
    assert.equal(HANDOFF_KEY_PREFIXES[1]!.verb, "join");
    assert.equal(HANDOFF_KEY_PREFIXES[2]!.prefix, "kri1_");
    assert.equal(HANDOFF_KEY_PREFIXES[2]!.kind, "room");
    assert.equal(HANDOFF_KEY_PREFIXES[2]!.verb, "join");
  });

  it("the room row carries no envelope/note-schema/frame-magic — a room invite has no envelope", () => {
    const room = HANDOFF_KEY_PREFIXES[2]!;
    assert.equal(room.envelopeKind, undefined);
    assert.equal(room.noteSchema, undefined);
    assert.equal(room.frameMagic, undefined);
  });
});

// ─── assemble/parse round trips ──────────────────────────────────────────────

describe("assembleRoomInviteKey / parseRoomInviteKey — round trip", () => {
  it("assembles a 69-char kri1_ key and parses it back to the same id/secret", () => {
    const secret = randomBytes(32);
    const { key, invite_id_bytes, master_secret } = assembleRoomInviteKey(ROOM_INVITE_ID, secret);
    assert.equal(key.length, 69);
    assert.ok(key.startsWith("kri1_"));
    const parsed = parseRoomInviteKey(key);
    assert.equal(parsed.kind, "room");
    assert.equal(parsed.invite_id, ROOM_INVITE_ID);
    assert.deepEqual([...parsed.invite_id_bytes], [...invite_id_bytes]);
    assert.deepEqual([...parsed.master_secret], [...secret]);
    assert.deepEqual([...parsed.master_secret], [...master_secret]);
  });

  it("parseClaimKey(raw, 'room') is the same parser under its generic name", () => {
    const { key } = assembleRoomInviteKey(ROOM_INVITE_ID);
    const parsed = parseClaimKey(key, "room");
    assert.equal(parsed.kind, "room");
    assert.equal(parsed.id, ROOM_INVITE_ID);
  });

  it("defaults to a fresh random master secret when none is supplied", () => {
    const a = assembleRoomInviteKey(ROOM_INVITE_ID);
    const b = assembleRoomInviteKey(ROOM_INVITE_ID);
    assert.notEqual(a.key, b.key);
  });
});

describe("randomClaimId", () => {
  it("mints a canonical, RFC-4122-v4-shaped UUID", () => {
    const id = randomClaimId();
    assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    // uuidToBytes/back round-trips without throwing — it is a canonical UUID.
    assert.equal(uuidToBytes(id).length, 16);
  });

  it("is usable directly as a room invite id", () => {
    const id = randomClaimId();
    const { key } = assembleRoomInviteKey(id);
    assert.equal(parseRoomInviteKey(key).invite_id, id);
  });
});

// ─── Cross-side vector: the client's derivation matches the gateway's ───────

describe("deriveRoomInviteAuthSecret / computeRoomInviteAuthHash — HKDF vectors, domain-separated from every vault kind (add-room-invite design D3)", () => {
  it("matches an independent recomputation of the gateway's own HKDF/hash labels", () => {
    const idBytes = uuidToBytes(ROOM_INVITE_ID);
    const masterSecret = randomBytes(32);
    const authSecret = deriveRoomInviteAuthSecret(idBytes, masterSecret);
    const expectedAuthSecret = hkdfSync("sha256", masterSecret, idBytes, Buffer.from("run402/room-invite/auth/v1", "utf8"), 32);
    assert.deepEqual(Buffer.from(authSecret), Buffer.from(expectedAuthSecret));

    const authHash = computeRoomInviteAuthHash(authSecret);
    const expectedHash = createHash("sha256")
      .update(Buffer.concat([Buffer.from("run402/room-invite/auth-hash/v1", "utf8"), Buffer.from(authSecret)]))
      .digest("hex");
    assert.equal(authHash, expectedHash);
  });

  it("a room auth_secret never verifies as a handoff or invite auth_hash, or the reverse", () => {
    const idBytes = uuidToBytes(ROOM_INVITE_ID);
    const masterSecret = randomBytes(32);
    const roomHash = computeRoomInviteAuthHash(deriveRoomInviteAuthSecret(idBytes, masterSecret));
    const handoffHash = deriveHandoffSecrets(idBytes, masterSecret).auth_hash_hex;
    const inviteHash = deriveInviteSecrets(idBytes, masterSecret).auth_hash_hex;
    assert.notEqual(roomHash, handoffHash);
    assert.notEqual(roomHash, inviteHash);
    assert.notEqual(handoffHash, inviteHash);
  });

  it("auth_hash is 64 lowercase hex characters — exactly what the gateway's mint route requires", () => {
    const authSecret = deriveRoomInviteAuthSecret(uuidToBytes(ROOM_INVITE_ID), randomBytes(32));
    const hash = computeRoomInviteAuthHash(authSecret);
    assert.match(hash, /^[0-9a-f]{64}$/);
  });
});

// ─── The full 3×3 cross-kind refusal table (task 1.3) ───────────────────────
//
// Every (door, key-kind) pair where door !== key-kind refuses BY NAME,
// naming the key's OWN door, before any network call (parse-only —
// synchronous throw, no awaited call in the stack). The 3 diagonal
// (matching) pairs round-trip successfully and are covered above /
// elsewhere; this table is exactly the 6 off-diagonal refusals.

const DOORS = [
  { parse: parseHandoffKey, expectedKind: "handoff" as const, errorPrefix: "HANDOFF", doorLabel: "run402 repos resume" },
  { parse: parseInviteKey, expectedKind: "invite" as const, errorPrefix: "INVITE", doorLabel: "run402 repos join" },
  { parse: parseRoomInviteKey, expectedKind: "room" as const, errorPrefix: "ROOM_INVITE", doorLabel: "run402 rooms join" },
];

const KEYS = [
  { kind: "handoff" as const, key: assembleHandoffKey(HANDOFF_ID).key, verb: "resume" },
  { kind: "invite" as const, key: assembleInviteKey(INVITE_ID).key, verb: "join" },
  { kind: "room" as const, key: assembleRoomInviteKey(ROOM_INVITE_ID).key, verb: "join" },
];

describe("the full 3×3 cross-kind refusal table (task 1.3)", () => {
  for (const door of DOORS) {
    for (const wrongKey of KEYS.filter((k) => k.kind !== door.expectedKind)) {
      it(`${door.expectedKind}'s door refuses a ${wrongKey.kind} key by name, naming its own door (never contacting the gateway)`, () => {
        assert.throws(
          () => door.parse(wrongKey.key),
          (e: unknown) => {
            const err = e as { code?: string; details?: { kind?: string; verb?: string } };
            return (
              err.code === `${door.errorPrefix}_KEY_WRONG_KIND` &&
              err.details?.kind === wrongKey.kind &&
              err.details?.verb === wrongKey.verb
            );
          },
        );
      });
    }

    it(`${door.expectedKind}'s door accepts its own key kind`, () => {
      const own = KEYS.find((k) => k.kind === door.expectedKind)!;
      assert.doesNotThrow(() => door.parse(own.key));
    });
  }

  it("every refusal above is a synchronous throw — no Promise, no network code path reachable", () => {
    const roomKey = assembleRoomInviteKey(ROOM_INVITE_ID).key;
    // A function that ever awaited a gateway call could not throw
    // synchronously like this — try/catch here proves the throw happens
    // before any microtask boundary.
    let threw = false;
    try {
      parseHandoffKey(roomKey);
    } catch {
      threw = true;
    }
    assert.ok(threw);
  });
});
