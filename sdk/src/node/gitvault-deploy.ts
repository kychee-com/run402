/**
 * gitvault — push-gated deploy (protocol rev 41 §6.5; task 5.6, lane supplied
 * by change `gitvault-deploy-lane`).
 *
 * Every deploy has a commit, and the artifacts it ships CORRESPOND to it:
 *   1. snapshot (§6.6) → the `gitvault_commit`, printed ALWAYS, never sent,
 *      plus a digest over the captured file set;
 *   2. a fresh `capture_id` before BOTH lanes;
 *   3. the deploy lane collects artifacts from the work tree and produces the
 *      canonical plan digest (`apply_plan_sha256`, null when the build fails
 *      before a plan exists) — concurrently, the push lane prepares the
 *      publication;
 *   4. the push's head carries `capture_binding {capture_id, apply_plan_sha256|null,
 *      snapshot_oid_hmac}` — capture-the-attempt survives a failed build; no
 *      token is mintable from a null digest;
 *   5. BEFORE any plan commits, the captured-set digest is RE-DERIVED. A
 *      difference is `SNAPSHOT_MOVED_DURING_DEPLOY`: the deploy stops, naming
 *      the changed paths, and commits nothing;
 *   6. with a digest and an admitted head, the capture receipt is exchanged
 *      for an activation token, and the apply commit is submitted ONLY with it;
 *   7. the outcome is one of the CLOSED five: `DEPLOYED_AND_VAULTED`,
 *      `DEPLOY_BLOCKED_PUSH_FAILED`, `DEPLOY_FAILED_VAULTED`,
 *      `DEPLOY_FAILED_UNVAULTED`, `DEPLOYED_UNVAULTED_OVERRIDE`.
 *
 * WHAT CORRESPONDENCE MEANS, AND WHAT IT DOES NOT. Step 5 establishes that the
 * captured source did NOT change while the artifacts were produced. It does
 * NOT establish that the artifacts are a reproducible function of that source:
 * nothing here ties a gitignored `dist/` to the `src/` it came from, and the
 * captured set deliberately excludes gitignored paths so a project with a
 * build step stays deployable. The stronger property — build inside an
 * isolated materialization, making artifacts a function of the snapshot — is a
 * recorded forward TODO, not a thing this module quietly delivers.
 *
 * REFUSE, NEVER REPAIR. On a detected move the deploy stops rather than
 * re-capturing: a second capture publishes a generation whose relationship to
 * the artifacts already collected is exactly what is in doubt, and a
 * capture→collect→capture loop churns generations. The caller re-runs.
 *
 * The push is never gated on deploy success. The unvaulted override
 * (`allow_unvaulted`) is journaled crash-safely BEFORE the commit with the
 * full §6.5 contents; any later invocation drains the journal by pushing the
 * journaled snapshot and presenting the capture receipt to the
 * override-completion route — equality on EVERY field or no clear.
 */

import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { LocalError, isRun402Error } from "../errors.js";
import { formatGitvaultTimestamp, hexToBytes, newHex32 } from "../namespaces/gitvault.crypto.js";
import type { GitvaultActivationToken, GitvaultCaptureBinding, GitvaultCaptureReceipt, GitvaultHeadTarget } from "../namespaces/gitvault.types.js";
import { GitvaultKeystore, readFileNoFollow, writeFileAtomic0600 } from "./gitvault-keystore.js";
import { GitvaultVault, captureBinding, deployRefTransaction, type GitvaultPublishResult } from "./gitvault-publication.js";
import { GITVAULT_DEPLOY_REF, capturedSetDigest, capturedSetUnchanged, captureSnapshot, deriveCapturedSet, diffCapturedSets, gitvaultCommitLine, snapshotCommitment, type GitvaultCapturedSetDrift, type GitvaultSnapshot, type GitvaultSnapshotOptions } from "./gitvault-snapshot.js";

// ─── Outcomes ────────────────────────────────────────────────────────────────

export const GITVAULT_DEPLOY_OUTCOMES = [
  "DEPLOYED_AND_VAULTED",
  "DEPLOY_BLOCKED_PUSH_FAILED",
  "DEPLOY_FAILED_VAULTED",
  "DEPLOY_FAILED_UNVAULTED",
  "DEPLOYED_UNVAULTED_OVERRIDE",
] as const;
export type GitvaultDeployOutcome = (typeof GITVAULT_DEPLOY_OUTCOMES)[number];

