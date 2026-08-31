/**
 * gitvault test fixture — an in-memory control plane + bucket implementing
 * the FULL {@link GitvaultTransport} (5.3 creation + 5.4 publication + 5.6
 * token/override routes) with the protocol's server-side rules a client must
 * survive: create-only objects, generation CAS (`HEAD_CAS_CONFLICT` + winner),
 * `TRANSITION_NOT_ACTIVE`, anchor/cursor-bound listings (`INVALID_CURSOR`),
 * capture receipts, activation-token mint rules (null digest → no token;
 * binding must match the operation row), override completion (equality on
 * every field), plus fault knobs (receipt tamper, read-back tamper, a
 * competing writer) the 5.4/5.6 suites use.
 *
 * Lives in a `.test.ts` so it never ships in `dist/`; the one test below keeps
 * the runner happy when the file is executed directly.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalError } from "../errors.js";
import {
  GITVAULT_FORMAT,
  GITVAULT_GENESIS_GENERATION,
  GITVAULT_SUITE,
  ekFingerprint,
  formatGitvaultTimestamp,
  fromBase64url,
  generateSigningKeypair,
  isCanonicalBase64url,
  jcs,
  newGitvaultId,
  newHex32,
  parseGitvaultStrict,
  sha256Hex,
  signGitvaultObject,
  verifyGitvaultObject,
  vkFingerprint,
} from "../namespaces/gitvault.crypto.js";
import type { GitvaultActivationToken, GitvaultAllocation, GitvaultCaptureReceipt, GitvaultHead, GitvaultHeadsListingPage, GitvaultHeadsListingRequest, GitvaultRetentionCutoff } from "../namespaces/gitvault.types.js";
import type { GitvaultAdmitGenesisRequest, GitvaultAdmitGenesisResult, GitvaultAllocateRequest, GitvaultObjectReceipt, GitvaultPutObjectRequest } from "./gitvault-creation-journal.js";
import { createGitvault } from "./gitvault-creation-journal.js";
import { GitvaultKeystore } from "./gitvault-keystore.js";
import type { GitvaultAdmitHeadRequest, GitvaultAdmitHeadResult, GitvaultCompactionGrant, GitvaultDesiredRecipientEntry, GitvaultEnvelopeRecipientsResponse, GitvaultMaintenanceLease, GitvaultMaintenanceLeaseRequest, GitvaultOrgEncryptionKeyDirectory, GitvaultOrgEncryptionKeyEntry, GitvaultRetentionCutoffIssued, GitvaultTransport, GitvaultUploadObject, GitvaultUploadReceipt, GitvaultVaultRecord, GitvaultVaultState } from "./gitvault-publication.js";
import type { GitvaultOpenReceipt, GitvaultRecipientConfirmationReceipt, GitvaultRotationAttemptDescriptor } from "../namespaces/gitvault.types.js";
import type { GitvaultPruneIntentRecord } from "./gitvault-prune.js";
import { GitvaultVault, generationToBigInt, bigIntToGeneration, gitvaultPaths } from "./gitvault-publication.js";
import { hardenedGit } from "./gitvault-snapshot.js";

function err(code: string, message: string, details?: unknown): LocalError {
  return new LocalError(message, "memory transport", { code, details });
}

export interface MemoryOperation {
  operation_id: string;
  capture_id: string;
  apply_plan_sha256: string;
  snapshot_oid_hmac: string;
  /** Set when the operation was activated unvaulted (the journaled advisory). */
  override: { cleared: boolean } | null;
  activated_with: string | null;
}

export class GitvaultMemoryTransport implements GitvaultTransport {
  readonly service = generateSigningKeypair();
  readonly objects = new Map<string, Uint8Array>();
  readonly allocations = new Map<string, GitvaultAllocation>();
  readonly operations = new Map<string, MemoryOperation>();
  readonly consumedTokens = new Map<string, string>();
  readonly calls: string[] = [];
  authorizationEpoch = "29ecd26abcb16d47cfd6b853a1c9130d";
  repoCounter = 0;
  // ── D6 push-to-create (repo-first-onramp task 4.4/4.5) — modelled server
  // state: `internal.repo_names` (run402-private services/repo-names.ts).
  // Keyed by `${org_slug}/${repo_name}`. `null` project_id = an in-flight
  // RESERVATION (the atomic-claim window); a request from a client_creation_id
  // that never "won" the reservation loses the race, exactly like the
  // gateway's real PRIMARY KEY arbiter.
  readonly repoNames = new Map<string, { orgId: string; projectId: string | null; winnerClientCreationId: string }>();
  /** Org slugs currently in their post-rename cooldown (design D6) — `findVaultByRepo`/push-to-create both refuse `SLUG_RELEASED`. */
  readonly slugReleased = new Map<string, { successor_slug: string | null; released_at: string; cooldown_until: string }>();
  /**
   * `project_id -> repo_id` / `repo_id -> {orgId, projectId}` — what
   * `findVaultByProject`/`findVaultByRepo`/`getVaultRecord` resolve through
   * for a multi-repo fixture instance (D6 push-to-create tests hold more
   * than one repo per transport). Promoted from `pendingOwners` in
   * `uploadObjects`, matching the SAME "objects exist" gate this fixture has
   * always used to mean "a vault is resolvable" (its pre-existing
   * single-vault fallback reads `[...this.objects.keys()]`) — a fresh
   * ALLOCATION alone does NOT make a vault resolvable here, which is exactly
   * what the D2 resumability test below depends on (a local journal, not a
   * network fast path, must drive a crashed creation to completion).
   */
  readonly projectRepoIds = new Map<string, string>();
  readonly repoOwners = new Map<string, { orgId: string; projectId: string }>();
  /** `repo_id -> {orgId, projectId}` from `allocate()`, promoted into the maps above once `uploadObjects` proves the repo has real content. */
  readonly pendingOwners = new Map<string, { orgId: string; projectId: string }>();
  /** `repo_id -> creator_signing_pubkey` (raw base64url) — what `createRotationAttempt` verifies a descriptor's signature against (the SAME writer-key model `admitHead`'s own signature checks would need, modelled once here since a rotation attempt is signed BEFORE any head). */
  readonly signingPubkeyByRepo = new Map<string, string>();

  // ── epoch rotation (D193-D203, rev 42) ──
  /** `org_id -> desired-recipient rows`. Tests set this directly. `undefined` (never queried) models an older gateway with no `desired[]` field at all. */
  readonly desiredRecipients = new Map<string, GitvaultDesiredRecipientEntry[]>();
  /** `org_id -> desired_state_version`. */
  readonly desiredStateVersions = new Map<string, number>();
  /** `org_id -> {state, revocation}` — D194's org-scoped watermark pair (`internal.gitvault_recipient_state_counters`). Lazily initialized at 0/0, mirroring the real gateway's `INSERT ... ON CONFLICT DO UPDATE` upsert-lock. */
  readonly recipientStateCounters = new Map<string, { state: bigint; revocation: bigint }>();
  /** `repo_id -> the LAST discharged recipient_revocation_version` (advances only on a COMMITTED rotate_epoch, to the value the winning attempt was fenced against — never re-read "current" at commit, D194). */
  readonly dischargedRevocationVersion = new Map<string, bigint>();
  /** `repo_id -> {version, clearedThrough}` — D199's vault-scoped exposure watermark. */
  readonly epochSecretExposure = new Map<string, { version: bigint; clearedThrough: bigint }>();
  /** `repo_id -> migration_rotation_required` (D193). Defaults `false` — a fixture-created vault is born under this fold's evidence discipline, same as a real rev-42+ genesis. */
  readonly migrationRotationRequired = new Map<string, boolean>();
  /** `${repo_id}:${rotation_id} -> the descriptor's stored bytes` — the create-only CAS `createRotationAttempt` writes to BEFORE any envelope upload (D195). */
  readonly rotationAttempts = new Map<string, { bytes: Uint8Array; descriptor: GitvaultRotationAttemptDescriptor }>();
  /** `repo_id -> the currently-effective pin manifest's {version, sha256}`. Absent = the zero-value sentinel (no manifest ever admitted). */
  readonly effectivePinManifest = new Map<string, { version: string; sha256: string }>();

