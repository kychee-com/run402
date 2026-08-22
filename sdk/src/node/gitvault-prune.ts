/**
 * gitvault — prune (protocol rev 40 §7.3; task 5.12a).
 *
 * The two-phase, ACYCLIC prune the client half owns:
 *
 *   1. plan     — walk the verified chain, compute the GC ROOT SET (what must
 *                 never be deleted) and the pruneable universe, and subtract.
 *   2. attest   — TWO `verifier_receipt`s over the SAME `intent_core_sha256`,
 *                 one per CLOSED implementation identity
 *                 (`run402-cli` | `r402s-verify`). This SDK is `run402-cli`
 *                 and produces exactly ONE of them; the other MUST come from
 *                 `r402s-verify`, which by spec shares no implementation code
 *                 with the SDK — differential verification is the whole point,
 *                 so this module will never synthesize the second receipt.
 *   3. submit   — sign the core, wrap it, sign the wrapper, and POST the
 *                 EXACT BYTES. The gateway reads this route through
 *                 `express.raw` and verifies the owner signature over the
 *                 bytes as sent, so a re-serialized object is a different
 *                 object. {@link pruneIntentBytes} is the one serializer.
 *   4. confirm  — poll the intent until its control-plane-signed
 *                 `prune_completion` appears, then believe ONLY that: per-object
 *                 outcomes are THREE-VALUED (`deleted` | `present_not_attempted`
 *                 | `present_after_attempt`) and only `deleted` means the bytes
 *                 are gone. `present_after_attempt` is NOT a deletion.
 *
 * What this module deliberately does NOT do:
 *   - decide retention eligibility. The ≥90-day schedule is measured against a
 *     control-plane-signed `retention_cutoff` ticket and the server's own
 *     admission times; a client cannot prove either. The plan is a PROPOSAL and
 *     the gateway is the authority — it refuses any candidate that is not
 *     retention-eligible against the bound ticket.
 *   - attest anything it did not check. A receipt this module builds carries
 *     `result: "failed"` (and both booleans as observed) whenever the chain
 *     cannot prove the property, rather than a convenient `true`.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalError } from "../errors.js";
import {
  GITVAULT_FORMAT,
  GITVAULT_SUITE,
  newGitvaultId,
  newHex32,
  signGitvaultObject,
  storedBytes,
  storedBytesSha256,
} from "../namespaces/gitvault.crypto.js";
import type {
  GitvaultCheckpointClaimSet,
  GitvaultCheckpointManifestReceipt,
  GitvaultCheckpointPackReceipt,
  GitvaultCheckpointClaimSetReceipt,
  GitvaultHead,
  GitvaultRefStateReceipt,
  GitvaultRetentionRootsReceipt,
  GitvaultSignedObject,
  GitvaultWalPackReceipt,
} from "../namespaces/gitvault.types.js";

function fail(code: string, message: string, context: string, details?: unknown, nextActions?: unknown[]): never {
  throw new LocalError(message, context, { code, details, ...(nextActions ? { next_actions: nextActions } : {}) });
}

/** §7.3: at most 10 000 candidates per intent; larger prunes chunk into successive intents. */
export const GITVAULT_MAX_PRUNE_CANDIDATES = 10_000;

/** The CLOSED V0 verifier identity set (`common.json#/$defs/implementation_id`). */
export const GITVAULT_VERIFIER_IMPLEMENTATIONS = ["run402-cli", "r402s-verify"] as const;
export type GitvaultVerifierImplementation = (typeof GITVAULT_VERIFIER_IMPLEMENTATIONS)[number];

/** This SDK's identity when it attests. The other half of the pair is never ours to produce. */
export const GITVAULT_SDK_VERIFIER_IMPLEMENTATION: GitvaultVerifierImplementation = "run402-cli";

/**
 * What this lineage calls itself in a receipt's `implementation_version`.
 *
 * The LINEAGE and the PROTOCOL REVISION, not the npm version: a receipt records
 * which verifier produced it against which frozen wire, and the npm number
 * moves for reasons that have nothing to do with either. Bump this when the
 * verification logic or the revision it verifies changes.
 */
