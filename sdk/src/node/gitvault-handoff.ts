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
import { base64 } from "@scure/base";
import { LocalError } from "../errors.js";
import {
  _gitvaultAeadBackend,
  fromBase64url,
  randomBytes,
  toBase64url,
  GITVAULT_FORMAT,
  GITVAULT_SUITE,
  GITVAULT_HEX16_RE,
  GITVAULT_SHA256_RE,
  signaturePreimage,
  ed25519Sign,
  ed25519PublicKey,
  ed25519VerifyStrict,
  vkFingerprint,
  ekFingerprint,
} from "../namespaces/gitvault.crypto.js";
// add-room-invite design D2: the pure key-format primitives (the registry,
// uuidToBytes, assemble/parse, the HKDF derive) moved to
// `bearer-claim-key.ts` — a move, not a copy — so the room kind (`kri1_`)
// can share them without teaching THIS vault-shaped module a room-shaped
// kind. Every symbol this module previously exported is re-exported here
// under its existing name, so nothing importing it changes.
import {
  type ClaimKind,
  type HandoffKeyPrefixEntry,
  type ClaimKeyParts,
  type HandoffKeyParts,
  type InviteKeyParts,
  type HandoffSecrets,
  HANDOFF_KEY_PREFIXES,
  uuidToBytes,
  assembleHandoffKey,
  assembleInviteKey,
  parseClaimKey,
  parseHandoffKey,
  parseInviteKey,
  deriveHandoffSecrets,
  deriveInviteSecrets,
} from "./bearer-claim-key.js";

export {
  HANDOFF_KEY_PREFIXES,
  uuidToBytes,
  assembleHandoffKey,
  assembleInviteKey,
  parseClaimKey,
  parseHandoffKey,
  parseInviteKey,
  deriveHandoffSecrets,
  deriveInviteSecrets,
};
export type { ClaimKind, HandoffKeyPrefixEntry, ClaimKeyParts, HandoffKeyParts, InviteKeyParts, HandoffSecrets };

function fail(code: string, message: string, context: string, details?: unknown): never {
  throw new LocalError(message, context, { code, details });
}

// `HANDOFF_KEY_PREFIXES[0]`/`[1]` — the vault kinds, which (unlike the room
// kind at `[2]`) always carry `envelopeKind`/`noteSchema`/`frameMagic`; this
// narrowing is what lets `sealClaimEnvelope`/`openClaimEnvelope` below keep
// those fields required without widening the shared registry's own type.
type VaultClaimKeyEntry = HandoffKeyPrefixEntry & { envelopeKind: string; noteSchema: string; frameMagic: string };
const HANDOFF_ENTRY = HANDOFF_KEY_PREFIXES[0] as VaultClaimKeyEntry;
const INVITE_ENTRY = HANDOFF_KEY_PREFIXES[1] as VaultClaimKeyEntry;

// ─── Writer-admission grant + acceptance (gitvault-multi-writer D4/§4.17) ───
//
// The bearer-completable path for `add_writer_key{authorization.kind:
// "handoff"}` — an unknown-at-mint, possibly-sender-gone recipient becomes a
// vault WRITER (not just a K_repo holder) via a sender-signed grant plus the
// claimant's own two-signature acceptance. Reuses ONLY existing primitives:
// `signaturePreimage`/`ed25519Sign`/`ed25519VerifyStrict`/`vkFingerprint`/
// `ekFingerprint` from `gitvault.crypto.ts` — the SAME "r402s/v0/<kind>\n" +
// JCS(object minus signature) preimage rule every other chain object uses
// (protocol §1), NOT a bespoke construction. Verified against the gateway's
// OWN `services/gitvault/claims.ts` (not just the protocol prose, which
// describes the acceptance statement's preimage as `lp(domain) ‖
// JCS(statement)` — that text is stale; the shipped gateway code calls its
// own `signaturePreimage("handoff-writer-accept/v1", acceptance.statement)`,
// the identical convention used here).