  private counters(orgId: string): { state: bigint; revocation: bigint } {
    let c = this.recipientStateCounters.get(orgId);
    if (!c) { c = { state: 0n, revocation: 0n }; this.recipientStateCounters.set(orgId, c); }
    return c;
  }
  // ── fault knobs ──
  /** Tamper every Nth receipt's hash (1-based index into the upload order); null = honest. */
  tamperReceiptAt: number | null = null;
  /** Store different bytes at head/<gen> than admitted (the read-back must catch it). */
  tamperReadback = false;
  /** A competing writer: before the NEXT admission, admit this head (bytes) at the same generation. */
  competitor: ((generation: string) => Promise<void>) | null = null;
  /** Refuse token minting with this code once. */
  refuseTokenOnce: string | null = null;
  pageLimit: number | null = null;

  private key(repoId: string, path: string): string { return `${repoId}/${path}`; }

  // ── creation (5.3) ──
  async allocate(req: GitvaultAllocateRequest): Promise<GitvaultAllocation> {
    this.calls.push("allocate");
    // The gateway's `validateCreatorKeys`, modelled exactly: the REQUEST
    // carries raw public keys, they must be canonical base64url decoding to
    // exactly 32 bytes, and the FINGERPRINTS on the returned record are DERIVED
    // here — never taken from the request. A fingerprint-shaped value
    // (`vk_…`/`ek_…`) sent in a pubkey field must fail, because that is the
    // production defect this fixture exists to catch locally.
    const requirePubkey = (v: unknown, field: string): string => {
      if (typeof v !== "string" || !isCanonicalBase64url(v)) throw err("VALIDATION_FAILED", `${field} must be a canonical base64url 32-byte public key`, { field });
      let decoded: Uint8Array;
      try {
        decoded = fromBase64url(v, field);
      } catch {
        throw err("VALIDATION_FAILED", `${field} must be a canonical base64url 32-byte public key`, { field });
      }
      if (decoded.length !== 32) throw err("VALIDATION_FAILED", `${field} must be a canonical base64url 32-byte public key`, { field });
      return v;
    };
    const signingPubkey = requirePubkey(req.creator_signing_pubkey, "creator_signing_pubkey");
    const encryptionPubkey = requirePubkey(req.creator_encryption_pubkey, "creator_encryption_pubkey");
    let a = this.allocations.get(req.client_creation_id);
    if (!a) {
      // ── D6 push-to-create addressing: resolve {org_id, project_id} from
      // {org_slug, repo_name} — the SYNCHRONOUS check-and-reserve below (no
      // `await` between the read and the write) models the gateway's atomic
      // PRIMARY KEY reservation: of two concurrent callers, whichever's
      // synchronous portion runs first (deterministic in a single-threaded
      // event loop, exactly the ordering `Promise.all([a(), b()])` produces)
      // wins the name, and the other sees REPO_CREATION_CONFLICT — never both.
      let orgId: string;
      let projectId: string;
      if ("org_slug" in req) {
        const key = `${req.org_slug}/${req.repo_name}`;
        const released = this.slugReleased.get(req.org_slug);
        if (released) throw err("SLUG_RELEASED", `slug "${req.org_slug}" is in cooldown`, released);
        const existing = this.repoNames.get(key);
        if (existing) {
          if (existing.winnerClientCreationId !== req.client_creation_id || existing.projectId === null) {
            // Either a different client won it (this one races and loses), or
            // the same reservation is still pending finalization — either way
            // this call did not win the atomic claim.
            throw err("REPO_CREATION_CONFLICT", `repo "${key}" was just created by a concurrent push`, { project_id: existing.projectId });
          }
          orgId = existing.orgId;
          projectId = existing.projectId;
        } else {
          this.repoCounter += 1;
          orgId = `org_${req.org_slug}`;
          projectId = `prj_${String(this.repoCounter).padStart(8, "0")}`;
          // Reserve + finalize synchronously — the fixture's atomic claim window.
          this.repoNames.set(key, { orgId, projectId, winnerClientCreationId: req.client_creation_id });
        }
      } else {
        orgId = req.org_id;
        projectId = req.project_id;
      }
      this.repoCounter += 1;
      const unsigned = {
        format: GITVAULT_FORMAT, object_kind: "allocation" as const, suite: GITVAULT_SUITE,
        repo_id: `src_${String(this.repoCounter).padStart(32, "0")}`, service_key_id: "sk_test-1", org_id: orgId, project_id: projectId, principal_id: "principal_1",
        creator_signing_fingerprint: vkFingerprint(fromBase64url(signingPubkey, "creator_signing_pubkey")),
        creator_encryption_fingerprint: ekFingerprint(fromBase64url(encryptionPubkey, "creator_encryption_pubkey")),
        client_creation_id: req.client_creation_id,
        allocation_nonce: "ab".repeat(16), allocation_generation: "0000000000000001", status: "active" as const, issued_at: "2026-08-22T12:00:00.000Z", created_at: "2026-08-22T12:00:00.000Z",
      };
      a = signGitvaultObject(unsigned, this.service.seed) as GitvaultAllocation;
      // Same "objects exist" gate as the ordinary path (see the class doc
      // comment on `projectRepoIds`) — a fresh ALLOCATION alone, push-to-create
      // or not, does not yet mean the client holds K_repo locally; only a
      // completed creation (this fixture's proxy: objects uploaded) does.
      this.pendingOwners.set(a.repo_id, { orgId, projectId });
      this.signingPubkeyByRepo.set(a.repo_id, signingPubkey);
      this.allocations.set(req.client_creation_id, a);
    }
    return a;
  }
  async putObject(req: GitvaultPutObjectRequest): Promise<GitvaultObjectReceipt> {
    const [r] = await this.uploadObjects({ repo_id: req.repo_id, objects: [{ path: req.path, object_kind: "key_envelope", object_id: null, bytes: req.bytes, sha256: req.expected_sha256, size_bytes: req.expected_size_bytes }] });
    return { stored_bytes_sha256: r!.sha256, size_bytes: r!.size_bytes };
  }
  async getObject({ repo_id, path }: { repo_id: string; path: string }): Promise<Uint8Array | null> {
    this.calls.push(`get:${path}`);
    return this.objects.get(this.key(repo_id, path)) ?? null;
  }
  /** Batched sibling (design D2) — logs one `get-batch:<n>:<paths…>` call, matching the real transport's one-presign-POST shape, then resolves each path exactly as {@link getObject} would. */
  async getObjects({ repo_id, paths }: { repo_id: string; paths: string[] }): Promise<Array<Uint8Array | null>> {
    this.calls.push(`get-batch:${paths.length}:${paths.join(",")}`);
    return paths.map((path) => this.objects.get(this.key(repo_id, path)) ?? null);
  }
  /**
   * `POST …/head-reads` (gitvault-batched-head-reads) — ONE logged call
   * carrying a whole page's head bytes, mirroring the route's all-or-nothing
   * contract: a single absent generation resolves the WHOLE batch to `null`
   * (the caller's "unsupported, fall back" signal) rather than a hole the
   * walk would misread as absence.
   */
  async getHeads({ repo_id, generations }: { repo_id: string; generations: string[] }): Promise<Uint8Array[] | null> {
    if (this.headReadsUnsupported) return null;
    this.calls.push(`head-reads:${generations.length}:${generations.join(",")}`);
    const out: Uint8Array[] = [];
    for (const g of generations) {
      const bytes = this.objects.get(this.key(repo_id, gitvaultPaths.head(g)));
      if (!bytes) return null;
      out.push(bytes);
    }
    return out;
  }
  /** Set by a fixture that wants the pre-batch fallback path under test. */
  headReadsUnsupported = false;

