/**
 * `r.gitvault` — the host-blind encrypted Git remote, as the SDK's programmatic
 * API (add-gitvault task 5.10).
 *
 * ARCHITECTURAL LAW (client-surface spec, "All protocol logic lives in the
 * SDK"): every piece of vault protocol behaviour — crypto core, keystore,
 * creation journal, snapshot + capture, publication state machines, ref
 * transactions, verification budget, token exchange, repair — is implemented
 * ONCE here. `run402 gitvault …`, `git-remote-run402`, and the MCP tools are
 * adapters over this namespace: argument parsing, TTY output, exit codes, and
 * local file I/O only. Anything the CLI can do is reachable programmatically
 * with identical semantics.
 *
 * `r402s-verify` is the deliberate exception: an independent second lineage
 * that must NOT share implementation code with this namespace, because
 * differential verification is its entire purpose.
 *
 * ISOMORPHIC / NODE SPLIT. Vault reads (the record, heads listing, policy,
 * override completion) need nothing but the HTTP client and run anywhere. The
 * verbs that touch a git working tree or the on-disk keystore — `init`,
 * `push`, `compact`, `verify`, `deploy`, `restore` — are Node-only and are
 * reached through DYNAMIC imports of `../node/*`, so importing `@run402/sdk`
 * in a browser or worker never pulls `node:fs` into the graph.
 *
 * CACHING. Nothing here is memoised. Two of these responses are
 * secret-bearing — the maintenance lease's `holder_token` (returned exactly
 * once) and anything derived from the keystore — and per
 * docs/agent-response-design.md a secret-bearing response is never cached,
 * never persisted into an agent-surface result store, and never logged.
 */

import type { Client } from "../kernel.js";
import { LocalError, isRun402Error , isNetworkError } from "../errors.js";
import {
  GITVAULT_BYO_NO_PAYLOAD_COPY_STATEMENT,
  GITVAULT_BYO_UNMIRRORED_REMEDY_STATEMENT,
  GITVAULT_DEGRADED_READ_STATEMENT,
  GITVAULT_DURABILITY_STATEMENT,
  GITVAULT_MIRROR_KEYSTORE_STILL_REQUIRED_STATEMENT,
  GITVAULT_MIRROR_VALIDITY_NOT_FRESHNESS_STATEMENT,
  GITVAULT_TERMINAL_LOSS_DOCTOR_TEXT,
  GITVAULT_TERMINAL_LOSS_STATEMENT,
  GITVAULT_UNMIRRORED_FINDING_STATEMENT,
  bytesToHex,
  computeKeystorePossessionProof,
  computeSigningKeyPossessionSignature,
  ed25519PublicKey,
  fromBase64url,
  hexToBytes,
  jcs,
  parseGitvaultStrict,
  randomBytes,
  sha256Hex,
  verifyGitvaultObject,
  toBase64url,
} from "./gitvault.crypto.js";
import type { NextAction } from "../errors.js";

/**
 * gitvault-agent-envelopes — per-process memo for the session-start
 * fulfilment (`<keystore root>|<repo_id>`) and the enroll-if-absent step
 * (`<keystore root>`), so a process that opens the same vault many times
 * (a `git push` runs several verbs) reconciles and enrolls once.
 */
const SESSION_RECONCILED = new Set<string>();

/**
 * Round 3 blocker 2: integrity verdicts must PROPAGATE through every
 * best-effort reconcile boundary — converting tampering evidence into
 * `skipped_error` at the outer catch is exactly the swallow the inner
 * verifier exists to prevent. Availability and local-policy failures stay
 * best-effort.
 */
const RECONCILE_FATAL_CODES = new Set([
  "GITVAULT_ENVELOPE_ALTERED",
  "GITVAULT_SIGNATURE_INVALID",
  "VAULT_CREATION_CONFLICT",
]);

function rethrowFatalReconcile(e: unknown): void {
  if (isRun402Error(e) && RECONCILE_FATAL_CODES.has(String((e as { code?: string }).code))) throw e;
}
/** The cold open's own verdicts — surfaced from `open()`; anything else leaves the handle lazy (see `open`). */
import type { GitvaultCaptureReceipt, GitvaultHeadsListingPage, GitvaultHeadsListingRequest, GitvaultHeadTarget, GitvaultOpenReceipt, GitvaultRecipientConfirmationReceipt, GitvaultRecoveryReceipt, GitvaultRotationReason } from "./gitvault.types.js";
import type {
  GitvaultCompactionGrant,
  GitvaultEnvelopeRecipientsResponse,
  GitvaultMaintenanceLease,
  GitvaultMaintenanceLeaseRequest,
  GitvaultTransport,
  GitvaultVaultRecord,
} from "../node/gitvault-publication.js";
import type { GitvaultDeployOptions, GitvaultDeployResult } from "../node/gitvault-deploy.js";
import type { GitvaultPublishResult, GitvaultPushOptions, GitvaultRefMap, GitvaultReconcileEnvelopeRecipientsResult, GitvaultReconcileWriterAdmissionsResult, GitvaultVerifiedState } from "../node/gitvault-publication.js";
import type { GitvaultCreationResult } from "../node/gitvault-creation-journal.js";
import type { GitvaultKeystore } from "../node/gitvault-keystore.js";
import type { GitvaultSnapshot } from "../node/gitvault-snapshot.js";
import type { GitvaultMirrorConfig, GitvaultMirrorCredential, GitvaultMirrorDestination } from "../node/gitvault-mirror-config.js";
import type { GitvaultByoMissingObject, GitvaultByoPresenceReport, GitvaultMirrorPushResult, GitvaultMirrorSyncSummary } from "../node/gitvault-mirror.js";
import type { GitvaultRecoverResult, GitvaultVerifyReport } from "../node/gitvault-recover.js";
import type { GitvaultMemberRecoveryBundle } from "../node/gitvault-member-bundle.js";
import type { GitvaultDegradedReadLive, GitvaultDegradedReadOutcome, GitvaultDegradedReadSource } from "../node/gitvault-degraded-read.js";

// The Node modules are loaded lazily and only ever through these helpers, so
// the isomorphic entry point stays free of `node:` imports.
type PublicationModule = typeof import("../node/gitvault-publication.js");
type DeployModule = typeof import("../node/gitvault-deploy.js");
type KeystoreModule = typeof import("../node/gitvault-keystore.js");
type CreationModule = typeof import("../node/gitvault-creation-journal.js");
type SnapshotModule = typeof import("../node/gitvault-snapshot.js");
type PruneModule = typeof import("../node/gitvault-prune.js");
type OpenOrCreateModule = typeof import("../node/gitvault-open-or-create.js");
type AddressModule = typeof import("../node/gitvault-address.js");
type MirrorModule = typeof import("../node/gitvault-mirror.js");
type MirrorConfigModule = typeof import("../node/gitvault-mirror-config.js");
type MirrorBackendModule = typeof import("../node/gitvault-mirror-backend.js");
type RecoverModule = typeof import("../node/gitvault-recover.js");
type DegradedReadModule = typeof import("../node/gitvault-degraded-read.js");
type ByoConfigModule = typeof import("../node/gitvault-byo-config.js");
type ByoProbeModule = typeof import("../node/gitvault-byo-probe.js");
type HandoffModule = typeof import("../node/gitvault-handoff.js");
type RestoreModule = typeof import("../node/gitvault-restore.js");
type WriterStateModule = typeof import("../node/gitvault-writer-state.js");

/** A keystore path, or `null` when there is no id to derive it from (or it is malformed). */
function safePath(derive: () => string, repoId: string | null): string | null {
  if (!repoId) return null;
  try {
    return derive();
  } catch {
    return null;
  }
}

async function nodeOnly<T>(load: () => Promise<T>, verb: string): Promise<T> {
  try {
    return await load();
  } catch (e) {
    throw new LocalError(
      `\`r.gitvault.${verb}\` needs the Node runtime (keystore + git); import it from a Node process, or use the read-only vault methods in a browser.`,
      `running gitvault ${verb}`,
      { code: "GITVAULT_NODE_ONLY", details: { cause: e instanceof Error ? e.message : String(e) } },
    );
  }
}