/**
 * Third HKDF output of a claim key's `master_secret` (design D4, protocol
 * §4.17; kind-parameterized by kygit-invite design D3): the one-use
 * admission Ed25519 seed. Derived directly from `master_secret` —
 * deliberately NEVER from `auth_secret` or `wrap_key` — so the gateway,
 * which receives `auth_secret` at claim, stays computationally unable to
 * derive this seed and manufacture a different claimant completion. The info
 * string is domain-separated by kind (`kygit/<kind>/writer-admission/v1`),
 * so an invite's admission seed never matches a handoff's for the same id
 * and master secret.
 */
export function deriveClaimWriterAdmissionSeed(kind: ClaimKind, idBytes: Uint8Array, masterSecret: Uint8Array): Uint8Array {
  return hkdf(sha256, masterSecret, idBytes, utf8ToBytes(`kygit/${kind}/writer-admission/v1`), 32);
}

/** Handoff-bound alias of {@link deriveClaimWriterAdmissionSeed} — `kygit/handoff/writer-admission/v1`. */
export function deriveWriterAdmissionSeed(handoffIdBytes: Uint8Array, masterSecret: Uint8Array): Uint8Array {
  return deriveClaimWriterAdmissionSeed("handoff", handoffIdBytes, masterSecret);
}

/** The invite-kind sibling of {@link deriveWriterAdmissionSeed} — `kygit/invite/writer-admission/v1` (kygit-invite design D3). */
export function deriveInviteWriterAdmissionSeed(inviteIdBytes: Uint8Array, masterSecret: Uint8Array): Uint8Array {
  return deriveClaimWriterAdmissionSeed("invite", inviteIdBytes, masterSecret);
}

export type GitvaultWriterMintedRole = "owner" | "admin" | "developer" | "billing" | "viewer";
const WRITER_MINTED_ROLES: readonly GitvaultWriterMintedRole[] = ["owner", "admin", "developer", "billing", "viewer"];

/** Signed by the MINTING writer's own writer key, at handoff mint time. Never chain-stored directly — embedded verbatim inside an admitted `add_writer_key` transition's `authorization.kind:"handoff".grant` once consumed. */
export interface WriterAdmissionGrant {
  format: typeof GITVAULT_FORMAT;
  object_kind: "writer_admission_grant";
  suite: typeof GITVAULT_SUITE;
  repo_id: string;
  handoff_id: string;
  auth_hash: string;
  checkpoint_generation: string;
  checkpoint_head_sha256: string;
  grantor_writer_key_id: string;
  handoff_admission_pubkey: string;
  minted_role: GitvaultWriterMintedRole;
  claim_not_after: string;
  created_at: string;
  signature: string;
}

export interface BuildWriterAdmissionGrantInput {
  repo_id: string;
  handoff_id: string;
  /** The existing kygit-handoff `auth_hash` (from {@link deriveHandoffSecrets}), unrelated to this grant's own signature. */
  auth_hash: string;
  checkpoint_generation: string;
  checkpoint_head_sha256: string;
  minted_role: GitvaultWriterMintedRole;
  claim_not_after: string;
  created_at?: string;
  /** The MINTER's own existing active writer signing seed — NOT {@link deriveWriterAdmissionSeed}'s one-use seed, which belongs to the grant's `handoff_admission_pubkey` field, never to its signer. */
  grantor_signing_seed: Uint8Array;
  /** Raw 32-byte Ed25519 public key: `ed25519PublicKey(deriveWriterAdmissionSeed(...))`. */
  handoff_admission_pubkey: Uint8Array;
}

