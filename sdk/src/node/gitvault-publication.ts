/**
 * gitvault — publication (protocol rev 40 §6 + §4.4–4.7 + §5A client side;
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
  deriveDigestKey,
  deriveObjectKey,
  formatGitvaultTimestamp,
  hexToBytes,
  jcs,
  keyedCommitment,
  newGitvaultId,
  objectsetContent,
  openBindingPreimage,
  openFrame,
  parseGitvaultStrict,
  sealFrame,
  sha256Hex,
  signGitvaultObject,
  storedBytes,
  verifyGitvaultObject,
} from "../namespaces/gitvault.crypto.js";
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
  GitvaultRefState,
  GitvaultRefTransaction,
  GitvaultRefUpdate,
  GitvaultRepairDescriptor,
  GitvaultRetentionCutoff,
  GitvaultRetentionCutoffReceipt,
  GitvaultRetentionRoot,
  GitvaultRetentionRoots,
  GitvaultRetentionRootsReceipt,
  GitvaultSignedObject,
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
}

const HEX16 = "[0-9a-f]{16}";
/** Ordered longest-suffix-first so `.ticket.json` is never eaten by `.enc`. */
const PATH_PATTERNS: Array<[RegExp, (m: RegExpExecArray) => GitvaultWireRef]> = [
  [new RegExp(`^head/(${HEX16})$`), (m) => ({ kind: "head", generation: m[1]! })],
  [new RegExp(`^admissions/(${HEX16})$`), (m) => ({ kind: "admission", generation: m[1]! })],
  [/^envelopes\/([0-9a-f]{16})\/(ek_[0-9a-f]{32})$/, (m) => ({ kind: "object", read: { object_kind: "key_envelope", epoch: m[1]!, recipient_fingerprint: m[2]! } })],
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

/** The stable key both sides agree on, used to pair receipts back to requests. */
export function gitvaultLedgerId(read: GitvaultObjectReadRequest): string {
  return read.object_kind === "key_envelope" ? `key_envelope:${read.epoch}:${read.recipient_fingerprint}` : String(read.object_id);
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
    if (!this.keystore.readIdentity()) fail("KEYSTORE_MISSING", "no gitvault identity in the keystore", "opening gitvault vault", undefined, [{ action: "restore ~/.config/run402/gitvault from backup or accept vault loss" }]);
    const repo = this.keystore.readRepo(this.repoId);
    if (!repo) fail("GITVAULT_REPO_STATE_MISSING", `no keystore repo file for ${this.repoId}; restore it from the principal's own envelope (keystore.restoreRepoFromEnvelope)`, "opening gitvault vault", { repo_id: this.repoId });
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
   */
  async verifyToNewest(): Promise<GitvaultVerifiedState> {
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
          this.keystore.updateRepo(this.repoId, { verified_prefix: pin });
          fail("VERIFICATION_BUDGET_EXCEEDED", `${verified} heads verified this call; the verified prefix (generation ${pin.generation}) is persisted — call again to continue`, "verifying gitvault chain", { verified_through: pin.generation }, [{ action: "resume verification from the persisted verified prefix" }]);
        }
        const bytes = await this.transport.getObject({ repo_id: this.repoId, path: gitvaultPaths.head(entry.generation) });
        if (!bytes) fail("CHAIN_BROKEN", `listed head ${entry.generation} is absent from storage`, "verifying gitvault chain", { generation: entry.generation });
        const head = parseGitvaultStrict(new TextDecoder().decode(bytes)) as GitvaultHead;
        checkChainLink({ head, stored_bytes: bytes, listed_sha256: entry.stored_bytes_sha256, expected_generation: nextGeneration(pin.generation), prev_sha256: pin.head_sha256, repo_id: this.repoId, writer_public_key: writerKey, writer_key_id: writerKeyId });
        try {
          assertNoTransition(head);
        } catch (e) {
          // fail closed: pin stays BELOW the transition head; the verified prefix is cleared (this is the final state, not a budget pause)
          this.keystore.updateRepo(this.repoId, { head_pin: pin, verified_prefix: null });
          throw e;
        }
        pin = { generation: head.generation, head_sha256: entry.stored_bytes_sha256, pinned_at: formatGitvaultTimestamp(this.now()) };
        lastHead = head;
        verified += 1;
      }
      // verified prefix persists per page (resumable)
      this.keystore.updateRepo(this.repoId, { verified_prefix: pin });
      const next = nextListingRequest(request, page);
      if (!next) break;
      request = next;
    }
    this.keystore.updateRepo(this.repoId, { head_pin: pin, verified_prefix: null });
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

  /** Verify to newest, then decrypt + apply its carriers — advancing the materialized pin. */
  async materialize(): Promise<GitvaultMaterializedState> {
    const state = await this.verifyToNewest();
    const writerKey = state.genesis.creator_signing_pubkey;
    if (!state.head) {
      this.keystore.updateRepo(this.repoId, { materialized_pin: { generation: state.generation, head_sha256: state.head_sha256, pinned_at: formatGitvaultTimestamp(this.now()) } });
      return { ...state, ref_state: null, retention_roots: null, refs: {}, roots: [], head_target: { kind: "symref", ref: "refs/heads/main" } };
    }
    const refState = await this.openCarrier<GitvaultRefState>("ref_state", state.head.ref_state, gitvaultPaths.refState(state.head.ref_state.object_id), writerKey);
    const roots = await this.openCarrier<GitvaultRetentionRoots>("retention_roots", state.head.retention_roots, gitvaultPaths.retentionRoots(state.head.retention_roots.object_id), writerKey);
    if (refState.generation !== state.generation || roots.generation !== state.generation) fail("CHAIN_UNUSABLE", "carrier generation does not match the head", "materializing gitvault head");
    this.keystore.updateRepo(this.repoId, { materialized_pin: { generation: state.generation, head_sha256: state.head_sha256, pinned_at: formatGitvaultTimestamp(this.now()) } });
    return { ...state, ref_state: refState, retention_roots: roots, refs: { ...refState.refs }, roots: roots.roots.map((r) => ({ ...r })), head_target: refState.head_target };
  }

  // ── object building ──

  private seal(kind: "wal_pack" | "ref_state" | "retention_roots" | "checkpoint_manifest" | "checkpoint_pack", objectId: string, plaintext: Uint8Array, path: string): GitvaultUploadObject {
    const sealed = sealFrame({ k_obj: deriveObjectKey(this.kRepo(), this.repoId, this.epoch(), kind, objectId), repo_id: this.repoId, object_kind: kind, object_id: objectId, epoch: this.epoch(), plaintext });
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

  private buildRefState(generation: string, refs: GitvaultRefMap, headTarget: GitvaultHeadTarget): { object: GitvaultRefState; upload: GitvaultUploadObject } {
    if (headTarget.kind === "symref" && !BRANCH_REF_RE.test(headTarget.ref)) fail("REFNAME_UNSUPPORTED", `head_target symref must name a refs/heads/* branch: ${headTarget.ref}`, "building ref_state");
    if (headTarget.kind === "detached" && !GITVAULT_OID40_RE.test(headTarget.oid)) fail("REF_TRANSACTION_INVALID", "detached head_target needs a 40-hex oid", "building ref_state");
    assertRefMapCardinality(refs);
    const sorted: GitvaultRefMap = {};
    for (const k of Object.keys(refs).sort()) sorted[k] = refs[k]!;
    const id = newGitvaultId("refs");
    const object = signGitvaultObject({ format: GITVAULT_FORMAT, object_kind: "ref_state" as const, suite: GITVAULT_SUITE, repo_id: this.repoId, object_id: id, generation, refs: sorted, head_target: headTarget }, this.signer()) as GitvaultRefState;
    const plaintext = storedBytes(object as unknown as GitvaultSignedObject);
    if (plaintext.length > GITVAULT_MAX_REF_STATE_OBJECT_BYTES) fail("REF_STATE_LIMIT_EXCEEDED", "ref_state object exceeds 32 MiB", "building ref_state");
    return { object, upload: this.seal("ref_state", id, plaintext, gitvaultPaths.refState(id)) };
  }

  private buildRetentionRoots(generation: string, roots: GitvaultRetentionRoot[], cutoff: GitvaultRetentionRoots["cutoff"]): { object: GitvaultRetentionRoots; upload: GitvaultUploadObject } {
    const id = newGitvaultId("rr");
    const object = signGitvaultObject({ format: GITVAULT_FORMAT, object_kind: "retention_roots" as const, suite: GITVAULT_SUITE, repo_id: this.repoId, object_id: id, generation, cutoff, roots: [...roots].sort(compareRoots) }, this.signer()) as GitvaultRetentionRoots;
    const plaintext = storedBytes(object as unknown as GitvaultSignedObject);
    if (plaintext.length > GITVAULT_MAX_REF_STATE_OBJECT_BYTES) fail("REF_STATE_LIMIT_EXCEEDED", "retention_roots object exceeds 32 MiB", "building retention_roots");
    return { object, upload: this.seal("retention_roots", id, plaintext, gitvaultPaths.retentionRoots(id)) };
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
    capture_binding: GitvaultPushOptions["capture_binding"];
  }): Promise<
    | { outcome: "admitted"; generation: string; head: GitvaultHead; head_sha256: string; admission_record_sha256: string; capture_receipt: GitvaultCaptureReceipt | null; form: "wal" | "checkpoint"; refs: GitvaultRefMap }
    | { outcome: "conflict"; generation: string; winner: { generation: string; stored_bytes_sha256: string } }
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
    if (input.force_checkpoint || walPacks.length > GITVAULT_MAX_WAL_RECEIPTS_PER_HEAD) {
      form = "checkpoint";
      const built = await this.buildCheckpoint({ generation, ref_state: refState.object, retention_roots: rootsObj.object });
      objects.push(...built.objects);
      checkpoint = { claim_set: built.claim_set_receipt, covers_through_generation: generation, git_object_format: "sha1", cutoff: ticket ? { ticket: ticket.receipt, cutoff_at: ticket.ticket.cutoff_at } : null };
    } else {
      form = "wal";
      for (const pack of walPacks) {
        const id = newGitvaultId("wal");
        const upload = { ...this.seal("wal_pack", id, pack, gitvaultPaths.wal(id)), base_generation: base.generation };
        objects.push(upload);
        walEntries.push({ object_id: id, object_kind: "wal_pack", ciphertext_sha256: upload.sha256, size_bytes: upload.size_bytes, base_generation: base.generation });
      }
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
      this.keystore.updateRepo(this.repoId, { last_ref_transaction: { generation: published.generation, transaction: options.transaction, at: formatGitvaultTimestamp(this.now()) } });
      return { generation: published.generation, head_sha256: published.head_sha256, head: published.head, admission_record_sha256: published.admission_record_sha256, capture_receipt: published.capture_receipt, form: published.form, conflicts_retried: conflicts, refs: published.refs };
    }
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

  private signHead(fields: Omit<GitvaultHead, "format" | "object_kind" | "suite" | "repo_id" | "epoch" | "transition" | "writer_key_id" | "created_at" | "signature">): GitvaultHead {
    return signGitvaultObject({ format: GITVAULT_FORMAT, object_kind: "head" as const, suite: GITVAULT_SUITE, repo_id: this.repoId, generation: fields.generation, prev_sha256: fields.prev_sha256, epoch: GITVAULT_GENESIS_EPOCH, wal_entries: fields.wal_entries, ref_state: fields.ref_state, retention_roots: fields.retention_roots, checkpoint: fields.checkpoint, checkpoint_purpose: fields.checkpoint_purpose, capture_binding: fields.capture_binding, repair: fields.repair, transition: null, writer_key_id: this.writerKeyId(), created_at: formatGitvaultTimestamp(this.now()) }, this.signer()) as GitvaultHead;
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
