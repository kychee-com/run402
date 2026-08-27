/**
 * The gitvault deploy lane, supplied at last (change `gitvault-deploy-lane`).
 *
 * `add-gitvault` 5.6 built `runGitvaultDeploy` with the lane INJECTED and never
 * supplied one, so a project whose `gitvault_policy` is `required` could not be
 * deployed by any published client. This module is that supplier, plus the
 * entry point the CLI calls in place of a bare `apply()`:
 *
 *   - {@link createApplyDeployLane} drives the shipped `/apply/v1` routes —
 *     plan carrying `{capture_id, snapshot_oid_hmac}`, content upload, then a
 *     commit carrying the activation token — by REUSING `Deploy.apply()` rather
 *     than reassembling it. Warning gating, CAS dedup, event emission, asset
 *     re-plan, and terminal polling are the same code every other deploy runs;
 *     the only difference is two extra wire fields.
 *   - {@link applyWithGitvault} decides whether any of that happens at all. A
 *     project that is not `required` takes the untouched path: no capture, no
 *     token, no extra refusal, one policy read.
 *
 * THE COROUTINE, because it is the non-obvious part. `runGitvaultDeploy` wants
 * two separable steps (plan, then commit) with the vault push running between
 * them; `Deploy.apply()` is one call. The lane bridges them with a pair of
 * deferreds: `apply()`'s `authorize` hook fires once the plan exists and its
 * content is uploaded, which RESOLVES `lane.plan(...)`; it then waits for
 * `lane.commit(...)` to hand back the activation block. If no commit is ever
 * coming — the push failed, or correspondence refused — {@link abandon} rejects
 * that wait so the apply unwinds with nothing committed.
 */

import { LocalError, isRun402Error, type NextAction } from "../errors.js";
import type { Deploy } from "../namespaces/deploy.js";
import type { Gitvault } from "../namespaces/gitvault.js";
import type {
  ApplyOptions,
  DeployResult,
  GitvaultCommitDeclaration,
  LegacyWarningEntry,
  ReleaseSpec,
} from "../namespaces/deploy.types.js";
import type { GitvaultVaultRecord } from "./gitvault-publication.js";
import type {
  GitvaultDeployLane,
  GitvaultDeployLaneCommitInput,
  GitvaultDeployLanePlan,
  GitvaultDeployResult,
} from "./gitvault-deploy.js";

// ─── The lane ────────────────────────────────────────────────────────────────

/** A promise plus its settlers — the handshake between the two call shapes. */
interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  // A rejection that lands before anyone awaits is still handled — the awaiter
  // arrives a tick later, and an unhandled-rejection crash here would take out
  // a deploy that is merely being abandoned.
  promise.catch(() => undefined);
  return { promise, resolve, reject };
}

export interface ApplyDeployLaneOptions {
  /** The apply engine (`r._applyEngine`). */
  engine: Deploy;
  spec: ReleaseSpec;
  /** Everything a normal `apply()` takes: events, idempotency key, warning allowances. */
  apply?: Omit<ApplyOptions, "gitvault">;
}

/** A lane that is also cancellable, because `runGitvaultDeploy` may never commit. */
export interface ApplyDeployLane extends GitvaultDeployLane {
  /**
   * Tell the in-flight apply that no commit is coming. Safe to call always —
   * a no-op once the apply has settled — and safe to call twice.
   */
  abandon(reason: unknown): void;
  /** The `DeployResult`, once a commit landed. `null` on every other path. */
  result(): DeployResult | null;
}

