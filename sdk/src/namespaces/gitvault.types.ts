/**
 * gitvault — `r402s/v0` wire types (protocol rev 40).
 *
 * Every object here mirrors a frozen JSON Schema under the private repo's
 * `docs/strategy/products/gitvault/schemas/` (`key_envelope.json`,
 * `vault_genesis.json`, `allocation.json`, `recovery_receipt.json`,
 * `capture_receipt.json`, `head.json`, `common.json`). Field names are the
 * wire names (snake_case); values are STRINGS everywhere — the `r402s/v0`
 * profile forbids JSON numbers (sizes, generations, and epochs are fixed-width
 * decimal / hex strings).
 *
 * Scalar grammars (from `common.json`): `hex16` = exactly 16 lowercase hex;
 * `hex32` = 32; `sha256` = 64; base64url values are unpadded and canonical
 * (32 bytes = 43 chars, 64 bytes = 86 chars, the HPKE-sealed K_repo = 64
 * chars / 48 bytes); timestamps are RFC 3339 UTC with millisecond precision
 * and a trailing `Z`.
 */

/** `format` const on every `r402s/v0` object. */
export type GitvaultFormat = "r402s/v0";
/** `suite` const on every `r402s/v0` object. */
export type GitvaultSuite = "r402s-1";

/** The closed `object_kind` vocabulary this module handles (protocol §1 table). */
export type GitvaultObjectKind =
  | "vault_genesis"
  | "head"
  | "ref_state"
  | "retention_roots"
  | "wal_pack"
  | "checkpoint_pack"
  | "checkpoint_manifest"
  | "checkpoint_claim_set"
  | "maintenance_stage_claim_set"
  | "maintenance_stage_page"
  | "key_envelope"
  | "recovery_receipt"
  | "allocation"
  | "capture_receipt"
  | "admission_record"
  | "activation_token"
  | "retention_cutoff"
  | "prune_intent_core"
  | "prune_intent"
  | "prune_completion"
  | "verifier_receipt"
  | "maintenance_cycle_terminal"
  | "maintenance_cycle_issuance"
  | "maintenance_completion_cut"
  | "service_key_registry"
  | "rotation_attempt_descriptor"
  | "recipient_pin_manifest"
  | "recipient_confirmation_receipt"
  | "recipient_open_receipt"
  /** gitvault-multi-writer rev 47 (protocol §4.17) — a writer's signed grant authorizing a handoff recipient to become a vault writer. */
  | "writer_admission_grant";

/** Kinds whose stored bytes are an AEAD frame (protocol §2 framing), keyed by `k_obj`. */
export type GitvaultEncryptedObjectKind =
  | "wal_pack"
  | "ref_state"
  | "retention_roots"
  | "checkpoint_manifest"
  | "checkpoint_pack";

/**
 * The `K_digest` labels of protocol §1 (keyed-digest derivation) — the
 * original five, keyed by `K_repo`, plus the three rev-42 labels (D195/D198/
 * D200) keyed by the SAMPLED epoch key (`K_e`/`K_1`) instead.
 */
export type GitvaultDigestLabel =
  | "refmap"
  | "rootset"
  | "objectset"
  | "snapshot_oid"
  | "gcrootset"
  | "epoch_rotation"
  | "epoch_rotation_attempt"
  | "vault_genesis_epoch_key";

/** `key_envelope` (schema `key_envelope.json`) — path-addressed by `(repo_id, epoch, recipient_fingerprint)`; no `object_id`. */
export interface GitvaultKeyEnvelope {
  format: GitvaultFormat;
  object_kind: "key_envelope";
  suite: GitvaultSuite;
  /** `src_` + 32 lowercase hex. */
  repo_id: string;
  /** 16 lowercase hex. */
  epoch: string;
  recipient_kind: "principal";
  /** `ek_` + 32 lowercase hex — first 16 bytes of SHA-256(raw X25519 pubkey). */
  recipient_fingerprint: string;
  /** HPKE `enc` — the 32-byte ephemeral X25519 public key, base64url (43 chars). */
  enc: string;
  /** HPKE-sealed raw 32-byte K_repo — 48 bytes, base64url (64 chars). */
  ct: string;
  /** The creator's `vk_` fingerprint, exactly as signed (also the 4th HPKE `info` component). */
  created_by: string;
  /** RFC 3339 UTC ms `Z`. */
  created_at: string;
  /**
   * D195/D203, rev 42: schema-optional, ADDED to `properties` (pure
   * widening — every existing envelope, which never set this field, stays
   * valid unamended). PRESENT-non-null for a rotation-attempt envelope
   * (widens the storage path to `(repo_id, epoch, rotation_id,
   * recipient_fingerprint)` and the HPKE AAD to the five-field form);
   * ABSENT — never explicit `null` — for a genesis/ADD-workaround envelope.
   */
  rotation_id?: string;
  /** Ed25519, base64url (86 chars), domain `key_envelope`. */
  signature: string;
}