export const GITVAULT_SDK_VERIFIER_VERSION = "run402-sdk/r402s-v0-rev40";

/** `common.json#/$defs/receipt_pruneable` — the CLOSED union a delete set may name. */
export type GitvaultPruneableReceipt =
  | GitvaultWalPackReceipt
  | GitvaultRefStateReceipt
  | GitvaultRetentionRootsReceipt
  | GitvaultCheckpointManifestReceipt
  | GitvaultCheckpointPackReceipt
  | GitvaultCheckpointClaimSetReceipt;

/** One verified chain link plus its resolved checkpoint claim set (null when the head bears no checkpoint). */
export interface GitvaultChainEntry {
  head: GitvaultHead;
  head_sha256: string;
  claim_set: GitvaultCheckpointClaimSet | null;
}

/** `common.json#/$defs/verifier_receipt_ref` — what the intent carries, not the receipt itself. */
export interface GitvaultVerifierReceiptRef {
  object_id: string;
  object_kind: "verifier_receipt";
  stored_bytes_sha256: string;
  size_bytes: string;
  implementation_id: GitvaultVerifierImplementation;
}

/** `verifier_receipt.json` — owner-signed, uploaded, then claimed at the intent's fence. */
export interface GitvaultVerifierReceipt {
  format: typeof GITVAULT_FORMAT;
  object_kind: "verifier_receipt";
  suite: typeof GITVAULT_SUITE;
  repo_id: string;
  object_id: string;
  intent_core_sha256: string;
  checkpoint_head_sha256: string;
  cutoff_ticket_sha256: string | null;
  restored_object_set_hmac: string;
  retention_evolution_ok: boolean;
  candidates_outside_roots_ok: boolean;
  implementation_id: GitvaultVerifierImplementation;
  implementation_version: string;
  result: "restored_and_verified" | "failed";
  signature: string;
}

/** `prune_intent_core.json` — owner-signed; the acyclic base BOTH receipts sign. */
export interface GitvaultPruneIntentCore {
  format: typeof GITVAULT_FORMAT;
  object_kind: "prune_intent_core";
  suite: typeof GITVAULT_SUITE;
  repo_id: string;
  object_id: string;
  gc_epoch: string;
  maintenance_cycle_id: string | null;
  maintenance_prune_role: "intermediate" | "final" | null;
  stage_claim_set_sha256: string | null;
  batch_index: string | null;
  batch_count: string | null;
  authorizing_head_sha256: string;
  checkpoint_claim_set_sha256: string;
  gc_root_set_hmac: string;
  retention_state_hmac: string;
  delete_set: GitvaultPruneableReceipt[];
  nonce: string;
  signature: string;
}

/** `prune_intent.json` — the wrapper the gateway publishes create-only under `prune/`. */
export interface GitvaultPruneIntent {
  format: typeof GITVAULT_FORMAT;
  object_kind: "prune_intent";
  suite: typeof GITVAULT_SUITE;
  repo_id: string;
  object_id: string;
  core: GitvaultPruneIntentCore;
  intent_core_sha256: string;
  verifier_receipts: GitvaultVerifierReceiptRef[];
  signature: string;
}

/** One entry of the completion's three-valued vector. */
export interface GitvaultPruneOutcome {
  object_id: string;
  result: "deleted" | "present_not_attempted" | "present_after_attempt";
}

