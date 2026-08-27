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
import { LocalError, isRun402Error } from "../errors.js";
import {
  GITVAULT_DURABILITY_STATEMENT,
  GITVAULT_MIRROR_KEYSTORE_STILL_REQUIRED_STATEMENT,
  GITVAULT_MIRROR_VALIDITY_NOT_FRESHNESS_STATEMENT,
  GITVAULT_TERMINAL_LOSS_DOCTOR_TEXT,
  GITVAULT_TERMINAL_LOSS_STATEMENT,
} from "./gitvault.crypto.js";
import type { GitvaultCaptureReceipt, GitvaultHeadsListingPage, GitvaultHeadsListingRequest, GitvaultHeadTarget, GitvaultRecipientConfirmationReceipt, GitvaultRecoveryReceipt, GitvaultRotationReason } from "./gitvault.types.js";
import type {
  GitvaultEnvelopeRecipientsResponse,
  GitvaultMaintenanceLease,
  GitvaultMaintenanceLeaseRequest,
  GitvaultTransport,
  GitvaultVaultRecord,
} from "../node/gitvault-publication.js";
import type { GitvaultDeployOptions, GitvaultDeployResult } from "../node/gitvault-deploy.js";
import type { GitvaultPublishResult, GitvaultPushOptions, GitvaultRefMap, GitvaultReconcileEnvelopeRecipientsResult, GitvaultVerifiedState } from "../node/gitvault-publication.js";
import type { GitvaultCreationResult } from "../node/gitvault-creation-journal.js";
import type { GitvaultKeystore } from "../node/gitvault-keystore.js";
import type { GitvaultSnapshot } from "../node/gitvault-snapshot.js";
import type { GitvaultMirrorConfig, GitvaultMirrorCredential, GitvaultMirrorDestination } from "../node/gitvault-mirror-config.js";
import type { GitvaultMirrorPushResult, GitvaultMirrorSyncSummary } from "../node/gitvault-mirror.js";
import type { GitvaultRecoverResult, GitvaultVerifyReport } from "../node/gitvault-recover.js";

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

// ─── Public result shapes (snake_case on the wire, per docs/style.md) ─────────

/** What `r.gitvault.status()` reports. Never carries key material. */
export interface GitvaultStatus {
  repo_id: string | null;
  project_id: string | null;
  /** The control plane's view. `null` when no vault is allocated for the project. */
  vault: GitvaultVaultRecord | null;
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
}