/** The envelope receipt embedded in `vault_genesis.envelopes[]` / `rotate_epoch_payload.envelopes[]` (`common.json#/$defs/receipt_key_envelope`). */
export interface GitvaultKeyEnvelopeReceipt {
  object_kind: "key_envelope";
  epoch: string;
  recipient_fingerprint: string;
  /** SHA-256 over the envelope's stored bytes (JCS INCLUDING `signature`). */
  stored_bytes_sha256: string;
  /** Decimal string — the stored bytes' length. */
  size_bytes: string;
  /** D195, rev 42 — see {@link GitvaultKeyEnvelope.rotation_id}. */
  rotation_id?: string;
}

/** One `{principal_id, envelope}` pair in `rotate_epoch_payload.envelopes[]` / an N-recipient `vault_genesis.envelopes[]` (D196, rev 42). */
export interface GitvaultRotationEnvelopePair {
  principal_id: string;
  envelope: GitvaultKeyEnvelopeReceipt;
}

/** `vault_genesis` (schema `vault_genesis.json`) — generation 0, epoch pinned to `0000000000000001`. */
export interface GitvaultVaultGenesis {
  format: GitvaultFormat;
  object_kind: "vault_genesis";
  suite: GitvaultSuite;
  repo_id: string;
  org_id: string;
  project_id: string;
  /** 32 lowercase hex — from the allocation. */
  allocation_nonce: string;
  generation: "0000000000000000";
  epoch: "0000000000000001";
  git_object_format: "sha1";
  /** Ed25519 raw pubkey, base64url (43 chars). */
  creator_signing_pubkey: string;
  /** X25519 raw pubkey, base64url (43 chars). */
  creator_encryption_pubkey: string;
  /**
   * Exactly one envelope in the shape THIS SDK still builds (single-recipient
   * genesis, byte-identical to rev 41). D198 (rev 42) widens the SCHEMA to
   * `minItems:1..MAX_EPOCH_ROTATION_ENVELOPES` with each item a
   * `{principal_id, envelope}` pair for a genesis admitted under rev-42+
   * code — reading a pre-existing bare-shape genesis stays supported
   * (protocol-v0.md's grandfathering paragraph on §4.2); this SDK does not
   * yet BUILD an N-recipient genesis (a separate, un-scoped follow-up), so
   * this field stays typed as the bare receipt array here.
   */
  envelopes: GitvaultKeyEnvelopeReceipt[];
  /** `vk_` fingerprint of `creator_signing_pubkey`. */
  writer_key_id: string;
  /**
   * D198, rev 42: the genesis's own initial `recipient_pin_manifest`,
   * claimed atomically in the same admission — required whenever
   * `envelopes` carries more than the creator's own. Absent on every
   * existing rev-41 genesis and on the single-recipient shape this SDK
   * still builds.
   */
  pin_manifest?: GitvaultPinManifestReceipt;
  created_at: string;
  signature: string;
}

/** `allocation` (schema `allocation.json`) — control-plane-signed API message; no `object_id`. */
export interface GitvaultAllocation {
  format: GitvaultFormat;
  object_kind: "allocation";
  suite: GitvaultSuite;
  repo_id: string;
  /** `sk_` + 4–64 of `[0-9a-z-]` — the signing service key (resolved through the registry). */
  service_key_id: string;
  org_id: string;
  project_id: string;
  principal_id: string;
  creator_signing_fingerprint: string;
  creator_encryption_fingerprint: string;
  /** 32 lowercase hex — the client's idempotency key for allocation. */
  client_creation_id: string;
  allocation_nonce: string;
  /** 16 lowercase hex — incremented on owner reclaim. */
  allocation_generation: string;
  /** `superseded` = reclaimed; a client holding it MUST NOT resume. */
  status: "active" | "superseded";
  /** Authority-time instant of THIS representation (fresh on republication). */
  issued_at: string;
  /** Immutable creation metadata. */
  created_at: string;
  signature: string;
}