export function createApplyDeployLane(options: ApplyDeployLaneOptions): ApplyDeployLane {
  const planned = deferred<GitvaultDeployLanePlan>();
  const authorized = deferred<GitvaultCommitDeclaration>();
  let applyPromise: Promise<DeployResult> | null = null;
  let result: DeployResult | null = null;
  let settled = false;

  const lane: ApplyDeployLane = {
    async plan(input) {
      applyPromise = options.engine.apply(options.spec, {
        ...(options.apply ?? {}),
        gitvault: {
          declaration: { capture_id: input.capture_id, snapshot_oid_hmac: input.snapshot_oid_hmac },
          authorize: async (p) => {
            if (!p.apply_plan_sha256) {
              // A capture-bearing plan the gateway answered without a canonical
              // digest cannot back a token. Fail the PLAN lane rather than
              // inventing a placeholder: the capture still publishes (with a
              // null digest, so nothing is mintable from it) and the outcome
              // is an honest `DEPLOY_FAILED_VAULTED`.
              const missing = new LocalError(
                "the gateway accepted a capture-bearing plan but returned no apply_plan_sha256; no activation token can be minted for it",
                "planning a gitvault deploy",
                { code: "GITVAULT_PLAN_DIGEST_MISSING", details: { plan_id: p.plan_id, operation_id: p.operation_id } },
              );
              planned.reject(missing);
              throw missing;
            }
            planned.resolve({ plan_id: p.plan_id, operation_id: p.operation_id, apply_plan_sha256: p.apply_plan_sha256 });
            return authorized.promise;
          },
        },
      });
      // A failure BEFORE the plan exists (validate, plan, upload) never calls
      // `authorize`, so surface it as the plan lane's failure — that is what
      // makes it `DEPLOY_FAILED_VAULTED` with a null digest rather than a hang.
      applyPromise.then(
        (r) => { settled = true; result = r; },
        (e) => { settled = true; planned.reject(e); },
      );
      return planned.promise;
    },
    async commit(input: GitvaultDeployLaneCommitInput) {
      authorized.resolve(commitDeclaration(input));
      if (!applyPromise) throw new LocalError("commit was called before plan", "committing gitvault deploy", { code: "GITVAULT_LANE_OUT_OF_ORDER" });
      result = await applyPromise;
      return result;
    },
    abandon(reason) {
      if (settled) return;
      authorized.reject(
        reason instanceof Error
          ? reason
          : new LocalError("the gitvault deploy was abandoned before commit", "committing gitvault deploy", { code: "GITVAULT_DEPLOY_ABANDONED", details: { reason } }),
      );
    },
    result: () => result,
  };
  return lane;
}

function commitDeclaration(input: GitvaultDeployLaneCommitInput): GitvaultCommitDeclaration {
  if (input.allow_unvaulted) return { allow_unvaulted: true, override_reason: input.allow_unvaulted.reason };
  const tokenId = input.activation_token?.object_id;
  if (!tokenId) {
    throw new LocalError(
      "a vaulted commit needs an activation token and none was minted",
      "committing gitvault deploy",
      { code: "GITVAULT_ACTIVATION_TOKEN_MISSING" },
    );
  }
  return { activation_token_id: tokenId };
}

// ─── The entry point ─────────────────────────────────────────────────────────

/** What the deploy did about gitvault, and why. */
export type GitvaultApplyMode =
  /** No vault, or the policy read did not resolve — the plain path ran. */
  | { kind: "none"; reason: "no_vault" | "policy_unreadable" }
  /** A vault exists but the policy is `grandfathered` — the plain path ran. */
  | { kind: "grandfathered"; repo_id: string }
  /**
   * A vault exists but `gitvault_policy` was never set either way — D3:
   * allocating a vault no longer flips the policy, so this is the ordinary
   * shape for a project whose vault came from `run402 gitvault init` (or a
   * lazy first push) and nobody has opted into gating deploys yet. The plain
   * path ran, and the DeployResult carries the offer/warning (see
   * {@link decorateUngatedResult}).
   */
  | { kind: "ungated"; repo_id: string }
  /** The policy is `required` — capture, token, and commit ran. */
  | { kind: "vaulted"; repo_id: string };

/** `run402 repos policy required` — the offer D3 attaches to every ungated deploy. */
export function gitvaultPolicyRequiredNextAction(repoId: string): NextAction {
  return {
    type: "gitvault_policy_required",
    command: "run402 repos policy required",
    why: `vault ${repoId} exists but gitvault_policy was never set, so this deploy ran without requiring a vaulted capture. Set it to require one, or run \`run402 repos policy grandfathered --reason <why>\` to explicitly accept the current state.`,
  };
}