/** Byte counts in the refusal text read as MiB — the unit an operator's tier is quoted in. */
function mib(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

/**
 * A client-generated handoff id (RFC 4122 v4), minted BEFORE the mint call
 * (kygit-handoff design D3): `auth_secret`/`wrap_key` derive off it, so it
 * cannot be gateway-assigned the way `internal.gitvault_claims.id` alone
 * would suggest — this SDK supplies it, mirroring the SAME
 * client_creation_id/client_open_id convention this protocol family
 * already uses elsewhere for idempotent creation. `handoff()` refuses if
 * the gateway's minted `handoff_id` disagrees.
 */
function randomHandoffUuid(): string {
  const b = randomBytes(16);
  b[6] = ((b[6] ?? 0) & 0x0f) | 0x40;
  b[8] = ((b[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytesToHex(b);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// ─── Public result shapes (snake_case on the wire, per docs/style.md) ─────────

/** What `r.gitvault.status()` reports. Never carries key material. */
export interface GitvaultStatus {
  repo_id: string | null;
  project_id: string | null;
  /** The control plane's view. `null` when no vault is allocated for the project. */
  vault: GitvaultVaultRecord | null;
  /** gitvault-agent-envelopes D5: what this KEY-HOLDER's session-start fulfilment did (`null` on a machine that holds no K_repo, or `reconcile: "forbidden"`). */
  reconcile_recipients?: GitvaultSessionReconcileResult | null;
  /** gitvault-agent-envelopes D3: what the enroll-if-absent step did for this keystore's key (`null` when it did not run). */
  enrollment?: GitvaultEnrollmentOutcome | null;
  keystore: {
    present: boolean;
    /** The principal's Ed25519 signing fingerprint, or `null` when identity is absent. */
    identity_fingerprint: string | null;
    /** `false` ⇒ read-only: this principal can decrypt and verify but cannot sign a head. */
    can_sign: boolean;
    /** `true` once this machine holds K_repo for the vault. */
    holds_repo_key: boolean;
    /**
     * WHERE the keystore lives, and what is in it.
     *
     * Terminal loss is stated three times in this surface; until 5.13 the path
     * to back up was stated nowhere, which made the warning unactionable. These
     * are file paths, never contents — nothing here is key material.
     * `repo` / `recovery_receipt` are `null` until a `repo_id` is known.
     */
    root: string;
    paths: {
      identity: string;
      repos: string;
      receipts: string;
      journal: string;
      audit_log: string;
      repo: string | null;
      recovery_receipt: string | null;
    };
  };
  /**
   * The `run402` git remote in the local repository, when there is one to read.
   * `null` when no `repo_dir` was given, the directory is not a repository, or
   * no such remote is configured.
   *
   * `matches` is a TRI-STATE. For an ID-FORM remote
   * (`run402::<org_id>/<project_id>`) it is `true`/`false` from the URL text
   * alone — the second half is a real project id, so comparing it against
   * this status's own project needs no lookup. For a SLUG-FORM remote
   * (`run402::<org-slug>/<name>`) the URL's second half is a repo NAME, not
   * a project id — comparing it as if it were one made a CORRECTLY
   * configured slug-form remote always report `matches: false` (the bug).
   * Instead it is compared against the local id-pin (`git config
   * r402.repoId`, task 4.5): pin present + equal → `true`; pin present +
   * different → `false`; no pin yet → `null` with `reason` explaining why
   * (no network read — `status` stays a pure observation). Render NO
   * mismatch warning for the `null` case anywhere — it is not evidence of
   * anything wrong, only of "not yet resolved on this machine".
   */
  remote: { name: string; url: string; matches: boolean | null; reason: string | null } | null;
  /**
   * The id-pinning state of this checkout — `null`
   * when no `repo_dir` was given, or nothing is pinned there yet. A SLUG-form
   * remote pins `repo_id` in local git state the first time it resolves;
   * `resolved_from` names the `org-slug/name` it was resolved from. An
   * id-form remote never pins (it needs no pin — see
   * `resolveGitvaultAddress`'s doc comment), so a checkout on one always
   * reports `null` here even once its vault is otherwise fully resolved.
   */
  pinned: { repo_id: string; resolved_from: { org_slug: string; repo_name: string } | null } | null;
  /**
   * The vault's ref map and HEAD target — present only when `refs: true` was
   * requested. Reading them means MATERIALIZING the chain, which is a
   * verification and advances the local materialized pin, so plain `status`
   * (an observation) leaves both `null`.
   */
  refs: Record<string, string> | null;
  head_target: GitvaultHeadTarget | null;
  pins: {
    highest_authenticated: string | null;
    highest_materialized: string | null;
  };
  gitvault_policy: "required" | "grandfathered" | null;
  /** Override journals on this machine that have not yet been completed. */
  pending_overrides: number;
  /**
   * Best-effort count of this vault's covering `key_envelope` recipients (the
   * same envelope-recipients read `Gitvault.access` uses), taken inside
   * `status()` when a vault is allocated. `null` when unknown — no vault, or
   * the read failed (never a new failure mode for `status`; falls back to the
   * single-principal V0-A statements below). This is what decides between
   * `terminal_loss_statement` and `durability_statement`: the V0-A terminal-loss
   * claim is specifically a single-principal claim, and is factually false to
   * print for a vault this client can locally prove has >= 2 recipients.
   */
  covering_recipients: number | null;
  /**
   * Stated verbatim per the client-surface spec — this sentence is normative
   * copy, not a summary, and is printed by `status` and `doctor` alike.
   * `null` exactly when `covering_recipients >= 2` — see `durability_statement`
   * for what is printed in that case instead.
   */
  terminal_loss_statement: typeof GITVAULT_TERMINAL_LOSS_STATEMENT | null;
  /** `null` exactly when `terminal_loss_statement` is — same condition, same reasoning. */
  terminal_loss_detail: typeof GITVAULT_TERMINAL_LOSS_DOCTOR_TEXT | null;
  /**
   * The protocol's durability sentence — printed in place of
   * `terminal_loss_statement` exactly when `covering_recipients >= 2`, since
   * the terminal-loss claim is false for a vault this client has locally
   * proven has a second covering recipient. `null` otherwise (including
   * "unknown" — the single-principal statements are the honest default).
   */
  durability_statement: typeof GITVAULT_DURABILITY_STATEMENT | null;
  warnings: { kind: string; message: string }[];
  next_actions: { action: string; command?: string }[];
}

/**
 * What {@link Gitvault.scaffoldRemote} did, and why (D1). `name` is `origin`
 * when it was free (or a caller-supplied name), `run402` when `origin` was
 * already taken by something else, or the caller's explicit `remote_name`.
 * `reason` is a human-readable sentence naming exactly what happened —
 * printed to stderr by every CLI caller, never synthesized twice.
 */
export interface GitvaultScaffoldRemoteResult {
  name: string;
  url: string;
  created_repository: boolean;
  already_present: boolean;
  existing_url: string | null;
  reason: string;
}

export interface GitvaultInitResult {
  repo_id: string;
  project_id: string;
  /** Emitted once at creation — integrity data, not a secret. Print it, copy it, keep many copies. */
  recovery_receipt: GitvaultCreationResult["recovery_receipt"];
  genesis_sha256: string;
  /** The git remote that was added, when a working tree was scaffolded. */
  remote: GitvaultScaffoldRemoteResult | null;
  deduplicated: boolean;
  terminal_loss_statement: typeof GITVAULT_TERMINAL_LOSS_STATEMENT;
  /**
   * gitvault-byo-primary-bucket task 3.1/3.5 — the AUTHORITATIVE profile
   * (read back from the vault record, never assumed from what `init`'s
   * `byo` option requested). `"managed"` when `byo` was omitted, OR when it
   * was requested but this project's vault already existed as a managed
   * one under a different creation attempt.
   */
  storage_profile: "managed" | "byo";
  byo_destination: string | null;
}

export interface GitvaultCompactResult {
  generation: string;
  head_sha256: string;
  form: "wal" | "checkpoint";
  /** Set when a maintenance lease was taken and released around the checkpoint. */
  maintenance_lease_id: string | null;
  /** `false` when no `retention_cutoff` ticket could be obtained — roots are RETAINED (expiry is permissive). */
  cutoff_bound: boolean;
  covered_refs: number;
  covered_roots: number;
  /**
   * What the transient-storage preflight saw
   * (gitvault-compaction-headroom-preflight). `null` when the preflight could
   * not be answered — see {@link GitvaultCompactHeadroom} for why an
   * unanswerable check never blocks maintenance.
   */
  headroom: GitvaultCompactHeadroom | null;
}

/**
 * Compaction's transient pooled-storage arithmetic.
 *
 * Compaction publishes a checkpoint pack roughly the size of the vault's live
 * content while every superseded object stays stored until prune completes —
 * a transient footprint of roughly TWICE `source_bytes`, counted against the
 * ORG's pooled tier storage. Saying nothing about this leaves an org near
 * its cap paying the full encrypt+upload cost and then taking a mid-flight
 * quota refusal that names a quota rather than the mechanism.
 *
 * This is advisory-grade by construction: it can only refuse EARLIER and more
 * legibly than the platform's own storage-quota enforcement, never admit
 * something that enforcement would refuse.
 */
export interface GitvaultCompactHeadroom {
  /** Pooled storage the org is already using, across every project it owns. */
  pool_used_bytes: number;
  /** The org's plain, unraised pooled tier storage limit — always the tier's own figure, never the grant-raised one, so a disclosed "used of X pooled" never implies the tier itself grew. */
  pool_limit_bytes: number;
  /** The vault's billed `source_bytes` — the checkpoint-size proxy (design D1). */
  vault_source_bytes: number;
  /** `pool_used_bytes + vault_source_bytes`. */
  projected_transient_bytes: number;
  /** `false` when the projection exceeds the EFFECTIVE limit (`effective_pool_limit_bytes` when a grant is active, else `pool_limit_bytes`). */
  ok: boolean;
  /** `true` when the caller passed the override and a `false` `ok` was proceeded past anyway. */
  overridden: boolean;
  /**
   * gitvault-checkpoint-cadence design D3: `pool_limit_bytes` PLUS an active
   * compaction grant's `granted_bytes`, when one is active for this cycle —
   * the limit `ok`/`projected_transient_bytes` are actually computed
   * against. Equal to `pool_limit_bytes` (and omittable) when no grant is
   * active.
   */
  effective_pool_limit_bytes?: number;
  /** The grant this compaction opened for itself, when one was opened and is still tracked at disclosure time — `null`/absent otherwise (no grant, an older gateway, or one already closed). */
  compaction_grant?: { granted_bytes: number; expires_at: string } | null;
}

/**
 * `run402 gitvault snapshot --dry-run`'s report shape
 * — {@link Gitvault.planPush}'s return type. Every sizing field is `null`,
 * and `refs`/`objects` are empty, exactly when `allocation_needed` is `true`
 * — see that method's doc comment for why sizing is genuinely UNKNOWABLE
 * (not merely unreported) before the vault's encryption key exists.
 */
export interface GitvaultSnapshotPushPlan {
  /** `true` when this project has no vault yet — a real push/snapshot would allocate one first (push-to-create). This dry run never does. */
  allocation_needed: boolean;
  base_generation: string | null;
  would_admit_generation: string | null;
  /** `would_admit_generation` as a plain decimal string. */
  would_admit_generation_decimal: string | null;
  form: "wal" | "checkpoint" | null;
  refs: GitvaultRefMap;
  head_target: GitvaultHeadTarget | null;
  /** Every object that would be uploaded, with REAL sealed (encrypted) sizes. Empty when `allocation_needed`. */
  objects: Array<{ object_kind: string; size_bytes: string }>;
  object_count: number | null;
  /** Sum of `objects[].size_bytes` — the REAL ciphertext byte count. */
  encrypted_bytes: string | null;
  /** Sum of the plaintext pack bytes before sealing. */
  raw_bytes: string | null;
  /** The local capture this dry run computed — real, regardless of `allocation_needed`: capturing the work tree touches no network. */
  snapshot: GitvaultSnapshot;
  gitvault_commit: string;
  gitvault_commit_line: string;
}

/** One retention ROOT (a dropped ref tip) and whether its 90-day window has closed. */
export interface GitvaultPruneCandidate {
  ref: string;
  oid: string;
  dropped_at_generation: string;
  eligible: boolean;
  reason: string;
}

/** One STORED OBJECT the plan proposes deleting — what a `prune_intent`'s `delete_set` actually names. */
export interface GitvaultPruneObjectCandidate {
  object_id: string;
  object_kind: string;
  size_bytes: string;
}

export interface GitvaultPruneResult {
  /** Retention ROOTS and their windows — the retention view, unchanged. */
  candidates: GitvaultPruneCandidate[];
  eligible_count: number;
  retained_count: number;
  /**
   * The stored objects the plan proposes deleting, in the intent's canonical
   * order. A PROPOSAL: the gateway re-checks every candidate against the bound
   * `retention_cutoff` ticket and its own admission times, and refuses any that
   * is not retention-eligible. A client cannot prove either fact.
   */
  object_candidates: GitvaultPruneObjectCandidate[];
  /** Pruneable objects left out by the 10 000-per-intent cap; chunk into a later intent. */
  deferred_object_count: number;
  /** Why nothing may be pruned yet, or `null` when a submission is structurally possible. */
  blocked_reason: string | null;
  /**
   * The SIGNED `prune_intent_core` this plan proposes, and its stored-bytes
   * hash — what BOTH verifier receipts must sign. `null` when blocked.
   *
   * Round-trip this object verbatim into `submit`: it carries a random nonce
   * and object id, so a rebuilt core is a DIFFERENT core and the receipt
   * `r402s-verify` produced would no longer bind to it.
   */
  intent_core: import("../node/gitvault-prune.js").GitvaultPruneIntentCore | null;
  intent_core_sha256: string | null;
  /** What this SDK observed while restoring the latest checkpoint — the receipt's evidence. */
  attestation: import("../node/gitvault-publication.js").GitvaultStoredCheckpointAttestation | null;
  /** `true` only when an intent was accepted by the gateway. */
  submitted: boolean;
  /** The gateway's view of the submitted intent; `null` when nothing was submitted. */
  intent: import("../node/gitvault-prune.js").GitvaultPruneIntentRecord | null;
  /**
   * What the control-plane-signed completion CONFIRMS. `deleted` is the only
   * result that means the bytes are gone: `present_after_attempt` is a failed
   * deletion, not a successful one.
   */
  confirmation: import("../node/gitvault-prune.js").GitvaultPruneConfirmation | null;
  note: string;
}

/** Options shared by every Node-only verb. */
export interface GitvaultVaultHandleOptions {
  /** The vault to act on. Resolved from `project_id` when omitted. */
  repo_id?: string;
  /** Resolve `repo_id` from the project (the cold-restart entry point). */
  project_id?: string;
  /**
   * gitvault-agent-envelopes D5 — the session-start envelope fulfilment a
   * KEY-HOLDING client runs on its first ordinary gitvault operation in a
   * process (read verbs included), so a pending member is covered the next
   * time ANY key-holder does anything. `"auto"` (default): run once per
   * process per vault, best-effort, reported on the handle. `"deferred"`
   * (`--no-reconcile`): skip, report `deferred_by_local_policy` with the
   * pending count — never pretends coverage. `"forbidden"`: forensic and
   * offline operations (`fsck`, `--no-write`, `recover`) — investigating a
   * suspicious pending recipient must not complete the disclosure.
   */
  reconcile?: "auto" | "deferred" | "forbidden";
  /** The local git working tree. Defaults to `process.cwd()`. */
  repo_dir?: string;
  /** Keystore root override (defaults to `~/.config/run402/gitvault`; `~/.config/run402/profiles/<wallet>/gitvault` under a named wallet). */
  keystore_root?: string;
  /** Pinned service public key for control-plane signature checks (cutoff tickets). */
  service_public_key?: Uint8Array | string;
  /** Heads verified per call; the verified prefix persists, so a budget-exceeded client resumes. */
  verification_budget?: number;
}

/** An opened vault plus the pieces the caller may want to keep using. */
export interface GitvaultHandle {
  repo_id: string;
  keystore: GitvaultKeystore;
  transport: GitvaultTransport;
  /** The full protocol object — every verb below is built on it. */
  vault: import("../node/gitvault-publication.js").GitvaultVault;
  /**
   * gitvault-agent-envelopes D4: non-null when this open restored the repo
   * file from the keystore's OWN envelope (a cold keystore joining a vault it
   * is a recipient of). Carries the honest trust tier — `platform_attested`
   * is not end-to-end authentication.
   */
  restored: import("../node/gitvault-publication.js").GitvaultColdOpenResult | null;
  /**
   * gitvault-agent-envelopes D5: the session-start fulfilment outcome for a
   * key-holding client (`null` when this open did not run one — a restored
   * keystore has nothing to wrap yet, `reconcile: "forbidden"`, or a later
   * open in the same process). Reported beside the verb's own result, never
   * folded into it.
   */
  reconcile_recipients: GitvaultSessionReconcileResult | null;
  /**
   * gitvault-multi-writer (task 5.7) — the session-start writer-admission
   * reconcile's outcome. `null` exactly when `reconcile: "forbidden"` — this
   * reconcile carries no disclosure risk (it wraps nothing), so unlike
   * {@link reconcile_recipients} it is otherwise ALWAYS attempted, no
   * custody-verification gate and no once-per-process memoization: {@link
   * import("../node/gitvault-publication.js").GitvaultVault.
   * reconcileWriterAdmissions} is already a fast no-op (one local pin check,
   * no network call) whenever this session's own key is not an active
   * writer.
   */
  writer_reconcile: GitvaultReconcileWriterAdmissionsPushResult | null;
  /** gitvault-agent-envelopes D3: what the enroll-if-absent step did for this keystore's key on this open. */
  enrollment: GitvaultEnrollmentOutcome;
}

/** The session-start reconcile's outcome (gitvault-agent-envelopes D5). */
export interface GitvaultSessionReconcileResult {
  attempted: boolean;
  outcome: "reconciled" | "skipped_error" | "deferred_by_local_policy" | "forbidden" | "custody_unverified";
  result?: GitvaultReconcileEnvelopeRecipientsResult;
  /** `deferred_by_local_policy` only: desired recipients this vault does not yet cover (best-effort; `null` when the read failed). */
  pending_count?: number | null;
  error?: string;
}

/** The enroll-if-absent step's outcome (gitvault-agent-envelopes D3). Never a rotation. */
export interface GitvaultEnrollmentOutcome {
  /** `already_active`: the directory holds this keystore's key (BOTH halves current — encryption active AND signing_fingerprint already matches, gitvault-multi-writer rev 47). `enrolled`: published + possession-proven in this call. `activated_pending`: an earlier unfinished publish was completed. `signing_republished` (rev 47): the encryption half was ALREADY active and needed no work; only the signing half was (re)published this call — never a rotation, the signing half is always freely republishable. `skipped_no_identity`: no local keystore identity (nothing to enroll — vault creation mints one). `skipped_no_principal`: whoami resolved no enrolling principal (e.g. a service key). `skipped_not_enrollable`: the principal's type is not custody-eligible (ci/system) — no identity is minted. `skipped_error`: whoami/publish/activate failed (older gateway, transport) — the verb still ran, but custody continuity is UNVERIFIED, so no automatic reconcile follows; `error` says why. */
  outcome: "already_active" | "enrolled" | "activated_pending" | "signing_republished" | "skipped_no_identity" | "skipped_no_principal" | "skipped_not_enrollable" | "skipped_error";
  ek_fingerprint: string | null;
  /**
   * gitvault-multi-writer rev 47 (task 5.3) — the keystore's vault-WRITER
   * signing half, published in the SAME call as the encryption half
   * whenever this keystore holds a signing seed. `null` when the identity
   * has no local signing seed (a read-only recovery identity — see
   * `GitvaultIdentityFile.signing_seed_hex`'s own doc comment) or when the
   * publish itself was never attempted (`skipped_no_identity`/
   * `skipped_no_principal`/`skipped_not_enrollable`). UNLIKE the encryption
   * half, the signing half is NEVER rotation-gated — a differing published
   * signing key is simply refreshed in place, never a `KEY_ROTATION_REQUIRED`
   * refusal, so this field's presence says nothing about whether a
   * publish actually happened this call vs. was already current.
   */
  signing_fingerprint: string | null;
  error?: string;
}

/** {@link Gitvault.push}'s best-effort envelope-recipient reconcile outcome, reported beside (never folded into) the vault result — same non-blocking contract as {@link GitvaultMirrorPushResult}. */
export interface GitvaultReconcileEnvelopeRecipientsPushResult {
  attempted: boolean;
  outcome: "reconciled" | "skipped_error";
  result?: GitvaultReconcileEnvelopeRecipientsResult;
  error?: string;
}

/**
 * gitvault-multi-writer (task 5.7) — the writer-admission twin of {@link
 * GitvaultReconcileEnvelopeRecipientsPushResult}: best-effort, reported
 * beside (never folded into) the vault result. ONE shape used at every
 * wiring site (push/snapshot/deploy/session-start/read) — unlike the
 * envelope reconcile's split between this push-result shape and the
 * richer {@link GitvaultSessionReconcileResult}, `"forbidden"` is included
 * here too since this reconcile's session-start policy (task 5.7's own,
 * deliberately simpler than the envelope reconcile's custody-gated one —
 * see {@link GitvaultHandle.writer_reconcile}) honors only that one value;
 * it is simply unreachable at the push/snapshot/deploy sites, which never
 * check `options.reconcile` for this hook.
 */
export interface GitvaultReconcileWriterAdmissionsPushResult {
  attempted: boolean;
  outcome: "reconciled" | "skipped_error" | "forbidden";
  result?: GitvaultReconcileWriterAdmissionsResult;
  error?: string;
}

// ─── Handoff / resume result shapes (kygit-handoff design D10) ──────────────

/** {@link Gitvault.handoff}'s result. `handoff_key` (the assembled `kgh1_…`) is returned exactly ONCE. */
export interface GitvaultHandoffMintResult {
  handoff_key: string;
  handoff_id: string;
  kind: "handoff";
  minted_role: string;
  expires_at: string;
  vault: { vault_id: string; address?: string | null; organization_id: string; project_id: string };
  checkpoint: { generation: string; snapshot_oid_hmac: string };
  capture: {
    modified_captured: number;
    untracked_captured: number;
    sensitive_excluded: string[];
    ignored_not_transferred_count: number;
  };
  /** The full local capture result, for a caller that wants more than the summarized `capture` block. */
  snapshot: import("../node/gitvault-snapshot.js").GitvaultHandoffSnapshot;
  warnings: { code: string; message: string }[];
  next_actions: NextAction[];
}

export interface GitvaultHandoffListEntry {
  handoff_id: string;
  kind: string;
  state: "issued" | "claimed" | "expired" | "revoked";
  minted_role: string;
  minted_by: string;
  expires_at: string;
  claimed_by?: string | null;
}

export interface GitvaultHandoffListResult {
  handoffs: GitvaultHandoffListEntry[];
}

/** {@link Gitvault.resume}'s result. */
export interface GitvaultHandoffResumeResult {
  handoff_id: string;
  kind: "handoff";
  deduplicated: boolean;
  /** The Handoff Note, parsed — `null` when the commit message could not be read/parsed (still restored either way). */
  note: import("../node/gitvault-handoff.js").KygitHandoffNote | null;
  /** The note's raw commit-message text, for a caller that wants Markdown rendering over the parsed shape. */
  note_raw: string | null;
  restored: { dir: string; branch: string; base_head_oid: string; stash_oid: string };
  membership: { organization_id: string; role: string; status: string };
  members: unknown[];
  expires_at: string;
  /** gitvault-multi-writer rev 47 (task 5.6, design D5) — this checkout's own writer activation. `outcome: "active"` covers BOTH a fresh submission this call made and the idempotent-skip case (a prior attempt's activation already landed) — the writer IS active either way. */
  writer_activation: { outcome: "active"; writer_key_id: string; generation: string };
  reconcile_recipients: GitvaultReconcileEnvelopeRecipientsPushResult;
  next_actions: NextAction[];
}

/**
 * The gateway names the vault by its three ids on the wire — `repo_id`,
 * `org_id`, `project_id` (docs/style.md's API-boundary vocabulary) — on
 * BOTH the handoff mint (`POST /gitvault/v1/vaults/:vault_id/handoffs`) and
 * claim (`POST /gitvault/v1/handoffs/:handoff_id/claim`) responses. The SDK
 * groups them under `vault` with the `organization_id` spelling every other
 * SDK result uses. Neither response carries a slug-form address, so
 * `address` is `null` unless the caller already knows one (a slug-form
 * remote at mint time). Pure; exported for tests.
 */
export function handoffVaultFromWire(wire: { repo_id: string; org_id: string; project_id: string }, address: string | null = null): GitvaultHandoffMintResult["vault"] {
  return { vault_id: wire.repo_id, address, organization_id: wire.org_id, project_id: wire.project_id };
}

/** The claim response's `membership` block (`org_id` on the wire) in the SDK's `organization_id` spelling. Pure; exported for tests. */
export function handoffMembershipFromWire(wire: { org_id: string; role: string; status: string }): GitvaultHandoffResumeResult["membership"] {
  return { organization_id: wire.org_id, role: wire.role, status: wire.status };
}

/** What {@link Gitvault.openOrCreate} did. `created` is `null` exactly when `found` is `true`. */
/** `run402 repos mirror` (no-arg, a READ) and `repos view`'s mirror summary both compose this — what this machine and the mirror each believe (both honesty statements ride every response). */
export interface GitvaultMirrorStatus {
  repo_id: string;
  configured: boolean;
  /** `s3://bucket/prefix` or a directory path — never a credential. */
  destination: string | null;
  credential_kind: "profile" | "ambient" | null;
  /** The newest generation the MIRROR holds and chain-verifies (keyless). `null` when unconfigured, unreachable, or empty. */
  mirrored_generation: string | null;
  /** The LIVE vault's newest generation (one vault-record read). `null` when unconfigured or the vault has never captured. */
  newest_generation: string | null;
  /** `null` when either side is unknown (never fabricated from a partial read). */
  is_current: boolean | null;
  /** Present exactly when `is_current === false`. */
  closing_command: string | null;
  /** gitvault-mirror-default: when a mirror write/sync last completed with zero failures (local config fact — never transmitted). `null` when unconfigured or never succeeded. */
  last_success_at: string | null;
  /** gitvault-mirror-default: the standing `vault_unmirrored` finding — informational, never blocking; `null` once a mirror write or sync has succeeded (see {@link gitvaultUnmirroredFinding}). */
  finding: GitvaultUnmirroredFinding | null;
  validity_not_freshness: typeof GITVAULT_MIRROR_VALIDITY_NOT_FRESHNESS_STATEMENT;
  keystore_still_required: typeof GITVAULT_MIRROR_KEYSTORE_STILL_REQUIRED_STATEMENT;
}

/**
 * gitvault-mirror-default — the named standing finding for a vault with no
 * customer-held mirror copy yet. gitvault-byo-primary-bucket task 3.5
 * widens `message` to the BYO remedy wording ({@link
 * GITVAULT_BYO_UNMIRRORED_REMEDY_STATEMENT}) for a BYO vault — it applies
 * there too (D7): a single-bucket BYO vault has exactly as few copies as an
 * unmirrored managed one, and the remedy names a SECOND customer-held
 * location the same way.
 */
export interface GitvaultUnmirroredFinding {
  kind: "vault_unmirrored";
  message: typeof GITVAULT_UNMIRRORED_FINDING_STATEMENT | typeof GITVAULT_BYO_UNMIRRORED_REMEDY_STATEMENT;
  /** The one command that moves toward clearing it: configure when unconfigured, backfill when configured-but-never-succeeded. */
  setup_command: string;
}

/**
 * gitvault-byo-primary-bucket task 3.3 — the number of `{key, object_kind}`
 * entries `GITVAULT_BYO_OBJECT_MISSING`'s `details.missing` lists before
 * truncating (`details.missing_count` always carries the true total, and
 * `details.missing_truncated` says whether the list above was cut). A
 * chain-referenced object list can be arbitrarily large; an error envelope
 * is not the place to reproduce it whole. Matches the platform's existing
 * `sample_keys`-class cap (asset-sync's plan response, `PLATFORM_INCIDENT_
 * FANOUT_CAP`) rather than inventing a new number.
 */
export const GITVAULT_BYO_OBJECT_MISSING_LIST_CAP = 50;

/**
 * gitvault-byo-primary-bucket task 3.3 (design D6) — `repos fsck`'s wiring of
 * the shipped {@link import("../node/gitvault-mirror.js").verifyByoObjectsPresent}
 * read-half primitive. Present on {@link GitvaultFsckResult.byo_presence}
 * ONLY for a `storage_profile: "byo"` vault — `undefined` (the key absent
 * from JSON entirely) for a managed vault, so a managed vault's `fsck`
 * output is byte-identical to before this task.
 *
 * `verified: true` NEVER coexists with a missing object: a nonzero absence
 * throws `GITVAULT_BYO_OBJECT_MISSING` instead of returning here (see
 * {@link Gitvault.fsck}'s own doc comment) — this shape only ever reports
 * the two honest non-failure outcomes, "checked, all present" and "could
 * not check".
 */
export interface GitvaultFsckByoPresence {
  /**
   * `true` iff this call actually HEAD-checked the destination (local BYO
   * write credentials were configured on this machine). `false` means "not
   * checked" — see `not_checked_reason` — which is deliberately NOT a
   * failure: a BYO vault a returning agent has no local credentials for
   * must never break its ordinary `fsck`.
   */
  verified: boolean;
  /** The BYO destination's address, from the vault record. Populated even when `verified` is `false` — a BYO vault always names its destination; it is the CREDENTIAL to reach it that may be missing on this machine. */
  destination: string | null;
  /** Objects HEAD-checked against the destination. `0` when `verified` is `false`. */
  checked_count: number;
  /** Present only when `verified` is `false` — why this call could not verify presence. Never blank: silence must never be mistaken for a clean verdict. */
  not_checked_reason: string | null;
}

/**
 * `repos fsck`'s result. Explicit pin fields make a local mutation visible rather than
 * implicit — the external review's clause-5 requirement for any verb that
 * may advance local trust state.
 */
export interface GitvaultFsckResult {
  repo_id: string;
  /** `false` under `--no-write` (`write: false`) — nothing local was persisted, regardless of what was computed. */
  write: boolean;
  verified_from_generation: string | null;
  /**
   * Alias for `chain_verified_to_generation` below (kept for back-compat —
   * every existing caller reads this field). Chain/signature verification
   * ALWAYS reaches this generation, independent of decrypt capability
   * (D193, rev 42: an admitted `rotate_epoch` transition is keylessly
   * structural, never a stopping point for chain verification).
   */
  verified_to_generation: string;
  /** Same value as `verified_to_generation` — the honest name for what this field actually measures (Request 1's split). */
  chain_verified_to_generation: string;
  /**
   * The newest generation this call could actually DECRYPT — restoration's
   * real ceiling. Equals `chain_verified_to_generation` on a healthy vault;
   * falls short of it when an admitted `rotate_epoch` transition's own
   * envelope could not be opened by this keystore (`epoch_decrypt_failure`
   * names exactly which epoch/rotation and why — never a bare, undifferentiated
   * `GITVAULT_AEAD_AUTH_FAILURE`). `refs`/`head_target`/`pin_after.highest_materialized`
   * below all reflect THIS generation, not the chain-verified one, when they differ.
   */
  decryptable_to_generation: string;
  /** Non-null iff `decryptable_to_generation` fell short of `chain_verified_to_generation` — the named epoch boundary (Request 1). */
  epoch_decrypt_failure: import("../node/gitvault-publication.js").GitvaultEpochDecryptFailure | null;
  /** `true` only when `write` was true AND a pin actually moved. */
  local_state_changed: boolean;
  pin_before: { highest_authenticated: string | null; highest_materialized: string | null };
  pin_after: { highest_authenticated: string | null; highest_materialized: string | null };
  /** The real, computed ref map, AS OF `decryptable_to_generation` — present even under `--no-write` (computing is not the same as persisting). */
  refs: GitvaultRefMap;
  head_target: GitvaultHeadTarget | null;
  /** Present only when `--mirror` was requested. Proves validity, never freshness — see its own honesty statements. */
  mirror: GitvaultVerifyReport | null;
  /**
   * clone-installs-retained-refs (D2, task 1.3): the healing path for a
   * pre-change clone (or a checkout whose original write degraded per D3) —
   * `null` under `--no-write` (a genuine audit mode persists nothing, refs
   * included) or when no local checkout was addressed (`repo_dir` absent, or
   * `repo_dir` is not itself a git repository — an ordinary, silent no-op,
   * never a warning).
   */
  retained_refs: import("../node/gitvault-publication.js").GitvaultRetainedRefsReconcileResult | null;
  /**
   * D210 (rev 44) — best-effort submission of THIS call's OWN
   * `chain_verified_to_generation`/`decryptable_to_generation` as
   * recipient-attested proof-of-open evidence (`POST
   * …/recipients/:principal_id/proof-of-open`), the SDK/CLI follow-up
   * D210's own decision log names ("an `fsck --attest-open`-class
   * submitter"). Automatic in WRITE mode when this keystore holds a local
   * encryption identity; `{attempted: false, ...}` under `--no-write` (a
   * genuine audit mode creates no server-side state) or when there is no
   * local identity to submit evidence for. This NEVER changes `fsck`'s own
   * verdict above — a submission failure (principal resolution, network,
   * `OPEN_PROOF_MISMATCH`) is recorded in `error` and nothing else; a
   * `recipient_open_receipt` is EVIDENCE, never authorization (§4.14).
   */
  open_proof: GitvaultOpenProofOutcome;
  /**
   * gitvault-byo-primary-bucket task 3.3 — see {@link GitvaultFsckByoPresence}.
   * Absent entirely (not `null`) for a `storage_profile: "managed"` vault, so
   * `JSON.stringify` drops the key and a managed vault's `fsck` output stays
   * byte-identical to before this task existed. A `verified: true` result
   * with objects missing is never returned here — see the interface's own
   * doc comment for why that case throws `GITVAULT_BYO_OBJECT_MISSING`
   * instead.
   */
  byo_presence?: GitvaultFsckByoPresence;
}

/** {@link GitvaultFsckResult.open_proof} — the outcome of `fsck`'s best-effort D210 proof-of-open submission. */
export interface GitvaultOpenProofOutcome {
  /** `false` iff this call decided LOCALLY there was nothing to submit (write:false, or no local encryption identity) — no network call was made. */
  attempted: boolean;
  /** `true` iff the gateway accepted the submission (200 or 201) — `receipt`/`deduplicated` are populated. */
  submitted: boolean;
  /** `true` — the gateway returned the tuple's EXISTING receipt (200, an idempotent replay). `false` — a fresh receipt was minted (201). `null` when `submitted` is `false`. */
  deduplicated: boolean | null;
  /** The `recipient_open_receipt` the gateway returned, present iff `submitted`. */
  receipt: GitvaultOpenReceipt | null;
  /** Present iff `attempted` and NOT `submitted` — why the gateway (or principal resolution before it) refused. */
  error: { code: string; message: string } | null;
}

/**
 * D210 (rev 44) — the decision function behind `fsck`'s best-effort
 * proof-of-open submission, factored out of {@link Gitvault}'s private
 * `#submitFsckOpenProof` so it is directly unit-testable with injected
 * (fake) `resolvePrincipalId`/`submit` dependencies, independent of a real
 * HTTP-backed vault. `fsck()` itself supplies the REAL dependencies (`GET
 * /agent/v1/whoami`, {@link Gitvault.submitProofOfOpen}) — this function
 * contains no HTTP/transport code of its own.
 *
 * Gating (all LOCAL, no network call made when either holds):
 *   - `write === false` — a genuine audit mode; submitting a receipt is a
 *     real server-side mutation (idempotent or not), so it never fires.
 *   - `ekFingerprint === null` — no local encryption identity to submit
 *     evidence FOR.
 *
 * Otherwise: resolve `principal_id` (`resolvePrincipalId`), then submit
 * `evidence` VERBATIM — `chain_verified_to_generation`/
 * `decryptable_to_generation` pass through completely unchanged from the
 * caller, never recomputed or rounded here.
 *
 * FAILURE CONTAINMENT (the load-bearing property): this function NEVER
 * throws. Every failure — `resolvePrincipalId` resolving `null`,
 * `resolvePrincipalId`/`readerEntrypoint`/`submit` throwing for any reason
 * (network, `OPEN_PROOF_MISMATCH`, anything) — is caught and reported in
 * the returned outcome's `error`; the caller's own already-computed result
 * (`fsck`'s verdict) is never touched by this function's own failure.
 */
export async function computeOpenProofOutcome(input: {
  write: boolean;
  ekFingerprint: string | null;
  evidence: { chain_verified_to_generation: string; decryptable_to_generation: string };
  resolvePrincipalId: () => Promise<string | null>;
  readerEntrypoint: () => Promise<string>;
  submit: (
    principalId: string,
    ekFingerprint: string,
    evidence: { chain_verified_to_generation: string; decryptable_to_generation: string; reader_entrypoint: string },
  ) => Promise<{ receipt: GitvaultOpenReceipt; deduplicated: boolean }>;
}): Promise<GitvaultOpenProofOutcome> {
  if (!input.write) return { attempted: false, submitted: false, deduplicated: null, receipt: null, error: null };
  if (!input.ekFingerprint) return { attempted: false, submitted: false, deduplicated: null, receipt: null, error: null };
  try {
    const principalId = await input.resolvePrincipalId();
    if (!principalId) {
      return {
        attempted: true,
        submitted: false,
        deduplicated: null,
        receipt: null,
        error: {
          code: "GITVAULT_PROOF_OF_OPEN_PRINCIPAL_UNRESOLVED",
          message: "GET /agent/v1/whoami returned no resolvable principal for this credential (delegate bearers are not accepted by whoami) — submit via r.gitvault.submitProofOfOpen(repoId, principalId, evidence) directly instead",
        },
      };
    }
    const readerEntrypoint = await input.readerEntrypoint();
    const out = await input.submit(principalId, input.ekFingerprint, {
      chain_verified_to_generation: input.evidence.chain_verified_to_generation,
      decryptable_to_generation: input.evidence.decryptable_to_generation,
      reader_entrypoint: readerEntrypoint,
    });
    return { attempted: true, submitted: true, deduplicated: out.deduplicated, receipt: out.receipt, error: null };
  } catch (e) {
    return {
      attempted: true,
      submitted: false,
      deduplicated: null,
      receipt: null,
      error: { code: isRun402Error(e) && e.code ? e.code : "UNKNOWN", message: e instanceof Error ? e.message : String(e) },
    };
  }
}

/**
 * gitvault-byo-primary-bucket task 3.3 (design D6) — the decision function
 * behind `fsck`'s BYO presence check, factored out of {@link Gitvault}'s
 * private `#checkByoPresence` the same way {@link computeOpenProofOutcome}
 * is factored out of `#submitFsckOpenProof`, so it is directly unit-testable
 * with an injected (fake) `hasLocalConfig`/`verifyPresence`, independent of
 * a real keystore or HTTP client. `#checkByoPresence` supplies the REAL
 * dependencies (`readByoConfig` against the real keystore,
 * `verifyByoObjectsPresent` against the real client) — this function
 * contains no filesystem/HTTP code of its own.
 *
 * Runs AUTOMATICALLY for a `storage_profile: "byo"` vault — never behind a
 * new flag, so a returning agent's ordinary `fsck` catches a
 * silently-emptied bucket without having to know to ask for it. Returns
 * `undefined` for a managed vault (`vault?.storage_profile !== "byo"` is
 * the FIRST check, before `hasLocalConfig`/`verifyPresence` are ever
 * called) — a managed vault pays zero extra network/filesystem work and
 * this task changes nothing about it (design D6/D9).
 *
 * NO local credentials configured (`hasLocalConfig()` returns `false`) is
 * reported, never thrown — a BYO vault this machine cannot reach is an
 * honest "not checked", not a failure that should break `fsck` for a
 * credential-less returning agent (see {@link GitvaultFsckByoPresence}'s
 * own doc comment). A confirmed absence is the opposite: it THROWS
 * `GITVAULT_BYO_OBJECT_MISSING` — the same severity class as {@link
 * Gitvault.mirrorVerify}'s own `GITVAULT_MIRROR_NOT_CONFIGURED` throw when
 * `--mirror` is requested against an unconfigured vault — this is exactly
 * the honesty D6 names: "we can tell the customer what SHOULD exist and
 * does not", stated as a real refusal rather than a silently-embedded
 * finding. The listed entries are capped at
 * {@link GITVAULT_BYO_OBJECT_MISSING_LIST_CAP} (a chain-referenced object
 * list can be arbitrarily large and this is an error envelope, not a
 * report); `missing_count` always carries the true total regardless of how
 * many are listed.
 *
 * `verifyPresence()` is a pure read (HEAD checks only, via
 * `verifyByoObjectsPresent`) — this function persists nothing itself, so
 * it behaves identically whether `fsck` was called with `write: true` or
 * `write: false`.
 */
export async function computeByoPresenceOutcome(input: {
  repoId: string;
  vault: { storage_profile?: "managed" | "byo"; byo_destination?: string | null } | null;
  hasLocalConfig: () => boolean;
  verifyPresence: () => Promise<GitvaultByoPresenceReport>;
}): Promise<GitvaultFsckByoPresence | undefined> {
  if (input.vault?.storage_profile !== "byo") return undefined;
  const destination = input.vault.byo_destination ?? null;
  if (!input.hasLocalConfig()) {
    return {
      verified: false,
      destination,
      checked_count: 0,
      not_checked_reason:
        "no local BYO destination credentials are configured for this vault on this machine — presence could not be verified; configure the same destination (`run402 repos create --byo <destination>` again, or the equivalent local BYO config) to enable it",
    };
  }
  const report = await input.verifyPresence();
  if (report.missing.length > 0) {
    const missing: GitvaultByoMissingObject[] = report.missing.slice(0, GITVAULT_BYO_OBJECT_MISSING_LIST_CAP);
    throw new LocalError(
      `the BYO destination for ${input.repoId} (${report.destination}) is missing ${report.missing.length} object(s) run402's own signed chain says should exist`,
      "running gitvault fsck",
      {
        code: "GITVAULT_BYO_OBJECT_MISSING",
        details: {
          repo_id: input.repoId,
          destination: report.destination,
          checked_count: report.checked,
          missing_count: report.missing.length,
          missing,
          missing_truncated: report.missing.length > missing.length,
        },
        next_actions: [
          {
            action: "restore the listed object(s) to the destination bucket from your own backup, or run `run402 repos mirror <destination>` to add a second customer-held copy",
            why: "run402 holds no payload copy for a BYO vault — it can only tell you what SHOULD exist from the signed chain, never restore it",
          },
        ],
      },
    );
  }
  return { verified: true, destination: report.destination, checked_count: report.checked, not_checked_reason: null };
}

/**
 * `repos access`'s result — a READ over whatever the live gateway surface
 * exposes today. The gateway's `envelope-recipients` read reports
 * server-authoritative, membership-driven desired-recipient state
 * (`desired[]` + `desired_state_version`), so per-recipient `envelope_state`
 * (`converged` when the desired key is wrapped on this vault, `pending` when
 * it is not, `pending_removal` when membership removal has not yet been
 * enforced) is real. `envelope_state_available` reflects this at RUNTIME —
 * it is `false` only against an older gateway that has not shipped
 * `desired[]` yet (a rolling deploy window, or a pinned older `apiBase`),
 * never a hardcoded claim.
 *
 * ONE gap remains genuine and gateway-independent: `history_scope` (which
 * epochs each recipient can read) has no substrate to report, because
 * gitvault protocol v0 pins a single fixed epoch for a vault's entire
 * lifetime — there is no per-epoch scope to have. `stale_access` below is
 * the closest observable proxy for the same underlying limitation: a
 * `pending_removal` recipient whose fingerprint is STILL covered still
 * decrypts every commit (past AND future) under that one epoch, because
 * epoch rotation — the mechanism that would actually revoke them — is
 * mid-fold in `gitvault-human-envelopes` under adversarial protocol review.
 *
 * `access` reports what the read surface HAS: the org's directory of
 * encryption-key-holding members, which of the vault's current
 * envelope-recipient fingerprints match a directory entry, the
 * server-reported desired state per recipient when available, and
 * (Node-only, best-effort) this machine's own local TOFU pin for each
 * principal, when it has ever wrapped one.
 */
export interface GitvaultAccessRecipient {
  principal_id: string;
  display_name: string | null;
  /** This recipient's fingerprint per the org directory. */
  fingerprint: string;
  /** `true` when this fingerprint has a `key_envelope` on the vault today. */
  covered: boolean;
  /**
   * The server's desired-recipient state for this principal, cross-referenced
   * against `covered`: `"converged"` (desired + covered), `"pending"`
   * (desired, not yet wrapped), `"pending_removal"` (membership removed
   * them but this vault has not been re-keyed away from them — see
   * `stale_access`), or `null` when the gateway did not report desired-state
   * for this principal (older gateway, or the directory and desired-state
   * reads disagree, which should not happen but is reported honestly rather
   * than papered over).
   */
  envelope_state: "converged" | "pending" | "pending_removal" | null;
  /** THIS machine's own local trust-on-first-use record for this principal, or `null` if this machine never wrapped them. Never a server-side fact. */
  tofu_pin: { fingerprint: string; matches_directory: boolean } | null;
}
/** A principal whose membership was removed (desired state `pending_removal`) but who STILL holds a covering `key_envelope` on this vault — real, continuing access that removal did not revoke, because gitvault v0 has no epoch-rotation mechanism yet. See {@link GitvaultAccessResult}'s doc comment. */
export interface GitvaultStaleAccessEntry {
  principal_id: string;
  display_name: string | null;
  fingerprint: string;
}
export interface GitvaultAccessResult {
  repo_id: string;
  org_id: string | null;
  /** gitvault-agent-envelopes D5: this KEY-HOLDER's session-start fulfilment outcome (`null` when this machine holds no K_repo for the vault, or `reconcile: "forbidden"`). */
  reconcile_recipients?: GitvaultSessionReconcileResult | null;
  /** gitvault-agent-envelopes D3: the enroll-if-absent step's outcome (`null` when it did not run). */
  enrollment?: GitvaultEnrollmentOutcome | null;
  recipients: GitvaultAccessRecipient[];
  /** Vault-covering fingerprints (from the server) that match neither a directory entry nor a desired-state row — genuinely orphaned, revoked outside this org's membership model, or external. Excludes fingerprints already explained by `stale_access` AND by `this_keystore`. */
  unmatched_covered_fingerprints: string[];
  /**
   * Node-only, best-effort: set when an otherwise-unmatched covering
   * fingerprint equals THIS keystore's own encryption-key fingerprint — the
   * one case an unmatched fingerprint is locally provable rather than a
   * genuine unknown. Typically the vault creator's own wallet-principal
   * keystore, which the org directory never lists (it only enrolls human
   * keys). `null` when no local match was found (including non-Node
   * callers, or a machine that never held this identity).
   */
  this_keystore: {
    fingerprint: string;
    /** `true` iff the directory holds this keystore's key as ACTIVE (gitvault-agent-envelopes: agents enroll too). */
    enrolled: boolean;
    /** `absent` = no published key (the next gitvault operation enrolls); `pending` = published, possession unproven; `rotation_required` = the principal's published key is a DIFFERENT key; `unknown` = whoami unavailable. */
    publish_state: "active" | "pending" | "absent" | "rotation_required" | "unknown";
    covered_on_this_vault: boolean;
    /** @deprecated alias of `covered_on_this_vault`. */
    covered: boolean;
    next_actions?: Array<{ action: string; why: string }>;
  } | null;
  /** Removed members who still decrypt this vault — see {@link GitvaultStaleAccessEntry}. Always `[]` when `envelope_state_available` is `false` (no desired-state substrate to compute it from). */
  stale_access: GitvaultStaleAccessEntry[];
  /** `true` when the gateway reported desired-recipient state (`desired[]`) for this read, making `recipients[].envelope_state` and `stale_access` real rather than absent. `false` only against an older gateway. */
  envelope_state_available: boolean;
  /** Always `false` — see this type's own doc comment for why this is a protocol-level absence, not a missing gateway feature. */
  history_scope_available: false;
  /** The honest, human-readable statement of the gap above. Read it before assuming `covered: true` means "converged," and before assuming `pending_removal` means access was actually revoked. */
  gap: string;
  /** Present only when `stale_access` is nonempty — the exact owner-driven remedy (D193-D203, rev 42): `repos access repair` for a general re-key, `repos access revoke-key <principal_id>` for one targeted principal. */
  next_actions?: { action: string; why: string }[];
}

/**
 * `repos list`'s bulk read —
 * `GET /gitvault/v1/vaults?org_id=<uuid>`.
 * FROZEN response shape, agreed with the gateway
 * team ahead of the route landing; the route may still 404 on a gateway
 * that has not shipped it yet, and callers should fall back to the
 * per-project walk (`status()` in a loop) until then — see
 * `cli/lib/repos.mjs`'s `list()` for that fallback, kept only until every
 * deployed gateway answers this route.
 */
export interface GitvaultOrgVaultSummary {
  repo_id: string;
  project_id: string;
  project_name: string | null;
  repo_name: string | null;
  org_slug: string | null;
  gitvault_policy: "required" | "grandfathered" | null;
  newest_generation: string | null;
  source_bytes: string;
  genesis_admitted_at: string | null;
  created_at: string;
  /** gitvault-byo-primary-bucket task 3.5 — absent-or-`"managed"` is byte-identical to today. */
  storage_profile?: "managed" | "byo";
}
export interface GitvaultOrgVaultsListing {
  vaults: GitvaultOrgVaultSummary[];
  /** Keyset pagination (agent-response-design): opaque, store-and-echo. */
  has_more?: boolean;
  next_cursor?: string | null;
}

export interface GitvaultOpenOrCreateResult {
  handle: GitvaultHandle;
  /** `true` when the vault already existed — nothing was allocated by this call. */
  found: boolean;
  created: {
    /** Mirrors `GitvaultInitResult.deduplicated`: an existing local creation journal was resumed to completion rather than started fresh — nothing was re-minted. */
    deduplicated: boolean;
    /** Emitted once at creation — integrity data, not a secret. Print it, copy it, keep many copies. Persisted into the keystore regardless. */
    recovery_receipt: GitvaultCreationResult["recovery_receipt"];
    genesis_sha256: string;
  } | null;
  terminal_loss_statement: typeof GITVAULT_TERMINAL_LOSS_STATEMENT;
}

/**
 * {@link Gitvault.deploy}'s post-push glue: attach the best-effort
 * mirror/reconcile hooks to a deploy result, gated on whether this deploy
 * actually landed a new generation in the vault. Extracted as a standalone
 * function (rather than inlined in `deploy()`) purely so the gating can be
 * unit-tested with fake thunks — the real hooks (`#tryMirrorPush` /
 * `#tryReconcileEnvelopeRecipients`) are private class methods that already
 * catch everything and never reject, so this function does not need its own
 * try/catch: it only decides WHETHER to call them and how to merge what they
 * resolve to.
 *
 * `DEPLOYED_AND_VAULTED` and `DEPLOY_FAILED_VAULTED` are the only two
 * outcomes that carry a `generation` — a vault push actually landed. The
 * other three (`DEPLOY_BLOCKED_PUSH_FAILED`, `DEPLOY_FAILED_UNVAULTED`,
 * `DEPLOYED_UNVAULTED_OVERRIDE`) published nothing new, so `mirror_push` /
 * `reconcile_recipients` are OMITTED rather than a faked `skipped_*` value —
 * there is nothing this deploy did that either hook could report on.
 */
export async function attachGitvaultDeployHooks(
  result: GitvaultDeployResult,
  mirror: () => Promise<GitvaultMirrorPushResult>,
  reconcile: () => Promise<GitvaultReconcileEnvelopeRecipientsPushResult>,
): Promise<GitvaultDeployResult & { mirror_push?: GitvaultMirrorPushResult; reconcile_recipients?: GitvaultReconcileEnvelopeRecipientsPushResult }> {
  if (result.outcome !== "DEPLOYED_AND_VAULTED" && result.outcome !== "DEPLOY_FAILED_VAULTED") return result;
  // Sequential, not Promise.all — same ordering push() uses, so a reconcile
  // failure can never be misread as a mirror failure in a log line that
  // assumed ordering.
  const mirrorPush = await mirror();
  const reconcileRecipients = await reconcile();
  return { ...result, mirror_push: mirrorPush, reconcile_recipients: reconcileRecipients };
}

// ─── The namespace ───────────────────────────────────────────────────────────

export class Gitvault {
  readonly #client: Client;

  constructor(client: Client) {
    this.#client = client;
  }

  // ── Control-plane reads (isomorphic) ──────────────────────────────────────

  /** The vault record — policy, allocation generation, storage + maintenance state. */
  async get(repoId: string): Promise<GitvaultVaultRecord> {
    return this.#client.request<GitvaultVaultRecord>(`/gitvault/v1/vaults/${encodeURIComponent(repoId)}`, { context: "reading the gitvault record" });
  }

  /**
   * Resolve a project's vault with no local state. This is the cold-restart
   * entry point: an agent that lost its machine but still holds authority on
   * the project learns its `repo_id` here.
   */
  async forProject(projectId: string): Promise<GitvaultVaultRecord> {
    return this.#client.request<GitvaultVaultRecord>(`/gitvault/v1/vaults?project_id=${encodeURIComponent(projectId)}`, { context: "resolving the project's gitvault" });
  }

  /**
   * Every vault the organization owns, one round trip — `repos list`'s bulk
   * read. See {@link
   * GitvaultOrgVaultsListing}'s doc comment for the FROZEN response shape and
   * the 404-until-shipped fallback contract.
   */
  async listByOrg(orgId: string): Promise<GitvaultOrgVaultsListing> {
    // The gateway keyset-paginates (has_more/next_cursor, opaque store-and-
    // echo). This method's contract is "the org's vaults", so it follows the
    // cursor and aggregates — a silently-truncated page one would be the
    // Faithful breach agent-response-design.md names. The page bound is a
    // runaway guard, far above any real org; hitting it surfaces has_more:
    // true honestly instead of looping forever on a misbehaving cursor.
    const all: GitvaultOrgVaultSummary[] = [];
    let cursor: string | null | undefined;
    for (let page = 0; page < 100; page++) {
      const url = `/gitvault/v1/vaults?org_id=${encodeURIComponent(orgId)}` + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : "");
      const res = await this.#client.request<GitvaultOrgVaultsListing>(url, { context: "listing the organization's vaults" });
      all.push(...res.vaults);
      if (!res.has_more || !res.next_cursor) return { vaults: all, has_more: false, next_cursor: null };
      cursor = res.next_cursor;
    }
    return { vaults: all, has_more: true, next_cursor: cursor ?? null };
  }

  /**
   * Resolve a vault by its address-form `org-slug/name` —
   * `GET /gitvault/v1/vaults?repo=<org-slug>/<name>`.
   * `RESOURCE_NOT_FOUND` for no such org OR no such name (deliberately
   * collapsed — see the design's slug-namespace-probing note);
   * `SLUG_RELEASED` (read it with {@link gitvaultSlugReleasedInfo}) while the
   * slug is in its post-rename cooldown — never auto-followed.
   */
  async forRepo(address: { org_slug: string; repo_name: string }): Promise<GitvaultVaultRecord> {
    const repo = `${address.org_slug}/${address.repo_name}`;
    return this.#client.request<GitvaultVaultRecord>(`/gitvault/v1/vaults?repo=${encodeURIComponent(repo)}`, { context: "resolving the gitvault by repo address" });
  }

  /**
   * Resolve a parsed remote address (`parseGitvaultRemoteUrl`'s output),
   * dispatching on its form: id-form resolves exactly like
   * {@link forProject}; slug-form resolves via {@link forRepo}. A pure read —
   * no pinning, no creation. Node-only callers wanting BOTH should use
   * {@link resolveOrCreateAddress} instead, which also drives the local pin
   * and (opt-in) push-to-create.
   */
  async resolveAddress(address: GitvaultRemoteAddress): Promise<GitvaultVaultRecord> {
    return gitvaultRemoteAddressForm(address) === "id"
      ? this.forProject(address.project_id)
      : this.forRepo({ org_slug: address.org_id, repo_name: address.project_id });
  }

  /**
   * One page of the heads listing (D186).
   *
   * `after_generation` is the REQUIRED verification anchor — a semantic input,
   * never a paging knob — and must stay CONSTANT across a page sequence.
   * `limit` is required. `cursor` is omitted on the first request and is then
   * the prior page's `next_cursor` echoed UNCHANGED: store and echo, never
   * parse. A malformed or stale cursor is `INVALID_CURSOR`; recover by
   * restarting from `after_generation` with no cursor.
   */
  async heads(repoId: string, request: GitvaultHeadsListingRequest): Promise<GitvaultHeadsListingPage> {
    const { validateHeadsListingRequest } = await this.#publication();
    validateHeadsListingRequest(request);
    const qs = new URLSearchParams({ after_generation: request.after_generation, limit: request.limit });
    if (request.cursor !== undefined) qs.set("cursor", request.cursor);
    return this.#client.request<GitvaultHeadsListingPage>(`/gitvault/v1/vaults/${encodeURIComponent(repoId)}/heads?${qs.toString()}`, { context: "listing gitvault heads" });
  }

  /**
   * Walk the whole listing above the anchor, verifying page coupling, ordering,
   * and gaplessness as it goes (a gap is `CHAIN_BROKEN`, never a silent skip).
   */
  async allHeads(repoId: string, options: { after_generation: string; limit?: string }): Promise<{ heads: GitvaultHeadsListingPage["heads"]; pages: number; total: string | null }> {
    const { verifyHeadsListingPage, nextListingRequest } = await this.#publication();
    let request: GitvaultHeadsListingRequest | null = { after_generation: options.after_generation, limit: options.limit ?? "1000" };
    let progress = { after_generation: options.after_generation, last_generation: options.after_generation, delivered: 0 };
    const heads: GitvaultHeadsListingPage["heads"] = [];
    let pages = 0;
    let total: string | null = null;
    while (request) {
      const page: GitvaultHeadsListingPage = await this.heads(repoId, request);
      progress = verifyHeadsListingPage(page, request, progress, repoId);
      heads.push(...page.heads);
      total = page.total;
      pages += 1;
      request = nextListingRequest(request, page);
    }
    return { heads, pages, total };
  }

  /**
   * Set the activation policy. Owner + step-up, audited, reason required.
   * `grandfathered` leaves a doctor-persistent warning until it returns to
   * `required`.
   */
  async setPolicy(repoId: string, input: { gitvault_policy: "required" | "grandfathered"; reason?: string }): Promise<{ gitvault_policy: string; gitvault_policy_version: string; changed: boolean; warnings: { kind: string; message: string }[] }> {
    return this.#client.request(`/gitvault/v1/vaults/${encodeURIComponent(repoId)}/policy`, {
      method: "PATCH",
      body: { gitvault_policy: input.gitvault_policy, ...(input.reason !== undefined ? { reason: input.reason } : {}) },
      context: "setting the gitvault activation policy",
    });
  }

  /**
   * Clear an unvaulted-override advisory by presenting a capture receipt that
   * matches the journaled operation on EVERY field. A partial match never
   * clears it.
   */
  async completeOverride(repoId: string, input: { operation_id: string; capture_receipt: GitvaultCaptureReceipt }): Promise<{ operation_id: string; advisory_cleared: boolean; generation: string; head_sha256: string }> {
    return this.#client.request(`/gitvault/v1/vaults/${encodeURIComponent(repoId)}/override-completions`, { method: "POST", body: input, context: "submitting the gitvault override completion" });
  }

  /**
   * Take the owner's maintenance reservation for a compact/prune cycle.
   *
   * SECRET-BEARING: `holder_token` is returned exactly ONCE and is the liveness
   * instrument for heartbeat/release. Never log it, never cache it, never place
   * it in an agent-surface result store.
   */
  // ── epoch rotation ceremonies + declarations (D193-D203, rev 42) ──────────
  //
  // Five isomorphic, no-local-key-material API calls (owner + step-up,
  // `gitvault.rotate`) — same "direct #client.request" shape as `setPolicy`/
  // `completeOverride` above. The actual ROTATION (sampling K_e, sealing
  // envelopes, submitting the head) needs the Node-only keystore + crypto
  // core and lives on `GitvaultVault` (`sdk/src/node/gitvault-publication.ts`);
  // see {@link rotateEpoch} / {@link rotateEpochForKeyRevocation} below.

  /** `POST …/recipients/:principal_id/confirm` (D197) — first-seen pin confirmation. */
  async confirmRecipient(repoId: string, principalId: string, newFingerprint: string): Promise<GitvaultRecipientConfirmationReceipt> {
    return this.#client.request(`/gitvault/v1/vaults/${encodeURIComponent(repoId)}/recipients/${encodeURIComponent(principalId)}/confirm`, {
      method: "POST", body: { new_fingerprint: newFingerprint }, context: "confirming a gitvault recipient's first pin",
    });
  }

  /** `POST …/recipients/:principal_id/repin` (D197) — re-pin ceremony. */
  async repinRecipient(repoId: string, principalId: string, input: { old_ek_fingerprint: string; new_fingerprint: string }): Promise<GitvaultRecipientConfirmationReceipt> {
    return this.#client.request(`/gitvault/v1/vaults/${encodeURIComponent(repoId)}/recipients/${encodeURIComponent(principalId)}/repin`, {
      method: "POST", body: input, context: "re-pinning a gitvault recipient",
    });
  }

  /**
   * gitvault-agent-envelopes D3 — a KEY-HOLDER explicitly accepts a recipient's
   * CHANGED key. The session-start reconcile refuses to wrap under a
   * fingerprint that differs from this keystore's TOFU pin
   * (`pinned_key_mismatch`) — that refusal is the substitution defence and
   * is never bypassed automatically, not even after an owner's revoke: from
   * this machine's view an owner-driven re-key and a platform substitution
   * look identical, and the audit event is not proof against the platform.
   * Acceptance is a deliberate act naming the new fingerprint (the
   * out-of-band verification point — read it back with the recipient over any
   * channel; it is public data): this records the D197 re-pin receipt with the
   * gateway AND moves the local pin, so the next reconcile wraps. Refuses when
   * `new_fingerprint` is not what the org directory currently serves for the
   * principal (a stale or mistyped fingerprint never pins).
   */
  async acceptRecipientKeyChange(options: GitvaultVaultHandleOptions & { principal_id: string; new_fingerprint: string }): Promise<{ repo_id: string; principal_id: string; old_fingerprint: string | null; new_fingerprint: string; receipt: GitvaultRecipientConfirmationReceipt | null }> {
    const repoId = await this.#resolveRepoId(options);
    const { GitvaultKeystore } = await this.#keystore();
    const keystore = new GitvaultKeystore(options.keystore_root !== undefined ? { rootDir: options.keystore_root } : {});
    const repo = keystore.readRepo(repoId);
    if (!repo) throw new LocalError("this keystore holds no repo state for the vault — only a key-holder can accept a recipient's key change", "accepting a recipient key change", { code: "GITVAULT_REPO_STATE_MISSING", details: { repo_id: repoId } });
    const record = await this.get(repoId);
    const directory = await this.#client.request<{ keys: Array<{ principal_id: string; ek_fingerprint: string }> }>(`/orgs/v1/${encodeURIComponent(record.org_id)}/encryption-keys`, { context: "reading the org encryption-key directory" });
    const served = directory.keys.find((k) => k.principal_id === options.principal_id)?.ek_fingerprint ?? null;
    if (served !== options.new_fingerprint) {
      throw new LocalError(
        `the org directory currently serves ${served ?? "no key"} for principal ${options.principal_id}, not ${options.new_fingerprint} — refusing to pin a fingerprint the directory does not vouch for`,
        "accepting a recipient key change",
        { code: "PIN_CHANGE_UNCONFIRMED", details: { repo_id: repoId, principal_id: options.principal_id, directory_fingerprint: served, requested_fingerprint: options.new_fingerprint } },
      );
    }
    const pins = { ...(repo.envelope_recipient_pins ?? {}) };
    const old = pins[options.principal_id] ?? null;
    let receipt: GitvaultRecipientConfirmationReceipt | null = null;
    if (old && old !== options.new_fingerprint) {
      receipt = await this.repinRecipient(repoId, options.principal_id, { old_ek_fingerprint: old, new_fingerprint: options.new_fingerprint }).catch(() => null);
    } else if (!old) {
      receipt = await this.confirmRecipient(repoId, options.principal_id, options.new_fingerprint).catch(() => null);
    }
    pins[options.principal_id] = options.new_fingerprint;
    keystore.updateRepo(repoId, { envelope_recipient_pins: pins });
    return { repo_id: repoId, principal_id: options.principal_id, old_fingerprint: old, new_fingerprint: options.new_fingerprint, receipt };
  }

  /**
   * `POST …/recipients/:principal_id/key-revocation` (D199) — declares
   * `reason:"recipient_key_revoked"` admissible for the NEXT rotation this
   * org's vaults submit; org-scoped, advances the same watermark a member
   * removal does. Returns the D194 counters — the ONE client-visible read of
   * them, which is why {@link rotateEpochForKeyRevocation} exists as the
   * fully self-contained entry point.
   */
  async declareRecipientKeyRevoked(repoId: string, principalId: string): Promise<{ recipient_state_version: string; recipient_revocation_version: string }> {
    return this.#client.request(`/gitvault/v1/vaults/${encodeURIComponent(repoId)}/recipients/${encodeURIComponent(principalId)}/key-revocation`, {
      method: "POST", body: {}, context: "declaring a gitvault recipient key revoked",
    });
  }

  /**
   * `POST …/epoch-secret-exposure` (D199) — declares `reason:"epoch_secret_exposed"`
   * admissible for THIS vault (deliberately vault-scoped, not org-wide — one
   * vault's leaked `K_repo`/`K_e` is not evidence any sibling vault is
   * compromised). This is the rekey remedy for a leaked/exposed vault key:
   * declare exposure here, then drive a `rotate_epoch` with
   * `reason:"epoch_secret_exposed"` (the required counters must be supplied
   * from a source other than this call — see {@link rotateEpoch}'s doc
   * comment on the confirmed gap in what the gateway exposes today).
   */
  async declareEpochSecretExposed(repoId: string): Promise<{ epoch_secret_exposure_version: string }> {
    return this.#client.request(`/gitvault/v1/vaults/${encodeURIComponent(repoId)}/epoch-secret-exposure`, { method: "POST", body: {}, context: "declaring a gitvault epoch secret exposed" });
  }

  /** `POST …/writer-authority/declare-unavailable` (D202) — an explicit, audited fact that the writer signing key is gone. */
  async declareWriterAuthorityUnavailable(repoId: string): Promise<{ declared_at: string; declared_by: string | null }> {
    return this.#client.request(`/gitvault/v1/vaults/${encodeURIComponent(repoId)}/writer-authority/declare-unavailable`, { method: "POST", body: {}, context: "declaring gitvault writer authority unavailable" });
  }

  /**
   * `POST …/recipients/:principal_id/proof-of-open` (D210, rev 44) — submit
   * `fsck`'s OWN `chain_verified_to_generation`/`decryptable_to_generation`
   * evidence VERBATIM as proof that `principalId` can open this vault under
   * its current epoch. `fsck()` itself calls this automatically (in write
   * mode, when a local encryption identity exists) — call it directly only
   * for a manual/explicit submission (e.g. resubmitting after fixing a
   * local keystore issue, or from a caller that already resolved its own
   * `principal_id` and does not want the extra `whoami` round trip
   * `fsck()`'s own auto-submission pays).
   *
   * Self-match only: the gateway requires `principalId` to equal the
   * AUTHENTICATED caller, never overridable by any credential class — a
   * mismatch is the ordinary 403 `GITVAULT_ACCESS_DENIED`. Idempotent on
   * `(repo_id, principal_id, ek_fingerprint, decryptable_to_generation)` —
   * `deduplicated: true` means the gateway returned the tuple's EXISTING
   * receipt (HTTP 200) rather than minting a fresh one (HTTP 201).
   */
  async submitProofOfOpen(
    repoId: string,
    principalId: string,
    evidence: { ek_fingerprint: string; chain_verified_to_generation: string; decryptable_to_generation: string; reader_entrypoint: string },
  ): Promise<{ receipt: GitvaultOpenReceipt; deduplicated: boolean }> {
    const res = await this.#client.requestWithResponse<GitvaultOpenReceipt>(
      `/gitvault/v1/vaults/${encodeURIComponent(repoId)}/recipients/${encodeURIComponent(principalId)}/proof-of-open`,
      { method: "POST", body: evidence, context: "submitting a gitvault proof-of-open receipt" },
    );
    return { receipt: res.body, deduplicated: res.status === 200 };
  }

  async acquireMaintenanceLease(request: GitvaultMaintenanceLeaseRequest): Promise<GitvaultMaintenanceLease> {
    const { repo_id, ...body } = request;
    return this.#client.request<GitvaultMaintenanceLease>(`/gitvault/v1/vaults/${encodeURIComponent(repo_id)}/maintenance-leases`, {
      method: "POST",
      body: {
        base_head_sha256: body.base_head_sha256,
        current_checkpoint_hash: body.current_checkpoint_hash ?? null,
        r1_size_bytes: body.r1_size_bytes,
        r2_cap_size_bytes: body.r2_cap_size_bytes,
        p_before_c1_size_bytes: body.p_before_c1_size_bytes ?? "0",
        p_before_c2_size_bytes: body.p_before_c2_size_bytes ?? "0",
      },
      context: "acquiring the gitvault maintenance lease",
    });
  }

  // ── Node-only verbs ───────────────────────────────────────────────────────

  /**
   * Open the vault: keystore + HTTP transport + the protocol object. Every verb
   * below builds on this; call it directly when you need the raw protocol
   * surface (ref transactions, repair, checkpoint building).
   */
  async open(options: GitvaultVaultHandleOptions = {}): Promise<GitvaultHandle> {
    const [{ GitvaultVault, createGitvaultHttpTransport }, { GitvaultKeystore }] = await Promise.all([this.#publication(), this.#keystore()]);
    const repoId = await this.#resolveRepoId(options);
    const keystore = new GitvaultKeystore(options.keystore_root !== undefined ? { rootDir: options.keystore_root } : {});
    // gitvault-object-host-predial (design D1, task 1.2): this is the ONE
    // transport whose object reads back the returned handle's vault, so
    // wiring the origin-observation hook here (and nowhere else `open()`
    // is reached from — `openOrCreate`'s own allocation-only transport
    // never serves object reads) covers every read path.
    const transport = createGitvaultHttpTransport(this.#client, {
      onObjectStoreOriginObserved: (rid, origins) => keystore.recordObjectStoreOrigins(rid, origins),
    });
    // gitvault-agent-envelopes D3: enroll the keystore's key if this principal
    // has none (publish + possession proof, one round trip each); a differing
    // current key REFUSES here — rotation is never automatic.
    const enrollment = await this.#ensureEnrolled(keystore);
    const vault = new GitvaultVault({
      keystore,
      transport,
      repo_id: repoId,
      ...(options.repo_dir !== undefined ? { repo_dir: options.repo_dir } : {}),
      ...(options.verification_budget !== undefined ? { verification_budget: options.verification_budget } : {}),
      ...(options.service_public_key !== undefined ? { service_public_key: options.service_public_key } : {}),
    });
    // D4: a cold keystore restores from its own envelope (or fails
    // GITVAULT_ENVELOPE_PENDING with the exact next actions). The lazy
    // fallback is an ALLOWLIST of typed transport/absence states, not a
    // denylist of known verdicts (consult round 2 §5): a network fault, an
    // older gateway missing the route (404/501), or a vault with no admitted
    // genesis yet (CHAIN_BROKEN — not born, nothing to restore or disclose)
    // leave the handle lazy so the verb fails exactly where it always did
    // (`GITVAULT_REPO_STATE_MISSING` at first use). EVERYTHING else —
    // integrity failures, parse failures, programming errors — propagates.
    // A keystore with NO identity has nothing to restore and nothing that
    // could be disclosed — stay lazy and let the verb hit the ordinary
    // KEYSTORE_MISSING wall (with its cross-profile hint) exactly where it
    // always did, AFTER the caller's own address-pin writes.
    let restored: import("../node/gitvault-publication.js").GitvaultColdOpenResult | null = null;
    try {
      restored = keystore.readIdentity() ? await vault.ensureRepoState() : null;
    } catch (e) {
      const code = isRun402Error(e) ? (e as { code?: string }).code : undefined;
      const status = isRun402Error(e) ? ((e as { status?: number | null }).status ?? null) : null;
      const transportAbsence = isNetworkError(e) || status === 404 || status === 501;
      if (code === "CHAIN_BROKEN" || transportAbsence) {
        restored = null;
      } else {
        throw e;
      }
    }
    // D5: a key-holder fulfils pending recipients once per process per vault.
    // A just-restored keystore holds K_repo too, but it just LEARNED it from
    // someone else's wrap — it is not the party that owes fulfilment on this
    // open, and wrapping from a first-contact restore before verifying the
    // chain would be premature; the next open in this process does it.
    const policy = options.reconcile ?? "auto";
    // Consult round 2 §4: reconcile WRAPS K_repo — a disclosure — so it runs
    // only when this open VERIFIED custody continuity against the gateway
    // (whoami answered and the current key is this keystore's). A transport
    // fault or unresolved principal is never fail-open into a wrap.
    // `signing_republished` (rev 47) belongs in this allowlist too: it is
    // reached only when the ENCRYPTION half was already active (continuity
    // already held) and a fresh, gateway-verified Ed25519 possession
    // signature was just proven for the signing half — strictly MORE
    // evidence of custody than `already_active` alone, not less.
    const custodyVerified = enrollment.outcome === "already_active" || enrollment.outcome === "enrolled" || enrollment.outcome === "activated_pending" || enrollment.outcome === "signing_republished";
    // Scoped to what was actually verified: keystore + vault + the exact
    // fingerprint whose continuity this open proved. Marked ONLY after a
    // successful reconcile — a transient failure stays retryable, and a
    // `deferred` policy never consumes the marker.
    const sessionKey = `${keystore.rootDir}|${repoId}|${enrollment.ek_fingerprint ?? "none"}`;
    let reconcileRecipients: GitvaultSessionReconcileResult | null = null;
    if (policy === "forbidden") {
      reconcileRecipients = { attempted: false, outcome: "forbidden" };
    } else if (!restored && !custodyVerified) {
      reconcileRecipients = { attempted: false, outcome: "custody_unverified", ...(enrollment.error !== undefined ? { error: enrollment.error } : {}) };
    } else if (!restored && !SESSION_RECONCILED.has(sessionKey)) {
      if (policy === "deferred") {
        let pendingCount: number | null = null;
        try {
          const coverage = await transport.listEnvelopeRecipients({ repo_id: repoId });
          const covered = new Set(coverage.recipient_fingerprints);
          pendingCount = coverage.desired ? coverage.desired.filter((d) => d.status === "active" && d.ek_fingerprint && !covered.has(d.ek_fingerprint)).length : null;
        } catch {
          pendingCount = null;
        }
        reconcileRecipients = { attempted: false, outcome: "deferred_by_local_policy", pending_count: pendingCount };
      } else {
        try {
          const result = await vault.reconcileEnvelopeRecipients();
          reconcileRecipients = { attempted: true, outcome: "reconciled", result };
          SESSION_RECONCILED.add(sessionKey);
        } catch (e) {
          rethrowFatalReconcile(e);
          reconcileRecipients = { attempted: true, outcome: "skipped_error", error: e instanceof Error ? e.message : String(e) };
        }
      }
    }
    // gitvault-multi-writer (task 5.7) — the SAME "session-start"/"read"
    // wiring point as the envelope reconcile above, but a genuinely simpler
    // policy: no disclosure risk, so only `forbidden` is honored — no
    // custody gate, no `deferred`/memoization branch.
    const writerReconcile = policy === "forbidden" ? { attempted: false as const, outcome: "forbidden" as const } : await this.#tryReconcileWriterAdmissions(vault);
    return { repo_id: repoId, keystore, transport, vault, restored, reconcile_recipients: reconcileRecipients, writer_reconcile: writerReconcile, enrollment };
  }

  /**
   * gitvault-agent-envelopes D3 — enroll-if-absent, checked FRESH on every
   * open (consult round 2 §4: memoizing this decision let a long-lived
   * process keep trusting a key an owner had since revoked). Reads
   * `GET /agent/v1/whoami` (the gateway folds the principal's current key
   * metadata in), then:
   *   - no current key → publish the keystore's X25519 key as
   *     `custody_scheme: keystore_v1`, answer the ECDH possession challenge,
   *     activate;
   *   - current key = this keystore's key, still `pending` → finish the
   *     activation (a crashed earlier enrollment);
   *   - current key = this keystore's key, `active` → no-op;
   *   - current key ≠ this keystore's key → `GITVAULT_KEY_ROTATION_REQUIRED`.
   *     Never published as a rotation: a stolen wallet key must not silently
   *     replace a member's decryption identity. The remedies are the
   *     gateway's — restore the keystore backup; an org owner revokes the
   *     stale key; or, for a sole-member principal, `replace_current`.
   * A credential that resolves to no enrolling principal (a service key)
   * skips enrollment — reads keep working; nothing pretends to be enrolled.
   */
  async #ensureEnrolled(keystore: GitvaultKeystore): Promise<GitvaultEnrollmentOutcome> {
    let identity = keystore.readIdentity();
    let whoami: { principal: { id: string; type: string } | null; encryption_key: { encryption_key_id: string; ek_fingerprint: string; custody_scheme: string; state: string; signing_fingerprint?: string | null; signing_possession_verified_at?: string | null } | null };
    try {
      whoami = await this.#client.request("/agent/v1/whoami", { context: "resolving the enrolling principal" });
    } catch (e) {
      // An older gateway, a credential whoami refuses, or a transport fault:
      // enrollment is best-effort on the way IN — the verb itself still runs
      // (and a cold open will say `GITVAULT_ENVELOPE_PENDING` honestly if it
      // needed an envelope this principal never enrolled for). A keystore
      // with no identity reaches the ordinary KEYSTORE_MISSING wall unchanged.
      return { outcome: identity ? "skipped_error" : "skipped_no_identity", ek_fingerprint: identity?.encryption_fingerprint ?? null, signing_fingerprint: identity?.signing_fingerprint ?? null, error: e instanceof Error ? e.message : String(e) };
    }
    if (!whoami.principal) {
      return { outcome: "skipped_no_principal", ek_fingerprint: identity?.encryption_fingerprint ?? null, signing_fingerprint: identity?.signing_fingerprint ?? null };
    }
    if (whoami.principal.type !== "human" && whoami.principal.type !== "agent") {
      // Only custody-eligible principal types enroll (consult round 2 §4):
      // the gateway would refuse the publish anyway, but by then an orphan
      // identity would already exist on disk.
      return { outcome: "skipped_not_enrollable", ek_fingerprint: identity?.encryption_fingerprint ?? null, signing_fingerprint: identity?.signing_fingerprint ?? null };
    }
    if (identity?.enrolled_principal_id && identity.enrolled_principal_id !== whoami.principal.id) {
      throw new LocalError(
        `this keystore identity enrolled as principal ${identity.enrolled_principal_id}, but the active credential resolves to ${whoami.principal.id} — refusing cross-profile reuse of a custody identity`,
        "enrolling the keystore encryption key",
        { code: "GITVAULT_IDENTITY_PROFILE_MISMATCH", details: { enrolled_principal_id: identity.enrolled_principal_id, principal_id: whoami.principal.id, keystore_root: keystore.rootDir } },
      );
    }
    const current = whoami.encryption_key ?? null;
    // A member joining from a FRESH machine has no keystore identity yet.
    // Mint one only now — a real gateway confirmed an enrollable principal
    // with no published key, so this identity is about to become that
    // principal's key. (Vault creation mints its own via the six-stage
    // journal; nothing else ever mints.) A principal that already HAS a
    // published key but no local identity lost its keystore — that is the
    // rotation case below, never a fresh mint.
    if (!identity && !current) identity = keystore.ensureIdentity();
    if (!identity) {
      throw new LocalError(
        `this principal has a published encryption key (${current!.ek_fingerprint}) but this keystore holds no identity — the keystore that enrolled it is not this one; rotation is never automatic`,
        "enrolling the keystore encryption key",
        {
          code: "GITVAULT_KEY_ROTATION_REQUIRED",
          details: { current_ek_fingerprint: current!.ek_fingerprint, current_state: current!.state, local_ek_fingerprint: null, keystore_root: keystore.rootDir },
          next_actions: [
            { type: "edit_request", why: "restore the keystore backup that holds the current key (~/.config/run402/gitvault or the wallet profile's gitvault dir)" },
            { type: "edit_request", why: "have an org owner revoke the stale key: DELETE /orgs/v1/:org_id/members/:principal_id/encryption-key (owner + step-up); your next gitvault operation then enrolls a fresh key" },
            { type: "edit_request", why: "if this principal is the sole custody-eligible member of every org it belongs to: POST /agent/v1/whoami/encryption-key with replace_current: true" },
          ],
        },
      );
    }
    if (current && current.ek_fingerprint !== identity.encryption_fingerprint) {
      throw new LocalError(
        `this principal's published encryption key (${current.ek_fingerprint}) is not this keystore's key (${identity.encryption_fingerprint}); rotation is never automatic`,
        "enrolling the keystore encryption key",
        {
          code: "GITVAULT_KEY_ROTATION_REQUIRED",
          details: { current_ek_fingerprint: current.ek_fingerprint, current_state: current.state, local_ek_fingerprint: identity.encryption_fingerprint, keystore_root: keystore.rootDir },
          next_actions: [
            { type: "edit_request", why: "restore the keystore backup that holds the current key (~/.config/run402/gitvault or the wallet profile's gitvault dir)" },
            { type: "edit_request", why: "have an org owner revoke the stale key: DELETE /orgs/v1/:org_id/members/:principal_id/encryption-key (owner + step-up); your next gitvault operation then enrolls this key" },
            { type: "edit_request", why: "if this principal is the sole custody-eligible member of every org it belongs to: POST /agent/v1/whoami/encryption-key with replace_current: true" },
          ],
        },
      );
    }
    // gitvault-multi-writer rev 47 (task 5.3, design D9) — the signing half's
    // OWN continuity check, parallel to the encryption half's: does the
    // directory's currently-published signing_fingerprint already equal
    // this keystore's? UNLIKE the encryption half this is never a rotation
    // refusal (D9: the signing half is always freely republishable) — a
    // mismatch just means the publish call below is still needed, even
    // when the encryption half is already fully active.
    const needsSigningPublish = identity.signing_fingerprint !== (current?.signing_fingerprint ?? null);
    if (current && current.state === "active" && !needsSigningPublish) {
      keystore.bindIdentityPrincipal(whoami.principal.id);
      return { outcome: "already_active", ek_fingerprint: current.ek_fingerprint, signing_fingerprint: identity.signing_fingerprint };
    }
    const keypair = keystore.encryptionKeypair(identity);
    if (!keypair) {
      throw new LocalError("the keystore identity has no X25519 private key — it cannot enroll or open envelopes", "enrolling the keystore encryption key", { code: "VAULT_UNRECOVERABLE", details: { statement: GITVAULT_TERMINAL_LOSS_STATEMENT } });
    }
    // The signing half rides the SAME publish call as the encryption half
    // (task 4.1's gateway contract: one round trip, both halves, all-or-
    // none). `keystore.signingKeypair` is `null` only for a read-only
    // recovery identity that lost its signing seed — that keystore can
    // still enroll its encryption half (existing behavior, unchanged); it
    // simply cannot become a vault writer until the seed is recovered.
    const signingKeypair = keystore.signingKeypair(identity);
    const signingFields = signingKeypair
      ? {
          signing_pubkey: identity.signing_pubkey,
          signing_fingerprint: identity.signing_fingerprint,
          possession_signature: computeSigningKeyPossessionSignature({
            signing_seed: signingKeypair.seed,
            principal_id: whoami.principal.id,
            signing_pubkey: identity.signing_pubkey,
            encryption_pubkey: identity.encryption_pubkey,
          }),
        }
      : {};
    try {
      const published = await this.#client.request<{ encryption_key_id: string; ek_fingerprint: string; state: string; activation: { challenge_id: string; epk: string; expires_at: string } | null; signing_fingerprint?: string | null }>(
        "/agent/v1/whoami/encryption-key",
        { method: "POST", body: { public_key: identity.encryption_pubkey, ek_fingerprint: identity.encryption_fingerprint, custody_scheme: "keystore_v1", ...signingFields }, context: "publishing the keystore encryption key" },
      );
      if (published.state !== "active") {
        if (!published.activation) {
          throw new LocalError("the gateway published the key as pending without an activation challenge", "enrolling the keystore encryption key", { code: "KEY_NOT_PENDING", details: { state: published.state } });
        }
        const proof = computeKeystorePossessionProof({
          private_key: keypair.private_key,
          epk_b64u: published.activation.epk,
          challenge_id: published.activation.challenge_id,
          encryption_key_id: published.encryption_key_id,
          public_key_b64u: identity.encryption_pubkey,
        });
        await this.#client.request("/agent/v1/whoami/encryption-key/activate", {
          method: "POST",
          body: { challenge_id: published.activation.challenge_id, proof },
          context: "proving possession of the keystore encryption key",
        });
      }
    } catch (e) {
      // The ONE refusal that must surface is a rotation (the gateway saw a
      // different current key than whoami just reported — a race with a
      // concurrent publish); everything else stays best-effort.
      if (isRun402Error(e) && (e as { code?: string }).code === "KEY_ROTATION_REQUIRED") throw e;
      return { outcome: "skipped_error", ek_fingerprint: identity.encryption_fingerprint, signing_fingerprint: identity.signing_fingerprint ?? null, error: e instanceof Error ? e.message : String(e) };
    }
    keystore.bindIdentityPrincipal(whoami.principal.id);
    // The early `already_active` return above only fires when NEITHER half
    // needs work, so reaching here with `current.state === "active"` means
    // specifically that the ENCRYPTION half was already fine and only the
    // signing half triggered this publish — `signing_republished`, not
    // `activated_pending` (which would wrongly imply an ECDH activation
    // challenge was just completed; none was, `published.state` was
    // already `"active"` and the activation branch above never ran).
    const outcome = !current ? "enrolled" : current.state === "active" ? "signing_republished" : "activated_pending";
    return { outcome, ek_fingerprint: identity.encryption_fingerprint, signing_fingerprint: identity.signing_fingerprint ?? null };
  }

  /**
   * Open a vault, allocating it first when it does not exist yet (D2 — lazy
   * allocation on first push).
   *
   * This is the ONE primitive the remote helper and the capture lane
   * (`run402 gitvault push`/`snapshot`) drive so that a push against an
   * unallocated project runs the six-stage creation journal inline instead of
   * refusing: it resolves `repo_id` from `project_id` exactly like
   * {@link open}, and when that resolution fails, tries to create the vault —
   * but ONLY when `org_id` was supplied. Without `org_id` this method is
   * byte-identical to `open()`: the original resolution failure is rethrown
   * unchanged, so every existing caller of `open()` that has no reason to
   * create anything sees no behavior change at all by switching to this.
   *
   * RESUMABILITY (client-surface spec, D2): before starting a fresh creation
   * attempt this looks for an INCOMPLETE local journal already matching this
   * exact `(org_id, project_id)` and resumes ITS `client_creation_id`, rather
   * than starting a second competing attempt every time the process is
   * interrupted mid-creation. Kill the process after ALLOCATED and call this
   * again: the same journal — not a new one — drives to ACTIVE, and exactly
   * one vault exists either way. An explicit `client_creation_id` (tests, or
   * a caller resuming a specific attempt by hand) always wins over that search.
   */
  async openOrCreate(options: GitvaultVaultHandleOptions & { org_id?: string; client_creation_id?: string }): Promise<GitvaultOpenOrCreateResult> {
    if (!options.repo_id && !options.project_id) {
      throw new LocalError("pass repo_id, or project_id to resolve it from the control plane", "opening the gitvault", { code: "GITVAULT_VAULT_UNRESOLVED" });
    }
    // An explicit repo_id addresses the vault directly — there is nothing to
    // resolve or lazily create from an id alone, so this degrades to a plain
    // open (matches `open()`'s own precedence: repo_id always wins).
    if (options.repo_id) {
      const handle = await this.open(options);
      return { handle, found: true, created: null, terminal_loss_statement: GITVAULT_TERMINAL_LOSS_STATEMENT };
    }

    const [{ createGitvaultHttpTransport }, { GitvaultKeystore }, { openOrCreateGitvault }] = await Promise.all([this.#publication(), this.#keystore(), this.#openOrCreate()]);
    const keystore = new GitvaultKeystore(options.keystore_root !== undefined ? { rootDir: options.keystore_root } : {});
    const transport = createGitvaultHttpTransport(this.#client);
    const result = await openOrCreateGitvault({
      keystore,
      transport,
      project_id: options.project_id!,
      ...(options.org_id !== undefined ? { org_id: options.org_id } : {}),
      ...(options.client_creation_id !== undefined ? { client_creation_id: options.client_creation_id } : {}),
      ...(options.service_public_key !== undefined ? { service_public_key: options.service_public_key } : {}),
    });
    const handle = await this.open({ ...options, repo_id: result.repo_id });
    return result.found
      ? { handle, found: true, created: null, terminal_loss_statement: GITVAULT_TERMINAL_LOSS_STATEMENT }
      : { handle, found: false, created: result.created, terminal_loss_statement: GITVAULT_TERMINAL_LOSS_STATEMENT };
  }

  /**
   * Resolve a parsed remote address to an OPEN handle, pinning `repo_id` in
   * local git state on the first successful resolution of EITHER form
   * (gitvault-client-round-trips design D4 widens the original slug-form-only
   * pin to id-form too — an id-form address needs no pin to survive a
   * rename, but the resolution round trip it skips is the same either way),
   * and — when `allow_create` is set and resolution misses — push-to-create
   * it. This is what the remote helper and `gitvault snapshot` drive for a
   * `run402::<org>/<name>` remote, whichever form it names, so a caller need
   * not branch on the address's form itself. A pinned id/address that no
   * longer resolves (404) clears the pin and re-resolves once.
   *
   * `SLUG_RELEASED` is NEVER auto-followed — it rethrows unchanged; read it
   * with {@link gitvaultSlugReleasedInfo} for the successor slug and cooldown.
   */
  async resolveOrCreateAddress(
    options: GitvaultVaultHandleOptions & {
      address: GitvaultRemoteAddress;
      /** Push-to-create on a slug-form miss (D6). `false` (default): a miss is an ordinary not-found refusal — the read path (`list`/`fetch`, `status`). */
      allow_create?: boolean;
      client_creation_id?: string;
      /** Fires once, only when THIS call allocated the vault. Awaited before the handle is returned. */
      onVaultCreated?: (created: NonNullable<import("../node/gitvault-address.js").GitvaultAddressResolution["created"]>) => void | Promise<void>;
    },
  ): Promise<GitvaultOpenOrCreateResult & { resolution: import("../node/gitvault-address.js").GitvaultAddressResolution }> {
    const [{ createGitvaultHttpTransport }, { GitvaultKeystore }, { resolveGitvaultAddress }] = await Promise.all([this.#publication(), this.#keystore(), this.#address()]);
    const keystore = new GitvaultKeystore(options.keystore_root !== undefined ? { rootDir: options.keystore_root } : {});
    const transport = createGitvaultHttpTransport(this.#client);
    const resolution = await resolveGitvaultAddress({
      keystore,
      transport,
      address: options.address,
      ...(options.repo_dir !== undefined ? { repo_dir: options.repo_dir } : {}),
      ...(options.allow_create !== undefined ? { allow_create: options.allow_create } : {}),
      ...(options.client_creation_id !== undefined ? { client_creation_id: options.client_creation_id } : {}),
      ...(options.service_public_key !== undefined ? { service_public_key: options.service_public_key } : {}),
      ...(options.onVaultCreated !== undefined ? { onVaultCreated: options.onVaultCreated } : {}),
    });
    const handle = await this.open({ ...options, repo_id: resolution.repo_id });
    return {
      handle,
      found: resolution.via !== "created",
      created: resolution.created,
      terminal_loss_statement: GITVAULT_TERMINAL_LOSS_STATEMENT,
      resolution,
    };
  }

  /**
   * Stale-pin recovery for OFFLINE address resolutions
   * (gitvault-force-spelling-and-pin-fold): an id-carrying pin resolves with
   * zero network reads, so a pin gone stale (its vault deleted and the
   * project re-allocated a new one) surfaces as the VERB's first repo-scoped
   * read failing rather than as a resolution failure. Call this with that
   * failure: it answers a fresh opened handle + resolution to retry the verb
   * against exactly once, or `null` when there is nothing to recover — the
   * error is not a vault-absent signal, the resolution was not offline, or
   * re-resolution lands on the SAME `repo_id` (the pin was fine and the
   * original refusal is real; it is restored, and recovery never widens what
   * an unauthorized caller learns).
   */
  async recoverStalePin(
    options: GitvaultVaultHandleOptions & {
      address: GitvaultRemoteAddress;
      repo_dir: string;
      resolution: import("../node/gitvault-address.js").GitvaultAddressResolution;
      error: unknown;
    },
  ): Promise<(GitvaultOpenOrCreateResult & { resolution: import("../node/gitvault-address.js").GitvaultAddressResolution }) | null> {
    const [{ createGitvaultHttpTransport }, { GitvaultKeystore }, { recoverStaleGitvaultPin }] = await Promise.all([this.#publication(), this.#keystore(), this.#address()]);
    const keystore = new GitvaultKeystore(options.keystore_root !== undefined ? { rootDir: options.keystore_root } : {});
    const transport = createGitvaultHttpTransport(this.#client);
    const fresh = await recoverStaleGitvaultPin({
      keystore,
      transport,
      address: options.address,
      repo_dir: options.repo_dir,
      resolution: options.resolution,
      error: options.error,
    });
    if (!fresh) return null;
    const handle = await this.open({ ...options, repo_id: fresh.repo_id });
    return {
      handle,
      found: true,
      created: null,
      terminal_loss_statement: GITVAULT_TERMINAL_LOSS_STATEMENT,
      resolution: fresh,
    };
  }

  /**
   * Create the vault for a project and scaffold the git remote.
   *
   * Runs the six-stage creation journal — `LOCAL_KEYS_PREPARED → ALLOCATED →
   * OBJECTS_PREPARED → OBJECTS_FINALIZED → GENESIS_PREPARED → ACTIVE`, each
   * fsynced before the next step, with no ciphertext existing before allocation
   * supplies the `repo_id` the key derivation needs. Crash-safe and resumable
   * on `client_creation_id`.
   *
   * An existing `origin` remote is never modified or claimed; only a remote
   * named `run402` is added.
   */
  async init(options: {
    org_id: string;
    project_id: string;
    repo_dir?: string;
    keystore_root?: string;
    /** Resume a specific creation attempt (or pin it in tests). */
    client_creation_id?: string;
    /** Skip the git scaffold — allocate the vault only. */
    scaffold_git?: boolean;
    remote_name?: string;
    remote_url?: string;
    service_public_key?: Uint8Array | string;
    /**
     * gitvault-byo-primary-bucket task 3.1/3.2/3.5 — request a BYO vault.
     * Same raw-string shape `mirrorSet` already takes (`destination_url` +
     * `credential` + `region`/`endpoint`), so a CLI edge stays a thin
     * adapter — no destination parsing lives outside the SDK. Omitted (the
     * default) is byte-identical to today. This method RUNS the
     * allocation-time bucket probe (D6) itself, BEFORE any allocation
     * request — a failed probe throws `GITVAULT_BYO_BUCKET_PROBE_FAILED`
     * and nothing is created.
     */
    byo?: { destination_url: string; credential?: import("../node/gitvault-mirror-config.js").GitvaultMirrorCredential; region?: string; endpoint?: string };
  }): Promise<GitvaultInitResult> {
    const [{ createGitvaultHttpTransport }, { GitvaultKeystore }, { createGitvault }] = await Promise.all([this.#publication(), this.#keystore(), this.#creation()]);
    const { parseMirrorDestinationUrl, formatMirrorDestination } = await this.#mirrorConfig();
    const keystore = new GitvaultKeystore(options.keystore_root !== undefined ? { rootDir: options.keystore_root } : {});
    const transport = createGitvaultHttpTransport(this.#client);
    let byoWriteTarget: { destination: import("../node/gitvault-mirror-config.js").GitvaultMirrorDestination; credential?: import("../node/gitvault-mirror-config.js").GitvaultMirrorCredential } | undefined;
    let byoDestinationAddress: string | undefined;
    if (options.byo) {
      const destination = parseMirrorDestinationUrl(options.byo.destination_url, { region: options.byo.region, endpoint: options.byo.endpoint });
      byoWriteTarget = { destination, ...(options.byo.credential ? { credential: options.byo.credential } : {}) };
      byoDestinationAddress = formatMirrorDestination(destination);
      // gitvault-byo-primary-bucket task 3.1 (design D6) — probe BEFORE any
      // allocation request; a failed probe throws and nothing is created.
      const { probeGitvaultByoDestination } = await this.#byoProbe();
      await probeGitvaultByoDestination(destination, options.byo.credential);
    }
    const created: GitvaultCreationResult = await createGitvault({
      keystore,
      transport,
      org_id: options.org_id,
      project_id: options.project_id,
      ...(options.client_creation_id !== undefined ? { client_creation_id: options.client_creation_id } : {}),
      ...(options.service_public_key !== undefined ? { service_public_key: options.service_public_key } : {}),
      ...(byoWriteTarget ? { storage_profile: "byo" as const, byo_destination: byoDestinationAddress!, byo_write_target: byoWriteTarget } : {}),
    });

    let remote: GitvaultInitResult["remote"] = null;
    if (options.scaffold_git !== false && options.repo_dir) {
      remote = await this.scaffoldRemote({
        repo_dir: options.repo_dir,
        org_id: options.org_id,
        project_id: options.project_id,
        ...(options.remote_name !== undefined ? { remote_name: options.remote_name } : {}),
        ...(options.remote_url !== undefined ? { remote_url: options.remote_url } : {}),
      });
    }

    // gitvault-byo-primary-bucket task 3.1/3.5 — read back the AUTHORITATIVE
    // storage_profile from the vault record rather than trusting what THIS
    // call requested: an idempotent replay against a pre-existing vault
    // (a different client_creation_id, a different machine) can legitimately
    // resolve to a vault whose real profile disagrees with what was just
    // asked for (`allocateVault`'s own doc comment: "a replay reads the
    // EXISTING row's profile, never re-derives it"). Only when the SERVER
    // confirms "byo" is the local write-credential config actually saved —
    // never speculatively, and never when it disagrees.
    let storageProfile: "managed" | "byo" = "managed";
    let byoDestination: string | null = null;
    if (byoWriteTarget) {
      const record = await transport.getVaultRecord({ repo_id: created.repo_id });
      storageProfile = record.storage_profile ?? "managed";
      byoDestination = record.byo_destination ?? null;
      if (storageProfile === "byo") {
        const { saveByoConfig } = await this.#byoConfig();
        saveByoConfig(keystore, { repo_id: created.repo_id, destination: byoWriteTarget.destination, ...(byoWriteTarget.credential ? { credential: byoWriteTarget.credential } : {}) });
      }
      // storageProfile !== "byo" here means this project's vault already
      // existed as a MANAGED vault under a different creation attempt —
      // nothing is saved locally, and the result below reports the TRUE
      // profile so the caller can tell the user honestly rather than
      // silently writing a bogus BYO config for a managed vault.
    }

    return {
      repo_id: created.repo_id,
      project_id: options.project_id,
      recovery_receipt: created.recovery_receipt,
      genesis_sha256: created.genesis_sha256,
      remote,
      deduplicated: created.how === "reconciled",
      terminal_loss_statement: GITVAULT_TERMINAL_LOSS_STATEMENT,
      storage_profile: storageProfile,
      byo_destination: byoDestination,
    };
  }

  /**
   * Add the run402 git remote, initialising the repository if absent.
   *
   * D1 — claim `origin` additively. LLM muscle memory is `git push origin
   * main` from a billion training examples, and a side-remote name costs
   * every agent a correction cycle, so when the repository has no `origin`
   * remote ours BECOMES `origin`. An existing `origin` is NEVER modified or
   * reclaimed — no matter what it points at, including a prior run of this
   * exact call — so the fallback is `run402`, and when THAT is also taken by
   * something else, nothing is added at all: the additive discipline holds
   * for every remote name this method ever touches, not just `origin`.
   *
   * An explicit `remote_name` is a caller override (no current caller passes
   * one) and skips the origin/run402 dance entirely — the caller already
   * decided the name; this method still never modifies an existing remote
   * under it.
   *
   * No key material or allocation is required — the cold-start path gains no
   * prompts or network dependencies from this.
   */
  async scaffoldRemote(options: { repo_dir: string; org_id: string; project_id: string; remote_name?: string; remote_url?: string }): Promise<GitvaultScaffoldRemoteResult> {
    const { hardenedGit } = await this.#snapshot();
    const url = options.remote_url ?? gitvaultRemoteUrl(options.org_id, options.project_id);
    let createdRepository = false;
    try {
      await hardenedGit(options.repo_dir, ["rev-parse", "--git-dir"]);
    } catch {
      // `main`, not whatever `init.defaultBranch` (or the pre-2.28 hardcoded
      // `master`) happens to be — the docs and this helper's own remedy text
      // (`repoRefusalNote` in git-remote-run402) teach `git push origin main`,
      // and a first push of any OTHER branch leaves HEAD naming a ref that
      // does not exist yet (see this file's own KNOWN LIMITS note on
      // `push` never changing the vault's HEAD target). `-b` needs git 2.28+
      // (2020); the fallback for anything older is the same result by a
      // different route: init, then point HEAD at `refs/heads/main` directly
      // — an EMPTY repository has no ref for `symbolic-ref` to disturb, so
      // this is exactly as safe as `-b main` would have been.
      try {
        await hardenedGit(options.repo_dir, ["init", "-b", "main"]);
      } catch {
        await hardenedGit(options.repo_dir, ["init"]);
        await hardenedGit(options.repo_dir, ["symbolic-ref", "HEAD", "refs/heads/main"]);
      }
      createdRepository = true;
    }
    // An EXISTING repository is never touched — only the branch a fresh `init`
    // above just created gets steered to `main`; this repository's own HEAD
    // (whatever branch it already uses) is left exactly as it was.
    const readRemote = async (name: string): Promise<string | null> => {
      try {
        const out = (await hardenedGit(options.repo_dir, ["remote", "get-url", name])).text().trim();
        return out.length > 0 ? out : null;
      } catch {
        return null;
      }
    };
    const add = async (name: string): Promise<void> => {
      await hardenedGit(options.repo_dir, ["remote", "add", name, url]);
    };

    if (options.remote_name) {
      const name = options.remote_name;
      const existing = await readRemote(name);
      if (existing) {
        return {
          name,
          url,
          created_repository: createdRepository,
          already_present: true,
          existing_url: existing,
          reason: existing === url ? `'${name}' already points here — nothing to add` : `'${name}' points at ${existing} — left unchanged, nothing was added`,
        };
      }
      await add(name);
      return { name, url, created_repository: createdRepository, already_present: false, existing_url: null, reason: `no existing '${name}' remote — added` };
    }

    // D1: claim `origin` when it is free.
    const existingOrigin = await readRemote("origin");
    if (!existingOrigin) {
      await add("origin");
      return { name: "origin", url, created_repository: createdRepository, already_present: false, existing_url: null, reason: "no existing 'origin' remote — claimed it" };
    }
    if (existingOrigin === url) {
      // Idempotent: a prior scaffold already claimed `origin` for this exact vault.
      return { name: "origin", url, created_repository: createdRepository, already_present: true, existing_url: existingOrigin, reason: "'origin' already points here — nothing to add" };
    }
    // `origin` is taken by something else — never touched. Fall back to `run402`.
    const existingRun402 = await readRemote("run402");
    if (existingRun402) {
      return {
        name: "run402",
        url,
        created_repository: createdRepository,
        already_present: true,
        existing_url: existingRun402,
        reason:
          existingRun402 === url
            ? `'origin' points at ${existingOrigin} — 'run402' already points here, nothing to add`
            : `'origin' points at ${existingOrigin}; 'run402' points at ${existingRun402} — neither remote was touched`,
      };
    }
    await add("run402");
    return {
      name: "run402",
      url,
      created_repository: createdRepository,
      already_present: false,
      existing_url: null,
      reason: `'origin' points at ${existingOrigin} — added as 'run402' instead`,
    };
  }

  /**
   * What this machine and the control plane each believe about the vault.
   *
   * Truthful for a VAULT-ONLY project (protocol D183): a project that has never
   * deployed raises no deploy-related warning, and the terminal-loss statement
   * is stated verbatim exactly as for any other vault.
   */
  async status(options: GitvaultVaultHandleOptions & {
    /**
     * Also report the vault's ref map and HEAD target.
     *
     * Opt-in because it is not free and not read-only in the local sense:
     * materializing walks the head chain (a verification) and advances the
     * keystore's materialized pin. `status` without it stays a pure
     * observation, which is what makes it safe to run anywhere.
     */
    refs?: boolean;
  } = {}): Promise<GitvaultStatus> {
    const { GitvaultKeystore } = await this.#keystore();
    const { listPendingOverrideJournals } = await this.#deploy();
    const keystore = new GitvaultKeystore(options.keystore_root !== undefined ? { rootDir: options.keystore_root } : {});

    let repoId: string | null = options.repo_id ?? null;
    let record: GitvaultVaultRecord | null = null;
    if (!repoId && options.project_id) {
      record = await this.forProject(options.project_id).catch(() => null);
      repoId = record?.repo_id ?? null;
    } else if (repoId) {
      record = await this.get(repoId).catch(() => null);
    }

    // READ, never `ensureIdentity()`: that mints an Ed25519 + X25519 keypair
    // and writes it to disk. `status` is an observation — it must not create
    // the very key material it is reporting on, and the client-surface spec is
    // explicit that no key material exists until first capture.
    let identityFingerprint: string | null = null;
    let canSign = false;
    let keystorePresent = false;
    try {
      const identity = keystore.readIdentity();
      if (identity) {
        keystorePresent = true;
        identityFingerprint = identity.signing_fingerprint;
        canSign = keystore.signingKeypair(identity) !== null;
      }
    } catch {
      keystorePresent = false;
    }

    let holdsRepoKey = false;
    let authenticated: string | null = null;
    let materialized: string | null = null;
    if (repoId && keystorePresent) {
      const repoFile = keystore.readRepo(repoId);
      holdsRepoKey = repoFile !== null;
      authenticated = repoFile?.head_pin?.generation ?? null;
      materialized = repoFile?.materialized_pin?.generation ?? null;
    }

    let pending: import("../node/gitvault-deploy.js").GitvaultOverrideJournal[] = [];
    if (repoId && keystorePresent) {
      try {
        pending = listPendingOverrideJournals(keystore, repoId);
      } catch {
        pending = [];
      }
    }
    // Best-effort covering-recipient count (dogfood item 2): the same
    // envelope-recipients read `access()` uses. Decides whether the V0-A
    // single-principal terminal-loss statement is still honest to print for
    // THIS vault, or whether this client has locally proven a second covering
    // recipient. Only attempted when a vault record is already in hand
    // (`record` non-null means the credentials that fetched it already work)
    // — a session-less or offline caller never pays for a second failing
    // request, and any failure here falls back to exactly today's
    // single-principal behavior, never a new failure mode for `status`.
    let coveringRecipients: number | null = null;
    if (repoId && record) {
      try {
        const coverage = await this.#client.request<GitvaultEnvelopeRecipientsResponse>(
          `/gitvault/v1/vaults/${encodeURIComponent(repoId)}/envelope-recipients`,
          { context: "reading the gitvault envelope recipients" },
        );
        coveringRecipients = coverage.recipient_fingerprints.length;
      } catch {
        coveringRecipients = null;
      }
    }
    const isMultiPrincipal = coveringRecipients !== null && coveringRecipients >= 2;

    const warnings = [...(record?.warnings ?? [])];
    if (keystorePresent && !canSign) {
      warnings.push({ kind: "read_only", message: "the signing key is missing from identity.json — this principal can decrypt and verify but cannot publish a new head" });
    }
    if (record?.gitvault_policy === "grandfathered") {
      warnings.push({ kind: "policy_grandfathered", message: "activation does not require vault admission on this project; return it to `required` when the migration is done" });
    }
    // D7 (repo-first-onramp task 2.7): a vault that has accrued enough value
    // at risk gets a STANDING warning instead of the one-time genesis note.
    // `record` is `null` for an unallocated project, which is the ordinary
    // "nothing to warn about" shape, not a gap in this check. Once this
    // client has locally proven >= 2 covering recipients, the SAME threshold
    // still fires — real value at risk still deserves a standing reminder —
    // but the copy downgrades to `keystore_backup_reminder`, which never
    // claims terminal loss (dogfood item 2: the single-principal premise
    // behind `terminal_loss_risk` is provably false for this vault).
    if (record) {
      const trip = gitvaultLossWarningTrip(record);
      if (gitvaultLossWarningTripped(trip)) {
        if (isMultiPrincipal) {
          warnings.push({ kind: "keystore_backup_reminder", message: gitvaultKeystoreBackupReminderMessage(trip, coveringRecipients!) });
        } else {
          warnings.push({ kind: "terminal_loss_risk", message: gitvaultLossWarningMessage(trip) });
        }
      }
    }

    // The local id-pin, when there is a repository to read it from — a pure
    // read, same discipline as `remote` below. Read
    // BEFORE `remote` so a slug-form remote's `matches` comparison can use
    // it: the pin is the only LOCAL ground truth a slug-form address's own
    // URL text does not carry.
    let pinned: GitvaultStatus["pinned"] = null;
    if (options.repo_dir) {
      const { readPinnedGitvaultRepo } = await this.#address();
      const p = await readPinnedGitvaultRepo(options.repo_dir);
      pinned = p ? { repo_id: p.repo_id, resolved_from: p.resolved_from } : null;
    }

    // The local git remote, when there is a repository to read it from. A
    // pure read: `status` must never write git configuration.
    //
    // Checks BOTH conventional names, `run402` first then `origin` —
    // matching `scaffoldRemote`'s own naming: it claims `origin`
    // additively when the repository has none yet, falling back to `run402`
    // only when `origin` is already taken by something else. The common
    // case is therefore an `origin` remote, not a `run402` one. A name whose URL exists but
    // does not parse as a run402 address (someone's own unrelated remote
    // happening to be named "run402") is skipped rather than reported, so
    // the other conventional name still gets a chance.
    let remote: GitvaultStatus["remote"] = null;
    if (options.repo_dir) {
      const { hardenedGit } = await this.#snapshot();
      const project = options.project_id ?? record?.project_id ?? null;
      for (const name of ["run402", "origin"]) {
        let url: string;
        try {
          url = (await hardenedGit(options.repo_dir, ["remote", "get-url", name])).text().trim();
        } catch {
          continue; // not a repository, or no such remote — try the other name
        }
        if (!url) continue;
        const parsed = parseGitvaultRemoteUrl(url);
        if (!parsed) continue;
        if (gitvaultRemoteAddressForm(parsed) === "id") {
          // Id-form: the URL's second half IS the real project id — the
          // pre-existing, always-correct comparison.
          remote = { name, url, matches: project === null || parsed.project_id === project, reason: null };
        } else {
          // Slug-form: the URL's second half is a repo NAME, not a project
          // id — comparing it against `project` would always mismatch, even for
          // a perfectly-configured remote. The only
          // LOCAL ground truth for a slug-form remote's real identity is the
          // id-pin; without one there is nothing to compare against, and
          // that absence is NOT evidence of a mismatch.
          remote = pinned
            ? { name, url, matches: repoId === null || pinned.repo_id === repoId, reason: null }
            : { name, url, matches: null, reason: "name-form remote, not yet resolved on this machine" };
        }
        break;
      }
    }

    // The ref map, only when asked (see the `refs` option's doc). Best-effort:
    // a status that cannot materialize still reports everything else.
    let refs: GitvaultStatus["refs"] = null;
    let headTarget: GitvaultStatus["head_target"] = null;
    if (options.refs === true && repoId && holdsRepoKey) {
      try {
        const handle = await this.open({ ...options, repo_id: repoId });
        const state = await handle.vault.materialize();
        refs = { ...(state.refs ?? {}) };
        headTarget = state.head_target ?? null;
      } catch (e) {
        warnings.push({ kind: "refs_unavailable", message: `the vault's ref map could not be materialized: ${e instanceof Error ? e.message : String(e)}` });
      }
    } else if (options.refs === true && !holdsRepoKey) {
      warnings.push({ kind: "refs_unavailable", message: "this machine does not hold K_repo for the vault, so its ref map cannot be decrypted here" });
    }

    // gitvault-agent-envelopes D3/D5: a KEY-HOLDER's ordinary read is a
    // session start — enroll this keystore's key if absent and fulfil every
    // pending desired recipient once per process (best-effort, reported,
    // never folded into the observation above). `status` on a machine that
    // holds no K_repo has nothing to fulfil and stays a pure read.
    let reconcileRecipients: GitvaultSessionReconcileResult | null = null;
    let enrollment: GitvaultEnrollmentOutcome | null = null;
    if (repoId && holdsRepoKey && options.reconcile !== "forbidden") {
      try {
        const handle = await this.open({ ...options, repo_id: repoId });
        reconcileRecipients = handle.reconcile_recipients;
        enrollment = handle.enrollment;
      } catch (e) {
        warnings.push({ kind: "reconcile_unavailable", message: `the session-start envelope fulfilment could not run: ${e instanceof Error ? e.message : String(e)}` });
      }
    }

    const nextActions: GitvaultStatus["next_actions"] = [];
    // `run402 init` scaffolds the git remote and deliberately allocates
    // nothing; pointing at it here sent users to a command that silently did
    // not do what this line promised (dogfood #1, finding A).
    if (!record) nextActions.push({ action: "allocate the project's vault", command: "run402 repos create --project <id>" });
    else if (pending.length > 0) nextActions.push({ action: `complete ${pending.length} unvaulted-override journal(s)`, command: "run402 repos snapshot" });
    else if (record && !holdsRepoKey) nextActions.push({ action: "this machine holds no key for the vault — allocate resolves to the existing vault and is idempotent", command: "run402 repos create --project <id>" });

    return {
      repo_id: repoId,
      project_id: options.project_id ?? record?.project_id ?? null,
      vault: record,
      reconcile_recipients: reconcileRecipients,
      enrollment,
      keystore: {
        present: keystorePresent,
        identity_fingerprint: identityFingerprint,
        can_sign: canSign,
        holds_repo_key: holdsRepoKey,
        root: keystore.rootDir,
        paths: {
          identity: keystore.identityPath,
          repos: keystore.reposDir,
          receipts: keystore.receiptsDir,
          journal: keystore.journalDir,
          audit_log: keystore.auditLogPath,
          // Path derivation validates the id shape and refuses a malformed
          // one; a bad `--repo` must not turn `status` into a stack trace.
          repo: safePath(() => keystore.repoPath(repoId!), repoId),
          recovery_receipt: safePath(() => keystore.recoveryReceiptPath(repoId!), repoId),
        },
      },
      remote,
      pinned,
      refs,
      head_target: headTarget,
      pins: { highest_authenticated: authenticated, highest_materialized: materialized },
      gitvault_policy: record?.gitvault_policy ?? null,
      pending_overrides: pending.length,
      covering_recipients: coveringRecipients,
      terminal_loss_statement: isMultiPrincipal ? null : GITVAULT_TERMINAL_LOSS_STATEMENT,
      terminal_loss_detail: isMultiPrincipal ? null : GITVAULT_TERMINAL_LOSS_DOCTOR_TEXT,
      durability_statement: isMultiPrincipal ? GITVAULT_DURABILITY_STATEMENT : null,
      warnings,
      next_actions: nextActions,
    };
  }

  /**
   * Capture the working tree and publish it — the push half of a deploy, run on
   * its own. Never gated on a deploy: a vault-only project pushes for months
   * without one.
   *
   * WHAT THIS PUBLISHES, and what it deliberately does not. This is the CAPTURE
   * lane: it publishes the protocol-owned `refs/run402/deploys/latest` plus the
   * `head_target` read off the local HEAD. The repository's OWN refs —
   * `refs/heads/*` and `refs/tags/*` — reach the vault through
   * `git push run402 …` via `git-remote-run402`, which is the lane the spec
   * charges with reproducing them ("the helper SHALL reproduce the exact set of
   * objects reachable from the declared canonical refs (`refs/heads/*`,
   * `refs/tags/*`, protocol-owned `refs/run402/*`), plus the `HEAD` target" —
   * gitvault-client-surface, "Faithful helper"; `run402 gitvault push` is
   * separately defined as "capture and push outside a deploy" under "Source
   * verbs"). The split is forced by §6.6: a dirty tree captures as a SYNTHETIC
   * commit that sits on no branch, so moving `refs/heads/main` onto it would
   * rewrite the user's branch on every dirty push — exactly the history
   * clobbering §6.1's fast-forward + force-with-lease rules exist to prevent.
   *
   * Hence `protocol_refs: "allow"`: this lane BUILDS the protocol ref itself,
   * so it opts in. The remote helper must keep the `"refuse"` default, because
   * there the refnames are user-supplied and a user must not be able to squat
   * the `refs/run402/*` namespace.
   *
   * Before reporting a push as landed the vault compares finalization receipts
   * against its expected manifest and reads the admitted head back from
   * storage. A 200 alone is never enough (§0 client obligations).
   */
  async push(
    options: GitvaultVaultHandleOptions & {
      /**
       * The owning org. Supply it to run D2's lazy allocation: when this
       * project's vault does not exist yet, push() runs the six-stage
       * creation journal inline (via {@link openOrCreate}) before capturing
       * and publishing — one command, no prior `gitvault init`. Without it,
       * push() behaves exactly as it always did: a push against an
       * unallocated vault throws the resolution failure unchanged.
       */
      org_id?: string;
      /**
       * A parsed remote address (`parseGitvaultRemoteUrl`'s output).
       * When given, this push resolves
       * (and, for a slug-form address, pins) through
       * {@link resolveOrCreateAddress} INSTEAD of `openOrCreate`'s
       * project_id-based path; `org_id`/`project_id`/`repo_id` are ignored.
       * Mirrors `git push`'s own push-to-create dispatch in the remote
       * helper, for callers (`gitvault snapshot`) that resolve the target
       * from the local git remote instead of `--project`.
       */
      address?: GitvaultRemoteAddress;
      /** Resume a specific creation attempt (or pin it in tests); auto-discovered from the local keystore otherwise. */
      client_creation_id?: string;
      /**
       * Fires once, only when THIS call allocated the vault — the moment to
       * print the one-shot recovery receipt and keystore path. Awaited
       * before capture/publish continue, so any async work inside it (e.g.
       * resolving the keystore path to print) completes and stays ordered
       * BEFORE the rest of this push's own output.
       */
      onVaultCreated?: (created: NonNullable<GitvaultOpenOrCreateResult["created"]>) => void | Promise<void>;
      /**
       * Capture options, forwarded verbatim to `captureSnapshot`. The commit
       * message for the synthetic commit a dirty tree produces lives HERE
       * (`snapshot: { message }`) — there is deliberately no second top-level
       * `message` field, because a `snapshot` passthrough plus a sibling
       * shortcut is two ways to say one thing with no defined precedence.
       */
      snapshot?: Omit<import("../node/gitvault-snapshot.js").GitvaultSnapshotOptions, "dir">;
      onCommitLine?: (line: string) => void;
      checkpoint?: boolean;
    },
  ): Promise<GitvaultPublishResult & { snapshot: GitvaultSnapshot; gitvault_commit: string; gitvault_commit_line: string; mirror_push: GitvaultMirrorPushResult; byo_chain_copy: GitvaultMirrorPushResult; reconcile_recipients: GitvaultReconcileEnvelopeRecipientsPushResult; writer_reconcile: GitvaultReconcileWriterAdmissionsPushResult }> {
    const [{ deployRefTransaction }, { captureSnapshot, gitvaultCommitLine }] = await Promise.all([this.#publication(), this.#snapshot()]);
    const openedByAddress = options.address ? await this.resolveOrCreateAddress({ ...options, address: options.address, allow_create: true }) : null;
    const opened = openedByAddress ?? (await this.openOrCreate(options));
    const addressResolution = openedByAddress?.resolution ?? null;
    if (!opened.found && opened.created) await options.onVaultCreated?.(opened.created);
    let handle = opened.handle;
    const repoDir = options.repo_dir ?? process.cwd();
    const snapshot = await captureSnapshot({ dir: repoDir, ...(options.snapshot ?? {}) });
    const line = gitvaultCommitLine(snapshot);
    options.onCommitLine?.(line);
    // An OFFLINE (id-carrying pin) resolution discovers a stale pin on this
    // first repo-scoped read — recover once and retry against the fresh
    // vault, per the client-surface id-pinning requirement.
    let materialized: Awaited<ReturnType<(typeof handle)["vault"]["materialize"]>>;
    try {
      materialized = await handle.vault.materialize();
    } catch (e) {
      const recovered =
        options.address && options.repo_dir && addressResolution?.offline
          ? await this.recoverStalePin({ ...options, address: options.address, repo_dir: options.repo_dir, resolution: addressResolution, error: e })
          : null;
      if (!recovered) throw e;
      handle = recovered.handle;
      materialized = await handle.vault.materialize();
    }
    const push: GitvaultPushOptions = {
      transaction: deployRefTransaction(materialized.refs, snapshot.oid),
      head_target: snapshot.head,
      // The transaction above names `refs/run402/deploys/latest`, which
      // `evaluateRefTransaction` refuses under its `?? "refuse"` default. Same
      // opt-in the deploy lane makes for the identical move — see the doc
      // comment for why the remote helper must NOT make it.
      protocol_refs: "allow",
      ...(options.checkpoint ? { checkpoint: true } : {}),
    };
    const result = await handle.vault.push(push).catch((e) => { throw this.#enrichEpochRotationRequired(e, handle.repo_id); });
    // Capture-time dual-push hook: fires only when a
    // mirror is configured; NEVER throws, NEVER alters the vault outcome
    // above (already returned/committed) — a mirror failure is a named
    // pending finding reported BESIDE the vault result, on its own field.
    const mirrorPush = await this.#tryMirrorPush(handle.repo_id, handle.keystore);
    // gitvault-byo-primary-bucket task 3.3 — the SAME non-blocking contract,
    // fired right beside the mirror hook (skipped_no_mirror with no network
    // call for any managed vault or any machine with no local BYO config).
    const byoChainCopy = await this.#tryByoChainCopyPush(handle.repo_id, handle.keystore);
    // Deploy-time reconcile hook: fires on every successful push,
    // best-effort — a reconcile failure (including a read-only principal
    // with no signing key) is reported BESIDE the vault result, never a
    // `push()` throw, same non-blocking contract as the mirror hook above.
    const reconcileRecipients = await this.#tryReconcileEnvelopeRecipients(handle.vault);
    // gitvault-multi-writer (task 5.7) — the SAME best-effort contract,
    // fired right beside the encryption-recipient reconcile above: a fresh
    // push proves this session's own key is an active writer, so this is
    // the natural place a just-admitted member's own next push clears
    // whatever candidacy it left behind for OTHER pending members too.
    const writerReconcile = await this.#tryReconcileWriterAdmissions(handle.vault);
    return { ...result, snapshot, gitvault_commit: snapshot.oid, gitvault_commit_line: line, mirror_push: mirrorPush, byo_chain_copy: byoChainCopy, reconcile_recipients: reconcileRecipients, writer_reconcile: writerReconcile };
  }

  // ── Handoff / resume (kygit-handoff design D1-D10) ─────────────────────────

  /**
   * Mint a Handoff Key: capture a stash-shaped checkpoint (design D1),
   * push it (retained, on no branch — {@link GITVAULT_DEPLOY_REF} carries
   * it exactly like an ordinary `push()`, never `refs/heads/*`), seal the
   * vault's current epoch key under a fresh `wrap_key`, and mint through
   * the gateway. The assembled `kgh1_…` key is returned exactly ONCE —
   * nothing here or downstream persists it.
   *
   * `options.note` omits `capture` — this method fills it with the real
   * capture figures and runs the client-side secret scan BEFORE the
   * handoff commit is written (design D10: no override flag).
   */
  async handoff(
    options: GitvaultVaultHandleOptions & {
      address?: GitvaultRemoteAddress;
      role?: string;
      ttlSeconds?: number;
      note: Omit<import("../node/gitvault-handoff.js").KygitHandoffNote, "capture">;
      includeSensitive?: string[];
      onCommitLine?: (line: string) => void;
    },
  ): Promise<GitvaultHandoffMintResult> {
    const [{ deployRefTransaction }, { captureHandoffSnapshot, snapshotCommitment }, ho] = await Promise.all([this.#publication(), this.#snapshot(), this.#handoff()]);
    const { assembleHandoffKey, deriveHandoffSecrets, sealHandoffEnvelopeV2, assertHandoffNoteHasNoSecret, buildWriterAdmissionGrant, deriveWriterAdmissionSeed } = ho;

    const handle = options.address ? (await this.resolveOrCreateAddress({ ...options, address: options.address, allow_create: false })).handle : await this.open(options);
    const repoDir = options.repo_dir ?? process.cwd();

    const repoFile = handle.keystore.readRepo(handle.repo_id);
    if (!repoFile) {
      throw new LocalError(
        `no local key material for ${handle.repo_id} — this principal is not yet a member with a materialized envelope (push once first)`,
        "minting a handoff",
        { code: "GITVAULT_VAULT_UNRESOLVED" },
      );
    }
    const kRepo = hexToBytes(repoFile.k_repo_hex);

    // gitvault-multi-writer rev 47 (task 5.5, design D4): only an ACTIVE
    // WRITER may mint — the gateway enforces this authoritatively at mint
    // time (`403 HANDOFF_MINT_REQUIRES_WRITER`), but failing that late
    // would mean this call already paid for a checkpoint capture + push +
    // envelope seal for nothing. `writer_set_pin` is freshly set by the
    // `verifyToNewest` this vault's `open()` above just ran (never stale by
    // more than this session's own most recent verify), so checking it
    // here is a cheap, typed, LOCAL fail-fast — never the check's source of
    // truth, which stays server-side.
    const identity = handle.keystore.readIdentity();
    const localWriterKeyId = identity?.signing_fingerprint ?? null;
    if (!localWriterKeyId || !repoFile.writer_set_pin?.writers.some((w) => w.writer_key_id === localWriterKeyId)) {
      throw new LocalError(
        "this keystore's signing key is not an admitted writer of this vault — minting a handoff requires an ACTIVE writer (design D4); an existing writer must add this key first (`run402 org members add` / repos access sync), or push once to reconcile if a pending admission already exists",
        "minting a handoff",
        { code: "GITVAULT_WRITER_NOT_ADMITTED" },
      );
    }

    // The grant's `minted_role` must EXACTLY predict what the gateway's own
    // role-attenuation (`services/gitvault/claims.ts mintHandoff`) will
    // compute, or the grant fails VALIDATION_FAILED after this call has
    // already paid for the checkpoint push below — `predictMintedRole`
    // mirrors that formula against the SAME `ORG_ROLE_RANK` lattice
    // `gitvault-writer-state.ts` already uses elsewhere in this codebase.
    const { predictMintedRole } = await this.#writerState();
    const vaultRecord = await this.get(handle.repo_id);
    const who = await this.#client.request<{ memberships: { org_id: string; role: string; status: string }[] }>("/agent/v1/whoami", { context: "resolving this principal's org role for the handoff grant" });
    const membership = who.memberships.find((m) => m.org_id === vaultRecord.org_id && m.status === "active");
    if (!membership) {
      throw new LocalError(
        `this principal has no active membership on ${vaultRecord.org_id} — an active writer must also be an active org member to mint a handoff`,
        "minting a handoff",
        { code: "GITVAULT_ACCESS_DENIED" },
      );
    }
    const grantMintedRole = predictMintedRole(options.role, membership.role);

    const snapshot = await captureHandoffSnapshot({
      dir: repoDir,
      ...(options.includeSensitive !== undefined ? { includeSensitive: options.includeSensitive } : {}),
      message: (stats) => {
        const note: import("../node/gitvault-handoff.js").KygitHandoffNote = {
          ...options.note,
          capture: {
            base_head: stats.base_head_oid,
            branch: stats.branch,
            modified_captured: stats.modified_captured.length,
            untracked_captured: stats.untracked_captured.length,
            sensitive_excluded: stats.sensitive_excluded,
            ignored_not_transferred_count: stats.ignored_not_transferred_count,
          },
        };
        assertHandoffNoteHasNoSecret(note);
        return JSON.stringify(note);
      },
    });
    options.onCommitLine?.(`handoff checkpoint ${snapshot.oid}`);

    const materialized = await handle.vault.materialize();
    const pushResult = await handle.vault.push({
      transaction: deployRefTransaction(materialized.refs, snapshot.oid),
      head_target: snapshot.head,
      protocol_refs: "allow",
    }).catch((e) => { throw this.#enrichEpochRotationRequired(e, handle.repo_id); });

    const snapshotOidHmac = snapshotCommitment(kRepo, handle.repo_id, repoFile.epoch, snapshot.oid);

    // Client-generated handoff_id (mirrors this protocol family's own
    // client_creation_id/client_open_id convention): needed to derive
    // auth_secret/wrap_key and seal the envelope BEFORE the mint call, so
    // it cannot be gateway-assigned. The gateway's own `handoff_id` in the
    // response is authoritative; a disagreement (an id collision the
    // gateway resolved differently) is refused rather than silently
    // trusted, since a mismatched id would make the recipient's derived
    // secrets useless anyway.
    const handoffId = randomHandoffUuid();
    const { key, handoff_id_bytes, master_secret } = assembleHandoffKey(handoffId, randomBytes(32));
    const secrets = deriveHandoffSecrets(handoff_id_bytes, master_secret);

    // gitvault-multi-writer rev 47 (task 5.5, design D4) — the MINTER's own
    // writer key signs `writer_admission_grant`, authorizing whoever claims
    // this handoff to become a writer (D224/D225). This is a HARD
    // requirement distinct from the earlier `writer_set_pin` presence
    // check: that check only proves the fingerprint is admitted, not that
    // THIS checkout still holds the seed to sign with — a read-only
    // recovery identity (no local `signing_seed_hex`) can be an admitted
    // writer's fingerprint yet be structurally unable to mint from here.
    //
    // Built BEFORE the envelope is sealed — design D4's "no hash cycle:
    // grant first, then seal" — so the v2 envelope below can embed this
    // grant's own stored-bytes SHA-256, letting the claimant's `resume()`
    // (task 5.6) cross-check the claim response's grant against what this
    // call actually sealed, independent of anything the gateway could alter.
    const signingKeypair = handle.keystore.signingKeypair(identity!); // non-null: the writer precheck above already required identity.signing_fingerprint
    if (!signingKeypair) {
      throw new LocalError(
        "this keystore has no local signing seed — it can read the vault's writer identity but cannot sign a writer_admission_grant from here (a read-only recovery identity); mint from a checkout that holds the full signing seed",
        "minting a handoff",
        { code: "VAULT_UNRECOVERABLE" },
      );
    }
    const handoffAdmissionSeed = deriveWriterAdmissionSeed(handoff_id_bytes, master_secret);
    const grant = buildWriterAdmissionGrant({
      repo_id: handle.repo_id,
      handoff_id: handoffId,
      auth_hash: secrets.auth_hash_hex,
      checkpoint_generation: pushResult.generation,
      checkpoint_head_sha256: pushResult.head_sha256,
      minted_role: grantMintedRole as import("../node/gitvault-handoff.js").GitvaultWriterMintedRole,
      // Mirrors the gateway's own HANDOFF_DEFAULT_TTL_SECONDS (3600) —
      // `claim_not_after` is NOT cross-validated against the mint's actual
      // TTL server-side (only well-formedness is checked), so this only
      // needs to be a reasonable bound, not an exact prediction.
      claim_not_after: new Date(Date.now() + (options.ttlSeconds ?? 3600) * 1000).toISOString(),
      grantor_signing_seed: signingKeypair.seed,
      handoff_admission_pubkey: ed25519PublicKey(handoffAdmissionSeed),
    });
    const grantSha256Local = sha256Hex(jcs(grant));

    const sealed = sealHandoffEnvelopeV2(handoff_id_bytes, secrets.wrap_key, {
      v: 2,
      kind: "handoff",
      repo_id: handle.repo_id,
      epoch: repoFile.epoch,
      k_e_hex: repoFile.k_repo_hex,
      checkpoint: { generation: pushResult.generation, commit_oid: snapshot.oid },
      note_schema: "kygit.handoff-note.v1",
      writer_admission_grant_sha256: grantSha256Local,
    });

    // The wire shape is the gateway's documented one (llms-full.txt
    // "Handoff / resume"): `role` (the minted role), `repo_id` / `org_id` /
    // `project_id`, a verbatim `warning` sentence plus its machine-readable
    // `warnings[]` twin. Read those names exactly — an SDK-side spelling
    // that the gateway never sends surfaces as "role undefined" at the CLI.
    const response = await this.#client.request<{
      handoff_id: string;
      kind: "handoff";
      role: string;
      expires_at: string;
      repo_id: string;
      org_id: string;
      project_id: string;
      checkpoint: { generation: string; snapshot_oid_hmac: string };
      writer_admission_grant_sha256: string;
      warning?: string;
      warnings?: { code: string; message: string }[];
      next_actions?: NextAction[];
    }>(`/gitvault/v1/vaults/${encodeURIComponent(handle.repo_id)}/handoffs`, {
      method: "POST",
      body: {
        handoff_id: handoffId,
        ...(options.role !== undefined ? { role: options.role } : {}),
        ...(options.ttlSeconds !== undefined ? { expires_in_seconds: options.ttlSeconds } : {}),
        checkpoint: { generation: pushResult.generation, snapshot_oid_hmac: snapshotOidHmac },
        sealed_envelope: sealed.sealed_envelope,
        envelope_kind: sealed.envelope_kind,
        auth_hash: secrets.auth_hash_hex,
        writer_admission_grant: toBase64url(jcs(grant)),
      },
      context: "minting a handoff key",
    });
    if (response.handoff_id !== handoffId) {
      throw new LocalError(
        `the gateway minted a different handoff_id (${response.handoff_id}) than requested (${handoffId}) — the assembled key would not match; retry`,
        "minting a handoff key",
        { code: "HANDOFF_ID_MISMATCH", details: { requested: handoffId, minted: response.handoff_id } },
      );
    }
    // The gateway names back the SHA-256 of the EXACT writer_admission_grant
    // bytes it stored — verified against this call's own local computation
    // (never the other way around) so a gateway that silently altered the
    // grant is caught here, before the key is ever handed to a recipient.
    if (response.writer_admission_grant_sha256 !== grantSha256Local) {
      throw new LocalError(
        `the gateway echoed a writer_admission_grant_sha256 (${response.writer_admission_grant_sha256}) that does not match what this call sent (${grantSha256Local}) — the stored grant may not be the one this call signed; do not distribute this handoff key`,
        "minting a handoff key",
        { code: "HANDOFF_MINT_GRANT_MISMATCH", details: { expected: grantSha256Local, received: response.writer_admission_grant_sha256 } },
      );
    }

    return {
      handoff_key: key,
      handoff_id: response.handoff_id,
      kind: response.kind,
      minted_role: response.role,
      expires_at: response.expires_at,
      // A slug-form remote is the one address the minter already knows;
      // an id-form one carries nothing a directory name should be built from.
      vault: handoffVaultFromWire(
        response,
        options.address && gitvaultRemoteAddressForm(options.address) === "slug" ? `${options.address.org_id}/${options.address.project_id}` : null,
      ),
      checkpoint: response.checkpoint,
      capture: {
        modified_captured: snapshot.modified_captured.length,
        untracked_captured: snapshot.untracked_captured.length,
        sensitive_excluded: snapshot.sensitive_excluded,
        ignored_not_transferred_count: snapshot.ignored_not_transferred_count,
      },
      snapshot,
      warnings: response.warnings ?? [],
      next_actions: response.next_actions ?? [],
    };
  }

  /** List a vault's handoffs (ids, kind, state, role, expiry, claimed_by — never the hash or envelope). */
  async listHandoffs(options: GitvaultVaultHandleOptions): Promise<GitvaultHandoffListResult> {
    const repoId = await this.#resolveRepoId(options);
    return this.#client.request<GitvaultHandoffListResult>(`/gitvault/v1/vaults/${encodeURIComponent(repoId)}/handoffs`, { context: "listing handoffs" });
  }

  /** Revoke a handoff (idempotent — a second revoke of an already-revoked/claimed/expired row still answers `200`). */
  async revokeHandoff(handoffId: string, options: GitvaultVaultHandleOptions): Promise<{ handoff_id: string; state: string }> {
    const repoId = await this.#resolveRepoId(options);
    return this.#client.request<{ handoff_id: string; state: string }>(`/gitvault/v1/vaults/${encodeURIComponent(repoId)}/handoffs/${encodeURIComponent(handoffId)}`, { method: "DELETE", context: "revoking a handoff" });
  }

  /**
   * Create this machine's wallet (the allowance file) when the credentials
   * provider supports one and none exists yet. A keypair on disk — no
   * faucet, no tier, no payment. Pure no-op for a provider without the
   * optional allowance methods, or when an allowance already exists.
   */
  async #ensureLocalWallet(onLine?: (line: string) => void): Promise<void> {
    const creds = this.#client.credentials;
    if (!creds.readAllowance || !creds.createAllowance || !creds.saveAllowance) return;
    if (await creds.readAllowance()) return;
    const created = await creds.createAllowance();
    await creds.saveAllowance(created);
    onLine?.(`wallet created for this machine: ${created.address} (a keypair on disk — no payment)`);
  }

  /**
   * Resume a Handoff Key: parse → ensure this machine has a wallet (the
   * claim is bare SIWX, so on a fresh machine the allowance file is created
   * here — a keypair on disk, no faucet, no tier, no payment, ever; design
   * D5) → claim → open the
   * sealed envelope → write the repo file to the keystore BEFORE touching
   * disk → clone at the base HEAD → `git stash apply --index` → local
   * git-config pins only → the session-start reconcile so a principal
   * envelope supersedes the bearer one.
   */
  /**
   * gitvault-multi-writer rev 47 (task 5.6, design D4/D5) — order: parse →
   * ensure wallet → ensure identity → derive auth/wrap/admission → build
   * acceptance → claim → verify grant → open envelope → check the grant
   * hash → persist repo file with `pending_writer_admission` → clone →
   * verify chain → submit the ref-neutral activation head → reconcile
   * principal envelope → apply the checkpoint. Reported as
   * `writer_activation` and `reconcile_recipients` (D5's "recipient
   * coverage"), two blocks, because they are two properties.
   *
   * Crash-resumable by construction, not by a special-cased retry branch:
   * the acceptance is derived fresh every call from the (deterministic)
   * admission seed + this checkout's own identity, so re-running this
   * ENTIRE method after a crash anywhere before activation lands is safe —
   * the claim route is itself idempotent (same-claimant replay returns the
   * SAME grant). The one step that is NOT safely repeatable is submitting
   * the activation head a second time (the chain burns `handoff_id`
   * single-use) — `submitWriterActivationHead` handles that by checking
   * whether this checkout's own key is ALREADY in the freshly-verified
   * writer set before ever building a transition, exactly mirroring
   * `handoff()`'s own writer precheck (task 5.5), just inverted: there
   * "not yet a writer" refuses; here "already a writer" means skip.
   */
  async resume(options: { key: string; to?: string; keystore_root?: string; onLine?: (line: string) => void }): Promise<GitvaultHandoffResumeResult> {
    const [ho, { GitvaultKeystore }, restore] = await Promise.all([this.#handoff(), this.#keystore(), this.#restore()]);
    const { parseHandoffKey, deriveHandoffSecrets, deriveWriterAdmissionSeed, buildWriterAcceptance, openHandoffEnvelopeV2 } = ho;
    const { cloneGitvaultRemote, applyHandoffCheckpoint, resolveResumeTargetDir, readGitCommitMessage } = restore;

    // parse
    const parsed = parseHandoffKey(options.key);

    // ensure wallet — A fresh machine has no wallet, and the claim route
    // accepts ONLY a SIWX wallet signature (a control-plane session,
    // delegate, or service key is refused HANDOFF_CLAIM_REQUIRES_WALLET —
    // the keystore key the claim publishes is what makes the recipient a
    // real key-holder). Nothing upstream creates the allowance for an
    // unpaid request, so `resume` does it here, exactly as `repos resume
    // --help` promises: a keypair written to the allowance file, no
    // faucet, no tier, no payment. Without it a bare machine answers
    // AUTH_REQUIRED. A provider without
    // allowance support (an isomorphic one) is left alone — it
    // authenticates however it authenticates.
    await this.#ensureLocalWallet(options.onLine);

    // ensure identity — BEFORE claim (D5): the acceptance below needs this
    // checkout's own signing key, which the claim REQUEST body carries.
    const keystore = new GitvaultKeystore(options.keystore_root !== undefined ? { rootDir: options.keystore_root } : {});
    const identity = keystore.ensureIdentity();
    const signingKeypair = keystore.signingKeypair(identity);
    if (!signingKeypair) {
      throw new LocalError(
        "this keystore has no local signing seed — resuming a gitvault-multi-writer handoff requires signing writer_acceptance with a full Ed25519 seed, which a read-only recovery identity does not hold",
        "resuming a handoff",
        { code: "VAULT_UNRECOVERABLE" },
      );
    }
    const claimantEncryptionPubkeyRaw = fromBase64url(identity.encryption_pubkey, "identity.encryption_pubkey");

    // derive auth/wrap/admission
    const secrets = deriveHandoffSecrets(parsed.handoff_id_bytes, parsed.master_secret);
    const admissionSeed = deriveWriterAdmissionSeed(parsed.handoff_id_bytes, parsed.master_secret);

    // build acceptance — before claim: design D4's own point is that the
    // claimant can construct BOTH signatures before ever seeing the stored
    // grant, since `handoff_id`/`auth_hash` are already independently known.
    const acceptance = buildWriterAcceptance({
      handoff_id: parsed.handoff_id,
      auth_hash: secrets.auth_hash_hex,
      admission_seed: admissionSeed,
      claimant_signing_seed: signingKeypair.seed,
      claimant_encryption_pubkey_raw: claimantEncryptionPubkeyRaw,
    });

    // claim
    const claim = await this.#client.request<{
      handoff_id: string;
      kind: "handoff";
      deduplicated: boolean;
      sealed_envelope: string;
      envelope_kind: string;
      repo_id: string;
      org_id: string;
      project_id: string;
      checkpoint: { generation: string; snapshot_oid_hmac: string };
      membership: { org_id: string; role: string; status: string };
      members?: unknown[];
      expires_at: string;
      writer_admission_grant: string;
      writer_activation: { state: string };
      next_actions?: NextAction[];
    }>(`/gitvault/v1/handoffs/${encodeURIComponent(parsed.handoff_id)}/claim`, {
      method: "POST",
      // Base64url, per the documented wire contract (openapi: "Base64url — the
      // HKDF-derived auth_secret half of the parsed kgh1_ key"). The gateway
      // decodes base64/base64url and substitutes 32 zero bytes for anything
      // else, so a hex-encoded secret never matches any stored hash and every
      // claim answers HANDOFF_KEY_INVALID. Each side's own tests can pass
      // independently; only the cross-side vector below catches this class.
      body: { auth_secret: toBase64url(secrets.auth_secret), writer_acceptance: toBase64url(jcs(acceptance as unknown as Record<string, unknown>)) },
      context: "claiming a handoff key",
    });

    // The claim names the vault by id only (no slug-form address rides the
    // wire), so the default target directory falls back to the vault id —
    // `--to <dir>` names it explicitly.
    const vault = handoffVaultFromWire(claim);

    // verify grant — a light structural/binding check, NOT the full
    // cryptographic verification (which needs the vault's writer set to
    // resolve the grantor's pubkey, and therefore waits until the chain is
    // walked below — protocol §4.17's own admission ordering, not skipped,
    // just not reachable from here yet).
    let grantBytes: Uint8Array;
    try {
      grantBytes = fromBase64url(claim.writer_admission_grant, "writer_admission_grant");
    } catch {
      throw new LocalError("the claim response's writer_admission_grant is not valid base64url", "resuming a handoff", { code: "VALIDATION_FAILED", details: { field: "writer_admission_grant" } });
    }
    let grant: Record<string, unknown>;
    try {
      grant = JSON.parse(new TextDecoder().decode(grantBytes)) as Record<string, unknown>;
    } catch {
      throw new LocalError("the claim response's writer_admission_grant does not decode to valid JSON", "resuming a handoff", { code: "VALIDATION_FAILED", details: { field: "writer_admission_grant" } });
    }
    if (grant.handoff_id !== parsed.handoff_id || grant.auth_hash !== secrets.auth_hash_hex || grant.repo_id !== vault.vault_id) {
      throw new LocalError("the claim response's writer_admission_grant does not bind this handoff — refusing", "resuming a handoff", { code: "VALIDATION_FAILED", details: { field: "writer_admission_grant" } });
    }
    const grantSha256 = sha256Hex(grantBytes);

    // open envelope — v2 (task 5.4): the v2 payload's own
    // writer_admission_grant_sha256 is what the next step cross-checks;
    // opening under the SAME v1/v2-requiring rule that refuses a
    // pre-gitvault-multi-writer mint's envelope outright.
    const payload = openHandoffEnvelopeV2(parsed.handoff_id_bytes, secrets.wrap_key, claim.sealed_envelope, claim.envelope_kind);
    if (payload.repo_id !== vault.vault_id) {
      throw new LocalError("the opened envelope's repo_id does not match the claim response's vault — refusing", "resuming a handoff", { code: "HANDOFF_ENVELOPE_INVALID" });
    }

    // check the grant hash — design D4's own integrity binding: the SEALED
    // envelope (wrap_key-authenticated, the gateway never holds wrap_key)
    // names the grant it was minted alongside; if the claim response's
    // grant doesn't match, something between mint and claim substituted a
    // different one — refuse before spending anything on this handoff.
    if (payload.writer_admission_grant_sha256 !== grantSha256) {
      throw new LocalError(
        `the claim response's writer_admission_grant (sha256 ${grantSha256}) does not match the hash sealed into the envelope at mint time (${payload.writer_admission_grant_sha256}) — refusing to activate under a substituted grant`,
        "resuming a handoff",
        { code: "HANDOFF_CLAIM_WRITER_KEY_MISMATCH", details: { expected: payload.writer_admission_grant_sha256, received: grantSha256 } },
      );
    }

    // Genesis must be pinned before ANY materialize call can succeed
    // (`GitvaultVault.genesis()` requires a keystore repo file — this is
    // the one read that happens BEFORE one exists, via the transport
    // directly, mirroring `restoreRepoFromEnvelope`'s own signature check).
    const { createGitvaultHttpTransport } = await this.#publication();
    const transport = createGitvaultHttpTransport(this.#client);
    const genesisBytes = await transport.getGenesis({ repo_id: vault.vault_id });
    if (!genesisBytes) {
      throw new LocalError("the vault has no admitted genesis", "resuming a handoff", { code: "CHAIN_BROKEN", details: { repo_id: vault.vault_id } });
    }
    const genesis = parseGitvaultStrict(new TextDecoder().decode(genesisBytes)) as { creator_signing_pubkey: string };
    if (!verifyGitvaultObject(genesis as unknown as Parameters<typeof verifyGitvaultObject>[0], genesis.creator_signing_pubkey)) {
      throw new LocalError("vault_genesis signature does not verify", "resuming a handoff", { code: "GITVAULT_SIGNATURE_INVALID", details: { repo_id: vault.vault_id } });
    }
    const genesisSha = sha256Hex(genesisBytes);

    // persist repo file with pending_writer_admission — BEFORE clone/chain
    // work below (design D10's "write to keystore before touching disk",
    // extended): a crash from here on leaves a durable record of the
    // ALREADY-VERIFIED grant, so a retry never needs to re-claim (the
    // acceptance is trivially re-derivable from data already in hand, per
    // this method's own doc comment above; only the grant is not).
    const myWriterKeyId = identity.signing_fingerprint;
    keystore.saveRepo({
      repo_id: vault.vault_id,
      org_id: vault.organization_id,
      project_id: vault.project_id ?? "",
      k_repo_hex: payload.k_e_hex,
      epoch: payload.epoch,
      epoch_keys: { [payload.epoch]: payload.k_e_hex },
      genesis_sha256: genesisSha,
      head_pin: null,
      last_ref_transaction: null,
      provenance: "restored_from_handoff",
      pending_writer_admission: { handoff_id: parsed.handoff_id, writer_admission_grant: grant, claimed_writer_key_id: myWriterKeyId },
    });

    const targetDir = await resolveResumeTargetDir(options.to, vault.address, vault.vault_id);
    options.onLine?.(`resuming into ${targetDir}`);
    const remoteUrl = gitvaultRemoteUrl(vault.organization_id, vault.project_id);
    await cloneGitvaultRemote(remoteUrl, targetDir);

    // Local-only pins (design D10) — never a worktree file, never the
    // global active project. Reuses the SAME pin-writer every other
    // gitvault resolution path uses, which also writes `r402.room`.
    const { pinGitvaultRepo } = await this.#address();
    const addressParts = vault.address ? vault.address.split("/") : null;
    await pinGitvaultRepo(
      targetDir,
      vault.vault_id,
      addressParts && addressParts.length === 2 ? { org_slug: addressParts[0]!, repo_name: addressParts[1]! } : undefined,
      { project_id: vault.project_id, org_id: vault.organization_id },
    );

    // verify chain — `open()` here mainly constructs the `GitvaultVault`
    // instance: its own `ensureRepoState()` (the cold-open restore path)
    // no-ops the instant it sees a repo file already on disk — and the
    // `saveRepo` call above just wrote one. The chain walk this method
    // actually needs happens a moment later, the FIRST time
    // `submitWriterActivationHead` calls `materialize()` on `handle.vault`
    // below — `materialize()` unconditionally runs `verifyToNewest()` on
    // every call, cold-open or not, which is what freshly pins
    // `writer_set_pin`. `options.reconcile: "forbidden"` here: the
    // encryption-envelope reconcile is deliberately deferred to its own
    // explicit step AFTER activation (D5's ordering), not run implicitly
    // and possibly twice.
    const handle = await this.open({ repo_id: vault.vault_id, repo_dir: targetDir, keystore_root: options.keystore_root, reconcile: "forbidden" });

    // `added_writer.principal_id` names the claimant's OWN control-plane
    // principal — the claim response never carries it (its `membership`
    // block names the ORG, not the principal), so resolve it fresh here,
    // the same one-call pattern `handoff()` already uses for its own role
    // resolution (task 5.5).
    const who = await this.#client.request<{ principal: { id: string } }>("/agent/v1/whoami", { context: "resolving this principal's id for the writer activation head" });

    // submit the ref-neutral activation head
    const activation = await handle.vault.submitWriterActivationHead({
      addedWriterKeyId: myWriterKeyId,
      addedSigningPubkeyB64u: identity.signing_pubkey,
      addedPrincipalId: who.principal.id,
      handoffId: parsed.handoff_id,
      grant,
      acceptance: acceptance as unknown as Record<string, unknown>,
    });
    const activationGeneration = activation.outcome === "activated" ? activation.result.generation : activation.generation;

    // Clearing pending_writer_admission now that the activation head is
    // (or already was — the idempotent-skip case) admitted mirrors
    // writer_status flipping to "active" at the same moment, per this
    // field's own doc comment in gitvault-keystore.ts.
    keystore.updateRepo(vault.vault_id, { pending_writer_admission: null });

    // reconcile principal envelope — the bearer envelope is superseded
    // within minutes of use; run the same reconcile `push()` runs,
    // best-effort (never a `resume()` throw), NOW that this checkout is an
    // admitted writer and the reconcile's own wrap step is meaningful.
    const reconcile = await this.#tryReconcileEnvelopeRecipients(handle.vault);

    // apply the checkpoint — LAST (D5): a failure anywhere above this line
    // leaves the working tree untouched (freshly cloned, nothing stashed),
    // the cleanest possible state to retry `resume()` from.
    const restored = await applyHandoffCheckpoint({ dir: targetDir, stash_oid: payload.checkpoint.commit_oid });

    const senderIsOwner = claim.membership.role === "owner";
    const nextActions: NextAction[] = [...(claim.next_actions ?? [])];
    if (claim.kind === "handoff" && senderIsOwner && !nextActions.some((a) => a.type === "remove_member")) {
      nextActions.push({
        type: "remove_member",
        why: "The previous agent is still an owner; if its environment is gone for good, remove it.",
        destructive: true,
        requires_approval: true,
      });
    }
    if (!nextActions.some((a) => a.type === "push_repo")) {
      nextActions.push({ type: "push_repo", command: "git push origin main", why: "Publish continued work back to the vault." });
    }

    let note: import("../node/gitvault-handoff.js").KygitHandoffNote | null = null;
    let noteRaw: string | null = null;
    try {
      noteRaw = (await readGitCommitMessage(targetDir, payload.checkpoint.commit_oid)) ?? null;
      if (noteRaw) note = JSON.parse(noteRaw) as import("../node/gitvault-handoff.js").KygitHandoffNote;
    } catch {
      note = null;
    }

    return {
      handoff_id: claim.handoff_id,
      kind: claim.kind,
      deduplicated: claim.deduplicated,
      note,
      note_raw: noteRaw,
      restored: { dir: targetDir, branch: restored.branch, base_head_oid: restored.base_head_oid, stash_oid: restored.stash_oid },
      membership: handoffMembershipFromWire(claim.membership),
      members: claim.members ?? [],
      expires_at: claim.expires_at,
      writer_activation: { outcome: "active", writer_key_id: myWriterKeyId, generation: activationGeneration },
      reconcile_recipients: reconcile,
      next_actions: nextActions,
    };
  }

  /** Best-effort dual-push: catches EVERYTHING, including the lazy module import itself, so a mirror problem can never surface as a `push()` throw. */
  /**
   * `EPOCH_ROTATION_REQUIRED` (D193) is left THROWN — never swallowed into a
   * silent auto-rotation — because this call site cannot legally decide the
   * two D194 counters (`recipient_state_version`/`recipient_revocation_version`)
   * a rotation attempt must be fenced against: no shipped gateway route
   * exposes them for `reason:"member_removed"`/`"elective_rekey"`/
   * `"epoch_secret_exposed"` (verified against the live gateway route
   * source — see `GitvaultVault.rotateEpoch`'s own doc comment). Submitting
   * a GUESSED pair would either fail loudly (`RECIPIENT_SET_MISMATCH`, the
   * honest outcome) or — worse — never be reachable at all for a fresh
   * counter row. Rather than let a caller decode `details.migration_required`/
   * `revocation_outstanding`/`exposure_outstanding` themselves, this
   * decorates the SAME thrown error with the exact next command for each
   * cause (`repos access repair` / `repos access revoke-key` / `repos
   * access declare-exposure`) so "the next push" surfaces its own remedy
   * instead of an opaque 409 — "wire into the natural path" without
   * pretending a blind retry could ever succeed.
   */
  #enrichEpochRotationRequired(e: unknown, repoId: string): unknown {
    if (!isRun402Error(e) || (e as { code?: string }).code !== "EPOCH_ROTATION_REQUIRED") return e;
    // Mirrors `epochRotationRequiredNextActions` in
    // `../node/gitvault-deploy.ts` byte-for-byte (same three causes, same
    // three commands) — kept as a small standalone copy rather than a
    // shared import so this namespace-level module (isomorphic — Deno/Bun/V8
    // isolates, no Node-only imports) never has to pull in the Node-only
    // deploy module just to decode three booleans. Update BOTH on drift.
    const details = (e as { details?: { migration_required?: boolean; revocation_outstanding?: boolean; exposure_outstanding?: boolean } }).details ?? {};
    const nextActions: { action: string; why: string }[] = [];
    if (details.migration_required) nextActions.push({ action: "run402 repos access repair", why: "this vault predates rev-42 epoch rotation and must complete one first-ever rotation (owner + step-up)" });
    if (details.revocation_outstanding) nextActions.push({ action: "run402 repos access revoke-key <principal_id>", why: "an org membership removal or key revocation is outstanding for this vault; a surviving writer's push completes a membership removal automatically (reason member_removed), so this push was refused because that rotation could not run here — an owner can rotate explicitly with this command (owner + step-up)" });
    if (details.exposure_outstanding) nextActions.push({ action: "run402 repos access declare-exposure", why: "this vault's own epoch secret has been declared exposed (owner + step-up)" });
    return new LocalError(
      `this vault requires a rotate_epoch admission before an ordinary push is admissible (repo_id ${repoId})`,
      "pushing to gitvault",
      { code: "EPOCH_ROTATION_REQUIRED", details, next_actions: nextActions.length > 0 ? nextActions : undefined, cause: e },
    );
  }

  async #tryMirrorPush(repoId: string, keystore: GitvaultKeystore): Promise<GitvaultMirrorPushResult> {
    try {
      const { mirrorPushForGeneration } = await this.#mirror();
      return await mirrorPushForGeneration(this.#client, repoId, { keystore });
    } catch (e) {
      return { attempted: false, outcome: "skipped_no_mirror", error: e instanceof Error ? e.message : String(e) };
    }
  }

  /**
   * gitvault-byo-primary-bucket task 3.3 — the chain's every-push dual-write
   * into a BYO vault's own destination, mirroring {@link #tryMirrorPush}'s
   * exact contract byte-for-byte (best-effort, catches EVERYTHING, never
   * throws, never alters the vault outcome already committed above — a
   * chain-copy failure is a named pending finding reported BESIDE the vault
   * result on its own field, never a `push()`/`deploy()` throw).
   */
  async #tryByoChainCopyPush(repoId: string, keystore: GitvaultKeystore): Promise<GitvaultMirrorPushResult> {
    try {
      const { byoChainCopyPushForGeneration } = await this.#mirror();
      return await byoChainCopyPushForGeneration(this.#client, repoId, { keystore });
    } catch (e) {
      return { attempted: false, outcome: "skipped_no_mirror", error: e instanceof Error ? e.message : String(e) };
    }
  }

  /** Best-effort envelope-recipient reconcile: availability and local-policy failures never surface as a `push()` throw (mirroring {@link #tryMirrorPush}), but INTEGRITY verdicts do — `RECONCILE_FATAL_CODES` propagates tampering evidence instead of demoting it to `skipped_error` (round 3 blocker 2). */
  async #tryReconcileEnvelopeRecipients(vault: import("../node/gitvault-publication.js").GitvaultVault): Promise<GitvaultReconcileEnvelopeRecipientsPushResult> {
    try {
      const result = await vault.reconcileEnvelopeRecipients();
      return { attempted: true, outcome: "reconciled", result };
    } catch (e) {
      rethrowFatalReconcile(e);
      return { attempted: false, outcome: "skipped_error", error: e instanceof Error ? e.message : String(e) };
    }
  }

  /**
   * gitvault-multi-writer (task 5.7) — best-effort writer-admission
   * reconcile, the SAME non-blocking contract as {@link
   * #tryReconcileEnvelopeRecipients} beside it: availability failures
   * (network, an older gateway missing `pending_writers`/`signing_pubkey`,
   * a CAS-conflict-exhausted admission) never surface as a `push()`/
   * `deploy()`/`open()` throw — `GitvaultVault.reconcileWriterAdmissions()`
   * ALREADY returns an empty result rather than throwing for the ordinary
   * "I am not a writer yet" case, so `skipped_error` here is reserved for
   * genuinely unexpected failures (a transport fault mid-loop, a thrown
   * chain-integrity verdict from the `materialize()` this reconcile's own
   * admission attempts re-run). `rethrowFatalReconcile` is reused as-is:
   * its `RECONCILE_FATAL_CODES` set is envelope-specific today (no writer-
   * chain-integrity code is in it yet), so this call is a no-op unless a
   * future code is added there — cheap, forward-compatible, and consistent
   * with the sibling method rather than a silently different policy.
   */
  async #tryReconcileWriterAdmissions(vault: import("../node/gitvault-publication.js").GitvaultVault): Promise<GitvaultReconcileWriterAdmissionsPushResult> {
    try {
      const result = await vault.reconcileWriterAdmissions();
      return { attempted: true, outcome: "reconciled", result };
    } catch (e) {
      rethrowFatalReconcile(e);
      return { attempted: false, outcome: "skipped_error", error: e instanceof Error ? e.message : String(e) };
    }
  }

  /**
   * A REAL preview of what {@link push} would publish
   * — never publishes anything, and never allocates. `run402 gitvault
   * snapshot --dry-run` and `git-remote-run402`'s `option dry-run true` are
   * both thin adapters over this method.
   *
   * "Refusing beats fake success" (this file's own architectural law) governs
   * the shape of what happens when the vault does not exist yet: unlike
   * {@link push}, this NEVER allocates one (push-to-create must not allocate
   * on a dry run) — it resolves READ-ONLY (`open`/`resolveOrCreateAddress`
   * with `allow_create: false`), and when that resolution misses, returns
   * `allocation_needed: true` with every sizing field `null` rather than a
   * guess. Sizing is genuinely unknowable before allocation: encryption uses
   * a `K_repo` this project has not been assigned yet, so there is no key to
   * preview a push under — only the real capture (this method still runs
   * `captureSnapshot`, which is local, filter-free work) can be computed.
   *
   * Everything else is the SAME real local pipeline `push` runs — capture,
   * pack building, sealing/encryption — computed by
   * {@link import("../node/gitvault-publication.js").GitvaultVault.planPush},
   * which is what actually stops short of the two network mutations
   * (`uploadObjects`, `admitHead`). See its doc comment for what
   * `would_admit_generation` does and does not promise.
   */
  async planPush(
    options: GitvaultVaultHandleOptions & {
      /** Same as {@link push}'s `address` — a parsed remote address. Resolved READ-ONLY (`allow_create: false`); never push-to-creates. */
      address?: GitvaultRemoteAddress;
      snapshot?: Omit<import("../node/gitvault-snapshot.js").GitvaultSnapshotOptions, "dir">;
      onCommitLine?: (line: string) => void;
      checkpoint?: boolean;
    },
  ): Promise<GitvaultSnapshotPushPlan> {
    const { captureSnapshot, gitvaultCommitLine } = await this.#snapshot();
    const repoDir = options.repo_dir ?? process.cwd();

    // READ-ONLY resolution — mirrors `push()`'s own dispatch on `address`,
    // but with `allow_create: false` and no `openOrCreate` fallback: a dry
    // run must never mutate the control plane, and allocation is the one
    // push-time mutation that happens before a single byte is built.
    let handle: GitvaultHandle | null = null;
    try {
      handle = options.address
        ? (await this.resolveOrCreateAddress({ ...options, address: options.address, allow_create: false })).handle
        : await this.open(options);
    } catch (e) {
      if (!isVaultResolutionMiss(e)) throw e;
      handle = null; // no vault to preview a push against yet
    }

    const snapshot = await captureSnapshot({ dir: repoDir, ...(options.snapshot ?? {}) });
    const line = gitvaultCommitLine(snapshot);
    options.onCommitLine?.(line);

    if (!handle) {
      return {
        base_generation: null, would_admit_generation: null, would_admit_generation_decimal: null,
        form: null, refs: {}, head_target: null, objects: [], object_count: null,
        encrypted_bytes: null, raw_bytes: null,
        allocation_needed: true, snapshot, gitvault_commit: snapshot.oid, gitvault_commit_line: line,
      };
    }

    const { deployRefTransaction } = await this.#publication();
    const materialized = await handle.vault.materialize();
    const push: GitvaultPushOptions = {
      transaction: deployRefTransaction(materialized.refs, snapshot.oid),
      head_target: snapshot.head,
      protocol_refs: "allow", // same opt-in `push()` makes for the SAME move — see its doc comment.
      ...(options.checkpoint ? { checkpoint: true } : {}),
    };
    const plan = await handle.vault.planPush(push);
    return { ...plan, allocation_needed: false, snapshot, gitvault_commit: snapshot.oid, gitvault_commit_line: line };
  }

  /**
   * Compaction's transient-storage preflight
   * (gitvault-compaction-headroom-preflight, design D1/D2).
   *
   * Three postures, in order of information quality:
   *   1. the check answers "won't fit" → typed refusal, before any upload;
   *   2. the caller passed the override → proceed, marked `overridden`;
   *   3. the check CANNOT be answered → proceed after one stderr note.
   *
   * (3) is deliberate: failing closed on ignorance would make compaction's
   * availability depend on an ADVISORY read, which is wrong for a maintenance
   * verb whose refusals must come from the authority that owns the quota.
   *
   * The size proxy is the vault's billed `source_bytes` (D1). The true
   * checkpoint-pack size is unknowable before packing, but it is bounded above
   * by — and usually near — the vault's live content. Deliberately
   * conservative when history exceeds live content; the override exists
   * precisely because a proxy can overestimate.
   */
  /**
   * Read compaction's transient-storage arithmetic WITHOUT compacting — the
   * same figures `compact` preflights on, with none of its policy. `repos gc`
   * uses it to disclose headroom on the `--submit` half, where no compaction
   * runs but the numbers are just as worth showing. `null` when the pooled
   * figures cannot be read.
   */
  async compactHeadroom(options: GitvaultVaultHandleOptions = {}): Promise<GitvaultCompactHeadroom | null> {
    // Deliberately resolves the repo id rather than `open()`ing: this is two
    // control-plane reads and arithmetic, so it needs no keystore, no
    // transport, and no Node runtime.
    return this.#readCompactHeadroom(await this.#resolveRepoId(options));
  }

  /**
   * Open this vault's compaction headroom grant directly (gitvault-checkpoint-cadence
   * design D3) — `compact()` already does this internally; this standalone
   * entry point exists for callers that need to inspect or drive the grant
   * without also running a full compaction cycle (tests; a future
   * operator/diagnostic surface). Throws `GITVAULT_COMPACTION_GRANT_ACTIVE`
   * (409) verbatim when another compaction already holds this project's
   * grant.
   */
  async openCompactionGrant(options: GitvaultVaultHandleOptions = {}): Promise<GitvaultCompactionGrant> {
    const handle = await this.open(options);
    return handle.vault.openCompactionGrant();
  }

  /** Close this vault's compaction headroom grant directly — idempotent; `{closed: false}` when nothing was active. */
  async closeCompactionGrant(options: GitvaultVaultHandleOptions = {}): Promise<{ closed: boolean }> {
    const handle = await this.open(options);
    return handle.vault.closeCompactionGrant();
  }

  /**
   * The arithmetic, with no policy: the block, or `null` when unanswerable.
   *
   * `effectiveLimitOverride` (gitvault-checkpoint-cadence design D3): when a
   * compaction grant is active for this cycle, `compact()` passes the
   * grant's `effective_pool_limit_bytes` here so `ok`/`projected_transient_bytes`
   * reflect the RAISED limit — `pool_limit_bytes` itself always stays the
   * tier's own figure (never the raised one), so disclosure never implies
   * the tier grew.
   */
  async #readCompactHeadroom(repoId: string, effectiveLimitOverride?: number | string): Promise<GitvaultCompactHeadroom | null> {
    /** Posture (3): one note, on stderr, and `null` — never a throw. */
    const unanswerable = (why: string): null => {
      globalThis.console?.error?.(`run402: could not check compaction storage headroom (${why}); proceeding — the platform's storage quota remains authoritative.`);
      return null;
    };

    let poolUsed: number;
    let poolLimit: number;
    let sourceBytes: number;
    try {
      const [record, tier] = await Promise.all([
        this.get(repoId),
        this.#client.request<{ pool_usage?: { total_storage_bytes?: number; storage_bytes_limit?: number } }>("/tiers/v1/status", {
          context: "reading pooled tier storage for the compaction headroom preflight",
        }),
      ]);
      poolUsed = Number(tier.pool_usage?.total_storage_bytes);
      poolLimit = Number(tier.pool_usage?.storage_bytes_limit);
      sourceBytes = Number(record.storage?.source_bytes ?? "0");
    } catch (e) {
      return unanswerable(e instanceof Error ? e.message : String(e));
    }
    // Shape drift in the tier-status response reads the same as an unreadable
    // one — an advisory that cannot be computed must not be guessed at.
    if (!Number.isFinite(poolUsed) || !Number.isFinite(poolLimit) || !Number.isFinite(sourceBytes) || poolLimit <= 0) {
      return unanswerable("tier status carried no usable pooled-storage figures");
    }

    // The grant's byte fields arrive as STRINGS on the wire (gateway BIGINT
    // serialization, verified live) — coerce BEFORE the finiteness gate, or
    // `Number.isFinite("472697418")` (false, no coercion) silently discards
    // an opened grant and the preflight refuses with the unraised limit.
    const overrideNum = effectiveLimitOverride === undefined ? Number.NaN : Number(effectiveLimitOverride);
    const effectiveLimit = Number.isFinite(overrideNum) && overrideNum > 0 ? overrideNum : poolLimit;
    const projected = poolUsed + sourceBytes;
    return {
      pool_used_bytes: poolUsed,
      pool_limit_bytes: poolLimit,
      vault_source_bytes: sourceBytes,
      projected_transient_bytes: projected,
      ok: projected <= effectiveLimit,
      overridden: false,
      ...(effectiveLimit !== poolLimit ? { effective_pool_limit_bytes: effectiveLimit } : {}),
    };
  }

  /** The reader plus compaction's policy (refuse / override / proceed). */
  async #compactHeadroomPreflight(repoId: string, ignore: boolean, effectiveLimitOverride?: number | string): Promise<GitvaultCompactHeadroom | null> {
    const headroom = await this.#readCompactHeadroom(repoId, effectiveLimitOverride);
    if (headroom === null) return null;
    const { pool_used_bytes: poolUsed, pool_limit_bytes: poolLimit, vault_source_bytes: sourceBytes, projected_transient_bytes: projected, ok, effective_pool_limit_bytes: effectiveLimit } = headroom;
    if (!ok && !ignore) {
      const limitForMessage = effectiveLimit ?? poolLimit;
      throw new LocalError(
        `compaction needs about ${mib(sourceBytes)} of transient headroom and the org's pooled storage has ${mib(Math.max(limitForMessage - poolUsed, 0))} free ` +
          `(${mib(poolUsed)} used of ${mib(limitForMessage)}${effectiveLimit !== undefined ? ` — includes an active compaction grant raising the ${mib(poolLimit)} tier limit` : ""}; projected ${mib(projected)}). Compaction transiently holds BOTH the new checkpoint and the ` +
          `not-yet-pruned history — roughly 2x source_bytes — until a prune completes. Free storage, raise the tier, or re-run with --force-headroom ` +
          `(the platform's own quota enforcement stays authoritative either way).`,
        "preflighting gitvault compaction storage headroom",
        {
          code: "GITVAULT_COMPACT_INSUFFICIENT_HEADROOM",
          details: {
            pool_used_bytes: poolUsed,
            pool_limit_bytes: poolLimit,
            vault_source_bytes: sourceBytes,
            projected_transient_bytes: projected,
            ...(effectiveLimit !== undefined ? { effective_pool_limit_bytes: effectiveLimit } : {}),
            override: "--force-headroom",
          },
        },
      );
    }
    return { ...headroom, overridden: !ok && ignore };
  }

  /** A 409 `GITVAULT_COMPACTION_GRANT_ACTIVE` refusal — another compaction already holds this project's grant. */
  #isCompactionGrantActive(e: unknown): e is { status?: number; code?: string; details?: { expires_at?: string } } {
    const err = e as { status?: number; code?: string } | null;
    return Boolean(err && err.code === "GITVAULT_COMPACTION_GRANT_ACTIVE");
  }

  /**
   * Open this vault's compaction headroom grant, shared by `compact()` and
   * `prune({ submit })` — both write ceremony
   * objects into the vault and both need the same single-flight-per-vault
   * headroom slot. Four outcomes:
   *   - opened: the grant is returned, carrying `effective_pool_limit_bytes`.
   *   - 409 `GITVAULT_COMPACTION_GRANT_ACTIVE`: another maintenance op (this
   *     process, another process, auto-gc, or a manual `repos gc`) already
   *     holds this project's one-at-a-time grant — refuse rather than race
   *     it, surfaced as the identical single-flight-conflict `LocalError`
   *     every caller of this helper throws.
   *   - 404/absent route (an older gateway): proceed ungranted exactly as
   *     before this grant existed — returns `null`.
   *   - any OTHER failure (network, 5xx): also proceeds ungranted — a grant
   *     that could not be confirmed open must never be ASSUMED open, and
   *     failing the whole caller because an ancillary raise-the-limit call
   *     errored would make routine maintenance depend on an availability
   *     property narrower than the caller itself needs.
   */
  async #openMaintenanceGrantOrConflict(handle: GitvaultHandle, context: string): Promise<GitvaultCompactionGrant | null> {
    try {
      return await handle.vault.openCompactionGrant();
    } catch (e) {
      if (this.#isCompactionGrantActive(e)) {
        throw new LocalError(
          `another compaction is already in progress for this vault (its headroom grant expires ${(e as { details?: { expires_at?: string } }).details?.expires_at ?? "soon"}) — refusing to race it.`,
          context,
          { code: "GITVAULT_COMPACTION_IN_PROGRESS", details: { expires_at: (e as { details?: { expires_at?: string } }).details?.expires_at ?? null } },
        );
      }
      // 404/absent-route or any other failure: proceed ungranted.
      return null;
    }
  }

  /**
   * Publish a checkpoint covering the canonical refs, every root unexpired at
   * the cutoff, and the `HEAD` target — under a maintenance lease so a
   * concurrent cycle cannot race it.
   *
   * The lease's `holder_token` is held in memory for the duration and released
   * in a `finally`; it is never returned to the caller, logged, or cached.
   * A repository beyond the V0 checkpoint maximum is refused at preflight with
   * `CHECKPOINT_SET_LIMIT_EXCEEDED`.
   */
  async compact(
    options: GitvaultVaultHandleOptions & {
      /** Skip the lease entirely (single-writer situations, tests). */
      lease?: boolean;
      /**
       * The cycle's reservation sizes. Both default to `"0"` — a ZERO
       * reservation, which is honest but not free: the control plane reserves
       * nothing, so a cycle whose objects exceed the (absent) headroom can be
       * refused mid-flight rather than at preflight. Supply real figures once
       * the caller can size the checkpoint it is about to write.
       */
      r1_size_bytes?: string;
      r2_cap_size_bytes?: string;
      /**
       * Proceed even when the transient-storage preflight says the org's
       * pooled tier storage cannot hold both the new checkpoint and the
       * not-yet-pruned history. The platform's own quota enforcement remains
       * the authority either way — this only skips the earlier, more legible
       * refusal. CLI: `--force-headroom`.
       */
      ignoreHeadroom?: boolean;
    } = {},
  ): Promise<GitvaultCompactResult> {
    const handle = await this.open(options);

    // gitvault-checkpoint-cadence design D3: open the compaction headroom
    // grant BEFORE the preflight (which needs its raised limit) and before
    // any checkpoint is built or uploaded — same ordering rule as the
    // preflight itself. Outcomes are documented on
    // {@link GitvaultNamespace.#openMaintenanceGrantOrConflict}.
    const grant = await this.#openMaintenanceGrantOrConflict(handle, "opening the gitvault compaction headroom grant");

    // Everything from here on is bracketed by the grant's own lifetime —
    // including the preflight's OWN possible throw (`GITVAULT_COMPACT_
    // INSUFFICIENT_HEADROOM`) — so a refusal still closes a grant this call
    // opened rather than leaking it until the gateway's hourly sweep.
    try {
      return await this.#compactAfterGrant(handle, options, grant);
    } finally {
      if (grant) await handle.vault.closeCompactionGrant().catch(() => undefined);
    }
  }

  /** The rest of `compact()`, run under an already-opened-or-skipped grant — split out so the grant's `finally` above covers every exit path, including the preflight's own throw. */
  async #compactAfterGrant(
    handle: GitvaultHandle,
    options: { lease?: boolean; r1_size_bytes?: string; r2_cap_size_bytes?: string; ignoreHeadroom?: boolean },
    grant: GitvaultCompactionGrant | null,
  ): Promise<GitvaultCompactResult> {
    // BEFORE any checkpoint is built or uploaded (that ordering is the whole
    // point — see GitvaultCompactHeadroom).
    const headroom = await this.#compactHeadroomPreflight(handle.repo_id, options.ignoreHeadroom === true, grant?.effective_pool_limit_bytes);

    const base = await handle.vault.materialize();

    let lease: GitvaultMaintenanceLease | null = null;
    if (options.lease !== false) {
      lease = await this.acquireMaintenanceLease({
        repo_id: handle.repo_id,
        base_head_sha256: base.head_sha256,
        current_checkpoint_hash: base.head?.checkpoint?.claim_set.stored_bytes_sha256 ?? null,
        r1_size_bytes: options.r1_size_bytes ?? "0",
        r2_cap_size_bytes: options.r2_cap_size_bytes ?? "0",
      }).catch(() => null);
    }

    try {
      // A cutoff ticket lets EXPIRED roots leave the map. Without one the roots
      // are RETAINED — expiry is permissive by design, so an unavailable ticket
      // costs storage, never history.
      let cutoffBound = true;
      let published: GitvaultPublishResult;
      try {
        published = await handle.vault.publishCheckpoint({ cutoff: {} });
      } catch (e) {
        if (!isMissingCutoffRoute(e)) throw e;
        cutoffBound = false;
        published = await handle.vault.publishCheckpoint({ cutoff: false });
      }
      return {
        generation: published.generation,
        head_sha256: published.head_sha256,
        form: published.form,
        maintenance_lease_id: lease?.maintenance_lease_id ?? null,
        cutoff_bound: cutoffBound,
        covered_refs: Object.keys(published.refs).length,
        covered_roots: base.roots.length,
        headroom: headroom && grant ? { ...headroom, compaction_grant: { granted_bytes: Number(grant.granted_bytes), expires_at: grant.expires_at } } : headroom,
      };
    } finally {
      if (lease) {
        await this.#client
          .request(`/gitvault/v1/vaults/${encodeURIComponent(handle.repo_id)}/maintenance-leases/${encodeURIComponent(lease.maintenance_lease_id)}`, { method: "DELETE", body: { holder_token: lease.holder_token }, context: "releasing the gitvault maintenance lease" })
          .catch(() => undefined);
      }
      // The compaction headroom grant (if one was opened) is closed by the
      // caller — `compact()`'s own `finally`, which wraps this ENTIRE
      // method so a preflight refusal closes it too. Design D3's rationale
      // for closing promptly (prune only ever REMOVES objects, so nothing
      // past the checkpoint publish needs the raised limit) lives there.
    }
  }

  /**
   * Plan a prune — and, with both verifier receipts in hand, submit it.
   *
   * TWO PHASES, because the protocol is two-phase (§7.3) and no amount of API
   * sugar can collapse it:
   *
   *   1. `prune()` walks the verified chain, computes the GC root set, subtracts
   *      it from the pruneable universe, and returns a SIGNED
   *      `prune_intent_core` plus its `intent_core_sha256`. Nothing is
   *      submitted and nothing is deleted.
   *   2. Run `r402s-verify` against that core, then call
   *      `prune({ submit: { core, verifier_receipt } })` with the core
   *      ROUND-TRIPPED VERBATIM. This SDK produces its own `run402-cli` receipt
   *      by restoring the latest checkpoint and recomputing its commitments;
   *      the second receipt is `r402s-verify`'s and is never synthesized here,
   *      because two receipts from one lineage prove nothing.
   *
   * The `deleted` list in the result comes from the control-plane-signed
   * completion and nothing else. `present_after_attempt` is a FAILED deletion
   * and is never counted as one.
   */
  async prune(
    options: GitvaultVaultHandleOptions & {
      now?: () => Date;
      /**
       * `effective_admitted_at` for a root's drop generation, or `null` when
       * this client cannot resolve it. A `null` RETAINS the root: expiry is
       * permissive, and `effective_admitted_at = max(prepared_at, the admission
       * record's storage creation time)` — deriving it from `prepared_at` alone
       * would SHORTEN the retention lane, which the protocol forbids.
       */
      effective_admitted_at?: (droppedAtGeneration: string) => string | null;
      /**
       * Submit the plan. `core` MUST be the exact object a prior `prune()`
       * returned, and `verifier_receipt` MUST be `r402s-verify`'s receipt over
       * that core's `intent_core_sha256`.
       */
      submit?: {
        core: import("../node/gitvault-prune.js").GitvaultPruneIntentCore;
        verifier_receipt: import("../node/gitvault-prune.js").GitvaultVerifierReceipt;
        /** Poll budget for the signed completion. Absent ⇒ submit and report the intent without waiting. */
        wait?: { attempts?: number; interval_ms?: number };
      };
    } = {},
  ): Promise<GitvaultPruneResult> {
    const pub = await this.#publication();
    const prune = await this.#prune();
    const { isRootEligibleForRemoval, GITVAULT_RETENTION_MIN_DAYS } = pub;
    const handle = await this.open(options);
    const base = await handle.vault.materialize();
    const cutoffAt = (options.now ?? (() => new Date()))().toISOString();
    const resolve = options.effective_admitted_at ?? (() => null);

    // ── the retention-ROOT view (unchanged) ──
    const candidates: GitvaultPruneCandidate[] = base.roots.map((root) => {
      const admittedAt = resolve(root.dropped_at_generation);
      const eligible = admittedAt !== null && isRootEligibleForRemoval(admittedAt, cutoffAt);
      return {
        ref: root.ref,
        oid: root.oid,
        dropped_at_generation: root.dropped_at_generation,
        eligible,
        reason:
          admittedAt === null
            ? "this client cannot resolve the drop's effective_admitted_at, which RETAINS the root — expiry is permissive by design"
            : eligible
              ? `dropped more than ${GITVAULT_RETENTION_MIN_DAYS} days before the cutoff; removable at the next checkpoint-bearing generation, then at the next successful prune`
              : `still inside the ${GITVAULT_RETENTION_MIN_DAYS}-day retention window`,
      };
    });
    const rootView = {
      candidates,
      eligible_count: candidates.filter((c) => c.eligible).length,
      retained_count: candidates.filter((c) => !c.eligible).length,
    };

    // ── the OBJECT view: universe − GC root set ──
    const entries = await handle.vault.chainEntries();
    const plan = prune.planPruneCandidates(entries);
    const objectCandidates: GitvaultPruneObjectCandidate[] = plan.candidates.map((r) => ({ object_id: r.object_id, object_kind: r.object_kind, size_bytes: r.size_bytes }));
    const blocked =
      plan.root_set.blocked_reason ??
      (plan.candidates.length === 0 ? "every stored object is still inside the GC root set — nothing is superseded yet" : null);

    if (blocked || !plan.root_set.latest_checkpoint) {
      return {
        ...rootView,
        object_candidates: objectCandidates,
        deferred_object_count: plan.deferred_count,
        blocked_reason: blocked,
        intent_core: null,
        intent_core_sha256: null,
        attestation: null,
        submitted: false,
        intent: null,
        confirmation: null,
        note: `no prune intent was built: ${blocked}. Retention is an operational promise of the platform, not a cryptographic guarantee against it.`,
      };
    }

    // ── restore-and-verify the latest checkpoint: the receipt's evidence ──
    const latest = plan.root_set.latest_checkpoint;
    const attestation = await handle.vault.verifyStoredCheckpoint(latest.head, latest.head_sha256);
    if (attestation.cutoff_ticket_sha256 === null) {
      return {
        ...rootView,
        object_candidates: objectCandidates,
        deferred_object_count: plan.deferred_count,
        blocked_reason: "the latest checkpoint binds no retention_cutoff ticket, so no root's window can be evaluated and no prune is authorizable",
        intent_core: null,
        intent_core_sha256: null,
        attestation,
        submitted: false,
        intent: null,
        confirmation: null,
        note: "run `run402 repos gc` to publish a checkpoint bound to a fresh retention_cutoff ticket, then plan the prune again.",
      };
    }

    const record = await handle.vault.transport.getVaultRecord({ repo_id: handle.repo_id });
    const gcRootSetHmac = handle.vault.keyedDigest("gcrootset", { receipts: plan.root_set.receipts });
    const core =
      options.submit?.core ??
      prune.buildPruneIntentCore(
        {
          repo_id: handle.repo_id,
          gc_epoch: record.gc_epoch,
          authorizing_head_sha256: base.head_sha256,
          checkpoint_claim_set_sha256: attestation.claim_set_sha256,
          gc_root_set_hmac: gcRootSetHmac,
          retention_state_hmac: attestation.retention_state_hmac,
          delete_set: plan.candidates,
        },
        handle.vault.signer(),
      );
    const coreSha = prune.pruneIntentCoreSha256(core);
    // A supplied core may have been planned against a chain that has since
    // moved. The rule lives in the prune module (and is unit-tested there); the
    // namespace only supplies the current facts.
    if (options.submit) {
      prune.assertPruneCoreStillCurrent(core, { repo_id: handle.repo_id, gc_epoch: record.gc_epoch, checkpoint_claim_set_sha256: attestation.claim_set_sha256 });
    }
    // Faithful: when a core was supplied, report ITS candidates — the ones
    // actually submitted — not a freshly-planned set that may differ.
    const reportedCandidates: GitvaultPruneObjectCandidate[] = options.submit
      ? core.delete_set.map((r) => ({ object_id: r.object_id, object_kind: r.object_kind, size_bytes: r.size_bytes }))
      : objectCandidates;
    const planned: GitvaultPruneResult = {
      ...rootView,
      object_candidates: reportedCandidates,
      deferred_object_count: plan.deferred_count,
      blocked_reason: null,
      intent_core: core,
      intent_core_sha256: coreSha,
      attestation,
      submitted: false,
      intent: null,
      confirmation: null,
      note:
        "planned, not submitted. Run r402s-verify against this intent_core, then call prune({ submit: { core, verifier_receipt } }) " +
        "with the core round-tripped verbatim — a rebuilt core carries a different nonce and the receipt would no longer bind to it.",
    };
    if (!options.submit) return planned;

    // ── attest, upload both receipts, submit the exact bytes ──
    const rootsEvolution = await this.#checkRootsEvolution(handle, entries, resolve, isRootEligibleForRemoval, attestation.cutoff_at);
    const candidateIds = new Set(core.delete_set.map((r) => r.object_id));
    const outsideRoots = plan.root_set.receipts.every((r) => !candidateIds.has(r.object_id));
    const ours = prune.buildVerifierReceipt(
      {
        repo_id: handle.repo_id,
        intent_core_sha256: coreSha,
        checkpoint_head_sha256: attestation.checkpoint_head_sha256,
        cutoff_ticket_sha256: attestation.cutoff_ticket_sha256,
        restored_object_set_hmac: attestation.restored_object_set_hmac,
        // Both booleans are OBSERVATIONS. A false one produces a `failed`
        // receipt and `buildPruneIntent` then refuses — which is the point:
        // the SDK never signs an attestation it did not earn.
        retention_evolution_ok: rootsEvolution.ok && attestation.object_set_matches && attestation.ref_state_matches && attestation.retention_roots_matches,
        candidates_outside_roots_ok: outsideRoots,
        implementation_id: prune.GITVAULT_SDK_VERIFIER_IMPLEMENTATION,
        implementation_version: prune.GITVAULT_SDK_VERIFIER_VERSION,
      },
      handle.vault.signer(),
    );
    const intent = prune.buildPruneIntent(core, [ours, options.submit.verifier_receipt], handle.vault.signer());

    // The submission writes ~8 KB of ceremony
    // objects (both verifier receipts + the intent) into the vault — on a
    // vault that is over-quota BECAUSE it just compacted, that write is
    // refused QUOTA_EXCEEDED, so the deletion's own paperwork is blocked by
    // the storage the deletion would free. Bracket the upload+submit with
    // the SAME compaction headroom grant `compact()` uses (design D3, via
    // the shared `#openMaintenanceGrantOrConflict`) — opened before the
    // upload, closed in a `finally` regardless of outcome.
    const grant = await this.#openMaintenanceGrantOrConflict(handle, "opening the gitvault compaction headroom grant for prune submission");
    let stored: import("../node/gitvault-prune.js").GitvaultPruneIntentRecord & { stored: boolean };
    try {
      await this.#uploadVerifierReceipts(handle, pub, [ours, options.submit.verifier_receipt]);
      stored = await handle.vault.transport.submitPruneIntent({ repo_id: handle.repo_id, intent_bytes: prune.pruneIntentBytes(intent) });
    } finally {
      if (grant) await handle.vault.closeCompactionGrant().catch(() => undefined);
    }
    let intentRecord: import("../node/gitvault-prune.js").GitvaultPruneIntentRecord | null = stored;
    const wait = options.submit.wait;
    if (wait) {
      const attempts = wait.attempts ?? 20;
      const intervalMs = wait.interval_ms ?? 3_000;
      for (let i = 0; i < attempts && !(intentRecord?.completion ?? null); i++) {
        await new Promise((r) => setTimeout(r, intervalMs));
        intentRecord = await handle.vault.transport.getPruneIntent({ repo_id: handle.repo_id, prune_intent_object_id: intent.object_id });
      }
    }
    const confirmation = prune.summarizePruneCompletion(core.delete_set.map((r) => r.object_id), intentRecord);
    return {
      ...planned,
      submitted: true,
      intent: intentRecord,
      confirmation,
      note:
        confirmation.outcome === null
          ? "the intent is accepted and the gateway's worker drives deletion; poll it until a signed completion appears. Nothing is deleted until the completion says so."
          : `the signed completion confirms ${confirmation.deleted.length} object(s) deleted and ${confirmation.present.length} still present. Only \`deleted\` means the bytes are gone.`,
    };
  }

  /** Upload both receipts so the gateway can claim them at the intent's fence. */
  async #uploadVerifierReceipts(
    handle: GitvaultHandle,
    pub: PublicationModule,
    receipts: readonly import("../node/gitvault-prune.js").GitvaultVerifierReceipt[],
  ): Promise<void> {
    const { storedBytes, sha256Hex } = await import("./gitvault.crypto.js");
    const objects = receipts.map((r) => {
      const bytes = storedBytes(r as unknown as import("./gitvault.types.js").GitvaultSignedObject);
      return {
        path: pub.gitvaultPaths.verifierReceipt(r.object_id),
        object_kind: "verifier_receipt",
        object_id: r.object_id,
        bytes,
        sha256: sha256Hex(bytes),
        size_bytes: String(bytes.length),
      };
    });
    try {
      await handle.vault.transport.uploadObjects({ repo_id: handle.repo_id, objects });
    } catch (e) {
      // Receipt object ids are DETERMINISTIC —
      // the same core + the same signer produce the same id on every retry —
      // and Ed25519 signing is deterministic too, so the SAME id can only
      // mean the SAME bytes when nothing about the receipt's content
      // changed. Ids are never reusable server-side (correct, the ledger's
      // rule) — but that means ANY failed submit AFTER this upload landed
      // (a later validation refusal, a network blip, a crash) burns both
      // ids for every future retry, with no recovery but a full re-plan
      // (new core, new nonce, new r402s-verify run). Recover instead: for
      // each id the gateway names as reused, read the STORED object back
      // and compare its bytes to ours — same bytes means already-uploaded,
      // different bytes means the id is genuinely burned.
      const reused = this.#reusedObjectIds(e);
      if (reused === null) throw e;
      const remaining: typeof objects = [];
      for (const o of objects) {
        if (!reused.includes(o.object_id)) {
          remaining.push(o);
          continue;
        }
        const existing = await handle.vault.transport.getObject({ repo_id: handle.repo_id, path: o.path });
        const existingSha256 = existing ? sha256Hex(existing) : null;
        if (existing && existingSha256 === o.sha256) continue; // identical bytes already landed — nothing to do
        throw new LocalError(
          existing
            ? `verifier receipt ${o.object_id} already exists in the vault with DIFFERENT bytes than this attempt's (stored sha256 ${existingSha256}, this attempt's sha256 ${o.sha256}) — the object id is burned and cannot be reused; re-plan the prune (new core, new nonce, new r402s-verify run).`
            : `verifier receipt ${o.object_id} was refused as an already-used id, but its stored bytes could not be read back to confirm they match — re-plan the prune.`,
          "uploading gitvault verifier receipts",
          { code: "GITVAULT_RECEIPT_ID_REUSED_DIFFERENT", details: { object_id: o.object_id, existing_sha256: existingSha256, this_attempt_sha256: o.sha256 } },
        );
      }
      // Every reused id was confirmed identical to ours; anything NOT
      // reused (a genuinely new upload, or the other side of a partial
      // race) still needs to land.
      if (remaining.length > 0) await handle.vault.transport.uploadObjects({ repo_id: handle.repo_id, objects: remaining });
    }
  }

  /**
   * `VALIDATION_FAILED` with `details.reused_object_ids`
   * (`services/gitvault/upload-sessions.ts`: "an object id in the manifest is
   * already used") — object ids a prior attempt already landed. `null` for
   * any other failure, so the caller rethrows it untouched.
   */
  #reusedObjectIds(e: unknown): string[] | null {
    if (!isRun402Error(e) || e.code !== "VALIDATION_FAILED") return null;
    const details = e.details;
    if (!details || typeof details !== "object" || Array.isArray(details)) return null;
    const ids = (details as { reused_object_ids?: unknown }).reused_object_ids;
    return Array.isArray(ids) && ids.every((id) => typeof id === "string") ? (ids as string[]) : null;
  }

  /** Did every retention root that LEFT the map leave legally? A `false` here is honest, not fatal. */
  async #checkRootsEvolution(
    handle: GitvaultHandle,
    entries: Array<{ head: import("./gitvault.types.js").GitvaultHead; head_sha256: string; claim_set: unknown }>,
    resolve: (droppedAtGeneration: string) => string | null,
    isEligible: (effectiveAdmittedAtIso: string, cutoffAtIso: string) => boolean,
    _cutoffAt: string | null,
  ): Promise<{ ok: boolean; unproven: Array<{ generation: string; ref: string; oid: string; reason: string }> }> {
    const { checkRetentionEvolution } = await this.#prune();
    const rootsByGeneration = new Map<string, Array<{ ref: string; oid: string; dropped_at_generation: string }>>();
    for (const e of entries) {
      const carrier = await handle.vault.openRetentionRootsAt(e.head.retention_roots);
      rootsByGeneration.set(e.head.generation, carrier.roots.map((r) => ({ ref: r.ref, oid: r.oid, dropped_at_generation: r.dropped_at_generation })));
    }
    return checkRetentionEvolution(
      entries as never,
      (entry) => rootsByGeneration.get(entry.head.generation) ?? [],
      resolve,
      isEligible,
    );
  }

  /**
   * Verify the head chain from the authenticated pin up to the newest listed
   * generation, then return the verified state.
   *
   * Fails closed: a regression below the pin is `GENERATION_REGRESSION`, a gap
   * or bad link is `CHAIN_BROKEN`, an unvalidatable transition descriptor is
   * `UPGRADE_REQUIRED` (read-only past it, never skipped). The verification
   * budget is resumable — a `VERIFICATION_BUDGET_EXCEEDED` client continues
   * from its verified prefix rather than restarting.
   */
  async verify(options: GitvaultVaultHandleOptions & { persist?: boolean } = {}): Promise<GitvaultVerifiedState> {
    const handle = await this.open(options);
    return handle.vault.verifyToNewest({ persist: options.persist ?? true });
  }

  /**
   * `repos fsck` (repo-surface-consolidation D2/D3): walk the head chain
   * AND materialize the ref map, reporting
   * BOTH local trust pins — authenticated and materialized — before and
   * after, with an explicit `local_state_changed` flag. This is the one
   * place chain materialization and pin advance live; `view` never
   * calls it.
   *
   * `options.write` (default `true`) is the inverse of the CLI's
   * `--no-write`: `false` still walks, verifies, and decrypt-validates
   * everything (the returned `refs`/`chain_verified_to_generation`/
   * `decryptable_to_generation` are real, computed answers, not estimates)
   * but persists neither pin — a genuine audit mode, not a simulation.
   * `options.mirror` additionally runs the keyless mirror verification
   * ({@link mirrorVerify}) and folds its report in; that half proves the
   * mirror's validity, never its freshness (its own honesty statements ride
   * the result unchanged).
   *
   * **Request 1 (decrypt-validation, D193-D203 rev 42).** `fsck` walks the
   * chain in TOLERANT decrypt-validation mode
   * (`verifyToNewest({decryptValidate: true, strict: false})`) rather than
   * the ordinary fail-closed `materialize()` — chain/signature verification
   * ALWAYS reaches the true newest generation regardless of decrypt
   * capability (an admitted `rotate_epoch` is keylessly structural), and a
   * generation this call cannot actually DECRYPT is never again reported as
   * bare "verified": `chain_verified_to_generation` and
   * `decryptable_to_generation` are reported separately and can genuinely
   * differ — the incident-shape truth ("chain verified to 10, decryptable
   * to 7, `GITVAULT_EPOCH_NOT_OPENABLE` at epoch 2/rotation …") is exactly
   * what this split makes representable. `refs`/`head_target`/
   * `pin_after.highest_materialized` all reflect `decryptable_to_generation`.
   *
   * **gitvault-byo-primary-bucket task 3.3 (design D6).** For a
   * `storage_profile: "byo"` vault, `fsck` ALSO adjudicates the customer's
   * own bucket against run402's signed chain — see {@link
   * #checkByoPresence} for the full contract (automatic, never a flag;
   * fails soft with no local credentials; throws
   * `GITVAULT_BYO_OBJECT_MISSING` on a confirmed absence). A managed vault
   * is byte-identical to before this task.
   */
  async fsck(options: GitvaultVaultHandleOptions & { write?: boolean; mirror?: boolean } = {}): Promise<GitvaultFsckResult> {
    const before = await this.status(options);
    const repoId = before.repo_id;
    if (!repoId) {
      throw new LocalError(
        options.repo_id || options.project_id
          ? "no vault is allocated for this project yet — nothing to fsck"
          : "pass repo_id, or project_id to resolve it from the control plane",
        "running gitvault fsck",
        { code: "GITVAULT_VAULT_UNRESOLVED", details: { project_id: options.project_id ?? null } },
      );
    }
    const write = options.write ?? true;
    // gitvault-agent-envelopes D5: fsck is observational — it never wraps an
    // envelope, in write mode or not. Investigating a suspicious pending
    // recipient must not complete the disclosure being investigated.
    const handle = await this.open({ ...options, repo_id: repoId, reconcile: "forbidden" });
    const state = await handle.vault.verifyToNewest({ persist: write, decryptValidate: true, strict: false });
    const mirror = options.mirror ? await this.mirrorVerify({ ...options, repo_id: repoId }) : null;

    const decrypt = state.decrypt!; // decryptValidate: true always populates this
    const decryptableToGeneration = decrypt.decryptable_to_generation;
    const refs = decrypt.ref_state ? { ...decrypt.ref_state.refs } : {};
    const roots = decrypt.retention_roots ? decrypt.retention_roots.roots.map((r) => ({ ...r })) : [];
    const headTarget = decrypt.ref_state?.head_target ?? null;

    const pinBefore = { highest_authenticated: before.pins.highest_authenticated, highest_materialized: before.pins.highest_materialized };
    const pinAfter = write
      ? { highest_authenticated: state.generation, highest_materialized: decryptableToGeneration }
      : pinBefore;
    const localStateChanged = write && (pinBefore.highest_authenticated !== pinAfter.highest_authenticated || pinBefore.highest_materialized !== pinAfter.highest_materialized);

    // clone-installs-retained-refs (D2, task 1.3): the SAME reconcile the
    // fetch path drives, run here so `repos fsck` heals a pre-change clone
    // (or a checkout whose original write degraded per D3) in one call.
    // `write: false` stays a genuine audit mode — nothing local is persisted,
    // refs included — and no `repo_dir` (or one that is not itself a git
    // repository — fsck addresses a vault by repo_id/project_id alone as
    // often as by a checkout) is an ordinary, silent no-op. Reconciled AS OF
    // `decryptableToGeneration` — the retained-refs bookkeeping is only ever
    // meaningful for state this call actually decrypted.
    let retainedRefs: import("../node/gitvault-publication.js").GitvaultRetainedRefsReconcileResult | null = null;
    if (write && options.repo_dir) {
      const { reconcileRetainedTipRefs } = await this.#publication();
      retainedRefs = await reconcileRetainedTipRefs(options.repo_dir, { refs, roots, head_target: headTarget ?? { kind: "symref", ref: "refs/heads/main" } });
    }

    // D210 (rev 44): best-effort proof-of-open submission — see
    // #submitFsckOpenProof's own doc comment for the write/audit-mode
    // gating and why a failure here never touches anything above.
    const openProof = await this.#submitFsckOpenProof(write, repoId, handle, {
      chain_verified_to_generation: state.generation,
      decryptable_to_generation: decryptableToGeneration,
    });

    // gitvault-byo-primary-bucket task 3.3 (design D6) — LAST, deliberately:
    // everything above (chain verify + its pin persist, retained-refs
    // reconcile, open-proof submission) is real, valid work regardless of
    // what the customer's own bucket holds — the signed chain is run402-
    // authoritative either way (design D9) — so a missing-object refusal
    // below must never cost any of it. See `#checkByoPresence`'s own doc
    // comment for the throw/no-throw split.
    const byoPresence = await this.#checkByoPresence(before.vault, repoId, handle.keystore);

    return {
      repo_id: repoId,
      write,
      verified_from_generation: pinBefore.highest_authenticated,
      verified_to_generation: state.generation,
      chain_verified_to_generation: state.generation,
      decryptable_to_generation: decryptableToGeneration,
      epoch_decrypt_failure: decrypt.failure,
      local_state_changed: localStateChanged,
      pin_before: pinBefore,
      pin_after: pinAfter,
      refs,
      head_target: headTarget,
      mirror,
      retained_refs: retainedRefs,
      open_proof: openProof,
      ...(byoPresence !== undefined ? { byo_presence: byoPresence } : {}),
    };
  }

  /**
   * D210 (rev 44) — `fsck`'s own best-effort proof-of-open submission. Thin
   * wrapper over {@link computeOpenProofOutcome} (the testable decision
   * function) supplying THIS instance's real `whoami`/`submit`
   * dependencies. See that function's own doc comment for the full
   * write/audit-mode gating and failure-containment contract.
   */
  async #submitFsckOpenProof(
    write: boolean,
    repoId: string,
    handle: GitvaultHandle,
    evidence: { chain_verified_to_generation: string; decryptable_to_generation: string },
  ): Promise<GitvaultOpenProofOutcome> {
    return computeOpenProofOutcome({
      write,
      ekFingerprint: handle.keystore.readIdentity()?.encryption_fingerprint ?? null,
      evidence,
      resolvePrincipalId: async () => {
        const who = await this.#client.request<{ principal: { id: string } | null }>("/agent/v1/whoami", {
          context: "resolving this principal's identity for a gitvault proof-of-open submission",
        });
        return who.principal?.id ?? null;
      },
      readerEntrypoint: async () => {
        const { gitvaultReaderEntrypoint } = await this.#publication();
        return gitvaultReaderEntrypoint("fsck");
      },
      submit: (principalId, ekFingerprint, ev) =>
        this.submitProofOfOpen(repoId, principalId, {
          ek_fingerprint: ekFingerprint,
          chain_verified_to_generation: ev.chain_verified_to_generation,
          decryptable_to_generation: ev.decryptable_to_generation,
          reader_entrypoint: ev.reader_entrypoint,
        }),
    });
  }

  /**
   * gitvault-byo-primary-bucket task 3.3 (design D6) — `repos fsck`'s
   * wiring of the shipped read-half primitive
   * {@link import("../node/gitvault-mirror.js").verifyByoObjectsPresent}.
   * Thin wrapper over {@link computeByoPresenceOutcome} (the testable
   * decision function, factored out the same way {@link
   * computeOpenProofOutcome} is factored out of `#submitFsckOpenProof`)
   * supplying THIS instance's real `hasLocalConfig`/`verifyPresence`
   * dependencies (`readByoConfig` against the real keystore,
   * `verifyByoObjectsPresent` against the real HTTP client). See that
   * function's own doc comment for the full gating/throw contract.
   */
  async #checkByoPresence(vault: GitvaultVaultRecord | null, repoId: string, keystore: GitvaultKeystore): Promise<GitvaultFsckByoPresence | undefined> {
    const { readByoConfig } = await this.#byoConfig();
    const { verifyByoObjectsPresent } = await this.#mirror();
    return computeByoPresenceOutcome({
      repoId,
      vault,
      hasLocalConfig: () => readByoConfig(keystore, repoId) !== null,
      verifyPresence: () => verifyByoObjectsPresent(this.#client, repoId, { keystore }),
    });
  }

  /**
   * Wrap this vault's current epoch key to every org member who has
   * published an encryption key but has no `key_envelope` on this vault yet
   * — gitvault-human-envelopes task 4.1's ADD-path workaround. See {@link
   * import("../node/gitvault-publication.js").GitvaultVault.
   * reconcileEnvelopeRecipients} for the full design (TOFU pinning, the
   * gateway `public_key` gap, and why this is a workaround rather than the
   * eventual epoch-rotation design).
   *
   * `run402 gitvault reconcile` has no `repos` equivalent — `reconcile` is
   * a workaround, not a permanent verb — and answers `COMMAND_REMOVED`
   * pointing at `repos access` for inspection. This method itself stays:
   * `deploy()` runs it, best-effort,
   * whenever a deploy lands a new generation in the vault — design D5's
   * "deploy time" hook, "the same 'one command every agent runs' argument
   * that decided deploy-implies-capture." `push()` (capture-and-publish
   * outside a deploy) runs the identical hook after every successful
   * publish, for the vault-only-project cadence. See
   * `#tryReconcileEnvelopeRecipients` below for both call sites, and
   * {@link Gitvault.access} for the READ half repo-surface-consolidation
   * ships in its place.
   */
  async reconcileEnvelopeRecipients(options: GitvaultVaultHandleOptions = {}): Promise<GitvaultReconcileEnvelopeRecipientsResult> {
    const handle = await this.open(options);
    return handle.vault.reconcileEnvelopeRecipients();
  }

  /**
   * gitvault-multi-writer (task 5.7) — admit every eligible `pending_writers[]`
   * candidate (active org membership at role developer+, a published,
   * possession-verified signing key, not yet in the writer set) via a fresh
   * `add_writer_key{"writer"}` head per candidate. This session's OWN key
   * must already be an active writer — see {@link
   * import("../node/gitvault-publication.js").GitvaultVault.
   * reconcileWriterAdmissions}'s doc comment for why that is checked
   * locally, once, rather than surfaced as N identical gateway refusals.
   *
   * The explicit standalone entry point for the SAME reconcile task 5.7
   * also wires onto session-start/push/snapshot/deploy — calling it here
   * is idempotent-safe alongside whatever `open()` above already ran
   * internally (an already-admitted candidate is simply reported under
   * `already_covered`, never re-admitted), mirroring {@link
   * reconcileEnvelopeRecipients}'s own identical redundancy-tolerant shape.
   */
  async reconcile(options: GitvaultVaultHandleOptions = {}): Promise<GitvaultReconcileWriterAdmissionsResult> {
    const handle = await this.open(options);
    return handle.vault.reconcileWriterAdmissions();
  }

  /**
   * Drive one epoch rotation (D193-D203, rev 42) — the client half of
   * epoch rotation: sample a fresh `K_e`, compute the H-partition from live
   * desired-recipient state + the effective pin manifest, seal one
   * `key_envelope` per included recipient, submit the create-only
   * `rotation_attempt_descriptor`, submit the `rotate_epoch` head, verify
   * this principal's own envelope opens to the committed key (when it is
   * itself a recipient), and advance the local keystore's epoch pointer.
   * See {@link import("../node/gitvault-publication.js").GitvaultVault.
   * rotateEpoch}'s own doc comment for the full obligations and — load-
   * bearing — the confirmed gap in what the gateway exposes for
   * `recipient_state_version`/`recipient_revocation_version` outside the
   * `recipient_key_revoked` reason, and (also load-bearing) `options.
   * pending_confirmations` for folding a receipted `/confirm`/`/repin`
   * result into THIS rotation's head instead of a separately-gated
   * `publishPinManifestUpdate` call.
   */
  async rotateEpoch(
    options: GitvaultVaultHandleOptions & { reason: GitvaultRotationReason; recipient_state_version: string; recipient_revocation_version: string; client_idempotency_key?: string; pending_confirmations?: { principal_id: string; ek_fingerprint: string; receipt: GitvaultRecipientConfirmationReceipt }[] },
  ): Promise<import("../node/gitvault-publication.js").GitvaultRotationResult> {
    const handle = await this.open(options);
    return handle.vault.rotateEpoch(options);
  }

  /**
   * The ONE fully self-contained rotation entry point: declares
   * `reason:"recipient_key_revoked"` for `principalId` (owner + step-up)
   * and drives the rotation from that call's OWN returned counters — no
   * external counter source needed. The rekey remedy for the exact witness
   * task 5.0 records: a specific member's key is compromised/should no
   * longer be trusted.
   */
  /**
   * The writer-capable rotation that completes an org membership removal
   * (`reason:"member_removed"`, gitvault-multi-writer D6): counters come off
   * the envelope-recipients read, no declaration, no owner step-up — any
   * surviving writer can run it. `push()` runs it automatically when the
   * gate names an outstanding removal; this is the explicit entry point
   * (`run402 org member rm` drives it on every vault the caller can).
   */
  async rotateEpochForMemberRemoval(options: GitvaultVaultHandleOptions & { client_idempotency_key?: string } = {}): Promise<import("../node/gitvault-publication.js").GitvaultRotationResult> {
    const handle = await this.open(options);
    return handle.vault.rotateEpochForMemberRemoval(options);
  }

  async rotateEpochForKeyRevocation(principalId: string, options: GitvaultVaultHandleOptions & { client_idempotency_key?: string } = {}): Promise<import("../node/gitvault-publication.js").GitvaultRotationResult> {
    const handle = await this.open(options);
    return handle.vault.rotateEpochForKeyRevocation(principalId, options);
  }

  /**
   * Publish a receipted `recipient_pin_manifest` update (D197) — the
   * publication half of the `/confirm`/`/repin` ceremonies above. Call
   * after {@link confirmRecipient}/{@link repinRecipient} returns a receipt;
   * this is `gitvault.writer`-sufficient (the owner-gated half already
   * happened at the ceremony route).
   *
   * **This publish is an ORDINARY admission** and is therefore itself
   * refused `EPOCH_ROTATION_REQUIRED` while this vault has a migration/
   * revocation/exposure condition outstanding (D193).
   * `#enrichEpochRotationRequiredForPinManifest`
   * below decorates that refusal with the remedy: fold the SAME receipt
   * into `rotateEpoch({..., pending_confirmations: [...]})` instead, which
   * durably publishes it on a `rotate_epoch` admission (the gate's own
   * escape valve) rather than a separately-gated ordinary one.
   */
  async publishPinManifestUpdate(
    input: { principal_id: string; ek_fingerprint: string; receipt: GitvaultRecipientConfirmationReceipt } & GitvaultVaultHandleOptions,
  ): Promise<import("../node/gitvault-publication.js").GitvaultPublishResult> {
    const handle = await this.open(input);
    return handle.vault
      .publishPinManifestUpdate({ principal_id: input.principal_id, ek_fingerprint: input.ek_fingerprint, confirmed_by: "operator_confirmation", receipt: input.receipt })
      .catch((e) => { throw this.#enrichEpochRotationRequiredForPinManifest(e, handle.repo_id); });
  }

  /**
   * `EPOCH_ROTATION_REQUIRED` from a `publishPinManifestUpdate` call names
   * the SAME three causes {@link #enrichEpochRotationRequired} decodes for
   * `push()`, but the remedy is different: a manifest-only publish should
   * fold into the NEXT `rotateEpoch` call via `pending_confirmations`
   * rather than run a separate migration/revocation/exposure rotation
   * first and publish again afterward — one admission instead of two, and
   * the only path that works at all while EVERY predecessor-confirmed
   * principal is already exhausted (see `GitvaultVault.rotateEpoch`'s own
   * doc comment for the honest residual: this does not rescue a vault with
   * zero ever-confirmed principals, which needs an operator-side fix).
   */
  #enrichEpochRotationRequiredForPinManifest(e: unknown, repoId: string): unknown {
    if (!isRun402Error(e) || (e as { code?: string }).code !== "EPOCH_ROTATION_REQUIRED") return e;
    return new LocalError(
      `this vault requires a rotate_epoch admission before an ordinary pin-manifest publish is admissible (repo_id ${repoId}) — fold this SAME receipt into rotateEpoch({..., pending_confirmations: [{principal_id, ek_fingerprint, receipt}]}) instead of retrying this call`,
      "publishing a recipient_pin_manifest update",
      { code: "EPOCH_ROTATION_REQUIRED", details: (e as { details?: unknown }).details, next_actions: [{ action: "r.gitvault.rotateEpoch({..., pending_confirmations: [{principal_id, ek_fingerprint, receipt}]})", why: "the manifest publish rides the SAME head as the required rotation, which is EPOCH_ROTATION_REQUIRED's own escape valve — a standalone publish never is" }], cause: e },
    );
  }

  /**
   * `repos access` (repo-surface-consolidation D5/D10) — a READ-ONLY report
   * of who can open this vault, composed from whatever the live gateway
   * surface exposes today. Never wraps, never mutates a `key_envelope` —
   * that mutating half stays {@link reconcileEnvelopeRecipients}, reachable
   * only through the deploy/push best-effort hooks until `access repair`
   * ships (gated on `gitvault-human-envelopes`' epoch-rotation work). See
   * {@link GitvaultAccessResult}'s doc comment for the honest gap this
   * reports rather than invents.
   */
  async access(options: GitvaultVaultHandleOptions = {}): Promise<GitvaultAccessResult> {
    const repoId = await this.#resolveRepoId(options);
    const record = await this.get(repoId).catch(() => null);
    const orgId = record?.org_id ?? null;

    // gitvault-agent-envelopes D3/D5: `access` is one of the ordinary reads a
    // KEY-HOLDER's session starts with — enroll this keystore's key if absent
    // and fulfil every pending desired recipient once per process, BEFORE the
    // roster below is read, so the roster reflects the fulfilment. Reported,
    // never folded into the roster; a machine holding no K_repo stays a pure
    // read.
    let reconcileRecipients: GitvaultSessionReconcileResult | null = null;
    let enrollment: GitvaultEnrollmentOutcome | null = null;
    if (options.reconcile !== "forbidden") {
      try {
        const { GitvaultKeystore } = await this.#keystore();
        const probe = new GitvaultKeystore(options.keystore_root !== undefined ? { rootDir: options.keystore_root } : {});
        if (probe.readRepo(repoId)) {
          const handle = await this.open({ ...options, repo_id: repoId });
          reconcileRecipients = handle.reconcile_recipients;
          enrollment = handle.enrollment;
        }
      } catch {
        // best-effort — the roster read below is the verb's own result
      }
    }

    const [directory, coverage] = await Promise.all([
      orgId
        ? this.#client.request<{ org_id: string; keys: Array<{ principal_id: string; display_name: string | null; ek_fingerprint: string }> }>(`/orgs/v1/${encodeURIComponent(orgId)}/encryption-keys`, { context: "reading the org encryption-key directory" })
        : Promise.resolve({ org_id: "", keys: [] }),
      this.#client.request<GitvaultEnvelopeRecipientsResponse>(`/gitvault/v1/vaults/${encodeURIComponent(repoId)}/envelope-recipients`, { context: "reading the gitvault envelope recipients" }),
    ]);
    const covered = new Set(coverage.recipient_fingerprints);

    // `desired` is OPTIONAL on the wire (see GitvaultEnvelopeRecipientsResponse):
    // absent means an older gateway that predates this field — genuinely
    // unknown, not "no desired recipients." Distinguish "absent" from
    // "present and empty" via the array itself, not a boolean flag, so a
    // null/undefined check is the single source of truth for both this
    // method and any future caller of the same wire type.
    const desiredList = coverage.desired ?? null;
    const envelopeStateAvailable = desiredList !== null;
    const desiredByPrincipal = new Map(desiredList?.map((d) => [d.principal_id, d] as const) ?? []);

    // Node-only, best-effort: THIS machine's own local TOFU pins, and this
    // keystore's own encryption-key fingerprint (used below to keep the
    // vault creator's own machine out of `unmatched_covered_fingerprints` —
    // the org directory only lists human-enrolled keys, so a wallet-principal
    // creator's fingerprint is legitimately absent from it, not orphaned).
    // Never fails the whole read — a browser/worker caller, or a machine that
    // has never wrapped anyone, simply reports every `tofu_pin` as `null` and
    // `this_keystore` as `null`.
    let pins: Record<string, string> = {};
    let ownFingerprint: string | null = null;
    try {
      const { GitvaultKeystore } = await this.#keystore();
      const keystore = new GitvaultKeystore(options.keystore_root !== undefined ? { rootDir: options.keystore_root } : {});
      pins = keystore.readRepo(repoId)?.envelope_recipient_pins ?? {};
      ownFingerprint = keystore.readIdentity()?.encryption_fingerprint ?? null;
    } catch {
      // Not Node, or no local keystore for this repo — pins/ownFingerprint stay empty/null.
    }

    const recipients: GitvaultAccessResult["recipients"] = directory.keys.map((k) => {
      const pinned = pins[k.principal_id];
      const desired = desiredByPrincipal.get(k.principal_id) ?? null;
      const envelopeState: GitvaultAccessRecipient["envelope_state"] =
        desired == null ? null : desired.status === "pending_removal" ? "pending_removal" : covered.has(k.ek_fingerprint) ? "converged" : "pending";
      return {
        principal_id: k.principal_id,
        display_name: k.display_name,
        fingerprint: k.ek_fingerprint,
        covered: covered.has(k.ek_fingerprint),
        envelope_state: envelopeState,
        tofu_pin: pinned !== undefined ? { fingerprint: pinned, matches_directory: pinned === k.ek_fingerprint } : null,
      };
    });
    const directoryFingerprints = new Set(directory.keys.map((k) => k.ek_fingerprint));

    // Removed members (desired status pending_removal) whose fingerprint is
    // STILL covered: real, continuing access that membership removal did not
    // revoke, because gitvault v0 has no epoch-rotation mechanism yet. See
    // GitvaultAccessResult's doc comment.
    const staleAccess: GitvaultAccessResult["stale_access"] = (desiredList ?? [])
      .filter((d) => d.status === "pending_removal" && d.ek_fingerprint != null && covered.has(d.ek_fingerprint))
      .map((d) => ({ principal_id: d.principal_id, display_name: d.display_name, fingerprint: d.ek_fingerprint as string }));
    const staleAccessFingerprints = new Set(staleAccess.map((s) => s.fingerprint));

    // Genuinely unexplained: covering fingerprints that match neither a
    // current directory entry NOR a desired-state row (already broken out
    // above as stale_access) — orphaned, externally revoked, or a recipient
    // outside this org's membership model entirely. THIS keystore's own
    // fingerprint is a separate, locally-provable case: the org directory
    // only lists human-enrolled keys, so the vault creator's own
    // wallet-principal keystore legitimately never appears there — that is
    // not orphaned/external, it is provably this machine, so it is broken
    // out into `this_keystore` instead of left to read as a misconfiguration.
    const unmatchedRaw = coverage.recipient_fingerprints.filter((fp) => !directoryFingerprints.has(fp) && !staleAccessFingerprints.has(fp));
    // gitvault-agent-envelopes: THIS machine's keystore is reported for every
    // principal type — enrolled or not, covered or not — never `null` for a
    // real keystore (only when there is no local identity at all). The
    // directory now lists agent keys too, so "own fingerprint in the
    // directory" is the enrolled case; an unenrolled creator's genesis
    // envelope still shows as covered-but-unenrolled.
    let publishState: "active" | "pending" | "absent" | "rotation_required" | "unknown" = "unknown";
    if (ownFingerprint !== null) {
      try {
        const who = await this.#client.request<{ encryption_key: { ek_fingerprint: string; state: string } | null }>("/agent/v1/whoami", { context: "reading this keystore's enrollment state" });
        const key = who.encryption_key ?? null;
        publishState = !key ? "absent" : key.ek_fingerprint !== ownFingerprint ? "rotation_required" : key.state === "active" ? "active" : "pending";
      } catch {
        publishState = "unknown";
      }
    }
    const thisKeystore: GitvaultAccessResult["this_keystore"] = ownFingerprint !== null
      ? {
          fingerprint: ownFingerprint,
          enrolled: publishState === "active",
          publish_state: publishState,
          covered_on_this_vault: covered.has(ownFingerprint),
          covered: covered.has(ownFingerprint),
          ...(!covered.has(ownFingerprint) && publishState === "active"
            ? { next_actions: [
                { action: "run402 repos access", why: "poll — covered_on_this_vault flips true once a key-holder has wrapped this vault to your key" },
                { action: "ask a key-holder to run any gitvault operation (run402 repos view / git push)", why: "a key-holding client wraps every pending desired recipient on its next operation" },
              ] }
            : {}),
          ...(publishState === "rotation_required"
            ? { next_actions: [{ action: "restore the keystore backup, or have an org owner revoke the stale key (DELETE /orgs/v1/:org_id/members/:principal_id/encryption-key)", why: "this keystore's key differs from the principal's published key; rotation is never automatic" }] }
            : {}),
        }
      : null;
    const unmatched = thisKeystore ? unmatchedRaw.filter((fp) => fp !== thisKeystore.fingerprint) : unmatchedRaw;

    const gap = envelopeStateAvailable
      ? "history_scope (which epochs each recipient can read) is not available: this read has no per-epoch view, only the vault's " +
        "CURRENT coverage — a recipient covered here may still be excluded from a PAST epoch's key (forward revocation is exactly what " +
        "an epoch rotation buys). envelope_state per recipient IS available today, from the " +
        `gateway's desired-recipient-state substrate (desired_state_version ${String(coverage.desired_state_version ?? "unknown")}): ` +
        "\"converged\" means desired and covered, \"pending\" means desired but not yet wrapped, \"pending_removal\" means membership " +
        "removed them but this vault has not yet completed a rotation away from them. pending_removal does NOT mean revoked — with " +
        "covered:true they still decrypt this vault until an owner runs `repos access repair` (or, for a targeted key, `repos access " +
        "revoke-key`); see stale_access for exactly who, and next_actions for the exact command."
      : "the gateway did not report desired-recipient state (desired[]) for this vault_id — likely an older gateway than this SDK " +
        "expects, so per-recipient envelope_state and stale_access are unavailable. history_scope is unavailable regardless: gitvault " +
        "protocol v0 pins a single fixed epoch, so there is no per-epoch scope to report. This reports what the read surface has today: " +
        "the org's directory of encryption-key-holding members, which of the vault's current envelope-recipient fingerprints match a " +
        "directory entry (covered), and this machine's own local TOFU pin per principal when it has ever wrapped one (tofu_pin) — never a server-side fact.";

    return {
      repo_id: repoId,
      org_id: orgId,
      reconcile_recipients: reconcileRecipients,
      enrollment,
      recipients,
      unmatched_covered_fingerprints: unmatched,
      this_keystore: thisKeystore,
      stale_access: staleAccess,
      envelope_state_available: envelopeStateAvailable,
      history_scope_available: false,
      gap,
      ...(staleAccess.length > 0
        ? {
            next_actions: [
              { action: "run402 repos access repair", why: "re-key this vault's current epoch away from every principal in stale_access at once (owner + step-up)" },
              { action: "run402 repos access revoke-key <principal_id>", why: "target exactly one stale_access principal for revocation-triggered rotation (owner + step-up)" },
            ],
          }
        : {}),
    };
  }

  /**
   * The push-gated deploy: both lanes under one fresh `capture_id`, resolving
   * to exactly one of five outcomes — `DEPLOYED_AND_VAULTED`,
   * `DEPLOY_BLOCKED_PUSH_FAILED`, `DEPLOY_FAILED_VAULTED`,
   * `DEPLOY_FAILED_UNVAULTED`, `DEPLOYED_UNVAULTED_OVERRIDE`.
   *
   * The push is never gated on deploy success, and a build that fails before a
   * canonical apply plan exists still captures (with a null plan digest, so no
   * activation token can be minted from it).
   *
   * `run402 deploy` is design D5's PRIMARY envelope-recipient reconcile hook
   * ("the same 'one command every agent runs' argument that decided
   * deploy-implies-capture") and design D6's primary dual-push mirror trigger
   * — both fire HERE, not inside {@link runGitvaultDeploy} itself, mirroring
   * {@link push}'s exact non-blocking contract: best-effort, NEVER throw,
   * NEVER alter the deploy outcome already resolved above, reported BESIDE it
   * on `mirror_push` / `reconcile_recipients`. They fire only when this
   * deploy actually landed a new generation in the vault
   * (`DEPLOYED_AND_VAULTED` / `DEPLOY_FAILED_VAULTED` — the outcomes carrying
   * a `generation`); the other three outcomes published nothing new, so
   * there is nothing to mirror or reconcile against ({@link
   * import("../node/gitvault-mirror.js").mirrorPushForGeneration}'s own
   * contract: "fires after an ordinary vault push/deploy produces a new
   * generation"). Both fields are therefore OMITTED — never a faked
   * `skipped_*` outcome — when no generation landed.
   */
  async deploy(
    options: Omit<GitvaultDeployOptions, "vault"> & GitvaultVaultHandleOptions,
  ): Promise<GitvaultDeployResult & { mirror_push?: GitvaultMirrorPushResult; byo_chain_copy?: GitvaultMirrorPushResult; reconcile_recipients?: GitvaultReconcileEnvelopeRecipientsPushResult; writer_reconcile?: GitvaultReconcileWriterAdmissionsPushResult }> {
    const { runGitvaultDeploy } = await this.#deploy();
    const handle = await this.open(options);
    const result = await runGitvaultDeploy({ ...options, vault: handle.vault, repo_dir: options.repo_dir ?? process.cwd() });
    // Same ordering push() uses (mirror, then reconcile) — sequential, not
    // Promise.all, so a reconcile failure can never be misread as a mirror
    // failure in a log line that assumed ordering. Extracted to a standalone
    // function so the outcome-gating is unit-testable with fake thunks,
    // without standing up a live vault — see gitvault-deploy-hooks.test.ts.
    const hooked = await attachGitvaultDeployHooks(
      result,
      () => this.#tryMirrorPush(handle.repo_id, handle.keystore),
      () => this.#tryReconcileEnvelopeRecipients(handle.vault),
    );
    // gitvault-byo-primary-bucket task 3.3 / gitvault-multi-writer task 5.7
    // — composed AFTER, not inside, `attachGitvaultDeployHooks` (kept
    // untouched so its own unit-tested outcome-gating contract stays
    // byte-for-byte): the SAME "did this deploy actually land a generation"
    // gate `mirror_push`'s presence already encodes, so no new
    // outcome-inspection logic here.
    if (hooked.mirror_push === undefined) return hooked;
    return { ...hooked, byo_chain_copy: await this.#tryByoChainCopyPush(handle.repo_id, handle.keystore), writer_reconcile: await this.#tryReconcileWriterAdmissions(handle.vault) };
  }

  /**
   * Drain every unvaulted-override journal on this machine: push the exact
   * journaled snapshot and present the capture receipt for full-field
   * comparison. A partial match never clears the advisory.
   */
  async drainOverrides(options: GitvaultVaultHandleOptions = {}): Promise<import("../node/gitvault-deploy.js").GitvaultOverrideDrainReport> {
    const { drainOverrideJournals } = await this.#deploy();
    const handle = await this.open(options);
    return drainOverrideJournals(handle.vault);
  }

  /**
   * Reproduce the vault's object database into a git repository — the clone-back
   * path. Needs only git and a surviving keystore: no deployment artifact, CAS
   * entry, or apply operation is consulted.
   */
  async restore(options: GitvaultVaultHandleOptions & { target_dir: string }): Promise<{ refs: Record<string, string>; generation: string; retained_refs: import("../node/gitvault-publication.js").GitvaultRetainedRefsReconcileResult }> {
    const handle = await this.open(options);
    const out = await handle.vault.restoreObjectsInto(options.target_dir);
    return { refs: out.refs, generation: out.generation, retained_refs: out.retained_refs };
  }

  // ── degraded read (gitvault-byo-primary-bucket, design D4, task 3.4 — mirror half) ──

  /**
   * Wrap an ALREADY-RESOLVED vault read with degraded-read fallback: run
   * `options.attemptLive` (the caller's own live call — its
   * `vault.materialize()` for a `list`-shaped read, or
   * `vault.restoreObjectsInto(dir)` for a `fetch`-shaped one), and on a
   * network-class failure (never on an authorization refusal or any other
   * 4xx — see `isNetworkClassGitvaultReadError`), fall back to the vault's
   * configured mirror via the SAME `r402s-recover` engine `recover()` uses.
   *
   * Deliberately takes an already-open `vault`/`keystore`/`repo_id` rather
   * than resolving them itself: named-address resolution (slug-form vs.
   * id-form), stale-pin recovery, and cross-command vault-instance reuse
   * within one `git-remote-run402` session are CLI-layer concerns that
   * already live in `cli/lib/remote-helper-session.mjs` — this method owns
   * only the trigger discipline and the fallback engine, never vault
   * resolution, so it composes with that existing flow instead of
   * duplicating it.
   *
   * `out_dir` is REQUIRED for the fallback to ever run — pass the resolved,
   * git-proven repository directory (`resolveGitInvocationRepo`'s own
   * `repo_dir`, never a guess from `cwd`). `null` (no resolvable repository,
   * e.g. a bare `git ls-remote` outside any checkout) disables the fallback
   * entirely: the original gateway error surfaces exactly as it always did.
   */
  async withDegradedRead<T extends GitvaultDegradedReadLive>(options: {
    attemptLive: () => Promise<T>;
    keystore: GitvaultKeystore;
    repo_id: string;
    out_dir: string | null;
  }): Promise<GitvaultDegradedReadOutcome<T>> {
    const { tryGitvaultDegradedRead } = await this.#degradedRead();
    return tryGitvaultDegradedRead(options);
  }

  // ── mirror (gitvault-mirror-and-recover, design D1/D2/D7) ─────────────────

  /**
   * Configure (or replace) the customer-owned mirror destination for one
   * vault. Client-side ONLY — the destination + credential NAME are written
   * beside the keystore (design D2); run402 never sees or stores a raw
   * secret value. `s3://<bucket>/<prefix>` needs `credential`; a plain
   * filesystem path needs none.
   */
  async mirrorSet(options: GitvaultVaultHandleOptions & { destination_url: string; credential?: GitvaultMirrorCredential; region?: string; endpoint?: string }): Promise<GitvaultMirrorConfig> {
    const [{ GitvaultKeystore }, { parseMirrorDestinationUrl, saveMirrorConfig }] = await Promise.all([this.#keystore(), this.#mirrorConfig()]);
    const repoId = await this.#resolveRepoId(options);
    const keystore = new GitvaultKeystore(options.keystore_root !== undefined ? { rootDir: options.keystore_root } : {});
    const destination: GitvaultMirrorDestination = parseMirrorDestinationUrl(options.destination_url, { region: options.region, endpoint: options.endpoint });
    return saveMirrorConfig(keystore, { repo_id: repoId, destination, ...(options.credential ? { credential: options.credential } : {}) });
  }

  /** Remove the mirror config for one vault. Never touches the mirror's own bytes (design: config removal ≠ data deletion). */
  async mirrorRemove(options: GitvaultVaultHandleOptions = {}): Promise<{ repo_id: string; removed: boolean }> {
    const [{ GitvaultKeystore }, { removeMirrorConfig }] = await Promise.all([this.#keystore(), this.#mirrorConfig()]);
    const repoId = await this.#resolveRepoId(options);
    const keystore = new GitvaultKeystore(options.keystore_root !== undefined ? { rootDir: options.keystore_root } : {});
    return { repo_id: repoId, ...removeMirrorConfig(keystore, repoId) };
  }

  /**
   * What this machine and the mirror each believe: whether a mirror is
   * configured, the newest generation the MIRROR holds and can chain-verify
   * (keyless — never touches keys), the LIVE vault's newest generation (one
   * read of the vault record), and — when they disagree — the closing
   * command. Both honesty statements (design D8) ride every response.
   */
  async mirrorStatus(options: GitvaultVaultHandleOptions & { is_byo?: boolean } = {}): Promise<GitvaultMirrorStatus> {
    const [{ GitvaultKeystore }, { readMirrorConfig, formatMirrorDestination }, { openGitvaultMirrorBackend }, { verifyGitvaultMirror }] = await Promise.all([
      this.#keystore(), this.#mirrorConfig(), this.#mirrorBackend(), this.#recovery(),
    ]);
    const repoId = await this.#resolveRepoId(options);
    const keystore = new GitvaultKeystore(options.keystore_root !== undefined ? { rootDir: options.keystore_root } : {});
    const config = readMirrorConfig(keystore, repoId);
    const base = { repo_id: repoId, validity_not_freshness: GITVAULT_MIRROR_VALIDITY_NOT_FRESHNESS_STATEMENT, keystore_still_required: GITVAULT_MIRROR_KEYSTORE_STILL_REQUIRED_STATEMENT };
    const lastSuccessAt = config?.last_success_at ?? null;
    if (!config) {
      // gitvault-mirror-default: the unconfigured branch stays gateway-blind
      // by construction — it returns before ANY network call, finding included.
      // `options.is_byo` is a caller-supplied hint (gitvault-byo-primary-bucket
      // task 3.5) — NEVER derived here, which is what keeps this branch
      // network-call-free; `repos view` already has `storage_profile` from
      // its own `status()` read and passes it in.
      return {
        ...base, configured: false, destination: null, credential_kind: null, mirrored_generation: null, newest_generation: null, is_current: null, closing_command: null,
        last_success_at: lastSuccessAt,
        finding: gitvaultUnmirroredFinding({ configured: false, last_success_at: lastSuccessAt, mirrored_generation: null, is_byo: options.is_byo }),
      };
    }
    let mirroredGeneration: string | null = null;
    try {
      const backend = openGitvaultMirrorBackend(config.destination, repoId, config.credential);
      const report = await verifyGitvaultMirror(backend, { keystore });
      mirroredGeneration = report.recovered_generation;
    } catch {
      // A configured-but-unreachable/empty mirror is still `configured: true` — the honest report is "unknown", not a thrown status call.
    }
    let newestGeneration: string | null = null;
    try {
      newestGeneration = (await this.get(repoId)).newest_generation;
    } catch {
      /* the live vault read is best-effort here; the mirror half of status still answers */
    }
    const isCurrent = mirroredGeneration !== null && newestGeneration !== null ? mirroredGeneration === newestGeneration : null;
    return {
      ...base, configured: true, destination: formatMirrorDestination(config.destination), credential_kind: config.credential?.kind ?? null,
      mirrored_generation: mirroredGeneration, newest_generation: newestGeneration, is_current: isCurrent,
      closing_command: isCurrent === false ? "run402 repos mirror --backfill" : null,
      last_success_at: lastSuccessAt,
      finding: gitvaultUnmirroredFinding({ configured: true, last_success_at: lastSuccessAt, mirrored_generation: mirroredGeneration, is_byo: options.is_byo }),
    };
  }

  /** List the vault's stored objects, diff against the mirror, fetch + hash-verify + write what's missing, in admission order. Resumable and idempotent. */
  async mirrorSync(options: GitvaultVaultHandleOptions = {}): Promise<GitvaultMirrorSyncSummary> {
    const [{ GitvaultKeystore }, { mirrorSync }] = await Promise.all([this.#keystore(), this.#mirror()]);
    const repoId = await this.#resolveRepoId(options);
    const keystore = new GitvaultKeystore(options.keystore_root !== undefined ? { rootDir: options.keystore_root } : {});
    return mirrorSync(this.#client, repoId, { keystore });
  }

  /** Keyless integrity probe against the CONFIGURED mirror: discovery + chain verification + closure/absence adjudication, never decryption (`run402 repos fsck --mirror`). */
  async mirrorVerify(options: GitvaultVaultHandleOptions = {}): Promise<GitvaultVerifyReport> {
    const [{ GitvaultKeystore }, { readMirrorConfig }, { openGitvaultMirrorBackend }, { verifyGitvaultMirror }] = await Promise.all([
      this.#keystore(), this.#mirrorConfig(), this.#mirrorBackend(), this.#recovery(),
    ]);
    const repoId = await this.#resolveRepoId(options);
    const keystore = new GitvaultKeystore(options.keystore_root !== undefined ? { rootDir: options.keystore_root } : {});
    const config = readMirrorConfig(keystore, repoId);
    if (!config) throw new LocalError(`no mirror is configured for ${repoId}`, "verifying gitvault mirror", { code: "GITVAULT_MIRROR_NOT_CONFIGURED", details: { repo_id: repoId }, next_actions: [{ action: "run402 repos mirror <destination>" }] });
    const backend = openGitvaultMirrorBackend(config.destination, repoId, config.credential);
    return verifyGitvaultMirror(backend, { keystore });
  }

  /**
   * `r402s-recover` (design D4): rebuild a working git repository straight
   * from a mirrored `source/<repo_id>/` prefix — NO SERVER INVOLVED. `source`
   * is `s3://<bucket>[/<prefix>]` or a local directory; when it names more
   * than one mirrored vault, pass `repo_id` explicitly. Recovery proves
   * validity, never freshness (both honesty statements ride every result).
   *
   * gitvault-recovery-custody: a human member with no keystore recovers with
   * `member_bundle` (the exported `r402s-member-recovery-bundle/v1`, or the
   * mirror's own `member-recovery-bundles/` sidecar when omitted) +
   * `source_recovery_code`; a raw WebAuthn PRF output is NOT a supported
   * input. The recovery-receipt pin stays the trust anchor either way —
   * pass `recovery_receipt` when there is no keystore holding one.
   */
  async recover(options: { source: string; out_dir: string; repo_id?: string; credential?: GitvaultMirrorCredential; region?: string; endpoint?: string; recovery_receipt?: GitvaultRecoveryReceipt; keystore_root?: string; member_bundle?: GitvaultMemberRecoveryBundle; source_recovery_code?: string; rp_id?: string }): Promise<GitvaultRecoverResult> {
    const [{ GitvaultKeystore }, { parseMirrorDestinationUrl }, { openGitvaultMirrorBackend, discoverMirroredRepoIds }, { recoverGitvaultMirror }] = await Promise.all([
      this.#keystore(), this.#mirrorConfig(), this.#mirrorBackend(), this.#recovery(),
    ]);
    const keystore = new GitvaultKeystore(options.keystore_root !== undefined ? { rootDir: options.keystore_root } : {});
    const destination = parseMirrorDestinationUrl(options.source, { region: options.region, endpoint: options.endpoint });
    let repoId = options.repo_id;
    if (!repoId) {
      const found = await discoverMirroredRepoIds(destination, options.credential);
      if (found.length === 0) throw new LocalError(`${options.source} holds no mirrored vault (no source/<repo_id>/ prefix found)`, "recovering gitvault vault", { code: "GITVAULT_MIRROR_EMPTY", details: { source: options.source } });
      if (found.length > 1) throw new LocalError(`${options.source} holds ${found.length} mirrored vaults; pass repo_id to pick one`, "recovering gitvault vault", { code: "GITVAULT_MIRROR_AMBIGUOUS", details: { source: options.source, repo_ids: found }, next_actions: found.map((id) => ({ action: `recover --repo ${id}` })) });
      repoId = found[0]!;
    }
    const backend = openGitvaultMirrorBackend(destination, repoId, options.credential);
    return recoverGitvaultMirror({
      backend, out_dir: options.out_dir, keystore,
      ...(options.recovery_receipt ? { recovery_receipt: options.recovery_receipt } : {}),
      ...(options.member_bundle ? { member_bundle: options.member_bundle } : {}),
      ...(options.source_recovery_code != null ? { source_recovery_code: options.source_recovery_code } : {}),
      ...(options.rp_id != null ? { rp_id: options.rp_id } : {}),
    });
  }

  /**
   * Re-apply the local immutable-object cache's eviction window (design D3,
   * task 4.2) for one vault — a periodic backstop wired into `run402 repos
   * gc`, catching any orphaned cache file a crashed write might have left
   * behind. Purely local: no network call beyond resolving `repo_id` when
   * only `project_id` was supplied. Idempotent and safe to call on a repo
   * with no cache directory at all (a no-op).
   */
  async sweepObjectCache(options: GitvaultVaultHandleOptions): Promise<void> {
    const [{ GitvaultKeystore }] = await Promise.all([this.#keystore()]);
    const repoId = await this.#resolveRepoId(options);
    const keystore = new GitvaultKeystore(options.keystore_root !== undefined ? { rootDir: options.keystore_root } : {});
    keystore.sweepObjectCache(repoId);
  }

  // ── internals ─────────────────────────────────────────────────────────────

  async #resolveRepoId(options: GitvaultVaultHandleOptions): Promise<string> {
    if (options.repo_id) return options.repo_id;
    if (options.project_id) return (await this.forProject(options.project_id)).repo_id;
    throw new LocalError("pass repo_id, or project_id to resolve it from the control plane", "opening the gitvault", { code: "GITVAULT_VAULT_UNRESOLVED" });
  }

  #publication(): Promise<PublicationModule> {
    return nodeOnly(() => import("../node/gitvault-publication.js"), "open");
  }
  #deploy(): Promise<DeployModule> {
    return nodeOnly(() => import("../node/gitvault-deploy.js"), "deploy");
  }
  #keystore(): Promise<KeystoreModule> {
    return nodeOnly(() => import("../node/gitvault-keystore.js"), "open");
  }
  #creation(): Promise<CreationModule> {
    return nodeOnly(() => import("../node/gitvault-creation-journal.js"), "init");
  }
  #snapshot(): Promise<SnapshotModule> {
    return nodeOnly(() => import("../node/gitvault-snapshot.js"), "push");
  }
  #prune(): Promise<PruneModule> {
    return nodeOnly(() => import("../node/gitvault-prune.js"), "prune");
  }
  #openOrCreate(): Promise<OpenOrCreateModule> {
    return nodeOnly(() => import("../node/gitvault-open-or-create.js"), "openOrCreate");
  }
  #address(): Promise<AddressModule> {
    return nodeOnly(() => import("../node/gitvault-address.js"), "resolveOrCreateAddress");
  }
  #mirror(): Promise<MirrorModule> {
    return nodeOnly(() => import("../node/gitvault-mirror.js"), "mirrorSync");
  }
  #mirrorConfig(): Promise<MirrorConfigModule> {
    return nodeOnly(() => import("../node/gitvault-mirror-config.js"), "mirrorSet");
  }
  #mirrorBackend(): Promise<MirrorBackendModule> {
    return nodeOnly(() => import("../node/gitvault-mirror-backend.js"), "mirrorSet");
  }
  #recovery(): Promise<RecoverModule> {
    return nodeOnly(() => import("../node/gitvault-recover.js"), "recover");
  }
  #handoff(): Promise<HandoffModule> {
    return nodeOnly(() => import("../node/gitvault-handoff.js"), "handoff");
  }
  #writerState(): Promise<WriterStateModule> {
    return nodeOnly(() => import("../node/gitvault-writer-state.js"), "handoff");
  }
  #restore(): Promise<RestoreModule> {
    return nodeOnly(() => import("../node/gitvault-restore.js"), "resume");
  }
  #degradedRead(): Promise<DegradedReadModule> {
    return nodeOnly(() => import("../node/gitvault-degraded-read.js"), "list");
  }
  #byoConfig(): Promise<ByoConfigModule> {
    return nodeOnly(() => import("../node/gitvault-byo-config.js"), "init");
  }
  #byoProbe(): Promise<ByoProbeModule> {
    return nodeOnly(() => import("../node/gitvault-byo-probe.js"), "init");
  }
}