/** `recovery_receipt` (schema `recovery_receipt.json`) — creator-signed integrity data, never a secret. */
export interface GitvaultRecoveryReceipt {
  format: GitvaultFormat;
  object_kind: "recovery_receipt";
  suite: GitvaultSuite;
  repo_id: string;
  org_id: string;
  project_id: string;
  /** Stored-bytes hash of the admitted `vault_genesis`. */
  genesis_sha256: string;
  creator_signing_fingerprint: string;
  creator_encryption_fingerprint: string;
  signature: string;
}

/** `capture_receipt` (schema `capture_receipt.json`) — control-plane-signed API message; no `object_id`. */
export interface GitvaultCaptureReceipt {
  format: GitvaultFormat;
  object_kind: "capture_receipt";
  suite: GitvaultSuite;
  repo_id: string;
  service_key_id: string;
  generation: string;
  head_sha256: string;
  capture_id: string;
  apply_plan_sha256: string | null;
  snapshot_oid_hmac: string;
  admission_record_sha256: string;
  issued_at: string;
  effective_admitted_at: string;
  /** 32 lowercase hex — the epoch AT ISSUANCE. */
  authorization_epoch: string;
  signature: string;
}

/** `common.json#/$defs/receipt_wal_pack`. */
export interface GitvaultWalPackReceipt {
  object_id: string;
  object_kind: "wal_pack";
  ciphertext_sha256: string;
  size_bytes: string;
  base_generation: string;
}

/** `common.json#/$defs/receipt_ref_state`. */
export interface GitvaultRefStateReceipt {
  object_id: string;
  object_kind: "ref_state";
  ciphertext_sha256: string;
  size_bytes: string;
}

/** `common.json#/$defs/receipt_retention_roots`. */
export interface GitvaultRetentionRootsReceipt {
  object_id: string;
  object_kind: "retention_roots";
  ciphertext_sha256: string;
  size_bytes: string;
}

/** `common.json#/$defs/capture_binding`. */
export interface GitvaultCaptureBinding {
  capture_id: string;
  apply_plan_sha256: string | null;
  snapshot_oid_hmac: string;
}

/** `common.json#/$defs/repair_descriptor`. */
export interface GitvaultRepairDescriptor {
  base_generation: string;
  base_head_sha256: string;
  supersedes_from: string;
  supersedes_through: string;
  reason: "missing_referenced_object" | "corrupt_referenced_object" | "unusable_ref_state";
}

/** `common.json#/$defs/transition_envelope` — validated fail-closed by later tasks; carried opaque here. */
export interface GitvaultTransitionEnvelope {
  kind: "add_envelope" | "rotate_epoch" | "add_writer_key" | "transfer_binding";
  payload_format: "base64url-jcs";
  payload: string;
  payload_sha256: string;
}

/** `common.json#/$defs/receipt_checkpoint_manifest`. */
export interface GitvaultCheckpointManifestReceipt {
  object_id: string;
  object_kind: "checkpoint_manifest";
  ciphertext_sha256: string;
  size_bytes: string;
}

/** `common.json#/$defs/receipt_checkpoint_pack`. */
export interface GitvaultCheckpointPackReceipt {
  object_id: string;
  object_kind: "checkpoint_pack";
  ciphertext_sha256: string;
  size_bytes: string;
}

/** `common.json#/$defs/receipt_checkpoint_claim_set` — plaintext-structured kinds are receipted by `stored_bytes_sha256`. */
export interface GitvaultCheckpointClaimSetReceipt {
  object_id: string;
  object_kind: "checkpoint_claim_set";
  stored_bytes_sha256: string;
  size_bytes: string;
}

/** `common.json#/$defs/receipt_retention_cutoff`. */
export interface GitvaultRetentionCutoffReceipt {
  object_id: string;
  object_kind: "retention_cutoff";
  stored_bytes_sha256: string;
  size_bytes: string;
}

/** `common.json#/$defs/checkpoint_block` — the head's checkpoint slot (§4.7). */
export interface GitvaultCheckpointBlock {
  claim_set: GitvaultCheckpointClaimSetReceipt;
  /** == the carrying head's generation. */
  covers_through_generation: string;
  git_object_format: "sha1";
  /** The cutoff-ticket binding; `null` in the no-removal form. */
  cutoff: { ticket: GitvaultRetentionCutoffReceipt; cutoff_at: string } | null;
}

/** `common.json#/$defs/head_target` — a discriminated union, never a null (§4.4). */
export type GitvaultHeadTarget =
  | { kind: "symref"; ref: string }
  | { kind: "detached"; oid: string };

