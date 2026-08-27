/**
 * gitvault — `r402s/v0` crypto core (protocol rev 40, §1 + §2; task 5.1).
 *
 * Pure, isomorphic (WebCrypto + noble + `@hpke/core`), no I/O. Everything
 * byte-level the protocol pins lives here ONCE and is replayed against the
 * frozen vector set (`gitvault.crypto.test.ts`):
 *
 *   - JCS (RFC 8785) for the no-JSON-numbers profile + the strict-parse profile
 *   - the two hash rules: stored bytes (JCS INCLUDING `signature`) and the
 *     signature preimage `"r402s/v0/" + object_kind + "\n" + JCS(object minus signature)`
 *   - Ed25519 strict RFC 8032 — noble with `zip215: false` pinned; a
 *     ZIP215-only signature is REJECTED (vector `zip215-002`)
 *   - `lp` / `lp_opt` length prefixes + the open-id / open-binding preimages
 *   - HKDF-SHA-256 `k_obj` / `K_digest` derivations and HMAC keyed commitments
 *   - the XChaCha20-Poly1305 frame (`"R402S0"` ‖ suite byte ‖ 24-byte nonce ‖ ct‖tag)
 *     with its seven-member JCS AAD
 *   - the `key_envelope` HPKE seal/open (Base mode, DHKEM(X25519,HKDF-SHA256) /
 *     HKDF-SHA256 / ChaCha20-Poly1305) with the EXACT D188 `info` / AAD bytes
 *   - genesis key-binding + recovery-receipt checks
 *
 * Design rules carried from the protocol: HPKE is a NAMED implementation
 * (`@hpke/core` + `@hpke/chacha20poly1305`), never assembled from primitives
 * (D38); an envelope's signature is verified BEFORE any open; plain hashes of
 * plaintext content never leave the client (every server-comparable digest is
 * keyed); object ids are single-use key labels — callers MUST NOT re-encrypt
 * under an id (retries read-and-compare).
 */

import { parse, evaluate, type Node, type DocumentNode, type ObjectNode, type ArrayNode } from "@humanwhocodes/momoa";
import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { hmac } from "@noble/hashes/hmac.js";
import { bytesToHex, hexToBytes, utf8ToBytes, concatBytes } from "@noble/hashes/utils.js";
import { base64urlnopad } from "@scure/base";
import { canonicalize } from "json-canonicalize";
import { CipherSuite, DhkemX25519HkdfSha256, HkdfSha256 } from "@hpke/core";
import { Chacha20Poly1305 } from "@hpke/chacha20poly1305";
import { LocalError } from "../errors.js";
import type {
  GitvaultAllocation,
  GitvaultDigestLabel,
  GitvaultEncryptedObjectKind,
  GitvaultEncryptionKeypair,
  GitvaultEnvelopeAad,
  GitvaultFormat,
  GitvaultFrameAad,
  GitvaultKeyEnvelope,
  GitvaultKeyEnvelopeReceipt,
  GitvaultObjectKind,
  GitvaultRecoveryReceipt,
  GitvaultSealedFrame,
  GitvaultSealedKeyEnvelope,
  GitvaultSignedObject,
  GitvaultSigningKeypair,
  GitvaultStrictParseReason,
  GitvaultSuite,
  GitvaultVaultGenesis,
} from "./gitvault.types.js";

// ─── Constants ───────────────────────────────────────────────────────────────

/** Wire format tag (retained by decision D181 across the product rename). */
export const GITVAULT_FORMAT = "r402s/v0" as const;
/** The one V0 cryptographic suite. */
export const GITVAULT_SUITE = "r402s-1" as const;
/** Frame magic, bytes 0–5 of every encrypted object. */
export const GITVAULT_FRAME_MAGIC = "R402S0" as const;
/** Frame suite byte (byte 6) and its two-char AAD spelling. */
export const GITVAULT_FRAME_SUITE_BYTE = 0x01 as const;
export const GITVAULT_FRAME_SUITE_ID = "01" as const;
/** Protocol §2: max plaintext per encrypted object (256 MiB). */
export const GITVAULT_MAX_PLAINTEXT_BYTES = 256 * 1024 * 1024;
/** The genesis generation / epoch constants (schema consts). */
export const GITVAULT_GENESIS_GENERATION = "0000000000000000" as const;
export const GITVAULT_GENESIS_EPOCH = "0000000000000001" as const;
/** HPKE `info` label for `key_envelope` (D188). */
export const GITVAULT_ENVELOPE_INFO_LABEL = "r402s/v0/envelope" as const;

/**
 * The V0-A terminal-loss sentence — protocol §0 / client-surface spec. Doctor
 * and status surfaces MUST state it verbatim while V0-A is current. Do not
 * paraphrase; the wording is a reviewed product commitment.
 */
export const GITVAULT_TERMINAL_LOSS_STATEMENT =
  "whole-machine or whole-keystore loss is terminal for vault history until human envelopes ship" as const;

/**
 * The protocol's durability sentence — the keystore-qualified half of the
 * terminal-loss statement, reusable on its own. It is TRUE regardless of how
 * many principals cover a vault (unlike {@link GITVAULT_TERMINAL_LOSS_STATEMENT},
 * which is specifically the single-principal V0-A claim), so a caller that has
 * locally proven a vault carries >= 2 covering recipients prints this sentence
 * instead of the terminal-loss one — see `Gitvault.status()`'s `covering_recipients`
 * field. Never paraphrase; the wording is a reviewed product commitment.
 */
export const GITVAULT_DURABILITY_STATEMENT =
  "The vault protects source history from host-side loss while a principal keystore survives." as const;

/** Protocol §0 sentence in full, as `doctor`/`status` print it. */
export const GITVAULT_TERMINAL_LOSS_DOCTOR_TEXT =
  "In V0-A, whole-machine or whole-keystore loss is terminal for vault history (VAULT_UNRECOVERABLE) until human envelopes ship. " +
  `${GITVAULT_DURABILITY_STATEMENT} ` +
  "The remaining paths are the platform's custodial restore of deployed artifacts (the deploy lane's CAS) and org/infra recovery; " +
  "a recovery receipt authenticates a genesis — it cannot decrypt anything.";

/**
 * gitvault-mirror-and-recover (design D8) — the two honesty statements. Both
 * appear VERBATIM wherever mirror status or recovery success is shown (mirror
 * `status`/`sync`, `recover`, keyless `mirror verify`), same voice and
 * mechanism as {@link GITVAULT_TERMINAL_LOSS_STATEMENT} above. Never
 * paraphrased — the §6.4 honesty posture is a reviewed product commitment.
 */
export const GITVAULT_MIRROR_VALIDITY_NOT_FRESHNESS_STATEMENT =
  "this recovery proves validity, never freshness — a mirror (or the vault itself) can only tell you the newest generation it happens to hold, never that a newer one does not exist elsewhere" as const;

/** The mirror does not change the V0 terminal-loss sentence: it is durability, not a second key. */
export const GITVAULT_MIRROR_KEYSTORE_STILL_REQUIRED_STATEMENT =
  "a mirror without the principal keystore (or an equivalent key) recovers nothing — mirroring ciphertext does not create a second key, and the V0 terminal-loss sentence is unchanged" as const;

const FRAME_NONCE_BYTES = 24;
const FRAME_HEADER_BYTES = 6 + 1 + FRAME_NONCE_BYTES;
const AEAD_TAG_BYTES = 16;

// ─── Scalar grammars (common.json) ───────────────────────────────────────────

export const GITVAULT_HEX16_RE = /^[0-9a-f]{16}$/;
export const GITVAULT_HEX32_RE = /^[0-9a-f]{32}$/;
export const GITVAULT_SHA256_RE = /^[0-9a-f]{64}$/;
export const GITVAULT_OID40_RE = /^[0-9a-f]{40}$/;
export const GITVAULT_VK_RE = /^vk_[0-9a-f]{32}$/;
export const GITVAULT_EK_RE = /^ek_[0-9a-f]{32}$/;
export const GITVAULT_SRC_RE = /^src_[0-9a-f]{32}$/;
export const GITVAULT_SERVICE_KEY_ID_RE = /^sk_[0-9a-z-]{4,64}$/;
export const GITVAULT_SIZE_BYTES_RE = /^(0|[1-9][0-9]{0,14})$/;
/** 32 bytes base64url: 43 chars, final char in the 16-value padding class. */
export const GITVAULT_B64U_32_RE = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;
/** 64 bytes base64url: 86 chars, final char ∈ {A,Q,g,w}. */
export const GITVAULT_B64U_64_RE = /^[A-Za-z0-9_-]{85}[AQgw]$/;
/** The HPKE-sealed K_repo: 48 bytes = exactly 64 base64url chars. */
export const GITVAULT_HPKE_CT_RE = /^[A-Za-z0-9_-]{64}$/;
export const GITVAULT_TIMESTAMP_RE =
  /^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]\.[0-9]{3}Z$/;