// ─── D7 — progressive terminal-loss warning (repo-first-onramp task 2.7) ────
//
// The §0 terminal-loss statement (`GITVAULT_TERMINAL_LOSS_STATEMENT`) never
// changes — this governs only PROMINENCE and CADENCE. A quiet stderr line
// already runs at genesis (the one-shot receipt path in `push`/`openOrCreate`
// callers). This is the OTHER half: once the vault has accrued enough value
// at risk, `status`/`doctor` carry a STANDING warning instead of a one-time
// note nobody re-reads.

/**
 * The composite escalation trigger (design D7): ANY of these crossing its
 * threshold escalates the quiet genesis-time note into a standing warning.
 * Deliberately an OR — any single metric alone is gameable by triviality
 * (an agent that pads one dimension to stay under a lone threshold). Shipped
 * as defaults; tunable in this ONE place, not a protocol contract.
 */
export const GITVAULT_LOSS_WARNING_THRESHOLDS = {
  generations: 10,
  source_bytes: 10 * 1024 * 1024,
  days_since_genesis: 14,
} as const;

/**
 * gitvault-clone-scaling (bench P3): generations-since-checkpoint at or
 * above this advises `run402 repos gc`. Same one-place-to-tune convention
 * as {@link GITVAULT_LOSS_WARNING_THRESHOLDS}; an advisory, never a gate.
 */