/** `ref_state` plaintext (schema `ref_state.json`) — encrypted at rest. */
export interface GitvaultRefState {
  format: GitvaultFormat;
  object_kind: "ref_state";
  suite: GitvaultSuite;
  repo_id: string;
  /** `refs_` + 32 hex. */
  object_id: string;
  generation: string;
  /** Canonical refname → 40-hex oid; ≤ 10 000 entries. */
  refs: Record<string, string>;
  head_target: GitvaultHeadTarget;
  signature: string;
}

/** One retention root: a dropped/force-displaced tip (§4.5), map-keyed `(ref, oid)`. */
export interface GitvaultRetentionRoot {
  ref: string;
  oid: string;
  dropped_at_generation: string;
}

/** `retention_roots` plaintext (schema `retention_roots.json`) — encrypted at rest. */
export interface GitvaultRetentionRoots {
  format: GitvaultFormat;
  object_kind: "retention_roots";
  suite: GitvaultSuite;
  repo_id: string;
  /** `rr_` + 32 hex. */
  object_id: string;
  generation: string;
  cutoff: { cutoff_ticket_sha256: string; cutoff_at: string } | null;
  /** Sorted by (dropped_at_generation, ref, oid); ≤ 50 000. */
  roots: GitvaultRetentionRoot[];
  signature: string;
}

/** One `checkpoint_manifest.packs[]` entry — BOTH representations (§4.1). */
export interface GitvaultCheckpointManifestPack {
  object_id: string;
  plaintext_sha256: string;
  plaintext_size_bytes: string;
  ciphertext_sha256: string;
  size_bytes: string;
}

/** `checkpoint_manifest` plaintext (schema `checkpoint_manifest.json`) — encrypted at rest. */
export interface GitvaultCheckpointManifest {
  format: GitvaultFormat;
  object_kind: "checkpoint_manifest";
  suite: GitvaultSuite;
  repo_id: string;
  /** `chk_` + 32 hex. */
  object_id: string;
  covers_through_generation: string;
  git_object_format: "sha1";
  packs: GitvaultCheckpointManifestPack[];
  /** Σ packs[i].plaintext_size_bytes (the manifest itself excluded). */
  total_plaintext_size_bytes: string;
  ref_state_hmac: string;
  retention_roots_hmac: string;
  object_set_hmac: string;
  signature: string;
}

/** `checkpoint_claim_set` (schema `checkpoint_claim_set.json`) — plaintext-structured, owner-signed, stored at `checkpoints/<ccs_id>.claims.json`. */
export interface GitvaultCheckpointClaimSet {
  format: GitvaultFormat;
  object_kind: "checkpoint_claim_set";
  suite: GitvaultSuite;
  repo_id: string;
  /** `ccs_` + 32 hex. */
  object_id: string;
  manifest_receipt: GitvaultCheckpointManifestReceipt;
  ordered_pack_receipts: GitvaultCheckpointPackReceipt[];
  /** manifest_receipt.size_bytes + Σ pack size_bytes (the claim set itself excluded). */
  total_stored_size_bytes: string;
  covers_through_generation: string;
  writer_key_id: string;
  signature: string;
}

/** `retention_cutoff` (schema `retention_cutoff.json`) — control-plane-signed clock attestation, stored at `retention/<rc_id>.ticket.json`. */
export interface GitvaultRetentionCutoff {
  format: GitvaultFormat;
  object_kind: "retention_cutoff";
  suite: GitvaultSuite;
  repo_id: string;
  /** `rc_` + 32 hex. */
  object_id: string;
  service_key_id: string;
  base_head_sha256: string;
  /** SERVER-AUTHORITATIVE. */
  cutoff_at: string;
  expires_at: string;
  authorization_epoch: string;
  signature: string;
}

/** `activation_token` (schema `activation_token.json`) — minted by token exchange, consumed at apply activation (§4.10). */
export interface GitvaultActivationToken {
  format: GitvaultFormat;
  object_kind: "activation_token";
  suite: GitvaultSuite;
  repo_id: string;
  /** `ct_` + 32 hex. */
  object_id: string;
  service_key_id: string;
  operation_id: string;
  generation: string;
  head_sha256: string;
  capture_id: string;
  /** Non-null by construction — no token is mintable from a null plan digest. */
  apply_plan_sha256: string;
  snapshot_oid_hmac: string;
  issued_at: string;
  authorization_epoch: string;
  signature: string;
}