/** `GET …/prune-intents/:id` — the gateway's secret-free public view (`toPublicIntent`). */
export interface GitvaultPruneIntentRecord {
  object_id: string;
  repo_id: string;
  state: string;
  gc_epoch: string;
  intent_sha256: string | null;
  intent_core_sha256: string | null;
  candidate_count: number;
  next_candidate_index: number;
  maintenance_cycle_id: string | null;
  maintenance_prune_role: string | null;
  stage_claim_set_sha256: string | null;
  batch_index: number | null;
  batch_count: number | null;
  completion: {
    object_id: string | null;
    sha256: string | null;
    per_object: GitvaultPruneOutcome[] | null;
    deleted_count: number;
    present_after_attempt_count: number;
    present_not_attempted_count: number;
    gc_epoch_at_completion: string;
    cycle_event_seq: string | null;
    completed_at: string | null;
  } | null;
  prepared_at: string | null;
  intent_put_issued_at: string | null;
  intent_stored_at: string | null;
  deleting_started_at: string | null;
}

// ─── The GC root set + the pruneable universe (§7.3 step 1) ──────────────────

function receiptsOfHead(head: GitvaultHead): GitvaultPruneableReceipt[] {
  return [...head.wal_entries, head.ref_state, head.retention_roots];
}

/**
 * A checkpoint's FULL RECOVERY BUNDLE: the claim set, the manifest, every pack,
 * AND its `covers_through` head's `ref_state` + `retention_roots` carriers.
 * A bundle missing its carriers is not a recovery path, so the carriers are
 * part of the protection, not adjacent to it.
 */
export function checkpointRecoveryBundle(entry: GitvaultChainEntry): GitvaultPruneableReceipt[] {
  const block = entry.head.checkpoint;
  if (!block) return [];
  const out: GitvaultPruneableReceipt[] = [block.claim_set, entry.head.ref_state, entry.head.retention_roots];
  if (entry.claim_set) out.push(entry.claim_set.manifest_receipt, ...entry.claim_set.ordered_pack_receipts);
  return out;
}

/** Every pruneable object the chain has ever named, sorted by `object_id`, deduplicated. */
export function collectPruneUniverse(entries: readonly GitvaultChainEntry[]): GitvaultPruneableReceipt[] {
  const seen = new Map<string, GitvaultPruneableReceipt>();
  for (const e of entries) {
    for (const r of receiptsOfHead(e.head)) seen.set(r.object_id, r);
    for (const r of checkpointRecoveryBundle(e)) seen.set(r.object_id, r);
  }
  return sortPruneReceipts([...seen.values()]);
}

/** Pairwise-distinct, sorted by `object_id` — the schema's canonical order, not an incidental one. */
export function sortPruneReceipts(receipts: readonly GitvaultPruneableReceipt[]): GitvaultPruneableReceipt[] {
  return [...receipts].sort((a, b) => (a.object_id < b.object_id ? -1 : a.object_id > b.object_id ? 1 : 0));
}

export interface GitvaultGcRootSet {
  /** The protected receipts, sorted — the `gcrootset` commitment's preimage content. */
  receipts: GitvaultPruneableReceipt[];
  /** The newest checkpoint-bearing entry, or `null` when the chain has none. */
  latest_checkpoint: GitvaultChainEntry | null;
  /** The one before it, or `null`. */
  prior_checkpoint: GitvaultChainEntry | null;
  /**
   * Why nothing may be pruned yet, or `null` when a prune is structurally
   * possible. Stated rather than left to be inferred from an empty candidate
   * list, which would read as "already clean".
   */
  blocked_reason: string | null;
}

/**
 * The GC root set: the latest checkpoint's recovery bundle + its WAL suffix +
 * the immediately-prior checkpoint's recovery bundle + every carrier at or
 * after the prior checkpoint.
 *
 * DELIBERATELY conservative in two places, because under-protecting deletes
 * history and over-protecting only costs storage:
 *
 *   - with FEWER THAN TWO checkpoints nothing is prunable at all. The
 *     protection rule exists so a bad latest checkpoint still has a second
 *     recovery path; with a single checkpoint that second path IS the
 *     pre-checkpoint WAL chain, so pruning it would leave exactly one.
 *   - every `ref_state` / `retention_roots` carrier at or after the PRIOR
 *     checkpoint is protected, not just the unexpired-root carriers. Root
 *     expiry is measured against a server-signed ticket this client cannot
 *     evaluate, so it never guesses a carrier is dead.
 */