export const GITVAULT_CHECKPOINT_ADVISORY_GENERATIONS = 25;

/** {@link gitvaultCheckpointStaleness}'s result. */
export interface GitvaultCheckpointStaleness {
  generations_since_checkpoint: number;
  advised: boolean;
}

/**
 * Pure staleness computation over two 16-hex generations. TOTAL: garbage
 * or unknown coverage (`null`) yields `{0, advised: false}` — advisory
 * call sites must never be able to break a verb, so unparseable input is
 * silence, not an error. Coverage `null` means "this checkout has not
 * locally learned the vault's checkpoint coverage" (see the keystore's
 * `checkpoint_covers_through` doc), which is deliberately indistinguishable
 * from fresh here.
 */
export function gitvaultCheckpointStaleness(input: { newest_generation: string; covers_through_generation: string | null }): GitvaultCheckpointStaleness {
  try {
    if (input.covers_through_generation === null) return { generations_since_checkpoint: 0, advised: false };
    if (!/^[0-9a-f]{16}$/.test(input.newest_generation) || !/^[0-9a-f]{16}$/.test(input.covers_through_generation)) {
      return { generations_since_checkpoint: 0, advised: false };
    }
    const newest = BigInt(`0x${input.newest_generation}`);
    const covered = BigInt(`0x${input.covers_through_generation}`);
    const since = newest > covered ? Number(newest - covered) : 0;
    return { generations_since_checkpoint: since, advised: since >= GITVAULT_CHECKPOINT_ADVISORY_GENERATIONS };
  } catch {
    return { generations_since_checkpoint: 0, advised: false };
  }
}