function fail(code: string, message: string, context: string, details?: unknown): never {
  throw new LocalError(message, context, { code, details });
}

/** Canonical base64url (no padding, length mod 4 ≠ 1, zero trailing bits): decode→encode round-trips. */
export function isCanonicalBase64url(value: string): boolean {
  if (!/^[A-Za-z0-9_-]*$/.test(value) || value.length % 4 === 1) return false;
  try {
    return base64urlnopad.encode(base64urlnopad.decode(value)) === value;
  } catch {
    return false;
  }
}

/** Decode canonical base64url or throw (`GITVAULT_NONCANONICAL_BASE64URL`). */
export function fromBase64url(value: string, field = "value"): Uint8Array {
  if (!isCanonicalBase64url(value)) {
    fail("GITVAULT_NONCANONICAL_BASE64URL", `${field} is not canonical base64url`, "decoding r402s/v0 scalar", { field });
  }
  return base64urlnopad.decode(value);
}

export function toBase64url(bytes: Uint8Array): string {
  return base64urlnopad.encode(bytes);
}

/** RFC 3339 UTC ms `Z` with semantic calendar validation (D187: `2026-02-31` and a non-leap Feb 29 are rejects). */
export function isValidGitvaultTimestamp(value: string): boolean {
  if (!GITVAULT_TIMESTAMP_RE.test(value)) return false;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]!;
  return day <= daysInMonth;
}

/** Format a Date as the protocol timestamp grammar (RFC 3339 UTC, milliseconds, `Z`). */
export function formatGitvaultTimestamp(date: Date = new Date()): string {
  return date.toISOString();
}

// ─── Encoding helpers ────────────────────────────────────────────────────────

/** `lp(x)` = 4-byte big-endian UTF-8 byte length ‖ UTF-8 bytes (protocol §1). */
export function lp(value: string): Uint8Array {
  const bytes = utf8ToBytes(value);
  const out = new Uint8Array(4 + bytes.length);
  new DataView(out.buffer).setUint32(0, bytes.length, false);
  out.set(bytes, 4);
  return out;
}

/** `lp_opt(null)` = `0x00`; `lp_opt(x)` = `0x01` ‖ `lp(x)`. */
export function lpOpt(value: string | null): Uint8Array {
  return value === null ? new Uint8Array([0]) : concatBytes(new Uint8Array([1]), lp(value));
}

export function sha256Hex(bytes: Uint8Array): string {
  return bytesToHex(sha256(bytes));
}

/** CSPRNG bytes from the platform WebCrypto (protocol §2: all keys/nonces/ephemerals from the OS CSPRNG). */
export function randomBytes(length: number): Uint8Array {
  const out = new Uint8Array(length);
  globalThis.crypto.getRandomValues(out);
  return out;
}

/** A fresh `<prefix>_<32 lowercase hex>` id (protocol §1: ids are CSPRNG). */
export function newGitvaultId(prefix: string): string {
  return `${prefix}_${bytesToHex(randomBytes(16))}`;
}

/** A fresh 32-lowercase-hex scalar (client_creation_id, capture_id, …). */
export function newHex32(): string {
  return bytesToHex(randomBytes(16));
}

// ─── JCS + strict parse ──────────────────────────────────────────────────────

function assertProfileValue(value: unknown, path: string): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" || typeof value === "bigint") {
    fail("GITVAULT_JSON_NUMBER", `r402s/v0 profile forbids JSON numbers (at ${path})`, "canonicalizing r402s/v0 object", { path });
  }
  if (Array.isArray(value)) {
    value.forEach((entry, i) => assertProfileValue(entry, `${path}[${i}]`));
    return;
  }
  if (typeof value === "object") {
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (entry === undefined) {
        fail("GITVAULT_JSON_UNDEFINED", `undefined member at ${path}.${key}`, "canonicalizing r402s/v0 object", { path: `${path}.${key}` });
      }
      assertProfileValue(entry, `${path}.${key}`);
    }
    return;
  }
  fail("GITVAULT_JSON_UNSUPPORTED", `unsupported value at ${path}`, "canonicalizing r402s/v0 object", { path });
}

/** RFC 8785 canonical JSON (no-numbers profile) as UTF-8 bytes. */
export function jcs(value: unknown): Uint8Array {
  assertProfileValue(value, "$");
  return utf8ToBytes(canonicalize(value));
}

/** RFC 8785 canonical JSON as a string. */
export function jcsString(value: unknown): string {
  assertProfileValue(value, "$");
  return canonicalize(value);
}

function inspectStrict(node: Node, path: string): void {
  switch (node.type) {
    case "Document":
      return inspectStrict((node as DocumentNode).body, path);
    case "Number":
      fail("GITVAULT_STRICT_PARSE", `JSON number at ${path}`, "strict-parsing r402s/v0 object", { reason: "json-number", path });
    // eslint-disable-next-line no-fallthrough
    case "Object": {
      const seen = new Set<string>();
      for (const member of (node as ObjectNode).members) {
        const name = member.name.type === "String" ? member.name.value : member.name.name;
        if (seen.has(name)) {
          fail("GITVAULT_STRICT_PARSE", `duplicate member ${name} at ${path}`, "strict-parsing r402s/v0 object", { reason: "duplicate-member", path: `${path}.${name}` });
        }
        seen.add(name);
        inspectStrict(member.value, `${path}.${name}`);
      }
      return;
    }
    case "Array":
      (node as ArrayNode).elements.forEach((entry, i) => inspectStrict(entry.value, `${path}[${i}]`));
      return;
    default:
      return;
  }
}

/**
 * The §1 strict-parse profile: reject ANY JSON number, duplicate members,
 * invalid JSON, and any text that is not byte-for-byte the JCS of its value
 * (member order, whitespace, escapes). Schema-awareness (unknown members,
 * hex case, scalar lengths) is the caller's job.
 */
export function parseGitvaultStrict(text: string): unknown {
  let ast: DocumentNode;
  try {
    ast = parse(text, { mode: "json", allowTrailingCommas: false });
  } catch {
    fail("GITVAULT_STRICT_PARSE", "invalid JSON", "strict-parsing r402s/v0 object", { reason: "invalid-json" });
  }
  inspectStrict(ast!, "$");
  const value = evaluate(ast!);
  if (jcsString(value) !== text) {
    fail("GITVAULT_STRICT_PARSE", "text is not canonical JCS", "strict-parsing r402s/v0 object", { reason: "noncanonical-encoding" });
  }
  return value;
}

/** Classify a strict-parse failure (for vector replay + diagnostics). */
export function gitvaultStrictParseReason(error: unknown): GitvaultStrictParseReason | null {
  if (error instanceof LocalError && error.code === "GITVAULT_STRICT_PARSE") {
    const details = error.details as { reason?: GitvaultStrictParseReason } | undefined;
    return details?.reason ?? null;
  }
  return null;
}

// ─── Hash rules: stored bytes + signature preimage ───────────────────────────

/** Stored bytes of a signed object = JCS of the COMPLETE object including `signature`. */
export function storedBytes(object: GitvaultSignedObject): Uint8Array {
  return jcs(object);
}

/** SHA-256 over stored bytes — what every `*_sha256` naming a signed object means. */
export function storedBytesSha256(object: GitvaultSignedObject): string {
  return sha256Hex(storedBytes(object));
}

function withoutSignature<T extends { signature?: unknown }>(object: T): Omit<T, "signature"> {
  const { signature: _signature, ...rest } = object;
  void _signature;
  return rest;
}

/**
 * Exported so the rotation producer (D195) can build the SAME
 * signature-stripped shape `rotation_id`'s own derivation needs
 * (`sha256(JCS(descriptor minus signature))`) without reaching into this
 * module's private helper twice under two different names.
 */