/** {@link Gitvault.push}'s best-effort envelope-recipient reconcile outcome, reported beside (never folded into) the vault result — same non-blocking contract as {@link GitvaultMirrorPushResult}. */
export interface GitvaultReconcileEnvelopeRecipientsPushResult {
  attempted: boolean;
  outcome: "reconciled" | "skipped_error";
  result?: GitvaultReconcileEnvelopeRecipientsResult;
  error?: string;
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
  validity_not_freshness: typeof GITVAULT_MIRROR_VALIDITY_NOT_FRESHNESS_STATEMENT;
  keystore_still_required: typeof GITVAULT_MIRROR_KEYSTORE_STILL_REQUIRED_STATEMENT;
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
  verified_to_generation: string;
  /** `true` only when `write` was true AND a pin actually moved. */
  local_state_changed: boolean;
  pin_before: { highest_authenticated: string | null; highest_materialized: string | null };
  pin_after: { highest_authenticated: string | null; highest_materialized: string | null };
  /** The real, computed ref map — present even under `--no-write` (computing is not the same as persisting). */
  refs: GitvaultRefMap;
  head_target: GitvaultHeadTarget | null;
  /** Present only when `--mirror` was requested. Proves validity, never freshness — see its own honesty statements. */
  mirror: GitvaultVerifyReport | null;
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
  this_keystore: { fingerprint: string; covered: true } | null;
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
    const transport = createGitvaultHttpTransport(this.#client);
    const vault = new GitvaultVault({
      keystore,
      transport,
      repo_id: repoId,
      ...(options.repo_dir !== undefined ? { repo_dir: options.repo_dir } : {}),
      ...(options.verification_budget !== undefined ? { verification_budget: options.verification_budget } : {}),
      ...(options.service_public_key !== undefined ? { service_public_key: options.service_public_key } : {}),
    });
    return { repo_id: repoId, keystore, transport, vault };
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
   * local git state on the first successful slug-form resolution, and —
   * when `allow_create` is set and resolution misses —
   * push-to-create it. This is what the remote helper and
   * `gitvault snapshot` drive for a `run402::<org-slug>/<name>` remote; an
   * id-form remote resolves through here too (no pin, since it needs none)
   * so a caller need not branch on the address's form itself.
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
  }): Promise<GitvaultInitResult> {
    const [{ createGitvaultHttpTransport }, { GitvaultKeystore }, { createGitvault }] = await Promise.all([this.#publication(), this.#keystore(), this.#creation()]);
    const keystore = new GitvaultKeystore(options.keystore_root !== undefined ? { rootDir: options.keystore_root } : {});
    const created: GitvaultCreationResult = await createGitvault({
      keystore,
      transport: createGitvaultHttpTransport(this.#client),
      org_id: options.org_id,
      project_id: options.project_id,
      ...(options.client_creation_id !== undefined ? { client_creation_id: options.client_creation_id } : {}),
      ...(options.service_public_key !== undefined ? { service_public_key: options.service_public_key } : {}),
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

    return {
      repo_id: created.repo_id,
      project_id: options.project_id,
      recovery_receipt: created.recovery_receipt,
      genesis_sha256: created.genesis_sha256,
      remote,
      deduplicated: created.how === "reconciled",
      terminal_loss_statement: GITVAULT_TERMINAL_LOSS_STATEMENT,
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
  ): Promise<GitvaultPublishResult & { snapshot: GitvaultSnapshot; gitvault_commit: string; gitvault_commit_line: string; mirror_push: GitvaultMirrorPushResult; reconcile_recipients: GitvaultReconcileEnvelopeRecipientsPushResult }> {
    const [{ deployRefTransaction }, { captureSnapshot, gitvaultCommitLine }] = await Promise.all([this.#publication(), this.#snapshot()]);
    const opened = options.address
      ? await this.resolveOrCreateAddress({ ...options, address: options.address, allow_create: true })
      : await this.openOrCreate(options);
    if (!opened.found && opened.created) await options.onVaultCreated?.(opened.created);
    const handle = opened.handle;
    const repoDir = options.repo_dir ?? process.cwd();
    const snapshot = await captureSnapshot({ dir: repoDir, ...(options.snapshot ?? {}) });
    const line = gitvaultCommitLine(snapshot);
    options.onCommitLine?.(line);
    const materialized = await handle.vault.materialize();
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
    // Deploy-time reconcile hook: fires on every successful push,
    // best-effort — a reconcile failure (including a read-only principal
    // with no signing key) is reported BESIDE the vault result, never a
    // `push()` throw, same non-blocking contract as the mirror hook above.
    const reconcileRecipients = await this.#tryReconcileEnvelopeRecipients(handle.vault);
    return { ...result, snapshot, gitvault_commit: snapshot.oid, gitvault_commit_line: line, mirror_push: mirrorPush, reconcile_recipients: reconcileRecipients };
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
    if (details.revocation_outstanding) nextActions.push({ action: "run402 repos access revoke-key <principal_id>", why: "an org membership removal or key revocation is outstanding for this vault (owner + step-up)" });
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

  /** Best-effort envelope-recipient reconcile: catches EVERYTHING so a reconcile problem can never surface as a `push()` throw (mirrors {@link #tryMirrorPush}'s contract exactly). */
  async #tryReconcileEnvelopeRecipients(vault: import("../node/gitvault-publication.js").GitvaultVault): Promise<GitvaultReconcileEnvelopeRecipientsPushResult> {
    try {
      const result = await vault.reconcileEnvelopeRecipients();
      return { attempted: true, outcome: "reconciled", result };
    } catch (e) {
      return { attempted: false, outcome: "skipped_error", error: e instanceof Error ? e.message : String(e) };
    }
  }

  /**
   * A REAL preview of what {@link push} would publish (kychee-com/run402#565)
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
    } = {},
  ): Promise<GitvaultCompactResult> {
    const handle = await this.open(options);
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
      };
    } finally {
      if (lease) {
        await this.#client
          .request(`/gitvault/v1/vaults/${encodeURIComponent(handle.repo_id)}/maintenance-leases/${encodeURIComponent(lease.maintenance_lease_id)}`, { method: "DELETE", body: { holder_token: lease.holder_token }, context: "releasing the gitvault maintenance lease" })
          .catch(() => undefined);
      }
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
    await this.#uploadVerifierReceipts(handle, pub, [ours, options.submit.verifier_receipt]);
    let stored = await handle.vault.transport.submitPruneIntent({ repo_id: handle.repo_id, intent_bytes: prune.pruneIntentBytes(intent) });
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
    await handle.vault.transport.uploadObjects({ repo_id: handle.repo_id, objects });
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
   * (what `verify()` did) AND materialize the ref map (what `status({refs:
   * true})` used to do before `--refs` was removed from `view`), reporting
   * BOTH local trust pins — authenticated and materialized — before and
   * after, with an explicit `local_state_changed` flag. This is the one
   * place chain materialization and pin advance live now; `view` never
   * calls it.
   *
   * `options.write` (default `true`) is the inverse of the CLI's
   * `--no-write`: `false` still walks and decrypts everything (the returned
   * `refs`/`verified_to_generation` are real, computed answers, not
   * estimates) but persists neither pin — a genuine audit mode, not a
   * simulation. `options.mirror` additionally runs the keyless mirror
   * verification ({@link mirrorVerify}) and folds its report in; that half
   * proves the mirror's validity, never its freshness (its own honesty
   * statements ride the result unchanged).
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
    const handle = await this.open({ ...options, repo_id: repoId });
    const state = await handle.vault.materialize({ persist: write });
    const mirror = options.mirror ? await this.mirrorVerify({ ...options, repo_id: repoId }) : null;

    const pinBefore = { highest_authenticated: before.pins.highest_authenticated, highest_materialized: before.pins.highest_materialized };
    const pinAfter = write
      ? { highest_authenticated: state.generation, highest_materialized: state.generation }
      : pinBefore;
    const localStateChanged = write && (pinBefore.highest_authenticated !== pinAfter.highest_authenticated || pinBefore.highest_materialized !== pinAfter.highest_materialized);

    return {
      repo_id: repoId,
      write,
      verified_from_generation: pinBefore.highest_authenticated,
      verified_to_generation: state.generation,
      local_state_changed: localStateChanged,
      pin_before: pinBefore,
      pin_after: pinAfter,
      refs: { ...state.refs },
      head_target: state.head_target,
      mirror,
    };
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
   * `run402 gitvault reconcile` was this method's explicit standalone CLI
   * surface (design D5's "session start" hook); repo-surface-consolidation
   * D5/D7/D10 REMOVED it (no `repos` equivalent — `reconcile` is a
   * workaround, not a permanent verb) and it now answers `COMMAND_REMOVED`
   * pointing at `repos access` for inspection. This method itself is
   * unchanged and un-retired: `deploy()` still runs it, best-effort,
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
   * `recipient_key_revoked` reason.
   */
  async rotateEpoch(
    options: GitvaultVaultHandleOptions & { reason: GitvaultRotationReason; recipient_state_version: string; recipient_revocation_version: string; client_idempotency_key?: string },
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
   */
  async publishPinManifestUpdate(
    input: { principal_id: string; ek_fingerprint: string; receipt: GitvaultRecipientConfirmationReceipt } & GitvaultVaultHandleOptions,
  ): Promise<import("../node/gitvault-publication.js").GitvaultPublishResult> {
    const handle = await this.open(input);
    return handle.vault.publishPinManifestUpdate({ principal_id: input.principal_id, ek_fingerprint: input.ek_fingerprint, confirmed_by: "operator_confirmation", receipt: input.receipt });
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
    const thisKeystore: GitvaultAccessResult["this_keystore"] = ownFingerprint !== null && unmatchedRaw.includes(ownFingerprint) ? { fingerprint: ownFingerprint, covered: true } : null;
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
  ): Promise<GitvaultDeployResult & { mirror_push?: GitvaultMirrorPushResult; reconcile_recipients?: GitvaultReconcileEnvelopeRecipientsPushResult }> {
    const { runGitvaultDeploy } = await this.#deploy();
    const handle = await this.open(options);
    const result = await runGitvaultDeploy({ ...options, vault: handle.vault, repo_dir: options.repo_dir ?? process.cwd() });
    // Same ordering push() uses (mirror, then reconcile) — sequential, not
    // Promise.all, so a reconcile failure can never be misread as a mirror
    // failure in a log line that assumed ordering. Extracted to a standalone
    // function so the outcome-gating is unit-testable with fake thunks,
    // without standing up a live vault — see gitvault-deploy-hooks.test.ts.
    return attachGitvaultDeployHooks(
      result,
      () => this.#tryMirrorPush(handle.repo_id, handle.keystore),
      () => this.#tryReconcileEnvelopeRecipients(handle.vault),
    );
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
  async restore(options: GitvaultVaultHandleOptions & { target_dir: string }): Promise<{ refs: Record<string, string>; generation: string }> {
    const handle = await this.open(options);
    const out = await handle.vault.restoreObjectsInto(options.target_dir);
    return { refs: out.refs, generation: out.generation };
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
  async mirrorStatus(options: GitvaultVaultHandleOptions = {}): Promise<GitvaultMirrorStatus> {
    const [{ GitvaultKeystore }, { readMirrorConfig, formatMirrorDestination }, { openGitvaultMirrorBackend }, { verifyGitvaultMirror }] = await Promise.all([
      this.#keystore(), this.#mirrorConfig(), this.#mirrorBackend(), this.#recovery(),
    ]);
    const repoId = await this.#resolveRepoId(options);
    const keystore = new GitvaultKeystore(options.keystore_root !== undefined ? { rootDir: options.keystore_root } : {});
    const config = readMirrorConfig(keystore, repoId);
    const base = { repo_id: repoId, validity_not_freshness: GITVAULT_MIRROR_VALIDITY_NOT_FRESHNESS_STATEMENT, keystore_still_required: GITVAULT_MIRROR_KEYSTORE_STILL_REQUIRED_STATEMENT };
    if (!config) {
      return { ...base, configured: false, destination: null, credential_kind: null, mirrored_generation: null, newest_generation: null, is_current: null, closing_command: null };
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
   */
  async recover(options: { source: string; out_dir: string; repo_id?: string; credential?: GitvaultMirrorCredential; region?: string; endpoint?: string; recovery_receipt?: GitvaultRecoveryReceipt; keystore_root?: string }): Promise<GitvaultRecoverResult> {
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
    return recoverGitvaultMirror({ backend, out_dir: options.out_dir, keystore, ...(options.recovery_receipt ? { recovery_receipt: options.recovery_receipt } : {}) });
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

/** `run402::<org_id>/<project_id>` — what `git-remote-run402` resolves. */
export function gitvaultRemoteUrl(orgId: string, projectId: string): string {
  return `run402::${orgId}/${projectId}`;
}

/**
 * `run402::<org-slug>/<repo-name>` — the address-form remote builder
 * (repo-first-onramp task 4, design D6). Same string shape as
 * {@link gitvaultRemoteUrl} (the wire slot admits both forms undiscriminated
 * — see {@link gitvaultRemoteAddressForm}); kept as its own named function so
 * a call site states which form it means rather than reusing the id-form
 * builder for a semantically different pair of arguments.
 */
export function gitvaultRemoteUrlForRepo(orgSlug: string, repoName: string): string {
  return `run402::${orgSlug}/${repoName}`;
}

/** What {@link parseGitvaultRemoteUrl} returns — the two undiscriminated address halves. */
export interface GitvaultRemoteAddress {
  org_id: string;
  project_id: string;
}

/** Parse a `run402::<org>/<project>` remote URL. `null` when it is not one. */
export function parseGitvaultRemoteUrl(url: string): GitvaultRemoteAddress | null {
  const m = /^run402::([^/]+)\/(.+)$/.exec(url.trim());
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