/** Mint side (D4): builds + signs `writer_admission_grant`. The gateway's own mint-time validation (grantor active + self-consistent, field equality) is server-side; this function only builds a well-formed, correctly-signed object. */
export function buildWriterAdmissionGrant(input: BuildWriterAdmissionGrantInput): WriterAdmissionGrant {
  if (!GITVAULT_SHA256_RE.test(input.auth_hash)) fail("VALIDATION_FAILED", "auth_hash must be 64 lowercase hex", "building writer_admission_grant", { field: "auth_hash" });
  if (!GITVAULT_HEX16_RE.test(input.checkpoint_generation)) fail("VALIDATION_FAILED", "checkpoint_generation must be 16 lowercase hex", "building writer_admission_grant", { field: "checkpoint_generation" });
  if (!GITVAULT_SHA256_RE.test(input.checkpoint_head_sha256)) fail("VALIDATION_FAILED", "checkpoint_head_sha256 must be 64 lowercase hex", "building writer_admission_grant", { field: "checkpoint_head_sha256" });
  if (!WRITER_MINTED_ROLES.includes(input.minted_role)) fail("VALIDATION_FAILED", "minted_role is not a recognized role", "building writer_admission_grant", { field: "minted_role" });
  const withoutSignature = {
    format: GITVAULT_FORMAT,
    object_kind: "writer_admission_grant" as const,
    suite: GITVAULT_SUITE,
    repo_id: input.repo_id,
    handoff_id: input.handoff_id,
    auth_hash: input.auth_hash,
    checkpoint_generation: input.checkpoint_generation,
    checkpoint_head_sha256: input.checkpoint_head_sha256,
    grantor_writer_key_id: vkFingerprint(ed25519PublicKey(input.grantor_signing_seed)),
    handoff_admission_pubkey: toBase64url(input.handoff_admission_pubkey),
    minted_role: input.minted_role,
    claim_not_after: input.claim_not_after,
    created_at: input.created_at ?? new Date().toISOString(),
  };
  const signature = toBase64url(ed25519Sign(signaturePreimage("writer_admission_grant", withoutSignature), input.grantor_signing_seed));
  return { ...withoutSignature, signature };
}

/**
 * Structural + signature verification of a `writer_admission_grant` against
 * the grantor's writer signing pubkey (raw bytes) — does NOT check chain
 * state (grantor active in the predecessor writer state, `handoff_id`
 * unconsumed). That is the caller's job: gateway-side at admission, or a
 * client-side pre-check before spending a grant it did not itself mint.
 */
export function verifyWriterAdmissionGrant(grant: WriterAdmissionGrant, grantorSigningPubkeyRaw: Uint8Array): boolean {
  if (grant.format !== GITVAULT_FORMAT || grant.object_kind !== "writer_admission_grant" || grant.suite !== GITVAULT_SUITE) return false;
  if (grant.grantor_writer_key_id !== vkFingerprint(grantorSigningPubkeyRaw)) return false;
  const { signature, ...withoutSignature } = grant;
  let sigBytes: Uint8Array;
  try {
    sigBytes = fromBase64url(signature, "writer_admission_grant.signature");
  } catch {
    return false;
  }
  return ed25519VerifyStrict(sigBytes, signaturePreimage("writer_admission_grant", withoutSignature), grantorSigningPubkeyRaw);
}

/** The statement `writer_acceptance` signs TWICE (design D225's fold of the consultation's separate `writer_key_proof` into a second signature over this same statement). */
export const HANDOFF_WRITER_ACCEPT_DOMAIN = "r402s/v0/handoff-writer-accept/v1" as const;
const HANDOFF_WRITER_ACCEPT_PREIMAGE_DOMAIN = "handoff-writer-accept/v1";

export interface HandoffWriterAcceptStatement {
  domain: typeof HANDOFF_WRITER_ACCEPT_DOMAIN;
  handoff_id: string;
  auth_hash: string;
  writer_key_id: string;
  signing_pubkey: string;
  encryption_pubkey: string;
  encryption_fingerprint: string;
}

/** ONE object, TWO signatures over the SAME statement: possession of the one-use admission capability (`acceptance_signature`) AND possession of the claimant's own permanent writer key (`possession_signature`). Never chain-stored directly — embedded verbatim inside an admitted `add_writer_key` transition's `authorization.kind:"handoff".acceptance` once consumed. */
export interface WriterAcceptance {
  statement: HandoffWriterAcceptStatement;
  acceptance_signature: string;
  possession_signature: string;
}