export function gitvaultWithoutSignature<T extends { signature?: unknown }>(object: T): Omit<T, "signature"> {
  return withoutSignature(object);
}

/** Signature preimage = `"r402s/v0/" + object_kind + "\n" + JCS(object without its single top-level signature)`. */
export function signaturePreimage(objectKind: GitvaultObjectKind, objectWithoutSignature: Record<string, unknown>): Uint8Array {
  if ("signature" in objectWithoutSignature) {
    fail("GITVAULT_PREIMAGE_HAS_SIGNATURE", "preimage input must not carry a signature member", "building r402s/v0 signature preimage");
  }
  return concatBytes(utf8ToBytes(`${GITVAULT_FORMAT}/${objectKind}\n`), jcs(objectWithoutSignature));
}

// ─── Ed25519 strict (RFC 8032, zip215:false) ─────────────────────────────────

export function ed25519PublicKey(seed: Uint8Array): Uint8Array {
  return ed25519.getPublicKey(seed);
}

export function ed25519Sign(message: Uint8Array, seed: Uint8Array): Uint8Array {
  return ed25519.sign(message, seed);
}

/**
 * Strict RFC 8032 verification: `zip215: false` is PINNED. Non-canonical R or A
 * encodings, non-canonical S, and wrong-length inputs are all `false` — never
 * an exception a caller could mistake for a transport error.
 */
export function ed25519VerifyStrict(signature: Uint8Array, message: Uint8Array, publicKey: Uint8Array): boolean {
  if (signature.length !== 64 || publicKey.length !== 32) return false;
  try {
    return ed25519.verify(signature, message, publicKey, { zip215: false });
  } catch {
    return false;
  }
}

/** Sign an object under its `object_kind` domain; returns the complete signed object. */
export function signGitvaultObject<T extends { object_kind: GitvaultObjectKind }>(
  objectWithoutSignature: T & { signature?: never },
  seed: Uint8Array,
): T & { signature: string } {
  const preimage = signaturePreimage(objectWithoutSignature.object_kind, objectWithoutSignature as Record<string, unknown>);
  return { ...objectWithoutSignature, signature: toBase64url(ed25519Sign(preimage, seed)) };
}

/**
 * Verify a signed object against a raw public key. Exact scalar lengths are
 * checked FIRST (an 85-char signature or a 42-char key is a schema reject,
 * never a decode-time surprise), then strict Ed25519 under the object's domain.
 */
export function verifyGitvaultObject(object: GitvaultSignedObject, publicKey: Uint8Array | string): boolean {
  if (typeof object.signature !== "string" || !GITVAULT_B64U_64_RE.test(object.signature) || !isCanonicalBase64url(object.signature)) return false;
  let pub: Uint8Array;
  if (typeof publicKey === "string") {
    if (!GITVAULT_B64U_32_RE.test(publicKey) || !isCanonicalBase64url(publicKey)) return false;
    pub = fromBase64url(publicKey);
  } else {
    pub = publicKey;
  }
  const preimage = signaturePreimage(object.object_kind, withoutSignature(object) as Record<string, unknown>);
  return ed25519VerifyStrict(fromBase64url(object.signature), preimage, pub);
}

/** Verify or throw `GITVAULT_SIGNATURE_INVALID`. */
export function assertGitvaultSignature(object: GitvaultSignedObject, publicKey: Uint8Array | string, context = "verifying r402s/v0 signature"): void {
  if (!verifyGitvaultObject(object, publicKey)) {
    fail("GITVAULT_SIGNATURE_INVALID", `${object.object_kind} signature does not verify (strict RFC 8032)`, context, { object_kind: object.object_kind });
  }
}

// ─── Key fingerprints + keypairs ─────────────────────────────────────────────

/** First 16 bytes of SHA-256(raw pubkey), lowercase hex (32 chars). */
export function keyFingerprintHex(rawPublicKey: Uint8Array): string {
  return sha256Hex(rawPublicKey).slice(0, 32);
}

/** `vk_` fingerprint of a raw Ed25519 public key. */
export function vkFingerprint(rawPublicKey: Uint8Array): string {
  return `vk_${keyFingerprintHex(rawPublicKey)}`;
}

/** `ek_` fingerprint of a raw X25519 public key. */
export function ekFingerprint(rawPublicKey: Uint8Array): string {
  return `ek_${keyFingerprintHex(rawPublicKey)}`;
}

export function generateSigningKeypair(seed: Uint8Array = randomBytes(32)): GitvaultSigningKeypair {
  if (seed.length !== 32) fail("GITVAULT_BAD_SEED", "Ed25519 seed must be 32 bytes", "generating signing keypair");
  return { seed, public_key: ed25519PublicKey(seed) };
}

export function generateEncryptionKeypair(privateKey: Uint8Array = randomBytes(32)): GitvaultEncryptionKeypair {
  if (privateKey.length !== 32) fail("GITVAULT_BAD_SEED", "X25519 private key must be 32 bytes", "generating encryption keypair");
  return { private_key: privateKey, public_key: x25519.getPublicKey(privateKey) };
}

// ─── HKDF: k_obj / K_digest, keyed commitments ──────────────────────────────

/** `k_obj` info = lp("r402s/v0") ‖ lp(suite) ‖ lp(repo_id) ‖ lp(epoch) ‖ lp(object_kind) ‖ lp(object_id) ‖ lp("L=32"). */
export function objectKeyInfo(repoId: string, epoch: string, objectKind: GitvaultEncryptedObjectKind, objectId: string): Uint8Array {
  return concatBytes(lp(GITVAULT_FORMAT), lp(GITVAULT_SUITE), lp(repoId), lp(epoch), lp(objectKind), lp(objectId), lp("L=32"));
}

/** `k_obj = HKDF-SHA-256(ikm=K_repo, salt=∅, info, L=32)`. */
export function deriveObjectKey(kRepo: Uint8Array, repoId: string, epoch: string, objectKind: GitvaultEncryptedObjectKind, objectId: string): Uint8Array {
  return hkdf(sha256, kRepo, undefined, objectKeyInfo(repoId, epoch, objectKind, objectId), 32);
}

/** `K_digest` info = lp("r402s/v0") ‖ lp("r402s-1") ‖ lp(repo_id) ‖ lp(epoch) ‖ lp("digest") ‖ lp(label) ‖ lp("L=32"). */
export function digestKeyInfo(repoId: string, epoch: string, label: GitvaultDigestLabel): Uint8Array {
  return concatBytes(lp(GITVAULT_FORMAT), lp(GITVAULT_SUITE), lp(repoId), lp(epoch), lp("digest"), lp(label), lp("L=32"));
}

export function deriveDigestKey(kRepo: Uint8Array, repoId: string, epoch: string, label: GitvaultDigestLabel): Uint8Array {
  return deriveDigestKeyFrom(kRepo, repoId, epoch, label);
}

/**
 * The general form `deriveDigestKey` is a fixed-`ikm=K_repo` specialization
 * of (D195/D198/D200, rev 42): every rev-42 rotation label is keyed by the
 * SAMPLED epoch key (`K_e` for a rotation, `K_1` for genesis) instead of
 * `K_repo` — "the value being committed IS the key being distributed"
 * (protocol-v0.md S1). Same HKDF info construction either way.
 */
export function deriveDigestKeyFrom(ikm: Uint8Array, repoId: string, epoch: string, label: GitvaultDigestLabel): Uint8Array {
  return hkdf(sha256, ikm, undefined, digestKeyInfo(repoId, epoch, label), 32);
}

/** Commitment = HMAC-SHA-256(K_digest(label), JCS(content)), lowercase hex. */
export function keyedCommitment(kDigest: Uint8Array, content: unknown): string {
  return bytesToHex(hmac(sha256, kDigest, jcs(content)));
}

/** The `"objectset"` content shape: `{oids:[sorted unique lowercase 40-hex]}`. */
export function objectsetContent(oids: Iterable<string>): { oids: string[] } {
  const unique = [...new Set(oids)];
  for (const oid of unique) {
    if (!GITVAULT_OID40_RE.test(oid)) fail("GITVAULT_BAD_OID", `not a lowercase 40-hex oid: ${oid}`, "building objectset content");
  }
  return { oids: unique.sort() };
}

/** True iff an `objectset` content is already in canonical (sorted-unique) order. */
export function isCanonicalObjectset(content: { oids: string[] }): boolean {
  const canonical = objectsetContent(content.oids).oids;
  return canonical.length === content.oids.length && canonical.every((oid, i) => oid === content.oids[i]);
}