/** Which composite metric(s) crossed their D7 threshold, if any. */
export interface GitvaultLossWarningTrip {
  generations: boolean;
  source_bytes: boolean;
  days_since_genesis: boolean;
}

/**
 * D7: has this vault crossed the composite terminal-loss escalation trigger?
 * Pure — no I/O, no clock dependency beyond the optional `now` override
 * (tests). `admitted_generations` and `storage.source_bytes` are decimal
 * strings (protocol convention for values that could exceed safe-integer
 * precision in principle; comfortably within it here).
 *
 * There is deliberately no companion "is this resolved" function on the
 * TRIP computation itself: whether the generations/bytes/days thresholds
 * crossed is independent of how many principals cover the vault, and this
 * function stays a pure threshold check forever — a caller does not un-trip
 * it, ever, in V0. What DOES now exist, one call site up in `status()`, is a
 * way to downgrade the COPY once tripped: a locally-provable read of the
 * vault's covering-recipient count (the same envelope-recipients read
 * `Gitvault.access` uses) can show this is no longer the single-principal
 * case the message below describes. See
 * {@link gitvaultKeystoreBackupReminderMessage} for that downgraded form.
 */
export function gitvaultLossWarningTrip(
  record: Pick<GitvaultVaultRecord, "admitted_generations" | "storage" | "genesis_admitted_at">,
  now: Date = new Date(),
): GitvaultLossWarningTrip {
  const generations = Number(record.admitted_generations ?? "0");
  const sourceBytes = Number(record.storage?.source_bytes ?? "0");
  const genesisAt = record.genesis_admitted_at ? new Date(record.genesis_admitted_at) : null;
  const daysSinceGenesis = genesisAt && !Number.isNaN(genesisAt.getTime()) ? (now.getTime() - genesisAt.getTime()) / 86_400_000 : null;
  return {
    generations: Number.isFinite(generations) && generations >= GITVAULT_LOSS_WARNING_THRESHOLDS.generations,
    source_bytes: Number.isFinite(sourceBytes) && sourceBytes >= GITVAULT_LOSS_WARNING_THRESHOLDS.source_bytes,
    days_since_genesis: daysSinceGenesis !== null && daysSinceGenesis >= GITVAULT_LOSS_WARNING_THRESHOLDS.days_since_genesis,
  };
}