export function computeGcRootSet(entries: readonly GitvaultChainEntry[]): GitvaultGcRootSet {
  const ordered = [...entries].sort((a, b) => (a.head.generation < b.head.generation ? -1 : a.head.generation > b.head.generation ? 1 : 0));
  const checkpoints = ordered.filter((e) => e.head.checkpoint !== null);
  const latest = checkpoints.length > 0 ? checkpoints[checkpoints.length - 1]! : null;
  const prior = checkpoints.length > 1 ? checkpoints[checkpoints.length - 2]! : null;
  const seen = new Map<string, GitvaultPruneableReceipt>();
  const protect = (rs: readonly GitvaultPruneableReceipt[]): void => {
    for (const r of rs) seen.set(r.object_id, r);
  };
  if (!latest || !prior) {
    // Everything is a root. Protect the whole universe so the commitment is
    // still computable and honest, and say why.
    protect(collectPruneUniverse(ordered));
    return {
      receipts: sortPruneReceipts([...seen.values()]),
      latest_checkpoint: latest,
      prior_checkpoint: prior,
      blocked_reason:
        checkpoints.length === 0
          ? "the chain carries no checkpoint, so the WAL history is the only recovery path — compact first"
          : "the chain carries only one checkpoint; the pre-checkpoint WAL chain is the second recovery path and stays protected until a second compaction exists",
    };
  }
  protect(checkpointRecoveryBundle(latest));
  protect(checkpointRecoveryBundle(prior));
  for (const e of ordered) {
    if (e.head.generation >= prior.head.generation) protect(receiptsOfHead(e.head));
  }
  return { receipts: sortPruneReceipts([...seen.values()]), latest_checkpoint: latest, prior_checkpoint: prior, blocked_reason: null };
}

export interface GitvaultPrunePlan {
  /** Candidates in canonical order, capped at {@link GITVAULT_MAX_PRUNE_CANDIDATES}. */
  candidates: GitvaultPruneableReceipt[];
  /** How many pruneable objects were left out by the per-intent cap (chunk into a later intent). */
  deferred_count: number;
  root_set: GitvaultGcRootSet;
  universe_count: number;
}

/** universe − GC root set, canonical order, capped. Never mutates its inputs. */
export function planPruneCandidates(entries: readonly GitvaultChainEntry[]): GitvaultPrunePlan {
  const rootSet = computeGcRootSet(entries);
  const protectedIds = new Set(rootSet.receipts.map((r) => r.object_id));
  const universe = collectPruneUniverse(entries);
  const eligible = universe.filter((r) => !protectedIds.has(r.object_id));
  return {
    candidates: eligible.slice(0, GITVAULT_MAX_PRUNE_CANDIDATES),
    deferred_count: Math.max(0, eligible.length - GITVAULT_MAX_PRUNE_CANDIDATES),
    root_set: rootSet,
    universe_count: universe.length,
  };
}

// ─── Retention-root evolution (what a receipt may honestly attest) ───────────

export interface GitvaultRetentionEvolutionCheck {
  ok: boolean;
  /** Every departure this client could not justify from the chain alone. */
  unproven: Array<{ generation: string; ref: string; oid: string; reason: string }>;
}

/**
 * Verify that every retention root which LEFT the map left legally: only at a
 * checkpoint-bearing generation carrying a cutoff ticket, and only when its
 * `effective_admitted_at + retentionDays < cutoff_at` strictly.
 *
 * `effectiveAdmittedAt` returning `null` is not a failure of the vault — it is
 * a failure of THIS CLIENT to prove the departure, and the check reports `ok:
 * false` so the receipt attests `false` rather than a convenient `true`.
 */