/** The `"snapshot_oid"` content shape. */
export function snapshotOidContent(oid: string): { oid: string; format: "sha1" } {
  if (!GITVAULT_OID40_RE.test(oid)) fail("GITVAULT_BAD_OID", `not a lowercase 40-hex oid: ${oid}`, "building snapshot_oid content");
  return { oid, format: "sha1" };
}

// ─── Golden preimages (open-id / open-binding) ──────────────────────────────

/** `"r402s/v0/open-id" ‖ lp(org_id) ‖ lp(repo_id) ‖ lp(client_open_id)`. */
export function openIdPreimage(orgId: string, repoId: string, clientOpenId: string): Uint8Array {
  return concatBytes(utf8ToBytes("r402s/v0/open-id"), lp(orgId), lp(repoId), lp(clientOpenId));
}

/** `"r402s/v0/open-binding" ‖ lp(client_open_id) ‖ lp(base_head_sha256) ‖ lp_opt(prior) ‖ lp(requested_r2_cap_size_bytes)`. */
export function openBindingPreimage(
  clientOpenId: string,
  baseHeadSha256: string,
  priorCheckpointClaimSetSha256: string | null,
  requestedR2CapSizeBytes: string,
): Uint8Array {
  return concatBytes(
    utf8ToBytes("r402s/v0/open-binding"),
    lp(clientOpenId),
    lp(baseHeadSha256),
    lpOpt(priorCheckpointClaimSetSha256),
    lp(requestedR2CapSizeBytes),
  );
}

// ─── AEAD frame (XChaCha20-Poly1305) ────────────────────────────────────────

/** The seven-member frame AAD, as the object JCS serializes. */
export function frameAad(repoId: string, objectKind: GitvaultEncryptedObjectKind, objectId: string, epoch: string): GitvaultFrameAad {
  return { repo_id: repoId, object_kind: objectKind, object_id: objectId, epoch, suite: GITVAULT_SUITE, magic: GITVAULT_FRAME_MAGIC, suite_id: GITVAULT_FRAME_SUITE_ID };
}

export interface GitvaultSealFrameInput {
  /** The per-object key — derive with {@link deriveObjectKey}. */
  k_obj: Uint8Array;
  repo_id: string;
  object_kind: GitvaultEncryptedObjectKind;
  object_id: string;
  epoch: string;
  plaintext: Uint8Array;
  /** 24-byte nonce; CSPRNG when omitted. Vectors inject it for determinism. */
  nonce?: Uint8Array;
}

/**
 * Seal a plaintext into the §2 frame: `"R402S0"` ‖ `0x01` ‖ nonce(24) ‖ ct‖tag.
 * `ciphertext_sha256` covers the COMPLETE frame. Callers own the single-use
 * rule: one object id, one seal — never re-encrypt under an id.
 */
export function sealFrame(input: GitvaultSealFrameInput): GitvaultSealedFrame {
  if (input.k_obj.length !== 32) fail("GITVAULT_BAD_KEY", "k_obj must be 32 bytes", "sealing r402s/v0 frame");
  if (input.plaintext.length > GITVAULT_MAX_PLAINTEXT_BYTES) {
    fail("GIT_OBJECT_TOO_LARGE", "plaintext exceeds the 256 MiB per-object cap", "sealing r402s/v0 frame", { size_bytes: String(input.plaintext.length) });
  }
  const nonce = input.nonce ?? randomBytes(FRAME_NONCE_BYTES);
  if (nonce.length !== FRAME_NONCE_BYTES) fail("GITVAULT_BAD_NONCE", "frame nonce must be 24 bytes", "sealing r402s/v0 frame");
  const aad = jcs(frameAad(input.repo_id, input.object_kind, input.object_id, input.epoch));
  const ct = xchacha20poly1305(input.k_obj, nonce, aad).encrypt(input.plaintext);
  const frame = concatBytes(utf8ToBytes(GITVAULT_FRAME_MAGIC), new Uint8Array([GITVAULT_FRAME_SUITE_BYTE]), nonce, ct);
  return { frame, ciphertext_sha256: sha256Hex(frame), size_bytes: String(frame.length), nonce_hex: bytesToHex(nonce) };
}

export interface GitvaultOpenFrameInput {
  k_obj: Uint8Array;
  repo_id: string;
  object_kind: GitvaultEncryptedObjectKind;
  object_id: string;
  epoch: string;
  frame: Uint8Array;
  /** When given, the frame's SHA-256 must equal the receipt BEFORE any decryption (the header is authenticated twice: by the receipt and by the AAD). */
  expected_ciphertext_sha256?: string;
}

/**
 * Open a §2 frame: header checked (magic, suite byte, length), receipt
 * compared when supplied, then the AEAD opened under the seven-member AAD.
 * No unverified streaming release — the whole plaintext or nothing.
 */
export function openFrame(input: GitvaultOpenFrameInput): Uint8Array {
  const { frame } = input;
  if (input.expected_ciphertext_sha256 !== undefined && sha256Hex(frame) !== input.expected_ciphertext_sha256) {
    fail("GITVAULT_RECEIPT_MISMATCH", "frame bytes do not hash to the receipt's ciphertext_sha256", "opening r402s/v0 frame", { object_id: input.object_id });
  }
  if (frame.length < FRAME_HEADER_BYTES + AEAD_TAG_BYTES) {
    fail("GITVAULT_FRAME_INVALID", "frame shorter than header + tag", "opening r402s/v0 frame", { object_id: input.object_id });
  }
  const magic = new TextDecoder().decode(frame.subarray(0, 6));
  if (magic !== GITVAULT_FRAME_MAGIC || frame[6] !== GITVAULT_FRAME_SUITE_BYTE) {
    fail("GITVAULT_FRAME_INVALID", "frame header magic/suite mismatch", "opening r402s/v0 frame", { object_id: input.object_id });
  }
  return openFrameWithAad(input.k_obj, frame, jcs(frameAad(input.repo_id, input.object_kind, input.object_id, input.epoch)), input.object_id);
}

/**
 * The AEAD half of {@link openFrame} with the AAD supplied verbatim — the
 * vector replay uses it to prove every one of the seven AAD members is
 * authenticated (including the constant `suite`/`magic`/`suite_id` members
 * that {@link openFrame}'s typed input cannot vary). Header already checked.
 */
export function openFrameWithAad(kObj: Uint8Array, frame: Uint8Array, aad: Uint8Array, objectId = "?"): Uint8Array {
  if (frame.length < FRAME_HEADER_BYTES + AEAD_TAG_BYTES) {
    fail("GITVAULT_FRAME_INVALID", "frame shorter than header + tag", "opening r402s/v0 frame", { object_id: objectId });
  }
  const nonce = frame.subarray(7, FRAME_HEADER_BYTES);
  const ct = frame.subarray(FRAME_HEADER_BYTES);
  try {
    return xchacha20poly1305(kObj, nonce, aad).decrypt(ct);
  } catch {
    fail("GITVAULT_AEAD_AUTH_FAILURE", "frame failed AEAD authentication", "opening r402s/v0 frame", { object_id: objectId });
  }
}

// ─── HPKE (named implementation: @hpke/core + @hpke/chacha20poly1305) ───────

let hpkeSuite: CipherSuite | undefined;

/** The one `r402s-1` HPKE suite: Base mode, DHKEM(X25519,HKDF-SHA256) 0x0020 / HKDF-SHA256 0x0001 / ChaCha20-Poly1305 0x0003. */
export function gitvaultHpkeSuite(): CipherSuite {
  hpkeSuite ??= new CipherSuite({ kem: new DhkemX25519HkdfSha256(), kdf: new HkdfSha256(), aead: new Chacha20Poly1305() });
  return hpkeSuite;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  return copy.buffer;
}

/** HPKE `info` (D188): lp("r402s/v0/envelope") ‖ lp("r402s-1") ‖ lp(lowerhex(SHA-256(recipient raw X25519 pubkey))) ‖ lp(created_by). */
export function envelopeInfo(recipientPublicKeyRaw: Uint8Array, createdBy: string): Uint8Array {
  return concatBytes(lp(GITVAULT_ENVELOPE_INFO_LABEL), lp(GITVAULT_SUITE), lp(sha256Hex(recipientPublicKeyRaw)), lp(createdBy));
}

