/**
 * gitvault — the Handoff Key (kygit-handoff design D3/D6/D10).
 *
 * A Handoff Key is a bearer bridge, never a K_repo derivation of its own:
 * `kgh1_<base64url(handoff_id[16] || master_secret[32])>` (69 chars). Two
 * HKDF-SHA-256 derivations off `master_secret` (salt = the 16 raw
 * `handoff_id` bytes) produce `auth_secret` (what the gateway hashes and
 * compares) and `wrap_key` (what seals/opens the small envelope carrying
 * the vault's epoch key `k_e` directly — the gateway never sees either).
 *
 * The prefix is a REGISTRY (design D9 rule 4): `kgh1_` is the first row.
 * `parseHandoffKey` refuses any other recognized-shape-but-wrong-kind
 * prefix BY NAME, pointing at its own verb, rather than misreading it as a
 * malformed handoff key.
 *
 * Reuses ONLY existing primitives — `jcs`/HKDF/HMAC/SHA-256 from
 * `@noble/hashes`, the SAME `_gitvaultAeadBackend()` XChaCha20-Poly1305
 * seam `sealFrame`/`openFrame` use — never a second crypto path. The wire
 * envelope here is a DIFFERENT, smaller frame than `r402s/v0`'s seven-member
 * object frame (design D3: "the sealed envelope lives in the gateway ROW,
 * never in the vault object store — the frozen r402s/v0 protocol is
 * untouched"), so it gets its own tiny header/AAD rather than reusing
 * `frameAad`'s object-store-shaped seven fields.
 */
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { concatBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { LocalError } from "../errors.js";
import { _gitvaultAeadBackend, fromBase64url, randomBytes, toBase64url, bytesToHex } from "../namespaces/gitvault.crypto.js";

function fail(code: string, message: string, context: string, details?: unknown): never {
  throw new LocalError(message, context, { code, details });
}

// ─── Key prefix registry (design D9 rule 4) ──────────────────────────────────

export interface HandoffKeyPrefixEntry {
  prefix: string;
  kind: string;
  verb: string;
}

/** `kgh1_` is the first row. A future `kgi1_` (KyGit Invite) is a SIBLING row here, never a branch on this one's parser. */
export const HANDOFF_KEY_PREFIXES: readonly HandoffKeyPrefixEntry[] = [{ prefix: "kgh1_", kind: "handoff", verb: "resume" }];

const HANDOFF_ID_BYTES = 16;
const MASTER_SECRET_BYTES = 32;
const HANDOFF_KEY_BODY_BYTES = HANDOFF_ID_BYTES + MASTER_SECRET_BYTES;

export interface HandoffKeyParts {
  kind: "handoff";
  handoff_id_bytes: Uint8Array;
  /** Canonical lowercase-hyphenated UUID form of `handoff_id_bytes` — the wire `handoff_id`. */
  handoff_id: string;
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

/**
 * Assemble the printed key from a fresh 32-byte master secret and the
 * gateway-minted `handoff_id`. The gateway never sees `master_secret` — the
 * caller derives `auth_hash` (via {@link deriveHandoffSecrets}) and sends
 * ONLY that.
 */
export function assembleHandoffKey(handoffId: string, masterSecret: Uint8Array = randomBytes(MASTER_SECRET_BYTES)): { key: string; handoff_id_bytes: Uint8Array; master_secret: Uint8Array } {
  if (masterSecret.length !== MASTER_SECRET_BYTES) fail("HANDOFF_KEY_INVALID", "master_secret must be 32 bytes", "assembling handoff key");
  const idBytes = uuidToBytes(handoffId);
  const body = concatBytes(idBytes, masterSecret);
  return { key: `kgh1_${toBase64url(body)}`, handoff_id_bytes: idBytes, master_secret: masterSecret };
}

/**
 * Parse ANY `kg**_` handoff-family key by its prefix registry. A recognized
 * prefix of a DIFFERENT kind (a future `kgi1_` invite key handed to
 * `resume`) refuses BY NAME pointing at its own verb — never misread as a
 * malformed handoff key (design D9 rule 4).
 */
export function parseHandoffKey(raw: string): HandoffKeyParts {
  const trimmed = raw.trim();
  const entry = HANDOFF_KEY_PREFIXES.find((e) => trimmed.startsWith(e.prefix));
  if (!entry) {
    // A recognized SIBLING prefix (future kind) would be matched here once
    // it joins the registry; today only `kgh1_` is registered, so any
    // non-matching prefix is a plain invalid key.
    fail("HANDOFF_KEY_INVALID", "not a recognized kygit key (expected a key starting kgh1_)", "parsing handoff key");
  }
  if (entry.kind !== "handoff") {
    fail("HANDOFF_KEY_WRONG_KIND", `this key is a ${entry.kind} key — use \`kygit ${entry.verb}\` instead of resume`, "parsing handoff key", { kind: entry.kind, verb: entry.verb });
  }
  const body = trimmed.slice(entry.prefix.length);
  let bytes: Uint8Array;
  try {
    bytes = fromBase64url(body, "handoff key body");
  } catch {
    fail("HANDOFF_KEY_INVALID", "the key body is not valid base64url", "parsing handoff key");
  }
  if (bytes.length !== HANDOFF_KEY_BODY_BYTES) {
    fail("HANDOFF_KEY_INVALID", `the key decodes to ${bytes.length} bytes; expected ${HANDOFF_KEY_BODY_BYTES}`, "parsing handoff key");
  }
  const idBytes = bytes.subarray(0, HANDOFF_ID_BYTES);
  const masterSecret = bytes.subarray(HANDOFF_ID_BYTES);
  return { kind: "handoff", handoff_id_bytes: idBytes, handoff_id: bytesToUuid(idBytes), master_secret: masterSecret };
}

// ─── HKDF derivations (design D3) ────────────────────────────────────────────

const HANDOFF_AUTH_INFO = "kygit/handoff/auth/v1";
const HANDOFF_WRAP_INFO = "kygit/handoff/wrap/v1";
const HANDOFF_AUTH_HASH_LABEL = "kygit/handoff/auth-hash/v1";

export interface HandoffSecrets {
  auth_secret: Uint8Array;
  wrap_key: Uint8Array;
  /** `SHA-256(auth-hash-label ‖ auth_secret)`, lowercase hex — the ONLY thing the gateway ever stores. */
  auth_hash_hex: string;
}

/** `HKDF-SHA256(ikm=master_secret, salt=handoff_id[16], info=…)` per D3, for both `auth_secret` and `wrap_key`. */
export function deriveHandoffSecrets(handoffIdBytes: Uint8Array, masterSecret: Uint8Array): HandoffSecrets {
  const authSecret = hkdf(sha256, masterSecret, handoffIdBytes, utf8ToBytes(HANDOFF_AUTH_INFO), 32);
  const wrapKey = hkdf(sha256, masterSecret, handoffIdBytes, utf8ToBytes(HANDOFF_WRAP_INFO), 32);
  // ONE SHA-256 over (label ‖ auth_secret), hex-encoded — exactly what the
  // gateway recomputes at claim (`computeAuthHash`). Through 4.68.1 this line
  // ran the digest through `sha256Hex` (which hashes its input again), so the
  // stored value was sha256(sha256(label ‖ secret)) and NO key minted by any
  // published client could ever verify — the mint/claim agreement test above
  // compared two calls of this same function and could not see it. The
  // cross-side vector in gitvault-handoff.test.ts now recomputes the
  // gateway's hash independently.
  const authHash = sha256(concatBytes(utf8ToBytes(HANDOFF_AUTH_HASH_LABEL), authSecret));
  return { auth_secret: authSecret, wrap_key: wrapKey, auth_hash_hex: bytesToHex(authHash) };
}

// ─── The sealed envelope (design D3) ─────────────────────────────────────────

/** The literal payload the mint side seals and the claim side opens. */
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

/** Frame tag for this envelope format — DISTINCT from `r402s/v0`'s `"R402S0"` object frame (design D3: never stored as a vault object). */
export const HANDOFF_ENVELOPE_KIND = "kygit-handoff-envelope-v1" as const;
const HANDOFF_FRAME_MAGIC = "KGH1";
const HANDOFF_FRAME_MAGIC_BYTES = 4;
const HANDOFF_FRAME_VERSION_BYTE = 0x01;
const HANDOFF_NONCE_BYTES = 24;
const HANDOFF_FRAME_HEADER_BYTES = HANDOFF_FRAME_MAGIC_BYTES + 1 + HANDOFF_NONCE_BYTES;

function handoffAeadSeal(key32: Uint8Array, nonce24: Uint8Array, aad: Uint8Array, plaintext: Uint8Array): Uint8Array {
  const backend = _gitvaultAeadBackend();
  if (backend) return backend.seal(key32, nonce24, aad, plaintext);
  return xchacha20poly1305(key32, nonce24, aad).encrypt(plaintext);
}

function handoffAeadOpen(key32: Uint8Array, nonce24: Uint8Array, aad: Uint8Array, ctAndTag: Uint8Array): Uint8Array | null {
  try {
    const backend = _gitvaultAeadBackend();
    if (backend) return backend.open(key32, nonce24, aad, ctAndTag);
    return xchacha20poly1305(key32, nonce24, aad).decrypt(ctAndTag);
  } catch {
    return null;
  }
}

/** AAD = `handoff_id[16] ‖ kind` (design D3) — `kind` is this envelope format's own tag, UTF-8. */
function handoffEnvelopeAad(handoffIdBytes: Uint8Array, envelopeKind: string): Uint8Array {
  return concatBytes(handoffIdBytes, utf8ToBytes(envelopeKind));
}

/** Seal the handoff payload under `wrap_key`. Returns the base64url wire form + its declared kind tag. */
export function sealHandoffEnvelope(handoffIdBytes: Uint8Array, wrapKey: Uint8Array, payload: HandoffEnvelopePayload, nonce?: Uint8Array): { sealed_envelope: string; envelope_kind: string } {
  // Plain JSON, NOT the r402s/v0 no-JSON-numbers JCS profile: this envelope
  // is never a vault object and only this SDK ever encodes/decodes it, so
  // it needs deterministic round-tripping, not cross-implementation
  // byte-canonical determinism (design D3's "the frozen protocol is
  // untouched" — reusing the object-frame profile here would be exactly
  // the kind of accidental protocol coupling that note warns against).
  const plaintext = utf8ToBytes(JSON.stringify(payload));
  const n = nonce ?? randomBytes(HANDOFF_NONCE_BYTES);
  if (n.length !== HANDOFF_NONCE_BYTES) fail("HANDOFF_ENVELOPE_INVALID", "nonce must be 24 bytes", "sealing handoff envelope");
  const aad = handoffEnvelopeAad(handoffIdBytes, HANDOFF_ENVELOPE_KIND);
  const ct = handoffAeadSeal(wrapKey, n, aad, plaintext);
  const frame = concatBytes(utf8ToBytes(HANDOFF_FRAME_MAGIC), new Uint8Array([HANDOFF_FRAME_VERSION_BYTE]), n, ct);
  return { sealed_envelope: toBase64url(frame), envelope_kind: HANDOFF_ENVELOPE_KIND };
}

/** Open a sealed handoff envelope under `wrap_key`. Throws `HANDOFF_ENVELOPE_INVALID` on any header mismatch and `HANDOFF_AEAD_AUTH_FAILURE` on a bad key/AAD/ciphertext. */
export function openHandoffEnvelope(handoffIdBytes: Uint8Array, wrapKey: Uint8Array, sealedEnvelopeB64u: string, envelopeKind: string = HANDOFF_ENVELOPE_KIND): HandoffEnvelopePayload {
  let frame: Uint8Array;
  try {
    frame = fromBase64url(sealedEnvelopeB64u, "sealed_envelope");
  } catch {
    fail("HANDOFF_ENVELOPE_INVALID", "sealed_envelope is not valid base64url", "opening handoff envelope");
  }
  if (frame.length < HANDOFF_FRAME_HEADER_BYTES + 16) {
    fail("HANDOFF_ENVELOPE_INVALID", "sealed_envelope is shorter than header + AEAD tag", "opening handoff envelope");
  }
  const magic = new TextDecoder().decode(frame.subarray(0, HANDOFF_FRAME_MAGIC_BYTES));
  if (magic !== HANDOFF_FRAME_MAGIC || frame[HANDOFF_FRAME_MAGIC_BYTES] !== HANDOFF_FRAME_VERSION_BYTE) {
    fail("HANDOFF_ENVELOPE_INVALID", "sealed_envelope header magic/version mismatch", "opening handoff envelope");
  }
  const nonce = frame.subarray(HANDOFF_FRAME_MAGIC_BYTES + 1, HANDOFF_FRAME_HEADER_BYTES);
  const ct = frame.subarray(HANDOFF_FRAME_HEADER_BYTES);
  const aad = handoffEnvelopeAad(handoffIdBytes, envelopeKind);
  const opened = handoffAeadOpen(wrapKey, nonce, aad, ct);
  if (opened === null) fail("HANDOFF_AEAD_AUTH_FAILURE", "the sealed envelope failed AEAD authentication under this key", "opening handoff envelope");
  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(opened));
  } catch {
    fail("HANDOFF_ENVELOPE_INVALID", "opened envelope is not valid JSON", "opening handoff envelope");
  }
  const p = payload as Partial<HandoffEnvelopePayload>;
  if (p.v !== 1 || p.kind !== "handoff" || typeof p.repo_id !== "string" || typeof p.epoch !== "string" || typeof p.k_e_hex !== "string" || !p.checkpoint || p.note_schema !== "kygit.handoff-note.v1") {
    fail("HANDOFF_ENVELOPE_INVALID", "opened envelope does not match the kygit.handoff-note.v1 payload shape", "opening handoff envelope");
  }
  return p as HandoffEnvelopePayload;
}

