/**
 * Bearer-claim key format — the pure, kind-agnostic primitives shared by
 * every bearer-addressed membership claim key this SDK mints or parses
 * (add-room-invite design D2/D3, mirroring the gateway's own
 * `services/bearer-claim-key.ts`).
 *
 * Through kygit-invite this lived inline in `gitvault-handoff.ts`: the key
 * registry (`HANDOFF_KEY_PREFIXES`), `uuidToBytes`, the generic
 * assemble/parse helpers, and the HKDF derivations for `auth_secret` /
 * `wrap_key`. add-room-invite adds a THIRD kind — `room` (`kri1_…`) — whose
 * claim confers org membership rather than vault access and carries no
 * `wrap_key`/envelope/admission-seed at all (design D3). Rather than teach
 * the vault-shaped module a room-shaped kind, the pure key-format
 * primitives move HERE (a move, not a copy — `gitvault-handoff.ts`
 * re-exports every symbol it previously exported, under its existing name,
 * so nothing importing it changes) and gain the room row alongside them.
 * Everything that is genuinely vault-specific — the sealed envelope, the
 * writer-admission grant/acceptance, the Handoff/Invite Note — stays in
 * `gitvault-handoff.ts`, which imports the pieces it needs from here.
 *
 * `HANDOFF_KEY_PREFIXES` is a REGISTRY: `kgh1_` (handoff, `resume`), `kgi1_`
 * (invite, `repos join`), `kri1_` (room, `rooms join`). `parseClaimKey`
 * refuses any other recognized-shape-but-wrong-kind prefix BY NAME, naming
 * the door it actually belongs at, rather than misreading it as a malformed
 * key of the kind the caller expected — never contacting the gateway.
 */
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { concatBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { LocalError } from "../errors.js";
import { fromBase64url, randomBytes, toBase64url, bytesToHex } from "../namespaces/gitvault.crypto.js";

function fail(code: string, message: string, context: string, details?: unknown): never {
  throw new LocalError(message, context, { code, details });
}

// ─── Key prefix / claim-kind registry (design D9 rule 4; kygit-invite D3; add-room-invite D3) ────

export type ClaimKind = "handoff" | "invite" | "room";

export interface HandoffKeyPrefixEntry {
  prefix: string;
  kind: ClaimKind;
  verb: string;
  /** Error-code prefix for this kind (`HANDOFF` | `INVITE` | `ROOM_INVITE`) — every client-side code this module throws is `${errorPrefix}_…`. */
  errorPrefix: string;
  /** The exact CLI invocation named in a cross-kind `*_KEY_WRONG_KIND` refusal (design D3/D9 rule 4). */
  doorLabel: string;
  /**
   * The sealed-envelope `envelope_kind` tag this kind's mint seals TODAY —
   * the v2 shape for both vault kinds (`v: 2`, `writer_admission_grant_sha256`,
   * `epoch_keys`), since writer admission rides the envelope for every vault
   * claim kind (gitvault-multi-writer D4). Absent for `room` — a room invite
   * has no envelope, no wrap key, no admission seed (add-room-invite D3).
   */
  envelopeKind?: string;
  /** This kind's note schema tag. Absent for `room` — a room invite carries a plaintext `note`, not a Handoff/Invite Note. */
  noteSchema?: string;
  /** This kind's envelope frame magic (4 ASCII bytes). Absent for `room`. */
  frameMagic?: string;
}

/**
 * `kgh1_` is the first row (handoff); `kgi1_` the second (invite,
 * kygit-invite design D3); `kri1_` the third (room, add-room-invite design
 * D3). A future kind is a SIBLING row here, never a branch on an existing
 * one's parser.
 */
export const HANDOFF_KEY_PREFIXES: readonly HandoffKeyPrefixEntry[] = [
  { prefix: "kgh1_", kind: "handoff", verb: "resume", errorPrefix: "HANDOFF", doorLabel: "run402 repos resume", envelopeKind: "kygit-handoff-envelope-v2", noteSchema: "kygit.handoff-note.v1", frameMagic: "KGH1" },
  { prefix: "kgi1_", kind: "invite", verb: "join", errorPrefix: "INVITE", doorLabel: "run402 repos join", envelopeKind: "kygit-invite-envelope-v2", noteSchema: "kygit.invite-note.v1", frameMagic: "KGI1" },
  { prefix: "kri1_", kind: "room", verb: "join", errorPrefix: "ROOM_INVITE", doorLabel: "run402 rooms join" },
];

const HANDOFF_ENTRY: HandoffKeyPrefixEntry = HANDOFF_KEY_PREFIXES[0]!;
const INVITE_ENTRY: HandoffKeyPrefixEntry = HANDOFF_KEY_PREFIXES[1]!;
const ROOM_ENTRY: HandoffKeyPrefixEntry = HANDOFF_KEY_PREFIXES[2]!;

function entryForKind(kind: ClaimKind): HandoffKeyPrefixEntry {
  return kind === "handoff" ? HANDOFF_ENTRY : kind === "invite" ? INVITE_ENTRY : ROOM_ENTRY;
}

const CLAIM_ID_BYTES = 16;
const MASTER_SECRET_BYTES = 32;
const CLAIM_KEY_BODY_BYTES = CLAIM_ID_BYTES + MASTER_SECRET_BYTES;

export interface ClaimKeyParts {
  kind: ClaimKind;
  id_bytes: Uint8Array;
  /** Canonical lowercase-hyphenated UUID form of `id_bytes` — the wire id (`handoff_id`/`invite_id`). */
  id: string;
  master_secret: Uint8Array;
}

/** {@link parseHandoffKey}'s legacy field names, preserved byte-identical. */
export interface HandoffKeyParts {
  kind: "handoff";
  handoff_id_bytes: Uint8Array;
  handoff_id: string;
  master_secret: Uint8Array;
}

/** {@link parseInviteKey}'s field names — the invite-kind sibling of {@link HandoffKeyParts}. */
export interface InviteKeyParts {
  kind: "invite";
  invite_id_bytes: Uint8Array;
  invite_id: string;
  master_secret: Uint8Array;
}

/** {@link parseRoomInviteKey}'s field names — the room-kind sibling of {@link HandoffKeyParts}/{@link InviteKeyParts} (add-room-invite design D3). */
export interface RoomInviteKeyParts {
  kind: "room";
  invite_id_bytes: Uint8Array;
  invite_id: string;
  master_secret: Uint8Array;
}

function bytesToUuid(bytes: Uint8Array): string {
  const h = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function uuidToBytes(uuid: string, field = "handoff_id"): Uint8Array {
  if (!UUID_RE.test(uuid)) fail("HANDOFF_ID_INVALID", `${field} is not a canonical UUID`, "parsing handoff id", { field });
  const hex = uuid.replace(/-/g, "").toLowerCase();
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** A fresh RFC 4122 v4 UUID — the client-generated claim id every bearer-claim kind mints with (design D3: `auth_secret` derives off it, so it cannot be gateway-assigned). */
export function randomClaimId(): string {
  const b = randomBytes(16);
  b[6] = ((b[6] ?? 0) & 0x0f) | 0x40;
  b[8] = ((b[8] ?? 0) & 0x3f) | 0x80;
  return bytesToUuid(b);
}

/** Assemble a printed claim key from a fresh 32-byte master secret and the (client-generated or gateway-minted) claim id, for `entry`'s kind. */
function assembleClaimKey(entry: HandoffKeyPrefixEntry, claimId: string, masterSecret: Uint8Array): { key: string; id_bytes: Uint8Array; master_secret: Uint8Array } {
  if (masterSecret.length !== MASTER_SECRET_BYTES) fail(`${entry.errorPrefix}_KEY_INVALID`, "master_secret must be 32 bytes", `assembling ${entry.kind} key`);
  const idBytes = uuidToBytes(claimId, `${entry.kind}_id`);
  const body = concatBytes(idBytes, masterSecret);
  return { key: `${entry.prefix}${toBase64url(body)}`, id_bytes: idBytes, master_secret: masterSecret };
}

/**
 * Assemble the printed key from a fresh 32-byte master secret and the
 * gateway-minted `handoff_id`. The gateway never sees `master_secret` — the
 * caller derives `auth_hash` (via {@link deriveHandoffSecrets}) and sends
 * ONLY that.
 */
export function assembleHandoffKey(handoffId: string, masterSecret: Uint8Array = randomBytes(MASTER_SECRET_BYTES)): { key: string; handoff_id_bytes: Uint8Array; master_secret: Uint8Array } {
  const { key, id_bytes, master_secret } = assembleClaimKey(HANDOFF_ENTRY, handoffId, masterSecret);
  return { key, handoff_id_bytes: id_bytes, master_secret };
}

/** The invite-kind sibling of {@link assembleHandoffKey} (kygit-invite design D3). */
export function assembleInviteKey(inviteId: string, masterSecret: Uint8Array = randomBytes(MASTER_SECRET_BYTES)): { key: string; invite_id_bytes: Uint8Array; master_secret: Uint8Array } {
  const { key, id_bytes, master_secret } = assembleClaimKey(INVITE_ENTRY, inviteId, masterSecret);
  return { key, invite_id_bytes: id_bytes, master_secret };
}

/**
 * The room-kind sibling of {@link assembleHandoffKey}/{@link assembleInviteKey}
 * (add-room-invite design D3). `invite_id` is CLIENT-generated (unlike the
 * vault kinds, whose id the gateway mints) — the client sends it verbatim in
 * the mint request and the gateway uses it as the row id, refusing a
 * collision with `409 ROOM_INVITE_ID_CONFLICT`.
 */
export function assembleRoomInviteKey(inviteId: string, masterSecret: Uint8Array = randomBytes(MASTER_SECRET_BYTES)): { key: string; invite_id_bytes: Uint8Array; master_secret: Uint8Array } {
  const { key, id_bytes, master_secret } = assembleClaimKey(ROOM_ENTRY, inviteId, masterSecret);
  return { key, invite_id_bytes: id_bytes, master_secret };
}

/**
 * Parse ANY registered claim-family key by its prefix registry against the
 * `expectedKind` the calling verb accepts. A recognized prefix of a
 * DIFFERENT kind (a `kgi1_` invite key handed to `resume`, a `kri1_` room
 * key handed to `repos join`/`resume`, or a `kgi1_`/`kgh1_` vault key handed
 * to `rooms join`) refuses BY NAME pointing at its own door — never misread
 * as a malformed key of the expected kind, and never contacting the gateway
 * (design D9 rule 4 / kygit-invite design D3 / add-room-invite design D3).
 */
export function parseClaimKey(raw: string, expectedKind: ClaimKind): ClaimKeyParts {
  const expectedEntry = entryForKind(expectedKind);
  const trimmed = raw.trim();
  const entry = HANDOFF_KEY_PREFIXES.find((e) => trimmed.startsWith(e.prefix));
  if (!entry) {
    fail(`${expectedEntry.errorPrefix}_KEY_INVALID`, `not a recognized run402 claim key (expected a key starting ${expectedEntry.prefix})`, "parsing claim key");
  }
  if (entry.kind !== expectedKind) {
    fail(
      `${expectedEntry.errorPrefix}_KEY_WRONG_KIND`,
      `this key is a ${entry.kind} key — use \`${entry.doorLabel}\` instead of \`${expectedEntry.doorLabel}\``,
      "parsing claim key",
      { kind: entry.kind, verb: entry.verb },
    );
  }
  const body = trimmed.slice(entry.prefix.length);
  let bytes: Uint8Array;
  try {
    bytes = fromBase64url(body, `${entry.kind} key body`);
  } catch {
    fail(`${entry.errorPrefix}_KEY_INVALID`, "the key body is not valid base64url", "parsing claim key");
  }
  if (bytes.length !== CLAIM_KEY_BODY_BYTES) {
    fail(`${entry.errorPrefix}_KEY_INVALID`, `the key decodes to ${bytes.length} bytes; expected ${CLAIM_KEY_BODY_BYTES}`, "parsing claim key");
  }
  const idBytes = bytes.subarray(0, CLAIM_ID_BYTES);
  const masterSecret = bytes.subarray(CLAIM_ID_BYTES);
  return { kind: entry.kind, id_bytes: idBytes, id: bytesToUuid(idBytes), master_secret: masterSecret };
}

/**
 * Parse ANY registered claim-family key by its prefix registry. A
 * recognized prefix of a DIFFERENT kind (an invite or room key handed to
 * `resume`) refuses BY NAME pointing at its own door — never misread as a
 * malformed handoff key (design D9 rule 4). Kind-bound alias of
 * {@link parseClaimKey}.
 */
export function parseHandoffKey(raw: string): HandoffKeyParts {
  const parsed = parseClaimKey(raw, "handoff");
  return { kind: "handoff", handoff_id_bytes: parsed.id_bytes, handoff_id: parsed.id, master_secret: parsed.master_secret };
}

/** The invite-kind sibling of {@link parseHandoffKey} (kygit-invite design D3). */
export function parseInviteKey(raw: string): InviteKeyParts {
  const parsed = parseClaimKey(raw, "invite");
  return { kind: "invite", invite_id_bytes: parsed.id_bytes, invite_id: parsed.id, master_secret: parsed.master_secret };
}

/** The room-kind sibling of {@link parseHandoffKey}/{@link parseInviteKey} (add-room-invite design D3). */
export function parseRoomInviteKey(raw: string): RoomInviteKeyParts {
  const parsed = parseClaimKey(raw, "room");
  return { kind: "room", invite_id_bytes: parsed.id_bytes, invite_id: parsed.id, master_secret: parsed.master_secret };
}

// ─── HKDF derivations — vault kinds (design D3; kind-parameterized by kygit-invite D3) ────

export interface HandoffSecrets {
  auth_secret: Uint8Array;
  wrap_key: Uint8Array;
  /** `SHA-256(auth-hash-label ‖ auth_secret)`, lowercase hex — the ONLY thing the gateway ever stores. */
  auth_hash_hex: string;
}

/** `HKDF-SHA256(ikm=master_secret, salt=id[16], info=…)` per D3, domain-separated by kind, for both `auth_secret` and `wrap_key`. Vault kinds only — `room` has no `wrap_key` and derives separately below. */
function deriveClaimSecrets(kind: "handoff" | "invite", idBytes: Uint8Array, masterSecret: Uint8Array): HandoffSecrets {
  const authInfo = `kygit/${kind}/auth/v1`;
  const wrapInfo = `kygit/${kind}/wrap/v1`;
  const authHashLabel = `kygit/${kind}/auth-hash/v1`;
  const authSecret = hkdf(sha256, masterSecret, idBytes, utf8ToBytes(authInfo), 32);
  const wrapKey = hkdf(sha256, masterSecret, idBytes, utf8ToBytes(wrapInfo), 32);
  const authHash = sha256(concatBytes(utf8ToBytes(authHashLabel), authSecret));
  // ONE SHA-256 over (label ‖ auth_secret), hex-encoded — exactly what the
  // gateway recomputes at claim (`computeAuthHash`). Through 4.68.1 this line
  // ran the digest through `sha256Hex` (which hashes its input again), so the
  // stored value was sha256(sha256(label ‖ secret)) and NO key minted by any
  // published client could ever verify. The cross-side vector in
  // gitvault-handoff.test.ts now recomputes the gateway's hash independently.
  return { auth_secret: authSecret, wrap_key: wrapKey, auth_hash_hex: bytesToHex(authHash) };
}

/** `HKDF-SHA256(ikm=master_secret, salt=handoff_id[16], info=kygit/handoff/…)` per D3, for both `auth_secret` and `wrap_key`. */
export function deriveHandoffSecrets(handoffIdBytes: Uint8Array, masterSecret: Uint8Array): HandoffSecrets {
  return deriveClaimSecrets("handoff", handoffIdBytes, masterSecret);
}

/** The invite-kind sibling of {@link deriveHandoffSecrets}, domain-separated under `kygit/invite/…` info strings (kygit-invite design D3) — an invite secret never verifies as a handoff hash, or the reverse. */
export function deriveInviteSecrets(inviteIdBytes: Uint8Array, masterSecret: Uint8Array): HandoffSecrets {
  return deriveClaimSecrets("invite", inviteIdBytes, masterSecret);
}

// ─── HKDF derivation — room kind (add-room-invite design D3) ────────────────
//
// A room invite derives EXACTLY ONE secret — no `wrap_key`, no envelope, no
// admission seed exist for this kind (there is nothing sealed: the gateway
// already reads every room message in plaintext, so there is no secret to
// hide from it). The info string and hash label are their OWN
// `run402/room-invite/…` namespace, never `kygit/room/…` — domain-separated
// from every vault kind so a room secret never verifies as a handoff/invite
// hash and neither of those ever verifies as a room hash, even for a row
// whose id every parser recovers.

const ROOM_INVITE_AUTH_INFO = "run402/room-invite/auth/v1";
const ROOM_INVITE_AUTH_HASH_LABEL = "run402/room-invite/auth-hash/v1";

/** `HKDF-SHA256(ikm=master_secret, salt=invite_id[16], info="run402/room-invite/auth/v1")` — the ONE secret a room invite derives (design D3). */
export function deriveRoomInviteAuthSecret(inviteIdBytes: Uint8Array, masterSecret: Uint8Array): Uint8Array {
  return hkdf(sha256, masterSecret, inviteIdBytes, utf8ToBytes(ROOM_INVITE_AUTH_INFO), 32);
}

/** `SHA-256("run402/room-invite/auth-hash/v1" ‖ auth_secret)`, lowercase hex — exactly what the gateway's `mintRoomInvite`/`claimRoomInvite` compute and store/compare (design D3). */
export function computeRoomInviteAuthHash(authSecret: Uint8Array): string {
  return bytesToHex(sha256(concatBytes(utf8ToBytes(ROOM_INVITE_AUTH_HASH_LABEL), authSecret)));
}