/** The standing `warnings[]` entry D3 attaches to every ungated deploy, until the policy is set either way. */
export function gitvaultUngatedWarning(repoId: string): LegacyWarningEntry {
  return {
    code: "GITVAULT_POLICY_UNSET",
    severity: "low",
    requires_confirmation: false,
    message: `vault ${repoId} is not gated: gitvault_policy was never set, so a deploy can activate without a vaulted capture. Run \`run402 repos policy required\` (or \`grandfathered --reason <why>\` to explicitly accept this) to clear the drift.`,
    affected: [repoId],
  };
}

/** Attach D3's offer + warning to an ungated deploy's result, without disturbing anything else on it. */
function decorateUngatedResult(result: DeployResult, repoId: string): DeployResult {
  return {
    ...result,
    warnings: [...(result.warnings ?? []), gitvaultUngatedWarning(repoId)],
    next_actions: [...(result.next_actions ?? []), gitvaultPolicyRequiredNextAction(repoId)],
  };
}

export interface ApplyWithGitvaultResult {
  mode: GitvaultApplyMode;
  /** The deploy result. `null` when a vaulted deploy did not reach a commit. */
  deploy: DeployResult | null;
  /** The five-outcome envelope. `null` on every non-`required` path. */
  gitvault: GitvaultDeployResult | null;
}

export interface ApplyWithGitvaultOptions {
  sdk: { _applyEngine: Deploy; gitvault: Gitvault };
  spec: ReleaseSpec;
  apply?: Omit<ApplyOptions, "gitvault">;
  /** The work tree to capture. Defaults to the process cwd. */
  repo_dir?: string;
  /** Override the keystore root (tests, non-default profiles). */
  keystore_root?: string;
  /** The audited unvaulted override — requires `gitvault.override_unvaulted`. */
  allow_unvaulted?: { reason: string };
  /**
   * Capture a dirty tree anyway. Default `false` — a dirty work tree refuses
   * `SNAPSHOT_DIRTY_TREE` before this deploy's capture runs at all (same
   * default as the manual `repos snapshot` lane; see `gitvault-snapshot.ts`).
   * Has no effect on a `none`/`grandfathered`/`ungated` deploy, which never
   * captures.
   */
  allowDirty?: boolean;
  /** Receives the `gitvault_commit` line the moment the snapshot exists. */
  onCommitLine?: (line: string) => void;
  /** Target passthrough; a Core target never engages the vault lane. */
  target?: "cloud" | "core";
}

/**
 * Deploy, taking the project's `gitvault_policy` into account.
 *
 * NOT `required` — no vault, an unreadable policy, a Core target, or an
 * explicit `grandfathered` — runs `apply()` with the caller's own options and
 * nothing else. That path must stay byte-identical: it is every non-vault
 * user's deploy, and the only cost this function may add to it is the single
 * policy read that determines the project is not `required`.
 */