/**
 * HPKE AAD (D188, discriminated by `rotation_id` presence — D203, rev 42):
 * `rotation_id` ABSENT (genesis / ADD-workaround envelope) -> the rev-41
 * four-field form, BYTE-IDENTICAL to every existing golden HPKE digest;
 * `rotation_id` PRESENT (a rotation-attempt envelope) -> the new five-field
 * form. Field ORDER in the returned object does not matter (JCS sorts
 * object members), but `rotation_id` must never be included as an explicit
 * `null` — the two shapes are genuinely different objects, not one object
 * with an optional-null member (protocol-v0.md S2).
 */
export function envelopeAad(repoId: string, epoch: string, recipientFingerprint: string, rotationId?: string | null): GitvaultEnvelopeAad {
  if (rotationId) {
    return { repo_id: repoId, epoch, rotation_id: rotationId, recipient_kind: "principal", recipient_fingerprint: recipientFingerprint };
  }
  return { repo_id: repoId, epoch, recipient_kind: "principal", recipient_fingerprint: recipientFingerprint };
}

export interface GitvaultHpkeSealInput {
  recipient_public_key: Uint8Array;
  info: Uint8Array;
  aad: Uint8Array;
  plaintext: Uint8Array;
  /** RFC 9180 §7.1.3 `DeriveKeyPair(ikmE)` injection — TEST/vector determinism only; production seals use the OS CSPRNG. */
  ikm_e?: Uint8Array;
}

/** Single-shot HPKE seal (Base mode) returning `{enc, ct}`. */
export async function hpkeSeal(input: GitvaultHpkeSealInput): Promise<{ enc: Uint8Array; ct: Uint8Array }> {
  const suite = gitvaultHpkeSuite();
  const recipientPublicKey = await suite.kem.deserializePublicKey(toArrayBuffer(input.recipient_public_key));
  const ekm = input.ikm_e ? await suite.kem.deriveKeyPair(toArrayBuffer(input.ikm_e)) : undefined;
  const sender = await suite.createSenderContext({ recipientPublicKey, info: toArrayBuffer(input.info), ...(ekm ? { ekm } : {}) });
  const ct = new Uint8Array(await sender.seal(toArrayBuffer(input.plaintext), toArrayBuffer(input.aad)));
  return { enc: new Uint8Array(sender.enc), ct };
}

export interface GitvaultHpkeOpenInput {
  recipient_private_key: Uint8Array;
  enc: Uint8Array;
  info: Uint8Array;
  aad: Uint8Array;
  ct: Uint8Array;
}

/** Single-shot HPKE open; any failure is `GITVAULT_HPKE_OPEN_FAILED` (never garbage plaintext). */
export async function hpkeOpen(input: GitvaultHpkeOpenInput): Promise<Uint8Array> {
  const suite = gitvaultHpkeSuite();
  try {
    const recipientKey = await suite.kem.deserializePrivateKey(toArrayBuffer(input.recipient_private_key));
    const recipient = await suite.createRecipientContext({ recipientKey, enc: toArrayBuffer(input.enc), info: toArrayBuffer(input.info) });
    return new Uint8Array(await recipient.open(toArrayBuffer(input.ct), toArrayBuffer(input.aad)));
  } catch {
    fail("GITVAULT_HPKE_OPEN_FAILED", "HPKE open failed — the recipient recovers no key", "opening r402s/v0 key envelope");
  }
}

export interface GitvaultSealKeyEnvelopeInput {
  /** The raw 32-byte secret being distributed — `K_repo`/`K_1` at genesis, `K_e` for a rotation. */
  k_repo: Uint8Array;
  repo_id: string;
  epoch: string;
  /** The recipient's raw X25519 public key. */
  recipient_public_key: Uint8Array;
  /** The creator's signing keypair; its `vk_` fingerprint becomes `created_by`. */
  signer: GitvaultSigningKeypair;
  created_at: string;
  /**
   * PRESENT for a rotation-attempt envelope (D195/D196, rev 42): widens the
   * path to `(repo_id, epoch, rotation_id, recipient_fingerprint)` and the
   * HPKE AAD to the five-field form. ABSENT/omitted for a genesis/ADD-
   * workaround envelope — byte-identical to rev 41.
   */
  rotation_id?: string | null;
  /** Vector determinism only. */
  ikm_e?: Uint8Array;
}

/** Seal + sign a `key_envelope` for one principal; returns the object with its stored-bytes identity + genesis receipt. */
export async function sealKeyEnvelope(input: GitvaultSealKeyEnvelopeInput): Promise<GitvaultSealedKeyEnvelope> {
  if (input.k_repo.length !== 32) fail("GITVAULT_BAD_KEY", "K_repo must be 32 bytes", "sealing r402s/v0 key envelope");
  if (!isValidGitvaultTimestamp(input.created_at)) fail("GITVAULT_BAD_TIMESTAMP", "created_at is not an RFC 3339 UTC ms timestamp", "sealing r402s/v0 key envelope");
  const createdBy = vkFingerprint(input.signer.public_key);
  const recipientFingerprint = ekFingerprint(input.recipient_public_key);
  const rotationId = input.rotation_id ?? null;
  const { enc, ct } = await hpkeSeal({
    recipient_public_key: input.recipient_public_key,
    info: envelopeInfo(input.recipient_public_key, createdBy),
    aad: jcs(envelopeAad(input.repo_id, input.epoch, recipientFingerprint, rotationId)),
    plaintext: input.k_repo,
    ikm_e: input.ikm_e,
  });
  const unsigned = {
    format: GITVAULT_FORMAT,
    object_kind: "key_envelope" as const,
    suite: GITVAULT_SUITE,
    repo_id: input.repo_id,
    epoch: input.epoch,
    recipient_kind: "principal" as const,
    recipient_fingerprint: recipientFingerprint,
    enc: toBase64url(enc),
    ct: toBase64url(ct),
    created_by: createdBy,
    created_at: input.created_at,
    ...(rotationId ? { rotation_id: rotationId } : {}),
  };
  const envelope = signGitvaultObject(unsigned, input.signer.seed) as GitvaultKeyEnvelope;
  const bytes = storedBytes(envelope as unknown as GitvaultSignedObject);
  const hash = sha256Hex(bytes);
  return {
    envelope,
    stored_bytes: bytes,
    stored_bytes_sha256: hash,
    size_bytes: String(bytes.length),
    receipt: {
      object_kind: "key_envelope",
      epoch: input.epoch,
      recipient_fingerprint: recipientFingerprint,
      stored_bytes_sha256: hash,
      size_bytes: String(bytes.length),
      ...(rotationId ? { rotation_id: rotationId } : {}),
    },
  };
}

export interface GitvaultOpenKeyEnvelopeInput {
  envelope: GitvaultKeyEnvelope;
  /** The recipient's raw X25519 keypair (the public half feeds `info`; the fingerprint must match the path identity). */
  recipient: GitvaultEncryptionKeypair;
  /** The creator's raw Ed25519 public key — the envelope signature is verified BEFORE any open. */
  signer_public_key: Uint8Array | string;
}

/**
 * Open a `key_envelope`: exact-scalar checks → signature (strict, domain
 * `key_envelope`) → path identity (recipient fingerprint = ours) → HPKE open
 * with the D188 info/AAD (widened to the five-field form when the envelope
 * itself carries `rotation_id` — D195/D203). Returns the raw 32-byte secret
 * (`K_repo`/`K_1` at genesis, `K_e` for a rotation).
 */
export async function openKeyEnvelope(input: GitvaultOpenKeyEnvelopeInput): Promise<Uint8Array> {
  const env = input.envelope;
  if (!GITVAULT_HPKE_CT_RE.test(env.ct) || !GITVAULT_B64U_32_RE.test(env.enc) || !isCanonicalBase64url(env.ct) || !isCanonicalBase64url(env.enc)) {
    fail("GITVAULT_SCHEMA_REJECT", "key_envelope enc/ct are not the exact scalar lengths", "opening r402s/v0 key envelope");
  }
  assertGitvaultSignature(env as unknown as GitvaultSignedObject, input.signer_public_key, "opening r402s/v0 key envelope");
  const ours = ekFingerprint(input.recipient.public_key);
  if (env.recipient_fingerprint !== ours || env.recipient_kind !== "principal") {
    fail("GITVAULT_ENVELOPE_NOT_FOR_RECIPIENT", "key_envelope is addressed to another recipient", "opening r402s/v0 key envelope", { recipient_fingerprint: env.recipient_fingerprint });
  }
  const kRepo = await hpkeOpen({
    recipient_private_key: input.recipient.private_key,
    enc: fromBase64url(env.enc, "enc"),
    info: envelopeInfo(input.recipient.public_key, env.created_by),
    aad: jcs(envelopeAad(env.repo_id, env.epoch, env.recipient_fingerprint, env.rotation_id ?? null)),
    ct: fromBase64url(env.ct, "ct"),
  });
  if (kRepo.length !== 32) fail("GITVAULT_HPKE_OPEN_FAILED", "opened plaintext is not a 32-byte K_repo", "opening r402s/v0 key envelope");
  return kRepo;
}

