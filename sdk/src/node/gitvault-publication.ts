/**
 * gitvault — publication (protocol rev 41 §6 + §4.4–4.7 + §5A client side;
 * task 5.4).
 *
 * What lives here:
 *   - the PURE evaluators: ref transactions (§6.1 — force-with-lease only,
 *     fast-forward for non-force branch updates, immutable tags, deletes need
 *     expected-old, pairwise-distinct refs refused BEFORE evaluation, the
 *     §6.5 cardinality bounds), retention-root evolution (§4.5 — map keyed
 *     `(ref, oid)`, renewal, expiry ONLY at checkpoints against the pre-signing
 *     cutoff ticket, strict `effective + 90d < cutoff_at`), the heads-listing
 *     page contract (§6.3 / D186 — anchor echo, cursor echo, has_more/
 *     next_cursor coupling, strictly-above-anchor, gapless across pages,
 *     truthful total), chain linkage (`CHAIN_BROKEN`), and the transition
 *     fail-closed rule (`UPGRADE_REQUIRED`);
 *   - {@link GitvaultTransport} — the control-plane + bucket operations the
 *     vault needs (extends task 5.3's creation transport) — and
 *     {@link createGitvaultHttpTransport}, the `fetch`-backed implementation
 *     over the SDK kernel (upload sessions → presigned PUT with
 *     `If-None-Match: *` → finalize);
 *   - {@link GitvaultVault} — discover/verify to newest with the RESUMABLE
 *     verification budget, materialize (decrypt ref_state + retention_roots →
 *     the materialized pin), push (pack_set or a checkpoint-bearing head when
 *     the delta exceeds the 64-receipt budget, upload with receipt-compare,
 *     admission with 409 re-apply-and-retry, head read-back before any pin
 *     advances), checkpoint build + acceptance self-check, and repair (the
 *     mandatory fresh checkpoint + the exact repair-root algebra).
 *
 * Dual pins (§6.4) live in the keystore repo file: `head_pin` is
 * `highest_authenticated`, `materialized_pin` is `highest_materialized` — the
 * ONLY push base. A regression below the authenticated pin is
 * `GENERATION_REGRESSION`; an authenticated-but-undecryptable head is
 * `CHAIN_UNUSABLE` (read-only at the materialized pin); an admitted non-null
 * transition is `UPGRADE_REQUIRED` (read-only past it, no publish).
 */

import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalError, isRun402Error } from "../errors.js";
import type { Client } from "../kernel.js";
import {
  GITVAULT_FORMAT,
  GITVAULT_GENESIS_EPOCH,
  GITVAULT_GENESIS_GENERATION,
  GITVAULT_HEX16_RE,
  GITVAULT_OID40_RE,
  GITVAULT_SUITE,
  attemptKeyCommitment,
  bytesToHex,
  checkFreshEpochKeyAgainstPriorKeys,
  checkHPartition,
  computeRotationId,
  computeTargetPartitionDigest,
  deriveDigestKey,
  deriveObjectKey,
  ekFingerprint,
  epochRotationKeyCommitment,
  formatGitvaultTimestamp,
  fromBase64url,
  hexToBytes,
  jcs,
  keyEnvelopeLedgerId,
  keyedCommitment,
  newGitvaultId,
  newHex32,
  nextEpoch,
  objectsetContent,
  openBindingPreimage,
  openFrame,
  openKeyEnvelope,
  parseGitvaultStrict,
  pinManifestLedgerId,
  randomBytes,
  sealFrame,
  sealKeyEnvelope,
  sha256Hex,
  signGitvaultObject,
  storedBytes,
  storedBytesSha256,
  toBase64url,
  verifyGitvaultObject,
} from "../namespaces/gitvault.crypto.js";
import { GITVAULT_ZERO_SHA256_SENTINEL } from "../namespaces/gitvault.types.js";
import type {
  GitvaultActivationToken,
  GitvaultAllocation,
  GitvaultCaptureBinding,
  GitvaultCaptureReceipt,
  GitvaultCheckpointBlock,
  GitvaultCheckpointClaimSet,
  GitvaultCheckpointManifest,
  GitvaultCheckpointManifestPack,
  GitvaultCheckpointPackReceipt,
  GitvaultDigestLabel,
  GitvaultHead,
  GitvaultHeadTarget,
  GitvaultHeadsListingPage,
  GitvaultHeadsListingRequest,
  GitvaultPinManifestReceipt,
  GitvaultRecipientConfirmationReceipt,
  GitvaultRecipientPinManifestEntry,
  GitvaultRefState,
  GitvaultRefTransaction,
  GitvaultRefUpdate,
  GitvaultRepairDescriptor,
  GitvaultRetentionCutoff,
  GitvaultRetentionCutoffReceipt,
  GitvaultRetentionRoot,
  GitvaultRetentionRoots,
  GitvaultRetentionRootsReceipt,
  GitvaultRotateEpochPayload,
  GitvaultRotationAttemptDescriptor,
  GitvaultRotationEnvelopePair,
  GitvaultRotationReason,
  GitvaultSignedObject,
  GitvaultSigningKeypair,
  GitvaultTransitionEnvelope,
  GitvaultVaultGenesis,
  GitvaultWalPackReceipt,
} from "../namespaces/gitvault.types.js";
import type {
  GitvaultAdmitGenesisRequest,
  GitvaultAdmitGenesisResult,
  GitvaultAllocateRequest,
  GitvaultCreationTransport,
  GitvaultObjectReceipt,
  GitvaultPutObjectRequest,
} from "./gitvault-creation-journal.js";
import { GitvaultKeystore, type GitvaultHeadPin, type GitvaultRepoFile } from "./gitvault-keystore.js";
import { crossProfileGitvaultHint } from "./gitvault-profile-scan.js";
// Type-only: erased at build, so the prune module stays a LEAF (it imports the
// crypto core and nothing from here) and no runtime import cycle exists.
import type { GitvaultPruneIntentRecord } from "./gitvault-prune.js";
import { GITVAULT_DEPLOY_REF, hardenedGit, hasObject, isAncestor } from "./gitvault-snapshot.js";

// ─── Constants (constants.json) ──────────────────────────────────────────────

export const GITVAULT_MAX_CANONICAL_REFS = 10_000;
export const GITVAULT_MAX_REF_UPDATES_PER_TRANSACTION = 1_000;
export const GITVAULT_MAX_RETENTION_ROOT_ENTRIES = 50_000;
export const GITVAULT_MAX_REPAIR_ADDED_ROOTS = 10_000;
export const GITVAULT_MAX_WAL_RECEIPTS_PER_HEAD = 64;
export const GITVAULT_MAX_CHECKPOINT_PACKS = 4_096;
export const GITVAULT_MAX_CHECKPOINT_TOTAL_STORED_BYTES = 858_993_459_200n;
export const GITVAULT_MULTI_OBJECT_PACK_TARGET_BYTES = 201_326_592;
export const GITVAULT_MAX_REF_STATE_OBJECT_BYTES = 33_554_432;
export const GITVAULT_MAX_HEADS_PER_LISTING_PAGE = 1_000;
export const GITVAULT_VERIFICATION_BUDGET_HEADS = 100_000;
export const GITVAULT_RETENTION_MIN_DAYS = 90;
/** Default admission-conflict retries before the push gives up (each retry re-verifies + re-applies to the winner). */
export const GITVAULT_PUSH_CONFLICT_RETRIES = 5;