/** A serializable error summary (never plaintext, never presigned URLs). */
export interface GitvaultDeployError {
  code: string;
  message: string;
  retryable: boolean;
  details?: unknown;
}

export interface GitvaultDeployNextAction {
  action: string;
  /** Present when the action needs a capability the caller may lack. */
  requires?: string;
}

interface GitvaultDeployResultBase {
  outcome: GitvaultDeployOutcome;
  /** The snapshot commit — ALWAYS present; the `gitvault_commit` line is derived from it. */
  gitvault_commit: string;
  gitvault_commit_line: string;
  snapshot: GitvaultSnapshot;
  capture_id: string;
  snapshot_oid_hmac: string;
  /** The canonical plan digest — null when the build failed before a plan existed. */
  apply_plan_sha256: string | null;
  operation_id: string | null;
  next_actions: GitvaultDeployNextAction[];
}

export type GitvaultDeployResult =
  | (GitvaultDeployResultBase & { outcome: "DEPLOYED_AND_VAULTED"; generation: string; head_sha256: string; capture_receipt: GitvaultCaptureReceipt; activation_token: GitvaultActivationToken; commit: unknown })
  | (GitvaultDeployResultBase & { outcome: "DEPLOY_BLOCKED_PUSH_FAILED"; push_error: GitvaultDeployError; previous_release_keeps_serving: true })
  | (GitvaultDeployResultBase & { outcome: "DEPLOY_FAILED_VAULTED"; generation: string; head_sha256: string; capture_receipt: GitvaultCaptureReceipt | null; deploy_error: GitvaultDeployError })
  | (GitvaultDeployResultBase & { outcome: "DEPLOY_FAILED_UNVAULTED"; push_error: GitvaultDeployError; deploy_error: GitvaultDeployError })
  | (GitvaultDeployResultBase & { outcome: "DEPLOYED_UNVAULTED_OVERRIDE"; push_error: GitvaultDeployError; override_journal: GitvaultOverrideJournal; commit: unknown });

// ─── The deploy lane (injected; 5.10 wires `Run402.deploy`) ──────────────────

export interface GitvaultDeployLanePlanInput {
  /**
   * The work tree the snapshot was captured from — collect artifacts from
   * HERE. It is the mutable tree on purpose (a materialization of the snapshot
   * commit holds source and no build output, because build output is
   * gitignored). Correspondence is enforced by re-deriving the captured-set
   * digest before the plan commits, not by isolating this directory.
   */
  source_dir: string;
  capture_id: string;
  snapshot_oid_hmac: string;
}

export interface GitvaultDeployLanePlan {
  plan_id: string;
  /** The apply operation the token is minted for (the gateway creates it at plan time under the vault gate). */
  operation_id: string;
  /** The canonical `apply_plan_canonical/v1` digest (opaque 32-byte commitment, hex). */
  apply_plan_sha256: string;
}

export interface GitvaultDeployLaneCommitInput {
  plan_id: string;
  operation_id: string;
  /** Present on the vaulted path. */
  activation_token?: GitvaultActivationToken;
  /** Present on the override path — requires `gitvault.override_unvaulted` server-side. */
  allow_unvaulted?: { reason: string };
}

/** The apply-v1 plan → commit pair, abstracted so the deploy logic is testable without a gateway. */
export interface GitvaultDeployLane {
  plan(input: GitvaultDeployLanePlanInput): Promise<GitvaultDeployLanePlan>;
  commit(input: GitvaultDeployLaneCommitInput): Promise<unknown>;
}

// ─── Override journal ────────────────────────────────────────────────────────

export interface GitvaultOverrideJournal {
  version: 1;
  repo_id: string;
  operation_id: string;
  capture_id: string;
  apply_plan_sha256: string;
  snapshot: { ref: string; oid: string; head_target: GitvaultHeadTarget };
  snapshot_oid_hmac: string;
  /** `pending` → committed unvaulted, not yet pushed; `published` → pushed, completion not yet accepted; `completed` → advisory cleared server-side. */
  publication_state: "pending" | "published" | "completed";
  generation: string | null;
  head_sha256: string | null;
  capture_receipt: GitvaultCaptureReceipt | null;
  reason: string;
  created_at: string;
  updated_at: string;
}