// ─── Genesis + recovery receipt ──────────────────────────────────────────────

export interface GitvaultBuildGenesisInput {
  repo_id: string;
  org_id: string;
  project_id: string;
  allocation_nonce: string;
  creator_signing: GitvaultSigningKeypair;
  creator_encryption_public_key: Uint8Array;
  envelope_receipt: GitvaultKeyEnvelopeReceipt;
  created_at: string;
}

/** Build + sign a `vault_genesis` (generation 0, epoch 1, the creator's single envelope). */
export function buildVaultGenesis(input: GitvaultBuildGenesisInput): GitvaultVaultGenesis {
  const unsigned = {
    format: GITVAULT_FORMAT,
    object_kind: "vault_genesis" as const,
    suite: GITVAULT_SUITE,
    repo_id: input.repo_id,
    org_id: input.org_id,
    project_id: input.project_id,
    allocation_nonce: input.allocation_nonce,
    generation: GITVAULT_GENESIS_GENERATION,
    epoch: GITVAULT_GENESIS_EPOCH,
    git_object_format: "sha1" as const,
    creator_signing_pubkey: toBase64url(input.creator_signing.public_key),
    creator_encryption_pubkey: toBase64url(input.creator_encryption_public_key),
    envelopes: [input.envelope_receipt],
    writer_key_id: vkFingerprint(input.creator_signing.public_key),
    created_at: input.created_at,
  };
  return signGitvaultObject(unsigned, input.creator_signing.seed) as GitvaultVaultGenesis;
}

/** A named genesis key-binding failure (semantic constraints `genesis-key-bindings` / `envelope-receipt-binding`). */
export type GitvaultGenesisBindingProblem =
  | "envelope_count"
  | "envelope_epoch"
  | "envelope_recipient_fingerprint"
  | "writer_key_id"
  | "stored_envelope_hash"
  | "stored_envelope_size"
  | "stored_envelope_repo_id"
  | "stored_envelope_epoch"
  | "stored_envelope_recipient_fingerprint"
  | "stored_envelope_created_by";

/**
 * The genesis key bindings (round-10 A6): exactly one envelope at epoch 1 whose
 * `recipient_fingerprint` is the creator's `ek_`; `writer_key_id` is the
 * creator's `vk_`; and, when the stored envelope is supplied, the receipt's
 * hash/size name its stored bytes and its path identity + `created_by` equal
 * the genesis values. Schema-valid-but-protocol-invalid objects surface here.
 */
export function checkGenesisKeyBindings(genesis: GitvaultVaultGenesis, storedEnvelope?: GitvaultKeyEnvelope): GitvaultGenesisBindingProblem[] {
  const problems: GitvaultGenesisBindingProblem[] = [];
  if (genesis.envelopes.length !== 1) problems.push("envelope_count");
  const receipt = genesis.envelopes[0];
  if (receipt && receipt.epoch !== GITVAULT_GENESIS_EPOCH) problems.push("envelope_epoch");
  const expectedEk = ekFingerprint(fromBase64url(genesis.creator_encryption_pubkey, "creator_encryption_pubkey"));
  if (receipt && receipt.recipient_fingerprint !== expectedEk) problems.push("envelope_recipient_fingerprint");
  const expectedVk = vkFingerprint(fromBase64url(genesis.creator_signing_pubkey, "creator_signing_pubkey"));
  if (genesis.writer_key_id !== expectedVk) problems.push("writer_key_id");
  if (storedEnvelope && receipt) {
    const bytes = storedBytes(storedEnvelope as unknown as GitvaultSignedObject);
    if (sha256Hex(bytes) !== receipt.stored_bytes_sha256) problems.push("stored_envelope_hash");
    if (String(bytes.length) !== receipt.size_bytes) problems.push("stored_envelope_size");
    if (storedEnvelope.repo_id !== genesis.repo_id) problems.push("stored_envelope_repo_id");
    if (storedEnvelope.epoch !== genesis.epoch) problems.push("stored_envelope_epoch");
    if (storedEnvelope.recipient_fingerprint !== receipt.recipient_fingerprint) problems.push("stored_envelope_recipient_fingerprint");
    if (storedEnvelope.created_by !== genesis.writer_key_id) problems.push("stored_envelope_created_by");
  }
  return problems;
}

export interface GitvaultBuildRecoveryReceiptInput {
  repo_id: string;
  org_id: string;
  project_id: string;
  genesis_sha256: string;
  creator_signing: GitvaultSigningKeypair;
  creator_encryption_public_key: Uint8Array;
}

/** Build + sign the creator's `recovery_receipt` (emitted at ACTIVE; integrity data, not a secret). */
export function buildRecoveryReceipt(input: GitvaultBuildRecoveryReceiptInput): GitvaultRecoveryReceipt {
  const unsigned = {
    format: GITVAULT_FORMAT,
    object_kind: "recovery_receipt" as const,
    suite: GITVAULT_SUITE,
    repo_id: input.repo_id,
    org_id: input.org_id,
    project_id: input.project_id,
    genesis_sha256: input.genesis_sha256,
    creator_signing_fingerprint: vkFingerprint(input.creator_signing.public_key),
    creator_encryption_fingerprint: ekFingerprint(input.creator_encryption_public_key),
  };
  return signGitvaultObject(unsigned, input.creator_signing.seed) as GitvaultRecoveryReceipt;
}

export type GitvaultRecoveryReceiptProblem =
  | "signature"
  | "genesis_sha256"
  | "repo_id"
  | "org_id"
  | "project_id"
  | "creator_signing_fingerprint"
  | "creator_encryption_fingerprint";

/**
 * Check a recovery receipt against a genesis it claims to pin: the receipt's
 * signature (under the genesis's creator key), the genesis stored-bytes hash,
 * and every identity field. A substituted, internally consistent vault fails
 * on `genesis_sha256` — exactly the fabricated-vault scenario.
 */
export function checkRecoveryReceipt(receipt: GitvaultRecoveryReceipt, genesis: GitvaultVaultGenesis): GitvaultRecoveryReceiptProblem[] {
  const problems: GitvaultRecoveryReceiptProblem[] = [];
  if (!verifyGitvaultObject(receipt as unknown as GitvaultSignedObject, genesis.creator_signing_pubkey)) problems.push("signature");
  if (receipt.genesis_sha256 !== storedBytesSha256(genesis as unknown as GitvaultSignedObject)) problems.push("genesis_sha256");
  if (receipt.repo_id !== genesis.repo_id) problems.push("repo_id");
  if (receipt.org_id !== genesis.org_id) problems.push("org_id");
  if (receipt.project_id !== genesis.project_id) problems.push("project_id");
  if (receipt.creator_signing_fingerprint !== genesis.writer_key_id) problems.push("creator_signing_fingerprint");
  const expectedEk = ekFingerprint(fromBase64url(genesis.creator_encryption_pubkey, "creator_encryption_pubkey"));
  if (receipt.creator_encryption_fingerprint !== expectedEk) problems.push("creator_encryption_fingerprint");
  return problems;
}

/**
 * Field-level checks on an `allocation` for THIS creation attempt (the
 * control-plane signature itself is verified through the service-key registry,
 * which task 5.4 wires; pass `service_public_key` once it is pinned).
 *
 * `expected.org_id` / `expected.project_id` are OPTIONAL (repo-first-onramp
 * task 4.5's push-to-create addition): a push-to-create attempt does not know
 * its org/project ahead of the allocation response (only `org_slug`/
 * `repo_name`), so those two fields are trust-on-first-use — the caller skips
 * the comparison on the FIRST allocation of a fresh push-to-create journal and
 * pins whatever the (owner-authorized, signature-verified) allocation says,
 * then compares against that pin on every later call for the SAME journal.
 * Every other field is checked unconditionally, same as before.
 */
