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
import { LocalError } from "../errors.js";
import { GITVAULT_TERMINAL_LOSS_DOCTOR_TEXT, GITVAULT_TERMINAL_LOSS_STATEMENT } from "./gitvault.crypto.js";
import type { GitvaultCaptureReceipt, GitvaultHeadsListingPage, GitvaultHeadsListingRequest } from "./gitvault.types.js";
import type {
  GitvaultMaintenanceLease,
  GitvaultMaintenanceLeaseRequest,
  GitvaultTransport,
  GitvaultVaultRecord,
} from "../node/gitvault-publication.js";
import type { GitvaultDeployOptions, GitvaultDeployResult } from "../node/gitvault-deploy.js";
import type { GitvaultPublishResult, GitvaultPushOptions, GitvaultVerifiedState } from "../node/gitvault-publication.js";
import type { GitvaultCreationResult } from "../node/gitvault-creation-journal.js";
import type { GitvaultKeystore } from "../node/gitvault-keystore.js";
import type { GitvaultSnapshot } from "../node/gitvault-snapshot.js";

// The Node modules are loaded lazily and only ever through these helpers, so
// the isomorphic entry point stays free of `node:` imports.
type PublicationModule = typeof import("../node/gitvault-publication.js");
type DeployModule = typeof import("../node/gitvault-deploy.js");
type KeystoreModule = typeof import("../node/gitvault-keystore.js");
type CreationModule = typeof import("../node/gitvault-creation-journal.js");
type SnapshotModule = typeof import("../node/gitvault-snapshot.js");
type PruneModule = typeof import("../node/gitvault-prune.js");

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
  };
  pins: {
    highest_authenticated: string | null;
    highest_materialized: string | null;
  };
  gitvault_policy: "required" | "grandfathered" | null;
  /** Override journals on this machine that have not yet been completed. */
  pending_overrides: number;
  /**
   * Stated verbatim per the client-surface spec — this sentence is normative
   * copy, not a summary, and is printed by `status` and `doctor` alike.
   */
  terminal_loss_statement: typeof GITVAULT_TERMINAL_LOSS_STATEMENT;
  terminal_loss_detail: typeof GITVAULT_TERMINAL_LOSS_DOCTOR_TEXT;
  warnings: { kind: string; message: string }[];
  next_actions: { action: string; command?: string }[];
}

export interface GitvaultInitResult {
  repo_id: string;
  project_id: string;
  /** Emitted once at creation — integrity data, not a secret. Print it, copy it, keep many copies. */
  recovery_receipt: GitvaultCreationResult["recovery_receipt"];
  genesis_sha256: string;
  /** The git remote that was added, when a working tree was scaffolded. */
  remote: { name: string; url: string } | null;
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
  /** Keystore root override (defaults to `~/.run402/source`). */
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
   * Add the `run402` git remote, initialising the repository if absent.
   *
   * Deliberately additive: an existing `origin` is never modified or claimed,
   * and an existing `run402` remote pointing elsewhere is reported rather than
   * silently rewritten. No key material or allocation is required — the
   * cold-start path gains no prompts or network dependencies from this.
   */
  async scaffoldRemote(options: { repo_dir: string; org_id: string; project_id: string; remote_name?: string; remote_url?: string }): Promise<{ name: string; url: string; created_repository: boolean; already_present: boolean; existing_url: string | null }> {
    const { hardenedGit } = await this.#snapshot();
    const name = options.remote_name ?? "run402";
    const url = options.remote_url ?? gitvaultRemoteUrl(options.org_id, options.project_id);
    let createdRepository = false;
    try {
      await hardenedGit(options.repo_dir, ["rev-parse", "--git-dir"]);
    } catch {
      await hardenedGit(options.repo_dir, ["init"]);
      createdRepository = true;
    }
    let existing: string | null = null;
    try {
      existing = (await hardenedGit(options.repo_dir, ["remote", "get-url", name])).text().trim();
    } catch {
      existing = null;
    }
    if (existing) return { name, url, created_repository: createdRepository, already_present: true, existing_url: existing };
    await hardenedGit(options.repo_dir, ["remote", "add", name, url]);
    return { name, url, created_repository: createdRepository, already_present: false, existing_url: null };
  }

