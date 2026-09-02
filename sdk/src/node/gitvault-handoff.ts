/**
 * gitvault — the Handoff Key and the Invite Key, one kind-parameterized
 * module (kygit-handoff design D3/D6/D10; kygit-invite design D3).
 *
 * Both keys are bearer bridges, never a K_repo derivation of their own:
 * `kgh1_<base64url(handoff_id[16] || master_secret[32])>` /
 * `kgi1_<base64url(invite_id[16] || master_secret[32])>` (69 chars each).
 * Two HKDF-SHA-256 derivations off `master_secret` (salt = the 16 raw id
 * bytes) produce `auth_secret` (what the gateway hashes and compares) and
 * `wrap_key` (what seals/opens the small envelope carrying the vault's
 * epoch key `k_e` directly — the gateway never sees either). The HKDF info
 * strings and the auth-hash label are DOMAIN-SEPARATED by kind
 * (`kygit/<kind>/auth/v1`, `kygit/<kind>/wrap/v1`,
 * `kygit/<kind>/auth-hash/v1`) so a handoff-derived secret can never verify
 * as an invite secret nor the reverse, even for a row whose id both parsers
 * would recover.
 *
 * The prefix is a REGISTRY (design D9 rule 4 / kygit-invite D3): `kgh1_` is
 * the first row, `kgi1_` the second. `parseClaimKey` refuses any other
 * recognized-shape-but-wrong-kind prefix BY NAME, pointing at its own verb,
 * rather than misreading it as a malformed key of the kind it expected.
 * `parseHandoffKey`/`parseInviteKey` are thin kind-bound aliases over the
 * one parser — every existing handoff export and test stays byte-identical.
 *
 * Reuses ONLY existing primitives — `jcs`/HKDF/HMAC/SHA-256 from
 * `@noble/hashes`, the SAME `_gitvaultAeadBackend()` XChaCha20-Poly1305
 * seam `sealFrame`/`openFrame` use — never a second crypto path. The wire
 * envelope here is a DIFFERENT, smaller frame than `r402s/v0`'s seven-member
 * object frame (design D3: "the sealed envelope lives in the gateway ROW,
 * never in the vault object store — the frozen r402s/v0 protocol is
 * untouched"), so it gets its own tiny header/AAD rather than reusing
 * `frameAad`'s object-store-shaped seven fields. The invite envelope is a
 * DIFFERENT, deliberately simpler format again than the `KGH1` handoff-
 * bridge frame is from `r402s/v0` — same idea, one level down: `KGI1` is its
 * own frame magic, never reused across kinds.
 */
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { concatBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { LocalError } from "../errors.js";
import { _gitvaultAeadBackend, fromBase64url, randomBytes, sha256Hex, toBase64url } from "../namespaces/gitvault.crypto.js";

function fail(code: string, message: string, context: string, details?: unknown): never {
  throw new LocalError(message, context, { code, details });
}

// ─── Key prefix / claim-kind registry (design D9 rule 4; kygit-invite D3) ────

export type ClaimKind = "handoff" | "invite";

export interface HandoffKeyPrefixEntry {
  prefix: string;
  kind: ClaimKind;
  verb: string;
  /** Error-code prefix for this kind (`HANDOFF` | `INVITE`) — every client-side code this module throws is `${errorPrefix}_…`. */
  errorPrefix: string;
  /** This kind's sealed-envelope `envelope_kind` tag. */
  envelopeKind: string;
  /** This kind's note schema tag. */
  noteSchema: string;
  /** This kind's envelope frame magic (4 ASCII bytes). */
  frameMagic: string;
}

/**
 * `kgh1_` is the first row (handoff); `kgi1_` is the second (invite,
 * kygit-invite design D3). A future third kind is a SIBLING row here, never
 * a branch on either existing one's parser.
 */
export const HANDOFF_KEY_PREFIXES: readonly HandoffKeyPrefixEntry[] = [
  { prefix: "kgh1_", kind: "handoff", verb: "resume", errorPrefix: "HANDOFF", envelopeKind: "kygit-handoff-envelope-v1", noteSchema: "kygit.handoff-note.v1", frameMagic: "KGH1" },
  { prefix: "kgi1_", kind: "invite", verb: "join", errorPrefix: "INVITE", envelopeKind: "kygit-invite-envelope-v1", noteSchema: "kygit.invite-note.v1", frameMagic: "KGI1" },
];

const HANDOFF_ENTRY: HandoffKeyPrefixEntry = HANDOFF_KEY_PREFIXES[0]!;
const INVITE_ENTRY: HandoffKeyPrefixEntry = HANDOFF_KEY_PREFIXES[1]!;

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

/** Assemble a printed claim key from a fresh 32-byte master secret and the gateway-minted claim id, for `entry`'s kind. */
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
 * Parse ANY `kg**_` claim-family key by its prefix registry against the
 * `expectedKind` the calling verb accepts. A recognized prefix of a
 * DIFFERENT kind (a `kgi1_` invite key handed to `resume`, or a `kgh1_`
 * handoff key handed to `join`) refuses BY NAME pointing at its own verb —
 * never misread as a malformed key of the expected kind, and never
 * contacting the gateway (design D9 rule 4 / kygit-invite design D3).
 */
export function parseClaimKey(raw: string, expectedKind: ClaimKind): ClaimKeyParts {
  const expectedEntry = expectedKind === "handoff" ? HANDOFF_ENTRY : INVITE_ENTRY;
  const trimmed = raw.trim();
  const entry = HANDOFF_KEY_PREFIXES.find((e) => trimmed.startsWith(e.prefix));
  if (!entry) {
    fail(`${expectedEntry.errorPrefix}_KEY_INVALID`, `not a recognized kygit key (expected a key starting ${expectedEntry.prefix})`, "parsing claim key");
  }
  if (entry.kind !== expectedKind) {
    fail(
      `${expectedEntry.errorPrefix}_KEY_WRONG_KIND`,
      `this key is a ${entry.kind} key — use \`kygit ${entry.verb}\` instead of ${expectedEntry.verb}`,
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
 * Parse ANY `kg**_` handoff-family key by its prefix registry. A recognized
 * prefix of a DIFFERENT kind (an invite key handed to `resume`) refuses BY
 * NAME pointing at its own verb — never misread as a malformed handoff key
 * (design D9 rule 4). Kind-bound alias of {@link parseClaimKey}.
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

// ─── HKDF derivations (design D3; kind-parameterized by kygit-invite D3) ────

export interface HandoffSecrets {
  auth_secret: Uint8Array;
  wrap_key: Uint8Array;
  /** `SHA-256(auth-hash-label ‖ auth_secret)`, lowercase hex — the ONLY thing the gateway ever stores. */
  auth_hash_hex: string;
}

/** `HKDF-SHA256(ikm=master_secret, salt=id[16], info=…)` per D3, domain-separated by kind, for both `auth_secret` and `wrap_key`. */
function deriveClaimSecrets(kind: ClaimKind, idBytes: Uint8Array, masterSecret: Uint8Array): HandoffSecrets {
  const authInfo = `kygit/${kind}/auth/v1`;
  const wrapInfo = `kygit/${kind}/wrap/v1`;
  const authHashLabel = `kygit/${kind}/auth-hash/v1`;
  const authSecret = hkdf(sha256, masterSecret, idBytes, utf8ToBytes(authInfo), 32);
  const wrapKey = hkdf(sha256, masterSecret, idBytes, utf8ToBytes(wrapInfo), 32);
  const authHash = sha256(concatBytes(utf8ToBytes(authHashLabel), authSecret));
  return { auth_secret: authSecret, wrap_key: wrapKey, auth_hash_hex: sha256Hex(authHash) };
}

/** `HKDF-SHA256(ikm=master_secret, salt=handoff_id[16], info=kygit/handoff/…)` per D3, for both `auth_secret` and `wrap_key`. */
export function deriveHandoffSecrets(handoffIdBytes: Uint8Array, masterSecret: Uint8Array): HandoffSecrets {
  return deriveClaimSecrets("handoff", handoffIdBytes, masterSecret);
}

/** The invite-kind sibling of {@link deriveHandoffSecrets}, domain-separated under `kygit/invite/…` info strings (kygit-invite design D3) — an invite secret never verifies as a handoff hash, or the reverse. */
export function deriveInviteSecrets(inviteIdBytes: Uint8Array, masterSecret: Uint8Array): HandoffSecrets {
  return deriveClaimSecrets("invite", inviteIdBytes, masterSecret);
}

// ─── The sealed envelope (design D3; kind-parameterized by kygit-invite D3) ─

/** The literal payload the mint side seals and the claim side opens, for the handoff kind. */
export interface HandoffEnvelopePayload {
  v: 1;
  kind: "handoff";
  repo_id: string;
  /** The pinned epoch (16-hex), matching the vault's `epoch` at capture time. */
  epoch: string;
  /** `K_e` for `epoch`, lowercase hex — the vault's own symmetric key, delivered directly. */
  k_e_hex: string;
  checkpoint: { generation: string; commit_oid: string };
  note_schema: "kygit.handoff-note.v1";
}

/** The invite-kind sibling of {@link HandoffEnvelopePayload} — otherwise identical shape (kygit-invite design D3: "the payload shape is otherwise identical to the handoff envelope — the room does NOT ride in the envelope"). */
export interface InviteEnvelopePayload {
  v: 1;
  kind: "invite";
  repo_id: string;
  epoch: string;
  k_e_hex: string;
  checkpoint: { generation: string; commit_oid: string };
  note_schema: "kygit.invite-note.v1";
}

/** Frame tag for the handoff envelope format — DISTINCT from `r402s/v0`'s `"R402S0"` object frame (design D3: never stored as a vault object). */
export const HANDOFF_ENVELOPE_KIND = "kygit-handoff-envelope-v1" as const;
/** Frame tag for the invite envelope format (kygit-invite design D3) — distinct again from BOTH `r402s/v0` and the `KGH1` handoff bridge frame. */
export const INVITE_ENVELOPE_KIND = "kygit-invite-envelope-v1" as const;

const FRAME_MAGIC_BYTES = 4;
const FRAME_VERSION_BYTE = 0x01;
const CLAIM_NONCE_BYTES = 24;
const CLAIM_FRAME_HEADER_BYTES = FRAME_MAGIC_BYTES + 1 + CLAIM_NONCE_BYTES;

function claimAeadSeal(key32: Uint8Array, nonce24: Uint8Array, aad: Uint8Array, plaintext: Uint8Array): Uint8Array {
  const backend = _gitvaultAeadBackend();
  if (backend) return backend.seal(key32, nonce24, aad, plaintext);
  return xchacha20poly1305(key32, nonce24, aad).encrypt(plaintext);
}

function claimAeadOpen(key32: Uint8Array, nonce24: Uint8Array, aad: Uint8Array, ctAndTag: Uint8Array): Uint8Array | null {
  try {
    const backend = _gitvaultAeadBackend();
    if (backend) return backend.open(key32, nonce24, aad, ctAndTag);
    return xchacha20poly1305(key32, nonce24, aad).decrypt(ctAndTag);
  } catch {
    return null;
  }
}

/** AAD = `id[16] ‖ envelopeKind` (design D3) — `envelopeKind` is this envelope format's own tag, UTF-8. */
function claimEnvelopeAad(idBytes: Uint8Array, envelopeKind: string): Uint8Array {
  return concatBytes(idBytes, utf8ToBytes(envelopeKind));
}

/** Seal `payload` under `wrap_key` for `entry`'s kind. Returns the base64url wire form + its declared kind tag. */
function sealClaimEnvelope(entry: HandoffKeyPrefixEntry, idBytes: Uint8Array, wrapKey: Uint8Array, payload: unknown, nonce?: Uint8Array): { sealed_envelope: string; envelope_kind: string } {
  // Plain JSON, NOT the r402s/v0 no-JSON-numbers JCS profile: this envelope
  // is never a vault object and only this SDK ever encodes/decodes it, so
  // it needs deterministic round-tripping, not cross-implementation
  // byte-canonical determinism (design D3's "the frozen protocol is
  // untouched" — reusing the object-frame profile here would be exactly
  // the kind of accidental protocol coupling that note warns against).
  const plaintext = utf8ToBytes(JSON.stringify(payload));
  const n = nonce ?? randomBytes(CLAIM_NONCE_BYTES);
  if (n.length !== CLAIM_NONCE_BYTES) fail(`${entry.errorPrefix}_ENVELOPE_INVALID`, "nonce must be 24 bytes", `sealing ${entry.kind} envelope`);
  const aad = claimEnvelopeAad(idBytes, entry.envelopeKind);
  const ct = claimAeadSeal(wrapKey, n, aad, plaintext);
  const frame = concatBytes(utf8ToBytes(entry.frameMagic), new Uint8Array([FRAME_VERSION_BYTE]), n, ct);
  return { sealed_envelope: toBase64url(frame), envelope_kind: entry.envelopeKind };
}

/** Open a sealed envelope under `wrap_key` for `entry`'s kind. Throws `${errorPrefix}_ENVELOPE_INVALID` on any header mismatch and `${errorPrefix}_AEAD_AUTH_FAILURE` on a bad key/AAD/ciphertext. Returns the decoded JSON, UNVALIDATED against either payload shape — callers check kind/schema themselves. */
function openClaimEnvelope(entry: HandoffKeyPrefixEntry, idBytes: Uint8Array, wrapKey: Uint8Array, sealedEnvelopeB64u: string, envelopeKind: string): unknown {
  let frame: Uint8Array;
  try {
    frame = fromBase64url(sealedEnvelopeB64u, "sealed_envelope");
  } catch {
    fail(`${entry.errorPrefix}_ENVELOPE_INVALID`, "sealed_envelope is not valid base64url", `opening ${entry.kind} envelope`);
  }
  if (frame.length < CLAIM_FRAME_HEADER_BYTES + 16) {
    fail(`${entry.errorPrefix}_ENVELOPE_INVALID`, "sealed_envelope is shorter than header + AEAD tag", `opening ${entry.kind} envelope`);
  }
  const magic = new TextDecoder().decode(frame.subarray(0, FRAME_MAGIC_BYTES));
  if (magic !== entry.frameMagic || frame[FRAME_MAGIC_BYTES] !== FRAME_VERSION_BYTE) {
    fail(`${entry.errorPrefix}_ENVELOPE_INVALID`, "sealed_envelope header magic/version mismatch", `opening ${entry.kind} envelope`);
  }
  const nonce = frame.subarray(FRAME_MAGIC_BYTES + 1, CLAIM_FRAME_HEADER_BYTES);
  const ct = frame.subarray(CLAIM_FRAME_HEADER_BYTES);
  const aad = claimEnvelopeAad(idBytes, envelopeKind);
  const opened = claimAeadOpen(wrapKey, nonce, aad, ct);
  if (opened === null) fail(`${entry.errorPrefix}_AEAD_AUTH_FAILURE`, "the sealed envelope failed AEAD authentication under this key", `opening ${entry.kind} envelope`);
  try {
    return JSON.parse(new TextDecoder().decode(opened));
  } catch {
    fail(`${entry.errorPrefix}_ENVELOPE_INVALID`, "opened envelope is not valid JSON", `opening ${entry.kind} envelope`);
  }
}

/** Seal the handoff payload under `wrap_key`. Returns the base64url wire form + its declared kind tag. */
export function sealHandoffEnvelope(handoffIdBytes: Uint8Array, wrapKey: Uint8Array, payload: HandoffEnvelopePayload, nonce?: Uint8Array): { sealed_envelope: string; envelope_kind: string } {
  return sealClaimEnvelope(HANDOFF_ENTRY, handoffIdBytes, wrapKey, payload, nonce);
}

/** Open a sealed handoff envelope under `wrap_key`. Throws `HANDOFF_ENVELOPE_INVALID` on any header mismatch and `HANDOFF_AEAD_AUTH_FAILURE` on a bad key/AAD/ciphertext. */
export function openHandoffEnvelope(handoffIdBytes: Uint8Array, wrapKey: Uint8Array, sealedEnvelopeB64u: string, envelopeKind: string = HANDOFF_ENVELOPE_KIND): HandoffEnvelopePayload {
  const p = openClaimEnvelope(HANDOFF_ENTRY, handoffIdBytes, wrapKey, sealedEnvelopeB64u, envelopeKind) as Partial<HandoffEnvelopePayload>;
  if (p.v !== 1 || p.kind !== "handoff" || typeof p.repo_id !== "string" || typeof p.epoch !== "string" || typeof p.k_e_hex !== "string" || !p.checkpoint || p.note_schema !== "kygit.handoff-note.v1") {
    fail("HANDOFF_ENVELOPE_INVALID", "opened envelope does not match the kygit.handoff-note.v1 payload shape", "opening handoff envelope");
  }
  return p as HandoffEnvelopePayload;
}

/** The invite-kind sibling of {@link sealHandoffEnvelope} (kygit-invite design D3). */
export function sealInviteEnvelope(inviteIdBytes: Uint8Array, wrapKey: Uint8Array, payload: InviteEnvelopePayload, nonce?: Uint8Array): { sealed_envelope: string; envelope_kind: string } {
  return sealClaimEnvelope(INVITE_ENTRY, inviteIdBytes, wrapKey, payload, nonce);
}

/** The invite-kind sibling of {@link openHandoffEnvelope} — throws `INVITE_ENVELOPE_INVALID` / `INVITE_AEAD_AUTH_FAILURE` (kygit-invite design D3). */
export function openInviteEnvelope(inviteIdBytes: Uint8Array, wrapKey: Uint8Array, sealedEnvelopeB64u: string, envelopeKind: string = INVITE_ENVELOPE_KIND): InviteEnvelopePayload {
  const p = openClaimEnvelope(INVITE_ENTRY, inviteIdBytes, wrapKey, sealedEnvelopeB64u, envelopeKind) as Partial<InviteEnvelopePayload>;
  if (p.v !== 1 || p.kind !== "invite" || typeof p.repo_id !== "string" || typeof p.epoch !== "string" || typeof p.k_e_hex !== "string" || !p.checkpoint || p.note_schema !== "kygit.invite-note.v1") {
    fail("INVITE_ENVELOPE_INVALID", "opened envelope does not match the kygit.invite-note.v1 payload shape", "opening invite envelope");
  }
  return p as InviteEnvelopePayload;
}

// ─── The Handoff / Invite Note (design D6; kygit-invite design D3) ──────────

export interface KygitHandoffNoteCapture {
  base_head: string;
  branch: string | null;
  modified_captured: number;
  untracked_captured: number;
  sensitive_excluded: string[];
  ignored_not_transferred_count: number;
}

/** The fields shared by every claim-kind note — free-text fields are Markdown. */
interface KygitClaimNoteBase {
  created_at: string;
  from: { agent: string; harness?: string; model?: string };
  summary: string;
  completed?: string[];
  in_progress?: string[];
  failing?: string[];
  tried?: string[];
  next_steps?: string[];
  commands?: { test?: string; build?: string; run?: string };
  decisions?: string[];
  open_questions?: string[];
  capture: KygitHandoffNoteCapture;
}

/** `kygit.handoff-note.v1` — the handoff commit's message, verbatim JSON. */
export interface KygitHandoffNote extends KygitClaimNoteBase {
  schema: "kygit.handoff-note.v1";
}

/** `kygit.invite-note.v1` — the invite commit's message, verbatim JSON. Same fields as {@link KygitHandoffNote} (kygit-invite design D3). */
export interface KygitInviteNote extends KygitClaimNoteBase {
  schema: "kygit.invite-note.v1";
}

export function isKygitHandoffNote(value: unknown): value is KygitHandoffNote {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return v.schema === "kygit.handoff-note.v1" && typeof v.summary === "string" && typeof v.created_at === "string" && !!v.from && !!v.capture;
}

export function isKygitInviteNote(value: unknown): value is KygitInviteNote {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return v.schema === "kygit.invite-note.v1" && typeof v.summary === "string" && typeof v.created_at === "string" && !!v.from && !!v.capture;
}

// ─── Client-side secret scan (design D10 — no override flag) ────────────────

const HANDOFF_NOTE_SECRET_PREFIXES: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9]/,
  /\bghp_[A-Za-z0-9]/,
  /\bgho_[A-Za-z0-9]/,
  /\bxox[abp]-[A-Za-z0-9]/,
  /\bAKIA[A-Z0-9]{4,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /-----BEGIN [A-Z ]*CERTIFICATE-----/,
  /\bkgh1_[A-Za-z0-9_-]/,
  // kygit-invite design D3: the invite key joins the scan's known-prefix
  // list so a pasted kgi1_ reads as a bare secret in EITHER note kind, not
  // just its own.
  /\bkgi1_[A-Za-z0-9_-]/,
];

/** Shannon entropy in bits/char over `s`. */
function shannonEntropy(s: string): number {
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / s.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

/** A run of ≥32 token-ish chars (letters/digits/`+/=_-`) with high per-char entropy reads as a bare secret, not prose. */
function hasHighEntropyToken(text: string): string | null {
  const tokenRe = /[A-Za-z0-9+/_=-]{32,}/g;
  let m: RegExpExecArray | null;
  while ((m = tokenRe.exec(text))) {
    const token = m[0];
    if (shannonEntropy(token) >= 3.5) return token;
  }
  return null;
}

export interface HandoffNoteSecretFinding {
  field: string;
  reason: string;
}

/** Every string leaf in a claim note, `path` = dotted field name for the refusal. */
function* noteStringLeaves(note: KygitClaimNoteBase): Generator<{ path: string; text: string }> {
  yield { path: "summary", text: note.summary };
  for (const [group, arr] of [
    ["completed", note.completed],
    ["in_progress", note.in_progress],
    ["failing", note.failing],
    ["tried", note.tried],
    ["next_steps", note.next_steps],
    ["decisions", note.decisions],
    ["open_questions", note.open_questions],
  ] as const) {
    for (const [i, text] of (arr ?? []).entries()) yield { path: `${group}[${i}]`, text };
  }
  if (note.commands) {
    for (const key of ["test", "build", "run"] as const) {
      const v = note.commands[key];
      if (v) yield { path: `commands.${key}`, text: v };
    }
  }
}

/**
 * Refuse a note that carries a bare secret — no override flag exists
 * (design D10): a note is read by another agent, and secrets have the
 * secrets API. `null` when the note is clean. Shared implementation for
 * every claim-note kind.
 */
function scanNoteForSecrets(note: KygitClaimNoteBase): HandoffNoteSecretFinding | null {
  for (const { path, text } of noteStringLeaves(note)) {
    for (const re of HANDOFF_NOTE_SECRET_PREFIXES) {
      if (re.test(text)) return { field: path, reason: `matches a known secret prefix (${re.source})` };
    }
    const token = hasHighEntropyToken(text);
    if (token) return { field: path, reason: `contains a high-entropy token (${token.length} chars) that reads as a bare secret` };
  }
  return null;
}

/**
 * Refuse a note that carries a bare secret — no override flag exists
 * (design D10): a note is read by another agent, and secrets have the
 * secrets API. `null` when the note is clean.
 */
export function scanHandoffNoteForSecrets(note: KygitHandoffNote): HandoffNoteSecretFinding | null {
  return scanNoteForSecrets(note);
}

/** The invite-kind sibling of {@link scanHandoffNoteForSecrets} (kygit-invite design D3). */
export function scanInviteNoteForSecrets(note: KygitInviteNote): HandoffNoteSecretFinding | null {
  return scanNoteForSecrets(note);
}

/** Throws `HANDOFF_NOTE_CONTAINS_SECRET` naming the field — call before the handoff commit is written. */
export function assertHandoffNoteHasNoSecret(note: KygitHandoffNote): void {
  const finding = scanHandoffNoteForSecrets(note);
  if (finding) {
    fail("HANDOFF_NOTE_CONTAINS_SECRET", `the handoff note's \`${finding.field}\` ${finding.reason} — edit the note; secrets belong in the secrets API, never in a note another agent will read`, "scanning handoff note", { field: finding.field });
  }
}

/** Throws `INVITE_NOTE_CONTAINS_SECRET` naming the field — call before the invite commit is written (kygit-invite design D3). */
export function assertInviteNoteHasNoSecret(note: KygitInviteNote): void {
  const finding = scanInviteNoteForSecrets(note);
  if (finding) {
    fail("INVITE_NOTE_CONTAINS_SECRET", `the invite note's \`${finding.field}\` ${finding.reason} — edit the note; secrets belong in the secrets API, never in a note another agent will read`, "scanning invite note", { field: finding.field });
  }
}