/** Any composite metric tripped — the standing warning threshold itself. */
export function gitvaultLossWarningTripped(trip: GitvaultLossWarningTrip): boolean {
  return trip.generations || trip.source_bytes || trip.days_since_genesis;
}

/** Shared by both D7 message forms below — which threshold(s) tripped, in prose. */
function gitvaultLossWarningReasons(trip: GitvaultLossWarningTrip): string[] {
  const reasons: string[] = [];
  if (trip.generations) reasons.push(`≥${GITVAULT_LOSS_WARNING_THRESHOLDS.generations} generations`);
  if (trip.source_bytes) reasons.push(`≥${Math.round(GITVAULT_LOSS_WARNING_THRESHOLDS.source_bytes / (1024 * 1024))} MB of source`);
  if (trip.days_since_genesis) reasons.push(`≥${GITVAULT_LOSS_WARNING_THRESHOLDS.days_since_genesis} days since genesis`);
  return reasons;
}

/**
 * The standing warning text (design D7): names what tripped, states the
 * resolution honestly (a second principal or human envelope — nothing this
 * client can verify yet), and never claims an attestation would clear it.
 *
 * This is the SINGLE-PRINCIPAL form — use it only when the vault's
 * covering-recipient count is unknown or <= 1. Once a caller has locally
 * proven >= 2 covering recipients, its premise ("only one principal can open
 * it") is false; use {@link gitvaultKeystoreBackupReminderMessage} instead.
 */