export interface BuildWriterAcceptanceInput {
  handoff_id: string;
  auth_hash: string;
  /** {@link deriveWriterAdmissionSeed}'s output — B derives it the SAME way A did, from its own copy of `master_secret`. */
  admission_seed: Uint8Array;
  /** The claimant's OWN permanent writer signing seed — becomes `writer_key_id`/`signing_pubkey` on the statement. */
  claimant_signing_seed: Uint8Array;
  claimant_encryption_pubkey_raw: Uint8Array;
}

/**
 * Claim side (D4): the claimant can construct BOTH signatures before ever
 * seeing the stored grant, since it already knows `handoff_id`, `auth_hash`
 * (recomputed exactly as the existing claim flow already does via
 * {@link deriveHandoffSecrets}), and its own keys.
 */
export function buildWriterAcceptance(input: BuildWriterAcceptanceInput): WriterAcceptance {
  if (!GITVAULT_SHA256_RE.test(input.auth_hash)) fail("VALIDATION_FAILED", "auth_hash must be 64 lowercase hex", "building writer_acceptance", { field: "auth_hash" });
  const signingPubkeyRaw = ed25519PublicKey(input.claimant_signing_seed);
  const statement: HandoffWriterAcceptStatement = {
    domain: HANDOFF_WRITER_ACCEPT_DOMAIN,
    handoff_id: input.handoff_id,
    auth_hash: input.auth_hash,
    writer_key_id: vkFingerprint(signingPubkeyRaw),
    signing_pubkey: toBase64url(signingPubkeyRaw),
    encryption_pubkey: toBase64url(input.claimant_encryption_pubkey_raw),
    encryption_fingerprint: ekFingerprint(input.claimant_encryption_pubkey_raw),
  };
  const preimage = signaturePreimage(HANDOFF_WRITER_ACCEPT_PREIMAGE_DOMAIN, statement as unknown as Record<string, unknown>);
  return {
    statement,
    acceptance_signature: toBase64url(ed25519Sign(preimage, input.admission_seed)),
    possession_signature: toBase64url(ed25519Sign(preimage, input.claimant_signing_seed)),
  };
}

/**
 * Verifies BOTH signatures over the SAME statement: `acceptance_signature`
 * under the grant's `handoff_admission_pubkey` (proves B legitimately
 * claimed THIS handoff), `possession_signature` under the statement's own
 * `signing_pubkey` (proves `writer_key_id`/`signing_pubkey` really belong
 * to whoever is submitting it, not a replayed statement about someone
 * else's key). Does not check `handoff_id`/`auth_hash` binding to a stored
 * grant, or single-use — those are the caller's job.
 */
export function verifyWriterAcceptance(acceptance: WriterAcceptance, admissionPubkeyRaw: Uint8Array): boolean {
  if (acceptance.statement.domain !== HANDOFF_WRITER_ACCEPT_DOMAIN) return false;
  let acceptanceSig: Uint8Array;
  let possessionSig: Uint8Array;
  let signingPubkey: Uint8Array;
  try {
    acceptanceSig = fromBase64url(acceptance.acceptance_signature, "writer_acceptance.acceptance_signature");
    possessionSig = fromBase64url(acceptance.possession_signature, "writer_acceptance.possession_signature");
    signingPubkey = fromBase64url(acceptance.statement.signing_pubkey, "writer_acceptance.statement.signing_pubkey");
  } catch {
    return false;
  }
  if (acceptance.statement.writer_key_id !== vkFingerprint(signingPubkey)) return false;
  const preimage = signaturePreimage(HANDOFF_WRITER_ACCEPT_PREIMAGE_DOMAIN, acceptance.statement as unknown as Record<string, unknown>);
  return ed25519VerifyStrict(acceptanceSig, preimage, admissionPubkeyRaw) && ed25519VerifyStrict(possessionSig, preimage, signingPubkey);
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
  /**
   * Every epoch key the minter holds (`epoch` → lowercase hex), so a handoff
   * minted after an epoch rotation lets the recipient open the pre-rotation
   * generations too. Optional: absent on an envelope minted before this
   * field existed, in which case `k_e_hex` for `epoch` is all the recipient
   * gets (a vault that never rotated needs nothing more).
   */
  epoch_keys?: Record<string, string>;
  checkpoint: { generation: string; commit_oid: string };
  note_schema: "kygit.handoff-note.v1";
}