/** One `ref_transaction.updates[]` entry (schema `ref_transaction.json`, §6.1). */
export interface GitvaultRefUpdate {
  ref: string;
  /** `null` ONLY for creation. */
  expected_old_oid: string | null;
  /** `null` = delete (requires a non-null `expected_old_oid`). */
  new_oid: string | null;
  /** Force-with-lease: skips ancestry but STILL requires `expected_old_oid`. */
  force: boolean;
}

/** `ref_transaction` (schema `ref_transaction.json`). */
export interface GitvaultRefTransaction {
  /** 1..1000 updates naming pairwise-distinct refs. */
  updates: GitvaultRefUpdate[];
}

/** The query of `GET /gitvault/v1/vaults/:vault_id/heads` (schema `heads_listing_request.json`, D186). */
export interface GitvaultHeadsListingRequest {
  /** The REQUIRED verification anchor — constant across one page sequence. */
  after_generation: string;
  /** The prior page's `next_cursor`, echoed UNCHANGED; omitted on the first request. */
  cursor?: string;
  /** REQUIRED; 1..1000, as a string. */
  limit: string;
}

/** One `heads_listing_page.heads[]` entry. */
export interface GitvaultHeadsListingEntry {
  generation: string;
  stored_bytes_sha256: string;
}

/** The ONE frozen response of the heads listing (schema `heads_listing_page.json`). */
export interface GitvaultHeadsListingPage {
  format: GitvaultFormat;
  repo_id: string;
  after_generation: string;
  heads: GitvaultHeadsListingEntry[];
  has_more: boolean;
  /** `has_more == false ⇒ null`; `has_more == true ⇒ a non-null opaque token`. */
  next_cursor: string | null;
  /** Exact or null, never a nearby number. */
  total: string | null;
}

/** `override_completion_request` (schema `override_completion_request.json`) — `POST …/override-completions`. */
export interface GitvaultOverrideCompletionRequest {
  operation_id: string;
  capture_receipt: GitvaultCaptureReceipt;
}

/**
 * `head` (schema `head.json`) — generations ≥ 1. Every member is typed; the
 * checkpoint block is the §4.7 claim-set binding.
 */
export interface GitvaultHead {
  format: GitvaultFormat;
  object_kind: "head";
  suite: GitvaultSuite;
  repo_id: string;
  generation: string;
  /** Stored-bytes hash of the predecessor (genesis for generation 1). */
  prev_sha256: string;
  /**
   * D194, rev 42: widened from the `"0000000000000001"` const to `hex16` —
   * equals the predecessor's `epoch` UNLESS this head admits a `rotate_epoch`
   * transition, in which case it equals `nextEpoch(predecessor.epoch)`
   * (increment-by-one, no skip).
   */
  epoch: string;
  wal_entries: GitvaultWalPackReceipt[];
  ref_state: GitvaultRefStateReceipt;
  retention_roots: GitvaultRetentionRootsReceipt;
  checkpoint: GitvaultCheckpointBlock | null;
  checkpoint_purpose: "ordinary_push" | "maintenance_cycle" | "repair" | null;
  capture_binding: GitvaultCaptureBinding | null;
  repair: GitvaultRepairDescriptor | null;
  transition: GitvaultTransitionEnvelope | null;
  /**
   * D197, rev 42: schema-optional, present ONLY on a head that publishes an
   * updated `recipient_pin_manifest` (an addition or a receipted change).
   * Absent on every existing rev-41 head and most rev-42+ heads too.
   */
  pin_manifest?: GitvaultPinManifestReceipt;
  writer_key_id: string;
  created_at: string;
  signature: string;
}

/** `common.json#/$defs/receipt_pin_manifest` — carried on `head.pin_manifest` / `vault_genesis.pin_manifest` (D197, rev 42). */
export interface GitvaultPinManifestReceipt {
  object_kind: "recipient_pin_manifest";
  pin_manifest_version: string;
  stored_bytes_sha256: string;
  size_bytes: string;
}

/** Any signed `r402s/v0` object: a JSON object carrying `object_kind` + a single top-level `signature`. */
export interface GitvaultSignedObject {
  object_kind: GitvaultObjectKind;
  signature: string;
  [member: string]: unknown;
}

/** The AAD of an AEAD frame (protocol §2): exactly these seven members, JCS-serialized. */
export interface GitvaultFrameAad {
  repo_id: string;
  object_kind: GitvaultEncryptedObjectKind;
  object_id: string;
  epoch: string;
  suite: GitvaultSuite;
  magic: "R402S0";
  suite_id: "01";
}