export function gitvaultLossWarningMessage(trip: GitvaultLossWarningTrip): string {
  const reasons = gitvaultLossWarningReasons(trip);
  return (
    `this vault has accrued real value at risk (${reasons.join(", ")}) while only one principal can open it. ` +
    "Only a second principal — another keystore, or later a human envelope — demonstrably able to open the vault clears this warning; " +
    "this client cannot verify that yet, so it stands until you add one. No attestation or flag clears it."
  );
}

/**
 * D7's downgraded form (dogfood item 2): once `status()` has locally proven
 * this vault carries >= 2 covering recipients (via the same envelope-recipients
 * read `Gitvault.access` uses), the single-principal premise behind
 * {@link gitvaultLossWarningMessage} is false for THIS vault — printing it
 * anyway would be a false terminal-loss claim. The composite threshold still
 * fires the SAME way (this function does not touch `gitvaultLossWarningTrip`/
 * `gitvaultLossWarningTripped` at all — a real value-at-risk signal is still
 * worth a reminder), but the copy switches to the protocol's own
 * keystore-qualified durability sentence instead of asserting single-principal
 * risk, and never claims terminal loss.
 */
export function gitvaultKeystoreBackupReminderMessage(trip: GitvaultLossWarningTrip, coveringRecipients: number): string {
  const reasons = gitvaultLossWarningReasons(trip);
  return (
    `this vault has accrued real value at risk (${reasons.join(", ")}), but it is covered by ${coveringRecipients} recipients today — not the single-principal case. ` +
    `${GITVAULT_DURABILITY_STATEMENT} Back up this machine's keystore anyway: losing it does not lose the vault, but it does lose YOUR access to it.`
  );
}