/** Frame tag for the handoff envelope format — DISTINCT from `r402s/v0`'s `"R402S0"` object frame (design D3: never stored as a vault object). The LEGACY v1 tag: nothing seals it any more, but a pre-gitvault-multi-writer handoff row still carries one and {@link openHandoffEnvelope} still opens it. */
export const HANDOFF_ENVELOPE_KIND = "kygit-handoff-envelope-v1" as const;

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

/**
 * `sealed_envelope` on the wire is STANDARD base64 — openapi spells it
 * `format: byte` in both the mint body and the claim response, and the
 * gateway echoes the stored bytes with `Buffer#toString("base64")` (`+`,
 * `/`, `=` padding). Decoding it with the canonical-base64url-only
 * `fromBase64url`, which refuses every `+`/`/`/`=`, takes a 200 from the
 * gateway and dies client-side with `*_ENVELOPE_INVALID`. This decoder
 * reads the documented form and, for tolerance, the base64url form other
 * clients mint; padding is optional either way. Anything outside the two
 * alphabets is a refusal (`null` — the caller raises the typed
 * `*_ENVELOPE_INVALID`), never a silent partial decode. Shared by both
 * claim kinds: the invite routes encode exactly as the handoff routes do,
 * byte for byte, rather than "fixing" the alphabet on one side only
 * (kygit-invite design D3's cross-side trap).
 */
function decodeSealedEnvelope(value: string): Uint8Array | null {
  const trimmed = value.trim();
  if (trimmed.length === 0 || !/^[A-Za-z0-9+/_-]+={0,2}$/.test(trimmed)) return null;
  const unpadded = trimmed.replace(/=+$/, "").replace(/-/g, "+").replace(/_/g, "/");
  if (unpadded.length % 4 === 1) return null;
  try {
    return base64.decode(unpadded + "=".repeat((4 - (unpadded.length % 4)) % 4));
  } catch {
    return null;
  }
}

/**
 * Seal `payload` under `wrap_key` for `entry`'s kind, tagged `envelopeKind`.
 * Returns the standard-base64 wire form (openapi `format: byte`) + the tag.
 *
 * Plain JSON, NOT the r402s/v0 no-JSON-numbers JCS profile: this envelope is
 * never a vault object and only this SDK ever encodes/decodes it, so it
 * needs deterministic round-tripping, not cross-implementation
 * byte-canonical determinism (design D3's "the frozen protocol is
 * untouched" — reusing the object-frame profile here would be exactly the
 * kind of accidental protocol coupling that note warns against). Shared by
 * every claim kind and every envelope version (v1, v2, …) so the frame
 * byte-layout lives in exactly one place — a kind or version divergence here
 * would be invisible to either side until a cross-open failed.
 */
function sealClaimEnvelope(entry: VaultClaimKeyEntry, idBytes: Uint8Array, wrapKey: Uint8Array, payload: unknown, envelopeKind: string, nonce?: Uint8Array): { sealed_envelope: string; envelope_kind: string } {
  const plaintext = utf8ToBytes(JSON.stringify(payload));
  const n = nonce ?? randomBytes(CLAIM_NONCE_BYTES);
  if (n.length !== CLAIM_NONCE_BYTES) fail(`${entry.errorPrefix}_ENVELOPE_INVALID`, "nonce must be 24 bytes", `sealing ${entry.kind} envelope`);
  const aad = claimEnvelopeAad(idBytes, envelopeKind);
  const ct = claimAeadSeal(wrapKey, n, aad, plaintext);
  const frame = concatBytes(utf8ToBytes(entry.frameMagic), new Uint8Array([FRAME_VERSION_BYTE]), n, ct);
  return { sealed_envelope: base64.encode(frame), envelope_kind: envelopeKind };
}