  async admitGenesis(req: GitvaultAdmitGenesisRequest): Promise<GitvaultAdmitGenesisResult> {
    const k = this.key(req.repo_id, gitvaultPaths.head(GITVAULT_GENESIS_GENERATION));
    const existing = this.objects.get(k);
    if (existing) return { outcome: "already_admitted", admitted_sha256: sha256Hex(existing) };
    this.objects.set(k, req.stored_bytes);
    return { outcome: "admitted", admitted_sha256: req.stored_bytes_sha256 };
  }
  getGenesis({ repo_id }: { repo_id: string }): Promise<Uint8Array | null> {
    return this.getObject({ repo_id, path: gitvaultPaths.head(GITVAULT_GENESIS_GENERATION) });
  }

  // ── listing (D186) ──
  newestGeneration(repoId: string): string {
    let newest = 0n;
    for (const k of this.objects.keys()) {
      const m = new RegExp(`^${repoId}/head/([0-9a-f]{16})$`).exec(k);
      if (m) { const g = generationToBigInt(m[1]!); if (g > newest) newest = g; }
    }
    return bigIntToGeneration(newest);
  }
  async listHeads(request: GitvaultHeadsListingRequest & { repo_id: string }): Promise<GitvaultHeadsListingPage> {
    this.calls.push("listHeads");
    const anchor = generationToBigInt(request.after_generation);
    let start = anchor + 1n;
    if (request.cursor !== undefined) {
      const m = /^hc_([0-9a-f]{16})_([0-9a-f]{16})_([0-9a-f]{8})$/.exec(request.cursor);
      const bound = m ? sha256Hex(new TextEncoder().encode(`${request.repo_id}|${m[1]}|${m[2]}`)).slice(0, 8) : null;
      if (!m || m[1] !== request.after_generation || bound !== m[3]) throw err("INVALID_CURSOR", "cursor not minted for this vault under this after_generation");
      start = generationToBigInt(m[2]!) + 1n;
    }
    const newest = generationToBigInt(this.newestGeneration(request.repo_id));
    const limit = BigInt(this.pageLimit ?? Number(request.limit));
    const heads: GitvaultHeadsListingPage["heads"] = [];
    let g = start;
    for (; g <= newest && BigInt(heads.length) < limit; g++) {
      const gen = bigIntToGeneration(g);
      heads.push({ generation: gen, stored_bytes_sha256: sha256Hex(this.objects.get(this.key(request.repo_id, gitvaultPaths.head(gen)))!) });
    }
    const hasMore = g <= newest;
    const last = heads.length > 0 ? heads[heads.length - 1]!.generation : request.after_generation;
    const cursor = `hc_${request.after_generation}_${last}_${sha256Hex(new TextEncoder().encode(`${request.repo_id}|${request.after_generation}|${last}`)).slice(0, 8)}`;
    return { format: GITVAULT_FORMAT, repo_id: request.repo_id, after_generation: request.after_generation, heads, has_more: hasMore, next_cursor: hasMore ? cursor : null, total: hasMore ? null : String(newest > anchor ? newest - anchor : 0n) };
  }

  // ── uploads (create-only) ──
  async uploadObjects({ repo_id, objects }: { repo_id: string; objects: GitvaultUploadObject[] }): Promise<GitvaultUploadReceipt[]> {
    this.calls.push(`upload:${objects.length}`);
    const receipts: GitvaultUploadReceipt[] = [];
    objects.forEach((o, i) => {
      const k = this.key(repo_id, o.path);
      const existing = this.objects.get(k);
      if (existing && sha256Hex(existing) !== o.sha256) throw err("GITVAULT_OBJECT_EXISTS_DIFFERENT", `${o.path} exists with different bytes`);
      if (sha256Hex(o.bytes) !== o.sha256 || String(o.bytes.length) !== o.size_bytes) throw err("GITVAULT_CHECKSUM_MISMATCH", `${o.path}: bytes do not match the declared checksum`);
      this.objects.set(k, o.bytes);
      const tampered = this.tamperReceiptAt === i + 1;
      receipts.push({ path: o.path, object_id: o.object_id, sha256: tampered ? "00".repeat(32) : o.sha256, size_bytes: o.size_bytes });
    });
    if (this.tamperReceiptAt !== null) this.tamperReceiptAt = null;
    // Promote the pending owner NOW — the SAME "objects exist" instant this
    // fixture's own single-vault fallback (`[...objects.keys()]`) has always
    // used to mean "a vault is resolvable." A fresh allocation alone must
    // NOT make `findVaultByProject`/`findVaultByRepo` succeed (see the class
    // doc comment on `projectRepoIds`).
    const owner = this.pendingOwners.get(repo_id);
    if (owner) {
      this.repoOwners.set(repo_id, owner);
      this.projectRepoIds.set(owner.projectId, repo_id);
    }
    return receipts;
  }