/**
 * The AAD of a `key_envelope` HPKE seal (protocol §2 / D188). Discriminated
 * by `rotation_id` presence (D203, rev 42): the rev-41 four-field form when
 * absent (genesis/ADD-workaround), the five-field form when present (a
 * rotation-attempt envelope) — two genuinely different object shapes, never
 * one shape with an optional-null member.
 */
export type GitvaultEnvelopeAad =
  | { repo_id: string; epoch: string; recipient_kind: "principal"; recipient_fingerprint: string }
  | { repo_id: string; epoch: string; rotation_id: string; recipient_kind: "principal"; recipient_fingerprint: string };

/** Result of sealing an AEAD frame — everything a finalization receipt is compared against. */
export interface GitvaultSealedFrame {
  /** The complete framed blob: `"R402S0"` ‖ `0x01` ‖ 24-byte nonce ‖ ct‖tag. */
  frame: Uint8Array;
  /** SHA-256 over the complete frame (what receipts call `ciphertext_sha256`). */
  ciphertext_sha256: string;
  /** Decimal string — `frame.length`. */
  size_bytes: string;
  /** The 24-byte nonce used, hex (informational; it is also bytes 7–30 of the frame). */
  nonce_hex: string;
}

/** Result of sealing a `key_envelope` — the signed object plus its stored-bytes identity. */
export interface GitvaultSealedKeyEnvelope {
  envelope: GitvaultKeyEnvelope;
  /** JCS of the signed envelope (what is PUT and what the receipt hashes). */
  stored_bytes: Uint8Array;
  stored_bytes_sha256: string;
  size_bytes: string;
  /** The receipt embedded in `vault_genesis.envelopes[]`. */
  receipt: GitvaultKeyEnvelopeReceipt;
}

/** A raw Ed25519 identity: 32-byte seed + derived raw public key. */
export interface GitvaultSigningKeypair {
  /** 32-byte seed (RFC 8032 private key). */
  seed: Uint8Array;
  /** 32-byte raw public key. */
  public_key: Uint8Array;
}

/** A raw X25519 identity: 32-byte private scalar + raw public key. */
export interface GitvaultEncryptionKeypair {
  /** 32-byte X25519 private key. */
  private_key: Uint8Array;
  /** 32-byte raw public key. */
  public_key: Uint8Array;
}

/** The outcome of a strict parse (protocol §1): the parsed object, or the named rejection reason. */
export type GitvaultStrictParseReason =
  | "json-number"
  | "duplicate-member"
  | "invalid-json"
  | "noncanonical-encoding";

// ─── Epoch rotation (D193-D203, rev 42, change gitvault-human-envelopes) ───

/** The four `rotate_epoch_payload.reason` values (D199) — three urgent + one elective. */
export type GitvaultRotationReason = "member_removed" | "recipient_key_revoked" | "epoch_secret_exposed" | "elective_rekey";

/**
 * `rotation_attempt_descriptor` (schema `rotation_attempt_descriptor.json`,
 * D195) — writer-signed, create-only, path-addressed at
 * `rotation-attempts/<rotation_id>.json`; `rotation_id` is NOT a field on the
 * object itself, it is `lowerhex(SHA-256(JCS(this object minus signature)))`
 * — the object's own path key, derived AFTER every field below (including
 * `attempt_key_commitment`) is fixed.
 */
export interface GitvaultRotationAttemptDescriptor {
  format: GitvaultFormat;
  object_kind: "rotation_attempt_descriptor";
  suite: GitvaultSuite;
  repo_id: string;
  base_head_sha256: string;
  new_epoch: string;
  /** Decimal-string uint64 — D194's frozen watermark. */
  recipient_state_version: string;
  /** Decimal-string uint64 — D194's frozen org-wide revocation watermark. */
  recipient_revocation_version: string;
  pin_manifest_sha256: string;
  target_partition_digest: string;
  /** 32-hex CSPRNG — client resume identity (D195). */
  client_idempotency_key: string;
  /** `HMAC-SHA-256(K_digest("epoch_rotation_attempt"), JCS(this object's own fields minus this field), ikm=K_e)`. */
  attempt_key_commitment: string;
  writer_key_id: string;
  signature: string;
}