export async function applyWithGitvault(options: ApplyWithGitvaultOptions): Promise<ApplyWithGitvaultResult> {
  const applyOpts: Omit<ApplyOptions, "gitvault"> = {
    ...(options.apply ?? {}),
    ...(options.target ? { target: options.target } : {}),
  };
  const plain = async (mode: GitvaultApplyMode): Promise<ApplyWithGitvaultResult> => ({
    mode,
    deploy: await options.sdk._applyEngine.apply(options.spec, applyOpts),
    gitvault: null,
  });

  // A self-hosted Core gateway has no vault gate; never spend a round trip.
  if (options.target === "core") return plain({ kind: "none", reason: "no_vault" });

  const record = await readVaultRecord(options.sdk.gitvault, options.spec.project);
  if (!record) return plain({ kind: "none", reason: "policy_unreadable" });
  if (record.gitvault_policy === "grandfathered") {
    return plain({ kind: "grandfathered", repo_id: record.repo_id });
  }
  if (record.gitvault_policy !== "required") {
    // D3: allocation no longer sets `gitvault_policy`, so a vault whose
    // policy is `null` is the ORDINARY shape, not a weakened one — the
    // deploy is never blocked or interactively prompted on this. It still
    // runs the untouched plain path (same options object, no gitvault hooks);
    // the only difference from `grandfathered` is that the result carries an
    // offer to gate, plus a standing warning naming the drift until the
    // policy is set either way (spec scenario "Ungated drift stays visible").
    const deploy = await options.sdk._applyEngine.apply(options.spec, applyOpts);
    return { mode: { kind: "ungated", repo_id: record.repo_id }, deploy: decorateUngatedResult(deploy, record.repo_id), gitvault: null };
  }

  const lane = createApplyDeployLane({ engine: options.sdk._applyEngine, spec: options.spec, apply: applyOpts });
  let gitvault: GitvaultDeployResult;
  try {
    gitvault = await options.sdk.gitvault.deploy({
      lane,
      repo_id: record.repo_id,
      repo_dir: options.repo_dir ?? process.cwd(),
      ...(options.keystore_root !== undefined ? { keystore_root: options.keystore_root } : {}),
      ...(options.allow_unvaulted ? { allow_unvaulted: options.allow_unvaulted } : {}),
      ...(options.onCommitLine ? { onCommitLine: options.onCommitLine } : {}),
      ...(options.allowDirty ? { snapshot: { allowDirty: true } } : {}),
    });
  } catch (err) {
    // Every throw here is a refusal that precedes activation — a snapshot
    // refusal, `SNAPSHOT_MOVED_DURING_DEPLOY`, or an unauthorized override.
    // Unwind the apply so no plan is left mid-flight, then surface the
    // refusal as itself: it is the caller's answer, not something to retry
    // under a fresh capture.
    lane.abandon(err);
    throw enrichCaptureRefusal(err, record.repo_id);
  } finally {
    lane.abandon(new LocalError("the deploy ended without committing this plan", "committing gitvault deploy", { code: "GITVAULT_DEPLOY_ABANDONED" }));
  }
  return { mode: { kind: "vaulted", repo_id: record.repo_id }, deploy: lane.result(), gitvault };
}

/**
 * Read the vault record, or `null` when it cannot be read.
 *
 * A read that fails for ANY reason is not a deploy failure: the gateway is the
 * authority on the policy and refuses the commit itself if a capture was
 * genuinely required. Turning a transient control-plane blip into a failed
 * deploy for a project that has no vault at all would be the worse trade.
 */
async function readVaultRecord(gitvault: Gitvault, projectId: string): Promise<GitvaultVaultRecord | null> {
  try {
    return await gitvault.forProject(projectId);
  } catch {
    return null;
  }
}

/**
 * A `required` project whose keystore this machine does not hold cannot
 * capture. The protocol's own code is PRESERVED (`KEYSTORE_MISSING` /
 * `GITVAULT_REPO_STATE_MISSING` — surfacing the typed outcome rather than
 * substituting one), with actions prepended that actually resolve it.
 */
function enrichCaptureRefusal(err: unknown, repoId: string): unknown {
  if (!isRun402Error(err)) return err;
  const e = err as { code?: string; message: string; details?: unknown; next_actions?: unknown[] };
  if (e.code !== "KEYSTORE_MISSING" && e.code !== "GITVAULT_REPO_STATE_MISSING") return err;
  return new LocalError(
    `${e.message} — this project's gitvault_policy is \`required\`, so a deploy from this machine needs the vault keystore`,
    "capturing for a gitvault-required deploy",
    {
      code: e.code,
      details: { repo_id: repoId, ...(e.details && typeof e.details === "object" ? e.details : {}) },
      next_actions: [
        { action: "restore the gitvault keystore onto this machine (run402 repos view prints keystore.root; back it up from the machine that holds it)" },
        { action: 'run402 repos policy grandfathered --reason "<why>" — un-gate the project so deploys activate without a capture (owner + step-up, audited, doctor-persistent advisory)' },
        ...(Array.isArray(e.next_actions) ? e.next_actions : []),
      ],
    },
  );
}