  // ── admission (§5A, client-visible half) ──
  async admitHead(req: GitvaultAdmitHeadRequest): Promise<GitvaultAdmitHeadResult> {
    this.calls.push(`admit:${req.generation}`);
    if (this.competitor) { const c = this.competitor; this.competitor = null; await c(req.generation); }
    const head = parseGitvaultStrict(new TextDecoder().decode(req.stored_bytes)) as GitvaultHead;
    if (head.transition !== null && head.transition.kind !== "rotate_epoch") throw err("TRANSITION_NOT_ACTIVE", "V0 admission rejects every non-null, non-rotate_epoch transition");
    const owner = this.repoOwners.get(req.repo_id) ?? this.pendingOwners.get(req.repo_id);
    const orgId = owner?.orgId ?? "org_memory";
    if (head.transition === null) {
      // D193: every ORDINARY admission on a flagged vault refuses, mirroring
      // the real gateway's three-way OR gate.
      const c = this.counters(orgId);
      const migrationRequired = this.migrationRotationRequired.get(req.repo_id) === true;
      const dischargedThrough = this.dischargedRevocationVersion.get(req.repo_id) ?? 0n;
      const revocationOutstanding = c.revocation > dischargedThrough;
      const exposure = this.epochSecretExposure.get(req.repo_id) ?? { version: 0n, clearedThrough: 0n };
      const exposureOutstanding = exposure.version > exposure.clearedThrough;
      if (migrationRequired || revocationOutstanding || exposureOutstanding) {
        throw err("EPOCH_ROTATION_REQUIRED", "this vault requires a rotate_epoch admission before an ordinary push is admissible", { migration_required: migrationRequired, revocation_outstanding: revocationOutstanding, exposure_outstanding: exposureOutstanding });
      }
    } else {
      // rotate_epoch: fenced re-derivation of the SAME facts createRotationAttempt already bound (D194/D195 self-consistency, simplified for this fixture — the real gateway's full H-partition bijection check (D196) lives server-side and is NOT re-implemented here; this models the fields a client-side test can meaningfully exercise: descriptor existence, bound-field agreement, and the frozen-counter comparison).
      const payloadObj = JSON.parse(new TextDecoder().decode(fromBase64url(head.transition.payload))) as Record<string, unknown>;
      const rotationId = String(payloadObj.rotation_id);
      const attempt = this.rotationAttempts.get(`${req.repo_id}:${rotationId}`);
      if (!attempt) throw err("ROTATION_ID_MISMATCH", "no rotation_attempt_descriptor exists for the declared rotation_id");
      const d = attempt.descriptor;
      if (payloadObj.recipient_state_version !== d.recipient_state_version || payloadObj.recipient_revocation_version !== d.recipient_revocation_version || payloadObj.pin_manifest_sha256 !== d.pin_manifest_sha256 || payloadObj.target_partition_digest !== d.target_partition_digest) {
        throw err("RECIPIENT_SET_MISMATCH", "the rotate_epoch payload's bound fields disagree with the referenced rotation_attempt_descriptor");
      }
      const c = this.counters(orgId);
      if (BigInt(String(d.recipient_state_version)) !== c.state || BigInt(String(d.recipient_revocation_version)) !== c.revocation) {
        throw err("RECIPIENT_SET_MISMATCH", "desired-recipient state has advanced since this rotation attempt was created; rebuild and resubmit");
      }
    }
    const newest = this.newestGeneration(req.repo_id);
    const expected = bigIntToGeneration(generationToBigInt(newest) + 1n);
    if (req.generation !== expected || head.generation !== expected) {
      const winnerBytes = this.objects.get(this.key(req.repo_id, gitvaultPaths.head(newest)))!;
      return { outcome: "conflict", winner: { generation: newest, stored_bytes_sha256: sha256Hex(winnerBytes) } };
    }
    const receipted = [head.ref_state.object_id, head.retention_roots.object_id, ...head.wal_entries.map((w) => w.object_id)];
    for (const id of receipted) {
      const path = id.startsWith("refs_") ? gitvaultPaths.refState(id) : id.startsWith("rr_") ? gitvaultPaths.retentionRoots(id) : gitvaultPaths.wal(id);
      if (!this.objects.has(this.key(req.repo_id, path))) throw err("GITVAULT_RECEIPT_UNKNOWN", `receipted object ${id} was never finalized`);
    }
    if (head.checkpoint && !this.objects.has(this.key(req.repo_id, gitvaultPaths.claimSet(head.checkpoint.claim_set.object_id)))) throw err("GITVAULT_RECEIPT_UNKNOWN", "claim set never finalized");
    if (head.transition?.kind === "rotate_epoch") {
      // D194's discharge-at-commit: EXACTLY the frozen value the winning
      // attempt was fenced against — never a value re-read at commit time.
      const payloadObj = JSON.parse(new TextDecoder().decode(fromBase64url(head.transition.payload))) as Record<string, unknown>;
      this.dischargedRevocationVersion.set(req.repo_id, BigInt(String(payloadObj.recipient_revocation_version)));
      this.migrationRotationRequired.set(req.repo_id, false);
      const exposure = this.epochSecretExposure.get(req.repo_id);
      if (exposure) exposure.clearedThrough = exposure.version;
    }
    // `head.pin_manifest` is an independent, schema-optional field (§4.3) —
    // it can ride EITHER an ordinary head (`publishPinManifestUpdate`) OR a
    // `rotate_epoch` head (the `pending_confirmations` fold). Track it
    // unconditionally so `confirmRecipient`/`repinRecipient`'s
    // `base_pin_manifest_sha256` stamp reflects the REAL currently-effective
    // predecessor after an ordinary pin-manifest-only publish too — this was
    // previously nested inside the `rotate_epoch` branch above, which meant
    // this fixture never observed an ordinary publish's manifest at all.
    if (head.pin_manifest) this.effectivePinManifest.set(req.repo_id, { version: head.pin_manifest.pin_manifest_version, sha256: head.pin_manifest.stored_bytes_sha256 });
    const stored = this.tamperReadback ? new TextEncoder().encode(new TextDecoder().decode(req.stored_bytes) + " ") : req.stored_bytes;
    this.objects.set(this.key(req.repo_id, gitvaultPaths.head(req.generation)), stored);
    const record = new TextEncoder().encode(JSON.stringify({ admission: req.generation, admitted_sha256: req.stored_bytes_sha256 }));
    this.objects.set(this.key(req.repo_id, gitvaultPaths.admission(req.generation)), record);
    let capture_receipt: GitvaultCaptureReceipt | null = null;
    if (head.capture_binding) {
      capture_receipt = signGitvaultObject({
        format: GITVAULT_FORMAT, object_kind: "capture_receipt" as const, suite: GITVAULT_SUITE, repo_id: req.repo_id, service_key_id: "sk_test-1", generation: req.generation,
        head_sha256: req.stored_bytes_sha256, capture_id: head.capture_binding.capture_id, apply_plan_sha256: head.capture_binding.apply_plan_sha256, snapshot_oid_hmac: head.capture_binding.snapshot_oid_hmac,
        admission_record_sha256: sha256Hex(record), issued_at: formatGitvaultTimestamp(), effective_admitted_at: formatGitvaultTimestamp(), authorization_epoch: this.authorizationEpoch,
      }, this.service.seed) as GitvaultCaptureReceipt;
    }
    return { outcome: "admitted", admission_record_sha256: sha256Hex(record), capture_receipt };
  }

  async requestRetentionCutoff({ repo_id, base_head_sha256 }: { repo_id: string; base_head_sha256: string }): Promise<GitvaultRetentionCutoffIssued> {
    const ticket = signGitvaultObject({ format: GITVAULT_FORMAT, object_kind: "retention_cutoff" as const, suite: GITVAULT_SUITE, repo_id, object_id: newGitvaultId("rc"), service_key_id: "sk_test-1", base_head_sha256, cutoff_at: formatGitvaultTimestamp(), expires_at: formatGitvaultTimestamp(new Date(Date.now() + 3600_000)), authorization_epoch: this.authorizationEpoch }, this.service.seed) as GitvaultRetentionCutoff;
    const bytes = new TextEncoder().encode(JSON.stringify(ticket));
    this.objects.set(this.key(repo_id, gitvaultPaths.cutoffTicket(ticket.object_id)), bytes);
    return { ticket, receipt: { object_id: ticket.object_id, object_kind: "retention_cutoff", stored_bytes_sha256: sha256Hex(bytes), size_bytes: String(bytes.length) } };
  }

  // ── §6.5 token exchange: only from a non-null digest that matches the operation row ──
  async exchangeActivationToken({ repo_id, operation_id, capture_receipt }: { repo_id: string; operation_id: string; capture_receipt: GitvaultCaptureReceipt }): Promise<GitvaultActivationToken> {
    this.calls.push("mint");
    if (this.refuseTokenOnce) { const c = this.refuseTokenOnce; this.refuseTokenOnce = null; throw err(c, "token mint refused"); }
    const op = this.operations.get(operation_id);
    if (!op) throw err("GITVAULT_ACCESS_DENIED", "unknown operation");
    if (capture_receipt.apply_plan_sha256 === null) throw err("GITVAULT_TOKEN_NOT_MINTABLE", "no token is mintable from a null plan digest");
    if (capture_receipt.repo_id !== repo_id || capture_receipt.capture_id !== op.capture_id || capture_receipt.apply_plan_sha256 !== op.apply_plan_sha256 || capture_receipt.snapshot_oid_hmac !== op.snapshot_oid_hmac) throw err("GITVAULT_TOKEN_BINDING_MISMATCH", "receipt does not bind the operation row");
    if (capture_receipt.authorization_epoch !== this.authorizationEpoch) throw err("AUTHORIZATION_EPOCH_STALE", "stale epoch");
    return signGitvaultObject({
      format: GITVAULT_FORMAT, object_kind: "activation_token" as const, suite: GITVAULT_SUITE, repo_id, object_id: newGitvaultId("ct"), service_key_id: "sk_test-1", operation_id,
      generation: capture_receipt.generation, head_sha256: capture_receipt.head_sha256, capture_id: op.capture_id, apply_plan_sha256: op.apply_plan_sha256, snapshot_oid_hmac: op.snapshot_oid_hmac,
      issued_at: formatGitvaultTimestamp(), authorization_epoch: this.authorizationEpoch,
    }, this.service.seed) as GitvaultActivationToken;
  }

  /** Atomic + idempotent consumption (the apply-activation side, modelled for the fake lane). */
  consumeToken(token: GitvaultActivationToken, operationId: string): void {
    const prior = this.consumedTokens.get(token.object_id);
    if (prior !== undefined) {
      if (prior === operationId) return; // idempotent same-operation replay = a READ of the terminal state
      throw err("GITVAULT_TOKEN_CONSUMED", "token consumed by a different operation");
    }
    if (token.authorization_epoch !== this.authorizationEpoch) throw err("AUTHORIZATION_EPOCH_STALE", "stale epoch");
    this.consumedTokens.set(token.object_id, operationId);
    const op = this.operations.get(operationId);
    if (op) op.activated_with = token.object_id;
  }