/**
 * `rotate_epoch_payload.self_open_attestation` (D209, rev 44, NEW field) —
 * the rotating client's claim that it round-tripped its OWN new-epoch
 * `key_envelope` through the REAL reader entry point
 * ({@link import("./gitvault.crypto.js").openEpochRotationForRecipient})
 * BEFORE submitting. The two generation fields are `fsck`'s OWN
 * `chain_verified_to_generation` / `decryptable_to_generation` split,
 * verbatim (hex16 generations) — one honest number, two consumers, never a
 * parallel notion.
 *
 * Gateway-checked biconditional: `outcome === "opened"` IFF the ADMITTING
 * principal has an included `{principal_id, envelope}` pair in `envelopes[]`
 * — on `"opened"`, `opened_fingerprint` / `decryptable_to_generation` /
 * `reader_entrypoint` are ALL REQUIRED-present; on `"writer_not_recipient"`
 * they are ALL REQUIRED-absent (the object schema keeps them optional so
 * both branches parse — the semantic constraint enforces the IFF). On both
 * branches `chain_verified_to_generation` MUST equal the predecessor
 * generation (the admitted head's own generation minus one).
 *
 * THE DECRYPTION CLAIM ITSELF IS HONEST-CLIENT EVIDENCE, NOT
 * SERVER-VERIFIABLE — the gateway verifies only the structural consistency
 * above; the server never holds a recipient private key. Same evidentiary
 * class as D200's `epoch_key_commitment` per-recipient self-check.
 */
export interface GitvaultEpochRotationSelfOpen {
  /**
   * `"opened"` — the writer is itself an included recipient and opened its
   * own new-epoch envelope through the reader entry point.
   * `"writer_not_recipient"` — the admitting principal has no included pair
   * in `envelopes[]` (the normal agent/CI-writer case); no self round-trip
   * is possible, and D210's recipient proof-of-open receipts are the
   * closure for post-rotation readability on this branch.
   */
  outcome: "opened" | "writer_not_recipient";
  chain_verified_to_generation: string;
  /** REQUIRED-present iff `outcome === "opened"`; REQUIRED-absent iff `outcome === "writer_not_recipient"`. */
  decryptable_to_generation?: string;
  /** REQUIRED-present iff `outcome === "opened"`; REQUIRED-absent iff `outcome === "writer_not_recipient"`. */
  opened_fingerprint?: string;
  /**
   * REQUIRED-present iff `outcome === "opened"`; REQUIRED-absent iff
   * `outcome === "writer_not_recipient"`. Audit provenance, never an
   * authorization input — names the client implementation + reader entry
   * point that produced the evidence (e.g.
   * `"run402@4.49.0/openEpochRotationForRecipient"`). Plain string by
   * design (`principal_id` precedent) — no wire grammar is promised for it.
   */
  reader_entrypoint?: string;
}

/**
 * `rotate_epoch_payload` (schema `rotate_epoch_payload.json`, D193-D210) —
 * the JCS bytes carried (base64url-encoded, hash-pinned) inside
 * `head.transition.payload` when `transition.kind == "rotate_epoch"`.
 */
export interface GitvaultRotateEpochPayload {
  new_epoch: string;
  /** The full 64-hex digest of the referenced `rotation_attempt_descriptor`'s stored bytes. */
  rotation_id: string;
  reason: GitvaultRotationReason;
  recipient_state_version: string;
  recipient_revocation_version: string;
  pin_manifest_sha256: string;
  target_partition_digest: string;
  /** `HMAC-SHA-256(K_digest("epoch_rotation"), JCS({rotation_id, fingerprints:[sorted]}), ikm=K_e)` — a per-recipient self-check only (D200). */
  epoch_key_commitment: string;
  excluded_keyless_principal_ids: string[];
  excluded_unconfirmed_principal_ids: string[];
  /** Reserved, always `null` in this revision (D197). */
  recipient_authority_attestation: null;
  envelopes: GitvaultRotationEnvelopePair[];
  /**
   * D209 (rev 44, NEW field). SCHEMA-OPTIONAL for exactly the historical-
   * parse reason (a pre-rev-44 committed rotation payload structurally
   * cannot carry it); SEMANTICALLY REQUIRED on every admission at or after
   * this fold's own activation fence — an admission that omits it refuses
   * `EPOCH_ROTATION_SELF_OPEN_UNPROVEN`. This SDK's own {@link
   * import("../node/gitvault-publication.js").GitvaultVault.rotateEpoch}
   * always populates it on every submitted rotation.
   */
  self_open_attestation?: GitvaultEpochRotationSelfOpen;
}