/**
 * Decodes, header-checks, AEAD-opens, and JSON-parses a sealed envelope for
 * `entry`'s kind, returning the RAW parsed payload with no shape validation
 * (mirrors {@link sealClaimEnvelope} on the seal side) so the frame
 * byte-layout lives in exactly one place. Each envelope kind/version's own
 * `open*` function applies its OWN shape check on the result; this function
 * deliberately does not, since a shape check IS the version discriminator (a
 * v1 opener must reject a `v:2` payload, not silently accept it — that is
 * what makes `v` meaningful at all). Throws `${errorPrefix}_ENVELOPE_INVALID`
 * on any header mismatch and `${errorPrefix}_AEAD_AUTH_FAILURE` on a bad
 * key/AAD/ciphertext.
 */
function openClaimEnvelope(entry: VaultClaimKeyEntry, idBytes: Uint8Array, wrapKey: Uint8Array, sealedEnvelope: string, envelopeKind: string): unknown {
  const frame = decodeSealedEnvelope(sealedEnvelope);
  if (frame === null) {
    fail(`${entry.errorPrefix}_ENVELOPE_INVALID`, "sealed_envelope is not valid base64", `opening ${entry.kind} envelope`);
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

/** Seal the handoff payload under `wrap_key` as a LEGACY v1 envelope. Returns the standard-base64 wire form (openapi `format: byte`) + its declared kind tag. Nothing in the shipped flow calls this any more — {@link sealHandoffEnvelopeV2} is what `handoff` seals — but the v1 shape stays openable and sealable for the conformance vectors. */
export function sealHandoffEnvelope(handoffIdBytes: Uint8Array, wrapKey: Uint8Array, payload: HandoffEnvelopePayload, nonce?: Uint8Array): { sealed_envelope: string; envelope_kind: string } {
  return sealClaimEnvelope(HANDOFF_ENTRY, handoffIdBytes, wrapKey, payload, HANDOFF_ENVELOPE_KIND, nonce);
}

/** Open a sealed handoff envelope under `wrap_key` (standard base64 as the claim response carries it, or base64url). Throws `HANDOFF_ENVELOPE_INVALID` on any header mismatch, a `v:2` (or otherwise non-v1) payload shape, and `HANDOFF_AEAD_AUTH_FAILURE` on a bad key/AAD/ciphertext. */
export function openHandoffEnvelope(handoffIdBytes: Uint8Array, wrapKey: Uint8Array, sealedEnvelope: string, envelopeKind: string = HANDOFF_ENVELOPE_KIND): HandoffEnvelopePayload {
  const p = openClaimEnvelope(HANDOFF_ENTRY, handoffIdBytes, wrapKey, sealedEnvelope, envelopeKind) as Partial<HandoffEnvelopePayload>;
  if (p.v !== 1 || p.kind !== "handoff" || typeof p.repo_id !== "string" || typeof p.epoch !== "string" || typeof p.k_e_hex !== "string" || !p.checkpoint || p.note_schema !== "kygit.handoff-note.v1") {
    fail("HANDOFF_ENVELOPE_INVALID", "opened envelope does not match the kygit.handoff-note.v1 payload shape", "opening handoff envelope");
  }
  return p as HandoffEnvelopePayload;
}

// ─── Envelope v2 (gitvault-multi-writer D4/§4.17; kygit-invite design D3) ───
//
// `writer_admission_grant_sha256` is what makes v2 v2 — design D4's "no hash
// cycle: grant first, then seal": the minter builds + signs
// {@link WriterAdmissionGrant} FIRST, hashes its stored bytes SECOND, and
// only THEN seals this envelope carrying that hash. The claimant
// cross-checks it against the grant the gateway independently returns at
// claim, an integrity binding entirely independent of anything the gateway
// could tamper with (the envelope's AEAD authenticity comes from `wrap_key`,
// which the gateway never holds). BOTH claim kinds seal v2 — an invite has
// no v1 at all, and a handoff's v1 survives only as a legacy opener.

/** The v2 envelope kind the handoff mint seals. */
export const HANDOFF_ENVELOPE_V2_KIND = "kygit-handoff-envelope-v2" as const;
/** The v2 envelope kind the invite mint seals (kygit-invite design D3) — its own tag, never confusable with the handoff one even for the same id. */
export const INVITE_ENVELOPE_V2_KIND = "kygit-invite-envelope-v2" as const;

/**
 * `v: 2` (NOT 1) is the payload's own shape discriminator, independent of
 * `envelope_kind` — a v1 opener's `p.v !== 1` shape check therefore refuses
 * a v2 payload outright (`HANDOFF_ENVELOPE_INVALID`) rather than silently
 * misreading it as v1; `v` and `envelope_kind` agreeing is exactly what
 * makes either one a meaningful, non-spoofable version signal.
 */
export interface HandoffEnvelopePayloadV2 extends Omit<HandoffEnvelopePayload, "v"> {
  v: 2;
  writer_admission_grant_sha256: string;
}

/** The invite-kind sibling of {@link HandoffEnvelopePayloadV2} — identical shape but for its `kind`/`note_schema` tags (kygit-invite design D3: "the payload is otherwise identical to the handoff envelope — the room does NOT ride in the envelope"). */
export interface InviteEnvelopePayloadV2 extends Omit<HandoffEnvelopePayloadV2, "kind" | "note_schema"> {
  kind: "invite";
  note_schema: "kygit.invite-note.v1";
}

/** Seal a v2 handoff envelope — identical framing to {@link sealHandoffEnvelope}, tagged `kygit-handoff-envelope-v2` so its AAD (and therefore its ciphertext) is never confusable with a v1 envelope of the same handoff. */
export function sealHandoffEnvelopeV2(handoffIdBytes: Uint8Array, wrapKey: Uint8Array, payload: HandoffEnvelopePayloadV2, nonce?: Uint8Array): { sealed_envelope: string; envelope_kind: string } {
  if (!GITVAULT_SHA256_RE.test(payload.writer_admission_grant_sha256)) {
    fail("VALIDATION_FAILED", "writer_admission_grant_sha256 must be 64 lowercase hex", "sealing handoff envelope v2", { field: "writer_admission_grant_sha256" });
  }
  return sealClaimEnvelope(HANDOFF_ENTRY, handoffIdBytes, wrapKey, payload, HANDOFF_ENVELOPE_V2_KIND, nonce);
}

/** The invite-kind sibling of {@link sealHandoffEnvelopeV2} — the ONLY invite envelope there is (kygit-invite design D3). */
export function sealInviteEnvelope(inviteIdBytes: Uint8Array, wrapKey: Uint8Array, payload: InviteEnvelopePayloadV2, nonce?: Uint8Array): { sealed_envelope: string; envelope_kind: string } {
  if (!GITVAULT_SHA256_RE.test(payload.writer_admission_grant_sha256)) {
    fail("VALIDATION_FAILED", "writer_admission_grant_sha256 must be 64 lowercase hex", "sealing invite envelope", { field: "writer_admission_grant_sha256" });
  }
  return sealClaimEnvelope(INVITE_ENTRY, inviteIdBytes, wrapKey, payload, INVITE_ENVELOPE_V2_KIND, nonce);
}

/**
 * Open a v2 envelope for a writer-activation flow. Refuses a v1 (or any
 * other non-v2) `envelope_kind` LOCALLY with `HANDOFF_ENVELOPE_UNSUPPORTED`
 * BEFORE attempting to decrypt anything — post-gitvault-multi-writer, a
 * writer-activation-aware `resume` needs `writer_admission_grant_sha256` to
 * cross-check the returned grant, and a pre-rev-47 v1 envelope structurally
 * has none. Shares ONLY the frame/AEAD-opening step with
 * {@link openHandoffEnvelope} ({@link openClaimEnvelope}) — NOT that
 * function itself, since its `v !== 1` shape check would (correctly) refuse
 * a v2 payload; this function applies its own `v !== 2` shape check
 * instead. Callers that only need K_repo/checkpoint delivery, with no
 * writer activation, keep using {@link openHandoffEnvelope} against a v1
 * envelope as before — v1 and v2 are NOT interchangeable at the shape
 * layer, by design.
 */
export function openHandoffEnvelopeV2(handoffIdBytes: Uint8Array, wrapKey: Uint8Array, sealedEnvelope: string, envelopeKind: string): HandoffEnvelopePayloadV2 {
  if (envelopeKind !== HANDOFF_ENVELOPE_V2_KIND) {
    fail(
      "HANDOFF_ENVELOPE_UNSUPPORTED",
      `this handoff's envelope is ${envelopeKind ? `\`${envelopeKind}\`` : "of an unrecognized kind"}, not \`${HANDOFF_ENVELOPE_V2_KIND}\` — writer activation needs the v2 envelope's writer_admission_grant_sha256, which a pre-gitvault-multi-writer handoff never carries`,
      "opening handoff envelope for writer activation",
      { received: envelopeKind, required: HANDOFF_ENVELOPE_V2_KIND },
    );
  }
  const p = openClaimEnvelope(HANDOFF_ENTRY, handoffIdBytes, wrapKey, sealedEnvelope, envelopeKind) as Partial<HandoffEnvelopePayloadV2>;
  if (
    p.v !== 2 ||
    p.kind !== "handoff" ||
    typeof p.repo_id !== "string" ||
    typeof p.epoch !== "string" ||
    typeof p.k_e_hex !== "string" ||
    !p.checkpoint ||
    p.note_schema !== "kygit.handoff-note.v1" ||
    typeof p.writer_admission_grant_sha256 !== "string" ||
    !GITVAULT_SHA256_RE.test(p.writer_admission_grant_sha256)
  ) {
    fail("HANDOFF_ENVELOPE_INVALID", "opened envelope does not match the v2 kygit.handoff-note.v1 payload shape", "opening handoff envelope for writer activation");
  }
  return p as HandoffEnvelopePayloadV2;
}

/** The invite-kind sibling of {@link openHandoffEnvelopeV2} — throws `INVITE_ENVELOPE_UNSUPPORTED` / `INVITE_ENVELOPE_INVALID` / `INVITE_AEAD_AUTH_FAILURE` (kygit-invite design D3). */
export function openInviteEnvelope(inviteIdBytes: Uint8Array, wrapKey: Uint8Array, sealedEnvelope: string, envelopeKind: string = INVITE_ENVELOPE_V2_KIND): InviteEnvelopePayloadV2 {
  if (envelopeKind !== INVITE_ENVELOPE_V2_KIND) {
    fail(
      "INVITE_ENVELOPE_UNSUPPORTED",
      `this invite's envelope is ${envelopeKind ? `\`${envelopeKind}\`` : "of an unrecognized kind"}, not \`${INVITE_ENVELOPE_V2_KIND}\``,
      "opening invite envelope",
      { received: envelopeKind, required: INVITE_ENVELOPE_V2_KIND },
    );
  }
  const p = openClaimEnvelope(INVITE_ENTRY, inviteIdBytes, wrapKey, sealedEnvelope, envelopeKind) as Partial<InviteEnvelopePayloadV2>;
  if (
    p.v !== 2 ||
    p.kind !== "invite" ||
    typeof p.repo_id !== "string" ||
    typeof p.epoch !== "string" ||
    typeof p.k_e_hex !== "string" ||
    !p.checkpoint ||
    p.note_schema !== "kygit.invite-note.v1" ||
    typeof p.writer_admission_grant_sha256 !== "string" ||
    !GITVAULT_SHA256_RE.test(p.writer_admission_grant_sha256)
  ) {
    fail("INVITE_ENVELOPE_INVALID", "opened envelope does not match the v2 kygit.invite-note.v1 payload shape", "opening invite envelope");
  }
  return p as InviteEnvelopePayloadV2;
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