  async submitOverrideCompletion({ repo_id, operation_id, capture_receipt }: { repo_id: string; operation_id: string; capture_receipt: GitvaultCaptureReceipt }): Promise<{ cleared: boolean }> {
    this.calls.push("override-completion");
    const op = this.operations.get(operation_id);
    if (!op || !op.override) throw err("GITVAULT_ACCESS_DENIED", "no unvaulted operation to complete");
    const headBytes = this.objects.get(this.key(repo_id, gitvaultPaths.head(capture_receipt.generation)));
    const equal = capture_receipt.repo_id === repo_id && capture_receipt.capture_id === op.capture_id && capture_receipt.apply_plan_sha256 === op.apply_plan_sha256 && capture_receipt.snapshot_oid_hmac === op.snapshot_oid_hmac && headBytes !== undefined && sha256Hex(headBytes) === capture_receipt.head_sha256;
    if (!equal) return { cleared: false };
    op.override.cleared = true;
    return { cleared: true };
  }

  // ── control-plane reads + the maintenance lease (5.6c) ──
  vaultRecord: Partial<GitvaultVaultRecord> = {};
  leases = new Map<string, { holder_token: string; released: boolean }>();
  /** `org_id -> directory rows` — gitvault-human-envelopes task 4.1's org encryption-key directory (`GET /orgs/v1/:org_id/encryption-keys`). Tests set this directly. */
  orgEncryptionKeys = new Map<string, GitvaultOrgEncryptionKeyEntry[]>();

  async listOrgEncryptionKeys({ org_id }: { org_id: string }): Promise<GitvaultOrgEncryptionKeyDirectory> {
    this.calls.push("org-encryption-keys");
    return { org_id, keys: this.orgEncryptionKeys.get(org_id) ?? [] };
  }

  /**
   * Derives the covering fingerprints from `envelopes/<epoch>/<fp>` (genesis/
   * ADD-workaround) AND `envelopes/<epoch>/<rotation_id>/<fp>` (D195,
   * rotation-attempt) objects actually stored for this repo — the SAME
   * source the real gateway route (`listVaultEnvelopeFingerprints`) reads
   * from. Additively carries `desired[]`/`desired_state_version` (D5, then
   * D194's H-partition input) when a test has configured them for this
   * vault's org — absent (not empty) otherwise, matching the real gateway's
   * older-gateway-compat contract.
   */
  async listEnvelopeRecipients({ repo_id }: { repo_id: string }): Promise<GitvaultEnvelopeRecipientsResponse> {
    this.calls.push("envelope-recipients");
    const prefix = this.key(repo_id, "envelopes/");
    const fingerprints = new Set<string>();
    for (const k of this.objects.keys()) {
      if (!k.startsWith(prefix)) continue;
      const parts = k.slice(prefix.length).split("/");
      if (parts.length === 2 && parts[1]) fingerprints.add(parts[1]); // envelopes/<epoch>/<fp>
      if (parts.length === 3 && parts[2]) fingerprints.add(parts[2]); // envelopes/<epoch>/<rotation_id>/<fp>
    }
    const owner = this.repoOwners.get(repo_id) ?? this.pendingOwners.get(repo_id);
    const orgId = owner?.orgId ?? "org_memory";
    const desired = this.desiredRecipients.get(orgId);
    return {
      vault_id: repo_id,
      recipient_fingerprints: [...fingerprints].sort(),
      ...(desired ? { desired } : {}),
      ...(this.desiredStateVersions.has(orgId) ? { desired_state_version: this.desiredStateVersions.get(orgId) } : {}),
    };
  }

  async getVaultRecord({ repo_id }: { repo_id: string }): Promise<GitvaultVaultRecord> {
    this.calls.push("vault-record");
    // `key()` joins with `/`, never `|` (see the `findVaultByProject` comment
    // above this class about the same class of bug) — this filter used the
    // wrong separator and so `generations` (hence `newest_generation`) was
    // ALWAYS empty/null from this method regardless of admitted history;
    // harmless while nothing read `newest_generation` off an unpatched
    // record, but `getState` (gitvault-composite-state-read task 4.4) needs
    // it correct.
    const generations = [...this.objects.keys()].filter((k) => k.startsWith(this.key(repo_id, "head/"))).map((k) => k.slice(this.key(repo_id, "head/").length)).sort();
    // The REAL owner, when this fixture created the repo via `allocate()` —
    // matters once a single transport instance holds more than one repo
    // (D6 push-to-create tests); falls back to the historical single-vault
    // default for every test that hand-rolled a `repo_id` without going
    // through `allocate()`.
    const owner = this.repoOwners.get(repo_id);
    return {
      repo_id, project_id: owner?.projectId ?? "prj_memory", org_id: owner?.orgId ?? "org_memory",
      gitvault_policy: "required", gitvault_policy_version: "1", gitvault_policy_changed_at: null,
      allocation_generation: "1", allocation_sha256: null,
      newest_generation: generations.at(-1) ?? null, genesis_admitted_at: null, latest_effective_admitted_at: null,
      admitted_generations: String(generations.length), gc_epoch: "0", repair_version: "0", repair_fence_state: "none",
      storage: { source_bytes: "0", open_session_reserved_bytes: "0", objects: {} },
      maintenance: { lease: null, open_cycle: null, pending_repair_attempt_id: null },
      warnings: [], created_at: null,
      ...this.vaultRecord,
    };
  }

  /**
   * `GET …/state` (gitvault-composite-state-read task 4.4) — the pin-current
   * fast path, modelled directly over this fixture's own storage: the newest
   * generation's head bytes plus its two carriers, verbatim from `this.objects`
   * (which already holds ciphertext exactly as the real bucket would). Always
   * the "inline" arm — this fixture has no presigned-URL concept and the
   * counted-budget tests never exercise oversize carriers (see the test-
   * helper's own doc comment: `getState` costs the Proxy's default 1 op
   * regardless of arm, so nothing here needs to model the URL arm to keep
   * those tests honest).
   *
   * `newest_generation` here can be the GENESIS generation itself, not just
   * `null` — this fixture's own `admitGenesis` stores genesis at the SAME
   * `head/<generation>` path an ordinary head uses, so a vault between
   * "genesis admitted" and "first ordinary push" reports its own generation
   * as newest. Genesis is a DIFFERENT stored-object shape (`vault_genesis` —
   * no `ref_state`/`retention_roots`), so that case is treated identically
   * to `null` (no ordinary head yet) rather than parsed as a head.
   */
  /** gitvault-delta-fetch: set true to simulate a gateway that predates the delta arm. */
  deltaDisabled = false;