export function overrideJournalDir(keystore: GitvaultKeystore): string {
  return join(keystore.journalDir, "overrides");
}

export function overrideJournalPath(keystore: GitvaultKeystore, operationId: string): string {
  if (!/^[A-Za-z0-9_.-]{1,128}$/.test(operationId)) throw new LocalError("operation_id is not a safe file name", "resolving override journal path", { code: "GITVAULT_BAD_ID" });
  return join(overrideJournalDir(keystore), `${operationId}.json`);
}

export function writeOverrideJournal(keystore: GitvaultKeystore, journal: GitvaultOverrideJournal): void {
  writeFileAtomic0600(overrideJournalPath(keystore, journal.operation_id), JSON.stringify(journal, null, 2));
  keystore.audit("journal_stage", journal.repo_id, { override_operation_id: journal.operation_id, publication_state: journal.publication_state });
}

export function readOverrideJournal(keystore: GitvaultKeystore, operationId: string): GitvaultOverrideJournal | null {
  const text = readFileNoFollow(overrideJournalPath(keystore, operationId));
  return text ? (JSON.parse(text) as GitvaultOverrideJournal) : null;
}

/** Every override journal not yet `completed` — the doctor-visible advisory list. */
export function listPendingOverrideJournals(keystore: GitvaultKeystore, repoId?: string): GitvaultOverrideJournal[] {
  const dir = overrideJournalDir(keystore);
  if (!existsSync(dir)) return [];
  const out: GitvaultOverrideJournal[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    const text = readFileNoFollow(join(dir, f));
    if (!text) continue;
    const j = JSON.parse(text) as GitvaultOverrideJournal;
    if (j.version !== 1 || j.publication_state === "completed") continue;
    if (repoId && j.repo_id !== repoId) continue;
    out.push(j);
  }
  return out;
}

// ─── Receipt ↔ journal equality (every field or no clear) ────────────────────

export interface GitvaultCaptureReceiptMatch {
  equal: boolean;
  mismatched_fields: string[];
}

/** Compare a capture receipt against an operation's journaled binding on EVERY field: repo, capture_id, plan digest, snapshot commitment, head hash. */
export function matchCaptureReceipt(receipt: GitvaultCaptureReceipt, expected: { repo_id: string; capture_id: string; apply_plan_sha256: string | null; snapshot_oid_hmac: string; head_sha256: string }): GitvaultCaptureReceiptMatch {
  const mismatched: string[] = [];
  if (receipt.repo_id !== expected.repo_id) mismatched.push("repo_id");
  if (receipt.capture_id !== expected.capture_id) mismatched.push("capture_id");
  if (receipt.apply_plan_sha256 !== expected.apply_plan_sha256) mismatched.push("apply_plan_sha256");
  if (receipt.snapshot_oid_hmac !== expected.snapshot_oid_hmac) mismatched.push("snapshot_oid_hmac");
  if (receipt.head_sha256 !== expected.head_sha256) mismatched.push("head_sha256");
  return { equal: mismatched.length === 0, mismatched_fields: mismatched };
}

/**
 * `authorization_epoch` is compared BYTEWISE against the epoch the client last
 * saw installed (a DR gate mints a fresh one). Any difference — one nibble is
 * enough — is `AUTHORIZATION_EPOCH_STALE`, never a retry under the old epoch.
 */
export function checkAuthorizationEpoch(tokenEpoch: string, installedEpoch: string): void {
  if (tokenEpoch === installedEpoch) return;
  throw new LocalError(
    `authorization_epoch ${tokenEpoch} is not the installed epoch ${installedEpoch}; the authorization was issued under a superseded epoch`,
    "checking authorization epoch",
    { code: "AUTHORIZATION_EPOCH_STALE", details: { token_authorization_epoch: tokenEpoch, installed_authorization_epoch: installedEpoch }, next_actions: [{ action: "re-request authorization under the current epoch (redeploy)" }] },
  );
}