/**
 * gitvault-mirror-default — the pure `vault_unmirrored` computation, in ONE
 * place so doctor and `repos view` echo the same finding instead of each
 * deriving their own (the loss-warning pattern above). Present when no mirror
 * is configured, OR when one is configured but has no success evidence yet —
 * either the local `last_success_at` stamp (survives a transiently unreachable
 * mirror) or a chain-verified `mirrored_generation` read from the mirror
 * itself (covers mirrors synced before the stamp existed). Informational,
 * never blocking; every input is client-local or read from the CUSTOMER'S
 * mirror — nothing here touches the gateway.
 */
export function gitvaultUnmirroredFinding(state: {
  configured: boolean;
  last_success_at: string | null;
  mirrored_generation: string | null;
  /** gitvault-byo-primary-bucket task 3.5 — when true, `message` uses the BYO remedy wording (a SECOND customer-held location) instead of the plain unmirrored statement. */
  is_byo?: boolean;
}): GitvaultUnmirroredFinding | null {
  if (state.configured && (state.last_success_at !== null || state.mirrored_generation !== null)) return null;
  return {
    kind: "vault_unmirrored",
    message: state.is_byo ? GITVAULT_BYO_UNMIRRORED_REMEDY_STATEMENT : GITVAULT_UNMIRRORED_FINDING_STATEMENT,
    setup_command: state.configured ? "run402 repos mirror --backfill" : "run402 repos mirror <destination>",
  };
}

/**
 * gitvault-byo-primary-bucket (design D4) — the ONE stderr line a degraded
 * chain/payload read prints: the fallback's own destination (never a
 * credential) plus the canonical, mechanism-only statement. `list`/`fetch`
 * degrading in the SAME `git-remote-run402` session each print their own
 * line (one per degraded READ, not one per session) — see
 * `Gitvault.withDegradedRead`'s own doc comment.
 */
export function gitvaultDegradedReadNote(source: GitvaultDegradedReadSource): string {
  return `degraded read from ${source.destination}: ${GITVAULT_DEGRADED_READ_STATEMENT}`;
}

/**
 * The remote door (kygit-handoff design D8): `"run402"` (the canonical,
 * plumbing spelling — accepted forever) or `"kygit"` (what the
 * `@kychee/kygit` shim renders once it sets `RUN402_REMOTE_SCHEME=kygit`
 * before exec). The gateway never sees this — `address` and every registry
 * `next_actions` command stay `run402::`; only client-side RENDERING reads
 * it. Any other value falls back to `"run402"` rather than emitting an
 * unparseable scheme.
 */
export function gitvaultRemoteScheme(): "run402" | "kygit" {
  return typeof process !== "undefined" && process.env?.RUN402_REMOTE_SCHEME === "kygit" ? "kygit" : "run402";
}

/** `<door>::<org_id>/<project_id>` — what `git-remote-run402`/`git-remote-kygit` resolves. */
export function gitvaultRemoteUrl(orgId: string, projectId: string): string {
  return `${gitvaultRemoteScheme()}::${orgId}/${projectId}`;
}

/**
 * `<door>::<org-slug>/<repo-name>` — the address-form remote builder
 * (repo-first-onramp task 4, design D6). Same string shape as
 * {@link gitvaultRemoteUrl} (the wire slot admits both forms undiscriminated
 * — see {@link gitvaultRemoteAddressForm}); kept as its own named function so
 * a call site states which form it means rather than reusing the id-form
 * builder for a semantically different pair of arguments. Rendered by
 * {@link gitvaultRemoteScheme} (kygit-handoff design D8) — `run402 repos
 * create` renders `run402::`, `kygit create` renders `kygit::`.
 */
export function gitvaultRemoteUrlForRepo(orgSlug: string, repoName: string): string {
  return `${gitvaultRemoteScheme()}::${orgSlug}/${repoName}`;
}

/** What {@link parseGitvaultRemoteUrl} returns — the two undiscriminated address halves. */
export interface GitvaultRemoteAddress {
  org_id: string;
  project_id: string;
}

/**
 * Parse a `run402::<org>/<project>` OR `kygit::<org>/<project>` remote URL
 * (kygit-handoff design D8) into ONE canonical, scheme-less address — the
 * door never changes resolution, only rendering. `null` when it is neither.
 */
export function parseGitvaultRemoteUrl(url: string): GitvaultRemoteAddress | null {
  const m = /^(?:run402|kygit)::([^/]+)\/(.+)$/.exec(url.trim());
  if (!m) return null;
  return { org_id: m[1]!, project_id: m[2]! };
}

/** Which address form a parsed `run402::` remote is (repo-first-onramp task 4, design D6). */
export type GitvaultRemoteAddressForm = "id" | "slug";

const GITVAULT_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const GITVAULT_PROJECT_ID_RE = /^prj_/;

/**
 * Discriminate a parsed address's form (design D6, "resolved"): "org UUIDs
 * and `prj_` prefixes make slug-vs-id in the same slot unambiguous." Both
 * halves must look id-shaped for the address to be treated as id-form — a
 * genuine `run402::<org_uuid>/<prj_id>` address always satisfies both at
 * once, since real org ids are UUIDs and real project ids are always
 * `prj_`-prefixed; anything else (an org slug half, or a bare repo-name half)
 * is slug-form. Resolution accepts either (task 4.3).
 */
export function gitvaultRemoteAddressForm(address: GitvaultRemoteAddress): GitvaultRemoteAddressForm {
  return GITVAULT_UUID_RE.test(address.org_id) && GITVAULT_PROJECT_ID_RE.test(address.project_id) ? "id" : "slug";
}

/** What a `SLUG_RELEASED` refusal names — the successor slug and the cooldown window (design D6). */
export interface GitvaultSlugReleasedInfo {
  successor_slug: string | null;
  released_at: string | null;
  cooldown_until: string | null;
}

/**
 * `SLUG_RELEASED` (a renamed/deleted org slug, still inside its ~90-day
 * cooldown) surfaces as a typed, actionable fact — NEVER auto-followed
 * (design D6: "no redirects, deliberately"). `null` when `err` is not a
 * `SLUG_RELEASED` refusal.
 */
export function gitvaultSlugReleasedInfo(err: unknown): GitvaultSlugReleasedInfo | null {
  const e = err as { code?: string; details?: Record<string, unknown>; body?: Record<string, unknown> } | null;
  if (!e || e.code !== "SLUG_RELEASED") return null;
  const source = (e.details ?? e.body ?? {}) as Record<string, unknown>;
  const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
  return { successor_slug: str(source.successor_slug), released_at: str(source.released_at), cooldown_until: str(source.cooldown_until) };
}

/** A 404/absent-route refusal for the unshipped `retention-cutoffs` endpoint. */
function isMissingCutoffRoute(e: unknown): boolean {
  const err = e as { status?: number; code?: string } | null;
  return Boolean(err && (err.status === 404 || err.code === "RESOURCE_NOT_FOUND" || err.code === "ROUTE_NOT_FOUND"));
}

/**
 * "No vault exists for this address/project yet" — the same 404 shape as
 * {@link isMissingCutoffRoute}, named separately because the two mean
 * different things to their callers (an absent OPTIONAL route vs. an absent
 * RESOURCE). Used by {@link Gitvault.planPush} to distinguish "nothing to
 * preview a push against" from a genuine failure worth rethrowing.
 */
function isVaultResolutionMiss(e: unknown): boolean {
  const err = e as { status?: number; code?: string } | null;
  return Boolean(err && (err.status === 404 || err.code === "RESOURCE_NOT_FOUND" || err.code === "ROUTE_NOT_FOUND"));
}