  async getState({ repo_id, since }: { repo_id: string; since?: string }): Promise<GitvaultVaultState> {
    this.calls.push("state");
    const vault = await this.getVaultRecord({ repo_id });
    if (vault.newest_generation === null || vault.newest_generation === GITVAULT_GENESIS_GENERATION) {
      return { vault, newest_generation: vault.newest_generation, head: null, carriers: null };
    }
    const headBytes = this.objects.get(this.key(repo_id, gitvaultPaths.head(vault.newest_generation)));
    if (!headBytes) throw err("CHAIN_BROKEN", `no stored bytes for generation ${vault.newest_generation}`);
    // LENIENT `JSON.parse` here, mirroring the REAL gateway's `getVaultState`
    // (`services/gitvault/reads.ts`): it locates the head's OWN
    // ref_state/retention_roots receipts with a plain parse, never
    // `parseGitvaultStrict`'s canonical-form check — the client is the sole
    // strict verifier, downstream of this call. Using the strict parser here
    // would make a byte-tampered head throw `GITVAULT_STRICT_PARSE` from
    // INSIDE the transport, before the SDK's own hash-check-before-parse
    // ordering ({@link GitvaultVault.tryStateFastPath}) ever gets a chance to
    // report the CORRECT `CHAIN_BROKEN`.
    let headJson: { ref_state?: { object_id?: unknown }; retention_roots?: { object_id?: unknown } };
    try {
      headJson = JSON.parse(new TextDecoder().decode(headBytes)) as typeof headJson;
    } catch {
      throw err("CHAIN_BROKEN", "the newest head's stored bytes are not valid JSON");
    }
    const refStateId = headJson.ref_state?.object_id;
    const retentionRootsId = headJson.retention_roots?.object_id;
    if (typeof refStateId !== "string" || typeof retentionRootsId !== "string") {
      throw err("CHAIN_BROKEN", "the newest head carries no ref_state/retention_roots receipt");
    }
    const refState = this.objects.get(this.key(repo_id, gitvaultPaths.refState(refStateId))) ?? null;
    const retentionRoots = this.objects.get(this.key(repo_id, gitvaultPaths.retentionRoots(retentionRootsId))) ?? null;
    // gitvault-delta-fetch: mirror the gateway's delta arm — a qualifying
    // `since` span (small, no checkpoint/transition heads) rides back as
    // heads + inline WAL packs; every disqualification just omits `delta`.
    let delta: GitvaultVaultState["delta"];
    if (since !== undefined && !this.deltaDisabled && /^[0-9a-f]{16}$/.test(since)) {
      const sinceBig = BigInt(`0x${since}`);
      const newestBig = BigInt(`0x${vault.newest_generation}`);
      const span = newestBig - sinceBig;
      if (span >= 1n && span <= 4n) {
        const heads: Array<{ generation: string; stored_bytes: Uint8Array; stored_bytes_sha256: string }> = [];
        const packs: Array<{ object_id: string; bytes: Uint8Array }> = [];
        let qualified = true;
        for (let g = sinceBig + 1n; g <= newestBig; g += 1n) {
          const generation = g.toString(16).padStart(16, "0");
          const bytes = this.objects.get(this.key(repo_id, gitvaultPaths.head(generation)));
          if (!bytes) {
            qualified = false;
            break;
          }
          let parsed: { checkpoint?: unknown; transition?: unknown; wal_entries?: Array<{ object_id?: unknown }> };
          try {
            parsed = JSON.parse(new TextDecoder().decode(bytes)) as typeof parsed;
          } catch {
            qualified = false;
            break;
          }
          if (parsed.checkpoint != null || parsed.transition != null) {
            qualified = false;
            break;
          }
          heads.push({ generation, stored_bytes: bytes, stored_bytes_sha256: sha256Hex(bytes) });
          for (const w of parsed.wal_entries ?? []) {
            if (typeof w?.object_id !== "string") continue;
            const packBytes = this.objects.get(this.key(repo_id, gitvaultPaths.wal(w.object_id)));
            if (packBytes) packs.push({ object_id: w.object_id, bytes: packBytes });
          }
        }
        if (qualified) delta = { heads, packs };
      }
    }
    return {
      vault,
      newest_generation: vault.newest_generation,
      head: { stored_bytes: headBytes, stored_bytes_sha256: sha256Hex(headBytes) },
      carriers: { ref_state: refState, retention_roots: retentionRoots },
      ...(delta ? { delta } : {}),
    };
  }

  async findVaultByProject({ project_id }: { project_id: string }): Promise<GitvaultVaultRecord> {
    this.calls.push("find-vault");
    // `key()` joins with `/` (`${repoId}/${path}`), never `|` — this used to
    // split on the wrong separator and return the whole compound key as
    // `repo_id` whenever `vaultRecord.repo_id` was not pre-set by hand.
    const repoId = this.vaultRecord.repo_id ?? this.projectRepoIds.get(project_id) ?? [...this.objects.keys()][0]?.split("/")[0];
    if (!repoId) throw err("RESOURCE_NOT_FOUND", `no gitvault for ${project_id}`);
    return { ...(await this.getVaultRecord({ repo_id: repoId })), project_id };
  }

  /** D6 (task 4.3) — resolve by address-form `org-slug/name`. */
  async findVaultByRepo({ org_slug, repo_name }: { org_slug: string; repo_name: string }): Promise<GitvaultVaultRecord> {
    this.calls.push("find-vault-by-repo");
    const released = this.slugReleased.get(org_slug);
    if (released) throw err("SLUG_RELEASED", `slug "${org_slug}" is in cooldown`, released);
    const entry = this.repoNames.get(`${org_slug}/${repo_name}`);
    if (!entry || entry.projectId === null) throw err("RESOURCE_NOT_FOUND", `no repo at ${org_slug}/${repo_name}`);
    return this.findVaultByProject({ project_id: entry.projectId });
  }

  async acquireMaintenanceLease(request: GitvaultMaintenanceLeaseRequest): Promise<GitvaultMaintenanceLease> {
    this.calls.push("lease-acquire");
    const id = `ml_${"1".repeat(32)}`;
    const holder = "00000000-0000-4000-8000-000000000000";
    this.leases.set(id, { holder_token: holder, released: false });
    return {
      maintenance_lease_id: id, repo_id: request.repo_id, base_head_sha256: request.base_head_sha256,
      current_checkpoint_hash: request.current_checkpoint_hash ?? null,
      reservation_size_bytes: request.r1_size_bytes, maintenance_headroom_bytes: request.r2_cap_size_bytes,
      holder_token: holder, expires_at: null, hard_deadline_at: null,
    };
  }

  async heartbeatMaintenanceLease({ maintenance_lease_id, holder_token }: { repo_id: string; maintenance_lease_id: string; holder_token: string }) {
    this.calls.push("lease-heartbeat");
    const l = this.leases.get(maintenance_lease_id);
    if (!l || l.holder_token !== holder_token || l.released) throw err("MAINTENANCE_LEASE_HELD", "not the holder");
    return { maintenance_lease_id, expires_at: null };
  }

  async releaseMaintenanceLease({ maintenance_lease_id, holder_token }: { repo_id: string; maintenance_lease_id: string; holder_token: string }) {
    this.calls.push("lease-release");
    const l = this.leases.get(maintenance_lease_id);
    if (!l || l.holder_token !== holder_token) throw err("MAINTENANCE_LEASE_HELD", "not the holder");
    l.released = true;
    return { maintenance_lease_id, status: "released" };
  }

  // ── compaction headroom grant (gitvault-checkpoint-cadence design D3) ──
  /** `repo_id -> the active grant`, at most one live at a time (mirrors the gateway's partial-unique-active-per-project index). */
  readonly compactionGrants = new Map<string, GitvaultCompactionGrant>();
  /** Set true to simulate an older gateway that predates this route (404/`ROUTE_NOT_FOUND`). */
  compactionGrantUnsupported = false;
  /** The pooled figures a fresh grant reports — tests set this to model a near-quota org. Defaults model plenty of headroom. */
  compactionGrantPoolFigures: { pool_used_bytes: number; pool_limit_bytes: number } = { pool_used_bytes: 0, pool_limit_bytes: Number.MAX_SAFE_INTEGER };
  /** The `granted_bytes` a fresh grant reports — tests set this to the vault's modeled `source_bytes`. */
  compactionGrantBytes = 0;

  async openCompactionGrant({ repo_id }: { repo_id: string }): Promise<GitvaultCompactionGrant> {
    this.calls.push("compaction-grant-open");
    if (this.compactionGrantUnsupported) throw err("ROUTE_NOT_FOUND", "compaction-grant is not supported by this gateway");
    const existing = this.compactionGrants.get(repo_id);
    if (existing) throw err("GITVAULT_COMPACTION_GRANT_ACTIVE", "a compaction grant is already active for this project", { expires_at: existing.expires_at });
    const grant: GitvaultCompactionGrant = {
      granted_bytes: this.compactionGrantBytes,
      expires_at: "2026-01-01T01:00:00.000Z",
      pool_used_bytes: this.compactionGrantPoolFigures.pool_used_bytes,
      pool_limit_bytes: this.compactionGrantPoolFigures.pool_limit_bytes,
      effective_pool_limit_bytes: this.compactionGrantPoolFigures.pool_limit_bytes + this.compactionGrantBytes,
    };
    this.compactionGrants.set(repo_id, grant);
    return grant;
  }

  async closeCompactionGrant({ repo_id }: { repo_id: string }): Promise<{ closed: boolean }> {
    this.calls.push("compaction-grant-close");
    if (this.compactionGrantUnsupported) throw err("ROUTE_NOT_FOUND", "compaction-grant is not supported by this gateway");
    return { closed: this.compactionGrants.delete(repo_id) };
  }