export function checkRetentionEvolution(
  entries: readonly GitvaultChainEntry[],
  roots: (entry: GitvaultChainEntry) => Array<{ ref: string; oid: string; dropped_at_generation: string }>,
  effectiveAdmittedAt: (droppedAtGeneration: string) => string | null,
  isEligible: (effectiveAdmittedAtIso: string, cutoffAtIso: string) => boolean,
): GitvaultRetentionEvolutionCheck {
  const ordered = [...entries].sort((a, b) => (a.head.generation < b.head.generation ? -1 : a.head.generation > b.head.generation ? 1 : 0));
  const unproven: GitvaultRetentionEvolutionCheck["unproven"] = [];
  for (let i = 1; i < ordered.length; i++) {
    const before = ordered[i - 1]!;
    const after = ordered[i]!;
    const key = (r: { ref: string; oid: string }): string => `${r.ref} ${r.oid}`;
    const stillThere = new Set(roots(after).map(key));
    for (const root of roots(before)) {
      if (stillThere.has(key(root))) continue;
      const block = after.head.checkpoint;
      if (!block) {
        unproven.push({ generation: after.head.generation, ref: root.ref, oid: root.oid, reason: "a root left the map at a generation that carries no checkpoint" });
        continue;
      }
      if (!block.cutoff) {
        unproven.push({ generation: after.head.generation, ref: root.ref, oid: root.oid, reason: "a root left the map at a checkpoint bound to no retention_cutoff ticket" });
        continue;
      }
      const admitted = effectiveAdmittedAt(root.dropped_at_generation);
      if (admitted === null) {
        unproven.push({ generation: after.head.generation, ref: root.ref, oid: root.oid, reason: "this client cannot resolve the drop's effective_admitted_at, so the departure is unproven" });
        continue;
      }
      if (!isEligible(admitted, block.cutoff.cutoff_at)) {
        unproven.push({ generation: after.head.generation, ref: root.ref, oid: root.oid, reason: "the root left the map before its retention window closed against the bound cutoff" });
      }
    }
  }
  return { ok: unproven.length === 0, unproven };
}

// ─── Building the signed objects ─────────────────────────────────────────────

export interface GitvaultBuildPruneCoreInput {
  repo_id: string;
  gc_epoch: string;
  authorizing_head_sha256: string;
  checkpoint_claim_set_sha256: string;
  gc_root_set_hmac: string;
  retention_state_hmac: string;
  delete_set: readonly GitvaultPruneableReceipt[];
  /** All five cycle fields are non-null together iff the prune advances a maintenance cycle (§7.2). */
  cycle?: { maintenance_cycle_id: string; maintenance_prune_role: "intermediate" | "final"; stage_claim_set_sha256: string; batch_index: string; batch_count: string } | null;
  object_id?: string;
  nonce?: string;
}

/**
 * Build + sign `prune_intent_core`. The core is signed on its own AND embedded
 * in a signed wrapper (the double signature of §7.3) — `intent_core_sha256` is
 * the stored-bytes hash of the COMPLETE signed core, which is why the core must
 * be finished before either verifier can attest anything about it.
 */
export function buildPruneIntentCore(input: GitvaultBuildPruneCoreInput, signingSeed: Uint8Array): GitvaultPruneIntentCore {
  const deleteSet = sortPruneReceipts(input.delete_set);
  if (deleteSet.length === 0) fail("UPGRADE_REQUIRED", "a prune intent must name at least one candidate", "building the gitvault prune intent");
  if (deleteSet.length > GITVAULT_MAX_PRUNE_CANDIDATES) {
    fail("UPGRADE_REQUIRED", `${deleteSet.length} candidates exceed the ${GITVAULT_MAX_PRUNE_CANDIDATES} per-intent maximum; chunk into successive intents`, "building the gitvault prune intent", { candidates: deleteSet.length });
  }
  for (let i = 1; i < deleteSet.length; i++) {
    if (!(deleteSet[i - 1]!.object_id < deleteSet[i]!.object_id)) {
      fail("UPGRADE_REQUIRED", `delete_set is not sorted and pairwise-distinct at index ${i}`, "building the gitvault prune intent", { object_id: deleteSet[i]!.object_id });
    }
  }
  const cycle = input.cycle ?? null;
  const unsigned = {
    format: GITVAULT_FORMAT,
    object_kind: "prune_intent_core" as const,
    suite: GITVAULT_SUITE,
    repo_id: input.repo_id,
    object_id: input.object_id ?? newGitvaultId("pi"),
    gc_epoch: input.gc_epoch,
    maintenance_cycle_id: cycle ? cycle.maintenance_cycle_id : null,
    maintenance_prune_role: cycle ? cycle.maintenance_prune_role : null,
    stage_claim_set_sha256: cycle ? cycle.stage_claim_set_sha256 : null,
    batch_index: cycle ? cycle.batch_index : null,
    batch_count: cycle ? cycle.batch_count : null,
    authorizing_head_sha256: input.authorizing_head_sha256,
    checkpoint_claim_set_sha256: input.checkpoint_claim_set_sha256,
    gc_root_set_hmac: input.gc_root_set_hmac,
    retention_state_hmac: input.retention_state_hmac,
    delete_set: deleteSet,
    nonce: input.nonce ?? newHex32(),
  };
  return signGitvaultObject(unsigned, signingSeed) as GitvaultPruneIntentCore;
}