/** One `recipient_pin_manifest.pins[]` entry (D197). */
export interface GitvaultRecipientPinManifestEntry {
  principal_id: string;
  ek_fingerprint: string;
  pinned_at: string;
  confirmed_by: "creator_self_key" | "operator_confirmation";
  /** REQUIRED-null iff `confirmed_by === "creator_self_key"`; REQUIRED-non-null otherwise. */
  confirmation_receipt_sha256: string | null;
}

/**
 * `recipient_pin_manifest` (schema `recipient_pin_manifest.json`, D197) —
 * plaintext-structured (pins are public data, never HPKE-sealed),
 * writer-signed, version-addressed at
 * `recipient-pins/<pin_manifest_version>.json`, chain-referenced only via
 * `head.pin_manifest` / `vault_genesis.pin_manifest`.
 */
export interface GitvaultRecipientPinManifest {
  format: GitvaultFormat;
  object_kind: "recipient_pin_manifest";
  suite: GitvaultSuite;
  repo_id: string;
  /** Monotonic hex16 — exactly the predecessor's version + 1, or exactly `1` if none. */
  pin_manifest_version: string;
  /** The predecessor's stored-bytes sha256, or the 64-`0` zero-value sentinel when `pin_manifest_version == 1`. */
  base_pin_manifest_sha256: string;
  pins: GitvaultRecipientPinManifestEntry[];
  writer_key_id: string;
  signature: string;
}

/** The `recipient_pin_manifest`'s zero-value sentinel `base_pin_manifest_sha256` when no predecessor manifest exists (D197). */
export const GITVAULT_ZERO_SHA256_SENTINEL = "0".repeat(64);

/**
 * `recipient_confirmation_receipt` (schema `recipient_confirmation_receipt.json`,
 * D197, `rcr_`) — control-plane-signed, immutable, ID-addressed at
 * `recipient-confirmations/<rcr_id>.json`, obtained BEFORE the `/confirm` or
 * `/repin` ceremony it authorizes. Single-use: consumed by admission of the
 * `recipient_pin_manifest` entry that cites its stored-bytes hash.
 */
export interface GitvaultRecipientConfirmationReceipt {
  format: GitvaultFormat;
  object_kind: "recipient_confirmation_receipt";
  /** `rcr_` + 32 lowercase hex. */
  object_id: string;
  repo_id: string;
  purpose: "first_pin" | "repin";
  principal_id: string;
  new_fingerprint: string;
  /** REQUIRED-present iff `purpose === "repin"`; REQUIRED-absent iff `purpose === "first_pin"`. */
  old_ek_fingerprint?: string;
  base_pin_manifest_sha256: string;
  recipient_state_version: string;
  issued_at: string;
  service_key_id: string;
  signature: string;
}

/**
 * `recipient_open_receipt` (schema `recipient_open_receipt.json`, D210, rev
 * 44, `ror_`) — the EVIDENCE mirror of {@link GitvaultRecipientConfirmationReceipt}'s
 * authorization class: minted AFTER the fact it records (a recipient's own
 * proof that it opened its envelope through the real reader path), never
 * consumed, never superseded, and never read by admission. The two
 * generation fields are `fsck`'s OWN `chain_verified_to_generation` /
 * `decryptable_to_generation` split, carried verbatim — one honest number,
 * two consumers (D209's `self_open_attestation` is the other). Minted by
 * `POST …/recipients/:principal_id/proof-of-open` (`source:
 * "recipient_submission"`) or self-minted by the gateway at a `rotate_epoch`
 * COMMIT from the admission's own verified D209 attestation (`source:
 * "rotation_admission"`). Idempotent on `(repo_id, principal_id,
 * ek_fingerprint, decryptable_to_generation)` — an exact-tuple replay
 * returns this SAME object.
 */
export interface GitvaultOpenReceipt {
  format: GitvaultFormat;
  object_kind: "recipient_open_receipt";
  /** `ror_` + 32 lowercase hex. */
  object_id: string;
  repo_id: string;
  principal_id: string;
  ek_fingerprint: string;
  /** fsck's own `chain_verified_to_generation`, verbatim (hex16). */
  chain_verified_to_generation: string;
  /** fsck's own `decryptable_to_generation`, verbatim (hex16). Always `<=` `chain_verified_to_generation`. */
  decryptable_to_generation: string;
  /** Audit provenance, never an authorization input — names the client implementation + entry point that produced this evidence. */
  reader_entrypoint: string;
  source: "recipient_submission" | "rotation_admission";
  issued_at: string;
  service_key_id: string;
  signature: string;
}