/** Verify a minted activation token binds exactly this deploy (before it is ever presented to a commit). */
export function checkActivationTokenBinding(token: GitvaultActivationToken, expected: { repo_id: string; operation_id: string; generation: string; head_sha256: string; capture_id: string; apply_plan_sha256: string; snapshot_oid_hmac: string }): string[] {
  const problems: string[] = [];
  if (token.object_kind !== "activation_token" || !/^ct_[0-9a-f]{32}$/.test(token.object_id)) problems.push("object_id");
  for (const k of ["repo_id", "operation_id", "generation", "head_sha256", "capture_id", "apply_plan_sha256", "snapshot_oid_hmac"] as const) {
    if (token[k] !== expected[k]) problems.push(k);
  }
  if (!/^[0-9a-f]{32}$/.test(token.authorization_epoch)) problems.push("authorization_epoch");
  return problems;
}

// ─── The deploy ──────────────────────────────────────────────────────────────

export interface GitvaultDeployOptions {
  vault: GitvaultVault;
  lane: GitvaultDeployLane;
  /** The work tree to snapshot. */
  repo_dir: string;
  snapshot?: Omit<GitvaultSnapshotOptions, "dir">;
  /** The unvaulted override — requires `gitvault.override_unvaulted` server-side; refused otherwise. */
  allow_unvaulted?: { reason: string };
  /** Test/replay hook: pin the capture id. */
  capture_id?: string;
  now?: () => Date;
  /** Called with the `gitvault_commit` line as soon as the snapshot exists — the CLI prints it. */
  onCommitLine?: (line: string) => void;
}

function summarize(e: unknown): GitvaultDeployError {
  if (isRun402Error(e)) {
    const err = e as { code?: string; message: string; retryable?: boolean; details?: unknown };
    return { code: err.code ?? "UNKNOWN", message: err.message, retryable: Boolean(err.retryable), ...(err.details !== undefined ? { details: err.details } : {}) };
  }
  return { code: "UNKNOWN", message: e instanceof Error ? e.message : String(e), retryable: false };
}

function code(e: unknown): string | undefined {
  return isRun402Error(e) ? (e as { code?: string }).code : undefined;
}

/**
 * The correspondence refusal. CLIENT-LOCAL by decision (design open question,
 * resolved 2026-08-23): the moved tree is detected before any plan is
 * committed, so this code never crosses the wire and is deliberately absent
 * from the protocol's frozen §11 wire registry. The accepted cost is
 * discoverability — which is why it is named here, in the client's own error
 * surface, rather than left to be found by grep.
 */
export const SNAPSHOT_MOVED_DURING_DEPLOY = "SNAPSHOT_MOVED_DURING_DEPLOY";

/** What `SNAPSHOT_MOVED_DURING_DEPLOY` carries in `details`. */
export interface GitvaultSnapshotMovedDetails extends GitvaultCapturedSetDrift {
  gitvault_commit: string;
  capture_id: string;
  captured_digest: string;
  observed_digest: string;
  /** Present when the snapshot reached the vault before the tree moved. */
  generation?: string;
}

function driftSummary(drift: GitvaultCapturedSetDrift): string {
  const parts: string[] = [];
  const name = (label: string, paths: string[]): void => {
    if (paths.length === 0) return;
    const shown = paths.slice(0, 5).join(", ");
    parts.push(`${label} ${paths.length > 5 ? `${shown}, …and ${paths.length - 5} more` : shown}`);
  };
  name("modified", drift.modified);
  name("added", drift.added);
  name("removed", drift.removed);
  return parts.join("; ");
}

/**
 * Re-derive the captured-set digest and refuse if it moved. Called before ANY
 * plan commit — including the override path, and before its journal is written,
 * so a refusal never leaves an advisory for an operation that never committed.
 */
async function assertCapturedSetUnchanged(
  snapshot: GitvaultSnapshot,
  context: { capture_id: string; generation?: string },
): Promise<void> {
  const now = await deriveCapturedSet({ top_level: snapshot.top_level, global_excludes_path: snapshot.global_excludes_path });
  const drift = diffCapturedSets(snapshot.captured, now);
  if (capturedSetUnchanged(drift)) return;
  const details: GitvaultSnapshotMovedDetails = {
    ...drift,
    gitvault_commit: snapshot.oid,
    capture_id: context.capture_id,
    captured_digest: snapshot.captured_digest,
    observed_digest: capturedSetDigest(now),
    ...(context.generation !== undefined ? { generation: context.generation } : {}),
  };
  throw new LocalError(
    `the captured source changed between capture and commit (${driftSummary(drift)}); refusing to activate artifacts the vaulted snapshot ${snapshot.oid} does not describe`,
    "verifying snapshot correspondence",
    {
      code: SNAPSHOT_MOVED_DURING_DEPLOY,
      details,
      next_actions: [
        { action: "redeploy — the next run captures the tree as it is now" },
        { action: "if the change was not yours, inspect the named paths before redeploying" },
      ],
    },
  );
}