/** The stored-bytes hash of the complete signed core — what BOTH verifier receipts sign. */
export function pruneIntentCoreSha256(core: GitvaultPruneIntentCore): string {
  return storedBytesSha256(core as unknown as GitvaultSignedObject);
}

export interface GitvaultBuildVerifierReceiptInput {
  repo_id: string;
  intent_core_sha256: string;
  checkpoint_head_sha256: string;
  cutoff_ticket_sha256: string | null;
  restored_object_set_hmac: string;
  retention_evolution_ok: boolean;
  candidates_outside_roots_ok: boolean;
  implementation_id: GitvaultVerifierImplementation;
  implementation_version: string;
  object_id?: string;
}

/**
 * Build + sign a `verifier_receipt`.
 *
 * `result` is DERIVED, never passed in: a receipt is `restored_and_verified`
 * exactly when both attestation booleans are true, and `failed` otherwise. A
 * caller cannot hand this function `failed` booleans and a passing result.
 */
export function buildVerifierReceipt(input: GitvaultBuildVerifierReceiptInput, signingSeed: Uint8Array): GitvaultVerifierReceipt {
  const unsigned = {
    format: GITVAULT_FORMAT,
    object_kind: "verifier_receipt" as const,
    suite: GITVAULT_SUITE,
    repo_id: input.repo_id,
    object_id: input.object_id ?? newGitvaultId("vr"),
    intent_core_sha256: input.intent_core_sha256,
    checkpoint_head_sha256: input.checkpoint_head_sha256,
    cutoff_ticket_sha256: input.cutoff_ticket_sha256,
    restored_object_set_hmac: input.restored_object_set_hmac,
    retention_evolution_ok: input.retention_evolution_ok,
    candidates_outside_roots_ok: input.candidates_outside_roots_ok,
    implementation_id: input.implementation_id,
    implementation_version: input.implementation_version,
    result: (input.retention_evolution_ok && input.candidates_outside_roots_ok ? "restored_and_verified" : "failed") as GitvaultVerifierReceipt["result"],
  };
  return signGitvaultObject(unsigned, signingSeed) as GitvaultVerifierReceipt;
}

/** The `verifier_receipt_ref` an intent carries for an uploaded receipt. */
export function verifierReceiptRef(receipt: GitvaultVerifierReceipt): GitvaultVerifierReceiptRef {
  const bytes = storedBytes(receipt as unknown as GitvaultSignedObject);
  return {
    object_id: receipt.object_id,
    object_kind: "verifier_receipt",
    stored_bytes_sha256: storedBytesSha256(receipt as unknown as GitvaultSignedObject),
    size_bytes: String(bytes.length),
    implementation_id: receipt.implementation_id,
  };
}

/**
 * Wrap + sign the intent.
 *
 * Every gate the gateway applies to the pair is applied here first, so a
 * malformed pair never reaches the wire as a wasted round trip: exactly two
 * refs, one per CLOSED implementation identity, distinct ids AND distinct
 * hashes, each attesting `restored_and_verified` with both booleans true, and
 * each signing THIS core.
 */