// ─── The Handoff Note (design D6) ────────────────────────────────────────────

export interface KygitHandoffNoteCapture {
  base_head: string;
  branch: string | null;
  modified_captured: number;
  untracked_captured: number;
  sensitive_excluded: string[];
  ignored_not_transferred_count: number;
}

/** `kygit.handoff-note.v1` — the handoff commit's message, verbatim JSON. Free-text fields are Markdown. */
export interface KygitHandoffNote {
  schema: "kygit.handoff-note.v1";
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

export function isKygitHandoffNote(value: unknown): value is KygitHandoffNote {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return v.schema === "kygit.handoff-note.v1" && typeof v.summary === "string" && typeof v.created_at === "string" && !!v.from && !!v.capture;
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

/** Every string leaf in the note, `path` = dotted field name for the refusal. */
function* noteStringLeaves(note: KygitHandoffNote): Generator<{ path: string; text: string }> {
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
 * secrets API. `null` when the note is clean.
 */
export function scanHandoffNoteForSecrets(note: KygitHandoffNote): HandoffNoteSecretFinding | null {
  for (const { path, text } of noteStringLeaves(note)) {
    for (const re of HANDOFF_NOTE_SECRET_PREFIXES) {
      if (re.test(text)) return { field: path, reason: `matches a known secret prefix (${re.source})` };
    }
    const token = hasHighEntropyToken(text);
    if (token) return { field: path, reason: `contains a high-entropy token (${token.length} chars) that reads as a bare secret` };
  }
  return null;
}

/** Throws `HANDOFF_NOTE_CONTAINS_SECRET` naming the field — call before the handoff commit is written. */
export function assertHandoffNoteHasNoSecret(note: KygitHandoffNote): void {
  const finding = scanHandoffNoteForSecrets(note);
  if (finding) {
    fail("HANDOFF_NOTE_CONTAINS_SECRET", `the handoff note's \`${finding.field}\` ${finding.reason} — edit the note; secrets belong in the secrets API, never in a note another agent will read`, "scanning handoff note", { field: finding.field });
  }
}