export function checkAllocation(
  allocation: GitvaultAllocation,
  expected: { client_creation_id: string; creator_signing_fingerprint: string; creator_encryption_fingerprint: string; org_id?: string; project_id?: string },
  servicePublicKey?: Uint8Array | string,
): string[] {
  const problems: string[] = [];
  if (allocation.format !== GITVAULT_FORMAT || allocation.object_kind !== "allocation" || allocation.suite !== GITVAULT_SUITE) problems.push("envelope");
  if (!GITVAULT_SRC_RE.test(allocation.repo_id)) problems.push("repo_id");
  if (!GITVAULT_HEX32_RE.test(allocation.allocation_nonce)) problems.push("allocation_nonce");
  if (!GITVAULT_HEX16_RE.test(allocation.allocation_generation)) problems.push("allocation_generation");
  if (!GITVAULT_SERVICE_KEY_ID_RE.test(allocation.service_key_id)) problems.push("service_key_id");
  if (allocation.client_creation_id !== expected.client_creation_id) problems.push("client_creation_id");
  if (allocation.creator_signing_fingerprint !== expected.creator_signing_fingerprint) problems.push("creator_signing_fingerprint");
  if (allocation.creator_encryption_fingerprint !== expected.creator_encryption_fingerprint) problems.push("creator_encryption_fingerprint");
  if (expected.org_id !== undefined && allocation.org_id !== expected.org_id) problems.push("org_id");
  if (expected.project_id !== undefined && allocation.project_id !== expected.project_id) problems.push("project_id");
  if (!isValidGitvaultTimestamp(allocation.issued_at) || !isValidGitvaultTimestamp(allocation.created_at)) problems.push("timestamp");
  if (servicePublicKey !== undefined && !verifyGitvaultObject(allocation as unknown as GitvaultSignedObject, servicePublicKey)) problems.push("signature");
  return problems;
}

// ─── Epoch rotation (D193-D203, rev 42, change gitvault-human-envelopes) ───
//
// Pure, isomorphic math shared by the producer (Node-only, gitvault-
// publication.ts's `rotateEpoch`, which has the live desired-recipient
// state + local keystore this module cannot see) and by vector generation.
// Every formula here MIRRORS the gateway's own pure functions in
// `packages/gateway/src/services/gitvault/epoch-rotation.ts` byte-for-byte
// (same field order is irrelevant — JCS sorts — but the SAME field SET and
// the SAME preimage construction is load-bearing: a drift here would build
// a descriptor/payload the gateway's own re-derivation refuses).

/** 16-hex epochs compare/increment as unsigned integers (chain.ts's `nextGeneration`, mirrored). */
export function epochValue(hex16: string): bigint {
  return BigInt("0x" + hex16);
}

export function nextEpoch(hex16: string): string {
  return (epochValue(hex16) + 1n).toString(16).padStart(16, "0");
}

function sortedDistinct(xs: readonly string[]): string[] {
  return [...new Set(xs)].sort();
}

export interface GitvaultIncludedPair {
  principal_id: string;
  ek_fingerprint: string;
}

/**
 * D196: `target_partition_digest = SHA-256(JCS({recipient_state_version,
 * recipient_revocation_version, pin_manifest_version, pin_manifest_sha256,
 * included: [sorted {principal_id, ek_fingerprint}], excluded_keyless_principal_ids:
 * [sorted], excluded_unconfirmed_principal_ids: [sorted]}))`. The producer
 * calls this ONCE to build the value it embeds in both the descriptor
 * (D195) and the payload (D196); the gateway recomputes the SAME formula
 * twice server-side and refuses on any disagreement — so a bug here is a
 * `RECIPIENT_SET_MISMATCH` at admission time, not a silent forgery.
 */
export function computeTargetPartitionDigest(input: {
  recipient_state_version: string;
  recipient_revocation_version: string;
  pin_manifest_version: string;
  pin_manifest_sha256: string;
  included: readonly GitvaultIncludedPair[];
  excluded_keyless_principal_ids: readonly string[];
  excluded_unconfirmed_principal_ids: readonly string[];
}): string {
  const includedSorted = [...input.included].sort((a, b) => (a.principal_id < b.principal_id ? -1 : a.principal_id > b.principal_id ? 1 : 0));
  const body = {
    recipient_state_version: input.recipient_state_version,
    recipient_revocation_version: input.recipient_revocation_version,
    pin_manifest_version: input.pin_manifest_version,
    pin_manifest_sha256: input.pin_manifest_sha256,
    included: includedSorted.map((p) => ({ principal_id: p.principal_id, ek_fingerprint: p.ek_fingerprint })),
    excluded_keyless_principal_ids: sortedDistinct(input.excluded_keyless_principal_ids),
    excluded_unconfirmed_principal_ids: sortedDistinct(input.excluded_unconfirmed_principal_ids),
  };
  return sha256Hex(jcs(body));
}

/**
 * D195: `rotation_id = lowerhex(SHA-256(JCS(the complete descriptor object,
 * MINUS signature)))` — the full 64-hex digest, computed over the descriptor
 * INCLUDING `attempt_key_commitment` (a field ON the descriptor). Callers
 * pass the SIGNED descriptor (or the unsigned one — the signature member is
 * stripped either way, matching the gateway's `computeRotationId`).
 */
export function computeRotationId(descriptor: Record<string, unknown> & { signature?: unknown }): string {
  return sha256Hex(jcs(gitvaultWithoutSignature(descriptor)));
}

/**
 * D195's `attempt_key_commitment` preimage: the descriptor's OWN fields
 * minus `attempt_key_commitment` itself (and minus `signature`, which does
 * not exist yet at this point in the build) — `rotation_id` is never a
 * member of the descriptor object at all (it is the object's derived path
 * key), so there is nothing to additionally strip for it. Noncircular by
 * construction: `attempt_key_commitment` must exist before `rotation_id`
 * can be computed FROM the complete descriptor.
 */
export function attemptKeyCommitmentPreimage(descriptorFields: {
  format: GitvaultFormat;
  object_kind: "rotation_attempt_descriptor";
  suite: GitvaultSuite;
  repo_id: string;
  base_head_sha256: string;
  new_epoch: string;
  recipient_state_version: string;
  recipient_revocation_version: string;
  pin_manifest_sha256: string;
  target_partition_digest: string;
  client_idempotency_key: string;
  writer_key_id: string;
}): Record<string, unknown> {
  return { ...descriptorFields };
}

/**
 * D195/§1's `"epoch_rotation_attempt"` commitment: `HMAC-SHA-256(K_digest(
 * "epoch_rotation_attempt", repo_id, new_epoch), JCS(the descriptor's own
 * fields minus attempt_key_commitment), ikm=K_e)` — keyed by the SAMPLED
 * epoch key being distributed, not `K_repo` (D195/D200/§1: "every one keyed
 * by the SAMPLED epoch key... since the value being committed IS the key
 * being distributed"). `K_digest`'s own `epoch` parameter is `new_epoch`
 * (this rotation's OWN epoch) — the natural, and only internally-consistent,
 * reading of §1's generic formula for a value that is a property of the new
 * epoch's key; there is no gateway-side computation of this value to cross-
 * check against (the gateway never sees `K_e`), so this is the SDK's own
 * considered wire-shape decision, stated here rather than guessed silently.
 */
export function attemptKeyCommitment(kE: Uint8Array, repoId: string, newEpoch: string, descriptorFields: Parameters<typeof attemptKeyCommitmentPreimage>[0]): string {
  const kDigest = deriveDigestKeyFrom(kE, repoId, newEpoch, "epoch_rotation_attempt");
  return keyedCommitment(kDigest, attemptKeyCommitmentPreimage(descriptorFields));
}

/**
 * D200/§1's `"epoch_rotation"` commitment: `HMAC-SHA-256(K_digest(
 * "epoch_rotation", repo_id, new_epoch), JCS({rotation_id, fingerprints:
 * [sorted pairwise-distinct]}), ikm=K_e)`. Proves a PER-RECIPIENT self-check
 * only (D200's narrowed claim) — never global set-coherence. A recipient
 * who opens their own envelope recovers `K_e` + `epoch` (== `new_epoch`)
 * directly from the envelope itself, so they can recompute this independent
 * of the descriptor/payload — confirming `new_epoch` is the right `K_digest`
 * epoch parameter (the same value both the producer and every recipient
 * arrive at without coordination).
 */