export function buildPruneIntent(core: GitvaultPruneIntentCore, receipts: readonly GitvaultVerifierReceipt[], signingSeed: Uint8Array): GitvaultPruneIntent {
  const coreSha = pruneIntentCoreSha256(core);
  if (receipts.length !== 2) {
    fail(
      "UPGRADE_REQUIRED",
      `a prune intent carries exactly two verifier receipts, one per implementation (${GITVAULT_VERIFIER_IMPLEMENTATIONS.join(", ")}); got ${receipts.length}`,
      "building the gitvault prune intent",
      { supplied: receipts.map((r) => r.implementation_id) },
      [{ action: "run r402s-verify against this intent core and pass its receipt alongside the SDK's own" }],
    );
  }
  for (const id of GITVAULT_VERIFIER_IMPLEMENTATIONS) {
    const matching = receipts.filter((r) => r.implementation_id === id);
    if (matching.length !== 1) {
      fail("UPGRADE_REQUIRED", `exactly one verifier receipt per implementation is required; ${id} has ${matching.length}`, "building the gitvault prune intent", { implementation_id: id });
    }
  }
  const [a, b] = receipts as [GitvaultVerifierReceipt, GitvaultVerifierReceipt];
  const refs = receipts.map(verifierReceiptRef);
  if (a.object_id === b.object_id || refs[0]!.stored_bytes_sha256 === refs[1]!.stored_bytes_sha256) {
    fail("UPGRADE_REQUIRED", "the two verifier receipts must be distinct objects with distinct hashes", "building the gitvault prune intent");
  }
  for (const r of receipts) {
    if (r.repo_id !== core.repo_id) fail("GITVAULT_ACCESS_DENIED", `verifier receipt ${r.object_id} attests a different vault`, "building the gitvault prune intent", { repo_id: r.repo_id });
    if (r.intent_core_sha256 !== coreSha) {
      fail("UPGRADE_REQUIRED", `verifier receipt ${r.object_id} signs a different intent core (${r.intent_core_sha256} ≠ ${coreSha})`, "building the gitvault prune intent", { object_id: r.object_id });
    }
    if (r.result !== "restored_and_verified" || r.retention_evolution_ok !== true || r.candidates_outside_roots_ok !== true) {
      fail("UPGRADE_REQUIRED", `verifier receipt ${r.object_id} does not attest restored_and_verified with both attestations true`, "building the gitvault prune intent", {
        object_id: r.object_id,
        result: r.result,
        retention_evolution_ok: r.retention_evolution_ok,
        candidates_outside_roots_ok: r.candidates_outside_roots_ok,
      });
    }
  }
  // The two refs ride in the receipts' given order; the schema's `uniqueItems`
  // is satisfied by the distinctness gate above, not by sorting.
  const unsigned = {
    format: GITVAULT_FORMAT,
    object_kind: "prune_intent" as const,
    suite: GITVAULT_SUITE,
    repo_id: core.repo_id,
    object_id: core.object_id,
    core,
    intent_core_sha256: coreSha,
    verifier_receipts: refs,
  };
  return signGitvaultObject(unsigned, signingSeed) as GitvaultPruneIntent;
}

/**
 * Refuse a supplied core that the chain has moved past — BEFORE the receipts
 * are uploaded.
 *
 * A prune is planned, verified out-of-band by a second implementation, and only
 * then submitted, so there is a real window in which a push or a compaction
 * lands underneath it. The gateway would refuse such an intent at its fence,
 * but by then both receipts are stored objects the fence CLAIMS, so a stale
 * submission burns evidence for nothing. Same registry codes the gateway uses,
 * raised one step earlier.
 */