/**
 * Run the push-gated deploy. Throws ONLY for refusals that precede any lane
 * (snapshot refusals such as `SNAPSHOT_CONFLICTED_INDEX`, unsupported
 * repositories), for `SNAPSHOT_MOVED_DURING_DEPLOY` (the tree moved under the
 * capture; nothing is committed), and for `OVERRIDE_NOT_AUTHORIZED`; every
 * other path resolves to one of the five outcomes.
 */
export async function runGitvaultDeploy(options: GitvaultDeployOptions): Promise<GitvaultDeployResult> {
  const { vault, lane } = options;
  const now = options.now ?? (() => new Date());
  const repo = vault.repoFile();
  const kRepo = hexToBytes(repo.k_repo_hex);

  // 1. snapshot — refusals propagate; nothing has been sent anywhere.
  const snapshot = await captureSnapshot({ dir: options.repo_dir, ...(options.snapshot ?? {}) });
  const commitLine = gitvaultCommitLine(snapshot);
  options.onCommitLine?.(commitLine);
  // 2. fresh capture id before both lanes; the keyed snapshot commitment (the platform never sees the oid).
  const captureId = options.capture_id ?? newHex32();
  const snapshotOidHmac = snapshotCommitment(kRepo, vault.repoId, repo.epoch, snapshot.oid);
  const base = (fields: Partial<GitvaultDeployResultBase>): GitvaultDeployResultBase => ({
    outcome: "DEPLOY_FAILED_UNVAULTED", gitvault_commit: snapshot.oid, gitvault_commit_line: commitLine, snapshot, capture_id: captureId, snapshot_oid_hmac: snapshotOidHmac,
    apply_plan_sha256: null, operation_id: null, next_actions: [], ...fields,
  });

  // 3. the deploy lane collects artifacts from the work tree; step 5 below
  //    verifies the captured set did not move while it did so.
  let plan: GitvaultDeployLanePlan | null = null;
  let planError: unknown = null;
  const planPromise = (async () => {
    try { plan = await lane.plan({ source_dir: snapshot.top_level, capture_id: captureId, snapshot_oid_hmac: snapshotOidHmac }); }
    catch (e) { planError = e; }
  })();

  // 4. push lane — concurrently; the head's binding is resolved at sign time from whatever the plan lane produced.
  let published: GitvaultPublishResult | null = null;
  let pushError: unknown = null;
  const pushPromise = (async () => {
    try {
      const current = await vault.materialize();
      published = await vault.push({
        transaction: deployRefTransaction(current.refs, snapshot.oid),
        head_target: snapshot.head,
        protocol_refs: "allow",
        capture_binding: async (): Promise<GitvaultCaptureBinding> => {
          await planPromise; // the digest (or its absence) must be known before the head is signed
          return captureBinding(captureId, plan ? (plan as GitvaultDeployLanePlan).apply_plan_sha256 : null, snapshotOidHmac);
        },
      });
    } catch (e) { pushError = e; }
  })();
  await Promise.all([planPromise, pushPromise]);

  const planned = plan as GitvaultDeployLanePlan | null;
  const pub = published as GitvaultPublishResult | null;
  const common = base({ apply_plan_sha256: planned?.apply_plan_sha256 ?? null, operation_id: planned?.operation_id ?? null });

  // 5. outcomes
  if (!pub) {
    const push_error = summarize(pushError);
    if (!planned) {
      return { ...common, outcome: "DEPLOY_FAILED_UNVAULTED", push_error, deploy_error: summarize(planError), next_actions: [{ action: "fix the build, then redeploy" }, { action: "retry the push (run402 gitvault snapshot)" }] };
    }
    if (options.allow_unvaulted) {
      // Correspondence is checked BEFORE the journal is written: an override
      // still activates artifacts, and a refusal must not leave an advisory
      // for an operation that never committed.
      await assertCapturedSetUnchanged(snapshot, { capture_id: captureId });
      // journal BEFORE the commit so a crash leaves the advisory + the exact snapshot to resume
      const journal: GitvaultOverrideJournal = {
        version: 1, repo_id: vault.repoId, operation_id: planned.operation_id, capture_id: captureId, apply_plan_sha256: planned.apply_plan_sha256,
        snapshot: { ref: GITVAULT_DEPLOY_REF, oid: snapshot.oid, head_target: snapshot.head }, snapshot_oid_hmac: snapshotOidHmac,
        publication_state: "pending", generation: null, head_sha256: null, capture_receipt: null, reason: options.allow_unvaulted.reason,
        created_at: formatGitvaultTimestamp(now()), updated_at: formatGitvaultTimestamp(now()),
      };
      writeOverrideJournal(vault.keystore, journal);
      let commit: unknown;
      try {
        commit = await lane.commit({ plan_id: planned.plan_id, operation_id: planned.operation_id, allow_unvaulted: options.allow_unvaulted });
      } catch (e) {
        if (code(e) === "OVERRIDE_NOT_AUTHORIZED") {
          rmSync(overrideJournalPath(vault.keystore, planned.operation_id), { force: true }); // nothing activated; no advisory to drain
          throw e;
        }
        return { ...common, outcome: "DEPLOY_FAILED_UNVAULTED", push_error, deploy_error: summarize(e), next_actions: [{ action: "retry the push (run402 gitvault snapshot) — the override journal is kept and will drain" }, { action: "retry the deploy" }] };
      }
      return { ...common, outcome: "DEPLOYED_UNVAULTED_OVERRIDE", push_error, override_journal: journal, commit, next_actions: [{ action: "run any run402 CLI command later: the override journal drains by pushing this exact snapshot and presenting its capture receipt for completion" }] };
    }
    return {
      ...common, outcome: "DEPLOY_BLOCKED_PUSH_FAILED", push_error, previous_release_keeps_serving: true,
      next_actions: [
        { action: "retry the deploy (the vault push is retried; the previous release keeps serving)" },
        { action: "deploy with allow_unvaulted to activate without a vaulted capture (journaled, completed later)", requires: "gitvault.override_unvaulted" },
      ],
    };
  }

  const vaulted = { generation: pub.generation, head_sha256: pub.head_sha256, capture_receipt: pub.capture_receipt };
  if (!planned) {
    return { ...common, outcome: "DEPLOY_FAILED_VAULTED", ...vaulted, deploy_error: summarize(planError), next_actions: [{ action: "fix the build, then redeploy (the attempted tree is in the vault at generation " + pub.generation + ")" }] };
  }
  if (!pub.capture_receipt) {
    return { ...common, outcome: "DEPLOY_FAILED_VAULTED", ...vaulted, deploy_error: { code: "GITVAULT_CAPTURE_RECEIPT_MISSING", message: "admission returned no capture receipt for a head carrying a capture binding; no activation token can be exchanged", retryable: true }, next_actions: [{ action: "retry the deploy" }] };
  }
  // Correspondence, before the token is even minted: an unspent token is
  // harmless, but refusing after the mint would leave one bound to a deploy
  // that can never legitimately present it.
  await assertCapturedSetUnchanged(snapshot, { capture_id: captureId, generation: pub.generation });
  let token: GitvaultActivationToken;
  try {
    token = await vault.transport.exchangeActivationToken({ repo_id: vault.repoId, operation_id: planned.operation_id, capture_receipt: pub.capture_receipt });
    const problems = checkActivationTokenBinding(token, { repo_id: vault.repoId, operation_id: planned.operation_id, generation: pub.generation, head_sha256: pub.head_sha256, capture_id: captureId, apply_plan_sha256: planned.apply_plan_sha256, snapshot_oid_hmac: snapshotOidHmac });
    if (problems.length > 0) throw new LocalError(`the minted activation token does not bind this deploy (${problems.join(", ")}); refusing to present it`, "checking activation token", { code: "GITVAULT_TOKEN_BINDING_MISMATCH", details: { problems } });
    // the mint validates the receipt's epoch against the installed one, so a minted token's epoch
    // must equal the receipt's — a difference means the epoch moved under us.
    checkAuthorizationEpoch(token.authorization_epoch, pub.capture_receipt.authorization_epoch);
  } catch (e) {
    return { ...common, outcome: "DEPLOY_FAILED_VAULTED", ...vaulted, deploy_error: summarize(e), next_actions: [{ action: code(e) === "AUTHORIZATION_EPOCH_STALE" ? "re-request authorization under the current epoch (redeploy)" : "retry the deploy" }] };
  }
  let commit: unknown;
  try {
    commit = await lane.commit({ plan_id: planned.plan_id, operation_id: planned.operation_id, activation_token: token });
  } catch (e) {
    return { ...common, outcome: "DEPLOY_FAILED_VAULTED", ...vaulted, deploy_error: summarize(e), next_actions: [{ action: "inspect the apply operation, fix, redeploy (the attempted tree is vaulted)" }] };
  }
  return { ...common, outcome: "DEPLOYED_AND_VAULTED", ...vaulted, capture_receipt: pub.capture_receipt, activation_token: token, commit, next_actions: [] };
}