  /**
   * What this machine and the control plane each believe about the vault.
   *
   * Truthful for a VAULT-ONLY project (protocol D183): a project that has never
   * deployed raises no deploy-related warning, and the terminal-loss statement
   * is stated verbatim exactly as for any other vault.
   */
  async status(options: GitvaultVaultHandleOptions = {}): Promise<GitvaultStatus> {
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
    const warnings = [...(record?.warnings ?? [])];
    if (keystorePresent && !canSign) {
      warnings.push({ kind: "read_only", message: "the signing key is missing from identity.json — this principal can decrypt and verify but cannot publish a new head" });
    }
    if (record?.gitvault_policy === "grandfathered") {
      warnings.push({ kind: "policy_grandfathered", message: "activation does not require vault admission on this project; return it to `required` when the migration is done" });
    }

    const nextActions: GitvaultStatus["next_actions"] = [];
    if (!record) nextActions.push({ action: "allocate the project's vault", command: "run402 init" });
    else if (pending.length > 0) nextActions.push({ action: `complete ${pending.length} unvaulted-override journal(s)`, command: "run402 gitvault push" });

    return {
      repo_id: repoId,
      project_id: options.project_id ?? record?.project_id ?? null,
      vault: record,
      keystore: { present: keystorePresent, identity_fingerprint: identityFingerprint, can_sign: canSign, holds_repo_key: holdsRepoKey },
      pins: { highest_authenticated: authenticated, highest_materialized: materialized },
      gitvault_policy: record?.gitvault_policy ?? null,
      pending_overrides: pending.length,
      terminal_loss_statement: GITVAULT_TERMINAL_LOSS_STATEMENT,
      terminal_loss_detail: GITVAULT_TERMINAL_LOSS_DOCTOR_TEXT,
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
  ): Promise<GitvaultPublishResult & { snapshot: GitvaultSnapshot; gitvault_commit: string; gitvault_commit_line: string }> {
    const [{ deployRefTransaction }, { captureSnapshot, gitvaultCommitLine }] = await Promise.all([this.#publication(), this.#snapshot()]);
    const handle = await this.open(options);
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
    const result = await handle.vault.push(push);
    return { ...result, snapshot, gitvault_commit: snapshot.oid, gitvault_commit_line: line };
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
        note: "run `run402 gitvault compact` to publish a checkpoint bound to a fresh retention_cutoff ticket, then plan the prune again.",
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
  async verify(options: GitvaultVaultHandleOptions = {}): Promise<GitvaultVerifiedState> {
    const handle = await this.open(options);
    return handle.vault.verifyToNewest();
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
   */
  async deploy(options: Omit<GitvaultDeployOptions, "vault"> & GitvaultVaultHandleOptions): Promise<GitvaultDeployResult> {
    const { runGitvaultDeploy } = await this.#deploy();
    const handle = await this.open(options);
    return runGitvaultDeploy({ ...options, vault: handle.vault, repo_dir: options.repo_dir ?? process.cwd() });
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
}

/** `run402::<org_id>/<project_id>` — what `git-remote-run402` resolves. */
export function gitvaultRemoteUrl(orgId: string, projectId: string): string {
  return `run402::${orgId}/${projectId}`;
}

/** Parse a `run402::<org>/<project>` remote URL. `null` when it is not one. */
export function parseGitvaultRemoteUrl(url: string): { org_id: string; project_id: string } | null {
  const m = /^run402::([^/]+)\/(.+)$/.exec(url.trim());
  if (!m) return null;
  return { org_id: m[1]!, project_id: m[2]! };
}

/** A 404/absent-route refusal for the unshipped `retention-cutoffs` endpoint. */
function isMissingCutoffRoute(e: unknown): boolean {
  const err = e as { status?: number; code?: string } | null;
  return Boolean(err && (err.status === 404 || err.code === "RESOURCE_NOT_FOUND" || err.code === "ROUTE_NOT_FOUND"));
}