export function assertPruneCoreStillCurrent(
  core: GitvaultPruneIntentCore,
  current: { repo_id: string; gc_epoch: string; checkpoint_claim_set_sha256: string },
): void {
  if (core.repo_id !== current.repo_id) {
    fail("GITVAULT_ACCESS_DENIED", `the supplied intent core belongs to ${core.repo_id}, not ${current.repo_id}`, "submitting the gitvault prune intent", { repo_id: core.repo_id });
  }
  if (core.gc_epoch !== current.gc_epoch) {
    fail(
      "GC_EPOCH_STALE",
      `the supplied intent core was planned at gc_epoch ${core.gc_epoch}; the vault is at ${current.gc_epoch}`,
      "submitting the gitvault prune intent",
      { planned: core.gc_epoch, current: current.gc_epoch },
      [{ action: "refetch the vault state and rebuild the intent at the current epoch" }],
    );
  }
  if (core.checkpoint_claim_set_sha256 !== current.checkpoint_claim_set_sha256) {
    fail(
      "GC_EPOCH_STALE",
      "the supplied intent core names a checkpoint that is no longer the latest; a fresh checkpoint landed after the plan",
      "submitting the gitvault prune intent",
      { planned: core.checkpoint_claim_set_sha256, current: current.checkpoint_claim_set_sha256 },
      [{ action: "refetch the vault state and rebuild the intent at the current epoch" }],
    );
  }
}

/**
 * THE serializer for the submit route.
 *
 * `POST …/prune-intents` is parsed with `express.raw`: the service strict-parses
 * these bytes and verifies the owner signature over them. Anything that
 * re-serializes the object between here and the socket — a JSON body helper, a
 * proxy that reformats — changes what was signed. Send exactly this.
 */
export function pruneIntentBytes(intent: GitvaultPruneIntent): Uint8Array {
  return storedBytes(intent as unknown as GitvaultSignedObject);
}

// ─── Believing the completion, and nothing else ──────────────────────────────

export interface GitvaultPruneConfirmation {
  /** `null` until the control-plane-signed completion exists. */
  outcome: "completed" | "superseded_no_delete" | "superseded_partial_delete" | null;
  /** Object ids the completion confirms are GONE. Only `deleted` qualifies. */
  deleted: string[];
  /** Still present — attempted or not. Never reported as removed. */
  present: GitvaultPruneOutcome[];
  /** Candidates the completion did not adjudicate at all (a defect; reported, never assumed deleted). */
  unadjudicated: string[];
}

/**
 * Read the completion's three-valued vector against the intent's canonical
 * candidate order.
 *
 * The one rule this function exists to enforce: **only `deleted` means gone.**
 * `present_after_attempt` looks like a deletion in the logs and is not one —
 * treating it as one is how a client reports history removed that is still
 * there. A candidate with no entry is `unadjudicated`, never inferred.
 */
export function summarizePruneCompletion(candidateIds: readonly string[], record: GitvaultPruneIntentRecord | null): GitvaultPruneConfirmation {
  const completion = record?.completion ?? null;
  const perObject = completion?.per_object ?? null;
  if (!completion || !perObject) return { outcome: null, deleted: [], present: [], unadjudicated: [...candidateIds] };
  const byId = new Map(perObject.map((o) => [o.object_id, o]));
  const deleted: string[] = [];
  const present: GitvaultPruneOutcome[] = [];
  const unadjudicated: string[] = [];
  for (const id of candidateIds) {
    const o = byId.get(id);
    if (!o) {
      unadjudicated.push(id);
      continue;
    }
    if (o.result === "deleted") deleted.push(id);
    else present.push(o);
  }
  const outcome =
    deleted.length === candidateIds.length && unadjudicated.length === 0
      ? "completed"
      : present.some((o) => o.result === "present_after_attempt") || deleted.length > 0
        ? "superseded_partial_delete"
        : "superseded_no_delete";
  return { outcome, deleted, present, unadjudicated };
}

// ─── A scratch directory for the restore-and-verify pass ─────────────────────

/** Run `fn` in a fresh temp directory and always remove it, even on refusal. */
export async function withScratchDir<T>(prefix: string, fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