// ─── Draining override journals ──────────────────────────────────────────────

export interface GitvaultOverrideDrainReport {
  completed: GitvaultOverrideJournal[];
  /** Still pending, with the reason the drain could not complete them this time. */
  remaining: Array<{ journal: GitvaultOverrideJournal; error: GitvaultDeployError }>;
}

/**
 * Drain every pending override journal for this vault: push the journaled
 * snapshot (same capture binding), verify the receipt against EVERY journaled
 * field + the read-back head hash, present it for completion. Partial matches
 * never clear; the advisory persists until equality.
 */
export async function drainOverrideJournals(vault: GitvaultVault, options: { now?: () => Date } = {}): Promise<GitvaultOverrideDrainReport> {
  const now = options.now ?? (() => new Date());
  const report: GitvaultOverrideDrainReport = { completed: [], remaining: [] };
  for (const journal of listPendingOverrideJournals(vault.keystore, vault.repoId)) {
    try {
      let j = journal;
      if (j.publication_state === "pending") {
        const current = await vault.materialize();
        const pub = await vault.push({
          transaction: deployRefTransaction(current.refs, j.snapshot.oid),
          head_target: j.snapshot.head_target,
          protocol_refs: "allow",
          capture_binding: captureBinding(j.capture_id, j.apply_plan_sha256, j.snapshot_oid_hmac),
        });
        j = { ...j, publication_state: "published", generation: pub.generation, head_sha256: pub.head_sha256, capture_receipt: pub.capture_receipt, updated_at: formatGitvaultTimestamp(now()) };
        writeOverrideJournal(vault.keystore, j);
      }
      if (!j.capture_receipt || !j.head_sha256) throw new LocalError("the journaled publication has no capture receipt to present", "draining override journal", { code: "GITVAULT_CAPTURE_RECEIPT_MISSING" });
      const match = matchCaptureReceipt(j.capture_receipt, { repo_id: j.repo_id, capture_id: j.capture_id, apply_plan_sha256: j.apply_plan_sha256, snapshot_oid_hmac: j.snapshot_oid_hmac, head_sha256: j.head_sha256 });
      if (!match.equal) throw new LocalError(`the capture receipt does not match the journaled operation on ${match.mismatched_fields.join(", ")}; the advisory persists`, "draining override journal", { code: "GITVAULT_OVERRIDE_COMPLETION_MISMATCH", details: match });
      const res = await vault.transport.submitOverrideCompletion({ repo_id: j.repo_id, operation_id: j.operation_id, capture_receipt: j.capture_receipt });
      if (!res.cleared) throw new LocalError("the platform did not clear the override advisory", "draining override journal", { code: "GITVAULT_OVERRIDE_COMPLETION_REFUSED" });
      j = { ...j, publication_state: "completed", updated_at: formatGitvaultTimestamp(now()) };
      writeOverrideJournal(vault.keystore, j);
      report.completed.push(j);
    } catch (e) {
      report.remaining.push({ journal, error: summarize(e) });
    }
  }
  return report;
}