  // ── prune (§7.3) ──
  /**
   * Submitted intents, keyed by `pi_` id, with the EXACT bytes the client sent.
   * Keeping the bytes (not a parsed object) is the point: the real route
   * strict-parses and signature-verifies them, so a client that re-serialized
   * anywhere between signing and sending must be caught HERE, in a test, and
   * not by a production refusal.
   */
  readonly pruneIntents = new Map<string, { bytes: Uint8Array; record: GitvaultPruneIntentRecord }>();
  /** Per-candidate outcome the next completion should report. Absent ⇒ `deleted`. */
  pruneOutcomes: Record<string, "deleted" | "present_not_attempted" | "present_after_attempt"> = {};
  /** When false, a submitted intent stays uncompleted — the "worker has not run yet" state. */
  pruneCompletesImmediately = true;
  /** Refuse the next submission with this registry code. */
  refusePruneOnce: string | null = null;

  async submitPruneIntent({ repo_id, intent_bytes }: { repo_id: string; intent_bytes: Uint8Array }): Promise<GitvaultPruneIntentRecord & { stored: boolean }> {
    this.calls.push("prune-submit");
    if (this.refusePruneOnce) {
      const code = this.refusePruneOnce;
      this.refusePruneOnce = null;
      throw err(code, `prune intent refused: ${code}`);
    }
    // Strict-parse the EXACT bytes, exactly as the route does. A body that is
    // not byte-identical to its own JCS is a refusal, not a normalization.
    const intent = parseGitvaultStrict(new TextDecoder().decode(intent_bytes)) as {
      object_id: string;
      repo_id: string;
      core: { object_id: string; gc_epoch: string; delete_set: Array<{ object_id: string }> };
      intent_core_sha256: string;
      verifier_receipts: Array<{ object_id: string; implementation_id: string; stored_bytes_sha256: string }>;
    };
    if (intent.repo_id !== repo_id) throw err("GITVAULT_ACCESS_DENIED", "intent repo_id does not match the vault");
    if (intent.object_id !== intent.core.object_id) throw err("UPGRADE_REQUIRED", "wrapper and core disagree on object_id");
    for (const ref of intent.verifier_receipts) {
      // The gateway requires each receipt to be a FINALIZED stored object; the
      // fixture models exactly that precondition and nothing more.
      const stored = this.objects.get(this.key(repo_id, gitvaultPaths.verifierReceipt(ref.object_id)));
      if (!stored) throw err("UPGRADE_REQUIRED", `verifier receipt ${ref.object_id} bytes are not present`);
      if (sha256Hex(stored) !== ref.stored_bytes_sha256) throw err("UPGRADE_REQUIRED", `verifier receipt ${ref.object_id} does not match its ref`);
    }
    const candidateIds = intent.core.delete_set.map((r) => r.object_id);
    const perObject = candidateIds.map((object_id) => ({ object_id, result: this.pruneOutcomes[object_id] ?? ("deleted" as const) }));
    const deleted = perObject.filter((o) => o.result === "deleted");
    const record: GitvaultPruneIntentRecord = {
      object_id: intent.object_id,
      repo_id,
      state: this.pruneCompletesImmediately ? "COMPLETED" : "INTENT_STORED",
      gc_epoch: intent.core.gc_epoch,
      intent_sha256: sha256Hex(intent_bytes),
      intent_core_sha256: intent.intent_core_sha256,
      candidate_count: candidateIds.length,
      next_candidate_index: this.pruneCompletesImmediately ? candidateIds.length : 0,
      maintenance_cycle_id: null,
      maintenance_prune_role: null,
      stage_claim_set_sha256: null,
      batch_index: null,
      batch_count: null,
      completion: this.pruneCompletesImmediately
        ? {
            object_id: `pc_${"a".repeat(32)}`,
            sha256: "b".repeat(64),
            per_object: perObject,
            deleted_count: deleted.length,
            present_after_attempt_count: perObject.filter((o) => o.result === "present_after_attempt").length,
            present_not_attempted_count: perObject.filter((o) => o.result === "present_not_attempted").length,
            gc_epoch_at_completion: intent.core.gc_epoch,
            cycle_event_seq: null,
            completed_at: "2026-08-22T12:00:00.000Z",
          }
        : null,
      prepared_at: "2026-08-22T12:00:00.000Z",
      intent_put_issued_at: "2026-08-22T12:00:00.000Z",
      intent_stored_at: "2026-08-22T12:00:00.000Z",
      deleting_started_at: this.pruneCompletesImmediately ? "2026-08-22T12:00:00.000Z" : null,
    };
    this.pruneIntents.set(intent.object_id, { bytes: intent_bytes, record });
    // Deletion is the gateway's, and it happens to the STORED objects: model it
    // so a test can prove the pruned bytes are actually gone from the bucket.
    if (this.pruneCompletesImmediately) {
      for (const o of deleted) {
        for (const k of [...this.objects.keys()]) {
          if (k.startsWith(this.key(repo_id, "")) && k.includes(o.object_id)) this.objects.delete(k);
        }
      }
    }
    return { ...record, stored: true };
  }

  async getPruneIntent({ prune_intent_object_id }: { repo_id: string; prune_intent_object_id: string }): Promise<GitvaultPruneIntentRecord | null> {
    this.calls.push("prune-read");
    return this.pruneIntents.get(prune_intent_object_id)?.record ?? null;
  }

  // ── epoch rotation (D193-D203, rev 42, §9.2) ──

  /** `POST …/rotation-attempts` (D195) — writer-signature check, then the create-only CAS by content-derived `rotation_id`. */
  async createRotationAttempt({ repo_id, descriptor }: { repo_id: string; descriptor: GitvaultRotationAttemptDescriptor }): Promise<{ rotation_id: string; descriptor: GitvaultRotationAttemptDescriptor; deduplicated: boolean }> {
    this.calls.push("rotation-attempt-create");
    const writerPub = this.signingPubkeyByRepo.get(repo_id);
    if (!writerPub || !verifyGitvaultObject(descriptor as never, writerPub)) throw err("GITVAULT_ACCESS_DENIED", "Not authorized for this vault");
    const { signature: _sig, ...rest } = descriptor as unknown as Record<string, unknown>;
    const rotationId = sha256Hex(jcs(rest));
    const key = `${repo_id}:${rotationId}`;
    const bytes = new TextEncoder().encode(JSON.stringify(descriptor));
    const existing = this.rotationAttempts.get(key);
    if (existing) {
      const same = sha256Hex(existing.bytes) === sha256Hex(bytes);
      if (!same) throw err("ATTEMPT_DESCRIPTOR_CONFLICT", "the declared rotation_id already names a descriptor with different bytes");
      return { rotation_id: rotationId, descriptor: existing.descriptor, deduplicated: true };
    }
    this.rotationAttempts.set(key, { bytes, descriptor });
    return { rotation_id: rotationId, descriptor, deduplicated: false };
  }

  async confirmRecipient({ repo_id, principal_id, new_fingerprint }: { repo_id: string; principal_id: string; new_fingerprint: string }): Promise<GitvaultRecipientConfirmationReceipt> {
    this.calls.push("confirm");
    const manifest = this.effectivePinManifest.get(repo_id);
    return signGitvaultObject({
      format: GITVAULT_FORMAT, object_kind: "recipient_confirmation_receipt" as const, object_id: `rcr_${newHex32()}`, repo_id,
      purpose: "first_pin" as const, principal_id, new_fingerprint, base_pin_manifest_sha256: manifest?.sha256 ?? "0".repeat(64),
      recipient_state_version: "0", issued_at: formatGitvaultTimestamp(), service_key_id: "sk_test-1",
    }, this.service.seed) as GitvaultRecipientConfirmationReceipt;
  }