const CANONICAL_REF_RE = /^(?!.*\.\.)(?!.*\/\/)(?!.*@\{)refs\/(heads|tags|run402)\/[^\u0000-\u0020\u007f~^:?*[\\]+$/;
const BRANCH_REF_RE = /^(?!.*\.\.)(?!.*\/\/)(?!.*@\{)refs\/heads\/[^\u0000-\u0020\u007f~^:?*[\\]+$/;
const CURSOR_RE = /^[A-Za-z0-9_-]{1,256}$/;
const LIMIT_RE = /^([1-9]|[1-9][0-9]|[1-9][0-9][0-9]|1000)$/;

function fail(code: string, message: string, context: string, details?: unknown, nextActions?: unknown[]): never {
  throw new LocalError(message, context, { code, details, ...(nextActions ? { next_actions: nextActions } : {}) });
}

// ─── Generations ─────────────────────────────────────────────────────────────

export function generationToBigInt(generation: string): bigint {
  if (!GITVAULT_HEX16_RE.test(generation)) fail("CHAIN_BROKEN", `malformed generation: ${generation}`, "parsing generation");
  return BigInt(`0x${generation}`);
}

export function bigIntToGeneration(value: bigint): string {
  if (value < 0n || value > 0xffffffffffffffffn) fail("CHAIN_BROKEN", "generation out of range", "formatting generation");
  return value.toString(16).padStart(16, "0");
}

export function nextGeneration(generation: string): string {
  return bigIntToGeneration(generationToBigInt(generation) + 1n);
}

// ─── §6.1 Ref transactions (pure) ────────────────────────────────────────────

export type GitvaultRefMap = Record<string, string>;

/** A tip that left the canonical map in this transaction — it enters `retention_roots` in the same generation. */
export interface GitvaultDroppedTip {
  ref: string;
  oid: string;
  reason: "deleted" | "force_displaced";
}

export interface GitvaultRefTransactionEvaluation {
  refs: GitvaultRefMap;
  dropped: GitvaultDroppedTip[];
}

export interface GitvaultEvaluateRefTransactionOptions {
  /** Ancestry oracle: true iff `ancestor` is reachable from `descendant`. */
  isAncestor: (ancestor: string, descendant: string) => Promise<boolean> | boolean;
  /** `refuse` (default — user pushes): any `refs/run402/*` update is refused; `allow`: the protocol's own deploy-ref move. */
  protocol_refs?: "refuse" | "allow";
}

/** One failing update of a refused transaction (never a silent revert). */
export interface GitvaultRefUpdateFailure {
  ref: string;
  reason: "expected_old_mismatch" | "non_fast_forward" | "tag_immutable" | "delete_requires_expected_old" | "noop";
  expected_old_oid: string | null;
  current_oid: string | null;
}

/**
 * Evaluate a §6.1 transaction against the materialized map. Refusals in
 * order: pairwise-distinct refs (before evaluation), grammar, the update cap,
 * then per-update semantics collected into ONE `REF_EXPECTED_OLD_MISMATCH`
 * (every failing update listed), then the resulting-state cardinality.
 */
export async function evaluateRefTransaction(current: GitvaultRefMap, transaction: GitvaultRefTransaction, options: GitvaultEvaluateRefTransactionOptions): Promise<GitvaultRefTransactionEvaluation> {
  const updates = transaction.updates;
  if (!Array.isArray(updates) || updates.length === 0) fail("REF_TRANSACTION_INVALID", "a ref transaction needs at least one update", "evaluating ref transaction");
  if (updates.length > GITVAULT_MAX_REF_UPDATES_PER_TRANSACTION) {
    fail("REF_STATE_LIMIT_EXCEEDED", `${updates.length} updates exceed the ${GITVAULT_MAX_REF_UPDATES_PER_TRANSACTION}-update transaction bound`, "evaluating ref transaction", { updates: updates.length, bound: GITVAULT_MAX_REF_UPDATES_PER_TRANSACTION });
  }
  const seen = new Set<string>();
  for (const u of updates) {
    if (seen.has(u.ref)) fail("REF_TRANSACTION_DUPLICATE_REF", `two updates name ${u.ref}; a transaction must name pairwise-distinct refs (refused before evaluation, never last-wins)`, "evaluating ref transaction", { ref: u.ref });
    seen.add(u.ref);
  }
  for (const u of updates) {
    if (!CANONICAL_REF_RE.test(u.ref)) fail("REFNAME_UNSUPPORTED", `${JSON.stringify(u.ref)} is not a canonical refs/heads|tags|run402 name`, "evaluating ref transaction", { ref: u.ref });
    if (u.ref.startsWith("refs/run402/") && (options.protocol_refs ?? "refuse") === "refuse") {
      fail("REFNAME_UNSUPPORTED", `${u.ref} is protocol-owned (refs/run402/*); user pushes to it are refused`, "evaluating ref transaction", { ref: u.ref });
    }
    if (u.expected_old_oid !== null && !GITVAULT_OID40_RE.test(u.expected_old_oid)) fail("REF_TRANSACTION_INVALID", `expected_old_oid for ${u.ref} is not a 40-hex oid`, "evaluating ref transaction", { ref: u.ref });
    if (u.new_oid !== null && !GITVAULT_OID40_RE.test(u.new_oid)) fail("REF_TRANSACTION_INVALID", `new_oid for ${u.ref} is not a 40-hex oid`, "evaluating ref transaction", { ref: u.ref });
    if (u.new_oid === null && u.expected_old_oid === null) fail("REF_TRANSACTION_INVALID", `${u.ref}: a delete requires expected_old_oid`, "evaluating ref transaction", { ref: u.ref });
  }
  const failures: GitvaultRefUpdateFailure[] = [];
  const next: GitvaultRefMap = { ...current };
  const dropped: GitvaultDroppedTip[] = [];
  for (const u of updates) {
    const cur = current[u.ref] ?? null;
    if (cur !== u.expected_old_oid) {
      failures.push({ ref: u.ref, reason: "expected_old_mismatch", expected_old_oid: u.expected_old_oid, current_oid: cur });
      continue;
    }
    if (u.new_oid === null) {
      // delete — expected-old already matched and is non-null by grammar
      delete next[u.ref];
      dropped.push({ ref: u.ref, oid: cur!, reason: "deleted" });
      continue;
    }
    if (cur === null) { next[u.ref] = u.new_oid; continue; } // creation (the only null-expected-old case)
    if (cur === u.new_oid) continue; // no-op update — legal, nothing dropped
    const isTag = u.ref.startsWith("refs/tags/");
    if (isTag && !u.force) { failures.push({ ref: u.ref, reason: "tag_immutable", expected_old_oid: u.expected_old_oid, current_oid: cur }); continue; }
    const ff = isTag ? false : await options.isAncestor(cur, u.new_oid);
    if (!u.force && !ff) { failures.push({ ref: u.ref, reason: "non_fast_forward", expected_old_oid: u.expected_old_oid, current_oid: cur }); continue; }
    next[u.ref] = u.new_oid;
    if (!ff) dropped.push({ ref: u.ref, oid: cur, reason: "force_displaced" });
  }
  if (failures.length > 0) {
    fail("REF_EXPECTED_OLD_MISMATCH", `${failures.length} update(s) refused: ${failures.map((f) => `${f.ref} (${f.reason})`).join(", ")}`, "evaluating ref transaction", { failures }, [{ action: "refetch, reapply the transaction to the winner's map, retry" }]);
  }
  assertRefMapCardinality(next);
  return { refs: next, dropped };
}

/** §6.5 bound: ≤ 10 000 canonical refs and the serialized map ≤ 32 MiB. */
export function assertRefMapCardinality(refs: GitvaultRefMap): void {
  const n = Object.keys(refs).length;
  if (n > GITVAULT_MAX_CANONICAL_REFS) fail("REF_STATE_LIMIT_EXCEEDED", `${n} canonical refs exceed the ${GITVAULT_MAX_CANONICAL_REFS} bound`, "checking ref-state cardinality", { refs: n });
  if (jcs(refs).length > GITVAULT_MAX_REF_STATE_OBJECT_BYTES) fail("REF_STATE_LIMIT_EXCEEDED", "the serialized ref map exceeds 32 MiB", "checking ref-state cardinality");
}

/** The §4.4 deploy-ref move: force-with-lease `refs/run402/deploys/latest` → `oid` (creation when absent). */
export function deployRefTransaction(current: GitvaultRefMap, oid: string): GitvaultRefTransaction {
  const old = current[GITVAULT_DEPLOY_REF] ?? null;
  return { updates: [{ ref: GITVAULT_DEPLOY_REF, expected_old_oid: old, new_oid: oid, force: old !== null }] };
}

// ─── §4.5 Retention roots (pure) ─────────────────────────────────────────────

/** `effective_admitted_at = max(prepared_at, storage creation time of the winning admission record)` (§4.10). */
export function effectiveAdmittedAt(preparedAt: string, recordStorageCreatedAt: string): string {
  return Date.parse(preparedAt) >= Date.parse(recordStorageCreatedAt) ? preparedAt : recordStorageCreatedAt;
}

/** A root may be removed iff `effective_admitted_at + 90 days < cutoff_at` (STRICT; §4.5a). */
export function isRootEligibleForRemoval(effectiveAdmittedAtIso: string, cutoffAtIso: string, retentionDays = GITVAULT_RETENTION_MIN_DAYS): boolean {
  const expiry = Date.parse(effectiveAdmittedAtIso) + retentionDays * 24 * 60 * 60 * 1000;
  return expiry < Date.parse(cutoffAtIso);
}

export interface GitvaultEvolveRootsOptions {
  /** The generation being built (`g+1`) — stamped as `dropped_at_generation` on new/renewed keys. */
  generation: string;
  /** Tips dropped or force-displaced by this generation's transaction. */
  dropped: Array<{ ref: string; oid: string }>;
  /**
   * Present ONLY when this generation carries a checkpoint bound to a cutoff
   * ticket: expiry is evaluated against `cutoff_at` using the resolver for each
   * root's drop generation. Removal is PERMISSIVE — a resolver returning
   * `null` keeps the root.
   */
  checkpoint_cutoff?: { cutoff_at: string; effectiveAdmittedAt: (droppedAtGeneration: string) => string | null };
}

export function compareRoots(a: GitvaultRetentionRoot, b: GitvaultRetentionRoot): number {
  if (a.dropped_at_generation !== b.dropped_at_generation) return a.dropped_at_generation < b.dropped_at_generation ? -1 : 1;
  if (a.ref !== b.ref) return a.ref < b.ref ? -1 : 1;
  return a.oid === b.oid ? 0 : a.oid < b.oid ? -1 : 1;
}

/** roots(g+1) = roots(g) ∪ dropped (RENEWING an existing `(ref, oid)` key) ∖ {expired, only at a checkpoint with a ticket}. */
export function evolveRetentionRoots(previous: GitvaultRetentionRoot[], options: GitvaultEvolveRootsOptions): GitvaultRetentionRoot[] {
  const map = new Map<string, GitvaultRetentionRoot>();
  for (const r of previous) map.set(`${r.ref}\0${r.oid}`, { ...r });
  for (const d of options.dropped) map.set(`${d.ref}\0${d.oid}`, { ref: d.ref, oid: d.oid, dropped_at_generation: options.generation });
  let roots = [...map.values()];
  if (options.checkpoint_cutoff) {
    const { cutoff_at, effectiveAdmittedAt: resolve } = options.checkpoint_cutoff;
    roots = roots.filter((r) => {
      const eff = resolve(r.dropped_at_generation);
      return eff === null ? true : !isRootEligibleForRemoval(eff, cutoff_at);
    });
  }
  roots.sort(compareRoots);
  if (roots.length > GITVAULT_MAX_RETENTION_ROOT_ENTRIES) fail("REF_STATE_LIMIT_EXCEEDED", `${roots.length} retention roots exceed the ${GITVAULT_MAX_RETENTION_ROOT_ENTRIES} bound`, "evolving retention roots", { roots: roots.length });
  return roots;
}

// ─── §6.3 Heads listing (pure) ───────────────────────────────────────────────

export interface GitvaultListingProgress {
  /** The anchor (constant across the sequence). */
  after_generation: string;
  /** The highest generation delivered so far (== anchor before page 1). */
  last_generation: string;
  /** Generations delivered so far (for the truthful-total check). */
  delivered: number;
}

/** Validate a listing request before it is sent (the request schema, D186). */
export function validateHeadsListingRequest(request: GitvaultHeadsListingRequest): void {
  if (!GITVAULT_HEX16_RE.test(request.after_generation)) fail("GITVAULT_LISTING_REQUEST_INVALID", "after_generation is REQUIRED and must be 16 lowercase hex (the verification anchor)", "listing heads", { after_generation: request.after_generation });
  if (!LIMIT_RE.test(request.limit)) fail("GITVAULT_LISTING_REQUEST_INVALID", "limit is REQUIRED and must be 1..1000", "listing heads", { limit: request.limit });
  if (request.cursor !== undefined && !CURSOR_RE.test(request.cursor)) fail("INVALID_CURSOR", "cursor violates the opaque-token grammar; restart from after_generation without a cursor and echo each page's next_cursor unchanged", "listing heads", { cursor: request.cursor });
}

/**
 * Validate one page against the request and the sequence so far. Returns the
 * advanced progress. Refusals: anchor not echoed / wrong vault / coupling
 * violation / retired member → `GITVAULT_LISTING_PAGE_INVALID`; an entry at or
 * below the anchor → `GENERATION_REGRESSION`; a gap within or across pages →
 * `CHAIN_BROKEN`; an untruthful final `total` → `CHAIN_BROKEN`.
 */
export function verifyHeadsListingPage(page: GitvaultHeadsListingPage, request: GitvaultHeadsListingRequest, progress: GitvaultListingProgress, expectedRepoId?: string): GitvaultListingProgress {
  const p = page as GitvaultHeadsListingPage & Record<string, unknown>;
  if (p.format !== GITVAULT_FORMAT) fail("GITVAULT_LISTING_PAGE_INVALID", "listing page has the wrong format", "listing heads");
  if ("next_after_generation" in p) fail("GITVAULT_LISTING_PAGE_INVALID", "listing page carries the retired next_after_generation member (D186 forbids it)", "listing heads");
  if (expectedRepoId && p.repo_id !== expectedRepoId) fail("GITVAULT_LISTING_PAGE_INVALID", "listing page is for a different vault", "listing heads", { repo_id: p.repo_id });
  if (p.after_generation !== request.after_generation || p.after_generation !== progress.after_generation) fail("GITVAULT_LISTING_PAGE_INVALID", "the page did not echo the request's after_generation anchor", "listing heads", { echoed: p.after_generation, anchor: request.after_generation });
  if (typeof p.has_more !== "boolean") fail("GITVAULT_LISTING_PAGE_INVALID", "has_more must be a boolean", "listing heads");
  if (p.has_more === false && p.next_cursor !== null) fail("GITVAULT_LISTING_PAGE_INVALID", "has_more=false with a non-null next_cursor is contradictory", "listing heads");
  if (p.has_more === true && (typeof p.next_cursor !== "string" || !CURSOR_RE.test(p.next_cursor))) fail("GITVAULT_LISTING_PAGE_INVALID", "has_more=true requires a non-null opaque next_cursor", "listing heads");
  if (!Array.isArray(p.heads) || p.heads.length > GITVAULT_MAX_HEADS_PER_LISTING_PAGE || p.heads.length > Number(request.limit)) fail("GITVAULT_LISTING_PAGE_INVALID", "heads[] exceeds the page limit", "listing heads");
  if (p.total !== null && !/^(0|[1-9][0-9]{0,14})$/.test(p.total)) fail("GITVAULT_LISTING_PAGE_INVALID", "total must be an exact decimal string or null", "listing heads");
  let last = generationToBigInt(progress.last_generation);
  const anchor = generationToBigInt(progress.after_generation);
  let delivered = progress.delivered;
  for (const entry of p.heads) {
    const g = generationToBigInt(entry.generation);
    if (!/^[0-9a-f]{64}$/.test(entry.stored_bytes_sha256)) fail("CHAIN_BROKEN", `malformed stored_bytes_sha256 at generation ${entry.generation}`, "listing heads");
    if (g <= anchor) fail("GENERATION_REGRESSION", `the listing delivered generation ${entry.generation}, at or below the verification anchor ${progress.after_generation}`, "listing heads", { generation: entry.generation, anchor: progress.after_generation });
    if (g !== last + 1n) fail("CHAIN_BROKEN", `generation gap: expected ${bigIntToGeneration(last + 1n)}, got ${entry.generation}`, "listing heads", { expected: bigIntToGeneration(last + 1n), got: entry.generation });
    last = g;
    delivered += 1;
  }
  if (p.has_more === false && p.total !== null && BigInt(p.total) !== BigInt(delivered)) {
    fail("CHAIN_BROKEN", `the final page claims total ${p.total} but ${delivered} generations were delivered above the anchor; total is exact or null, never a nearby number`, "listing heads", { total: p.total, delivered });
  }
  return { after_generation: progress.after_generation, last_generation: bigIntToGeneration(last), delivered };
}

/**
 * The continuation request for `page`, or `null` when the sequence is complete.
 * The anchor stays CONSTANT and `next_cursor` is echoed UNCHANGED — the cursor
 * is stored and echoed, never parsed or edited (a client that re-anchors or
 * edits a byte earns `INVALID_CURSOR` from the platform, D186).
 */
export function nextListingRequest(request: GitvaultHeadsListingRequest, page: GitvaultHeadsListingPage): GitvaultHeadsListingRequest | null {
  if (!page.has_more) return null;
  if (page.next_cursor === null) fail("GITVAULT_LISTING_PAGE_INVALID", "has_more=true requires a non-null opaque next_cursor", "listing heads");
  return { after_generation: request.after_generation, cursor: page.next_cursor, limit: request.limit };
}

/**
 * §6.4: the vault's newest generation may never fall BELOW the authenticated
 * pin. A listing (or a storage read) that says otherwise is a rollback, not a
 * quiet vault — `GENERATION_REGRESSION`, no publish.
 */
export function checkGenerationRegression(listedNewestGeneration: string, pinnedGeneration: string): void {
  if (generationToBigInt(listedNewestGeneration) < generationToBigInt(pinnedGeneration)) {
    fail(
      "GENERATION_REGRESSION",
      `the vault's newest generation ${listedNewestGeneration} is below the authenticated pin ${pinnedGeneration}; refusing to publish over a rollback`,
      "verifying gitvault chain",
      { listed_newest_generation: listedNewestGeneration, pinned_generation: pinnedGeneration },
      [{ action: "do not publish; escalate — the vault regressed below a generation this client authenticated" }],
    );
  }
}

// ─── §7.2 request→C1 binding (client half of the fence) ──────────────────────

/** The parameters a maintenance open requests, and that the C1 record must echo. */
export interface GitvaultOpenBindingRecord {
  base_head_sha256: string;
  prior_checkpoint_claim_set_sha256: string | null;
  r2_cap_size_bytes: string;
}

/** `SHA-256("r402s/v0/open-binding" ‖ lp(client_open_id) ‖ lp(base_head) ‖ lp_opt(prior) ‖ lp(cap))`. */
export function openBindingDigest(clientOpenId: string, record: GitvaultOpenBindingRecord): string {
  return sha256Hex(openBindingPreimage(clientOpenId, record.base_head_sha256, record.prior_checkpoint_claim_set_sha256, record.r2_cap_size_bytes));
}

/**
 * Recompute the binding from the record's OWN fields and compare it bytewise
 * with the signed issuance digest. The error registry has no dedicated code for
 * the fence inequality (D145), so the client surfaces
 * `GITVAULT_OPEN_BINDING_MISMATCH`; a same-`client_open_id` retry that carries a
 * DIFFERENT binding is the registry's `CLIENT_OPEN_ID_CONFLICT`.
 */
export function checkOpenBinding(clientOpenId: string, record: GitvaultOpenBindingRecord, issuanceOpenBindingSha256: string, options: { retry?: boolean } = {}): void {
  const recomputed = openBindingDigest(clientOpenId, record);
  if (recomputed === issuanceOpenBindingSha256) return;
  if (options.retry) {
    fail("CLIENT_OPEN_ID_CONFLICT", `client_open_id ${clientOpenId} was already opened with a different request binding`, "checking maintenance open binding", { recomputed, issued: issuanceOpenBindingSha256 });
  }
  fail("GITVAULT_OPEN_BINDING_MISMATCH", `the C1 record does not recompute to the signed issuance binding for ${clientOpenId}`, "checking maintenance open binding", { recomputed, issued: issuanceOpenBindingSha256 });
}

// ─── Chain + transition (pure) ───────────────────────────────────────────────

export interface GitvaultChainLinkInput {
  head: GitvaultHead;
  stored_bytes: Uint8Array;
  /** The listing's hash for this generation. */
  listed_sha256: string;
  expected_generation: string;
  prev_sha256: string;
  repo_id: string;
  /** The registered writer public key (V0: the genesis creator key). */
  writer_public_key: Uint8Array | string;
  writer_key_id: string;
}

/** Verify one link: bytes hash to the listing, strict parse, generation, prev linkage, epoch pin, repo, writer signature. */
export function checkChainLink(input: GitvaultChainLinkInput): void {
  const h = input.head;
  const hash = sha256Hex(input.stored_bytes);
  if (hash !== input.listed_sha256) fail("CHAIN_BROKEN", `head ${input.expected_generation}: stored bytes hash ${hash} ≠ the listing's ${input.listed_sha256}`, "verifying head chain", { generation: input.expected_generation });
  if (h.format !== GITVAULT_FORMAT || h.object_kind !== "head" || h.suite !== GITVAULT_SUITE) fail("CHAIN_BROKEN", `head ${input.expected_generation}: not an r402s/v0 head`, "verifying head chain");
  if (h.repo_id !== input.repo_id) fail("CHAIN_BROKEN", `head ${input.expected_generation}: repo_id ${h.repo_id} ≠ ${input.repo_id}`, "verifying head chain");
  if (h.generation !== input.expected_generation) fail("CHAIN_BROKEN", `head generation ${h.generation} ≠ expected ${input.expected_generation} (generation must equal newest+1)`, "verifying head chain", { got: h.generation, expected: input.expected_generation });
  if (h.prev_sha256 !== input.prev_sha256) fail("CHAIN_BROKEN", `head ${h.generation}: prev_sha256 does not name the predecessor's stored bytes`, "verifying head chain", { prev_sha256: h.prev_sha256, expected: input.prev_sha256 });
  if (h.epoch !== GITVAULT_GENESIS_EPOCH) fail("CHAIN_BROKEN", `head ${h.generation}: epoch ${h.epoch} breaks the V0 pin`, "verifying head chain");
  if (h.writer_key_id !== input.writer_key_id) fail("CHAIN_BROKEN", `head ${h.generation}: writer_key_id ${h.writer_key_id} is not the registered writer`, "verifying head chain");
  if (!verifyGitvaultObject(h as unknown as GitvaultSignedObject, input.writer_public_key)) fail("CHAIN_BROKEN", `head ${h.generation}: signature does not verify under the registered writer key`, "verifying head chain");
  if ((h.checkpoint === null) !== (h.checkpoint_purpose === null)) fail("CHAIN_BROKEN", `head ${h.generation}: checkpoint/checkpoint_purpose must be null together`, "verifying head chain");
  if (h.checkpoint !== null && h.wal_entries.length !== 0) fail("CHAIN_BROKEN", `head ${h.generation}: a checkpoint-bearing head must carry an empty WAL set`, "verifying head chain");
  if ((h.repair !== null) !== (h.checkpoint_purpose === "repair")) fail("CHAIN_BROKEN", `head ${h.generation}: repair ⇔ checkpoint_purpose "repair"`, "verifying head chain");
  if (h.wal_entries.length > GITVAULT_MAX_WAL_RECEIPTS_PER_HEAD) fail("CHAIN_BROKEN", `head ${h.generation}: ${h.wal_entries.length} WAL receipts exceed the 64 budget`, "verifying head chain");
}

/**
 * The transition fail-closed rule: a V0 client that encounters an ADMITTED
 * non-null transition stops advancing — read-only at the materialized pin,
 * no publish past it, `UPGRADE_REQUIRED`. Unknown kinds are a parse reject.
 */
export function assertNoTransition(head: GitvaultHead): void {
  if (head.transition === null) return;
  const kinds = ["add_envelope", "rotate_epoch", "add_writer_key", "transfer_binding"];
  if (!kinds.includes(head.transition.kind)) fail("CHAIN_BROKEN", `head ${head.generation}: unknown transition kind ${String(head.transition.kind)} (closed enum)`, "verifying head chain");
  fail("UPGRADE_REQUIRED", `head ${head.generation} carries an admitted "${head.transition.kind}" transition this client cannot validate; staying read-only at the materialized pin and refusing to publish past it`, "verifying head chain", { generation: head.generation, kind: head.transition.kind }, [{ action: "upgrade the client; the vault stays readable at the materialized pin" }]);
}

// ─── Transport ───────────────────────────────────────────────────────────────

/** One object to upload — identity fixed BEFORE the PUT; the receipt is compared against it. */
export interface GitvaultUploadObject {
  /**
   * Storage path relative to the vault root (§3). CLIENT-LOCAL addressing only:
   * the control plane derives the bucket key from `object_kind` + the ledger
   * identity and REFUSES a manifest entry carrying an unexpected member, so
   * this never rides the wire (5.6c).
   */
  path: string;
  object_kind: string;
  /** `null` for path-addressed kinds (envelopes) — those ride `epoch` + `recipient_fingerprint`. */
  object_id: string | null;
  bytes: Uint8Array;
  /** SHA-256 of `bytes` (ciphertext hash for frames, stored-bytes hash for plaintext kinds). */
  sha256: string;
  size_bytes: string;
  /** `wal_pack` only — §4.1: the ONLY receipt kind carrying `base_generation`. */
  base_generation?: string;
}

export interface GitvaultUploadReceipt {
  path: string;
  object_id: string | null;
  sha256: string;
  size_bytes: string;
}

// ─── Wire addressing (5.6c) ──────────────────────────────────────────────────

/**
 * The control plane addresses stored objects by LEDGER IDENTITY, never by
 * bucket path: heads and admission records have their own generation-addressed
 * routes, and every uploadable kind is named by `object_kind` + `object_id`
 * (or, for envelopes, `epoch` + `recipient_fingerprint`). This resolver maps
 * the SDK's internal `gitvaultPaths` strings onto that identity so the rest of
 * the vault can keep addressing objects the way §3 describes them.
 */
export type GitvaultWireRef =
  | { kind: "head"; generation: string }
  | { kind: "admission"; generation: string }
  | { kind: "object"; read: GitvaultObjectReadRequest };

/** One entry of a `POST …/object-reads` batch. */
export interface GitvaultObjectReadRequest {
  object_kind: string;
  object_id?: string;
  epoch?: string;
  recipient_fingerprint?: string;
  /** D195, rev 42 — present only for a rotation-attempt `key_envelope` read. */
  rotation_id?: string;
  /** D197, rev 42 — present only for a `recipient_pin_manifest` read. */
  pin_manifest_version?: string;
}

const HEX16 = "[0-9a-f]{16}";
const SHA256 = "[0-9a-f]{64}";
/** Ordered longest-suffix-first so `.ticket.json` is never eaten by `.enc`, and the rotation-scoped envelope pattern before the plain one so it never matches short. */
const PATH_PATTERNS: Array<[RegExp, (m: RegExpExecArray) => GitvaultWireRef]> = [
  [new RegExp(`^head/(${HEX16})$`), (m) => ({ kind: "head", generation: m[1]! })],
  [new RegExp(`^admissions/(${HEX16})$`), (m) => ({ kind: "admission", generation: m[1]! })],
  [new RegExp(`^envelopes/(${HEX16})/(${SHA256})/(ek_[0-9a-f]{32})$`), (m) => ({ kind: "object", read: { object_kind: "key_envelope", epoch: m[1]!, rotation_id: m[2]!, recipient_fingerprint: m[3]! } })],
  [/^envelopes\/([0-9a-f]{16})\/(ek_[0-9a-f]{32})$/, (m) => ({ kind: "object", read: { object_kind: "key_envelope", epoch: m[1]!, recipient_fingerprint: m[2]! } })],
  [new RegExp(`^recipient-pins/(${HEX16})\\.json$`), (m) => ({ kind: "object", read: { object_kind: "recipient_pin_manifest", pin_manifest_version: m[1]! } })],
  [/^wal\/(wal_[0-9a-f]{32})\.pack\.enc$/, (m) => ({ kind: "object", read: { object_kind: "wal_pack", object_id: m[1]! } })],
  [/^refs\/(refs_[0-9a-f]{32})\.enc$/, (m) => ({ kind: "object", read: { object_kind: "ref_state", object_id: m[1]! } })],
  [/^retention\/(rr_[0-9a-f]{32})\.enc$/, (m) => ({ kind: "object", read: { object_kind: "retention_roots", object_id: m[1]! } })],
  [/^checkpoints\/(chk_[0-9a-f]{32})\.manifest\.enc$/, (m) => ({ kind: "object", read: { object_kind: "checkpoint_manifest", object_id: m[1]! } })],
  [/^checkpoints\/(ckp_[0-9a-f]{32})\.pack\.enc$/, (m) => ({ kind: "object", read: { object_kind: "checkpoint_pack", object_id: m[1]! } })],
  [/^checkpoints\/(ccs_[0-9a-f]{32})\.claims\.json$/, (m) => ({ kind: "object", read: { object_kind: "checkpoint_claim_set", object_id: m[1]! } })],
  [/^maintenance\/(msc_[0-9a-f]{32})\.stage\.json$/, (m) => ({ kind: "object", read: { object_kind: "maintenance_stage_claim_set", object_id: m[1]! } })],
  [/^maintenance\/(msp_[0-9a-f]{32})\.page\.json$/, (m) => ({ kind: "object", read: { object_kind: "maintenance_stage_page", object_id: m[1]! } })],
  [/^verifier-receipts\/(vr_[0-9a-f]{32})\.json$/, (m) => ({ kind: "object", read: { object_kind: "verifier_receipt", object_id: m[1]! } })],
];

/** `null` for a path with no wire identity (e.g. a locally-held cutoff ticket). */
export function gitvaultWireRefForPath(path: string): GitvaultWireRef | null {
  for (const [re, build] of PATH_PATTERNS) {
    const m = re.exec(path);
    if (m) return build(m);
  }
  return null;
}

/** The manifest entry for one upload — closed-key, exactly what the control plane validates. */
export function gitvaultManifestEntry(object: GitvaultUploadObject): GitvaultObjectReadRequest & { sha256: string; size_bytes: string; base_generation?: string } {
  const ref = gitvaultWireRefForPath(object.path);
  if (!ref || ref.kind !== "object") {
    fail("GITVAULT_UPLOAD_SESSION_INVALID", `${object.path} is not an uploadable object path; the control plane addresses uploads by object_kind + ledger identity`, "building the gitvault upload manifest", { path: object.path });
  }
  const entry = { ...ref.read, sha256: object.sha256, size_bytes: object.size_bytes } as GitvaultObjectReadRequest & { sha256: string; size_bytes: string; base_generation?: string };
  if (entry.object_kind === "wal_pack") {
    if (object.base_generation === undefined) fail("GITVAULT_UPLOAD_SESSION_INVALID", "a wal_pack upload must declare base_generation (§4.1)", "building the gitvault upload manifest", { path: object.path });
    entry.base_generation = object.base_generation;
  }
  return entry;
}

/**
 * The stable key both sides agree on, used to pair receipts back to
 * requests — MIRRORS the gateway's `keyEnvelopeLedgerId`/`pinManifestLedgerId`
 * (services/gitvault/epoch-rotation.ts) exactly; drift here breaks receipt
 * pairing at upload finalize for a rotation-attempt envelope or a pin
 * manifest.
 */
export function gitvaultLedgerId(read: GitvaultObjectReadRequest): string {
  if (read.object_kind === "key_envelope") return keyEnvelopeLedgerId(read.epoch!, read.recipient_fingerprint!, read.rotation_id ?? null);
  if (read.object_kind === "recipient_pin_manifest") return pinManifestLedgerId(read.pin_manifest_version!);
  return String(read.object_id);
}

export interface GitvaultAdmitHeadRequest {
  repo_id: string;
  generation: string;
  stored_bytes: Uint8Array;
  stored_bytes_sha256: string;
}

export type GitvaultAdmitHeadResult =
  | { outcome: "admitted"; admission_record_sha256: string; capture_receipt: GitvaultCaptureReceipt | null }
  | { outcome: "conflict"; winner: { generation: string; stored_bytes_sha256: string } };

export interface GitvaultRetentionCutoffIssued {
  ticket: GitvaultRetentionCutoff;
  receipt: GitvaultRetentionCutoffReceipt;
}

/**
 * Everything the vault needs from the control plane + bucket. Extends the
 * creation transport so one implementation serves 5.3–5.6. All methods are
 * idempotent from the state machines' point of view.
 */
/** The `resource_binding` an upload session is charged against (§7.2 / §9.3). */
export type GitvaultResourceBinding =
  | { kind: "ordinary_push" }
  | { kind: "maintenance_cycle"; maintenance_lease_id: string }
  | { kind: "repair_attempt"; repair_attempt_id: string };

/** `POST …/maintenance-leases` — the owner's compact/prune reservation (§7.2). */
export interface GitvaultMaintenanceLeaseRequest {
  repo_id: string;
  base_head_sha256: string;
  current_checkpoint_hash?: string | null;
  r1_size_bytes: string;
  r2_cap_size_bytes: string;
  p_before_c1_size_bytes?: string;
  p_before_c2_size_bytes?: string;
}

export interface GitvaultMaintenanceLease {
  maintenance_lease_id: string;
  repo_id: string;
  base_head_sha256: string;
  current_checkpoint_hash: string | null;
  reservation_size_bytes: string;
  maintenance_headroom_bytes: string;
  /** Returned ONCE — the liveness instrument (heartbeat / release). Never logged, never cached. */
  holder_token: string;
  expires_at: string | null;
  hard_deadline_at: string | null;
}

export interface GitvaultTransport extends GitvaultCreationTransport {
  listHeads(request: GitvaultHeadsListingRequest & { repo_id: string }): Promise<GitvaultHeadsListingPage>;
  /** Session → create-only presigned PUTs (`If-None-Match: *`) → finalize; receipts in request order. */
  uploadObjects(request: { repo_id: string; objects: GitvaultUploadObject[]; resource_binding?: GitvaultResourceBinding }): Promise<GitvaultUploadReceipt[]>;
  admitHead(request: GitvaultAdmitHeadRequest): Promise<GitvaultAdmitHeadResult>;
  requestRetentionCutoff(request: { repo_id: string; base_head_sha256: string }): Promise<GitvaultRetentionCutoffIssued>;
  exchangeActivationToken(request: { repo_id: string; operation_id: string; capture_receipt: GitvaultCaptureReceipt }): Promise<GitvaultActivationToken>;
  submitOverrideCompletion(request: { repo_id: string; operation_id: string; capture_receipt: GitvaultCaptureReceipt }): Promise<{ cleared: boolean }>;
  /** The vault record — policy, allocation generation, storage + maintenance state (§9.2). */
  getVaultRecord(request: { repo_id: string }): Promise<GitvaultVaultRecord>;
  /** Resolve a project's vault without local state (the cold-restart entry point). */
  findVaultByProject(request: { project_id: string }): Promise<GitvaultVaultRecord>;
  /**
   * Resolve a vault by its address-form `org-slug/name` (repo-first-onramp
   * task 4.3, design D6) — `GET /gitvault/v1/vaults?repo=<org-slug>/<name>`.
   * `RESOURCE_NOT_FOUND` for no such org OR no such name within it (the two
   * collapse deliberately, so slug-namespace probing learns nothing extra);
   * `SLUG_RELEASED` (with `successor_slug`/`released_at`/`cooldown_until` on
   * the error) while the slug is in its post-rename cooldown — never
   * auto-followed.
   */
  findVaultByRepo(request: { org_slug: string; repo_name: string }): Promise<GitvaultVaultRecord>;
  acquireMaintenanceLease(request: GitvaultMaintenanceLeaseRequest): Promise<GitvaultMaintenanceLease>;
  heartbeatMaintenanceLease(request: { repo_id: string; maintenance_lease_id: string; holder_token: string }): Promise<{ maintenance_lease_id: string; expires_at: string | null }>;
  releaseMaintenanceLease(request: { repo_id: string; maintenance_lease_id: string; holder_token: string }): Promise<{ maintenance_lease_id: string; status: string }>;
  /**
   * `POST …/prune-intents` — the intent's EXACT BYTES (§7.3).
   *
   * The route is parsed with `express.raw` and the owner signature is verified
   * over the bytes as sent, so the transport MUST NOT re-serialize: it puts
   * `intent_bytes` on the wire verbatim under `Content-Type: application/json`.
   * An implementation that accepts a parsed object here and stringifies it is
   * signing one thing and sending another.
   */
  submitPruneIntent(request: { repo_id: string; intent_bytes: Uint8Array }): Promise<GitvaultPruneIntentRecord & { stored: boolean }>;
  /** `GET …/prune-intents/:id` — the intent's state and, once signed, its completion. */
  getPruneIntent(request: { repo_id: string; prune_intent_object_id: string }): Promise<GitvaultPruneIntentRecord | null>;
  /**
   * The org's directory of envelope-capable principals (gitvault-human-
   * envelopes design D7, `GET /orgs/v1/:org_id/encryption-keys`) — every
   * active human member who has published an encryption key. Read by
   * {@link GitvaultVault.reconcileEnvelopeRecipients} to diff against a
   * vault's current recipient set.
   */
  listOrgEncryptionKeys(request: { org_id: string }): Promise<GitvaultOrgEncryptionKeyDirectory>;
  /**
   * The `ek_` fingerprints already covering this vault, at any epoch
   * (`GET /gitvault/v1/vaults/:vault_id/envelope-recipients`, task 2.2) —
   * fingerprints only, never envelope bytes; the recipient-only rule on
   * envelope BYTES elsewhere is unaffected.
   */
  listEnvelopeRecipients(request: { repo_id: string }): Promise<GitvaultEnvelopeRecipientsResponse>;

  // ── epoch rotation (D193-D203, rev 42, §9.2) ──

  /**
   * `POST …/rotation-attempts` (D195) — the FIRST write of any rotation
   * attempt, BEFORE any `key_envelope` upload for it. `descriptor` is the
   * COMPLETE, signed `rotation_attempt_descriptor`; the gateway re-derives
   * `rotation_id` from the stored bytes and returns it alongside the
   * (possibly-idempotent-replayed) descriptor.
   */
  createRotationAttempt(request: { repo_id: string; descriptor: GitvaultRotationAttemptDescriptor }): Promise<{ rotation_id: string; descriptor: GitvaultRotationAttemptDescriptor; deduplicated: boolean }>;
  /** `POST …/recipients/:principal_id/confirm` (D197) — first-seen pin confirmation; owner + step-up. */
  confirmRecipient(request: { repo_id: string; principal_id: string; new_fingerprint: string }): Promise<GitvaultRecipientConfirmationReceipt>;
  /** `POST …/recipients/:principal_id/repin` (D197) — re-pin ceremony; owner + step-up. */
  repinRecipient(request: { repo_id: string; principal_id: string; old_ek_fingerprint: string; new_fingerprint: string }): Promise<GitvaultRecipientConfirmationReceipt>;
  /** `POST …/recipients/:principal_id/key-revocation` (D199) — declares `reason:"recipient_key_revoked"` admissible; owner + step-up. Returns the D194 counters this rotation must be fenced against — the ONE reason value with a client-visible counter read. */
  declareRecipientKeyRevoked(request: { repo_id: string; principal_id: string }): Promise<{ recipient_state_version: string; recipient_revocation_version: string }>;
  /** `POST …/epoch-secret-exposure` (D199) — declares `reason:"epoch_secret_exposed"` admissible, VAULT-scoped; owner + step-up. */
  declareEpochSecretExposed(request: { repo_id: string }): Promise<{ epoch_secret_exposure_version: string }>;
  /** `POST …/writer-authority/declare-unavailable` (D202) — an explicit, audited fact that the writer signing key is gone; owner + step-up. */
  declareWriterAuthorityUnavailable(request: { repo_id: string }): Promise<{ declared_at: string; declared_by: string | null }>;
}

/**
 * One row of the org's envelope-capable-principal directory
 * ({@link GitvaultTransport.listOrgEncryptionKeys}).
 *
 * The gateway route (`GET /orgs/v1/:org_id/encryption-keys`, `routes/org.ts`
 * in run402-private) returns `public_key` on every row — the raw key
 * material is what makes the directory usable for wrapping at all
 * (deployed 2026-08-26). The field stays OPTIONAL in this wire type the
 * same way `desired[]` does on {@link GitvaultEnvelopeRecipientsResponse}:
 * a response is network data, and an older/rolling-deploy gateway that
 * omits the field must degrade to a per-entry `skipped` report
 * (`missing_public_key`) from {@link GitvaultVault.reconcileEnvelopeRecipients},
 * never a hardcoded assumption or a thrown error.
 */
export interface GitvaultOrgEncryptionKeyEntry {
  principal_id: string;
  display_name: string | null;
  ek_fingerprint: string;
  suite: string;
  created_at: string;
  /** Raw base64url X25519 public key. Present on every current-gateway row; tolerated as absent (per-entry `missing_public_key` skip) for wire robustness only. */
  public_key?: string;
  [key: string]: unknown;
}

/** `GET /orgs/v1/:org_id/encryption-keys` — {@link GitvaultTransport.listOrgEncryptionKeys}'s result. */
export interface GitvaultOrgEncryptionKeyDirectory {
  org_id: string;
  keys: GitvaultOrgEncryptionKeyEntry[];
}

/**
 * One row of the vault's org-level, membership-driven DESIRED-recipient
 * state. `status` is the server's own honest accounting of what membership
 * currently wants, NOT a claim about whether access was actually revoked:
 * `"pending_removal"` means membership removed this principal but gitvault
 * protocol v0 has no epoch-rotation mechanism yet to un-wrap their existing
 * `key_envelope`, so `covered: true` on a `pending_removal` row is a REAL
 * continuing-access fact, not stale data.
 */
export interface GitvaultDesiredRecipientEntry {
  principal_id: string;
  display_name: string | null;
  status: "active" | "pending_removal";
  /** `null` when this principal is desired but has not published an encryption key yet. */
  ek_fingerprint: string | null;
  public_key: string | null;
  suite: string | null;
  /** `true` when `ek_fingerprint` currently has a `key_envelope` on this vault. */
  covered: boolean;
}

/** `GET /gitvault/v1/vaults/:vault_id/envelope-recipients` — {@link GitvaultTransport.listEnvelopeRecipients}'s result. */
export interface GitvaultEnvelopeRecipientsResponse {
  vault_id: string;
  recipient_fingerprints: string[];
  /**
   * The org's desired-recipient state, cross-referenced against this
   * vault's coverage — see {@link GitvaultDesiredRecipientEntry}. OPTIONAL:
   * absent (not empty) on an older gateway that predates this field —
   * callers MUST distinguish "field absent" (older gateway, state genuinely
   * unknown) from "field present and empty" (org has no desired recipients)
   * rather than treating both as "no data."
   */
  desired?: GitvaultDesiredRecipientEntry[];
  /** The desired-recipient substrate's own monotonic version, for cheap client-side diffing. Present iff `desired` is present. */
  desired_state_version?: number;
}

/** `GET /gitvault/v1/vaults/:vault_id` — the shape `reads.ts:getVaultRecord` returns. */
export interface GitvaultVaultRecord {
  repo_id: string;
  project_id: string;
  org_id: string;
  gitvault_policy: "required" | "grandfathered" | null;
  gitvault_policy_version: string;
  gitvault_policy_changed_at: string | null;
  allocation_generation: string;
  allocation_sha256: string | null;
  newest_generation: string | null;
  genesis_admitted_at: string | null;
  latest_effective_admitted_at: string | null;
  admitted_generations: string;
  gc_epoch: string;
  repair_version: string;
  repair_fence_state: string;
  storage: { source_bytes: string; open_session_reserved_bytes: string; objects: Record<string, string> };
  maintenance: {
    lease: { maintenance_lease_id: string; base_head_sha256: string; reservation_size_bytes: string; expires_at: string | null; hard_deadline_at: string | null } | null;
    open_cycle: { maintenance_cycle_id: string; state: string; last_cycle_progress_at: string | null } | null;
    pending_repair_attempt_id: string | null;
  };
  warnings: { kind: string; message: string }[];
  created_at: string | null;
}

export interface GitvaultHttpTransportOptions {
  /** Wire shape: every vault-scoped route is `/gitvault/v1/vaults/:vault_id/...`; `vault_id` is the `repo_id` unless a mapping is supplied (D185). */
  vaultIdFor?: (repoId: string) => string;
}

interface UploadSessionResponse {
  upload_session_id: string;
  objects: Array<GitvaultObjectReadRequest & { put: { url: string; headers?: Record<string, string> } }>;
}
interface FinalizeResponse {
  receipts: Array<GitvaultObjectReadRequest & { stored_bytes_sha256?: string; ciphertext_sha256?: string; size_bytes: string }>;
}
interface ObjectReadsResponse {
  reads: Array<GitvaultObjectReadRequest & { url: string; stored_bytes_sha256: string; size_bytes: string }>;
}

function b64(bytes: Uint8Array): string { return Buffer.from(bytes).toString("base64"); }
function b64u(bytes: Uint8Array): string { return Buffer.from(bytes).toString("base64url"); }

/**
 * The `fetch`-backed transport over the SDK kernel. Presigned PUTs carry
 * `If-None-Match: *` (create-only — the bucket policy demands it) and the
 * FULL_OBJECT SHA-256 checksum header.
 */
export function createGitvaultHttpTransport(client: Client, options: GitvaultHttpTransportOptions = {}): GitvaultTransport {
  const vid = (repoId: string) => encodeURIComponent((options.vaultIdFor ?? ((r) => r))(repoId));
  const base = (repoId: string) => `/gitvault/v1/vaults/${vid(repoId)}`;

  /**
   * Read raw bytes from a generation-addressed route (heads, admission records).
   *
   * Deliberately NOT `client.request` — that parses JSON, and re-serializing a
   * parsed head would verify the SDK's own canonicalizer instead of the bytes
   * the host actually stored. §0's client obligation is to hash what was
   * served, so this fetches the response body untouched (authenticated by the
   * same credential provider the kernel uses).
   */
  async function getGenerationBytes(repoId: string, route: "heads" | "admissions", generation: string): Promise<Uint8Array | null> {
    const path = `${base(repoId)}/${route}/${encodeURIComponent(generation)}`;
    const auth = (await client.credentials.getAuth(path, { method: `gitvault.read_${route}` })) ?? {};
    const r = await client.fetch(`${client.apiBase}${path}`, { method: "GET", headers: { ...auth, accept: "application/json" } });
    if (r.status === 404) return null;
    if (!r.ok) {
      // Surface the registry code the control plane actually sent (e.g.
      // `GITVAULT_ACCESS_DENIED`) rather than flattening every refusal into a
      // generic read failure — the codes carry the caller's next action.
      let code = "GITVAULT_OBJECT_READ_FAILED";
      let message = `${route}/${generation} read failed (HTTP ${r.status})`;
      try {
        const envelope = (await r.json()) as { error?: { code?: string; message?: string } };
        if (typeof envelope?.error?.code === "string") code = envelope.error.code;
        if (typeof envelope?.error?.message === "string") message = envelope.error.message;
      } catch {
        // a non-JSON body — keep the generic code
      }
      fail(code, message, `reading gitvault ${route}`, { generation, status: r.status });
    }
    return new Uint8Array(await r.arrayBuffer());
  }

  /** Presign + fetch one object by its ledger identity (`POST …/object-reads`). */
  async function getObjectBytes(repoId: string, path: string): Promise<Uint8Array | null> {
    const ref = gitvaultWireRefForPath(path);
    if (!ref) fail("GITVAULT_OBJECT_READ_FAILED", `${path} has no control-plane wire identity; it is not a readable vault object`, "reading gitvault object", { path });
    if (ref.kind === "head") return getGenerationBytes(repoId, "heads", ref.generation);
    if (ref.kind === "admission") return getGenerationBytes(repoId, "admissions", ref.generation);
    let presigned: ObjectReadsResponse;
    try {
      presigned = await client.request<ObjectReadsResponse>(`${base(repoId)}/object-reads`, { method: "POST", body: { objects: [ref.read] }, context: "resolving gitvault object" });
    } catch (e) {
      if (isRun402Error(e) && (e as { status?: number }).status === 404) return null;
      if (isRun402Error(e) && (e as { code?: string }).code === "RESOURCE_NOT_FOUND") return null;
      throw e;
    }
    const target = presigned.reads[0];
    if (!target) return null;
    const r = await client.fetch(target.url, { method: "GET" });
    if (r.status === 404) return null;
    if (!r.ok) fail("GITVAULT_OBJECT_READ_FAILED", `object GET failed (HTTP ${r.status}) for ${path}`, "reading gitvault object", { path, status: r.status });
    return new Uint8Array(await r.arrayBuffer());
  }

  async function upload(repoId: string, objects: GitvaultUploadObject[], resourceBinding?: GitvaultResourceBinding): Promise<GitvaultUploadReceipt[]> {
    if (objects.length === 0) return [];
    // The manifest is closed-key: `path` is client-local and MUST NOT ride the
    // wire — the control plane derives the bucket key itself and refuses an
    // entry carrying an unexpected member.
    const entries = objects.map((o) => gitvaultManifestEntry(o));
    const session = await client.request<UploadSessionResponse>(`${base(repoId)}/upload-sessions`, {
      method: "POST",
      body: { objects: entries, ...(resourceBinding ? { resource_binding: resourceBinding } : {}) },
      context: "opening gitvault upload session",
    });
    const issued = new Map(session.objects.map((u) => [gitvaultLedgerId(u), u]));
    for (let i = 0; i < objects.length; i++) {
      const o = objects[i]!;
      const id = gitvaultLedgerId(entries[i]!);
      const target = issued.get(id);
      if (!target) fail("GITVAULT_UPLOAD_SESSION_INVALID", `the session issued no upload for ${id}`, "uploading gitvault objects", { object_id: id, path: o.path });
      // `If-None-Match: *` (create-only) and the FULL_OBJECT `x-amz-checksum-sha256`
      // are SIGNED INTO the presigned URL, so they must go out exactly as the
      // server issued them — a dropped or altered header is a signature
      // mismatch, not a silently unconditional or unchecked write. The locals
      // below are only a fallback for a transport that omits them; the
      // server's copy always wins.
      const r = await client.fetch(target.put.url, {
        method: "PUT",
        headers: { "If-None-Match": "*", "Content-Length": o.size_bytes, "x-amz-checksum-sha256": b64(hexToBytes(o.sha256)), ...(target.put.headers ?? {}) },
        body: o.bytes as unknown as BodyInit,
      });
      if (r.status === 412 || r.status === 409) {
        // create-only: the key exists — legal only if it is byte-identical (read-and-compare)
        const existing = await getObjectBytes(repoId, o.path);
        if (!existing || sha256Hex(existing) !== o.sha256) fail("GITVAULT_OBJECT_EXISTS_DIFFERENT", `${o.path} already exists with different bytes`, "uploading gitvault objects", { path: o.path });
        continue;
      }
      if (!r.ok) fail("GITVAULT_UPLOAD_FAILED", `presigned PUT failed (HTTP ${r.status}) for ${o.path}`, "uploading gitvault objects", { path: o.path, status: r.status });
    }
    const fin = await client.request<FinalizeResponse>(`${base(repoId)}/upload-sessions/${encodeURIComponent(session.upload_session_id)}/finalize`, { method: "POST", body: {}, context: "finalizing gitvault upload session" });
    const receipts = new Map(fin.receipts.map((r) => [gitvaultLedgerId(r), r]));
    return objects.map((o, i) => {
      const id = gitvaultLedgerId(entries[i]!);
      const r = receipts.get(id);
      if (!r) fail("GITVAULT_RECEIPT_MISSING", `finalize returned no receipt for ${id}`, "finalizing gitvault upload session", { object_id: id, path: o.path });
      return { path: o.path, object_id: o.object_id, sha256: r.ciphertext_sha256 ?? r.stored_bytes_sha256 ?? "", size_bytes: r.size_bytes };
    });
  }

  async function admit(repoId: string, generation: string, bytes: Uint8Array, hash: string, extra: Record<string, unknown> = {}): Promise<GitvaultAdmitHeadResult> {
    try {
      const r = await client.request<{ outcome?: string; admission_record_sha256: string; capture_receipt?: GitvaultCaptureReceipt | null }>(`${base(repoId)}/admissions`, {
        method: "POST",
        body: { generation, stored_bytes: b64u(bytes), stored_bytes_sha256: hash, ...extra },
        context: "admitting gitvault head",
      });
      return { outcome: "admitted", admission_record_sha256: r.admission_record_sha256, capture_receipt: r.capture_receipt ?? null };
    } catch (e) {
      if (isRun402Error(e) && (e as { code?: string }).code === "HEAD_CAS_CONFLICT") {
        const winner = ((e as { details?: { winner?: { generation: string; stored_bytes_sha256: string } } }).details?.winner) ?? null;
        if (winner) return { outcome: "conflict", winner };
      }
      throw e;
    }
  }

  return {
    // ── creation (5.3) ──
    async allocate(request: GitvaultAllocateRequest): Promise<GitvaultAllocation> {
      // The route wraps the signed allocation object under `allocation` and
      // adds routing sugar (`allocation_sha256`, `deduplicated`, next_actions).
      // The vault verifies the SIGNED object, so unwrap it here.
      const res = await client.request<{ allocation?: GitvaultAllocation } & GitvaultAllocation>("/gitvault/v1/vaults", { method: "POST", body: request, context: "allocating gitvault" });
      return res.allocation ?? (res as GitvaultAllocation);
    },
    async putObject(request: GitvaultPutObjectRequest): Promise<GitvaultObjectReceipt> {
      const [r] = await upload(request.repo_id, [{ path: request.path, object_kind: "key_envelope", object_id: null, bytes: request.bytes, sha256: request.expected_sha256, size_bytes: request.expected_size_bytes }]);
      return { stored_bytes_sha256: r!.sha256, size_bytes: r!.size_bytes };
    },
    getObject: ({ repo_id, path }) => getObjectBytes(repo_id, path),
    async admitGenesis(request: GitvaultAdmitGenesisRequest): Promise<GitvaultAdmitGenesisResult> {
      try {
        const r = await admit(request.repo_id, GITVAULT_GENESIS_GENERATION, request.stored_bytes, request.stored_bytes_sha256, { allocation_generation: request.allocation_generation });
        if (r.outcome === "admitted") return { outcome: "admitted", admitted_sha256: request.stored_bytes_sha256 };
        return { outcome: "already_admitted", admitted_sha256: r.winner.stored_bytes_sha256 };
      } catch (e) {
        if (isRun402Error(e) && (e as { code?: string }).code === "ALLOCATION_SUPERSEDED") return { outcome: "allocation_superseded" };
        throw e;
      }
    },
    getGenesis: ({ repo_id }) => getObjectBytes(repo_id, `head/${GITVAULT_GENESIS_GENERATION}`),
    // ── publication (5.4) ──
    async listHeads(request) {
      validateHeadsListingRequest(request);
      const qs = new URLSearchParams({ after_generation: request.after_generation, limit: request.limit });
      if (request.cursor !== undefined) qs.set("cursor", request.cursor);
      return client.request<GitvaultHeadsListingPage>(`${base(request.repo_id)}/heads?${qs.toString()}`, { context: "listing gitvault heads" });
    },
    uploadObjects: ({ repo_id, objects, resource_binding }) => upload(repo_id, objects, resource_binding),
    admitHead: (r) => admit(r.repo_id, r.generation, r.stored_bytes, r.stored_bytes_sha256),
    // Both routes SHIPPED (`routes/gitvault-admission.ts`). `retention-cutoffs`
    // answers `{ticket, receipt, next_actions}`, which IS
    // `GitvaultRetentionCutoffIssued` plus routing sugar — no unwrap needed.
    requestRetentionCutoff: ({ repo_id, base_head_sha256 }) => client.request<GitvaultRetentionCutoffIssued>(`${base(repo_id)}/retention-cutoffs`, { method: "POST", body: { base_head_sha256 }, context: "requesting retention cutoff ticket" }),
    async exchangeActivationToken({ repo_id, operation_id, capture_receipt }): Promise<GitvaultActivationToken> {
      // The route wraps the SIGNED token under `activation_token` and adds
      // routing sugar (`object_id`, `reissued`, next_actions) — same envelope
      // shape as `allocate` above, and unwrapped for the same reason: the
      // caller verifies the SIGNED object, and `checkActivationTokenBinding`
      // compares nine fields that all live INSIDE it. Passing the envelope on
      // as the token mismatches every one of them
      // (`GITVAULT_TOKEN_BINDING_MISMATCH`) and the deploy never commits — even
      // though the envelope's sibling `object_id` makes the shape look close
      // enough to be a plausible token at a glance. Pinned by
      // `gitvault-wire-shapes.test.ts`.
      const res = await client.request<{ activation_token?: GitvaultActivationToken } & GitvaultActivationToken>(
        `${base(repo_id)}/activation-tokens`,
        { method: "POST", body: { operation_id, capture_receipt }, context: "exchanging capture receipt for activation token" },
      );
      return res.activation_token ?? (res as GitvaultActivationToken);
    },
    async submitOverrideCompletion({ repo_id, operation_id, capture_receipt }) {
      const r = await client.request<{ advisory_cleared?: boolean; cleared?: boolean }>(`${base(repo_id)}/override-completions`, { method: "POST", body: { operation_id, capture_receipt }, context: "submitting override completion" });
      return { cleared: r.advisory_cleared ?? r.cleared ?? false };
    },
    getVaultRecord: ({ repo_id }) => client.request<GitvaultVaultRecord>(base(repo_id), { context: "reading the gitvault record" }),
    findVaultByProject: ({ project_id }) => client.request<GitvaultVaultRecord>(`/gitvault/v1/vaults?project_id=${encodeURIComponent(project_id)}`, { context: "resolving the project's gitvault" }),
    findVaultByRepo: ({ org_slug, repo_name }) => client.request<GitvaultVaultRecord>(`/gitvault/v1/vaults?repo=${encodeURIComponent(`${org_slug}/${repo_name}`)}`, { context: "resolving the gitvault by repo address" }),
    listOrgEncryptionKeys: ({ org_id }) => client.request<GitvaultOrgEncryptionKeyDirectory>(`/orgs/v1/${encodeURIComponent(org_id)}/encryption-keys`, { context: "reading the org encryption-key directory" }),
    listEnvelopeRecipients: ({ repo_id }) => client.request<GitvaultEnvelopeRecipientsResponse>(`${base(repo_id)}/envelope-recipients`, { context: "reading the gitvault envelope recipients" }),
    // ── epoch rotation (D193-D203, rev 42, §9.2) ──
    async createRotationAttempt({ repo_id, descriptor }) {
      const res = await client.request<{ rotation_id: string; descriptor: GitvaultRotationAttemptDescriptor; deduplicated?: boolean }>(`${base(repo_id)}/rotation-attempts`, {
        method: "POST",
        body: descriptor,
        context: "creating a gitvault rotation attempt",
      });
      return { rotation_id: res.rotation_id, descriptor: res.descriptor, deduplicated: res.deduplicated ?? false };
    },
    confirmRecipient: ({ repo_id, principal_id, new_fingerprint }) =>
      client.request<GitvaultRecipientConfirmationReceipt>(`${base(repo_id)}/recipients/${encodeURIComponent(principal_id)}/confirm`, { method: "POST", body: { new_fingerprint }, context: "confirming a gitvault recipient's first pin" }),
    repinRecipient: ({ repo_id, principal_id, old_ek_fingerprint, new_fingerprint }) =>
      client.request<GitvaultRecipientConfirmationReceipt>(`${base(repo_id)}/recipients/${encodeURIComponent(principal_id)}/repin`, { method: "POST", body: { old_ek_fingerprint, new_fingerprint }, context: "re-pinning a gitvault recipient" }),
    declareRecipientKeyRevoked: ({ repo_id, principal_id }) =>
      client.request<{ recipient_state_version: string; recipient_revocation_version: string }>(`${base(repo_id)}/recipients/${encodeURIComponent(principal_id)}/key-revocation`, { method: "POST", body: {}, context: "declaring a gitvault recipient key revoked" }),
    declareEpochSecretExposed: ({ repo_id }) =>
      client.request<{ epoch_secret_exposure_version: string }>(`${base(repo_id)}/epoch-secret-exposure`, { method: "POST", body: {}, context: "declaring a gitvault epoch secret exposed" }),
    declareWriterAuthorityUnavailable: ({ repo_id }) =>
      client.request<{ declared_at: string; declared_by: string | null }>(`${base(repo_id)}/writer-authority/declare-unavailable`, { method: "POST", body: {}, context: "declaring gitvault writer authority unavailable" }),
    acquireMaintenanceLease: ({ repo_id, base_head_sha256, current_checkpoint_hash, r1_size_bytes, r2_cap_size_bytes, p_before_c1_size_bytes, p_before_c2_size_bytes }) =>
      client.request<GitvaultMaintenanceLease>(`${base(repo_id)}/maintenance-leases`, {
        method: "POST",
        body: {
          base_head_sha256,
          current_checkpoint_hash: current_checkpoint_hash ?? null,
          r1_size_bytes,
          r2_cap_size_bytes,
          p_before_c1_size_bytes: p_before_c1_size_bytes ?? "0",
          p_before_c2_size_bytes: p_before_c2_size_bytes ?? "0",
        },
        context: "acquiring the gitvault maintenance lease",
      }),
    heartbeatMaintenanceLease: ({ repo_id, maintenance_lease_id, holder_token }) =>
      client.request<{ maintenance_lease_id: string; expires_at: string | null }>(`${base(repo_id)}/maintenance-leases/${encodeURIComponent(maintenance_lease_id)}/heartbeat`, { method: "POST", body: { holder_token }, context: "renewing the gitvault maintenance lease" }),
    releaseMaintenanceLease: ({ repo_id, maintenance_lease_id, holder_token }) =>
      client.request<{ maintenance_lease_id: string; status: string }>(`${base(repo_id)}/maintenance-leases/${encodeURIComponent(maintenance_lease_id)}`, { method: "DELETE", body: { holder_token }, context: "releasing the gitvault maintenance lease" }),
    // ── prune (§7.3) ──
    async submitPruneIntent({ repo_id, intent_bytes }) {
      // Deliberately NOT `client.request`: that serializes a body object, and
      // the gateway strict-parses + signature-verifies THESE bytes (the route
      // is registered through `express.raw`). Re-serializing an equal-valued
      // object would change what was signed. Same raw-fetch shape the
      // generation-addressed reads use, so it inherits the same credentials.
      const path = `${base(repo_id)}/prune-intents`;
      const auth = (await client.credentials.getAuth(path, { method: "gitvault.prune" })) ?? {};
      const r = await client.fetch(`${client.apiBase}${path}`, {
        method: "POST",
        headers: { ...auth, "content-type": "application/json", accept: "application/json" },
        body: intent_bytes as unknown as BodyInit,
      });
      const text = await r.text();
      let parsed: unknown = null;
      try {
        parsed = text.length > 0 ? JSON.parse(text) : null;
      } catch {
        parsed = null;
      }
      if (!r.ok) {
        const envelope = parsed as { error?: { code?: string; message?: string; details?: unknown } } | null;
        fail(
          envelope?.error?.code ?? "GITVAULT_PRUNE_SUBMIT_FAILED",
          envelope?.error?.message ?? `prune intent submission failed (HTTP ${r.status})`,
          "submitting the gitvault prune intent",
          { status: r.status, details: envelope?.error?.details ?? null },
        );
      }
      const body = (parsed ?? {}) as GitvaultPruneIntentRecord & { stored?: boolean };
      return { ...body, stored: body.stored === true };
    },
    async getPruneIntent({ repo_id, prune_intent_object_id }) {
      try {
        return await client.request<GitvaultPruneIntentRecord>(`${base(repo_id)}/prune-intents/${encodeURIComponent(prune_intent_object_id)}`, { context: "reading the gitvault prune intent" });
      } catch (e) {
        // Authorize-before-reveal: a malformed, absent, or foreign id all
        // return the SAME envelope, so `null` is the only honest reading.
        if (isRun402Error(e) && ((e as { status?: number }).status === 404 || (e as { code?: string }).code === "RESOURCE_NOT_FOUND")) return null;
        throw e;
      }
    },
  };
}

// ─── Storage paths (§3) ──────────────────────────────────────────────────────

export const gitvaultPaths = {
  head: (generation: string) => `head/${generation}`,
  admission: (generation: string) => `admissions/${generation}`,
  wal: (id: string) => `wal/${id}.pack.enc`,
  refState: (id: string) => `refs/${id}.enc`,
  retentionRoots: (id: string) => `retention/${id}.enc`,
  checkpointManifest: (id: string) => `checkpoints/${id}.manifest.enc`,
  checkpointPack: (id: string) => `checkpoints/${id}.pack.enc`,
  claimSet: (id: string) => `checkpoints/${id}.claims.json`,
  cutoffTicket: (id: string) => `retention/${id}.ticket.json`,
  /** `verifier-receipts/<vr>.json` — plaintext-structured, uploaded before a prune intent may reference it (§7.3). */
  verifierReceipt: (id: string) => `verifier-receipts/${id}.json`,
  /**
   * `envelopes/<epoch>/<recipient_fingerprint>` — mirrors
   * `gitvault-creation-journal.ts`'s private `envelopePath` (the genesis
   * creator's envelope); this is the same addressing for every OTHER
   * recipient's `key_envelope`. `rotationId` present (D195, rev 42) widens
   * this to `envelopes/<epoch>/<rotation_id>/<recipient_fingerprint>` — a
   * rotation-attempt envelope's own path (protocol §1: `rotation_id`
   * ABSENT, never explicit null, in the genesis/ADD-workaround case).
   */
  envelope: (epoch: string, recipientFingerprint: string, rotationId?: string | null) =>
    rotationId ? `envelopes/${epoch}/${rotationId}/${recipientFingerprint}` : `envelopes/${epoch}/${recipientFingerprint}`,
  /** `recipient-pins/<pin_manifest_version>.json` (D197, rev 42) — version-addressed, plaintext-structured, writer-signed. */
  pinManifest: (pinManifestVersion: string) => `recipient-pins/${pinManifestVersion}.json`,
} as const;

// ─── The vault ───────────────────────────────────────────────────────────────

export interface GitvaultVaultOptions {
  keystore: GitvaultKeystore;
  transport: GitvaultTransport;
  repo_id: string;
  /** The local git repository (objects for pack building / ancestry); optional for read-only use. */
  repo_dir?: string;
  now?: () => Date;
  /** Verification budget per call (resumable — the verified prefix persists). */
  verification_budget?: number;
  conflict_retries?: number;
  /** The signing service key resolved through the registry — when supplied, control-plane-signed messages (cutoff tickets) are signature-checked. */
  service_public_key?: Uint8Array | string;
}

/** How a checkpoint-bearing head binds a `retention_cutoff` ticket and expires roots (§4.5a / §4.5). */
export interface GitvaultCutoffOptions {
  /**
   * `effective_admitted_at` for a root's drop generation, or `null` when this
   * client cannot resolve it — a `null` RETAINS the root (expiry is permissive).
   * `effective_admitted_at = max(prepared_at, the admission record's storage
   * creation time)`; deriving it from `prepared_at` alone shortens the lane.
   */
  effectiveAdmittedAt?: (droppedAtGeneration: string) => string | null;
}

export interface GitvaultVerifiedState {
  generation: string;
  head_sha256: string;
  /** `null` at generation zero. */
  head: GitvaultHead | null;
  genesis: GitvaultVaultGenesis;
}

export interface GitvaultMaterializedState extends GitvaultVerifiedState {
  ref_state: GitvaultRefState | null;
  retention_roots: GitvaultRetentionRoots | null;
  refs: GitvaultRefMap;
  roots: GitvaultRetentionRoot[];
  head_target: GitvaultHeadTarget;
}

/** One directory entry {@link GitvaultVault.reconcileEnvelopeRecipients} wrapped a fresh `key_envelope` for. */
export interface GitvaultReconcileEnvelopeRecipientsWrapped {
  principal_id: string;
  ek_fingerprint: string;
}

/** Why {@link GitvaultVault.reconcileEnvelopeRecipients} did NOT wrap a directory entry it otherwise would have. */
export type GitvaultReconcileEnvelopeRecipientsSkipReason = "missing_public_key" | "invalid_public_key" | "pinned_key_mismatch";

export interface GitvaultReconcileEnvelopeRecipientsSkipped {
  principal_id: string;
  ek_fingerprint: string;
  reason: GitvaultReconcileEnvelopeRecipientsSkipReason;
  /** `pinned_key_mismatch`: `{pinned_fingerprint, directory_fingerprint}`. `invalid_public_key` (derivation mismatch): `{derived_fingerprint}`. Absent for `missing_public_key` and a bad-encoding `invalid_public_key`. */
  details?: Record<string, unknown>;
}

/** {@link GitvaultVault.reconcileEnvelopeRecipients}'s full per-recipient breakdown. */
export interface GitvaultReconcileEnvelopeRecipientsResult {
  repo_id: string;
  org_id: string;
  /** The epoch every wrap in this call used (V0: always {@link GITVAULT_GENESIS_EPOCH}). */
  epoch: string;
  /** Directory entries this call itself wrapped a NEW `key_envelope` for. */
  wrapped: GitvaultReconcileEnvelopeRecipientsWrapped[];
  /** `ek_` fingerprints already covering the vault before (or, for a raced wrap, as of) this call — no action taken. */
  already_covered: string[];
  /** Directory entries this call could not (or, for `pinned_key_mismatch`, would not) wrap. */
  skipped: GitvaultReconcileEnvelopeRecipientsSkipped[];
}

export interface GitvaultPushOptions {
  transaction: GitvaultRefTransaction;
  /** New `HEAD` target for the published ref_state; carried forward when omitted. */
  head_target?: GitvaultHeadTarget;
  protocol_refs?: "refuse" | "allow";
  /** Force the checkpoint-bearing form (purpose `ordinary_push`) regardless of delta size. */
  checkpoint?: boolean;
  /** Bind a fresh `retention_cutoff` ticket so expired roots may leave the map (checkpoint-bearing heads only). */
  cutoff?: GitvaultCutoffOptions;
  /** Built lazily at head-sign time — the deploy lane may still be computing the plan digest. */
  capture_binding?: GitvaultCaptureBinding | (() => Promise<GitvaultCaptureBinding | null> | GitvaultCaptureBinding | null);
}

export interface GitvaultPublishResult {
  generation: string;
  head_sha256: string;
  head: GitvaultHead;
  admission_record_sha256: string;
  capture_receipt: GitvaultCaptureReceipt | null;
  /** `wal` = direct WAL receipts; `checkpoint` = the delta shipped as a checkpoint set. */
  form: "wal" | "checkpoint";
  conflicts_retried: number;
  refs: GitvaultRefMap;
}

/** {@link GitvaultVault.rotateEpoch}'s result (D193-D203, rev 42). */
export interface GitvaultRotationResult {
  outcome: "admitted";
  generation: string;
  head_sha256: string;
  new_epoch: string;
  rotation_id: string;
  reason: GitvaultRotationReason;
  included: { principal_id: string; ek_fingerprint: string }[];
  excluded_keyless_principal_ids: string[];
  excluded_unconfirmed_principal_ids: string[];
  admission_record_sha256: string;
  capture_receipt: GitvaultCaptureReceipt | null;
  /**
   * `"passed"` — this principal is itself an included recipient and its own
   * opened envelope reproduced the committed `K_e` + `epoch_key_commitment`
   * (D200's per-recipient self-check; a failure THROWS rather than
   * returning here — there is no `"failed"` value). `"not_a_recipient"` —
   * this principal (the vault's writer) is not itself in `included` (e.g.
   * it was excluded, or holds no local encryption key) — there is nothing
   * for this machine to self-check. This is NOT a confidentiality gap: the
   * writer sampled `kE` itself (it never needs a `key_envelope` to learn its
   * own secret) and `keystore.recordEpochRotation` below advances the LOCAL
   * pointer unconditionally, regardless of `self_check` — an agent/CI writer
   * that is deliberately never a directory envelope recipient (design D1 of
   * `services/gitvault/desired-recipients.ts`: "agents hold their own vault
   * keys in their CLI keystore") keeps read/write access to its own vault
   * through every rotation it itself drives, with or without an envelope.
   */
  self_check: "passed" | "not_a_recipient";
  /**
   * Present iff `options.pending_confirmations` was non-empty and its
   * receipted entries were folded into THIS SAME head's `pin_manifest`
   * field (D197 conservation; schema-legal per §4.3 — `transition` and
   * `pin_manifest` are independent optional fields on one `head`). `null`
   * when no fold was requested.
   *
   * **D196 boundary, load-bearing:** folding does NOT make these principals
   * `included` in THIS rotation's envelope set — "for a non-genesis
   * rotation, `confirmed(h)` reads the NEAREST PREDECESSOR admitted pin
   * manifest — a manifest update riding the SAME head never self-authorizes
   * its own recipients" (protocol-v0.md D196). They land in
   * `excluded_unconfirmed_principal_ids` for THIS rotation exactly as they
   * would without folding. What folding buys: the manifest becomes DURABLY
   * ADMITTED in the same atomic submission that is itself EXEMPT from
   * `EPOCH_ROTATION_REQUIRED` (a `rotate_epoch` admission is the gate's own
   * escape valve — it must be, or the flag it clears could never clear) —
   * closing the standalone `publishPinManifestUpdate` deadlock where the
   * manifest-only push is ITSELF an ordinary admission and therefore
   * ITSELF gated while migration/revocation/exposure is outstanding. The
   * newly-published principals become eligible starting from the NEXT
   * rotation (or the next ordinary push, once the flag clears).
   */
  pin_manifest_published: { pin_manifest_version: string; stored_bytes_sha256: string; principal_ids: string[] } | null;
}

/**
 * What {@link GitvaultVault.planPush} reports (kychee-com/run402#565) — a REAL
 * local computation, not an estimate: every number here comes from actually
 * building the packs (or checkpoint set) and actually sealing/encrypting
 * them, exactly as a real `push` would. `would_admit_generation` is what this
 * push would claim AT THE OBSERVED BASE — a concurrent publisher can still
 * win the race before a real push runs (see the method doc for why that is
 * not a defect: `git push --dry-run` carries the identical caveat).
 */
export interface GitvaultPushPlan {
  /** The base this plan was computed against — `materialize()`'s generation at call time. */
  base_generation: string;
  /** The generation a real push would claim, computed the same way a real push computes it (`nextGeneration(base_generation)`). */
  would_admit_generation: string;
  /** `would_admit_generation` as a plain decimal string — the hex generation is a wire format, not a human one. */
  would_admit_generation_decimal: string;
  /** `wal` = direct WAL receipts; `checkpoint` = the delta would ship as a checkpoint set — the SAME threshold real `push` uses. */
  form: "wal" | "checkpoint";
  /** The ref map this push would publish (after evaluating the transaction against the base). */
  refs: GitvaultRefMap;
  head_target: GitvaultHeadTarget;
  /** Every object that would be uploaded — `ref_state`, `retention_roots`, and the WAL/checkpoint pack(s) — with their REAL sealed (encrypted) sizes. */
  objects: Array<{ object_kind: GitvaultUploadObject["object_kind"]; size_bytes: string }>;
  object_count: number;
  /** Sum of `objects[].size_bytes` — the REAL ciphertext byte count a real push would upload. */
  encrypted_bytes: string;
  /** Sum of the plaintext pack bytes BEFORE sealing — what "objects that would publish" weigh on the wire before encryption overhead. */
  raw_bytes: string;
}

/**
 * What {@link GitvaultVault.verifyStoredCheckpoint} observed. Every boolean is
 * a FINDING, not a promise: a `false` here is what makes a truthful negative
 * `verifier_receipt` possible.
 */
export interface GitvaultStoredCheckpointAttestation {
  checkpoint_head_sha256: string;
  checkpoint_generation: string;
  claim_set_sha256: string;
  /** `null` in the no-removal checkpoint form — a prune needs one, so that is a refusal upstream. */
  cutoff_ticket_sha256: string | null;
  cutoff_at: string | null;
  covered_tips: string[];
  /** Covered tips that did NOT resolve from the restored set. Non-empty ⇒ the checkpoint does not verify. */
  missing_tips: string[];
  restored_object_set_hmac: string;
  object_set_matches: boolean;
  ref_state_matches: boolean;
  retention_roots_matches: boolean;
  /** The `rootset` commitment over this generation's roots carrier — the intent core's `retention_state_hmac`. */
  retention_state_hmac: string;
}

export interface GitvaultBuiltCheckpoint {
  manifest: GitvaultCheckpointManifest;
  claim_set: GitvaultCheckpointClaimSet;
  claim_set_receipt: GitvaultCheckpointBlock["claim_set"];
  objects: GitvaultUploadObject[];
  /** Plaintext packs in order (for the acceptance self-check). */
  packs: Uint8Array[];
  covered_tips: string[];
}

/** A transport-agnostic view of git ops the publication needs (the local repository). */
export class GitvaultVault {
  readonly keystore: GitvaultKeystore;
  readonly transport: GitvaultTransport;
  readonly repoId: string;
  readonly repoDir: string | null;
  private readonly now: () => Date;
  private readonly budget: number;
  private readonly retries: number;
  private readonly servicePublicKey: Uint8Array | string | null;
  private genesisCache: { genesis: GitvaultVaultGenesis; sha256: string } | null = null;

  constructor(options: GitvaultVaultOptions) {
    this.keystore = options.keystore;
    this.transport = options.transport;
    this.repoId = options.repo_id;
    this.repoDir = options.repo_dir ?? null;
    this.now = options.now ?? (() => new Date());
    this.budget = options.verification_budget ?? GITVAULT_VERIFICATION_BUDGET_HEADS;
    this.retries = options.conflict_retries ?? GITVAULT_PUSH_CONFLICT_RETRIES;
    this.servicePublicKey = options.service_public_key ?? null;
  }

  static open(options: GitvaultVaultOptions): GitvaultVault {
    const v = new GitvaultVault(options);
    v.repoFile(); // KEYSTORE_MISSING / GITVAULT_REPO_STATE_MISSING surface here
    return v;
  }

  repoFile(): GitvaultRepoFile {
    // Cross-profile hint (kychee-com/run402#564): a keystore-miss on the
    // ACTIVE profile is enriched, when the scan finds one, with which OTHER
    // local wallet profile holds this repo's key — a purely local
    // directory/filename read, appended after the existing remedy rather
    // than replacing it.
    if (!this.keystore.readIdentity()) {
      fail("KEYSTORE_MISSING", "no gitvault identity in the keystore", "opening gitvault vault", undefined, [
        { action: "restore ~/.config/run402/gitvault from backup or accept vault loss" },
        ...crossProfileGitvaultHint(this.repoId),
      ]);
    }
    const repo = this.keystore.readRepo(this.repoId);
    if (!repo) {
      const hint = crossProfileGitvaultHint(this.repoId);
      fail(
        "GITVAULT_REPO_STATE_MISSING",
        `no keystore repo file for ${this.repoId}; restore it from the principal's own envelope (keystore.restoreRepoFromEnvelope)`,
        "opening gitvault vault",
        { repo_id: this.repoId },
        hint.length > 0 ? hint : undefined,
      );
    }
    return repo;
  }

  private kRepo(): Uint8Array { return hexToBytes(this.repoFile().k_repo_hex); }
  private epoch(): string { return this.repoFile().epoch; }

  private git(): string {
    if (!this.repoDir) fail("GITVAULT_REPO_DIR_REQUIRED", "this operation needs the local git repository (repo_dir)", "gitvault publication");
    return this.repoDir;
  }

  /** Fetch + pin-check the genesis (the writer key source). */
  async genesis(): Promise<{ genesis: GitvaultVaultGenesis; sha256: string }> {
    if (this.genesisCache) return this.genesisCache;
    const repo = this.repoFile();
    const bytes = await this.transport.getGenesis({ repo_id: this.repoId });
    if (!bytes) fail("CHAIN_BROKEN", "the vault has no admitted genesis", "reading gitvault genesis", { repo_id: this.repoId });
    const sha256 = sha256Hex(bytes);
    if (sha256 !== repo.genesis_sha256) fail("VAULT_CREATION_CONFLICT", `the admitted genesis (${sha256}) is not the pinned one (${repo.genesis_sha256}); refusing a substituted vault`, "reading gitvault genesis", { admitted: sha256, pinned: repo.genesis_sha256 });
    const genesis = parseGitvaultStrict(new TextDecoder().decode(bytes)) as GitvaultVaultGenesis;
    this.genesisCache = { genesis, sha256 };
    return this.genesisCache;
  }

  // ── §6.3/6.4 discovery + verification ──

  /**
   * List from the authenticated pin and verify every link upward. Persists
   * the verified prefix after each page, so a `VERIFICATION_BUDGET_EXCEEDED`
   * continues rather than restarts. Returns the newest verified state.
   *
   * `options.persist` (default `true`, repo-surface-consolidation task 3.3 —
   * `repos fsck --no-write`'s audit mode): when `false`, the chain is walked
   * and verified exactly the same way, but every `keystore.updateRepo(...)`
   * write below is skipped — no local trust pin advances. A
   * `VERIFICATION_BUDGET_EXCEEDED` pause in this mode persists nothing, so a
   * retry restarts from the ORIGINAL pin rather than resuming — the honest
   * consequence of asking for a no-write audit and then walking off the end
   * of one call's budget.
   */
  async verifyToNewest(options: { persist?: boolean } = {}): Promise<GitvaultVerifiedState> {
    const persist = options.persist ?? true;
    const { genesis, sha256: genesisSha } = await this.genesis();
    const writerKey = genesis.creator_signing_pubkey;
    const writerKeyId = genesis.writer_key_id;
    const repo = this.repoFile();
    let pin: GitvaultHeadPin = repo.verified_prefix ?? repo.head_pin ?? { generation: GITVAULT_GENESIS_GENERATION, head_sha256: genesisSha, pinned_at: formatGitvaultTimestamp(this.now()) };
    let lastHead: GitvaultHead | null = pin.generation === GITVAULT_GENESIS_GENERATION ? null : await this.readHead(pin.generation, pin.head_sha256);
    const anchor = pin.generation;
    let progress: GitvaultListingProgress = { after_generation: anchor, last_generation: anchor, delivered: 0 };
    let request: GitvaultHeadsListingRequest = { after_generation: anchor, limit: String(GITVAULT_MAX_HEADS_PER_LISTING_PAGE) };
    let verified = 0;
    for (;;) {
      const page = await this.transport.listHeads({ repo_id: this.repoId, ...request });
      progress = verifyHeadsListingPage(page, request, progress, this.repoId);
      for (const entry of page.heads) {
        if (verified >= this.budget) {
          if (persist) this.keystore.updateRepo(this.repoId, { verified_prefix: pin });
          fail(
            "VERIFICATION_BUDGET_EXCEEDED",
            persist
              ? `${verified} heads verified this call; the verified prefix (generation ${pin.generation}) is persisted — call again to continue`
              : `${verified} heads verified this call in no-write mode; nothing was persisted — a retry restarts from the original pin, not generation ${pin.generation}`,
            "verifying gitvault chain",
            { verified_through: pin.generation, persisted: persist },
            [{ action: persist ? "resume verification from the persisted verified prefix" : "re-run without --no-write to persist and resume incrementally, or re-run this same audit call again from the start" }],
          );
        }
        const bytes = await this.transport.getObject({ repo_id: this.repoId, path: gitvaultPaths.head(entry.generation) });
        if (!bytes) fail("CHAIN_BROKEN", `listed head ${entry.generation} is absent from storage`, "verifying gitvault chain", { generation: entry.generation });
        const head = parseGitvaultStrict(new TextDecoder().decode(bytes)) as GitvaultHead;
        checkChainLink({ head, stored_bytes: bytes, listed_sha256: entry.stored_bytes_sha256, expected_generation: nextGeneration(pin.generation), prev_sha256: pin.head_sha256, repo_id: this.repoId, writer_public_key: writerKey, writer_key_id: writerKeyId });
        try {
          assertNoTransition(head);
        } catch (e) {
          // fail closed: pin stays BELOW the transition head; the verified prefix is cleared (this is the final state, not a budget pause)
          if (persist) this.keystore.updateRepo(this.repoId, { head_pin: pin, verified_prefix: null });
          throw e;
        }
        pin = { generation: head.generation, head_sha256: entry.stored_bytes_sha256, pinned_at: formatGitvaultTimestamp(this.now()) };
        lastHead = head;
        verified += 1;
      }
      // verified prefix persists per page (resumable) — skipped entirely in no-write mode
      if (persist) this.keystore.updateRepo(this.repoId, { verified_prefix: pin });
      const next = nextListingRequest(request, page);
      if (!next) break;
      request = next;
    }
    if (persist) this.keystore.updateRepo(this.repoId, { head_pin: pin, verified_prefix: null });
    return { generation: pin.generation, head_sha256: pin.head_sha256, head: lastHead, genesis };
  }

  private async readHead(generation: string, expectedSha256: string): Promise<GitvaultHead> {
    const bytes = await this.transport.getObject({ repo_id: this.repoId, path: gitvaultPaths.head(generation) });
    // Absent ⇒ the vault no longer holds a generation this client authenticated: a ROLLBACK, not a
    // broken link (chain-005). Present-but-different bytes IS a broken link (substituted object).
    if (!bytes) {
      fail("GENERATION_REGRESSION", `the vault no longer holds the authenticated generation ${generation}; it regressed below the pin`, "reading pinned gitvault head", { generation }, [
        { action: "do not publish; escalate — the vault regressed below a generation this client authenticated" },
      ]);
    }
    if (sha256Hex(bytes) !== expectedSha256) fail("CHAIN_BROKEN", `pinned head ${generation} no longer hashes to the pin`, "reading pinned gitvault head", { generation });
    return parseGitvaultStrict(new TextDecoder().decode(bytes)) as GitvaultHead;
  }

  /** Decrypt one encrypted carrier object by its receipt; any failure is `CHAIN_UNUSABLE`. */
  private async openCarrier<T extends { object_kind: string; signature: string }>(kind: "ref_state" | "retention_roots" | "checkpoint_manifest", receipt: { object_id: string; ciphertext_sha256: string }, path: string, writerKey: string): Promise<T> {
    const frame = await this.transport.getObject({ repo_id: this.repoId, path });
    if (!frame) fail("CHAIN_UNUSABLE", `${kind} ${receipt.object_id} is absent from storage`, "materializing gitvault head", { object_id: receipt.object_id }, [{ action: "stay read-only at the materialized pin; run the repair path" }]);
    let plaintext: Uint8Array;
    try {
      plaintext = openFrame({ k_obj: deriveObjectKey(this.kRepo(), this.repoId, this.epoch(), kind, receipt.object_id), repo_id: this.repoId, object_kind: kind, object_id: receipt.object_id, epoch: this.epoch(), frame, expected_ciphertext_sha256: receipt.ciphertext_sha256 });
    } catch (e) {
      fail("CHAIN_UNUSABLE", `${kind} ${receipt.object_id} cannot be opened: ${(e as Error).message}`, "materializing gitvault head", { object_id: receipt.object_id }, [{ action: "stay read-only at the materialized pin; run the repair path" }]);
    }
    const object = parseGitvaultStrict(new TextDecoder().decode(plaintext)) as T;
    if (object.object_kind !== kind || (object as { object_id?: string }).object_id !== receipt.object_id || (object as { repo_id?: string }).repo_id !== this.repoId || !verifyGitvaultObject(object as unknown as GitvaultSignedObject, writerKey)) {
      fail("CHAIN_UNUSABLE", `${kind} ${receipt.object_id} plaintext fails its identity/signature checks`, "materializing gitvault head", { object_id: receipt.object_id });
    }
    return object;
  }

  /**
   * Verify to newest, then decrypt + apply its carriers — advancing the
   * materialized pin. `options.persist` (default `true`) is forwarded to
   * {@link verifyToNewest} and gates this method's OWN `materialized_pin`
   * write the same way — `repos fsck --no-write` computes and returns the
   * real ref map and generation without moving either local pin.
   */
  async materialize(options: { persist?: boolean } = {}): Promise<GitvaultMaterializedState> {
    const persist = options.persist ?? true;
    const state = await this.verifyToNewest({ persist });
    const writerKey = state.genesis.creator_signing_pubkey;
    if (!state.head) {
      if (persist) this.keystore.updateRepo(this.repoId, { materialized_pin: { generation: state.generation, head_sha256: state.head_sha256, pinned_at: formatGitvaultTimestamp(this.now()) } });
      return { ...state, ref_state: null, retention_roots: null, refs: {}, roots: [], head_target: { kind: "symref", ref: "refs/heads/main" } };
    }
    const refState = await this.openCarrier<GitvaultRefState>("ref_state", state.head.ref_state, gitvaultPaths.refState(state.head.ref_state.object_id), writerKey);
    const roots = await this.openCarrier<GitvaultRetentionRoots>("retention_roots", state.head.retention_roots, gitvaultPaths.retentionRoots(state.head.retention_roots.object_id), writerKey);
    if (refState.generation !== state.generation || roots.generation !== state.generation) fail("CHAIN_UNUSABLE", "carrier generation does not match the head", "materializing gitvault head");
    if (persist) this.keystore.updateRepo(this.repoId, { materialized_pin: { generation: state.generation, head_sha256: state.head_sha256, pinned_at: formatGitvaultTimestamp(this.now()) } });
    return { ...state, ref_state: refState, retention_roots: roots, refs: { ...refState.refs }, roots: roots.roots.map((r) => ({ ...r })), head_target: refState.head_target };
  }

  // ── envelope recipients (gitvault-human-envelopes task 4.1, the ADD-path workaround) ──

  /**
   * Wrap the vault's CURRENT epoch key to every org member the directory
   * lists but the vault does not yet have a `key_envelope` for.
   *
   * **This is task 1.1's residual WORKAROUND, not the design D5 ideal.** D5
   * describes a recipient-set change as an epoch rotation — "history epochs
   * stay wrapped as they were; a new member reads from their first covered
   * epoch forward" — which needs a protocol revision (task 1, BLOCKED as of
   * 2026-08-26: V0 pins `epoch` to the single constant
   * `GITVAULT_GENESIS_EPOCH` on every head, so there is no "forward" to
   * speak of yet). What this method actually does, legally, without any
   * protocol change: `key_envelope` objects are never head-referenced (not
   * even genesis's own envelope is), so uploading an ADDITIONAL one at
   * `envelopes/<current epoch>/<recipient fingerprint>` for a missing
   * recipient is accepted by the existing generic create-only upload route
   * as-is. The honest consequence: a newly-wrapped member gets the SAME
   * single epoch every existing member already has, which in V0 means the
   * vault's ENTIRE history — not "from here forward." True forward-only
   * semantics wait on task 1's protocol revision; this method does not
   * pretend otherwise.
   *
   * **TOFU pinning (design D4 point 3).** The first time this repo wraps a
   * given `principal_id`, its CURRENT `ek_fingerprint` is pinned in the
   * keystore repo file (`envelope_recipient_pins`). On a later call, a
   * directory entry whose fingerprint no longer matches its pin is a
   * REFUSAL for that recipient ONLY — reported under `skipped` with reason
   * `pinned_key_mismatch` and both fingerprints in `details`, never wrapped
   * under the new key, and never a thrown error that would abort the whole
   * call (other recipients still get processed). Whether that mismatch is a
   * legitimate key rotation or a substitution is a product/human decision
   * this SDK does not make unattended.
   *
   * **The gateway directory route carries `public_key` on every row**
   * (`GET /orgs/v1/:org_id/encryption-keys`, deployed 2026-08-26 — see the
   * doc comment on {@link GitvaultOrgEncryptionKeyEntry}), so against a
   * current gateway entries actually wrap. A directory entry that arrives
   * WITHOUT the field (an older/rolling-deploy gateway) is still tolerated
   * per-entry — reported under `skipped` with reason `missing_public_key`,
   * never a thrown error that would abort the other recipients.
   *
   * Best-effort by design at the call site, not here: this method itself
   * either completes (returning a full per-recipient breakdown) or throws
   * (e.g. `GITVAULT_READ_ONLY` when this principal holds no signing key).
   * Callers that want "never block on this" (the deploy hook) wrap the call
   * themselves — see `Gitvault.push`'s `#tryReconcileEnvelopeRecipients`.
   */
  async reconcileEnvelopeRecipients(): Promise<GitvaultReconcileEnvelopeRecipientsResult> {
    const repo = this.repoFile();
    const epoch = this.epoch();
    const signer = this.signingKeypair();
    const [directory, coverage] = await Promise.all([
      this.transport.listOrgEncryptionKeys({ org_id: repo.org_id }),
      this.transport.listEnvelopeRecipients({ repo_id: this.repoId }),
    ]);
    const covered = new Set(coverage.recipient_fingerprints);
    const pins = { ...(repo.envelope_recipient_pins ?? {}) };
    const wrapped: GitvaultReconcileEnvelopeRecipientsWrapped[] = [];
    const alreadyCovered: string[] = [];
    const skipped: GitvaultReconcileEnvelopeRecipientsSkipped[] = [];
    let pinsChanged = false;

    for (const entry of directory.keys) {
      if (covered.has(entry.ek_fingerprint)) {
        alreadyCovered.push(entry.ek_fingerprint);
        continue;
      }
      const pinned = pins[entry.principal_id];
      if (pinned !== undefined && pinned !== entry.ek_fingerprint) {
        skipped.push({ principal_id: entry.principal_id, ek_fingerprint: entry.ek_fingerprint, reason: "pinned_key_mismatch", details: { pinned_fingerprint: pinned, directory_fingerprint: entry.ek_fingerprint } });
        continue;
      }
      if (typeof entry.public_key !== "string" || entry.public_key.length === 0) {
        skipped.push({ principal_id: entry.principal_id, ek_fingerprint: entry.ek_fingerprint, reason: "missing_public_key" });
        continue;
      }
      let recipientPublicKey: Uint8Array;
      try {
        recipientPublicKey = fromBase64url(entry.public_key, "public_key");
      } catch {
        skipped.push({ principal_id: entry.principal_id, ek_fingerprint: entry.ek_fingerprint, reason: "invalid_public_key" });
        continue;
      }
      // Defense in depth: a directory row whose printed fingerprint does not
      // derive from its own public_key is corrupt data, not a valid
      // recipient — fail loud here rather than let `sealKeyEnvelope` (which
      // derives the fingerprint itself and never trusts a caller-supplied
      // one) silently seal under a fingerprint that disagrees with the one
      // the directory printed.
      const derived = ekFingerprint(recipientPublicKey);
      if (derived !== entry.ek_fingerprint) {
        skipped.push({ principal_id: entry.principal_id, ek_fingerprint: entry.ek_fingerprint, reason: "invalid_public_key", details: { derived_fingerprint: derived } });
        continue;
      }
      const sealed = await sealKeyEnvelope({
        k_repo: this.kRepo(),
        repo_id: this.repoId,
        epoch,
        recipient_public_key: recipientPublicKey,
        signer,
        created_at: formatGitvaultTimestamp(this.now()),
      });
      try {
        await this.transport.putObject({
          repo_id: this.repoId,
          path: gitvaultPaths.envelope(epoch, sealed.receipt.recipient_fingerprint),
          bytes: sealed.stored_bytes,
          expected_sha256: sealed.stored_bytes_sha256,
          expected_size_bytes: sealed.size_bytes,
        });
        wrapped.push({ principal_id: entry.principal_id, ek_fingerprint: entry.ek_fingerprint });
      } catch (e) {
        // A concurrent reconcile (another machine/session) may have wrapped
        // the SAME recipient first — HPKE seal is randomized, so two valid
        // wraps of the same K_repo to the same recipient produce DIFFERENT
        // ciphertext bytes, and the create-only path's read-and-compare
        // reports that as `GITVAULT_OBJECT_EXISTS_DIFFERENT` even though the
        // recipient is now genuinely covered. Treat exactly that code as a
        // benign race, not a failure; anything else propagates.
        if (isRun402Error(e) && (e as { code?: string }).code === "GITVAULT_OBJECT_EXISTS_DIFFERENT") {
          alreadyCovered.push(entry.ek_fingerprint);
        } else {
          throw e;
        }
      }
      pins[entry.principal_id] = entry.ek_fingerprint;
      pinsChanged = true;
    }

    if (pinsChanged) this.keystore.updateRepo(this.repoId, { envelope_recipient_pins: pins });
    return { repo_id: this.repoId, org_id: repo.org_id, epoch, wrapped, already_covered: alreadyCovered, skipped };
  }

  // ── object building ──

  /**
   * `keyOverride` (D194, rev 42): a `rotate_epoch` head's OWN `ref_state`/
   * `retention_roots` must be sealed under the NEWLY-sampled `K_e` at the
   * NEW epoch, never under `this.kRepo()`/`this.epoch()` (the about-to-be-
   * superseded current key) — every other call site keeps calling `seal`
   * with no override, unaffected.
   */
  private seal(kind: "wal_pack" | "ref_state" | "retention_roots" | "checkpoint_manifest" | "checkpoint_pack", objectId: string, plaintext: Uint8Array, path: string, keyOverride?: { k_repo: Uint8Array; epoch: string }): GitvaultUploadObject {
    const kRepo = keyOverride?.k_repo ?? this.kRepo();
    const epoch = keyOverride?.epoch ?? this.epoch();
    const sealed = sealFrame({ k_obj: deriveObjectKey(kRepo, this.repoId, epoch, kind, objectId), repo_id: this.repoId, object_kind: kind, object_id: objectId, epoch, plaintext });
    return { path, object_kind: kind, object_id: objectId, bytes: sealed.frame, sha256: sealed.ciphertext_sha256, size_bytes: sealed.size_bytes };
  }

  /**
   * The owner signing seed, or `GITVAULT_READ_ONLY`.
   *
   * Public so the prune lane signs its intent core, wrapper, and verifier
   * receipt through the SAME refusal path every other signed object uses — a
   * second "get the seed" helper is a second place for a read-only principal to
   * slip through. The vault is already open by the time this is reachable, so
   * `ensureIdentity` never MINTS here (it would refuse at `repoFile()` first).
   */
  signer(): Uint8Array {
    const identity = this.keystore.ensureIdentity();
    const kp = this.keystore.signingKeypair(identity);
    if (!kp) fail("GITVAULT_READ_ONLY", "the signing key is missing from identity.json; this principal is read-only", "signing gitvault object", undefined, [{ action: "stay read-only at the materialized pin" }]);
    return kp.seed;
  }

  private writerKeyId(): string { return this.keystore.ensureIdentity().signing_fingerprint; }

  /** The owner's full signing keypair, or `GITVAULT_READ_ONLY` — same refusal path as {@link signer}, which returns only the seed; {@link sealKeyEnvelope} needs both halves. */
  private signingKeypair(): GitvaultSigningKeypair {
    const identity = this.keystore.ensureIdentity();
    const kp = this.keystore.signingKeypair(identity);
    if (!kp) fail("GITVAULT_READ_ONLY", "the signing key is missing from identity.json; this principal is read-only", "signing gitvault object", undefined, [{ action: "stay read-only at the materialized pin" }]);
    return kp;
  }

  private buildRefState(generation: string, refs: GitvaultRefMap, headTarget: GitvaultHeadTarget, keyOverride?: { k_repo: Uint8Array; epoch: string }): { object: GitvaultRefState; upload: GitvaultUploadObject } {
    if (headTarget.kind === "symref" && !BRANCH_REF_RE.test(headTarget.ref)) fail("REFNAME_UNSUPPORTED", `head_target symref must name a refs/heads/* branch: ${headTarget.ref}`, "building ref_state");
    if (headTarget.kind === "detached" && !GITVAULT_OID40_RE.test(headTarget.oid)) fail("REF_TRANSACTION_INVALID", "detached head_target needs a 40-hex oid", "building ref_state");
    assertRefMapCardinality(refs);
    const sorted: GitvaultRefMap = {};
    for (const k of Object.keys(refs).sort()) sorted[k] = refs[k]!;
    const id = newGitvaultId("refs");
    const object = signGitvaultObject({ format: GITVAULT_FORMAT, object_kind: "ref_state" as const, suite: GITVAULT_SUITE, repo_id: this.repoId, object_id: id, generation, refs: sorted, head_target: headTarget }, this.signer()) as GitvaultRefState;
    const plaintext = storedBytes(object as unknown as GitvaultSignedObject);
    if (plaintext.length > GITVAULT_MAX_REF_STATE_OBJECT_BYTES) fail("REF_STATE_LIMIT_EXCEEDED", "ref_state object exceeds 32 MiB", "building ref_state");
    return { object, upload: this.seal("ref_state", id, plaintext, gitvaultPaths.refState(id), keyOverride) };
  }

  private buildRetentionRoots(generation: string, roots: GitvaultRetentionRoot[], cutoff: GitvaultRetentionRoots["cutoff"], keyOverride?: { k_repo: Uint8Array; epoch: string }): { object: GitvaultRetentionRoots; upload: GitvaultUploadObject } {
    const id = newGitvaultId("rr");
    const object = signGitvaultObject({ format: GITVAULT_FORMAT, object_kind: "retention_roots" as const, suite: GITVAULT_SUITE, repo_id: this.repoId, object_id: id, generation, cutoff, roots: [...roots].sort(compareRoots) }, this.signer()) as GitvaultRetentionRoots;
    const plaintext = storedBytes(object as unknown as GitvaultSignedObject);
    if (plaintext.length > GITVAULT_MAX_REF_STATE_OBJECT_BYTES) fail("REF_STATE_LIMIT_EXCEEDED", "retention_roots object exceeds 32 MiB", "building retention_roots");
    return { object, upload: this.seal("retention_roots", id, plaintext, gitvaultPaths.retentionRoots(id), keyOverride) };
  }

  /** Plaintext, independently non-thin packs covering `reachable(tips) ∖ reachable(base)`, split at the multi-object target. */
  async buildPacks(tips: string[], base: string[]): Promise<Uint8Array[]> {
    const dir = this.git();
    const uniqueTips = [...new Set(tips)].filter((t) => GITVAULT_OID40_RE.test(t));
    if (uniqueTips.length === 0) return [];
    const presentBase: string[] = [];
    for (const b of new Set(base)) if (GITVAULT_OID40_RE.test(b) && (await hasObject(dir, b))) presentBase.push(b);
    const tmp = mkdtempSync(join(tmpdir(), "run402-gitvault-packs-"));
    try {
      const revs = [...uniqueTips, ...presentBase.map((b) => `^${b}`)].join("\n") + "\n";
      await hardenedGit(dir, ["pack-objects", "--revs", "--no-reuse-delta", "--delta-base-offset", `--max-pack-size=${GITVAULT_MULTI_OBJECT_PACK_TARGET_BYTES}`, "-q", join(tmp, "p")], { input: revs });
      const files = readdirSync(tmp).filter((f) => f.endsWith(".pack")).sort();
      return files.map((f) => new Uint8Array(readFileSync(join(tmp, f))));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  /** Sorted unique object ids reachable from `tips` (the `"objectset"` content). */
  async objectSet(tips: string[]): Promise<string[]> {
    return this.objectSetIn(this.git(), tips);
  }

  /**
   * The same `"objectset"` content computed in an ARBITRARY repository.
   *
   * The prune lane's restore-and-verify pass runs against a scratch clone-back,
   * not the working tree, and must recompute the digest there with the same
   * canonicalization the manifest was built with — hence one implementation,
   * parameterized by directory, rather than a second rev-list at the call site.
   */
  async objectSetIn(dir: string, tips: string[]): Promise<string[]> {
    const unique = [...new Set(tips)].filter((t) => GITVAULT_OID40_RE.test(t));
    if (unique.length === 0) return [];
    const out = await hardenedGit(dir, ["rev-list", "--objects", "--no-object-names", ...unique]);
    return objectsetContent(out.lines().map((l) => l.trim())).oids;
  }

  /**
   * Decrypt one generation's `retention_roots` carrier by its head receipt.
   *
   * `materialize()` opens only the NEWEST carrier; the prune lane must compare
   * consecutive generations to see which roots LEFT the map, so it needs any
   * generation's. Same `openCarrier` path, same `CHAIN_UNUSABLE` semantics — a
   * carrier that cannot be opened is never silently treated as empty.
   */
  async openRetentionRootsAt(receipt: GitvaultRetentionRootsReceipt): Promise<GitvaultRetentionRoots> {
    const { genesis } = await this.genesis();
    return this.openCarrier<GitvaultRetentionRoots>("retention_roots", receipt, gitvaultPaths.retentionRoots(receipt.object_id), genesis.creator_signing_pubkey);
  }

  private digest(label: GitvaultDigestLabel, content: unknown): string {
    return keyedCommitment(deriveDigestKey(this.kRepo(), this.repoId, this.epoch(), label), content);
  }

  /**
   * The §1 keyed commitment under one of the five `K_digest` labels.
   *
   * Public because the prune lane needs `gcrootset` (over the GC root set's
   * sorted receipts) and `rootset` (over the retention-roots carrier) and must
   * compute them with the SAME key derivation the checkpoint manifest uses —
   * two derivations for one commitment is how a verifier and a publisher stop
   * agreeing. Keyed by design (§7.3): a server-comparable plaintext digest
   * would be a confirmation oracle.
   */
  keyedDigest(label: GitvaultDigestLabel, content: unknown): string {
    return this.digest(label, content);
  }

  /** Strip the single top-level signature — the commitment preimage shape carriers use. */
  digestPreimage<T extends { signature: string }>(o: T): Omit<T, "signature"> {
    return this.withoutSignature(o);
  }

  private withoutSignature<T extends { signature: string }>(o: T): Omit<T, "signature"> {
    const { signature: _s, ...rest } = o;
    return rest;
  }

  /** Coverage tips (§4.7): canonical refs ∪ unexpired roots ∪ the HEAD target (detached commit; an unborn symref contributes nothing). */
  static coverageTips(refs: GitvaultRefMap, roots: GitvaultRetentionRoot[], headTarget: GitvaultHeadTarget): string[] {
    const tips = new Set<string>(Object.values(refs));
    for (const r of roots) tips.add(r.oid);
    if (headTarget.kind === "detached") tips.add(headTarget.oid);
    return [...tips].sort();
  }

  /**
   * Build a checkpoint set (§4.7): manifest + packs + the owner-signed claim
   * set, with the acceptance self-check (restore into an empty scratch, every
   * covered tip resolves, full connectivity, all three keyed commitments
   * recomputed). Coverage above the V0 maximum → `CHECKPOINT_SET_LIMIT_EXCEEDED`.
   */
  async buildCheckpoint(input: { generation: string; ref_state: GitvaultRefState; retention_roots: GitvaultRetentionRoots }): Promise<GitvaultBuiltCheckpoint> {
    const tips = GitvaultVault.coverageTips(input.ref_state.refs, input.retention_roots.roots, input.ref_state.head_target);
    for (const t of tips) if (!(await hasObject(this.git(), t))) fail("CHECKPOINT_INCOMPLETE", `covered tip ${t} is not present locally; the checkpoint cannot be built from this repository`, "building checkpoint set", { oid: t });
    const packs = await this.buildPacks(tips, []);
    if (packs.length > GITVAULT_MAX_CHECKPOINT_PACKS) fail("CHECKPOINT_SET_LIMIT_EXCEEDED", `${packs.length} packs exceed the ${GITVAULT_MAX_CHECKPOINT_PACKS}-pack V0 checkpoint maximum`, "building checkpoint set", undefined, [{ action: "compact or prune before adding coverage" }]);
    const entries: GitvaultCheckpointManifestPack[] = [];
    const objects: GitvaultUploadObject[] = [];
    let totalPlain = 0n;
    let totalStored = 0n;
    for (const pack of packs) {
      const id = newGitvaultId("ckp");
      const upload = this.seal("checkpoint_pack", id, pack, gitvaultPaths.checkpointPack(id));
      objects.push(upload);
      entries.push({ object_id: id, plaintext_sha256: sha256Hex(pack), plaintext_size_bytes: String(pack.length), ciphertext_sha256: upload.sha256, size_bytes: upload.size_bytes });
      totalPlain += BigInt(pack.length);
      totalStored += BigInt(upload.size_bytes);
    }
    const objectIds = await this.objectSet(tips);
    const manifestUnsigned = {
      format: GITVAULT_FORMAT, object_kind: "checkpoint_manifest" as const, suite: GITVAULT_SUITE, repo_id: this.repoId, object_id: newGitvaultId("chk"),
      covers_through_generation: input.generation, git_object_format: "sha1" as const, packs: entries, total_plaintext_size_bytes: String(totalPlain),
      ref_state_hmac: this.digest("refmap", this.withoutSignature(input.ref_state)),
      retention_roots_hmac: this.digest("rootset", this.withoutSignature(input.retention_roots)),
      object_set_hmac: this.digest("objectset", { oids: objectIds }),
    };
    const manifest = signGitvaultObject(manifestUnsigned, this.signer()) as GitvaultCheckpointManifest;
    const manifestUpload = this.seal("checkpoint_manifest", manifest.object_id, storedBytes(manifest as unknown as GitvaultSignedObject), gitvaultPaths.checkpointManifest(manifest.object_id));
    objects.unshift(manifestUpload);
    totalStored += BigInt(manifestUpload.size_bytes);
    if (totalStored > GITVAULT_MAX_CHECKPOINT_TOTAL_STORED_BYTES) fail("CHECKPOINT_SET_LIMIT_EXCEEDED", "the checkpoint's stored bytes exceed the 800 GiB V0 maximum", "building checkpoint set", { total_stored_size_bytes: String(totalStored) }, [{ action: "compact or prune before adding coverage" }]);
    const claimSet = signGitvaultObject({
      format: GITVAULT_FORMAT, object_kind: "checkpoint_claim_set" as const, suite: GITVAULT_SUITE, repo_id: this.repoId, object_id: newGitvaultId("ccs"),
      manifest_receipt: { object_id: manifest.object_id, object_kind: "checkpoint_manifest" as const, ciphertext_sha256: manifestUpload.sha256, size_bytes: manifestUpload.size_bytes },
      ordered_pack_receipts: entries.map((e): GitvaultCheckpointPackReceipt => ({ object_id: e.object_id, object_kind: "checkpoint_pack", ciphertext_sha256: e.ciphertext_sha256, size_bytes: e.size_bytes })),
      total_stored_size_bytes: String(totalStored), covers_through_generation: input.generation, writer_key_id: this.writerKeyId(),
    }, this.signer()) as GitvaultCheckpointClaimSet;
    const claimBytes = storedBytes(claimSet as unknown as GitvaultSignedObject);
    const claimUpload: GitvaultUploadObject = { path: gitvaultPaths.claimSet(claimSet.object_id), object_kind: "checkpoint_claim_set", object_id: claimSet.object_id, bytes: claimBytes, sha256: sha256Hex(claimBytes), size_bytes: String(claimBytes.length) };
    objects.push(claimUpload);
    const built: GitvaultBuiltCheckpoint = { manifest, claim_set: claimSet, claim_set_receipt: { object_id: claimSet.object_id, object_kind: "checkpoint_claim_set", stored_bytes_sha256: claimUpload.sha256, size_bytes: claimUpload.size_bytes }, objects, packs, covered_tips: tips };
    await this.acceptCheckpoint(built, input.ref_state, input.retention_roots);
    return built;
  }

  /** §4.7 acceptance: restore from the set ALONE into an empty scratch; every covered ref resolves; fsck connectivity; recompute the three commitments. */
  async acceptCheckpoint(built: GitvaultBuiltCheckpoint, refState: GitvaultRefState, roots: GitvaultRetentionRoots): Promise<void> {
    checkClaimSetEquality(built.claim_set, built.manifest, built.claim_set.covers_through_generation);
    const scratch = mkdtempSync(join(tmpdir(), "run402-gitvault-accept-"));
    try {
      await hardenedGit(scratch, ["init", "-q", "--bare", "--object-format=sha1", "."]);
      for (const pack of built.packs) {
        await hardenedGit(scratch, ["index-pack", "--stdin", "--strict"], { input: pack });
      }
      const tips = GitvaultVault.coverageTips(refState.refs, roots.roots, refState.head_target);
      for (const t of tips) {
        if (!(await hasObject(scratch, t))) fail("CHECKPOINT_INCOMPLETE", `covered tip ${t} does not resolve from the restored set`, "accepting checkpoint set", { oid: t }, [{ action: "rebuild the checkpoint set; restorers fall back to WAL replay" }]);
      }
      const fsck = await hardenedGit(scratch, ["fsck", "--no-dangling", "--connectivity-only", ...tips], { okStatuses: [1, 2] });
      if (fsck.status !== 0) fail("CHECKPOINT_INCOMPLETE", `fsck reports missing connectivity: ${fsck.stderr.slice(0, 300)}`, "accepting checkpoint set");
      const restored = tips.length === 0 ? [] : objectsetContent((await hardenedGit(scratch, ["rev-list", "--objects", "--no-object-names", ...tips])).lines().map((l) => l.trim())).oids;
      if (this.digest("objectset", { oids: restored }) !== built.manifest.object_set_hmac) fail("CHECKPOINT_INCOMPLETE", "restored object set does not match the manifest's object_set_hmac", "accepting checkpoint set");
      if (this.digest("refmap", this.withoutSignature(refState)) !== built.manifest.ref_state_hmac) fail("CHECKPOINT_INCOMPLETE", "ref_state_hmac mismatch", "accepting checkpoint set");
      if (this.digest("rootset", this.withoutSignature(roots)) !== built.manifest.retention_roots_hmac) fail("CHECKPOINT_INCOMPLETE", "retention_roots_hmac mismatch", "accepting checkpoint set");
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }

  /**
   * The §4.7 acceptance run against a checkpoint ALREADY IN STORAGE — the
   * restore-and-verify pass a `verifier_receipt` attests (§7.3).
   *
   * `acceptCheckpoint` above proves a checkpoint the client just BUILT; this
   * proves one the client is about to make a claim about, from the stored bytes
   * alone. It reports the observed facts rather than throwing on a mismatch,
   * because "the checkpoint does not verify" is exactly the finding a receipt
   * must be able to carry as `false` — turning it into an exception would make
   * an honest negative attestation impossible to produce.
   */
  async verifyStoredCheckpoint(head: GitvaultHead, headSha256: string): Promise<GitvaultStoredCheckpointAttestation> {
    const block = head.checkpoint;
    if (!block) fail("CHECKPOINT_INCOMPLETE", `head ${head.generation} carries no checkpoint to verify`, "verifying a stored checkpoint", { generation: head.generation });
    const { genesis } = await this.genesis();
    const writerKey = genesis.creator_signing_pubkey;
    const claimBytes = await this.transport.getObject({ repo_id: this.repoId, path: gitvaultPaths.claimSet(block.claim_set.object_id) });
    if (!claimBytes || sha256Hex(claimBytes) !== block.claim_set.stored_bytes_sha256) {
      fail("CHECKPOINT_INCOMPLETE", `checkpoint claim set ${block.claim_set.object_id} is absent or does not match the head's receipt`, "verifying a stored checkpoint", { object_id: block.claim_set.object_id });
    }
    const claimSet = parseGitvaultStrict(new TextDecoder().decode(claimBytes)) as GitvaultCheckpointClaimSet;
    if (!verifyGitvaultObject(claimSet as unknown as GitvaultSignedObject, writerKey)) fail("CHECKPOINT_INCOMPLETE", "checkpoint claim set signature fails", "verifying a stored checkpoint", { object_id: claimSet.object_id });
    const manifest = await this.openCarrier<GitvaultCheckpointManifest>("checkpoint_manifest", claimSet.manifest_receipt, gitvaultPaths.checkpointManifest(claimSet.manifest_receipt.object_id), writerKey);
    checkClaimSetEquality(claimSet, manifest, block.covers_through_generation);
    const refState = await this.openCarrier<GitvaultRefState>("ref_state", head.ref_state, gitvaultPaths.refState(head.ref_state.object_id), writerKey);
    const roots = await this.openCarrier<GitvaultRetentionRoots>("retention_roots", head.retention_roots, gitvaultPaths.retentionRoots(head.retention_roots.object_id), writerKey);
    const tips = GitvaultVault.coverageTips(refState.refs, roots.roots, refState.head_target);
    const scratch = mkdtempSync(join(tmpdir(), "run402-gitvault-attest-"));
    try {
      await hardenedGit(scratch, ["init", "-q", "--bare", "--object-format=sha1", "."]);
      for (const p of manifest.packs) {
        const frame = await this.transport.getObject({ repo_id: this.repoId, path: gitvaultPaths.checkpointPack(p.object_id) });
        if (!frame) fail("CHECKPOINT_INCOMPLETE", `checkpoint pack ${p.object_id} is absent from storage`, "verifying a stored checkpoint", { object_id: p.object_id });
        const plain = openFrame({ k_obj: deriveObjectKey(this.kRepo(), this.repoId, this.epoch(), "checkpoint_pack", p.object_id), repo_id: this.repoId, object_kind: "checkpoint_pack", object_id: p.object_id, epoch: this.epoch(), frame, expected_ciphertext_sha256: p.ciphertext_sha256 });
        if (sha256Hex(plain) !== p.plaintext_sha256 || String(plain.length) !== p.plaintext_size_bytes) fail("CHECKPOINT_INCOMPLETE", `checkpoint pack ${p.object_id} plaintext mismatch`, "verifying a stored checkpoint", { object_id: p.object_id });
        await hardenedGit(scratch, ["index-pack", "--stdin", "--strict"], { input: plain });
      }
      const missing: string[] = [];
      for (const t of tips) if (!(await hasObject(scratch, t))) missing.push(t);
      const fsck = tips.length === 0 ? { status: 0 } : await hardenedGit(scratch, ["fsck", "--no-dangling", "--connectivity-only", ...tips], { okStatuses: [1, 2] });
      const restored = tips.length === 0 || missing.length > 0 ? [] : await this.objectSetIn(scratch, tips);
      const restoredHmac = this.digest("objectset", { oids: restored });
      // Named locals, not inline ternaries: the no-removal checkpoint form has
      // no ticket at all, and both halves of that absence travel together.
      const cutoffTicketSha256: string | null = block.cutoff ? block.cutoff.ticket.stored_bytes_sha256 : null;
      const cutoffAt: string | null = block.cutoff ? block.cutoff.cutoff_at : null;
      return {
        checkpoint_head_sha256: headSha256,
        checkpoint_generation: head.generation,
        claim_set_sha256: block.claim_set.stored_bytes_sha256,
        cutoff_ticket_sha256: cutoffTicketSha256,
        cutoff_at: cutoffAt,
        covered_tips: tips,
        missing_tips: missing,
        restored_object_set_hmac: restoredHmac,
        object_set_matches: missing.length === 0 && fsck.status === 0 && restoredHmac === manifest.object_set_hmac,
        ref_state_matches: this.digest("refmap", this.withoutSignature(refState)) === manifest.ref_state_hmac,
        retention_roots_matches: this.digest("rootset", this.withoutSignature(roots)) === manifest.retention_roots_hmac,
        retention_state_hmac: this.digest("rootset", this.withoutSignature(roots)),
      };
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }

  /**
   * The whole verified chain, newest-first walk returned oldest-first, each
   * head paired with its checkpoint claim set (`null` when it bears none).
   *
   * The prune lane needs EVERY generation, not just the newest: a candidate is
   * an object some head once named and no surviving head still needs, and that
   * is only computable over the whole chain. Reuses {@link chainFrom}, so the
   * bytes are re-read and hash-checked against the verified chain rather than
   * trusted from a listing.
   */
  async chainEntries(): Promise<Array<{ head: GitvaultHead; head_sha256: string; claim_set: GitvaultCheckpointClaimSet | null }>> {
    const newest = await this.verifyToNewest();
    if (!newest.head) return [];
    const chain = await this.chainFrom("0000000000000001", newest);
    const generations = [...chain.keys()].sort();
    const out: Array<{ head: GitvaultHead; head_sha256: string; claim_set: GitvaultCheckpointClaimSet | null }> = [];
    const { genesis } = await this.genesis();
    for (const gen of generations) {
      const entry = chain.get(gen)!;
      let claimSet: GitvaultCheckpointClaimSet | null = null;
      const block = entry.head.checkpoint;
      if (block) {
        // Plaintext-structured and stored-bytes-receipted: no decryption, but
        // the hash and the owner signature are still checked before a single
        // pack receipt inside it is believed.
        const bytes = await this.transport.getObject({ repo_id: this.repoId, path: gitvaultPaths.claimSet(block.claim_set.object_id) });
        if (!bytes || sha256Hex(bytes) !== block.claim_set.stored_bytes_sha256) {
          fail("CHECKPOINT_INCOMPLETE", `checkpoint claim set ${block.claim_set.object_id} (generation ${gen}) is absent or altered`, "walking the gitvault chain", { generation: gen, object_id: block.claim_set.object_id });
        }
        claimSet = parseGitvaultStrict(new TextDecoder().decode(bytes)) as GitvaultCheckpointClaimSet;
        if (!verifyGitvaultObject(claimSet as unknown as GitvaultSignedObject, genesis.creator_signing_pubkey)) {
          fail("CHECKPOINT_INCOMPLETE", `checkpoint claim set ${claimSet.object_id} signature fails`, "walking the gitvault chain", { generation: gen });
        }
      }
      out.push({ head: entry.head, head_sha256: entry.sha256, claim_set: claimSet });
    }
    return out;
  }

  // ── upload with receipt-compare ──

  private async uploadAll(objects: GitvaultUploadObject[]): Promise<void> {
    const receipts = await this.transport.uploadObjects({ repo_id: this.repoId, objects });
    if (receipts.length !== objects.length) fail("GITVAULT_RECEIPT_MISMATCH", `${receipts.length} receipts for ${objects.length} objects`, "comparing finalization receipts");
    const mismatches = objects.filter((o, i) => receipts[i]!.path !== o.path || receipts[i]!.sha256 !== o.sha256 || receipts[i]!.size_bytes !== o.size_bytes);
    if (mismatches.length > 0) {
      fail("GITVAULT_RECEIPT_MISMATCH", `the server's finalization receipts do not match the expected manifest for ${mismatches.map((m) => m.path).join(", ")}; refusing to sign a head over them`, "comparing finalization receipts", { paths: mismatches.map((m) => m.path) });
    }
  }

  // ── §6.2 push ──

  /**
   * Build + upload + sign + admit ONE generation over `base`. Shared by the ref
   * transaction path (`push`) and the checkpoint-only path (`publishCheckpoint`); the
   * caller owns the conflict loop because only it knows how to re-derive the
   * next state from the winner.
   */
  private async publishGeneration(input: {
    base: GitvaultMaterializedState;
    refs: GitvaultRefMap;
    dropped: GitvaultDroppedTip[];
    head_target: GitvaultHeadTarget;
    force_checkpoint: boolean;
    cutoff: GitvaultCutoffOptions | null;
    // Optional (not just optional-VALUED): `planPush` never needs a binding —
    // it stops before `signHead` is reached, so omitting the key entirely
    // (rather than threading `capture_binding: undefined` through every dry
    // -run call site) is the honest shape.
    capture_binding?: GitvaultPushOptions["capture_binding"];
    /**
     * kychee-com/run402#565 — a REAL dry run. Every step above this flag's
     * check is identical to a real push: the same `evolveRetentionRoots`, the
     * same `buildRefState`/`buildRetentionRoots` (real signing), the same
     * `buildPacks`/`buildCheckpoint` (real pack building), the same `seal`
     * (real encryption) — so the sizes and the generation this returns are
     * exactly what a real push would compute AT THIS OBSERVED BASE, not an
     * estimate. Only the two NETWORK MUTATIONS (`uploadAll`, `admit`) are
     * skipped, per the client-surface spec's "refusing beats fake success":
     * this never claims a generation was admitted, only that it WOULD be, at
     * this base — a concurrent publisher can still take the same generation
     * first, exactly as `git push --dry-run` never promises a later
     * fast-forward will still be possible.
     */
    dry_run?: boolean;
  }): Promise<
    | { outcome: "admitted"; generation: string; head: GitvaultHead; head_sha256: string; admission_record_sha256: string; capture_receipt: GitvaultCaptureReceipt | null; form: "wal" | "checkpoint"; refs: GitvaultRefMap }
    | { outcome: "conflict"; generation: string; winner: { generation: string; stored_bytes_sha256: string } }
    | { outcome: "dry_run"; generation: string; form: "wal" | "checkpoint"; refs: GitvaultRefMap; head_target: GitvaultHeadTarget; objects: GitvaultUploadObject[]; raw_pack_bytes: number }
  > {
    const { base } = input;
    const generation = nextGeneration(base.generation);
    // The ticket is obtained BEFORE the checkpoint is built (§4.5a: expiry is evaluated against a
    // server time that exists before signing, never a future storage-commit time).
    const ticket = input.cutoff ? await this.issueRetentionCutoff(base.head_sha256) : null;
    const roots = evolveRetentionRoots(base.roots, {
      generation,
      dropped: input.dropped,
      ...(ticket && input.cutoff ? { checkpoint_cutoff: { cutoff_at: ticket.ticket.cutoff_at, effectiveAdmittedAt: input.cutoff.effectiveAdmittedAt ?? (() => null) } } : {}),
    });
    const refState = this.buildRefState(generation, input.refs, input.head_target);
    const rootsObj = this.buildRetentionRoots(generation, roots, ticket ? { cutoff_ticket_sha256: ticket.receipt.stored_bytes_sha256, cutoff_at: ticket.ticket.cutoff_at } : null);
    const baseTips = GitvaultVault.coverageTips(base.refs, base.roots, base.head_target);
    const newTips = GitvaultVault.coverageTips(input.refs, roots, input.head_target);
    // Preflight the projected coverage against the V0 checkpoint maximum (client-side, plaintext projection).
    const walPacks = input.force_checkpoint ? [] : await this.buildPacks(newTips, baseTips);
    let form: "wal" | "checkpoint";
    const walEntries: GitvaultWalPackReceipt[] = [];
    let checkpoint: GitvaultCheckpointBlock | null = null;
    const objects: GitvaultUploadObject[] = [refState.upload, rootsObj.upload];
    let rawPackBytes = 0;
    if (input.force_checkpoint || walPacks.length > GITVAULT_MAX_WAL_RECEIPTS_PER_HEAD) {
      form = "checkpoint";
      const built = await this.buildCheckpoint({ generation, ref_state: refState.object, retention_roots: rootsObj.object });
      objects.push(...built.objects);
      checkpoint = { claim_set: built.claim_set_receipt, covers_through_generation: generation, git_object_format: "sha1", cutoff: ticket ? { ticket: ticket.receipt, cutoff_at: ticket.ticket.cutoff_at } : null };
      rawPackBytes = built.packs.reduce((sum, p) => sum + p.length, 0);
    } else {
      form = "wal";
      for (const pack of walPacks) {
        const id = newGitvaultId("wal");
        const upload = { ...this.seal("wal_pack", id, pack, gitvaultPaths.wal(id)), base_generation: base.generation };
        objects.push(upload);
        walEntries.push({ object_id: id, object_kind: "wal_pack", ciphertext_sha256: upload.sha256, size_bytes: upload.size_bytes, base_generation: base.generation });
        rawPackBytes += pack.length;
      }
    }
    // kychee-com/run402#565: everything above this point is REAL local work —
    // real signing, real pack building, real encryption. Stopping HERE is what
    // makes the dry run honest: nothing below this line has run yet, so
    // nothing was uploaded and no generation was admitted.
    if (input.dry_run) {
      return { outcome: "dry_run", generation, form, refs: input.refs, head_target: input.head_target, objects, raw_pack_bytes: rawPackBytes };
    }
    await this.uploadAll(objects);
    const binding = typeof input.capture_binding === "function" ? await input.capture_binding() : input.capture_binding ?? null;
    const head = this.signHead({
      generation, prev_sha256: base.head_sha256, wal_entries: walEntries,
      ref_state: { object_id: refState.object.object_id, object_kind: "ref_state", ciphertext_sha256: refState.upload.sha256, size_bytes: refState.upload.size_bytes },
      retention_roots: { object_id: rootsObj.object.object_id, object_kind: "retention_roots", ciphertext_sha256: rootsObj.upload.sha256, size_bytes: rootsObj.upload.size_bytes },
      checkpoint, checkpoint_purpose: checkpoint ? "ordinary_push" : null, capture_binding: binding, repair: null,
    });
    const admitted = await this.admit(head);
    if (admitted.outcome === "conflict") return { outcome: "conflict", generation, winner: admitted.winner };
    return { outcome: "admitted", generation, head, head_sha256: admitted.head_sha256, admission_record_sha256: admitted.admission_record_sha256, capture_receipt: admitted.capture_receipt, form, refs: input.refs };
  }

  /** The complete push: verify → materialize → evaluate → pack → upload → head → admit (409: re-apply to the winner, retry) → read back → advance pins. */
  async push(options: GitvaultPushOptions): Promise<GitvaultPublishResult> {
    let conflicts = 0;
    for (;;) {
      const base = await this.materialize();
      const evaluation = await evaluateRefTransaction(base.refs, options.transaction, { isAncestor: (a, d) => isAncestor(this.git(), a, d), protocol_refs: options.protocol_refs });
      const published = await this.publishGeneration({
        base, refs: evaluation.refs, dropped: evaluation.dropped, head_target: options.head_target ?? base.head_target,
        force_checkpoint: options.checkpoint === true, cutoff: options.cutoff ?? null, capture_binding: options.capture_binding,
      });
      if (published.outcome === "conflict") {
        conflicts += 1;
        if (conflicts > this.retries) fail("HEAD_CAS_CONFLICT", `admission lost ${conflicts} races at generation ${published.generation}; giving up`, "publishing gitvault head", { generation: published.generation, winner: published.winner }, [{ action: "verify the attached winner from storage, rebase, retry" }]);
        continue; // the loop re-verifies from storage (the winner), re-applies the transaction to the winner's map, retries
      }
      // `push()` never sets `dry_run`, so this outcome is unreachable here —
      // narrows `published` to `"admitted"` for the return below.
      if (published.outcome === "dry_run") fail("GIT_COMMAND_FAILED", "internal: push() received a dry-run result it never requested", "publishing gitvault head");
      this.keystore.updateRepo(this.repoId, { last_ref_transaction: { generation: published.generation, transaction: options.transaction, at: formatGitvaultTimestamp(this.now()) } });
      return { generation: published.generation, head_sha256: published.head_sha256, head: published.head, admission_record_sha256: published.admission_record_sha256, capture_receipt: published.capture_receipt, form: published.form, conflicts_retried: conflicts, refs: published.refs };
    }
  }

  /**
   * A REAL preview of what {@link push} would publish (kychee-com/run402#565)
   * — runs the SAME local pipeline `push` runs (materialize → evaluate →
   * evolve retention roots → build refState/retentionRoots → build packs or a
   * checkpoint set → seal/encrypt) and stops BEFORE the two network
   * mutations `push` performs (`uploadAll`, `admit`). One shot, no conflict
   * retry: there is nothing to retry against, since no generation is ever
   * admitted. `would_admit_generation` is therefore the generation this push
   * WOULD claim over the CURRENTLY OBSERVED base — a concurrent publisher can
   * still take it first before a real push runs, exactly as `git push
   * --dry-run` never promises a fast-forward will still hold by the time a
   * real push executes.
   *
   * Never retries and never allocates: an unallocated vault has no `repo_id`
   * (hence no encryption key) to preview a push against at all — callers
   * resolve the vault READ-ONLY first (see `Gitvault.planPush` in
   * `../namespaces/gitvault.js`, which reports `allocation_needed: true` in
   * that case instead of calling this method).
   */
  async planPush(options: GitvaultPushOptions): Promise<GitvaultPushPlan> {
    const base = await this.materialize();
    const evaluation = await evaluateRefTransaction(base.refs, options.transaction, { isAncestor: (a, d) => isAncestor(this.git(), a, d), protocol_refs: options.protocol_refs });
    const headTarget = options.head_target ?? base.head_target;
    const published = await this.publishGeneration({
      base, refs: evaluation.refs, dropped: evaluation.dropped, head_target: headTarget,
      force_checkpoint: options.checkpoint === true, cutoff: null, dry_run: true,
    });
    // `dry_run: true` above means `publishGeneration` returns ONLY the
    // `"dry_run"` outcome — `"conflict"`/`"admitted"` are reachable only via
    // `admit()`, which a dry run never calls.
    if (published.outcome !== "dry_run") fail("GIT_COMMAND_FAILED", "internal: planPush did not receive a dry-run result", "planning gitvault push");
    const encryptedBytes = published.objects.reduce((sum, o) => sum + BigInt(o.size_bytes), 0n);
    return {
      base_generation: base.generation,
      would_admit_generation: published.generation,
      would_admit_generation_decimal: generationToBigInt(published.generation).toString(),
      form: published.form,
      refs: published.refs,
      head_target: published.head_target,
      objects: published.objects.map((o) => ({ object_kind: o.object_kind, size_bytes: o.size_bytes })),
      object_count: published.objects.length,
      encrypted_bytes: encryptedBytes.toString(),
      raw_bytes: String(published.raw_pack_bytes),
    };
  }

  /**
   * Publish an `ordinary_push` checkpoint-bearing head that changes NO ref (the
   * canonical map and HEAD target are carried forward). With a cutoff the head
   * binds a fresh `retention_cutoff` ticket and roots past their ≥90-day lane
   * may leave the map; without one it is the no-removal form (§4.5a) and every
   * root is carried.
   *
   * Root expiry is PERMISSIVE: a root whose `effective_admitted_at` this client
   * cannot resolve is RETAINED. That is deliberate — `effective_admitted_at =
   * max(prepared_at, the admission record's storage creation time)`, and a client
   * reading only object bytes cannot see the second term. Resolving it from
   * `prepared_at` alone would shorten the lane, which the protocol's own
   * delayed-PUT vector calls out as the naive implementation.
   *
   * This is NOT `run402 gitvault compact`: the §7.2 maintenance CYCLE (purpose
   * `maintenance_cycle`, C1/C2 roles, stage claim sets, prune intents, `R2_cap`
   * accounting) is a separate protocol under compact authority, and gets its own
   * method when it ships.
   */
  async publishCheckpoint(options: { cutoff?: GitvaultCutoffOptions | false } = {}): Promise<GitvaultPublishResult> {
    let conflicts = 0;
    for (;;) {
      const base = await this.materialize();
      const published = await this.publishGeneration({
        base, refs: base.refs, dropped: [], head_target: base.head_target,
        force_checkpoint: true, cutoff: options.cutoff === false ? null : options.cutoff ?? {}, capture_binding: undefined,
      });
      if (published.outcome === "conflict") {
        conflicts += 1;
        if (conflicts > this.retries) fail("HEAD_CAS_CONFLICT", `the checkpoint lost ${conflicts} races at generation ${published.generation}; giving up`, "publishing gitvault checkpoint", { generation: published.generation, winner: published.winner }, [{ action: "verify the attached winner from storage, retry" }]);
        continue;
      }
      // `publishCheckpoint` never sets `dry_run`, so this outcome is
      // unreachable here — narrows `published` to `"admitted"` below.
      if (published.outcome === "dry_run") fail("GIT_COMMAND_FAILED", "internal: publishCheckpoint() received a dry-run result it never requested", "publishing gitvault checkpoint");
      return { generation: published.generation, head_sha256: published.head_sha256, head: published.head, admission_record_sha256: published.admission_record_sha256, capture_receipt: published.capture_receipt, form: published.form, conflicts_retried: conflicts, refs: published.refs };
    }
  }

  /** Request a `retention_cutoff` ticket and check it binds THIS base head (and the service key, when one is pinned). */
  private async issueRetentionCutoff(baseHeadSha256: string): Promise<GitvaultRetentionCutoffIssued> {
    const issued = await this.transport.requestRetentionCutoff({ repo_id: this.repoId, base_head_sha256: baseHeadSha256 });
    const t = issued.ticket;
    if (t.object_kind !== "retention_cutoff" || t.repo_id !== this.repoId || t.base_head_sha256 !== baseHeadSha256) {
      fail("GITVAULT_CUTOFF_TICKET_INVALID", `the retention cutoff ticket does not bind this vault's base head ${baseHeadSha256}`, "requesting retention cutoff ticket", { object_id: t.object_id, base_head_sha256: t.base_head_sha256 });
    }
    if (Date.parse(t.expires_at) <= this.now().getTime()) fail("GITVAULT_CUTOFF_TICKET_INVALID", `the retention cutoff ticket expired at ${t.expires_at}`, "requesting retention cutoff ticket", { object_id: t.object_id });
    if (this.servicePublicKey && !verifyGitvaultObject(t as unknown as GitvaultSignedObject, this.servicePublicKey)) {
      fail("GITVAULT_CUTOFF_TICKET_INVALID", "the retention cutoff ticket is not signed by the pinned service key", "requesting retention cutoff ticket", { object_id: t.object_id, service_key_id: t.service_key_id });
    }
    return issued;
  }

  /**
   * `overrides.epoch` (D194, rev 42 fix): defaults to `this.epoch()` — the
   * LOCALLY KNOWN current epoch — rather than the fixed genesis constant.
   * This is load-bearing, not cosmetic: once ANY rotation has landed, every
   * ORDINARY (non-`rotate_epoch`) head this principal signs must still
   * claim the vault's CURRENT epoch (protocol §4.3's chain-link rule —
   * "every head's epoch equals its predecessor's UNLESS this head admits a
   * `rotate_epoch` transition"); hard-coding the generation-1 constant here
   * would make EVERY ordinary push after a vault's first rotation refuse
   * `CHAIN_BROKEN` forever. `rotateEpoch` passes `overrides.epoch = new_epoch`
   * explicitly for the ONE head that legitimately claims a DIFFERENT epoch
   * than `this.epoch()` currently reads (the local pointer only advances
   * AFTER a successful admit, via `keystore.recordEpochRotation`).
   */
  private signHead(
    fields: Omit<GitvaultHead, "format" | "object_kind" | "suite" | "repo_id" | "epoch" | "transition" | "pin_manifest" | "writer_key_id" | "created_at" | "signature">,
    overrides?: { epoch?: string; transition?: GitvaultTransitionEnvelope | null; pin_manifest?: GitvaultPinManifestReceipt },
  ): GitvaultHead {
    const unsigned = {
      format: GITVAULT_FORMAT, object_kind: "head" as const, suite: GITVAULT_SUITE, repo_id: this.repoId,
      generation: fields.generation, prev_sha256: fields.prev_sha256, epoch: overrides?.epoch ?? this.epoch(),
      wal_entries: fields.wal_entries, ref_state: fields.ref_state, retention_roots: fields.retention_roots,
      checkpoint: fields.checkpoint, checkpoint_purpose: fields.checkpoint_purpose, capture_binding: fields.capture_binding,
      repair: fields.repair, transition: overrides?.transition ?? null,
      ...(overrides?.pin_manifest ? { pin_manifest: overrides.pin_manifest } : {}),
      writer_key_id: this.writerKeyId(), created_at: formatGitvaultTimestamp(this.now()),
    };
    return signGitvaultObject(unsigned, this.signer()) as GitvaultHead;
  }

  /** Admit a signed head; on success read it back from storage and compare BEFORE any pin advances. */
  private async admit(head: GitvaultHead): Promise<{ outcome: "admitted"; head_sha256: string; admission_record_sha256: string; capture_receipt: GitvaultCaptureReceipt | null } | { outcome: "conflict"; winner: { generation: string; stored_bytes_sha256: string } }> {
    const bytes = storedBytes(head as unknown as GitvaultSignedObject);
    const hash = sha256Hex(bytes);
    const result = await this.transport.admitHead({ repo_id: this.repoId, generation: head.generation, stored_bytes: bytes, stored_bytes_sha256: hash });
    if (result.outcome === "conflict") return result;
    const back = await this.transport.getObject({ repo_id: this.repoId, path: gitvaultPaths.head(head.generation) });
    if (!back || sha256Hex(back) !== hash) {
      fail("GITVAULT_HEAD_READBACK_MISMATCH", `the admitted head at generation ${head.generation} read back ${back ? sha256Hex(back) : "absent"} ≠ ${hash}; the push is NOT reported as landed and no pin advances`, "reading back admitted head", { generation: head.generation, expected: hash, observed: back ? sha256Hex(back) : null });
    }
    const pin: GitvaultHeadPin = { generation: head.generation, head_sha256: hash, pinned_at: formatGitvaultTimestamp(this.now()) };
    this.keystore.updateRepo(this.repoId, { head_pin: pin, materialized_pin: pin, verified_prefix: null });
    return { outcome: "admitted", head_sha256: hash, admission_record_sha256: result.admission_record_sha256, capture_receipt: result.capture_receipt };
  }

  // ── epoch rotation (D193-D203, rev 42, change gitvault-human-envelopes) ──

  /**
   * Walk the chain BACKWARD from the current tip to find the nearest
   * admitted `recipient_pin_manifest` receipt (D197: "a fresh client... reads
   * the LATEST admitted manifest, walking `prev_sha256` back to the nearest
   * head carrying one"). Heads are plaintext-structured/signed (never
   * encrypted) so this needs no key material — only signature verification
   * against the creator's own pubkey. Falls back to `vault_genesis.pin_manifest`
   * (D198 N-recipient genesis — this SDK does not BUILD one, but reads one
   * correctly for interop), then to the zero-value sentinel (no manifest has
   * ever been admitted — every principal starts `excluded_unconfirmed`).
   *
   * Cost is O(distance to the nearest pin-manifest-bearing head) — for a
   * vault that has never published one, that is every generation back to
   * genesis. There is no index that avoids this in protocol v0 (the same
   * cost class `verifyToNewest`'s own chain walk already has); a vault with
   * a long, pin-manifest-free history pays it once per rotation.
   */
  private async loadEffectivePinManifest(newestGeneration: string): Promise<{ pinManifestVersion: string; pinManifestSha256: string; pinnedFingerprintOf: Map<string, string> }> {
    const { genesis } = await this.genesis();
    let gen = generationToBigInt(newestGeneration);
    while (gen >= 1n) {
      const generation = gen.toString(16).padStart(16, "0");
      const bytes = await this.transport.getObject({ repo_id: this.repoId, path: gitvaultPaths.head(generation) });
      if (!bytes) fail("CHAIN_BROKEN", `head ${generation} is missing from storage while resolving the effective pin manifest`, "resolving the effective recipient pin manifest", { generation });
      const head = parseGitvaultStrict(new TextDecoder().decode(bytes)) as GitvaultHead;
      if (head.pin_manifest) return this.readPinManifestObject(head.pin_manifest);
      gen -= 1n;
    }
    if (genesis.pin_manifest) return this.readPinManifestObject(genesis.pin_manifest);
    return { pinManifestVersion: "0".repeat(16), pinManifestSha256: GITVAULT_ZERO_SHA256_SENTINEL, pinnedFingerprintOf: new Map() };
  }

  private async readPinManifestObject(receipt: GitvaultPinManifestReceipt): Promise<{ pinManifestVersion: string; pinManifestSha256: string; pinnedFingerprintOf: Map<string, string> }> {
    const bytes = await this.transport.getObject({ repo_id: this.repoId, path: gitvaultPaths.pinManifest(receipt.pin_manifest_version) });
    if (!bytes || sha256Hex(bytes) !== receipt.stored_bytes_sha256) {
      fail("GITVAULT_RECEIPT_MISMATCH", `recipient_pin_manifest ${receipt.pin_manifest_version} is absent or does not match its receipted hash`, "resolving the effective recipient pin manifest", { pin_manifest_version: receipt.pin_manifest_version });
    }
    const manifest = parseGitvaultStrict(new TextDecoder().decode(bytes)) as { pins: GitvaultRecipientPinManifestEntry[]; writer_key_id: string; signature: string; object_kind: string };
    const { genesis } = await this.genesis();
    if (!verifyGitvaultObject(manifest as unknown as GitvaultSignedObject, genesis.creator_signing_pubkey)) {
      fail("GITVAULT_SIGNATURE_INVALID", `recipient_pin_manifest ${receipt.pin_manifest_version} signature does not verify`, "resolving the effective recipient pin manifest", { pin_manifest_version: receipt.pin_manifest_version });
    }
    const pinnedFingerprintOf = new Map(manifest.pins.map((p) => [p.principal_id, p.ek_fingerprint] as const));
    return { pinManifestVersion: receipt.pin_manifest_version, pinManifestSha256: receipt.stored_bytes_sha256, pinnedFingerprintOf };
  }

  /**
   * Build the successor `recipient_pin_manifest` object from the currently-
   * effective PREDECESSOR manifest plus a batch of receipted updates (D197
   * full-map conservation: `next_map = prior_map + receipt-authorized
   * additions/replacements`). Shared by {@link publishPinManifestUpdate} (a
   * single-entry ordinary-push publish) and {@link rotateEpoch}'s
   * `pending_confirmations` fold (a multi-entry publish riding the SAME
   * head as the rotation, D196). Validates EVERY update's receipt against
   * `prior` before building — a receipt issued against a stale predecessor
   * fails closed here (`VALIDATION_FAILED`), never silently overwritten,
   * matching the gateway's own admission-time field-by-field check.
   *
   * Does NOT admit anything — the caller uploads `.upload` and attaches the
   * returned `{object_kind, pin_manifest_version, stored_bytes_sha256,
   * size_bytes}` receipt shape to whichever head it is publishing on.
   */
  private buildPinManifestUpdate(
    prior: { pinManifestVersion: string; pinManifestSha256: string; pinnedFingerprintOf: Map<string, string> },
    updates: { principal_id: string; ek_fingerprint: string; confirmed_by: "operator_confirmation"; receipt: GitvaultRecipientConfirmationReceipt }[],
  ): { nextVersion: string; manifestSha: string; upload: GitvaultUploadObject } {
    for (const u of updates) {
      if (u.receipt.base_pin_manifest_sha256 !== prior.pinManifestSha256) {
        fail("VALIDATION_FAILED", `the confirmation receipt for ${u.principal_id} was issued against a different predecessor manifest than the one currently effective — obtain a fresh /confirm or /repin`, "publishing a recipient_pin_manifest update", { principal_id: u.principal_id, receipt_base: u.receipt.base_pin_manifest_sha256, current_base: prior.pinManifestSha256 });
      }
    }
    const updateIds = new Set(updates.map((u) => u.principal_id));
    if (updateIds.size !== updates.length) {
      fail("VALIDATION_FAILED", "duplicate principal_id across pin-manifest updates in one publish", "publishing a recipient_pin_manifest update", { principal_ids: updates.map((u) => u.principal_id) });
    }
    const nextVersion = (generationToBigInt(prior.pinManifestVersion) + 1n).toString(16).padStart(16, "0");
    const pins: GitvaultRecipientPinManifestEntry[] = [];
    for (const [principalId, ekFp] of prior.pinnedFingerprintOf) {
      if (updateIds.has(principalId)) continue; // replaced below
      pins.push({ principal_id: principalId, ek_fingerprint: ekFp, pinned_at: formatGitvaultTimestamp(this.now()), confirmed_by: "operator_confirmation", confirmation_receipt_sha256: GITVAULT_ZERO_SHA256_SENTINEL });
    }
    for (const u of updates) {
      pins.push({ principal_id: u.principal_id, ek_fingerprint: u.ek_fingerprint, pinned_at: formatGitvaultTimestamp(this.now()), confirmed_by: "operator_confirmation", confirmation_receipt_sha256: storedBytesSha256(u.receipt as unknown as GitvaultSignedObject) });
    }
    pins.sort((a, b) => (a.principal_id < b.principal_id ? -1 : a.principal_id > b.principal_id ? 1 : 0));
    const unsignedManifest = { format: GITVAULT_FORMAT, object_kind: "recipient_pin_manifest" as const, suite: GITVAULT_SUITE, repo_id: this.repoId, pin_manifest_version: nextVersion, base_pin_manifest_sha256: prior.pinManifestSha256, pins, writer_key_id: this.writerKeyId() };
    const manifest = signGitvaultObject(unsignedManifest, this.signer());
    const manifestBytes = storedBytes(manifest as unknown as GitvaultSignedObject);
    const manifestSha = sha256Hex(manifestBytes);
    const upload: GitvaultUploadObject = { path: gitvaultPaths.pinManifest(nextVersion), object_kind: "recipient_pin_manifest", object_id: null, bytes: manifestBytes, sha256: manifestSha, size_bytes: String(manifestBytes.length) };
    return { nextVersion, manifestSha, upload };
  }

  /**
   * Build a `recipient_pin_manifest` update (D197 full-map conservation) and
   * publish it via an ORDINARY head (`gitvault.writer`-sufficient — the
   * OWNER-GATED half of the ceremony already happened at `/confirm`/`/repin`,
   * which is what produced `receipt`; PUBLISHING the resulting entry is
   * ordinary-writer authority, same split as envelope-wrap authority
   * always had). Carries the SAME refs/roots forward unchanged, at the
   * CURRENT epoch (this is not a rotation — no new epoch, no new K_e).
   *
   * **This is an ORDINARY admission (`transition: null`) and is therefore
   * itself refused `EPOCH_ROTATION_REQUIRED` while a migration/revocation/
   * exposure condition is outstanding on this vault (D193) — the exact
   * deadlock the incident behind {@link GitvaultVault.rotateEpoch}'s
   * `pending_confirmations` parameter closes.** When this vault is in that
   * state, fold the receipt into `rotateEpoch({..., pending_confirmations:
   * [{principal_id, ek_fingerprint, receipt}]})` instead of calling this
   * method directly — that submission carries a `rotate_epoch` transition,
   * which IS the gate's own escape valve.
   */
  async publishPinManifestUpdate(input: { principal_id: string; ek_fingerprint: string; confirmed_by: "operator_confirmation"; receipt: GitvaultRecipientConfirmationReceipt }): Promise<GitvaultPublishResult> {
    let conflicts = 0;
    for (;;) {
      const base = await this.materialize();
      const prior = await this.loadEffectivePinManifest(base.generation);
      const { nextVersion, manifestSha, upload: manifestUpload } = this.buildPinManifestUpdate(prior, [input]);
      await this.uploadAll([manifestUpload]);

      const generation = nextGeneration(base.generation);
      const refState = this.buildRefState(generation, base.refs, base.head_target);
      const rootsObj = this.buildRetentionRoots(generation, base.roots, null);
      await this.uploadAll([refState.upload, rootsObj.upload]);
      const head = this.signHead(
        {
          generation, prev_sha256: base.head_sha256, wal_entries: [],
          ref_state: { object_id: refState.object.object_id, object_kind: "ref_state", ciphertext_sha256: refState.upload.sha256, size_bytes: refState.upload.size_bytes },
          retention_roots: { object_id: rootsObj.object.object_id, object_kind: "retention_roots", ciphertext_sha256: rootsObj.upload.sha256, size_bytes: rootsObj.upload.size_bytes },
          checkpoint: null, checkpoint_purpose: null, capture_binding: null, repair: null,
        },
        { pin_manifest: { object_kind: "recipient_pin_manifest", pin_manifest_version: nextVersion, stored_bytes_sha256: manifestSha, size_bytes: String(manifestUpload.size_bytes) } },
      );
      const admitted = await this.admit(head);
      if (admitted.outcome === "conflict") {
        conflicts += 1;
        if (conflicts > this.retries) fail("HEAD_CAS_CONFLICT", `the pin-manifest update lost ${conflicts} races at generation ${generation}; giving up`, "publishing a recipient_pin_manifest update", { generation, winner: admitted.winner });
        continue;
      }
      return { generation, head_sha256: admitted.head_sha256, head, admission_record_sha256: admitted.admission_record_sha256, capture_receipt: admitted.capture_receipt, form: "wal", conflicts_retried: conflicts, refs: base.refs };
    }
  }

  /**
   * Drive one epoch rotation to a committed head (D193-D203). This is the
   * producer's obligations in full: sample a FRESH `K_e` independent of
   * every prior epoch key this principal has locally held; compute the H
   * bijection from the live desired-recipient state + the effective pin
   * manifest; seal one `key_envelope` per included recipient from the SAME
   * `K_e`; submit the create-only `rotation_attempt_descriptor` BEFORE any
   * envelope upload; upload the envelopes; submit the `rotate_epoch` head;
   * on a CAS conflict, retry from a fresh `materialize()` (the SAME
   * conflict-retry shape `push()` uses); after commit, verify this
   * principal's OWN envelope (when it is itself a recipient) opens to
   * exactly the committed `K_e` and reproduces `epoch_key_commitment`
   * (D200's narrowed per-recipient self-check — never a global proof);
   * advance the local keystore's current epoch/key pointer AND retain the
   * prior key in `epoch_keys`.
   *
   * **`recipient_state_version`/`recipient_revocation_version` are REQUIRED
   * inputs, not discovered here.** The gateway exposes NO general read route
   * for `internal.gitvault_recipient_state_counters` (D194) — the ONLY
   * client-visible read of these two org-scoped counters today is the
   * response of `POST …/recipients/:principal_id/key-revocation`
   * ({@link GitvaultTransport.declareRecipientKeyRevoked}), which is why
   * {@link rotateEpochForKeyRevocation} (below) is the one fully
   * self-contained entry point. For `member_removed` / `elective_rekey` /
   * `epoch_secret_exposed`, a caller that does not already know the current
   * counter pair cannot discover it from any shipped gateway route — this
   * is a confirmed gap in the live gateway (verified against
   * `packages/gateway/src/services/gitvault/reads.ts:getVaultRecord` and
   * every `routes/gitvault*.ts` handler, not inferred), not a client
   * limitation this SDK can work around. Passing a stale/guessed pair fails
   * safely: the admission fence's D194 frozen-counter comparison refuses
   * `RECIPIENT_SET_MISMATCH` rather than silently canonizing against wrong
   * evidence.
   *
   * **`options.pending_confirmations` (the manifest-publish deadlock fix).**
   * `publishPinManifestUpdate` is an ORDINARY admission (`transition:
   * null`) and is therefore itself refused `EPOCH_ROTATION_REQUIRED` while
   * this vault has an urgent/migration condition outstanding — the exact
   * state a `rotateEpoch` call is being made to clear. Reproduced live in
   * production 2026-08-27 (a vault's first `epoch_secret_exposed` rekey:
   * `/confirm` minted a receipt server-side, but the ordinary push that
   * would publish it never admitted). Pass the pending receipted updates
   * here instead — they ride the SAME head as this rotation's `transition`,
   * which IS `EPOCH_ROTATION_REQUIRED`'s own escape valve, so the publish
   * is no longer blocked. **This does NOT include these principals in
   * THIS rotation's `envelopes[]`** — protocol-v0.md D196 is explicit: "a
   * manifest update riding the SAME head never self-authorizes its own
   * recipients"; `confirmed(h)` for THIS rotation still reads only the
   * PREDECESSOR manifest, unchanged. They land in
   * `excluded_unconfirmed_principal_ids` here (same as without folding) and
   * become eligible starting at the NEXT rotation, once this manifest is
   * the admitted predecessor. See {@link GitvaultRotationResult.pin_manifest_published}.
   *
   * **Honest residual — this does not rescue a vault with ZERO ever-
   * confirmed principals.** If `included` would be empty even with the
   * fold (no predecessor-confirmed principal exists at all — e.g. a
   * grandfathered pre-rev-42 vault whose bare genesis never published a
   * pin manifest and which was never bootstrapped before its
   * `migration_rotation_required` flag was set), the gateway refuses
   * `EPOCH_ROTATION_WOULD_LEAVE_VAULT_UNCOVERED` regardless of what rides
   * along on `pin_manifest` — D196's same-head exclusion makes THIS
   * impossible to route around from the client. That is a genuine,
   * currently-open protocol gap (not something this parameter can paper
   * over) and needs an operator-side decision, not a client workaround.
   */
  async rotateEpoch(options: { reason: GitvaultRotationReason; recipient_state_version: string; recipient_revocation_version: string; client_idempotency_key?: string; ikm_e?: Uint8Array; pending_confirmations?: { principal_id: string; ek_fingerprint: string; receipt: GitvaultRecipientConfirmationReceipt }[] }): Promise<GitvaultRotationResult> {
    let conflicts = 0;
    for (;;) {
      const base = await this.materialize();
      const repo = this.repoFile();
      const currentEpoch = base.head?.epoch ?? this.epoch();
      const newEpoch = nextEpoch(currentEpoch);

      // D195's producer obligation: a fresh K_e, checked against EVERY prior
      // epoch key this principal has ever locally held.
      const kE = randomBytes(32);
      const priorKnownKeys = Object.values(repo.epoch_keys ?? { [repo.epoch]: repo.k_repo_hex }).map(hexToBytes);
      checkFreshEpochKeyAgainstPriorKeys(kE, priorKnownKeys);

      // Live desired-recipient state (H) + the effective pin manifest.
      const envelopeRecipients = await this.transport.listEnvelopeRecipients({ repo_id: this.repoId });
      const desired = envelopeRecipients.desired;
      if (!desired) {
        fail("GITVAULT_DESIRED_STATE_UNAVAILABLE", "the gateway did not report desired-recipient state (desired[]) for this vault — an epoch rotation cannot compute its H-partition without it", "computing the epoch-rotation H-partition");
      }
      const pinManifest = await this.loadEffectivePinManifest(base.generation);

      // D196's H-partition: included / excluded_keyless / excluded_unconfirmed.
      // A `pending_removal` desired-recipient row is EXCLUDED from H entirely
      // (the gateway's own H is `status='active'` only) — that omission is
      // the entire forward-revocation point for reason:"member_removed".
      const included: { principal_id: string; ek_fingerprint: string; public_key: Uint8Array }[] = [];
      const excludedKeyless: string[] = [];
      const excludedUnconfirmed: string[] = [];
      const pinBlocked: { principal_id: string; directory_fingerprint: string; pinned_fingerprint: string }[] = [];
      for (const d of desired) {
        if (d.status !== "active") continue;
        if (!d.ek_fingerprint || !d.public_key) {
          excludedKeyless.push(d.principal_id);
          continue;
        }
        const pinned = pinManifest.pinnedFingerprintOf.get(d.principal_id);
        if (pinned === undefined) {
          excludedUnconfirmed.push(d.principal_id);
          continue;
        }
        if (pinned !== d.ek_fingerprint) {
          // A live pin exists but disagrees with the directory's current
          // fingerprint (the principal re-enrolled a key since their last
          // confirmation). Neither "included" (D196 requires the envelope
          // fingerprint to equal the PINNED one) nor "excluded_unconfirmed"
          // (D196/gateway validation requires pinnedFingerprintOf to LACK
          // them entirely) is a legal bucket for this principal under the
          // protocol as specified — the owner must run `/repin` first.
          pinBlocked.push({ principal_id: d.principal_id, directory_fingerprint: d.ek_fingerprint, pinned_fingerprint: pinned });
          continue;
        }
        let pub: Uint8Array;
        try {
          pub = fromBase64url(d.public_key, "public_key");
        } catch {
          pinBlocked.push({ principal_id: d.principal_id, directory_fingerprint: d.ek_fingerprint, pinned_fingerprint: pinned });
          continue;
        }
        if (ekFingerprint(pub) !== d.ek_fingerprint) {
          pinBlocked.push({ principal_id: d.principal_id, directory_fingerprint: d.ek_fingerprint, pinned_fingerprint: pinned });
          continue;
        }
        included.push({ principal_id: d.principal_id, ek_fingerprint: d.ek_fingerprint, public_key: pub });
      }
      if (pinBlocked.length > 0) {
        fail(
          "GITVAULT_ROTATION_BLOCKED_PIN_MISMATCH",
          `${pinBlocked.length} principal(s) have a live pin that disagrees with their current directory key and cannot be safely included or excluded under the protocol's own H-partition rules — run the /repin ceremony for each, then retry: ${pinBlocked.map((p) => p.principal_id).join(", ")}`,
          "computing the epoch-rotation H-partition",
          { blocked: pinBlocked },
        );
      }
      if (options.reason === "elective_rekey" && (excludedKeyless.length > 0 || excludedUnconfirmed.length > 0)) {
        fail(
          "EPOCH_ROTATION_INCOMPLETE_ENROLLMENT",
          `reason:"elective_rekey" refuses a target set that is a proper subset of the vault's current actual coverage — ${excludedKeyless.length} keyless, ${excludedUnconfirmed.length} unconfirmed`,
          "computing the epoch-rotation H-partition",
          { excluded_keyless_principal_ids: excludedKeyless, excluded_unconfirmed_principal_ids: excludedUnconfirmed },
        );
      }
      if (included.length === 0) {
        fail("EPOCH_ROTATION_WOULD_LEAVE_VAULT_UNCOVERED", "every eligible principal is excluded — this reason would leave the vault with no recipient able to decrypt the new epoch", "computing the epoch-rotation H-partition");
      }

      // Self-consistency (defense in depth — the gateway's own recomputation under its live lock is authoritative).
      const desiredIds = new Set(desired.filter((d) => d.status === "active").map((d) => d.principal_id));
      const keyedIds = new Set(desired.filter((d) => d.status === "active" && d.ek_fingerprint).map((d) => d.principal_id));
      const hCheck = checkHPartition({ desiredPrincipalIds: desiredIds, keyedPrincipalIds: keyedIds, pinnedFingerprintOf: pinManifest.pinnedFingerprintOf, included, excludedKeylessPrincipalIds: excludedKeyless, excludedUnconfirmedPrincipalIds: excludedUnconfirmed });
      if (!hCheck.ok) fail("VALIDATION_FAILED", `internal: the H-partition this producer built is not a valid bijection over H (${hCheck.detail}) — refusing to submit a rotation the gateway would refuse`, "computing the epoch-rotation H-partition");

      const targetPartitionDigest = computeTargetPartitionDigest({
        recipient_state_version: options.recipient_state_version,
        recipient_revocation_version: options.recipient_revocation_version,
        pin_manifest_version: pinManifest.pinManifestVersion,
        pin_manifest_sha256: pinManifest.pinManifestSha256,
        included: included.map((p) => ({ principal_id: p.principal_id, ek_fingerprint: p.ek_fingerprint })),
        excluded_keyless_principal_ids: excludedKeyless,
        excluded_unconfirmed_principal_ids: excludedUnconfirmed,
      });

      // D195: build + sign the rotation_attempt_descriptor, derive rotation_id, submit the create-only CAS BEFORE any envelope upload.
      const clientIdempotencyKey = options.client_idempotency_key ?? newHex32();
      const descriptorFields = {
        format: GITVAULT_FORMAT, object_kind: "rotation_attempt_descriptor" as const, suite: GITVAULT_SUITE,
        repo_id: this.repoId, base_head_sha256: base.head_sha256, new_epoch: newEpoch,
        recipient_state_version: options.recipient_state_version, recipient_revocation_version: options.recipient_revocation_version,
        pin_manifest_sha256: pinManifest.pinManifestSha256, target_partition_digest: targetPartitionDigest,
        client_idempotency_key: clientIdempotencyKey, writer_key_id: this.writerKeyId(),
      };
      const attemptCommitment = attemptKeyCommitment(kE, this.repoId, newEpoch, descriptorFields);
      const signedDescriptor = signGitvaultObject({ ...descriptorFields, attempt_key_commitment: attemptCommitment }, this.signer()) as GitvaultRotationAttemptDescriptor;
      const rotationId = computeRotationId(signedDescriptor as unknown as Record<string, unknown>);

      const attemptOut = await this.transport.createRotationAttempt({ repo_id: this.repoId, descriptor: signedDescriptor });
      if (attemptOut.rotation_id !== rotationId) {
        fail("ROTATION_ID_MISMATCH", "the gateway's own re-derived rotation_id disagrees with this client's derivation — refusing to proceed", "creating a rotation attempt", { client_derived: rotationId, gateway_derived: attemptOut.rotation_id });
      }

      // Seal one key_envelope per included recipient, all from the SAME kE (D200's global one-key property depends on this).
      const sealedReceipts: GitvaultRotationEnvelopePair[] = [];
      const envelopeUploads: GitvaultUploadObject[] = [];
      const nowIso = formatGitvaultTimestamp(this.now());
      for (const p of included) {
        const sealed = await sealKeyEnvelope({ k_repo: kE, repo_id: this.repoId, epoch: newEpoch, recipient_public_key: p.public_key, signer: this.signingKeypair(), created_at: nowIso, rotation_id: rotationId });
        sealedReceipts.push({ principal_id: p.principal_id, envelope: sealed.receipt });
        envelopeUploads.push({ path: gitvaultPaths.envelope(newEpoch, p.ek_fingerprint, rotationId), object_kind: "key_envelope", object_id: null, bytes: sealed.stored_bytes, sha256: sealed.stored_bytes_sha256, size_bytes: sealed.size_bytes });
      }
      if (envelopeUploads.length > 0) await this.uploadAll(envelopeUploads);
      sealedReceipts.sort((a, b) => (a.principal_id < b.principal_id ? -1 : a.principal_id > b.principal_id ? 1 : 0));

      const epochKeyCommitmentValue = epochRotationKeyCommitment(kE, this.repoId, newEpoch, rotationId, included.map((p) => p.ek_fingerprint));
      const payload: GitvaultRotateEpochPayload = {
        new_epoch: newEpoch, rotation_id: rotationId, reason: options.reason,
        recipient_state_version: options.recipient_state_version, recipient_revocation_version: options.recipient_revocation_version,
        pin_manifest_sha256: pinManifest.pinManifestSha256, target_partition_digest: targetPartitionDigest,
        epoch_key_commitment: epochKeyCommitmentValue, excluded_keyless_principal_ids: excludedKeyless, excluded_unconfirmed_principal_ids: excludedUnconfirmed,
        recipient_authority_attestation: null, envelopes: sealedReceipts,
      };
      const payloadBytes = jcs(payload);
      const transition: GitvaultTransitionEnvelope = { kind: "rotate_epoch", payload_format: "base64url-jcs", payload: toBase64url(payloadBytes), payload_sha256: sha256Hex(payloadBytes) };

      // The manifest-publish deadlock fix: fold receipted pending
      // confirmations into THIS SAME head's `pin_manifest` field (schema-
      // legal, §4.3 — `transition` and `pin_manifest` are independent
      // optional fields on one `head`). Built from `pinManifest`, the
      // PREDECESSOR already loaded above for the H-partition — NEVER used
      // to recompute `included`/`excludedUnconfirmed` above, which is what
      // keeps this conformant with D196 ("a manifest update riding the SAME
      // head never self-authorizes its own recipients"). This durably
      // publishes the receipts (unblocking every future ordinary admission
      // once this rotation clears the urgent/migration condition) without
      // claiming these principals are covered by THIS rotation's envelopes.
      const pendingConfirmations = options.pending_confirmations ?? [];
      const pinManifestFold = pendingConfirmations.length > 0
        ? this.buildPinManifestUpdate(pinManifest, pendingConfirmations.map((p) => ({ principal_id: p.principal_id, ek_fingerprint: p.ek_fingerprint, confirmed_by: "operator_confirmation" as const, receipt: p.receipt })))
        : null;

      // The new epoch's ref_state/retention_roots — CARRIED FORWARD unchanged, sealed under kE.
      const generation = nextGeneration(base.generation);
      const refState = this.buildRefState(generation, base.refs, base.head_target, { k_repo: kE, epoch: newEpoch });
      const rootsObj = this.buildRetentionRoots(generation, base.roots, null, { k_repo: kE, epoch: newEpoch });
      const uploads = [refState.upload, rootsObj.upload];
      if (pinManifestFold) uploads.push(pinManifestFold.upload);
      await this.uploadAll(uploads);

      const head = this.signHead(
        {
          generation, prev_sha256: base.head_sha256, wal_entries: [],
          ref_state: { object_id: refState.object.object_id, object_kind: "ref_state", ciphertext_sha256: refState.upload.sha256, size_bytes: refState.upload.size_bytes },
          retention_roots: { object_id: rootsObj.object.object_id, object_kind: "retention_roots", ciphertext_sha256: rootsObj.upload.sha256, size_bytes: rootsObj.upload.size_bytes },
          checkpoint: null, checkpoint_purpose: null, capture_binding: null, repair: null,
        },
        {
          epoch: newEpoch, transition,
          ...(pinManifestFold ? { pin_manifest: { object_kind: "recipient_pin_manifest" as const, pin_manifest_version: pinManifestFold.nextVersion, stored_bytes_sha256: pinManifestFold.manifestSha, size_bytes: pinManifestFold.upload.size_bytes } } : {}),
        },
      );
      const admitted = await this.admit(head);
      if (admitted.outcome === "conflict") {
        conflicts += 1;
        if (conflicts > this.retries) fail("HEAD_CAS_CONFLICT", `the rotation lost ${conflicts} races at generation ${generation}; giving up`, "admitting a rotate_epoch head", { generation, winner: admitted.winner });
        continue;
      }

      // D200's post-commit self-check: verify THIS principal's own envelope
      // (when it is itself a recipient) opens to exactly the committed K_e
      // and reproduces epoch_key_commitment — a per-recipient proof only,
      // never a global set-coherence claim.
      let selfCheck: GitvaultRotationResult["self_check"] = "not_a_recipient";
      const identity = this.keystore.readIdentity();
      const ownKeypair = identity ? this.keystore.encryptionKeypair(identity) : null;
      if (identity && ownKeypair) {
        const ownFingerprint = ekFingerprint(ownKeypair.public_key);
        const own = included.find((p) => p.ek_fingerprint === ownFingerprint);
        const ownPair = own ? sealedReceipts.find((r) => r.principal_id === own.principal_id) : undefined;
        if (own && ownPair) {
          const envelopeBytes = await this.transport.getObject({ repo_id: this.repoId, path: gitvaultPaths.envelope(newEpoch, own.ek_fingerprint, rotationId) });
          if (!envelopeBytes || sha256Hex(envelopeBytes) !== ownPair.envelope.stored_bytes_sha256) {
            fail("GITVAULT_RECEIPT_MISMATCH", "this principal's own rotation-attempt envelope is absent or altered after commit", "verifying the committed epoch key", { rotation_id: rotationId });
          }
          const envelopeObj = parseGitvaultStrict(new TextDecoder().decode(envelopeBytes)) as Parameters<typeof openKeyEnvelope>[0]["envelope"];
          // Verification key: this producer's OWN signing key — only the
          // vault's single registered writer key can sign a rotate_epoch
          // head/descriptor at all (v0 single-writer model), so a rotation
          // this call itself drove was necessarily signed by `this.signingKeypair()`.
          const recoveredKe = await openKeyEnvelope({ envelope: envelopeObj, recipient: ownKeypair, signer_public_key: this.signingKeypair().public_key });
          if (bytesToHex(recoveredKe) !== bytesToHex(kE)) {
            fail("GITVAULT_EPOCH_ROTATION_SELF_CHECK_FAILED", "this principal's own opened envelope does not recover the K_e it sealed — refusing to advance the local epoch pointer", "verifying the committed epoch key");
          }
          const recomputed = epochRotationKeyCommitment(recoveredKe, this.repoId, newEpoch, rotationId, included.map((p) => p.ek_fingerprint));
          if (recomputed !== epochKeyCommitmentValue) {
            fail("GITVAULT_EPOCH_ROTATION_SELF_CHECK_FAILED", "epoch_key_commitment does not reproduce from this principal's own opened K_e", "verifying the committed epoch key");
          }
          selfCheck = "passed";
        }
      }

      // Advance the local pointer only after the self-check (when applicable) confirms this principal genuinely holds the committed K_e.
      this.keystore.recordEpochRotation(this.repoId, { new_epoch: newEpoch, new_k_repo_hex: bytesToHex(kE) });

      return {
        outcome: "admitted", generation, head_sha256: admitted.head_sha256, new_epoch: newEpoch, rotation_id: rotationId, reason: options.reason,
        included: included.map((p) => ({ principal_id: p.principal_id, ek_fingerprint: p.ek_fingerprint })),
        excluded_keyless_principal_ids: excludedKeyless, excluded_unconfirmed_principal_ids: excludedUnconfirmed,
        admission_record_sha256: admitted.admission_record_sha256, capture_receipt: admitted.capture_receipt, self_check: selfCheck,
        pin_manifest_published: pinManifestFold ? { pin_manifest_version: pinManifestFold.nextVersion, stored_bytes_sha256: pinManifestFold.manifestSha, principal_ids: pendingConfirmations.map((p) => p.principal_id) } : null,
      };
    }
  }

  /**
   * The ONE fully self-contained rotation entry point: declares
   * `reason:"recipient_key_revoked"` (owner + step-up) for `principal_id`,
   * takes the D194 counters straight off that call's OWN response, and
   * drives the rotation with them — no external counter source needed.
   */
  async rotateEpochForKeyRevocation(principalId: string, options: { client_idempotency_key?: string } = {}): Promise<GitvaultRotationResult> {
    const counters = await this.transport.declareRecipientKeyRevoked({ repo_id: this.repoId, principal_id: principalId });
    return this.rotateEpoch({ reason: "recipient_key_revoked", recipient_state_version: counters.recipient_state_version, recipient_revocation_version: counters.recipient_revocation_version, client_idempotency_key: options.client_idempotency_key });
  }

  // ── repair (owner-only; mandatory fresh checkpoint; repair resource lane server-side) ──

  /**
   * Publish a repair head over `base_generation` (§4.3): superseded tips that
   * the repaired state no longer reaches enter the retention-root map with
   * `dropped_at_generation = the repair generation`; the head carries the
   * mandatory self-contained checkpoint. Coverage that cannot be built →
   * `REPAIR_TARGET_UNPRESERVABLE`. A repair never crosses an admitted transition.
   */
  async repair(input: { base_generation: string; reason: GitvaultRepairDescriptor["reason"] }): Promise<GitvaultPublishResult> {
    const newest = await this.verifyToNewest();
    const baseGen = generationToBigInt(input.base_generation);
    const newestGen = generationToBigInt(newest.generation);
    if (baseGen >= newestGen) fail("REPAIR_TARGET_UNPRESERVABLE", `base_generation ${input.base_generation} must be below the newest ${newest.generation}`, "preparing repair");
    if (baseGen === 0n) fail("REPAIR_TARGET_UNPRESERVABLE", "a repair cannot base on the genesis", "preparing repair");
    const writerKey = newest.genesis.creator_signing_pubkey;
    const chain = await this.chainFrom(input.base_generation, newest);
    const baseEntry = chain.get(input.base_generation)!;
    const baseRefState = await this.openCarrier<GitvaultRefState>("ref_state", baseEntry.head.ref_state, gitvaultPaths.refState(baseEntry.head.ref_state.object_id), writerKey);
    const baseRoots = await this.openCarrier<GitvaultRetentionRoots>("retention_roots", baseEntry.head.retention_roots, gitvaultPaths.retentionRoots(baseEntry.head.retention_roots.object_id), writerKey);
    const repairGen = nextGeneration(newest.generation);
    const repairedRefs = baseRefState.refs;
    const repairedTips = Object.values(repairedRefs);
    const added: Array<{ ref: string; oid: string }> = [];
    for (let g = baseGen + 1n; g <= newestGen; g++) {
      const entry = chain.get(bigIntToGeneration(g))!;
      let state: GitvaultRefState;
      try {
        state = await this.openCarrier<GitvaultRefState>("ref_state", entry.head.ref_state, gitvaultPaths.refState(entry.head.ref_state.object_id), writerKey);
      } catch {
        continue; // an unusable superseded ref_state preserves nothing it cannot name (reason unusable_ref_state)
      }
      for (const [ref, oid] of Object.entries(state.refs)) {
        let reachable = false;
        for (const t of repairedTips) if (await isAncestor(this.git(), oid, t)) { reachable = true; break; }
        if (!reachable) {
          if (!(await hasObject(this.git(), oid))) fail("REPAIR_TARGET_UNPRESERVABLE", `superseded tip ${ref}@${oid} (generation ${entry.head.generation}) is not present locally and cannot be preserved in the repair checkpoint`, "preparing repair", { ref, oid }, [{ action: "choose a repair base whose superseded tips can all be preserved" }]);
          added.push({ ref, oid });
        }
      }
    }
    if (added.length > GITVAULT_MAX_REPAIR_ADDED_ROOTS) fail("REF_STATE_LIMIT_EXCEEDED", `${added.length} repair-added roots exceed the ${GITVAULT_MAX_REPAIR_ADDED_ROOTS} bound`, "preparing repair");
    const roots = evolveRetentionRoots(baseRoots.roots, { generation: repairGen, dropped: added });
    const refState = this.buildRefState(repairGen, repairedRefs, baseRefState.head_target);
    const rootsObj = this.buildRetentionRoots(repairGen, roots, null);
    let built: GitvaultBuiltCheckpoint;
    try {
      built = await this.buildCheckpoint({ generation: repairGen, ref_state: refState.object, retention_roots: rootsObj.object });
    } catch (e) {
      if (isRun402Error(e) && (e as { code?: string }).code === "CHECKPOINT_INCOMPLETE") fail("REPAIR_TARGET_UNPRESERVABLE", `the repair checkpoint cannot be constructed: ${(e as Error).message}`, "preparing repair", undefined, [{ action: "choose a repair base whose superseded tips can all be preserved" }]);
      throw e;
    }
    await this.uploadAll([refState.upload, rootsObj.upload, ...built.objects]);
    const head = this.signHead({
      generation: repairGen, prev_sha256: newest.head_sha256, wal_entries: [],
      ref_state: { object_id: refState.object.object_id, object_kind: "ref_state", ciphertext_sha256: refState.upload.sha256, size_bytes: refState.upload.size_bytes },
      retention_roots: { object_id: rootsObj.object.object_id, object_kind: "retention_roots", ciphertext_sha256: rootsObj.upload.sha256, size_bytes: rootsObj.upload.size_bytes },
      checkpoint: { claim_set: built.claim_set_receipt, covers_through_generation: repairGen, git_object_format: "sha1", cutoff: null },
      checkpoint_purpose: "repair", capture_binding: null,
      repair: { base_generation: input.base_generation, base_head_sha256: baseEntry.sha256, supersedes_from: nextGeneration(input.base_generation), supersedes_through: newest.generation, reason: input.reason },
    });
    const admitted = await this.admit(head);
    if (admitted.outcome === "conflict") fail("HEAD_CAS_CONFLICT", "a different head was admitted while the repair was being prepared", "publishing repair head", { winner: admitted.winner }, [{ action: "verify the attached winner from storage, rebase, retry" }]);
    return { generation: repairGen, head_sha256: admitted.head_sha256, head, admission_record_sha256: admitted.admission_record_sha256, capture_receipt: null, form: "checkpoint", conflicts_retried: 0, refs: repairedRefs };
  }

  /** Heads `base..newest` (already chain-verified by `verifyToNewest`) re-read + hash-checked from storage. */
  private async chainFrom(baseGeneration: string, newest: GitvaultVerifiedState): Promise<Map<string, { head: GitvaultHead; sha256: string }>> {
    const out = new Map<string, { head: GitvaultHead; sha256: string }>();
    let g = generationToBigInt(newest.generation);
    let expected = newest.head_sha256;
    const stop = generationToBigInt(baseGeneration);
    while (g >= stop) {
      const gen = bigIntToGeneration(g);
      const bytes = await this.transport.getObject({ repo_id: this.repoId, path: gitvaultPaths.head(gen) });
      if (!bytes || sha256Hex(bytes) !== expected) fail("CHAIN_BROKEN", `head ${gen} no longer matches the verified chain`, "re-reading gitvault chain", { generation: gen });
      const head = parseGitvaultStrict(new TextDecoder().decode(bytes)) as GitvaultHead;
      if (head.transition !== null) fail("UPGRADE_REQUIRED", "a repair must not cross an admitted transition", "re-reading gitvault chain", { generation: gen });
      out.set(gen, { head, sha256: expected });
      expected = head.prev_sha256;
      g -= 1n;
    }
    return out;
  }

  // ── restore (clone-back / WAL replay into a local repository) ──

  /**
   * Pull the newest checkpoint (if any) and every later WAL pack into
   * `targetRepoDir` (an initialized repository), then verify every canonical
   * ref + the HEAD target resolves. Returns the materialized refs.
   */
  async restoreObjectsInto(targetRepoDir: string): Promise<{ refs: GitvaultRefMap; head_target: GitvaultHeadTarget; generation: string }> {
    const newest = await this.materialize();
    if (!newest.head) return { refs: {}, head_target: newest.head_target, generation: newest.generation };
    const writerKey = newest.genesis.creator_signing_pubkey;
    // walk back to the newest checkpoint-bearing head
    const heads: GitvaultHead[] = [];
    let cur: GitvaultHead | null = newest.head;
    while (cur) {
      heads.unshift(cur);
      if (cur.checkpoint) break;
      if (cur.generation === "0000000000000001") break;
      const prevGen = bigIntToGeneration(generationToBigInt(cur.generation) - 1n);
      const bytes = await this.transport.getObject({ repo_id: this.repoId, path: gitvaultPaths.head(prevGen) });
      if (!bytes || sha256Hex(bytes) !== cur.prev_sha256) fail("CHAIN_BROKEN", `head ${prevGen} does not match the chain during restore`, "restoring gitvault objects");
      cur = parseGitvaultStrict(new TextDecoder().decode(bytes)) as GitvaultHead;
    }
    const first = heads[0]!;
    if (first.checkpoint) {
      const claimBytes = await this.transport.getObject({ repo_id: this.repoId, path: gitvaultPaths.claimSet(first.checkpoint.claim_set.object_id) });
      if (!claimBytes || sha256Hex(claimBytes) !== first.checkpoint.claim_set.stored_bytes_sha256) fail("CHECKPOINT_INCOMPLETE", "claim set absent or altered", "restoring gitvault objects");
      const claimSet = parseGitvaultStrict(new TextDecoder().decode(claimBytes)) as GitvaultCheckpointClaimSet;
      if (!verifyGitvaultObject(claimSet as unknown as GitvaultSignedObject, writerKey)) fail("CHECKPOINT_INCOMPLETE", "claim set signature fails", "restoring gitvault objects");
      const manifest = await this.openCarrier<GitvaultCheckpointManifest>("checkpoint_manifest", claimSet.manifest_receipt, gitvaultPaths.checkpointManifest(claimSet.manifest_receipt.object_id), writerKey);
      checkClaimSetEquality(claimSet, manifest, first.checkpoint.covers_through_generation);
      for (const p of manifest.packs) {
        const frame = await this.transport.getObject({ repo_id: this.repoId, path: gitvaultPaths.checkpointPack(p.object_id) });
        if (!frame) fail("CHECKPOINT_INCOMPLETE", `checkpoint pack ${p.object_id} absent`, "restoring gitvault objects");
        const plain = openFrame({ k_obj: deriveObjectKey(this.kRepo(), this.repoId, this.epoch(), "checkpoint_pack", p.object_id), repo_id: this.repoId, object_kind: "checkpoint_pack", object_id: p.object_id, epoch: this.epoch(), frame, expected_ciphertext_sha256: p.ciphertext_sha256 });
        if (sha256Hex(plain) !== p.plaintext_sha256 || String(plain.length) !== p.plaintext_size_bytes) fail("CHECKPOINT_INCOMPLETE", `checkpoint pack ${p.object_id} plaintext mismatch`, "restoring gitvault objects");
        await hardenedGit(targetRepoDir, ["index-pack", "--stdin", "--strict"], { input: plain });
      }
    }
    for (const h of heads) {
      for (const w of h.wal_entries) {
        const frame = await this.transport.getObject({ repo_id: this.repoId, path: gitvaultPaths.wal(w.object_id) });
        if (!frame) fail("CHAIN_UNUSABLE", `WAL pack ${w.object_id} absent`, "restoring gitvault objects");
        const plain = openFrame({ k_obj: deriveObjectKey(this.kRepo(), this.repoId, this.epoch(), "wal_pack", w.object_id), repo_id: this.repoId, object_kind: "wal_pack", object_id: w.object_id, epoch: this.epoch(), frame, expected_ciphertext_sha256: w.ciphertext_sha256 });
        await hardenedGit(targetRepoDir, ["index-pack", "--stdin", "--strict"], { input: plain });
      }
    }
    // the §4.7 coverage set — canonical refs ∪ unexpired roots ∪ the HEAD target — must all resolve.
    for (const t of GitvaultVault.coverageTips(newest.refs, newest.roots, newest.head_target)) {
      if (!(await hasObject(targetRepoDir, t))) fail("CHAIN_UNUSABLE", `covered tip ${t} does not resolve after restore`, "restoring gitvault objects", { oid: t });
    }
    return { refs: newest.refs, head_target: newest.head_target, generation: newest.generation };
  }
}

/** §4.7 cross-field equality: covers_through agree; the claim set's ordered pack ids/hashes/sizes/total equal the manifest's (shared stored fields only). */
export function checkClaimSetEquality(claimSet: GitvaultCheckpointClaimSet, manifest: GitvaultCheckpointManifest, headCoversThrough: string): void {
  if (claimSet.covers_through_generation !== headCoversThrough || manifest.covers_through_generation !== headCoversThrough) fail("CHECKPOINT_INCOMPLETE", "covers_through_generation disagrees between head, claim set, and manifest", "checking checkpoint claim set");
  if (claimSet.ordered_pack_receipts.length !== manifest.packs.length) fail("CHECKPOINT_INCOMPLETE", "claim set and manifest list different pack counts", "checking checkpoint claim set");
  let total = BigInt(claimSet.manifest_receipt.size_bytes);
  for (let i = 0; i < manifest.packs.length; i++) {
    const c = claimSet.ordered_pack_receipts[i]!;
    const m = manifest.packs[i]!;
    if (c.object_id !== m.object_id || c.ciphertext_sha256 !== m.ciphertext_sha256 || c.size_bytes !== m.size_bytes) fail("CHECKPOINT_INCOMPLETE", `pack ${i}: claim set and manifest disagree on the shared stored fields`, "checking checkpoint claim set", { index: i });
    total += BigInt(c.size_bytes);
  }
  if (BigInt(claimSet.total_stored_size_bytes) !== total) fail("CHECKPOINT_INCOMPLETE", "total_stored_size_bytes ≠ manifest receipt + Σ pack sizes", "checking checkpoint claim set");
  if (claimSet.manifest_receipt.object_id !== manifest.object_id) fail("CHECKPOINT_INCOMPLETE", "claim set names a different manifest", "checking checkpoint claim set");
}

/** Convenience for the deploy lane: the §6.5 capture binding. */
export function captureBinding(captureId: string, applyPlanSha256: string | null, snapshotOidHmac: string): GitvaultCaptureBinding {
  if (!/^[0-9a-f]{32}$/.test(captureId)) fail("GITVAULT_BAD_ID", "capture_id must be 32 lowercase hex", "building capture binding");
  return { capture_id: captureId, apply_plan_sha256: applyPlanSha256, snapshot_oid_hmac: snapshotOidHmac };
}

export type { GitvaultRefUpdate };