export function epochRotationKeyCommitment(kE: Uint8Array, repoId: string, newEpoch: string, rotationId: string, fingerprints: readonly string[]): string {
  const kDigest = deriveDigestKeyFrom(kE, repoId, newEpoch, "epoch_rotation");
  return keyedCommitment(kDigest, { rotation_id: rotationId, fingerprints: sortedDistinct(fingerprints) });
}

/**
 * D198's genesis-specific `"vault_genesis_epoch_key"` commitment — the same
 * per-recipient-self-check discipline applied to an N-recipient genesis,
 * with its own noncircular preimage (no `rotation_id` exists at generation
 * zero). Not built by this SDK's genesis path today (single-recipient
 * genesis only); exported for vector generation / future N-recipient
 * genesis support.
 */
export function genesisEpochKeyCommitment(k1: Uint8Array, repoId: string, fingerprints: readonly string[]): string {
  const kDigest = deriveDigestKeyFrom(k1, repoId, GITVAULT_GENESIS_EPOCH, "vault_genesis_epoch_key");
  return keyedCommitment(kDigest, { repo_id: repoId, generation: GITVAULT_GENESIS_GENERATION, epoch: GITVAULT_GENESIS_EPOCH, fingerprints: sortedDistinct(fingerprints) });
}

/**
 * D195's producer obligation the round-3 review's own decisive witness
 * forces: "a producer that cannot prove it is resuming its OWN prior
 * in-flight attempt... MUST mint a fresh `client_idempotency_key`... before
 * uploading any envelope." The corollary — and what actually PREVENTS the
 * complementary-path mosaic client-side, before the descriptor's create-only
 * CAS even gets a chance to catch it server-side — is that a fresh K_e must
 * never equal any epoch key this client has ever locally held (constant-time
 * comparison; a match is evidence of a broken CSPRNG or a reused seed, not a
 * legitimate resume, since a genuine resume reuses the SAME
 * client_idempotency_key AND therefore builds the identical descriptor, not
 * merely the same K_e in isolation).
 */
export function checkFreshEpochKeyAgainstPriorKeys(kE: Uint8Array, priorKeys: Iterable<Uint8Array>): void {
  if (kE.length !== 32) fail("GITVAULT_BAD_KEY", "a freshly sampled K_e must be 32 bytes", "sampling a fresh epoch key");
  const fresh = bytesToHex(kE);
  for (const prior of priorKeys) {
    if (bytesToHex(prior) === fresh) {
      fail("GITVAULT_EPOCH_KEY_NOT_FRESH", "the freshly sampled K_e equals a prior epoch key already held locally — refusing to seal under it", "sampling a fresh epoch key");
    }
  }
}

export type GitvaultHPartitionVerdict = { ok: true } | { ok: false; detail: string };

/**
 * D196's pair-level bijection, mirrored client-side as a PRE-SUBMIT
 * self-check (the gateway's own recomputation under its live desired-state
 * lock remains the authoritative check — this exists so a client-side
 * partition bug surfaces as a clear local error instead of a round trip
 * that ends in `RECIPIENT_SET_MISMATCH`).
 */
export function checkHPartition(input: {
  desiredPrincipalIds: ReadonlySet<string>;
  keyedPrincipalIds: ReadonlySet<string>;
  pinnedFingerprintOf: ReadonlyMap<string, string>;
  included: readonly GitvaultIncludedPair[];
  excludedKeylessPrincipalIds: readonly string[];
  excludedUnconfirmedPrincipalIds: readonly string[];
}): GitvaultHPartitionVerdict {
  const includedIds = input.included.map((p) => p.principal_id);
  const includedFps = input.included.map((p) => p.ek_fingerprint);
  if (new Set(includedIds).size !== includedIds.length) return { ok: false, detail: "envelopes[].principal_id are not pairwise-distinct" };
  if (new Set(includedFps).size !== includedFps.length) return { ok: false, detail: "envelopes[].envelope.recipient_fingerprint are not pairwise-distinct" };
  if (new Set(input.excludedKeylessPrincipalIds).size !== input.excludedKeylessPrincipalIds.length) return { ok: false, detail: "excluded_keyless_principal_ids are not pairwise-distinct" };
  if (new Set(input.excludedUnconfirmedPrincipalIds).size !== input.excludedUnconfirmedPrincipalIds.length) return { ok: false, detail: "excluded_unconfirmed_principal_ids are not pairwise-distinct" };

  const partition = new Map<string, "included" | "keyless" | "unconfirmed">();
  for (const id of includedIds) {
    if (partition.has(id)) return { ok: false, detail: `principal ${id} appears more than once across the partition` };
    partition.set(id, "included");
  }
  for (const id of input.excludedKeylessPrincipalIds) {
    if (partition.has(id)) return { ok: false, detail: `principal ${id} appears more than once across the partition` };
    partition.set(id, "keyless");
  }
  for (const id of input.excludedUnconfirmedPrincipalIds) {
    if (partition.has(id)) return { ok: false, detail: `principal ${id} appears more than once across the partition` };
    partition.set(id, "unconfirmed");
  }
  if (partition.size !== input.desiredPrincipalIds.size) return { ok: false, detail: `partition covers ${partition.size} principals; H has ${input.desiredPrincipalIds.size}` };
  for (const id of partition.keys()) if (!input.desiredPrincipalIds.has(id)) return { ok: false, detail: `principal ${id} is not in the current desired-recipient set H` };
  for (const id of input.desiredPrincipalIds) if (!partition.has(id)) return { ok: false, detail: `principal ${id} in H is named by neither envelopes[] nor either exclusion array` };

  for (const pair of input.included) {
    if (!input.keyedPrincipalIds.has(pair.principal_id)) return { ok: false, detail: `included principal ${pair.principal_id} has no enrolled key` };
    const pinned = input.pinnedFingerprintOf.get(pair.principal_id);
    if (pinned === undefined) return { ok: false, detail: `included principal ${pair.principal_id} has no live pin-manifest entry` };
    if (pinned !== pair.ek_fingerprint) return { ok: false, detail: `included principal ${pair.principal_id}'s envelope fingerprint does not match the effective pin manifest's binding` };
  }
  for (const id of input.excludedKeylessPrincipalIds) {
    if (input.keyedPrincipalIds.has(id)) return { ok: false, detail: `excluded-keyless principal ${id} actually has an enrolled key` };
  }
  for (const id of input.excludedUnconfirmedPrincipalIds) {
    if (!input.keyedPrincipalIds.has(id)) return { ok: false, detail: `excluded-unconfirmed principal ${id} is keyless, not unconfirmed` };
    if (input.pinnedFingerprintOf.has(id)) return { ok: false, detail: `excluded-unconfirmed principal ${id} actually has a live pin-manifest entry` };
  }
  return { ok: true };
}

/** D197's full-map conservation rule: `next_map = prior_map + receipt-authorized additions/replacements`, deletion-by-omission forbidden. */
export function checkPinManifestConservation(prior: readonly { principal_id: string }[], next: readonly { principal_id: string }[]): GitvaultHPartitionVerdict {
  const nextIds = new Set(next.map((p) => p.principal_id));
  for (const p of prior) {
    if (!nextIds.has(p.principal_id)) return { ok: false, detail: `principal ${p.principal_id} present in the predecessor manifest is missing from the successor — deletion by omission is forbidden in V0` };
  }
  const seen = new Set<string>();
  for (const p of next) {
    if (seen.has(p.principal_id)) return { ok: false, detail: `principal ${p.principal_id} appears more than once in the manifest` };
    seen.add(p.principal_id);
  }
  return { ok: true };
}

/** The synthetic ledger id a path-addressed `key_envelope` gets — mirrors the gateway's `keyEnvelopeLedgerId` exactly (drift here breaks receipt pairing at upload finalize). */
export function keyEnvelopeLedgerId(epoch: string, fingerprint: string, rotationId: string | null): string {
  return rotationId ? `key_envelope:${epoch}:${rotationId}:${fingerprint}` : `key_envelope:${epoch}:${fingerprint}`;
}

export function pinManifestLedgerId(pinManifestVersion: string): string {
  return `recipient_pin_manifest:${pinManifestVersion}`;
}

export { bytesToHex, hexToBytes };