  async repinRecipient({ repo_id, principal_id, old_ek_fingerprint, new_fingerprint }: { repo_id: string; principal_id: string; old_ek_fingerprint: string; new_fingerprint: string }): Promise<GitvaultRecipientConfirmationReceipt> {
    this.calls.push("repin");
    const manifest = this.effectivePinManifest.get(repo_id);
    return signGitvaultObject({
      format: GITVAULT_FORMAT, object_kind: "recipient_confirmation_receipt" as const, object_id: `rcr_${newHex32()}`, repo_id,
      purpose: "repin" as const, principal_id, new_fingerprint, old_ek_fingerprint, base_pin_manifest_sha256: manifest?.sha256 ?? "0".repeat(64),
      recipient_state_version: "0", issued_at: formatGitvaultTimestamp(), service_key_id: "sk_test-1",
    }, this.service.seed) as GitvaultRecipientConfirmationReceipt;
  }

  async declareRecipientKeyRevoked({ repo_id }: { repo_id: string; principal_id: string }): Promise<{ recipient_state_version: string; recipient_revocation_version: string }> {
    this.calls.push("declare-key-revoked");
    const owner = this.repoOwners.get(repo_id) ?? this.pendingOwners.get(repo_id);
    const c = this.counters(owner?.orgId ?? "org_memory");
    c.state += 1n;
    c.revocation += 1n;
    return { recipient_state_version: c.state.toString(), recipient_revocation_version: c.revocation.toString() };
  }

  async declareEpochSecretExposed({ repo_id }: { repo_id: string }): Promise<{ epoch_secret_exposure_version: string }> {
    this.calls.push("declare-exposure");
    let e = this.epochSecretExposure.get(repo_id);
    if (!e) { e = { version: 0n, clearedThrough: 0n }; this.epochSecretExposure.set(repo_id, e); }
    e.version += 1n;
    return { epoch_secret_exposure_version: e.version.toString() };
  }

  async declareWriterAuthorityUnavailable({ repo_id: _repo_id }: { repo_id: string }): Promise<{ declared_at: string; declared_by: string | null }> {
    this.calls.push("declare-writer-unavailable");
    return { declared_at: formatGitvaultTimestamp(), declared_by: null };
  }

  /** `ror_` receipts already minted, keyed by the D206/D210 idempotency tuple `repo_id|principal_id|ek_fingerprint|decryptable_to_generation`. */
  readonly openReceipts = new Map<string, GitvaultOpenReceipt>();

  /**
   * D210 (rev 44) — models the SAME checks `services/gitvault/open-receipts.ts`'s
   * `submitOpenProof` runs server-side: `decryptable_to_generation <=` the
   * newest COMMITTED generation, `chain_verified_to_generation >=
   * decryptable_to_generation` (both fixed-width hex16, so a plain string
   * compare orders them correctly), and `ek_fingerprint` names a live
   * `key_envelope` object on the vault (genesis-shaped `envelopes/<epoch>/<fp>`
   * OR rotation-shaped `envelopes/<epoch>/<rotation_id>/<fp>` — both end
   * with `/<fp>`). Idempotent on the full tuple, mirroring D206's
   * `(xmax = 0)` linearization: an exact-tuple replay returns the ORIGINAL
   * receipt with `deduplicated: true`.
   */
  async submitOpenProof({
    repo_id, principal_id, ek_fingerprint, chain_verified_to_generation, decryptable_to_generation, reader_entrypoint,
  }: {
    repo_id: string; principal_id: string; ek_fingerprint: string; chain_verified_to_generation: string; decryptable_to_generation: string; reader_entrypoint: string;
  }): Promise<{ receipt: GitvaultOpenReceipt; deduplicated: boolean }> {
    this.calls.push("submit-open-proof");
    const tupleKey = `${repo_id}|${principal_id}|${ek_fingerprint}|${decryptable_to_generation}`;
    const existing = this.openReceipts.get(tupleKey);
    if (existing) return { receipt: existing, deduplicated: true };
    if (chain_verified_to_generation < decryptable_to_generation) {
      throw err("OPEN_PROOF_MISMATCH", "chain_verified_to_generation is below decryptable_to_generation — fsck can never report that ordering");
    }
    // this.newestGeneration is the SAME helper admitHead's own generation-CAS
    // check uses — genesis (head/0000000000000000) always counts, so this
    // never reports "no committed generation" the way a bare key-scan default
    // could; a fresh repo's floor is genesis, not absence.
    const newestGeneration = this.newestGeneration(repo_id);
    if (decryptable_to_generation > newestGeneration) {
      throw err("OPEN_PROOF_MISMATCH", "decryptable_to_generation exceeds the vault's newest committed generation");
    }
    const envelopePrefix = `${repo_id}/envelopes/`;
    const envelopeSuffix = `/${ek_fingerprint}`;
    const hasLiveEnvelope = [...this.objects.keys()].some((k) => k.startsWith(envelopePrefix) && k.endsWith(envelopeSuffix));
    if (!hasLiveEnvelope) {
      throw err("OPEN_PROOF_MISMATCH", "ek_fingerprint names no live key_envelope on this vault");
    }
    const receipt = signGitvaultObject({
      format: GITVAULT_FORMAT, object_kind: "recipient_open_receipt" as const, object_id: `ror_${newHex32()}`, repo_id,
      principal_id, ek_fingerprint, chain_verified_to_generation, decryptable_to_generation, reader_entrypoint,
      source: "recipient_submission" as const, issued_at: formatGitvaultTimestamp(), service_key_id: "sk_test-1",
    }, this.service.seed) as GitvaultOpenReceipt;
    this.openReceipts.set(tupleKey, receipt);
    return { receipt, deduplicated: false };
  }
}

// ─── Shared fixtures ─────────────────────────────────────────────────────────

export async function git(dir: string, args: string[], input?: string): Promise<string> {
  return (await hardenedGit(dir, args, input !== undefined ? { input } : {})).text().trim();
}

/** A fresh working repository with one commit on `main`. Returns the REAL path — git reports
 * `--show-toplevel` resolved, and on macOS `/var/folders/...` is a symlink to `/private/var/...`. */
export async function makeRepo(root: string, name = "repo"): Promise<string> {
  mkdirSync(join(root, name), { recursive: true });
  const dir = realpathSync(join(root, name));
  await git(dir, ["init", "-q", "-b", "main", "."]);
  writeFileSync(join(dir, "README.md"), "hello\n");
  await git(dir, ["add", "README.md"]);
  await git(dir, ["commit", "-q", "-m", "init"]);
  return dir;
}

export async function commitFile(dir: string, file: string, content: string, message = `edit ${file}`): Promise<string> {
  mkdirSync(join(dir, file, ".."), { recursive: true });
  writeFileSync(join(dir, file), content);
  await git(dir, ["add", file]);
  await git(dir, ["commit", "-q", "-m", message]);
  return git(dir, ["rev-parse", "HEAD"]);
}

export interface VaultFixture {
  root: string;
  keystore: GitvaultKeystore;
  transport: GitvaultMemoryTransport;
  repoDir: string;
  repoId: string;
  vault: GitvaultVault;
}

/** Keystore + memory control plane + a created (ACTIVE) vault + a local repo. */
export async function makeVault(root?: string): Promise<VaultFixture> {
  const r = root ?? mkdtempSync(join(tmpdir(), "run402-gitvault-fixture-"));
  const keystore = GitvaultKeystore.open({ rootDir: join(r, "ks") });
  const transport = new GitvaultMemoryTransport();
  const repoDir = await makeRepo(r);
  const created = await createGitvault({ keystore, transport, org_id: "org_1", project_id: "proj_1", service_public_key: transport.service.public_key });
  const vault = GitvaultVault.open({ keystore, transport, repo_id: created.repo_id, repo_dir: repoDir });
  return { root: r, keystore, transport, repoDir, repoId: created.repo_id, vault };
}

describe("gitvault memory transport (fixture self-check)", () => {
  it("lists nothing above the genesis on a fresh vault", async () => {
    const t = new GitvaultMemoryTransport();
    t.objects.set("src_x/head/0000000000000000", new Uint8Array([1]));
    const page = await t.listHeads({ repo_id: "src_x", after_generation: "0000000000000000", limit: "10" });
    assert.deepEqual(page.heads, []);
    assert.equal(page.has_more, false);
    assert.equal(page.next_cursor, null);
    assert.equal(page.total, "0");
  });
});
