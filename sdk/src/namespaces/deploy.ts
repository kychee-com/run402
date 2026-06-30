/**
 * `deploy` namespace — the canonical unified deploy primitive.
 *
 * Three layers exposed:
 *   - `apply(spec, opts?)`  — one-shot, awaits to completion or terminal failure.
 *   - `start(spec, opts?)`  — returns a `DeployOperation` with `events()` + `result()`.
 *   - `plan` / `upload` / `commit` — low-level steps for CLI and tests.
 *
 * All bytes ride through the CAS content service via presigned PUTs to S3.
 * The wire body to `POST /apply/v1/plans` carries `ContentRef` objects only —
 * never inline file bytes. When the normalized spec exceeds 5 MB JSON, the
 * SDK uploads the manifest itself as a CAS object and references it.
 *
 * Idempotency is keyed on the gateway-computed manifest digest, not the
 * SDK's local digest. The SDK does not canonicalize for correctness — the
 * gateway is authoritative.
 *
 * See `unified-deploy` and `cas-content` capability specs for normative
 * behavior; this file is the implementation.
 */

import type { Client } from "../kernel.js";
import { isCiSessionCredentials } from "../ci-credentials.js";
import { assertCiDeployableSpec } from "./ci.js";
import {
  ROUTE_HTTP_METHODS,
  normalizeDeployResolveRequest,
} from "./deploy.types.js";
import {
  ApiError,
  LocalError,
  NetworkError,
  PaymentRequired,
  Run402DeployError,
  Unauthorized,
  isTransferFreezeError,
  type Run402DeployErrorCode,
  type Run402DeployErrorFix,
} from "../errors.js";
import type {
  ApplyOptions,
  ActiveReleaseInventory,
  AssetPutEntry,
  AssetPutEntryInput,
  AssetSpec,
  CommitResponse,
  ContentPlanResponse,
  ContentRef,
  ContentSource,
  DeployEvent,
  DeployEventsResponse,
  DeployDiff,
  DeployListOptions,
  DeployListResponse,
  DeployOperation,
  DeployResult,
  DeployResolveOptions,
  DeployResolveResponse,
  FileSet,
  FsFileSource,
  GatewayDeployError,
  LocalDirRef,
  MissingContent,
  NormalizedAssetSpec,
  NormalizedDatabaseSpec,
  NormalizedFunctionSpec,
  NormalizedFunctionsSpec,
  NormalizedMigrationSpec,
  NormalizedReleaseSpec,
  NormalizedSiteSpec,
  OperationSnapshot,
  OperationStatus,
  PlanRequest,
  PlanResponse,
  PromoteOptions,
  PromoteResult,
  ReleaseDiffOptions,
  ReleaseInventory,
  ReleaseInventoryByIdOptions,
  ReleaseInventoryOptions,
  ReleaseSpec,
  ReleaseToReleaseDiff,
  StartOptions,
  WarningEntry,
} from "./deploy.types.js";
import {
  assertAssetMetadata,
  assertExifPolicy,
} from "./assets-validation.js";
import type { TierStatusResult } from "./tier.js";

// ─── Constants ───────────────────────────────────────────────────────────────

const PLAN_BODY_LIMIT_BYTES = 5 * 1024 * 1024;
const COMMIT_POLL_INITIAL_MS = 1_000;
const COMMIT_POLL_MAX_MS = 30_000;
const COMMIT_POLL_BACKOFF_AFTER_MS = 30_000;
const COMMIT_POLL_TIMEOUT_MS = 10 * 60 * 1000;
const APPLY_RETRY_DEFAULT_MAX_RETRIES = 2;
const APPLY_RETRY_BASE_DELAY_MS = 250;
const APPLY_RETRY_MAX_DELAY_MS = 2_000;
const APPLY_RETRY_JITTER_MS = 100;
const URL_REFRESH_AT_MS = 50 * 60 * 1000;
const SECRET_KEY_RE = /^[A-Z_][A-Z0-9_]{0,127}$/;
const APPLY_SAFE_RETRY_CODES = new Set<Run402DeployErrorCode>([
  "BASE_RELEASE_CONFLICT",
]);
const STATIC_ACTIVATION_FAILURE_CODES = new Set<string>([
  "BAD_FIELD",
  "INVALID_SPEC",
  "FUNCTION_ACTIVATE_FAILED",
  "FUNCTION_CONFIG_INVALID",
  "FUNCTION_TIMEOUT_EXCEEDS_TIER",
  "FUNCTION_MEMORY_EXCEEDS_TIER",
  "FUNCTION_SCHEDULE_EXCEEDS_TIER",
  "FUNCTION_SCHEDULE_INTERVAL_TOO_SHORT",
  "FUNCTION_SCHEDULE_LIMIT_EXCEEDED",
  "TIER_LIMIT_EXCEEDED",
]);
const STATIC_FUNCTION_LIMITS_BY_TIER: Record<string, StaticTierFunctionLimits> = {
  prototype: {
    maxTimeoutSeconds: 10,
    maxMemoryMb: 128,
    maxScheduledFunctions: 1,
    minCronIntervalMinutes: 15,
  },
  hobby: {
    maxTimeoutSeconds: 30,
    maxMemoryMb: 256,
    maxScheduledFunctions: 3,
    minCronIntervalMinutes: 5,
  },
  team: {
    maxTimeoutSeconds: 60,
    maxMemoryMb: 512,
    maxScheduledFunctions: 10,
    minCronIntervalMinutes: 1,
  },
};

const MANIFEST_CONTENT_TYPE =
  "application/vnd.run402.deploy-manifest+json";

const TERMINAL_STATUSES: OperationStatus[] = [
  "ready",
  "failed",
  "rolled_back",
  "needs_repair",
];
const SUCCESS_STATUS: OperationStatus = "ready";
type DeployTarget = "cloud" | "core";

interface CoreCommitResponse {
  plan_id: string;
  project_id: string;
  release_id: string;
  release_digest: string;
  status: "committed" | "noop" | "deferred";
  deferred_phase?: "schema_settling" | "activation_pending";
  deferred_reason?: string;
}

// ─── Public class ────────────────────────────────────────────────────────────

export class Deploy {
  constructor(private readonly client: Client) {}

  /**
   * One-shot deploy. Normalizes byte sources, plans, uploads missing
   * content, commits, and polls until terminal. Throws
   * {@link Run402DeployError} on any state-machine failure.
   */
  async apply(spec: ReleaseSpec, opts: ApplyOptions = {}): Promise<DeployResult> {
    const maxRetries = normalizeApplyMaxRetries(opts.maxRetries);
    const maxAttempts = maxRetries + 1;
    const emit = makeEmitter(opts.onEvent);

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await applyOnce(this.client, spec, opts, emit);
      } catch (err) {
        if (!(err instanceof Run402DeployError)) throw err;
        const safeToRetry = isSafeDeployApplyRetry(err, spec);
        if (!safeToRetry) throw err;
        if (attempt === maxAttempts) {
          if (maxRetries > 0) {
            throw withDeployRetryMetadata(err, attempt, maxRetries, err.code);
          }
          throw err;
        }
        const delayMs = deployApplyRetryDelayMs(attempt);
        emit({
          type: "deploy.retry",
          attempt,
          nextAttempt: attempt + 1,
          maxAttempts,
          delayMs,
          code: err.code,
          phase: err.phase,
          resource: err.resource,
          operationId: err.operationId,
          planId: err.planId,
          message: err.message,
        });
        await sleep(delayMs);
      }
    }

    throw new Run402DeployError("Deploy retry loop ended without a result", {
      code: "INTERNAL_ERROR",
      phase: "apply",
      retryable: false,
      context: "applying deploy",
    });
  }

  /**
   * Start a resumable deploy operation. Returns an object exposing the
   * operation id, an event async-iterable, and a result promise.
   */
  start(spec: ReleaseSpec, opts: StartOptions = {}): Promise<DeployOperation> {
    return startInternal(this.client, spec, opts);
  }

  /**
   * Low-level plan: normalize the spec, upload the manifest as CAS if over
   * the inline limit, and call `POST /apply/v1/plans`. Returns the plan
   * response and a byte-reader map keyed by sha256 (used by `upload`).
   */
  async plan(
    spec: ReleaseSpec,
    opts: {
      idempotencyKey?: string;
      dryRun?: boolean;
      mode?: "legacyDryRun" | "reviewedPlan";
      requiredPlan?: { planId: string; planFingerprint?: string };
    } = {},
  ): Promise<{ plan: PlanResponse; byteReaders: Map<string, ByteReader> }> {
    return planInternal(this.client, spec, opts.idempotencyKey, {
      dryRun: opts.dryRun ?? opts.mode === "legacyDryRun",
      reviewedPlan: opts.mode === "reviewedPlan",
      requiredPlan: opts.requiredPlan,
    });
  }

  /**
   * Low-level upload: ensure every ref the gateway reported as missing for
   * this project has bytes in CAS. Issues a content-plan, PUTs bytes to
   * the returned presigned URLs, and finalizes the content plan. Caller
   * passes the project id so the apikey-gated CAS routes can authenticate.
   */
  async upload(
    plan: PlanResponse,
    opts: {
      project: string;
      byteReaders: Map<string, ByteReader>;
      onEvent?: (event: DeployEvent) => void;
    },
  ): Promise<void> {
    const emit = makeEmitter(opts.onEvent);
    await uploadMissing(
      this.client,
      opts.project,
      plan.missing_content,
      opts.byteReaders,
      emit,
    );
  }

  /**
   * Low-level commit: `POST /apply/v1/plans/:plan_id/commit`, then poll
   * `/operations/:id` until terminal. Pass the project id whose anon_key
   * should authenticate the polling — the operations endpoint requires
   * apikey auth even though the plan/commit endpoints accept SIWX.
   */
  async commit(
    planId: string,
    opts: {
      onEvent?: (event: DeployEvent) => void;
      idempotencyKey?: string;
      project?: string;
      requiredPlan?: { planId: string; planFingerprint?: string };
    } = {},
  ): Promise<DeployResult> {
    const emit = makeEmitter(opts.onEvent);
    const commit = requireCloudCommitResponse(
      await commitInternal(this.client, planId, opts.idempotencyKey, opts.project, opts.requiredPlan),
      "committing deploy",
    );
    return await pollUntilReady(this.client, commit, {}, [], emit, opts.project);
  }

  /**
   * Resume an operation in `schema_settling` or `activation_pending`. The
   * gateway re-runs only the failed phase forward — never replays SQL.
   * Returns the resulting snapshot, polling until terminal. The resume
   * endpoint accepts wallet (SIWX) auth; the polling that follows requires
   * the project's apikey, so pass `project` to enable polling. (Without
   * `project`, this method returns once the gateway accepts the resume
   * request — successful resumes typically reach `ready` synchronously
   * via the auto-resume worker.)
   */
  async resume(
    operationId: string,
    opts: { onEvent?: (event: DeployEvent) => void; project?: string } = {},
  ): Promise<DeployResult> {
    if (!operationId || !operationId.startsWith("op_")) {
      throw new Run402DeployError(`Invalid operation id: "${operationId}"`, {
        code: "OPERATION_NOT_FOUND",
        retryable: false,
        context: "resuming deploy operation",
      });
    }
    const emit = makeEmitter(opts.onEvent);
    let snapshot: OperationSnapshot;
    try {
      snapshot = await this.client.request<OperationSnapshot>(
        `/apply/v1/operations/${encodeURIComponent(operationId)}/resume`,
        { method: "POST", context: "resuming deploy operation" },
      );
    } catch (err) {
      throw translateDeployError(err, "resume", null, operationId);
    }
    return await pollSnapshotUntilReady(this.client, snapshot, {}, [], emit, opts.project);
  }

  /**
   * Promote an existing release to be the project's current live release —
   * a pointer swap on `internal.projects.live_release_id` without re-running
   * the apply pipeline. Designed for operator recovery from a destructive
   * apply ("oops on a real project ID"). The prior release's bytes,
   * functions, and migrations remain persisted; this just routes traffic
   * back to them.
   *
   * Surfaces structured warnings via the result envelope:
   *
   *   - `MIGRATIONS_NOT_REVERSIBLE` (requires_confirmation: true) when the
   *     target release predates migrations applied since. The migrations
   *     remain applied; the new live release runs against the current
   *     schema. Ack via `opts.allowWarningCodes`.
   *
   *   - `FUNCTION_VERSION_MISMATCH` (informational) when overlapping
   *     function names have different code_hashes. The Lambda code is
   *     whatever's currently $LATEST.
   *
   * Rejected cases:
   *   - `PROMOTE_TARGET_NOT_FOUND` — releaseId doesn't exist
   *   - `PROMOTE_PROJECT_MISMATCH` — releaseId belongs to a different project
   *   - `PROMOTE_RELEASE_NOT_READY` — release status isn't promotable
   *   - `PROMOTE_NO_OP` — releaseId IS already the project's current live
   *   - `PROMOTE_WARNING_REQUIRES_ACK` — at least one blocking warning unacked
   *
   * Capability: unified-deploy (v1.58+, release-promote).
   */
  async promote(
    project: string,
    releaseId: string,
    opts: PromoteOptions = {},
  ): Promise<PromoteResult> {
    if (!project || typeof project !== "string") {
      throw new Run402DeployError(`Invalid project id: "${String(project)}"`, {
        code: "BAD_REQUEST",
        retryable: false,
        context: "promoting release",
      });
    }
    if (!releaseId || !releaseId.startsWith("rel_")) {
      throw new Run402DeployError(`Invalid release id: "${releaseId}"`, {
        code: "BAD_REQUEST",
        retryable: false,
        context: "promoting release",
      });
    }
    // Note: `allowWarnings: true` is implemented client-side by enumerating
    // every known blocking warning code, since the gateway expects a precise
    // list per warning code (no wildcard accept). v1.58 has exactly one
    // blocking promote warning (MIGRATIONS_NOT_REVERSIBLE); if more land,
    // expand this list.
    const ALL_BLOCKING_PROMOTE_WARNINGS = ["MIGRATIONS_NOT_REVERSIBLE"];
    const allowCodes =
      opts.allowWarnings === true
        ? ALL_BLOCKING_PROMOTE_WARNINGS
        : (opts.allowWarningCodes ?? []);
    try {
      return await this.client.request<PromoteResult>(
        `/apply/v1/releases/${encodeURIComponent(releaseId)}/promote`,
        {
          method: "POST",
          context: "promoting release",
          headers: { "content-type": "application/json" },
          body: {
            project,
            allow_warning_codes: allowCodes,
          },
        },
      );
    } catch (err) {
      throw translateDeployError(err, "promote", null, releaseId);
    }
  }

  /**
   * Snapshot a deploy operation. The endpoint requires `apikey` auth, so
   * pass the project that owns the operation. (When omitted, the request
   * is sent without an apikey header and the gateway will return 401.)
   */
  async status(
    operationId: string,
    opts: { project?: string } = {},
  ): Promise<OperationSnapshot> {
    if (!operationId || !operationId.startsWith("op_")) {
      throw new Run402DeployError(`Invalid operation id: "${operationId}"`, {
        code: "OPERATION_NOT_FOUND",
        retryable: false,
        context: "fetching deploy operation",
      });
    }
    const headers = opts.project ? await apikeyHeaders(this.client, opts.project) : {};
    try {
      return await this.client.request<OperationSnapshot>(
        `/apply/v1/operations/${encodeURIComponent(operationId)}`,
        { headers, context: "fetching deploy operation" },
      );
    } catch (err) {
      throw translateDeployError(err, "status", null, operationId);
    }
  }

  /**
   * List recent deploy operations for a project. The endpoint requires
   * `apikey` auth, so a project id is required — accepted as a bare string
   * (matches `r.functions.list(projectId)` and friends) or as `{ project,
   * limit?, cursor? }`. `limit` and `cursor` are forwarded to the gateway
   * as query strings when set; the gateway picks a default page otherwise.
   */
  async list(
    opts: string | DeployListOptions,
  ): Promise<DeployListResponse> {
    const project = typeof opts === "string" ? opts : opts?.project;
    const limit = typeof opts === "string" ? undefined : opts?.limit;
    const cursor = typeof opts === "string" ? undefined : opts?.cursor;
    if (!project) {
      throw new LocalError(
        "apply.list requires a project id (as a string or { project: 'prj_...' })",
        "listing deploy operations",
      );
    }
    const normalizedLimit = normalizePositiveSafeIntegerQueryOption(
      limit,
      "apply.list limit",
      "listing deploy operations",
    );
    const headers = await apikeyHeaders(this.client, project);
    const qs = new URLSearchParams();
    if (normalizedLimit !== undefined) qs.set("limit", String(normalizedLimit));
    if (cursor !== undefined) qs.set("cursor", cursor);
    const path =
      qs.toString().length > 0
        ? `/apply/v1/operations?${qs.toString()}`
        : `/apply/v1/operations`;
    return this.client.request<DeployListResponse>(path, {
      headers,
      context: "listing deploy operations",
    });
  }

  /**
   * Fetch the synthesized phase event stream for an operation. Returns the
   * events the gateway has recorded so far — useful for inspecting a deploy
   * after the fact, or resuming an event subscription from a different
   * process. For live subscription during an in-flight deploy, use
   * {@link Deploy.start} and iterate `op.events()`.
   *
   * The endpoint requires `apikey` auth, so `project` is required.
   */
  async events(
    operationId: string,
    opts: { project: string },
  ): Promise<DeployEventsResponse> {
    if (!operationId || !operationId.startsWith("op_")) {
      throw new Run402DeployError(`Invalid operation id: "${operationId}"`, {
        code: "OPERATION_NOT_FOUND",
        retryable: false,
        context: "fetching deploy events",
      });
    }
    const headers = await apikeyHeaders(this.client, opts.project);
    try {
      return await this.client.request<DeployEventsResponse>(
        `/apply/v1/operations/${encodeURIComponent(operationId)}/events`,
        { headers, context: "fetching deploy events" },
      );
    } catch (err) {
      throw translateDeployError(err, "events", null, operationId);
    }
  }

  /**
   * Fetch a release inventory by id. The endpoint requires `apikey` auth, so
   * pass the owning project id. `siteLimit` controls how many site paths the
   * gateway includes before reporting `site.totals.paths`.
   */
  async getRelease(opts: ReleaseInventoryByIdOptions): Promise<ReleaseInventory> {
    if (!opts?.project) {
      throw new LocalError(
        "apply.getRelease requires a project id ({ project: 'prj_...', releaseId: 'rel_...' })",
        "fetching release inventory",
      );
    }
    if (!opts.releaseId) {
      throw new LocalError(
        "apply.getRelease requires a release id",
        "fetching release inventory",
      );
    }
    const siteLimit = normalizePositiveSafeIntegerQueryOption(
      opts.siteLimit,
      "apply.getRelease siteLimit",
      "fetching release inventory",
    );
    const headers = await apikeyHeaders(this.client, opts.project);
    return this.client.request<ReleaseInventory>(
      appendQuery(`/apply/v1/releases/${encodeURIComponent(opts.releaseId)}`, {
        site_limit: siteLimit,
      }),
      { headers, context: "fetching release inventory" },
    );
  }

  /**
   * Fetch the currently active release inventory for a project. If the project
   * has not activated a release yet, the gateway returns an empty current-live
   * inventory with `release_id: null`.
   */
  async getActiveRelease(
    opts: ReleaseInventoryOptions,
  ): Promise<ActiveReleaseInventory> {
    if (!opts?.project) {
      throw new LocalError(
        "apply.getActiveRelease requires a project id ({ project: 'prj_...' })",
        "fetching active release inventory",
      );
    }
    const siteLimit = normalizePositiveSafeIntegerQueryOption(
      opts.siteLimit,
      "apply.getActiveRelease siteLimit",
      "fetching active release inventory",
    );
    const headers = await apikeyHeaders(this.client, opts.project);
    return this.client.request<ActiveReleaseInventory>(
      appendQuery("/apply/v1/releases/active", {
        site_limit: siteLimit,
      }),
      { headers, context: "fetching active release inventory" },
    );
  }

  /**
   * Diff two materialized release targets for a project. `from` may be
   * `"empty"`, `"active"`, or a release id. `to` may be `"active"` or a
   * release id; the gateway treats `"active"` as the current-live target.
   */
  async diff(opts: ReleaseDiffOptions): Promise<ReleaseToReleaseDiff> {
    if (!opts?.project) {
      throw new LocalError(
        "apply.diff requires a project id ({ project: 'prj_...', from, to })",
        "diffing releases",
      );
    }
    const from = requireNonEmptyStringQueryOption(
      opts.from,
      "apply.diff from",
      "diffing releases",
    );
    const to = requireNonEmptyStringQueryOption(
      opts.to,
      "apply.diff to",
      "diffing releases",
    );
    const limit = normalizePositiveSafeIntegerQueryOption(
      opts.limit,
      "apply.diff limit",
      "diffing releases",
    );
    const headers = await apikeyHeaders(this.client, opts.project);
    const qs = new URLSearchParams({ from, to });
    if (limit !== undefined) qs.set("limit", String(limit));
    return this.client.request<ReleaseToReleaseDiff>(
      `/apply/v1/releases/diff?${qs.toString()}`,
      { headers, context: "diffing releases" },
    );
  }

  /**
   * Diagnose how a stable public URL or host/path would resolve against the
   * current live release. This is an authenticated read: `project` is used
   * only for local apikey lookup and is not sent to the gateway.
   */
  async resolve(opts: DeployResolveOptions): Promise<DeployResolveResponse> {
    const request = normalizeDeployResolveRequest(opts);
    const headers = await apikeyHeaders(this.client, request.project);
    const qs = new URLSearchParams({ host: request.host });
    if ("url" in opts || opts.path !== undefined) qs.set("path", request.path);
    if (request.method) qs.set("method", request.method);
    return this.client.request<DeployResolveResponse>(
      `/apply/v1/resolve?${qs.toString()}`,
      { headers, context: "resolving deploy public URL" },
    );
  }
}

function appendQuery(
  path: string,
  params: Record<string, string | number | undefined>,
): string {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) qs.set(key, String(value));
  }
  const query = qs.toString();
  return query.length > 0 ? `${path}?${query}` : path;
}

function normalizePositiveSafeIntegerQueryOption(
  value: number | undefined,
  label: string,
  context: string,
): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new LocalError(`${label} must be a positive safe integer`, context);
  }
  return value;
}

function requireNonEmptyStringQueryOption(
  value: unknown,
  label: string,
  context: string,
): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new LocalError(`${label} must be a non-empty string`, context);
  }
  return value;
}

// ─── Internal pipeline ───────────────────────────────────────────────────────

/**
 * Compute the sorted set of slice kinds the spec carried. Surfaces on
 * `commit.phase` and `ready` events so agents can group per-phase
 * telemetry by slice category. `assets` slice → `"asset"`; any of
 * `database` / `functions` / `site` → `"release"`. Order is stable
 * (release before asset).
 */
function deriveSliceKinds(spec: ReleaseSpec): ("release" | "asset")[] {
  // Guard against non-object spec — the validate phase throws below
  // (INVALID_SPEC), but this is called before validation in applyOnce so
  // we must not blow up first.
  if (!spec || typeof spec !== "object") return [];
  const set = new Set<"release" | "asset">();
  if (spec.database || spec.functions || spec.site) set.add("release");
  if (spec.assets) set.add("asset");
  return [...set].sort((a, b) => (a === "release" ? -1 : 1));
}

async function applyOnce(
  client: Client,
  spec: ReleaseSpec,
  opts: ApplyOptions,
  emit: (event: DeployEvent) => void,
): Promise<DeployResult> {
  const allowWarningCodes = normalizeAllowWarningCodes(opts.allowWarningCodes);
  const target: DeployTarget = opts.target === "core" ? "core" : "cloud";
  const sliceKinds = deriveSliceKinds(spec);
  emit({ type: "plan.started" });
  const { plan, byteReaders } = await planInternal(client, spec, opts.idempotencyKey, {
    target,
    requiredPlan: opts.requiredPlan,
  });
  emit({ type: "plan.diff", diff: plan.diff });
  emitPlanWarnings(plan, emit);
  if (!opts.requiredPlan) abortOnConfirmationWarnings(plan, opts, allowWarningCodes);

  if (plan.payment_required) {
    emit({
      type: "payment.required",
      amount: plan.payment_required.amount,
      asset: plan.payment_required.asset,
      payTo: plan.payment_required.payTo,
      reason: plan.payment_required.reason,
    });
    // The kernel's x402-wrapped fetch (Node) handles 402 transparently
    // when the commit happens; we don't block here. Agents using a
    // sandbox provider without payment auto-handling can intercept the
    // event and resolve before we hit upload.
  }

  if (target === "core") {
    await uploadCoreContent(client, spec.project, byteReaders, emit);

    emit({
      type: "commit.phase",
      phase: "validate",
      status: "started",
      ...(sliceKinds.length > 0 ? { slice_kinds: sliceKinds } : {}),
    });
    const planId = requirePlanId(plan, "applying deploy to Core");
    const commit = await commitInternal(client, planId, opts.idempotencyKey, spec.project, opts.requiredPlan);
    if (!isCoreCommitResponse(commit)) {
      return await pollUntilReady(client, commit, plan.diff, plan.warnings, emit, spec.project, sliceKinds);
    }
    return await coreDeployResult(client, commit, plan.diff, plan.warnings, emit, spec.project, sliceKinds);
  }

  await uploadMissing(client, spec.project, plan.missing_content, byteReaders, emit);

  emit({
    type: "commit.phase",
    phase: "validate",
    status: "started",
    ...(sliceKinds.length > 0 ? { slice_kinds: sliceKinds } : {}),
  });
  const { planId } = requirePersistedPlan(plan, "applying deploy");
  const commit = requireCloudCommitResponse(
    await commitInternal(client, planId, opts.idempotencyKey, spec.project, opts.requiredPlan),
    "applying deploy",
  );
  const result = await pollUntilReady(client, commit, plan.diff, plan.warnings, emit, spec.project, sliceKinds);

  // v1.48 unified-apply: thread the plan response's `asset_entries[]` back
  // into DeployResult.assets so callers reading `result.assets.byKey[key]`
  // get the gateway-authoritative `AssetRef` envelope (URLs, SRI, etag).
  // Release-only applies leave `result.assets` undefined.
  if (plan.asset_entries && plan.asset_entries.length > 0) {
    result.assets = buildAssetManifestFromPlanEntries(plan.asset_entries);

    // v1.49 image-variant follow-up: variants are generated AT COMMIT TIME
    // (parent gateway change Section 5 — `prepareStagedAssetVariants` runs
    // before the activation txn opens). The plan that funded `result.assets`
    // was built BEFORE commit, so its `asset_entries[].asset_ref` doesn't
    // include the variant fields (the gateway only threads `image_data`
    // through `buildAssetRefForPlan` for SHAs that ALREADY have variants
    // in `internal.blob_image_variants`).
    //
    // For image puts, do a dry-run re-plan with the same spec. Bytes are
    // now in CAS (the commit just landed) AND variant rows exist in the
    // DB. The new plan response surfaces the variants. Dry-run keeps it
    // cheap: no new plan_id or operation_id rows are created.
    //
    // Best-effort: a re-plan failure shouldn't fail the apply. The bytes
    // are committed, the release is live, and the variant fields are
    // strictly additive — leaving them empty when the recheck errors is
    // worse than failing the apply.
    const hasImagePut = spec.assets?.put?.some((entry) => {
      const ct = ("content_type" in entry && typeof entry.content_type === "string")
        ? entry.content_type
        : "";
      return ct.startsWith("image/");
    });
    if (hasImagePut) {
      try {
        const { plan: recheck } = await planInternal(client, spec, undefined, { dryRun: true });
        if (recheck.asset_entries && recheck.asset_entries.length > 0) {
          for (const recheckEntry of recheck.asset_entries) {
            const existing = result.assets.byKey[recheckEntry.key];
            if (!existing) continue;
            const ref = recheckEntry.asset_ref;
            // v1.49 — variants + intrinsics surfaced now that the encoder ran.
            if (ref.width_px !== undefined) existing.width_px = ref.width_px;
            if (ref.height_px !== undefined) existing.height_px = ref.height_px;
            if (ref.blurhash !== undefined) existing.blurhash = ref.blurhash;
            if (ref.variant_spec_version !== undefined) {
              existing.variant_spec_version = ref.variant_spec_version;
            }
            if (ref.display_url !== undefined) existing.display_url = ref.display_url;
            if (ref.display_immutable_url !== undefined) {
              existing.display_immutable_url = ref.display_immutable_url;
            }
            if (ref.variants !== undefined) existing.variants = ref.variants;
            // v1.50 — image-intrinsic + caller-metadata columns surfaced by
            // the gateway plan-path enrichment (kychee-com/run402-private #415).
            // The first plan ran BEFORE the encoder; the re-plan picks them up.
            // Without this merge, the SDK's buildAssetRef widens them back
            // to null in the final result.
            if (ref.image_format !== undefined) existing.image_format = ref.image_format;
            if (ref.image_info !== undefined) existing.image_info = ref.image_info;
            if (ref.image_exif !== undefined) existing.image_exif = ref.image_exif;
            if (ref.image_exif_policy !== undefined) {
              existing.image_exif_policy = ref.image_exif_policy;
            }
            if (ref.metadata !== undefined) existing.metadata = ref.metadata;
            // v1.54 — shape-contract fields. `<Run402Image>` placeholder
            // rendering + strict-mode schema filtering both key on these.
            if (ref.blurhash_data_url !== undefined) {
              existing.blurhash_data_url = ref.blurhash_data_url;
            }
            if (ref.asset_schema !== undefined) existing.asset_schema = ref.asset_schema;
          }
        }
      } catch {
        // Best-effort: leave variant fields unpopulated rather than
        // failing a successful apply. Consumers can re-call
        // `r.assets.put` with the same bytes (dedup) to trigger the
        // plan-time surfacing if variants are missing.
      }
    }
  }

  return result;
}

function normalizeApplyMaxRetries(value: number | undefined): number {
  if (value === undefined) return APPLY_RETRY_DEFAULT_MAX_RETRIES;
  if (!Number.isInteger(value) || value < 0 || !Number.isFinite(value)) {
    throw new Run402DeployError("ApplyOptions.maxRetries must be a non-negative integer", {
      code: "INVALID_SPEC",
      phase: "validate",
      resource: "maxRetries",
      retryable: false,
      context: "validating deploy retry options",
    });
  }
  return value;
}

function isSafeDeployApplyRetry(err: Run402DeployError, spec: ReleaseSpec): boolean {
  return (
    err.safeToRetry === true &&
    APPLY_SAFE_RETRY_CODES.has(err.code) &&
    isAutoRebasableSpec(spec)
  );
}

function isAutoRebasableSpec(spec: ReleaseSpec): boolean {
  if (spec.base === undefined) return true;
  return "release" in spec.base && spec.base.release === "current";
}

function deployApplyRetryDelayMs(attempt: number): number {
  const exponential = APPLY_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
  const capped = Math.min(exponential, APPLY_RETRY_MAX_DELAY_MS);
  return capped + Math.floor(Math.random() * (APPLY_RETRY_JITTER_MS + 1));
}

function withDeployRetryMetadata(
  err: Run402DeployError,
  attempts: number,
  maxRetries: number,
  lastRetryCode: Run402DeployErrorCode,
): Run402DeployError {
  return new Run402DeployError(err.message, {
    code: err.code,
    phase: err.phase,
    resource: err.resource,
    retryable: err.retryable,
    operationId: err.operationId,
    planId: err.planId,
    fix: err.fix,
    logs: err.logs,
    rolledBack: err.rolledBack,
    attempts,
    maxRetries,
    lastRetryCode,
    status: err.status,
    body: enrichDeployRetryBody(err.body, attempts, maxRetries, lastRetryCode),
    context: err.context,
  });
}

function enrichDeployRetryBody(
  body: unknown,
  attempts: number,
  maxRetries: number,
  lastRetryCode: Run402DeployErrorCode,
): unknown {
  const retryFields = {
    attempts,
    max_retries: maxRetries,
    last_retry_code: lastRetryCode,
  };
  if (body && typeof body === "object" && !Array.isArray(body)) {
    return { ...(body as Record<string, unknown>), ...retryFields };
  }
  return retryFields;
}

function contentRefToWire(ref: ContentRef): Record<string, unknown> {
  const maybeWire = ref as ContentRef & { content_type?: string };
  return {
    sha256: ref.sha256,
    size: ref.size,
    ...(ref.contentType ?? maybeWire.content_type
      ? { content_type: ref.contentType ?? maybeWire.content_type }
      : {}),
    ...(ref.integrity ? { integrity: ref.integrity } : {}),
  };
}

function contentRefToCoreSpec(ref: ContentRef): Record<string, unknown> {
  const maybeWire = ref as ContentRef & { content_type?: string };
  const contentType = ref.contentType ?? maybeWire.content_type;
  return {
    sha256: ref.sha256,
    size: ref.size,
    ...(contentType ? { contentType } : {}),
    ...(ref.integrity ? { integrity: ref.integrity } : {}),
  };
}

function requireContentRef(ref: ContentRef | undefined, resource: string): ContentRef {
  if (ref) return ref;
  throw new Run402DeployError(`Missing content ref for ${resource}`, {
    code: "INTERNAL_ERROR",
    phase: "validate",
    resource,
    retryable: false,
    context: "serializing deploy spec",
  });
}

function fileSetToWire(map: Record<string, ContentRef>): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const [path, ref] of Object.entries(map)) out[path] = contentRefToWire(ref);
  return out;
}

function fileSetToCoreSpec(map: Record<string, ContentRef>): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const [path, ref] of Object.entries(map)) out[path] = contentRefToCoreSpec(ref);
  return out;
}

function requireRoleToWire(gate: NonNullable<NormalizedFunctionSpec["requireRole"]>): Record<string, unknown> {
  return {
    table: gate.table,
    id_column: gate.idColumn,
    role_column: gate.roleColumn,
    allowed: gate.allowed,
    ...(gate.cacheTtl !== undefined ? { cache_ttl: gate.cacheTtl } : {}),
    ...(gate.onDeny !== undefined ? { on_deny: gate.onDeny } : {}),
    ...(gate.signInPath !== undefined ? { sign_in_path: gate.signInPath } : {}),
  };
}

function functionToCoreSpec(fn: NormalizedFunctionSpec): Record<string, unknown> {
  return {
    ...(fn.runtime !== undefined ? { runtime: fn.runtime } : {}),
    ...(fn.source !== undefined ? { source: contentRefToCoreSpec(fn.source) } : {}),
    ...(fn.files !== undefined ? { files: fileSetToCoreSpec(fn.files) } : {}),
    ...(fn.entrypoint !== undefined ? { entrypoint: fn.entrypoint } : {}),
    ...(fn.config !== undefined ? { config: fn.config } : {}),
    ...(fn.deps !== undefined ? { deps: fn.deps } : {}),
    ...(fn.schedule !== undefined ? { schedule: fn.schedule } : {}),
    ...(fn.requireAuth !== undefined ? { requireAuth: fn.requireAuth } : {}),
    ...(fn.requireRole !== undefined ? { requireRole: fn.requireRole } : {}),
    ...(fn.class !== undefined ? { class: fn.class } : {}),
    ...(fn.capabilities !== undefined ? { capabilities: fn.capabilities } : {}),
  };
}

function functionToWire(fn: NormalizedFunctionSpec): Record<string, unknown> {
  return {
    ...(fn.runtime !== undefined ? { runtime: fn.runtime } : {}),
    ...(fn.source !== undefined ? { source: contentRefToWire(fn.source) } : {}),
    ...(fn.files !== undefined ? { files: fileSetToWire(fn.files) } : {}),
    ...(fn.entrypoint !== undefined ? { entrypoint: fn.entrypoint } : {}),
    ...(fn.config !== undefined
      ? {
          config: {
            ...(fn.config.timeoutSeconds !== undefined ? { timeout_seconds: fn.config.timeoutSeconds } : {}),
            ...(fn.config.memoryMb !== undefined ? { memory_mb: fn.config.memoryMb } : {}),
          },
        }
      : {}),
    ...(fn.deps !== undefined ? { deps: fn.deps } : {}),
    ...(fn.schedule !== undefined ? { schedule: fn.schedule } : {}),
    ...(fn.requireAuth !== undefined ? { require_auth: fn.requireAuth } : {}),
    ...(fn.requireRole !== undefined
      ? { require_role: fn.requireRole === null ? null : requireRoleToWire(fn.requireRole) }
      : {}),
    ...(fn.class !== undefined ? { class: fn.class } : {}),
    ...(fn.capabilities !== undefined ? { capabilities: fn.capabilities } : {}),
  };
}

function functionMapToWire(map: Record<string, NormalizedFunctionSpec>): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const [name, fn] of Object.entries(map)) out[name] = functionToWire(fn);
  return out;
}

function functionMapToCoreSpec(map: Record<string, NormalizedFunctionSpec>): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const [name, fn] of Object.entries(map)) out[name] = functionToCoreSpec(fn);
  return out;
}

function functionsToCoreSpec(functions: NormalizedFunctionsSpec): Record<string, unknown> {
  return {
    ...(functions.replace !== undefined ? { replace: functionMapToCoreSpec(functions.replace) } : {}),
    ...(functions.patch !== undefined
      ? {
          patch: {
            ...(functions.patch.set !== undefined ? { set: functionMapToCoreSpec(functions.patch.set) } : {}),
            ...(functions.patch.delete !== undefined ? { delete: functions.patch.delete } : {}),
          },
        }
      : {}),
  };
}

function databaseToWire(database: NormalizedDatabaseSpec): Record<string, unknown> {
  return {
    ...(database.expose !== undefined ? { expose: database.expose } : {}),
    ...(database.zero_downtime !== undefined ? { zero_downtime: database.zero_downtime } : {}),
    ...(database.migrations !== undefined
      ? {
          migrations: database.migrations.map((m) => ({
            id: m.id,
            checksum: m.checksum,
            ...(m.sql !== undefined
              ? { sql: m.sql }
              : { sql_ref: contentRefToWire(requireContentRef(m.sql_ref, `database.migrations.${m.id}.sql_ref`)) }),
            ...(m.transaction !== undefined ? { transaction: m.transaction } : {}),
          })),
        }
      : {}),
  };
}

function databaseToCoreSpec(database: NormalizedDatabaseSpec): Record<string, unknown> {
  return {
    ...(database.expose !== undefined ? { expose: database.expose } : {}),
    ...(database.zero_downtime !== undefined ? { zero_downtime: database.zero_downtime } : {}),
    ...(database.migrations !== undefined
      ? {
          migrations: database.migrations.map((m) => ({
            id: m.id,
            checksum: m.checksum,
            ...(m.sql !== undefined
              ? { sql: m.sql }
              : { sql_ref: contentRefToCoreSpec(requireContentRef(m.sql_ref, `database.migrations.${m.id}.sql_ref`)) }),
            ...(m.transaction !== undefined ? { transaction: m.transaction } : {}),
          })),
        }
      : {}),
  };
}

function functionsToWire(functions: NormalizedFunctionsSpec): Record<string, unknown> {
  return {
    ...(functions.replace !== undefined ? { replace: functionMapToWire(functions.replace) } : {}),
    ...(functions.patch !== undefined
      ? {
          patch: {
            ...(functions.patch.set !== undefined ? { set: functionMapToWire(functions.patch.set) } : {}),
            ...(functions.patch.delete !== undefined ? { delete: functions.patch.delete } : {}),
          },
        }
      : {}),
  };
}

function siteToCoreSpec(site: NormalizedSiteSpec): Record<string, unknown> {
  if ("replace" in site && site.replace) {
    return {
      replace: fileSetToCoreSpec(site.replace),
      ...(site.public_paths ? { public_paths: site.public_paths } : {}),
    };
  }
  if ("patch" in site && site.patch) {
    return {
      patch: {
        ...(site.patch.put ? { put: fileSetToCoreSpec(site.patch.put) } : {}),
        ...(site.patch.delete ? { delete: site.patch.delete } : {}),
      },
      ...(site.public_paths ? { public_paths: site.public_paths } : {}),
    };
  }
  return { public_paths: site.public_paths };
}

function siteToWire(site: NormalizedSiteSpec): Record<string, unknown> {
  if ("replace" in site && site.replace) {
    return {
      replace: fileSetToWire(site.replace),
      ...(site.public_paths ? { public_paths: site.public_paths } : {}),
    };
  }
  if ("patch" in site && site.patch) {
    return {
      patch: {
        ...(site.patch.put ? { put: fileSetToWire(site.patch.put) } : {}),
        ...(site.patch.delete ? { delete: site.patch.delete } : {}),
      },
      ...(site.public_paths ? { public_paths: site.public_paths } : {}),
    };
  }
  return { public_paths: site.public_paths };
}

function i18nToWire(i18n: NonNullable<NormalizedReleaseSpec["i18n"]>): Record<string, unknown> {
  return {
    default_locale: i18n.defaultLocale,
    locales: i18n.locales,
    ...(i18n.detect !== undefined ? { detect: i18n.detect } : {}),
    ...(i18n.unknownLocalePolicy !== undefined ? { unknown_locale_policy: i18n.unknownLocalePolicy } : {}),
  };
}

function releaseSpecToCoreSpec(spec: NormalizedReleaseSpec): Record<string, unknown> {
  return {
    project: spec.project,
    ...(spec.base !== undefined ? { base: spec.base } : {}),
    ...(spec.database !== undefined ? { database: databaseToCoreSpec(spec.database) } : {}),
    ...(spec.secrets !== undefined ? { secrets: spec.secrets } : {}),
    ...(spec.functions !== undefined ? { functions: functionsToCoreSpec(spec.functions) } : {}),
    ...(spec.site !== undefined ? { site: siteToCoreSpec(spec.site) } : {}),
    ...(spec.subdomains !== undefined ? { subdomains: spec.subdomains } : {}),
    ...(spec.routes !== undefined ? { routes: spec.routes } : {}),
    ...(spec.checks !== undefined ? { checks: spec.checks } : {}),
    ...(spec.assets !== undefined ? { assets: spec.assets } : {}),
    ...(spec.i18n !== undefined ? { i18n: spec.i18n } : {}),
  };
}

function releaseSpecToWire(spec: NormalizedReleaseSpec): Record<string, unknown> {
  return {
    project_id: spec.project,
    ...(spec.base !== undefined ? { base: spec.base } : {}),
    ...(spec.database !== undefined ? { database: databaseToWire(spec.database) } : {}),
    ...(spec.secrets !== undefined ? { secrets: spec.secrets } : {}),
    ...(spec.functions !== undefined ? { functions: functionsToWire(spec.functions) } : {}),
    ...(spec.site !== undefined ? { site: siteToWire(spec.site) } : {}),
    ...(spec.subdomains !== undefined ? { subdomains: spec.subdomains } : {}),
    ...(spec.routes !== undefined ? { routes: spec.routes } : {}),
    ...(spec.checks !== undefined ? { checks: spec.checks } : {}),
    ...(spec.assets !== undefined ? { assets: spec.assets } : {}),
    ...(spec.i18n !== undefined ? { i18n: spec.i18n === null ? null : i18nToWire(spec.i18n) } : {}),
  };
}

async function planInternal(
  client: Client,
  spec: ReleaseSpec,
  idempotencyKey?: string,
  opts: {
    dryRun?: boolean;
    reviewedPlan?: boolean;
    requiredPlan?: { planId: string; planFingerprint?: string };
    target?: DeployTarget;
  } = {},
): Promise<{ plan: PlanResponse; byteReaders: Map<string, ByteReader> }> {
  const dryRun = opts.dryRun === true;
  const reviewedPlan = opts.reviewedPlan === true;
  const target = opts.target ?? "cloud";
  const ciCredentials = isCiClient(client);
  validateSpec(spec);
  if (ciCredentials) assertCiDeployableSpec(spec);

  const isCore = target === "core";
  const { normalized, byteReaders } = await normalizeReleaseSpec(client, spec, {
    inlineMigrationSql: isCore,
  });
  if (!isCore) await preflightTierFunctionLimits(client, normalized, ciCredentials);
  const wireSpec = isCore ? releaseSpecToCoreSpec(normalized) : releaseSpecToWire(normalized);

  // The gateway expects { spec, manifest_ref?, idempotency_key? }. Cloud
  // receives the legacy snake_case apply wire shape; Core receives the
  // open ReleaseSpec shape from @run402/release. For oversized Cloud specs
  // the SDK uploads the manifest JSON to CAS first and references it; the
  // gateway still needs `spec` in the body (with at least the project), so
  // we keep a minimal stub there.
  const inlineBody: PlanRequest = { spec: wireSpec };
  if (idempotencyKey && !dryRun && !reviewedPlan) inlineBody.idempotency_key = idempotencyKey;
  if (reviewedPlan) inlineBody.mode = "reviewed_plan";
  if (opts.requiredPlan) inlineBody.required_plan = requiredPlanToWire(opts.requiredPlan);
  const inlineBytes = new TextEncoder().encode(JSON.stringify(inlineBody)).byteLength;

  let body: PlanRequest;
  if (inlineBytes <= PLAN_BODY_LIMIT_BYTES) {
    body = inlineBody;
  } else if (isCore) {
    throw new Run402DeployError(
      "Core deploy planning requires an inline spec under the gateway body cap; manifest_ref is not supported by Run402 Core yet.",
      {
        code: "DRY_RUN_REQUIRES_INLINE_SPEC",
        phase: "validate",
        resource: "manifest_ref",
        retryable: false,
        context: "planning Core deploy",
      },
    );
  } else {
    if (dryRun || reviewedPlan || opts.requiredPlan) {
      throw new Run402DeployError(
        "Check/plan/require-plan deploy planning requires an inline spec under the gateway body cap; the normalized deploy plan would require manifest_ref.",
        {
          code: "PLAN_REQUIRES_INLINE_SPEC",
          phase: "validate",
          resource: "manifest_ref",
          retryable: false,
          context: "planning deploy",
        },
      );
    }
    if (ciCredentials) {
      throw new Run402DeployError(
        "CI deploys must use inline specs under the gateway body cap; the normalized deploy plan would require manifest_ref.",
        {
          code: "forbidden_spec_field",
          phase: "validate",
          resource: "manifest_ref",
          retryable: false,
          context: "validating CI deploy spec",
        },
      );
    }
    // Upload the normalized manifest itself as a CAS object so the gateway
    // can pick it up via `manifest_ref`. The body still carries a minimal
    // `spec` so the gateway has the project for auth + plan persistence.
    const manifestBytes = new TextEncoder().encode(JSON.stringify(wireSpec));
    const ref = await uploadInlineCas(
      client,
      spec.project,
      manifestBytes,
      MANIFEST_CONTENT_TYPE,
    );
    body = { spec: { project_id: spec.project }, manifest_ref: contentRefToWire(ref) };
    if (idempotencyKey) body.idempotency_key = idempotencyKey;
  }

  let plan: PlanResponse;
  try {
    plan = withClientPlanWarnings(normalized, normalizePlanResponse(await client.request<PlanResponse>(dryRun ? "/apply/v1/plans?dry_run=true" : "/apply/v1/plans", {
      method: "POST",
      body,
      // Operator-approval scope: deploying a release is `project.deploy` on this project.
      authMeta: { method: "deploy.plan", capability: "project.deploy", target: { project_id: spec.project } },
      context: "planning deploy",
    })));
  } catch (err) {
    throw translateDeployError(err, "plan", null, null);
  }
  return { plan, byteReaders };
}

function requiredPlanToWire(plan: { planId: string; planFingerprint?: string }): NonNullable<PlanRequest["required_plan"]> {
  const wire: NonNullable<PlanRequest["required_plan"]> = { plan_id: plan.planId };
  if (plan.planFingerprint !== undefined) wire.plan_fingerprint = plan.planFingerprint;
  return wire;
}

type TierLimitSource = "tier_status" | "local_static_fallback";

interface StaticTierFunctionLimits {
  maxTimeoutSeconds: number;
  maxMemoryMb: number;
  maxScheduledFunctions: number;
  minCronIntervalMinutes: number;
}

interface TierLimitNumber {
  value: number;
  source: TierLimitSource;
}

interface TierFunctionLimitSnapshot {
  tier: string;
  maxTimeoutSeconds?: TierLimitNumber;
  maxMemoryMb?: TierLimitNumber;
  maxScheduledFunctions?: TierLimitNumber;
  minCronIntervalMinutes?: TierLimitNumber;
  currentScheduledFunctions?: TierLimitNumber;
}

interface FunctionTierPreflightEntry {
  name: string;
  fn: NormalizedFunctionSpec;
  fieldPrefix: string;
}

async function preflightTierFunctionLimits(
  client: Client,
  spec: NormalizedReleaseSpec,
  ciCredentials: boolean,
): Promise<void> {
  if (ciCredentials) return;
  if (!hasFunctionTierPreflightInputs(spec.functions)) return;

  const limits = await readTierFunctionLimits(client);
  if (!limits) return;

  const entries = collectFunctionPreflightEntries(spec.functions);
  for (const entry of entries) {
    const timeout = entry.fn.config?.timeoutSeconds;
    if (
      timeout !== undefined &&
      limits.maxTimeoutSeconds &&
      timeout > limits.maxTimeoutSeconds.value
    ) {
      throw tierLimitError(
        `Function ${entry.name} timeoutSeconds ${timeout} exceeds the ${limits.tier} tier maximum of ${limits.maxTimeoutSeconds.value}.`,
        `${entry.fieldPrefix}.config.timeoutSeconds`,
        timeout,
        limits,
        limits.maxTimeoutSeconds,
        {
          tier_max: limits.maxTimeoutSeconds.value,
          max_function_timeout_seconds: limits.maxTimeoutSeconds.value,
        },
      );
    }

    const memory = entry.fn.config?.memoryMb;
    if (
      memory !== undefined &&
      limits.maxMemoryMb &&
      memory > limits.maxMemoryMb.value
    ) {
      throw tierLimitError(
        `Function ${entry.name} memoryMb ${memory} exceeds the ${limits.tier} tier maximum of ${limits.maxMemoryMb.value}.`,
        `${entry.fieldPrefix}.config.memoryMb`,
        memory,
        limits,
        limits.maxMemoryMb,
        {
          tier_max: limits.maxMemoryMb.value,
          max_function_memory_mb: limits.maxMemoryMb.value,
        },
      );
    }

    if (isScheduledCron(entry.fn.schedule) && limits.minCronIntervalMinutes) {
      const intervalMinutes = estimateCronMinimumIntervalMinutes(entry.fn.schedule);
      if (
        intervalMinutes !== null &&
        intervalMinutes < limits.minCronIntervalMinutes.value
      ) {
        throw tierLimitError(
          `Function ${entry.name} schedule runs every ${intervalMinutes} minute(s), below the ${limits.tier} tier minimum interval of ${limits.minCronIntervalMinutes.value} minutes.`,
          `${entry.fieldPrefix}.schedule`,
          entry.fn.schedule,
          limits,
          limits.minCronIntervalMinutes,
          {
            interval_minutes: intervalMinutes,
            min_interval_minutes: limits.minCronIntervalMinutes.value,
            min_cron_interval_minutes: limits.minCronIntervalMinutes.value,
          },
        );
      }
    }
  }

  if (limits.maxScheduledFunctions) {
    const lowerBound = countScheduledFunctionsInSetEntries(spec.functions);
    if (lowerBound > limits.maxScheduledFunctions.value) {
      throw scheduledCountTierLimitError(lowerBound, limits, limits.maxScheduledFunctions, "manifest");
    }

    const desired = await computeDesiredScheduledFunctionCount(client, spec);
    if (desired && desired.count > limits.maxScheduledFunctions.value) {
      throw scheduledCountTierLimitError(
        desired.count,
        limits,
        limits.maxScheduledFunctions,
        desired.source,
      );
    }
  }
}

function hasFunctionTierPreflightInputs(functions: NormalizedFunctionsSpec | undefined): boolean {
  if (!functions) return false;
  return collectFunctionPreflightEntries(functions).some((entry) => (
    entry.fn.config?.timeoutSeconds !== undefined ||
    entry.fn.config?.memoryMb !== undefined ||
    isScheduledCron(entry.fn.schedule)
  ));
}

function collectFunctionPreflightEntries(
  functions: NormalizedFunctionsSpec | undefined,
): FunctionTierPreflightEntry[] {
  if (!functions) return [];
  const entries: FunctionTierPreflightEntry[] = [];
  for (const [name, fn] of Object.entries(functions.replace ?? {})) {
    entries.push({ name, fn, fieldPrefix: `functions.${name}` });
  }
  for (const [name, fn] of Object.entries(functions.patch?.set ?? {})) {
    entries.push({ name, fn, fieldPrefix: `functions.${name}` });
  }
  return entries;
}

async function readTierFunctionLimits(
  client: Client,
): Promise<TierFunctionLimitSnapshot | null> {
  let status: TierStatusResult;
  try {
    status = await client.request<TierStatusResult>("/tiers/v1/status", {
      context: "checking tier status for deploy preflight",
    });
  } catch {
    return null;
  }

  if (typeof status.tier !== "string" || status.tier.length === 0) {
    return null;
  }

  const tierKey = status.tier.toLowerCase();
  const fallback = STATIC_FUNCTION_LIMITS_BY_TIER[tierKey];
  const limits: TierFunctionLimitSnapshot = { tier: status.tier };

  limits.maxTimeoutSeconds = tierStatusLimitOrFallback(
    status,
    [
      "max_function_timeout_seconds",
      "max_timeout_seconds",
      "timeout_seconds_max",
      "function_timeout_seconds_max",
    ],
    fallback?.maxTimeoutSeconds,
  );
  limits.maxMemoryMb = tierStatusLimitOrFallback(
    status,
    [
      "max_function_memory_mb",
      "max_memory_mb",
      "memory_mb_max",
      "function_memory_mb_max",
    ],
    fallback?.maxMemoryMb,
  );
  limits.maxScheduledFunctions = tierStatusLimitOrFallback(
    status,
    [
      "max_scheduled_functions",
      "scheduled_functions_limit",
      "scheduled_function_limit",
      "max_function_schedules",
    ],
    fallback?.maxScheduledFunctions,
  );
  limits.minCronIntervalMinutes = tierStatusLimitOrFallback(
    status,
    [
      "min_cron_interval_minutes",
      "minimum_cron_interval_minutes",
      "min_schedule_interval_minutes",
      "min_scheduled_function_interval_minutes",
    ],
    fallback?.minCronIntervalMinutes,
  );
  limits.currentScheduledFunctions = tierStatusLimit(
    status,
    [
      "current_scheduled_functions",
      "current_scheduled_function_count",
      "scheduled_function_count",
      "scheduled_functions",
    ],
  );

  return hasAnyTierFunctionLimit(limits) ? limits : null;
}

function tierStatusLimitOrFallback(
  status: TierStatusResult,
  keys: string[],
  fallback: number | undefined,
): TierLimitNumber | undefined {
  return tierStatusLimit(status, keys) ?? (
    fallback === undefined
      ? undefined
      : { value: fallback, source: "local_static_fallback" }
  );
}

function tierStatusLimit(
  status: TierStatusResult,
  keys: string[],
): TierLimitNumber | undefined {
  const limits = objectField(status, "limits");
  const containers: unknown[] = [
    objectField(status, "function_limits"),
    objectField(limits, "functions"),
    objectField(limits, "function_limits"),
    objectField(status, "pool_usage"),
    status,
  ];

  for (const container of containers) {
    if (!container || typeof container !== "object" || Array.isArray(container)) continue;
    const obj = container as Record<string, unknown>;
    for (const key of keys) {
      const value = obj[key];
      if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
        return { value, source: "tier_status" };
      }
    }
  }
  return undefined;
}

function hasAnyTierFunctionLimit(limits: TierFunctionLimitSnapshot): boolean {
  return Boolean(
    limits.maxTimeoutSeconds ||
    limits.maxMemoryMb ||
    limits.maxScheduledFunctions ||
    limits.minCronIntervalMinutes ||
    limits.currentScheduledFunctions
  );
}

async function computeDesiredScheduledFunctionCount(
  client: Client,
  spec: NormalizedReleaseSpec,
): Promise<{ count: number; source: "manifest" | "active_release_inventory" } | null> {
  const functions = spec.functions;
  if (!functions) return null;

  const replaceScheduled = scheduledFunctionNames(functions.replace);
  if (replaceScheduled) {
    applyScheduledFunctionPatch(replaceScheduled, functions.patch);
    return { count: replaceScheduled.size, source: "manifest" };
  }

  if (!functions.patch) return null;
  const activeScheduled = await readActiveScheduledFunctionNames(client, spec.project);
  if (!activeScheduled) return null;
  applyScheduledFunctionPatch(activeScheduled, functions.patch);
  return { count: activeScheduled.size, source: "active_release_inventory" };
}

function countScheduledFunctionsInSetEntries(functions: NormalizedFunctionsSpec | undefined): number {
  if (!functions) return 0;
  const names = new Set<string>();
  for (const [name, fn] of Object.entries(functions.replace ?? {})) {
    if (isScheduledCron(fn.schedule)) names.add(name);
  }
  for (const [name, fn] of Object.entries(functions.patch?.set ?? {})) {
    if (isScheduledCron(fn.schedule)) names.add(name);
  }
  return names.size;
}

function scheduledFunctionNames(
  functions: Record<string, NormalizedFunctionSpec> | undefined,
): Set<string> | null {
  if (!functions) return null;
  const scheduled = new Set<string>();
  for (const [name, fn] of Object.entries(functions)) {
    if (isScheduledCron(fn.schedule)) scheduled.add(name);
  }
  return scheduled;
}

function applyScheduledFunctionPatch(
  scheduled: Set<string>,
  patch: NormalizedFunctionsSpec["patch"] | undefined,
): void {
  for (const name of patch?.delete ?? []) {
    scheduled.delete(name);
  }
  for (const [name, fn] of Object.entries(patch?.set ?? {})) {
    if (fn.schedule === null) scheduled.delete(name);
    else if (isScheduledCron(fn.schedule)) scheduled.add(name);
  }
}

async function readActiveScheduledFunctionNames(
  client: Client,
  projectId: string,
): Promise<Set<string> | null> {
  let inventory: ActiveReleaseInventory;
  try {
    inventory = await client.request<ActiveReleaseInventory>(
      appendQuery("/apply/v1/releases/active", { site_limit: 1 }),
      {
        headers: await apikeyHeaders(client, projectId),
        context: "fetching active release inventory for deploy preflight",
      },
    );
  } catch {
    return null;
  }

  const scheduled = new Set<string>();
  for (const fn of inventory.functions ?? []) {
    if (isScheduledCron(fn.schedule)) scheduled.add(fn.name);
  }
  return scheduled;
}

function scheduledCountTierLimitError(
  count: number,
  limits: TierFunctionLimitSnapshot,
  limit: TierLimitNumber,
  countSource: "manifest" | "active_release_inventory",
): Run402DeployError {
  return tierLimitError(
    `Deploy would have ${count} scheduled function(s), exceeding the ${limits.tier} tier maximum of ${limit.value}.`,
    "functions.scheduled_count",
    count,
    limits,
    limit,
    {
      tier_max: limit.value,
      max_scheduled_functions: limit.value,
      count_source: countSource,
    },
  );
}

function tierLimitError(
  message: string,
  field: string,
  value: unknown,
  limits: TierFunctionLimitSnapshot,
  limit: TierLimitNumber,
  extraDetails: Record<string, unknown>,
): Run402DeployError {
  const hint = limit.source === "local_static_fallback"
    ? "Tier limits came from the SDK's static fallback because /tiers/v1/status did not expose function caps. Run `run402 tier status` to refresh, lower the function setting, upgrade the tier, or retry and let gateway validation decide if this seems stale."
    : "Lower the function setting or upgrade the tier before deploying.";
  const details = {
    field,
    value,
    tier: limits.tier,
    limit_source: limit.source,
    ...extraDetails,
  };
  const body = {
    code: "BAD_FIELD",
    category: "deploy",
    message,
    retryable: false,
    details,
    hint,
  };
  return new Run402DeployError(message, {
    code: "BAD_FIELD",
    phase: "validate",
    resource: field,
    retryable: false,
    body,
    context: "validating deploy tier limits",
  });
}

function isScheduledCron(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function estimateCronMinimumIntervalMinutes(expression: string): number | null {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const minutes = expandCronNumberField(parts[0]!, 0, 59);
  const hours = expandCronNumberField(parts[1]!, 0, 23);
  if (!minutes || !hours || minutes.length === 0 || hours.length === 0) return null;

  const occurrences: number[] = [];
  for (const hour of hours) {
    for (const minute of minutes) {
      occurrences.push(hour * 60 + minute);
    }
  }
  occurrences.sort((a, b) => a - b);
  if (occurrences.length <= 1) return 24 * 60;

  let minGap = Number.POSITIVE_INFINITY;
  for (let i = 1; i < occurrences.length; i += 1) {
    minGap = Math.min(minGap, occurrences[i]! - occurrences[i - 1]!);
  }
  minGap = Math.min(
    minGap,
    24 * 60 - occurrences[occurrences.length - 1]! + occurrences[0]!,
  );
  return Number.isFinite(minGap) ? minGap : null;
}

function expandCronNumberField(field: string, min: number, max: number): number[] | null {
  const values = new Set<number>();
  for (const part of field.split(",")) {
    const expanded = expandCronNumberPart(part.trim(), min, max);
    if (!expanded) return null;
    for (const value of expanded) values.add(value);
  }
  return [...values].sort((a, b) => a - b);
}

function expandCronNumberPart(part: string, min: number, max: number): number[] | null {
  if (!part) return null;
  const [rangePart, stepPart] = part.split("/");
  if (part.split("/").length > 2) return null;
  const step = stepPart === undefined ? 1 : Number(stepPart);
  if (!Number.isSafeInteger(step) || step < 1) return null;

  let start: number;
  let end: number;
  if (rangePart === "*") {
    start = min;
    end = max;
  } else if (rangePart?.includes("-")) {
    const [rawStart, rawEnd] = rangePart.split("-");
    start = Number(rawStart);
    end = Number(rawEnd);
  } else {
    start = Number(rangePart);
    end = stepPart === undefined ? start : max;
  }

  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < min ||
    end > max ||
    start > end
  ) {
    return null;
  }

  const values: number[] = [];
  for (let value = start; value <= end; value += step) {
    values.push(value);
  }
  return values;
}

async function commitInternal(
  client: Client,
  planId: string,
  idempotencyKey?: string,
  project?: string,
  requiredPlan?: { planId: string; planFingerprint?: string },
): Promise<CommitResponse | CoreCommitResponse> {
  try {
    const body: Record<string, unknown> = {};
    if (idempotencyKey) body.idempotency_key = idempotencyKey;
    if (requiredPlan) body.required_plan = requiredPlanToWire(requiredPlan);
    return await client.request<CommitResponse>(
      `/apply/v1/plans/${encodeURIComponent(planId)}/commit`,
      {
        method: "POST",
        body,
        // Operator-approval scope: committing a deploy is `project.deploy` on this project.
        ...(project
          ? {
              authMeta: {
                method: "deploy.commit",
                capability: "project.deploy" as const,
                target: { project_id: project },
              },
            }
          : {}),
        context: "committing deploy",
      },
    );
  } catch (err) {
    throw translateDeployError(err, "commit", planId, null);
  }
}

async function uploadMissing(
  client: Client,
  projectId: string,
  presence: PlanResponse["missing_content"],
  byteReaders: Map<string, ByteReader>,
  emit: (event: DeployEvent) => void,
): Promise<void> {
  // Surface CAS dedup hits so agents can distinguish "N files were already
  // present" from "nothing happened". The gateway reports both present and
  // missing refs in `missing_content`; emit a skipped event for each present
  // one before short-circuiting on a fully-deduped plan. (#124, #134)
  const skipped = presence.filter((p) => p.present);
  for (const p of skipped) {
    const reader = byteReaders.get(p.sha256);
    emit({
      type: "content.upload.skipped",
      label: reader?.label ?? p.sha256,
      sha256: p.sha256,
      reason: "present",
      ...(reader?.slice ? { slice_kind: reader.slice } : {}),
    });
  }

  // Filter to refs the gateway reported as missing for this project.
  const needsUpload = presence.filter((p) => !p.present);
  if (needsUpload.length === 0) return;

  // Hand off to the CAS content service: hand it the list of missing
  // refs, it issues an upload session per ref with presigned PUT URLs,
  // then we PUT the bytes and commit the content plan.
  const headers = await apikeyHeaders(client, projectId);
  const ciCredentials = isCiClient(client);

  const contentRequest = needsUpload.map((p) => {
    const reader = byteReaders.get(p.sha256);
    return {
      sha256: p.sha256,
      size: p.size,
      content_type: reader?.contentType,
    };
  });

  const planRes = await client.request<ContentPlanResponse>(
    "/content/v1/plans",
    {
      method: "POST",
      headers,
      body: ciCredentials
        ? { project_id: projectId, content: contentRequest }
        : { content: contentRequest },
      context: "planning content upload",
    },
  );

  const total = planRes.missing.length;
  let done = 0;

  for (const session of planRes.missing) {
    const reader = byteReaders.get(session.sha256);
    if (!reader) {
      throw new Run402DeployError(
        `internal: no local byte reader for sha ${session.sha256.slice(0, 12)}…`,
        {
          code: "CONTENT_UPLOAD_FAILED",
          phase: "upload",
          retryable: false,
          context: "uploading deploy bytes",
        },
      );
    }
    const bytes = await reader();
    await uploadOneWithRetry(client.fetch, session, bytes);

    // v1.48 unified-apply: per-session completion via /storage/v1/uploads/:id/
    // complete was removed (the route is now 404). All sessions are CAS-style
    // staged-then-promote; the plan-level POST /content/v1/plans/:id/commit
    // call below promotes every session for the plan in one shot.

    done += 1;
    emit({
      type: "content.upload.progress",
      label: reader.label ?? session.sha256,
      sha256: session.sha256,
      done,
      total,
      ...(reader.slice ? { slice_kind: reader.slice } : {}),
    });
  }

  // Plan-level finalize — marks the plan committed in the deploy_plans
  // table. Per-session promotion to CAS already happened in the loop
  // above; this call is the plan-level idempotency anchor.
  await client.request<unknown>(
    `/content/v1/plans/${encodeURIComponent(planRes.plan_id)}/commit`,
    { method: "POST", headers, body: {}, context: "committing content upload" },
  );
}

async function uploadCoreContent(
  client: Client,
  projectId: string,
  byteReaders: Map<string, ByteReader>,
  emit: (event: DeployEvent) => void,
): Promise<void> {
  const entries = [...byteReaders.entries()].sort(([a], [b]) => a.localeCompare(b));
  const total = entries.length;
  let done = 0;
  for (const [sha256, reader] of entries) {
    const bytes = await reader();
    await client.request(
      `/projects/v1/${encodeURIComponent(projectId)}/content`,
      {
        method: "POST",
        body: {
          sha256,
          size: bytes.byteLength,
          content_type: reader.contentType ?? "application/octet-stream",
          bytes_base64: base64FromBytes(bytes),
        },
        context: "staging Core deploy content",
      },
    );
    done += 1;
    emit({
      type: "content.upload.progress",
      label: reader.label ?? sha256,
      sha256,
      done,
      total,
      ...(reader.slice ? { slice_kind: reader.slice } : {}),
    });
  }
}

// Wrap `uploadOne` with exponential backoff for retryable failures.
// `putToS3` raises Run402DeployError(retryable: true) for transient network
// drops and 5xx/403 responses; one network blip should not fail the entire
// deploy. Cap at 3 attempts (1 initial + 2 retries) with delays 1s, 2s.
// Non-retryable errors (4xx other than 403, internal SDK invariants) bubble
// up on the first attempt. See GH-140.
interface UploadedPart {
  part_number: number;
  etag: string;
}

async function uploadOneWithRetry(
  fetchFn: typeof globalThis.fetch,
  session: MissingContent,
  bytes: Uint8Array,
): Promise<UploadedPart[]> {
  const MAX_ATTEMPTS = 3;
  for (let attempt = 1; ; attempt++) {
    try {
      return await uploadOne(fetchFn, session, bytes);
    } catch (err) {
      const retryable = err instanceof Run402DeployError && err.retryable;
      if (!retryable || attempt >= MAX_ATTEMPTS) throw err;
      await sleep(1000 * Math.pow(2, attempt - 1)); // 1s, 2s
    }
  }
}

async function uploadOne(
  fetchFn: typeof globalThis.fetch,
  entry: MissingContent,
  bytes: Uint8Array,
): Promise<UploadedPart[]> {
  if (entry.mode === "single") {
    if (entry.parts.length !== 1) {
      throw new Run402DeployError(
        `internal: single-mode upload for ${entry.sha256.slice(0, 12)}… returned ${entry.parts.length} parts`,
        {
          code: "CONTENT_UPLOAD_FAILED",
          phase: "upload",
          retryable: false,
          context: "uploading deploy bytes",
        },
      );
    }
    const part = entry.parts[0];
    const slice = bytes.subarray(part.byte_start, part.byte_end + 1);
    const checksum = base64FromHex(entry.sha256);
    await putToS3(fetchFn, part.url, slice, checksum, part.part_number);
    return [];
  }
  const uploadedParts: UploadedPart[] = [];
  for (const part of entry.parts) {
    const slice = bytes.subarray(part.byte_start, part.byte_end + 1);
    const checksum = await sha256Base64(slice);
    const etag = await putToS3(fetchFn, part.url, slice, checksum, part.part_number);
    if (!etag) {
      throw new Run402DeployError(
        `S3 PUT succeeded for multipart part ${part.part_number} but did not return an ETag`,
        {
          code: "CONTENT_UPLOAD_FAILED",
          phase: "upload",
          retryable: false,
          context: "uploading deploy bytes",
        },
      );
    }
    uploadedParts.push({ part_number: part.part_number, etag });
  }
  return uploadedParts;
}

function uploadCompleteBody(
  session: MissingContent,
  uploadedParts: UploadedPart[],
): Record<string, unknown> {
  if (session.mode === "multipart") {
    return { parts: uploadedParts };
  }
  return {};
}

async function putToS3(
  fetchFn: typeof globalThis.fetch,
  url: string,
  body: Uint8Array,
  checksumBase64: string,
  partNumber: number,
): Promise<string | null> {
  // The gateway issues SigV4 presigned URLs with `ChecksumSHA256` set on
  // PutObjectCommand / UploadPartCommand. The AWS SDK (v3) encodes that
  // value as the `x-amz-checksum-sha256` query parameter and only signs
  // `host` + `content-length`. If we ALSO send it as a request header, S3
  // returns 403 "There were headers present in the request which were not
  // signed: x-amz-checksum-sha256" because the header isn't in the
  // SigV4-signed list.
  //
  // So: only send the header when the URL doesn't already encode the
  // checksum as a query param. This keeps us compatible with both
  // signing styles (query-param-encoded, the default for AWS SDK v3, and
  // header-signed, which an older signer might still produce).
  const headers: Record<string, string> = {};
  const urlHasChecksum = (() => {
    try {
      return new URL(url).searchParams.has("x-amz-checksum-sha256");
    } catch {
      return false;
    }
  })();
  if (!urlHasChecksum) {
    headers["x-amz-checksum-sha256"] = checksumBase64;
  }
  void checksumBase64; // silence unused-var if both branches skip the header

  let res: Response;
  try {
    res = await fetchFn(url, {
      method: "PUT",
      headers,
      body: body as BodyInit,
    });
  } catch (err) {
    throw new Run402DeployError(
      `S3 PUT failed for part ${partNumber}: ${(err as Error).message}`,
      {
        code: "CONTENT_UPLOAD_FAILED",
        phase: "upload",
        retryable: true,
        context: "uploading deploy bytes",
      },
    );
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Run402DeployError(
      `S3 PUT failed for part ${partNumber} (HTTP ${res.status})${text ? ": " + text.slice(0, 200) : ""}`,
      {
        code: "CONTENT_UPLOAD_FAILED",
        phase: "upload",
        retryable: res.status >= 500 || res.status === 403,
        status: res.status,
        body: text,
        context: "uploading deploy bytes",
      },
    );
  }
  return res.headers.get("etag");
}

async function pollUntilReady(
  client: Client,
  commit: CommitResponse,
  diff: PlanResponse["diff"],
  warnings: PlanResponse["warnings"],
  emit: (event: DeployEvent) => void,
  projectId: string | undefined,
  sliceKinds: ("release" | "asset")[] = [],
): Promise<DeployResult> {
  if (commit.status === "failed") {
    throw translateGatewayError(commit.error, "commit", null, commit.operation_id);
  }
  if (commit.status === "ready") {
    if (!commit.release_id || !commit.urls) {
      throw new Run402DeployError(
        "Commit returned ready but no release_id/urls",
        {
          code: "INTERNAL_ERROR",
          phase: "ready",
          retryable: false,
          operationId: commit.operation_id,
          context: "committing deploy",
        },
      );
    }
    emit({
      type: "ready",
      releaseId: commit.release_id,
      urls: commit.urls,
      ...(sliceKinds.length > 0 ? { slice_kinds: sliceKinds } : {}),
    });
    return {
      release_id: commit.release_id,
      operation_id: commit.operation_id,
      urls: commit.urls,
      diff,
      warnings,
    };
  }

  const opHeaders = projectId ? await apikeyHeaders(client, projectId) : {};
  const initialSnapshot: OperationSnapshot = await client.request<OperationSnapshot>(
    `/apply/v1/operations/${encodeURIComponent(commit.operation_id)}`,
    { headers: opHeaders, context: "fetching deploy operation" },
  );
  return await pollSnapshotUntilReady(client, initialSnapshot, diff, warnings, emit, projectId, sliceKinds);
}

async function pollSnapshotUntilReady(
  client: Client,
  initial: OperationSnapshot,
  diff: PlanResponse["diff"],
  warnings: PlanResponse["warnings"],
  emit: (event: DeployEvent) => void,
  projectId: string | undefined,
  sliceKinds: ("release" | "asset")[] = [],
): Promise<DeployResult> {
  // Helper to spread slice_kinds onto every commit.phase / ready emit so
  // agents grouping per-slice telemetry don't need to track the apply's
  // spec separately. The low-level commit/upload helpers that pass no
  // sliceKinds get an empty array → field is omitted from events.
  const withSliceKinds = <T extends { type: string }>(ev: T): T =>
    sliceKinds.length > 0
      ? ({ ...ev, slice_kinds: sliceKinds } as T)
      : ev;
  let snapshot = initial;
  const opHeaders = projectId ? await apikeyHeaders(client, projectId) : {};
  let lastPhaseEmitted: OperationStatus | null = null;
  const start = Date.now();
  let interval = COMMIT_POLL_INITIAL_MS;

  const phaseFor = (status: OperationStatus): DeployEvent | null => {
    const map: Partial<Record<OperationStatus, DeployEvent>> = {
      staging: { type: "commit.phase", phase: "stage", status: "started" },
      gating: { type: "commit.phase", phase: "migrate-gate", status: "started" },
      migrating: { type: "commit.phase", phase: "migrate", status: "started" },
      schema_settling: {
        type: "commit.phase",
        phase: "schema-settle",
        status: "started",
      },
      activating: { type: "commit.phase", phase: "activate", status: "started" },
      activation_pending: {
        type: "commit.phase",
        phase: "activate",
        status: "failed",
      },
    };
    return map[status] ?? null;
  };

  // Close out the previously-emitted phase as `done` (or `failed`) before
  // emitting the next phase's `started` event. Skips when there's no prior
  // phase, when the prior emission wasn't a `started` event (e.g. the
  // `activation_pending` path which already emits `failed`), or when the
  // prior phase string equals the next phase. (#135)
  const closePreviousPhase = (
    nextPhase?: string,
    closeStatus: "done" | "failed" = "done",
  ): void => {
    if (lastPhaseEmitted === null) return;
    const prev = phaseFor(lastPhaseEmitted);
    if (!prev || prev.type !== "commit.phase") return;
    if (prev.status !== "started") return;
    if (nextPhase !== undefined && prev.phase === nextPhase) return;
    emit(withSliceKinds({ type: "commit.phase", phase: prev.phase, status: closeStatus }));
  };

  while (true) {
    if (lastPhaseEmitted !== snapshot.status) {
      const ev = phaseFor(snapshot.status);
      if (ev) {
        if (ev.type === "commit.phase") closePreviousPhase(ev.phase);
        emit(withSliceKinds(ev));
        lastPhaseEmitted = snapshot.status;
      }
      // If `ev` is null (status not in the phase map, e.g. "ready"), leave
      // lastPhaseEmitted pointing at the prior in-flight phase so the
      // terminal-success closePreviousPhase() below can emit its `done`.
    }

    if (snapshot.status === SUCCESS_STATUS) {
      if (!snapshot.release_id || !snapshot.urls) {
        throw new Run402DeployError(
          "Operation reached ready but no release_id/urls available",
          {
            code: "INTERNAL_ERROR",
            phase: "ready",
            retryable: false,
            operationId: snapshot.operation_id,
            context: "polling deploy",
          },
        );
      }
      closePreviousPhase();
      emit(withSliceKinds({ type: "ready", releaseId: snapshot.release_id, urls: snapshot.urls }));
      return {
        release_id: snapshot.release_id,
        operation_id: snapshot.operation_id,
        urls: snapshot.urls,
        diff,
        warnings,
      };
    }

    if (TERMINAL_STATUSES.includes(snapshot.status)) {
      closePreviousPhase(undefined, "failed");
      throw translateGatewayError(
        snapshot.error,
        snapshot.status,
        snapshot.plan_id,
        snapshot.operation_id,
      );
    }

    if (
      snapshot.status === "activation_pending" &&
      isTerminalStaticActivationError(snapshot.error)
    ) {
      closePreviousPhase(undefined, "failed");
      throw translateGatewayError(
        snapshot.error,
        "activate",
        snapshot.plan_id,
        snapshot.operation_id,
      );
    }

    if (Date.now() - start > COMMIT_POLL_TIMEOUT_MS) {
      throw new Run402DeployError(
        `Timed out waiting for operation ${snapshot.operation_id} to reach ready`,
        {
          code: "INTERNAL_ERROR",
          phase: snapshot.status,
          retryable: true,
          operationId: snapshot.operation_id,
          status: 504,
          context: "polling deploy",
        },
      );
    }

    await sleep(interval);
    if (Date.now() - start > COMMIT_POLL_BACKOFF_AFTER_MS) {
      interval = Math.min(Math.floor(interval * 1.5), COMMIT_POLL_MAX_MS);
    }

    snapshot = await client.request<OperationSnapshot>(
      `/apply/v1/operations/${encodeURIComponent(snapshot.operation_id)}`,
      { headers: opHeaders, context: "polling deploy operation" },
    );
  }
}

function isTerminalStaticActivationError(
  error: GatewayDeployError | null | undefined,
): boolean {
  if (!error?.code) return false;
  if (error.retryable === false) return true;
  if (error.safe_to_retry === false) return true;
  return STATIC_ACTIVATION_FAILURE_CODES.has(error.code.toUpperCase());
}

// ─── start() implementation ──────────────────────────────────────────────────

async function startInternal(
  client: Client,
  spec: ReleaseSpec,
  opts: StartOptions,
): Promise<DeployOperation> {
  const allowWarningCodes = normalizeAllowWarningCodes(opts.allowWarningCodes);
  const buffered: DeployEvent[] = [];
  const subscribers: Array<(ev: DeployEvent) => void> = [];
  const emit = (event: DeployEvent): void => {
    buffered.push(event);
    if (opts.onEvent) {
      try {
        opts.onEvent(event);
      } catch {
        /* swallow */
      }
    }
    for (const fn of subscribers) {
      try {
        fn(event);
      } catch {
        /* swallow */
      }
    }
  };

  emit({ type: "plan.started" });
  const { plan, byteReaders } = await planInternal(client, spec, opts.idempotencyKey, {
    requiredPlan: opts.requiredPlan,
  });
  emit({ type: "plan.diff", diff: plan.diff });
  emitPlanWarnings(plan, emit);
  if (!opts.requiredPlan) abortOnConfirmationWarnings(plan, opts, allowWarningCodes);
  if (plan.payment_required) {
    emit({
      type: "payment.required",
      amount: plan.payment_required.amount,
      asset: plan.payment_required.asset,
      payTo: plan.payment_required.payTo,
      reason: plan.payment_required.reason,
    });
  }

  const sliceKinds = deriveSliceKinds(spec);
  const resultPromise: Promise<DeployResult> = (async () => {
    await uploadMissing(client, spec.project, plan.missing_content, byteReaders, emit);
    emit({
      type: "commit.phase",
      phase: "validate",
      status: "started",
      ...(sliceKinds.length > 0 ? { slice_kinds: sliceKinds } : {}),
    });
    const { planId } = requirePersistedPlan(plan, "starting deploy");
    const commit = requireCloudCommitResponse(
      await commitInternal(client, planId, opts.idempotencyKey, spec.project, opts.requiredPlan),
      "starting deploy",
    );
    return await pollUntilReady(client, commit, plan.diff, plan.warnings, emit, spec.project, sliceKinds);
  })();
  // Avoid an unhandled-rejection at construction time. Consumers must call
  // .result() to actually observe the error.
  resultPromise.catch(() => {});

  let snapshot: OperationSnapshot | null = null;
  const { operationId } = requirePersistedPlan(plan, "starting deploy");
  const startHeaders = await apikeyHeaders(client, spec.project);
  const fetchSnapshot = async (): Promise<OperationSnapshot> => {
    if (snapshot && TERMINAL_STATUSES.includes(snapshot.status)) return snapshot;
    snapshot = await client.request<OperationSnapshot>(
      `/apply/v1/operations/${encodeURIComponent(operationId)}`,
      { headers: startHeaders, context: "fetching deploy operation" },
    );
    return snapshot;
  };

  return {
    id: operationId,
    async snapshot() {
      return fetchSnapshot();
    },
    async result() {
      return resultPromise;
    },
    events(): AsyncIterable<DeployEvent> {
      return {
        [Symbol.asyncIterator](): AsyncIterator<DeployEvent> {
          const queue: DeployEvent[] = [...buffered];
          let resolveNext: ((v: IteratorResult<DeployEvent>) => void) | null = null;
          let done = false;
          // If a terminal event was already buffered before this iterator
          // attached (e.g. iteration starts after `await op.result()`
          // resolved), we'll go done after the queue drains. Without this,
          // late iteration would hang forever waiting for an emit that
          // will never come.
          const terminalAlreadyBuffered = buffered.some(
            (ev) => ev.type === "ready",
          );
          const subscriber = (ev: DeployEvent): void => {
            const waiter = resolveNext;
            if (waiter) {
              resolveNext = null;
              waiter({ value: ev, done: false });
            } else {
              queue.push(ev);
            }
            if (ev.type === "ready") {
              done = true;
              // The next() loop checks `done` after queue drain, so a
              // pending waiter that was just satisfied above will see
              // `done` on its next call. No second wake-up needed here.
            }
          };
          subscribers.push(subscriber);
          // Wake up on either success or failure of the result promise
          // so an iterator attached after termination always exits.
          const finalize = (): void => {
            done = true;
            if (resolveNext) {
              const r = resolveNext;
              resolveNext = null;
              r({ value: undefined as unknown as DeployEvent, done: true });
            }
          };
          resultPromise.then(finalize, finalize);

          return {
            next(): Promise<IteratorResult<DeployEvent>> {
              if (queue.length > 0) {
                return Promise.resolve({ value: queue.shift()!, done: false });
              }
              // After queue drain, if we already saw the terminal event
              // in the initial buffer (or the result promise has
              // resolved/rejected), we're done.
              if (done || terminalAlreadyBuffered) {
                return Promise.resolve({
                  value: undefined as unknown as DeployEvent,
                  done: true,
                });
              }
              return new Promise<IteratorResult<DeployEvent>>((resolve) => {
                resolveNext = resolve;
              });
            },
            return(): Promise<IteratorResult<DeployEvent>> {
              done = true;
              const idx = subscribers.indexOf(subscriber);
              if (idx >= 0) subscribers.splice(idx, 1);
              return Promise.resolve({
                value: undefined as unknown as DeployEvent,
                done: true,
              });
            },
          };
        },
      };
    },
  };
}

// ─── Spec normalization ──────────────────────────────────────────────────────

/**
 * A deferred byte reader: returns the bytes when called. The `label` is a
 * human-readable hint surfaced via `content.upload.progress` events. The
 * `contentType` is forwarded to the CAS content service when we issue the
 * upload session — same value the spec carried at normalization time.
 */
export interface ByteReader {
  (): Promise<Uint8Array>;
  label?: string;
  contentType?: string;
  /** Which spec slice category registered this byte reader. Set by the
   *  slice-tagged `remember` in `normalizeReleaseSpec` and surfaces on
   *  `content.upload.*` events so callers can group telemetry by slice.
   *  Cross-kind CAS dedup escalates the value to `"mixed"`. */
  slice?: "release" | "asset" | "mixed";
}

interface ResolvedContent {
  ref: ContentRef;
  reader: ByteReader;
}

const RELEASE_SPEC_FIELDS = new Set([
  "$schema",
  "project",
  "base",
  "database",
  "secrets",
  "functions",
  "site",
  "subdomains",
  "routes",
  "checks",
  "assets", // v1.48 unified-apply
  "i18n", // v2.5 routed-locale-context
]);
const DEPLOYABLE_SPEC_FIELDS = [
  "assets", // v1.48 unified-apply
  "database",
  "site",
  "functions",
  "secrets",
  "subdomains",
  "routes",
  "checks",
  "i18n", // v2.5 routed-locale-context
] as const;
const BASE_SPEC_FIELDS = new Set(["release", "release_id"]);
const DATABASE_SPEC_FIELDS = new Set(["migrations", "expose", "zero_downtime"]);
const MIGRATION_SPEC_FIELDS = new Set(["id", "checksum", "sql", "sql_ref", "transaction"]);
const FUNCTIONS_SPEC_FIELDS = new Set(["replace", "patch"]);
const FUNCTIONS_PATCH_FIELDS = new Set(["set", "delete"]);
const FUNCTION_SPEC_FIELDS = new Set([
  "runtime",
  "source",
  "files",
  "entrypoint",
  "config",
  "deps",
  "schedule",
  "requireAuth",
  "requireRole",
  "class",
  "capabilities",
]);
const FUNCTION_CONFIG_FIELDS = new Set(["timeoutSeconds", "memoryMb"]);
const SITE_SPEC_FIELDS = new Set(["replace", "patch", "public_paths"]);
const SITE_PATCH_FIELDS = new Set(["put", "delete"]);
const SITE_PUBLIC_PATHS_FIELDS = new Set(["mode", "replace"]);
const PUBLIC_STATIC_PATH_FIELDS = new Set(["asset", "cache_class"]);
const SUBDOMAINS_SPEC_FIELDS = new Set(["set", "add", "remove"]);
const ROUTES_SPEC_FIELDS = new Set(["replace"]);
const ROUTE_ENTRY_FIELDS = new Set(["pattern", "methods", "target", "acknowledge_readonly"]);
const FUNCTION_ROUTE_TARGET_FIELDS = new Set(["type", "name"]);
const STATIC_ROUTE_TARGET_FIELDS = new Set(["type", "file"]);
const ROUTE_METHOD_SET = new Set<string>(ROUTE_HTTP_METHODS);
const I18N_SPEC_FIELDS = new Set(["defaultLocale", "locales", "detect", "unknownLocalePolicy"]);
const I18N_LOCALE_TAG_REGEX = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const I18N_COOKIE_NAME_REGEX = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const I18N_MAX_LOCALES = 50;
const I18N_MAX_DETECT_SOURCES = 10;

function validateSpec(spec: ReleaseSpec): void {
  if (!spec || typeof spec !== "object") {
    throw new Run402DeployError("ReleaseSpec must be an object", {
      code: "INVALID_SPEC",
      phase: "validate",
      resource: "spec",
      retryable: false,
      fix: { action: "set_field", path: "" },
      context: "validating spec",
    });
  }

  const raw = spec as unknown as Record<string, unknown>;
  validateKnownFields(raw, "spec", RELEASE_SPEC_FIELDS, {
    project_id:
      "Use `project` in ReleaseSpec, or call `loadDeployManifest()` / `normalizeDeployManifest()` for MCP/CLI-style manifests.",
    subdomain: "Use `subdomains: { set: [name] }`.",
  });

  if (!spec.project || typeof spec.project !== "string") {
    throw new Run402DeployError("ReleaseSpec.project is required", {
      code: "INVALID_SPEC",
      phase: "validate",
      resource: "spec.project",
      retryable: false,
      fix: { action: "set_field", path: "project" },
      context: "validating spec",
    });
  }

  validateBaseSpec(raw.base);
  validateDatabaseSpec(raw.database);
  validateFunctionsSpec(raw.functions);
  validateSiteSpec(raw.site);
  validateSubdomainsSpec(raw.subdomains);
  validateRoutesSpec(raw.routes);
  validateChecksSpec(raw.checks);
  validateSecretsSpec(raw.secrets);
  validateI18nSpec(raw.i18n);

  const subdomains = raw.subdomains as Record<string, unknown> | undefined;
  const set = subdomains?.set as string[] | undefined;
  if (set && set.length > 1) {
    throw new Run402DeployError(
      "subdomains.set accepts at most one subdomain per project; multi-subdomain support is not yet available",
      {
        code: "SUBDOMAIN_MULTI_NOT_SUPPORTED",
        phase: "validate",
        resource: "subdomains.set",
        retryable: false,
        fix: { action: "set_field", path: "subdomains.set" },
        context: "validating spec",
      },
    );
  }

  if (!hasDeployableContent(raw)) {
    throw new Run402DeployError(
      `ReleaseSpec contains no deployable sections. Expected at least one non-empty section: ${DEPLOYABLE_SPEC_FIELDS.join(", ")}`,
      {
        code: "MANIFEST_EMPTY",
        phase: "validate",
        resource: "spec",
        retryable: false,
        fix: { action: "set_field", path: "site.replace" },
        body: { deployable_fields: DEPLOYABLE_SPEC_FIELDS },
        context: "validating spec",
      },
    );
  }
}

function validateBaseSpec(base: unknown): void {
  if (base === undefined) return;
  const obj = requireObject(base, "base");
  validateKnownFields(obj, "base", BASE_SPEC_FIELDS);
  if (hasOwn(obj, "release") && hasOwn(obj, "release_id")) {
    throw invalidSpec("ReleaseSpec.base must use either release or release_id, not both", "base");
  }
}

function validateDatabaseSpec(database: unknown): void {
  if (database === undefined) return;
  const obj = requireObject(database, "database");
  validateKnownFields(obj, "database", DATABASE_SPEC_FIELDS);
  if (obj.migrations !== undefined) {
    if (!Array.isArray(obj.migrations)) {
      throw invalidSpec("ReleaseSpec.database.migrations must be an array", "database.migrations");
    }
    for (const [index, migration] of obj.migrations.entries()) {
      const m = requireObject(migration, `database.migrations.${index}`);
      validateKnownFields(m, `database.migrations.${index}`, MIGRATION_SPEC_FIELDS);
    }
  }
  if (obj.expose !== undefined) {
    requireObject(obj.expose, "database.expose");
  }
}

function validateFunctionsSpec(functions: unknown): void {
  if (functions === undefined) return;
  const obj = requireObject(functions, "functions");
  validateKnownFields(obj, "functions", FUNCTIONS_SPEC_FIELDS);
  if (obj.replace !== undefined) {
    validateFunctionMap(obj.replace, "functions.replace");
  }
  if (obj.patch !== undefined) {
    const patch = requireObject(obj.patch, "functions.patch");
    validateKnownFields(patch, "functions.patch", FUNCTIONS_PATCH_FIELDS);
    if (patch.set !== undefined) validateFunctionMap(patch.set, "functions.patch.set");
    if (patch.delete !== undefined) validateStringArray(patch.delete, "functions.patch.delete");
  }
}

function validateFunctionMap(value: unknown, resource: string): void {
  const map = requireObject(value, resource);
  for (const [name, fn] of Object.entries(map)) {
    const entry = requireObject(fn, `${resource}.${name}`);
    validateKnownFields(entry, `${resource}.${name}`, FUNCTION_SPEC_FIELDS);
    if (entry.config !== undefined) {
      const config = requireObject(entry.config, `${resource}.${name}.config`);
      validateKnownFields(config, `${resource}.${name}.config`, FUNCTION_CONFIG_FIELDS);
      validateFunctionConfigInteger(
        config.timeoutSeconds,
        `${resource}.${name}.config.timeoutSeconds`,
      );
      validateFunctionConfigInteger(
        config.memoryMb,
        `${resource}.${name}.config.memoryMb`,
      );
    }
    if (entry.files !== undefined) {
      requireObject(entry.files, `${resource}.${name}.files`);
    }
  }
}

/**
 * Detect a site path key that belongs to the `@run402/astro` SSR adapter's
 * build tree rather than to deployable static content. The adapter writes
 * `dist/run402/{adapter.json, server/**, client/**}`; only `client/**` is
 * servable. `adapter.json` and `server/**` are build internals — their
 * presence in a site spec means the caller rooted their file source at the
 * build root (`dist/`) instead of `dist/run402/client/`.
 */
function isAstroAdapterTreeSitePath(path: string): boolean {
  return path === "run402/adapter.json" || path.startsWith("run402/server/");
}

/**
 * Return the synchronously-knowable keys of a site file container. Plain
 * path-keyed `FileSet`s expose their keys directly; a `LocalDirRef`
 * (`dir(path)`) or any future source sentinel carries an `__source` marker
 * and is only knowable after expansion — those return `[]` here and are
 * re-checked post-normalization.
 */
function siteFileSetKeysForGuard(container: unknown): string[] {
  if (
    !container ||
    typeof container !== "object" ||
    Array.isArray(container) ||
    (container as { __source?: unknown }).__source !== undefined
  ) {
    return [];
  }
  return Object.keys(container as Record<string, unknown>);
}

/**
 * Reject a site slice that ships the `@run402/astro` adapter build tree as
 * static content. This is the mis-rooting behind kychee-com/run402#411: a
 * deploy pointed `fileSetFromDir`/`dir()` at `dist/` (not `dist/run402/client/`),
 * so every page landed under a `run402/client/` path prefix while
 * `run402/adapter.json` + `run402/server/**` leaked in as assets — producing a
 * release that 404'd every URL and exposed the SSR bundle. Fail fast, locally,
 * with the fix, before any CAS upload or plan.
 */
function assertNoAstroAdapterTreeInSite(
  paths: Iterable<string>,
  resource: string,
): void {
  const offenders: string[] = [];
  for (const p of paths) {
    if (isAstroAdapterTreeSitePath(p)) offenders.push(p);
    if (offenders.length >= 3) break;
  }
  if (offenders.length === 0) return;
  throw new Run402DeployError(
    `${resource} ships the @run402/astro adapter build tree (e.g. ${offenders
      .map((p) => `\`${p}\``)
      .join(", ")}) as static content. Only \`dist/run402/client/\` is deployable; ` +
      `\`run402/adapter.json\` and \`run402/server/**\` are build internals. You likely ` +
      `rooted your file source at the build root (\`dist/\`) instead of \`dist/run402/client/\`. ` +
      `Use \`buildAstroReleaseSlice("dist")\` from @run402/astro (it roots the site and bundles ` +
      `the SSR function correctly), or point your dir at \`dist/run402/client\`.`,
    {
      code: "ASTRO_ADAPTER_TREE_IN_SITE",
      phase: "validate",
      resource,
      retryable: false,
      fix: {
        action: "reroot_site_to_astro_client_dir",
        path: resource,
        expected_dir: "dist/run402/client",
      },
      context: "validating spec",
    },
  );
}

function validateSiteSpec(site: unknown): void {
  if (site === undefined) return;
  const obj = requireObject(site, "site");
  validateKnownFields(obj, "site", SITE_SPEC_FIELDS, {
    file: "Use `site.replace` or `site.patch.put` with a path-keyed file map.",
    files: "Use `site.replace` or `site.patch.put` with a path-keyed file map.",
  });
  if (hasOwn(obj, "replace") && hasOwn(obj, "patch")) {
    throw invalidSpec("ReleaseSpec.site must use either replace or patch, not both", "site");
  }
  if (obj.replace !== undefined) {
    requireObject(obj.replace, "site.replace");
    assertNoAstroAdapterTreeInSite(siteFileSetKeysForGuard(obj.replace), "site.replace");
  }
  if (obj.patch !== undefined) {
    const patch = requireObject(obj.patch, "site.patch");
    validateKnownFields(patch, "site.patch", SITE_PATCH_FIELDS);
    if (patch.put !== undefined) {
      requireObject(patch.put, "site.patch.put");
      assertNoAstroAdapterTreeInSite(siteFileSetKeysForGuard(patch.put), "site.patch.put");
    }
    if (patch.delete !== undefined) validateStringArray(patch.delete, "site.patch.delete");
  }
  if (obj.public_paths !== undefined) {
    validateSitePublicPathsSpec(obj.public_paths, "site.public_paths");
  }
}

function validateSitePublicPathsSpec(value: unknown, resource: string): void {
  const obj = requireObject(value, resource);
  validateKnownFields(obj, resource, SITE_PUBLIC_PATHS_FIELDS);
  if (obj.mode !== "implicit" && obj.mode !== "explicit") {
    throw invalidSpec(
      `ReleaseSpec.${resource}.mode must be "implicit" or "explicit"`,
      `${resource}.mode`,
    );
  }
  if (obj.mode === "implicit") {
    if (hasOwn(obj, "replace")) {
      throw invalidSpec(
        "ReleaseSpec.site.public_paths.replace is not allowed when mode is implicit",
        `${resource}.replace`,
      );
    }
    return;
  }

  if (!hasOwn(obj, "replace")) {
    throw invalidSpec(
      "ReleaseSpec.site.public_paths with mode explicit requires a complete public_paths.replace map",
      `${resource}.replace`,
    );
  }
  const replace = requireObject(obj.replace, `${resource}.replace`);
  for (const [publicPath, entry] of Object.entries(replace)) {
    const entryResource = `${resource}.replace.${publicPath}`;
    const pathSpec = requireObject(entry, entryResource);
    validateKnownFields(pathSpec, entryResource, PUBLIC_STATIC_PATH_FIELDS);
    if (typeof pathSpec.asset !== "string" || pathSpec.asset.length === 0) {
      throw invalidSpec(
        `ReleaseSpec.${entryResource}.asset must be a non-empty release static asset path`,
        `${entryResource}.asset`,
      );
    }
    if (pathSpec.cache_class !== undefined && typeof pathSpec.cache_class !== "string") {
      throw invalidSpec(
        `ReleaseSpec.${entryResource}.cache_class must be a string`,
        `${entryResource}.cache_class`,
      );
    }
  }
}

function validateSubdomainsSpec(subdomains: unknown): void {
  if (subdomains === undefined) return;
  const obj = requireObject(subdomains, "subdomains");
  validateKnownFields(obj, "subdomains", SUBDOMAINS_SPEC_FIELDS);
  if (obj.set !== undefined) validateStringArray(obj.set, "subdomains.set");
  if (obj.add !== undefined) validateStringArray(obj.add, "subdomains.add");
  if (obj.remove !== undefined) validateStringArray(obj.remove, "subdomains.remove");
}

function validateRoutesSpec(routes: unknown): void {
  if (routes === undefined) return;
  if (routes === null) return;
  const obj = requireObject(routes, "routes");
  for (const key of Object.keys(obj)) {
    if (key.startsWith("/")) {
      throw invalidRouteSpec(
        `Unknown ReleaseSpec field: routes.${key}. ${routeShapeHints(obj)[key]}`,
        `routes.${key}`,
      );
    }
  }
  validateKnownFields(obj, "routes", ROUTES_SPEC_FIELDS, routeShapeHints(obj));
  if (!hasOwn(obj, "replace")) {
    throw invalidRouteSpec(
      "ReleaseSpec.routes must be null or { replace: [{ pattern, target: { type: \"function\", name } | { type: \"static\", file } }] }. Path-keyed route maps are not supported.",
      "routes",
    );
  }
  if (!Array.isArray(obj.replace)) {
    throw invalidRouteSpec("ReleaseSpec.routes.replace must be an array of route entries", "routes.replace");
  }
  for (const [index, route] of obj.replace.entries()) {
    validateRouteEntry(route, `routes.replace.${index}`);
  }
}

function routeShapeHints(obj: Record<string, unknown>): Record<string, string> {
  const hints: Record<string, string> = {};
  for (const key of Object.keys(obj)) {
    if (key.startsWith("/")) {
      hints[key] = "Use `routes.replace[]` entries like `{ pattern, target: { type: \"function\", name } }` or `{ pattern, methods: [\"GET\"], target: { type: \"static\", file } }` instead of a path-keyed route map.";
    }
  }
  return hints;
}

function validateRouteEntry(route: unknown, resource: string): void {
  const entry = requireObject(route, resource);
  validateKnownFields(entry, resource, ROUTE_ENTRY_FIELDS);
  if (typeof entry.pattern !== "string" || entry.pattern.length === 0) {
    throw invalidRouteSpec(`ReleaseSpec.${resource}.pattern must be a non-empty string`, `${resource}.pattern`);
  }
  if (entry.methods !== undefined) {
    if (!Array.isArray(entry.methods)) {
      throw invalidRouteSpec(`ReleaseSpec.${resource}.methods must be an array of HTTP methods`, `${resource}.methods`);
    }
    if (entry.methods.length === 0) {
      throw invalidRouteSpec(
        `ReleaseSpec.${resource}.methods must not be empty; omit methods to allow all supported methods`,
        `${resource}.methods`,
      );
    }
    for (const method of entry.methods) {
      if (typeof method !== "string" || !ROUTE_METHOD_SET.has(method)) {
        throw invalidRouteSpec(
          `Unsupported route method ${JSON.stringify(method)} at ReleaseSpec.${resource}.methods. Supported methods: ${ROUTE_HTTP_METHODS.join(", ")}`,
          `${resource}.methods`,
        );
      }
    }
    const seen = new Set<string>();
    for (const method of entry.methods) {
      const methodString = method as string;
      if (seen.has(methodString)) {
        throw invalidRouteSpec(
          `ReleaseSpec.${resource}.methods contains duplicate method ${JSON.stringify(method)}`,
          `${resource}.methods`,
        );
      }
      seen.add(methodString);
    }
  }
  const targetType = validateRouteTarget(entry.target, `${resource}.target`);
  validateRouteReadOnlyAcknowledgement(entry, targetType, resource);
  if (targetType === "static") {
    validateStaticRouteEntry(entry, resource);
  }
}

function validateRouteReadOnlyAcknowledgement(
  entry: Record<string, unknown>,
  targetType: "function" | "static",
  resource: string,
): void {
  if (entry.acknowledge_readonly === undefined) return;
  if (entry.acknowledge_readonly !== true) {
    throw invalidRouteSpec(
      `ReleaseSpec.${resource}.acknowledge_readonly must be true when present`,
      `${resource}.acknowledge_readonly`,
    );
  }
  if (
    targetType !== "function" ||
    typeof entry.pattern !== "string" ||
    !isFinalWildcardRoutePattern(entry.pattern) ||
    !isReadOnlyRouteMethods(entry.methods)
  ) {
    throw invalidRouteSpec(
      `ReleaseSpec.${resource}.acknowledge_readonly applies only to GET/HEAD final-wildcard function routes`,
      `${resource}.acknowledge_readonly`,
    );
  }
}

function validateRouteTarget(target: unknown, resource: string): "function" | "static" {
  const obj = requireObject(target, resource);
  if ((hasOwn(obj, "function") || hasOwn(obj, "static")) && !hasOwn(obj, "type")) {
    throw invalidRouteSpec(
      `ReleaseSpec.${resource} uses an unsupported target shorthand. Use { type: "function", name: "api" } or { type: "static", file: "events.html" }.`,
      resource,
    );
  }
  if (obj.type === undefined) {
    throw invalidRouteSpec(`ReleaseSpec.${resource}.type is required; use "function" or "static"`, `${resource}.type`);
  }
  if (obj.type === "function") {
    validateKnownFields(obj, resource, FUNCTION_ROUTE_TARGET_FIELDS);
    if (typeof obj.name !== "string" || obj.name.length === 0) {
      throw invalidRouteSpec(`ReleaseSpec.${resource}.name is required for function route targets`, `${resource}.name`);
    }
    return "function";
  }
  if (obj.type === "static") {
    validateKnownFields(obj, resource, STATIC_ROUTE_TARGET_FIELDS);
    if (typeof obj.file !== "string" || obj.file.length === 0) {
      throw invalidRouteSpec(`ReleaseSpec.${resource}.file is required for static route targets`, `${resource}.file`);
    }
    validateStaticTargetFile(obj.file, `${resource}.file`);
    return "static";
  }
  throw invalidRouteSpec(
    `Unsupported route target type ${JSON.stringify(obj.type)} at ReleaseSpec.${resource}.type; route targets support "function" and "static"`,
    `${resource}.type`,
  );
}

function validateStaticRouteEntry(entry: Record<string, unknown>, resource: string): void {
  const pattern = entry.pattern as string;
  if (pattern.includes("*")) {
    throw invalidRouteSpec(
      `ReleaseSpec.${resource}.pattern uses a static route target, so it must be an exact path pattern (wildcard patterns such as /docs/* are not supported for static targets)`,
      `${resource}.pattern`,
    );
  }
  if (entry.methods === undefined) {
    throw invalidRouteSpec(
      `ReleaseSpec.${resource}.methods is required for static route targets; use ["GET"] or ["GET", "HEAD"]`,
      `${resource}.methods`,
    );
  }
  const methods = entry.methods as unknown[];
  const methodSet = new Set(methods);
  const valid =
    methodSet.has("GET") &&
    (methodSet.size === 1 || (methodSet.size === 2 && methodSet.has("HEAD")));
  if (!valid) {
    throw invalidRouteSpec(
      `ReleaseSpec.${resource}.methods for static route targets must be ["GET"] or ["GET", "HEAD"]; either form materializes effective GET plus HEAD`,
      `${resource}.methods`,
    );
  }
}

function validateStaticTargetFile(file: string, resource: string): void {
  const invalid =
    file.startsWith("/") ||
    file.includes("?") ||
    file.includes("#") ||
    file.includes("\\") ||
    file.endsWith("/") ||
    file.split("/").some((segment) => segment === "" || segment === "." || segment === "..");
  if (invalid) {
    throw invalidRouteSpec(
      `ReleaseSpec.${resource} must be a relative materialized static-site file path without leading slash, query, fragment, traversal, empty segments, backslashes, or directory shorthand`,
      resource,
    );
  }
}

function validateChecksSpec(checks: unknown): void {
  if (checks === undefined) return;
  if (!Array.isArray(checks)) {
    throw invalidSpec("ReleaseSpec.checks must be an array", "checks");
  }
}

function validateI18nSpec(i18n: unknown): void {
  if (i18n === undefined) return;
  if (i18n === null) return;
  const obj = requireObject(i18n, "i18n");
  validateKnownFields(obj, "i18n", I18N_SPEC_FIELDS, {
    default_locale: "Use `defaultLocale` (camelCase) in i18n.",
    default: "Use `defaultLocale` in i18n.",
    locale: "Use `locales` (plural array) in i18n.",
  });

  if (typeof obj.defaultLocale !== "string" || obj.defaultLocale.length === 0) {
    throw invalidSpec(
      "ReleaseSpec.i18n.defaultLocale is required and must be a non-empty string",
      "i18n.defaultLocale",
    );
  }
  if (!I18N_LOCALE_TAG_REGEX.test(obj.defaultLocale)) {
    throw invalidSpec(
      `ReleaseSpec.i18n.defaultLocale ${JSON.stringify(obj.defaultLocale)} must match /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/`,
      "i18n.defaultLocale",
    );
  }

  if (!Array.isArray(obj.locales)) {
    throw invalidSpec(
      "ReleaseSpec.i18n.locales is required and must be a non-empty array of locale tags",
      "i18n.locales",
    );
  }
  if (obj.locales.length === 0) {
    throw invalidSpec(
      "ReleaseSpec.i18n.locales must contain at least one entry",
      "i18n.locales",
    );
  }
  if (obj.locales.length > I18N_MAX_LOCALES) {
    throw invalidSpec(
      `ReleaseSpec.i18n.locales accepts at most ${I18N_MAX_LOCALES} entries (got ${obj.locales.length})`,
      "i18n.locales",
    );
  }
  const seenLocales = new Set<string>();
  for (let i = 0; i < obj.locales.length; i++) {
    const tag = obj.locales[i];
    const path = `i18n.locales.${i}`;
    if (typeof tag !== "string" || tag.length === 0) {
      throw invalidSpec(`ReleaseSpec.${path} must be a non-empty string`, path);
    }
    if (!I18N_LOCALE_TAG_REGEX.test(tag)) {
      throw invalidSpec(
        `ReleaseSpec.${path} (${JSON.stringify(tag)}) must match /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/`,
        path,
      );
    }
    if (seenLocales.has(tag)) {
      throw invalidSpec(
        `ReleaseSpec.i18n.locales contains duplicate entry ${JSON.stringify(tag)}`,
        path,
      );
    }
    seenLocales.add(tag);
  }
  if (!seenLocales.has(obj.defaultLocale as string)) {
    throw invalidSpec(
      `ReleaseSpec.i18n.defaultLocale (${JSON.stringify(obj.defaultLocale)}) must be byte-identical to one entry in i18n.locales`,
      "i18n.defaultLocale",
    );
  }

  if (obj.detect !== undefined) {
    if (!Array.isArray(obj.detect)) {
      throw invalidSpec(
        "ReleaseSpec.i18n.detect must be an array of detect sources",
        "i18n.detect",
      );
    }
    if (obj.detect.length > I18N_MAX_DETECT_SOURCES) {
      throw invalidSpec(
        `ReleaseSpec.i18n.detect accepts at most ${I18N_MAX_DETECT_SOURCES} entries (got ${obj.detect.length})`,
        "i18n.detect",
      );
    }
    for (let i = 0; i < obj.detect.length; i++) {
      const source = obj.detect[i];
      const path = `i18n.detect.${i}`;
      if (typeof source !== "string" || source.length === 0) {
        throw invalidSpec(
          `ReleaseSpec.${path} must be a non-empty string ("accept-language" or "cookie:<name>")`,
          path,
        );
      }
      if (source === "accept-language") continue;
      if (source.startsWith("cookie:")) {
        const cookieName = source.slice("cookie:".length);
        if (cookieName.length === 0) {
          throw invalidSpec(
            `ReleaseSpec.${path} cookie source is missing the cookie name (use "cookie:<name>")`,
            path,
          );
        }
        if (!I18N_COOKIE_NAME_REGEX.test(cookieName)) {
          throw invalidSpec(
            `ReleaseSpec.${path} cookie name ${JSON.stringify(cookieName)} must match the RFC 6265 cookie-name grammar /^[!#$%&'*+\\-.^_\`|~0-9A-Za-z]+$/`,
            path,
          );
        }
        continue;
      }
      throw invalidSpec(
        `ReleaseSpec.${path} must be "accept-language" or "cookie:<name>" (got ${JSON.stringify(source)})`,
        path,
      );
    }
  }
}

function validateKnownFields(
  obj: Record<string, unknown>,
  resource: string,
  allowed: Set<string>,
  hints: Record<string, string> = {},
): void {
  for (const key of Object.keys(obj)) {
    if (allowed.has(key)) continue;
    const field = resource === "spec" ? `spec.${key}` : `${resource}.${key}`;
    const hint = hints[key] ? ` ${hints[key]}` : "";
    throw invalidSpec(`Unknown ReleaseSpec field: ${field}.${hint}`, field);
  }
}

function requireObject(value: unknown, resource: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalidSpec(`ReleaseSpec.${resource} must be an object`, resource);
  }
  return value as Record<string, unknown>;
}

function validateStringArray(value: unknown, resource: string): void {
  if (!Array.isArray(value)) {
    throw invalidSpec(`ReleaseSpec.${resource} must be an array`, resource);
  }
  if (value.some((entry) => typeof entry !== "string")) {
    throw invalidSpec(`ReleaseSpec.${resource} entries must be strings`, resource);
  }
}

function validateFunctionConfigInteger(value: unknown, resource: string): void {
  if (value === undefined) return;
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw invalidSpec(`ReleaseSpec.${resource} must be a positive safe JSON integer`, resource);
  }
}

function hasDeployableContent(spec: Record<string, unknown>): boolean {
  return (
    hasDatabaseContent(spec.database) ||
    hasSiteContent(spec.site) ||
    hasFunctionsContent(spec.functions) ||
    hasSecretsContent(spec.secrets) ||
    hasSubdomainsContent(spec.subdomains) ||
    hasRecordEntries(spec.routes) ||
    hasArrayEntries(spec.checks) ||
    hasAssetsContent(spec.assets) ||
    hasI18nContent(spec.i18n)
  );
}

function hasI18nContent(i18n: unknown): boolean {
  if (i18n === null) return true;
  return isRecord(i18n);
}

function hasAssetsContent(assets: unknown): boolean {
  if (!isRecord(assets)) return false;
  if (hasArrayEntries(assets.put)) return true;
  if (hasArrayEntries(assets.delete)) return true;
  return isRecord(assets.sync);
}

function hasDatabaseContent(database: unknown): boolean {
  if (!isRecord(database)) return false;
  return hasArrayEntries(database.migrations) || hasRecordEntries(database.expose);
}

function hasSiteContent(site: unknown): boolean {
  if (!isRecord(site)) return false;
  if (hasRecordEntries(site.replace)) return true;
  if (isRecord(site.patch)) {
    return hasRecordEntries(site.patch.put) || hasArrayEntries(site.patch.delete);
  }
  return isRecord(site.public_paths);
}

function hasFunctionsContent(functions: unknown): boolean {
  if (!isRecord(functions)) return false;
  if (hasRecordEntries(functions.replace)) return true;
  if (!isRecord(functions.patch)) return false;
  return hasRecordEntries(functions.patch.set) || hasArrayEntries(functions.patch.delete);
}

function hasSecretsContent(secrets: unknown): boolean {
  if (!isRecord(secrets)) return false;
  return hasArrayEntries(secrets.require) || hasArrayEntries(secrets.delete);
}

function hasSubdomainsContent(subdomains: unknown): boolean {
  if (!isRecord(subdomains)) return false;
  return (
    hasArrayEntries(subdomains.set) ||
    hasArrayEntries(subdomains.add) ||
    hasArrayEntries(subdomains.remove)
  );
}

function hasRecordEntries(value: unknown): boolean {
  return isRecord(value) && Object.keys(value).length > 0;
}

function hasArrayEntries(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0;
}

function hasOwn(obj: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function invalidSpec(message: string, resource: string): Run402DeployError {
  return new Run402DeployError(message, {
    code: "INVALID_SPEC",
    phase: "validate",
    resource,
    retryable: false,
    fix: { action: "set_field", path: resource.replace(/^spec\./, "") },
    context: "validating spec",
  });
}

function invalidRouteSpec(message: string, resource: string): Run402DeployError {
  return new Run402DeployError(message, {
    code: "INVALID_SPEC",
    phase: "validate",
    resource,
    retryable: false,
    fix: {
      action: "set_field",
      path: "routes.replace",
      example: {
        routes: {
          replace: [
            {
              pattern: "/api/*",
              target: { type: "function", name: "api" },
            },
            {
              pattern: "/events",
              methods: ["GET", "HEAD"],
              target: { type: "static", file: "events.html" },
            },
          ],
        },
      },
    },
    context: "validating spec",
  });
}

function normalizePlanResponse(plan: PlanResponse): PlanResponse {
  const raw = plan as PlanResponse & { warnings?: unknown };
  const warnings = Array.isArray(raw.warnings) ? raw.warnings : [];
  const missingContent = Array.isArray(raw.missing_content) ? raw.missing_content : [];
  if (raw.kind === "plan_response") {
    const diff: DeployDiff = {
      is_noop: raw.is_noop,
      summary: raw.summary,
      warnings,
      migrations: raw.migrations,
      site: raw.site,
      functions: raw.functions,
      secrets: raw.secrets,
      subdomains: raw.subdomains,
      routes: raw.routes,
      static_assets: raw.static_assets,
    };
    return {
      ...plan,
      warnings,
      missing_content: missingContent,
      diff,
      payment_required: raw.payment_required ?? null,
    };
  }
  return {
    ...plan,
    warnings,
    missing_content: missingContent,
    diff: plan.diff ?? {},
  };
}

function requirePersistedPlan(
  plan: PlanResponse,
  context: string,
): { planId: string; operationId: string } {
  if (plan.plan_id && plan.operation_id) {
    return { planId: plan.plan_id, operationId: plan.operation_id };
  }
  throw new Run402DeployError(
    "Dry-run plan responses cannot be uploaded or committed because they do not create plan or operation rows.",
    {
      code: "DRY_RUN_PLAN_NOT_COMMITTABLE",
      phase: "plan",
      resource: "plan_id",
      retryable: false,
      context,
    },
  );
}

function requirePlanId(plan: PlanResponse, context: string): string {
  if (plan.plan_id) return plan.plan_id;
  throw new Run402DeployError(
    "Plan response cannot be committed because it does not include plan_id.",
    {
      code: "DRY_RUN_PLAN_NOT_COMMITTABLE",
      phase: "plan",
      resource: "plan_id",
      retryable: false,
      context,
    },
  );
}

function isCoreCommitResponse(commit: CommitResponse | CoreCommitResponse): commit is CoreCommitResponse {
  return (
    typeof (commit as CoreCommitResponse).plan_id === "string" &&
    typeof (commit as CoreCommitResponse).project_id === "string" &&
    typeof (commit as CoreCommitResponse).release_digest === "string" &&
    (
      (commit as CoreCommitResponse).status === "committed" ||
      (commit as CoreCommitResponse).status === "noop" ||
      (commit as CoreCommitResponse).status === "deferred"
    )
  );
}

function requireCloudCommitResponse(
  commit: CommitResponse | CoreCommitResponse,
  context: string,
): CommitResponse {
  if (!isCoreCommitResponse(commit)) return commit;
  throw new Run402DeployError(
    "Core commit response reached a Cloud operation-polling path.",
    {
      code: "INTERNAL_ERROR",
      phase: "commit",
      retryable: false,
      context,
    },
  );
}

async function coreDeployResult(
  client: Client,
  commit: CoreCommitResponse,
  diff: PlanResponse["diff"],
  warnings: PlanResponse["warnings"],
  emit: (event: DeployEvent) => void,
  projectId: string,
  sliceKinds: ("release" | "asset")[] = [],
): Promise<DeployResult> {
  if (commit.status === "deferred") {
    throw new Run402DeployError(
      commit.deferred_reason ?? "Core deploy commit deferred.",
      {
        code: "INTERNAL_ERROR",
        phase: commit.deferred_phase ?? "commit",
        retryable: true,
        context: "committing Core deploy",
      },
    );
  }
  const urls = await coreProjectUrls(client, projectId);
  emit({
    type: "ready",
    releaseId: commit.release_id,
    urls,
    ...(sliceKinds.length > 0 ? { slice_kinds: sliceKinds } : {}),
  });
  return {
    release_id: commit.release_id,
    operation_id: `core:${commit.plan_id}`,
    urls,
    diff,
    warnings,
  };
}

async function coreProjectUrls(client: Client, projectId: string): Promise<Record<string, string>> {
  try {
    const project = await client.request<{
      endpoints?: { static_base_url?: string; rest_url?: string; storage_base_url?: string };
    }>(`/projects/v1/${encodeURIComponent(projectId)}`, {
      method: "GET",
      context: "fetching Core project endpoints",
    });
    const staticUrl = project.endpoints?.static_base_url;
    return {
      ...(staticUrl ? { site: staticUrl, static: staticUrl } : {}),
      ...(project.endpoints?.rest_url ? { rest: project.endpoints.rest_url } : {}),
      ...(project.endpoints?.storage_base_url ? { storage: project.endpoints.storage_base_url } : {}),
    };
  } catch {
    const staticUrl = `${client.apiBase.replace(/\/+$/, "")}/projects/v1/${encodeURIComponent(projectId)}/static`;
    return { site: staticUrl, static: staticUrl };
  }
}

function emitPlanWarnings(
  plan: PlanResponse,
  emit: (event: DeployEvent) => void,
): void {
  if (plan.warnings.length > 0) {
    emit({ type: "plan.warnings", warnings: plan.warnings });
  }
}

function withClientPlanWarnings(
  spec: NormalizedReleaseSpec,
  plan: PlanResponse,
): PlanResponse {
  const warnings = clientRoutePlanWarnings(spec);
  if (warnings.length === 0) return plan;

  const seen = new Set(
    plan.warnings.map((warning) => warningKey(warning)),
  );
  const nextWarnings = [...plan.warnings];
  for (const warning of warnings) {
    const key = warningKey(warning);
    if (seen.has(key)) continue;
    seen.add(key);
    nextWarnings.push(warning);
  }

  return { ...plan, warnings: nextWarnings };
}

function warningKey(warning: WarningEntry): string {
  return `${warning.code}:${(warning.affected ?? []).join(",")}`;
}

function clientRoutePlanWarnings(spec: NormalizedReleaseSpec): WarningEntry[] {
  const routes = spec.routes;
  if (!routes || !("replace" in routes)) return [];

  const affected = routes.replace
    .filter((route) => {
      if (route.target.type !== "function") return false;
      if (!isFinalWildcardRoutePattern(route.pattern)) return false;
      if (!route.methods) return false;
      if (route.acknowledge_readonly === true) return false;
      return isReadOnlyRouteMethods(route.methods);
    })
    .map((route) => route.pattern)
    .sort();

  if (affected.length === 0) return [];
  return [
    {
      code: "WILDCARD_ROUTE_EXCLUDES_MUTATION_METHODS",
      severity: "warn",
      requires_confirmation: true,
      message:
        "A wildcard function route only allows GET/HEAD. Mutation endpoints under that prefix will be rejected by the gateway before the function runs.",
      affected,
      confidence: "heuristic",
      details: {
        missing_common_methods: ["POST", "PUT", "PATCH", "DELETE"],
        fix: "Add the mutation methods your routed function supports, or omit methods to allow every supported method.",
      },
    },
  ];
}

function isFinalWildcardRoutePattern(pattern: string): boolean {
  return pattern.endsWith("/*");
}

function isReadOnlyRouteMethods(methods: unknown): boolean {
  if (!Array.isArray(methods) || methods.length === 0) return false;
  return methods.every((method) => method === "GET" || method === "HEAD");
}

function normalizeAllowWarningCodes(value: unknown): Set<string> {
  if (value === undefined) return new Set();
  if (!Array.isArray(value)) {
    throw new Run402DeployError("ApplyOptions.allowWarningCodes must be an array of warning-code strings", {
      code: "INVALID_SPEC",
      phase: "validate",
      resource: "allowWarningCodes",
      retryable: false,
      context: "validating deploy warning options",
    });
  }
  const codes = new Set<string>();
  for (const code of value) {
    if (typeof code !== "string" || code.length === 0) {
      throw new Run402DeployError("ApplyOptions.allowWarningCodes entries must be non-empty strings", {
        code: "INVALID_SPEC",
        phase: "validate",
        resource: "allowWarningCodes",
        retryable: false,
        context: "validating deploy warning options",
      });
    }
    codes.add(code);
  }
  return codes;
}

function abortOnConfirmationWarnings(
  plan: PlanResponse,
  opts: Pick<ApplyOptions, "allowWarnings">,
  allowWarningCodes: Set<string>,
): void {
  if (opts.allowWarnings) return;
  const blocking = plan.warnings.filter(
    (w) => w.requires_confirmation || w.code === "MISSING_REQUIRED_SECRET",
  );
  if (blocking.length === 0) return;
  const unacknowledged = blocking.filter((w) => !allowWarningCodes.has(w.code));
  if (unacknowledged.length === 0) return;
  const missing = unacknowledged.find((w) => w.code === "MISSING_REQUIRED_SECRET");
  const first = missing ?? unacknowledged[0]!;
  const unacknowledgedCodes = Array.from(new Set(unacknowledged.map((w) => w.code))).sort();
  throw new Run402DeployError(
    `Deploy plan returned unacknowledged warning ${first.code}; resolve it, retry with allowWarningCodes for reviewed warning codes, or retry with allowWarnings after explicit review.`,
    {
      code: first.code || "DEPLOY_WARNING_REQUIRES_CONFIRMATION",
      phase: "plan",
      resource: "warnings",
      retryable: false,
      fix: { action: "review_warnings", path: "warnings" },
      body: {
        warnings: blocking,
        unacknowledged_warnings: unacknowledged,
        unacknowledged_warning_codes: unacknowledgedCodes,
        allowed_warning_codes: Array.from(allowWarningCodes).sort(),
      },
      context: "planning deploy",
    },
  );
}

function validateSecretsSpec(secrets: unknown): void {
  if (secrets === undefined) return;
  if (!secrets || typeof secrets !== "object" || Array.isArray(secrets)) {
    throw invalidSecretSpec("ReleaseSpec.secrets must be an object", "secrets");
  }

  const obj = secrets as Record<string, unknown>;
  const allowed = new Set(["require", "delete"]);
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) {
      throw invalidSecretSpec(
        key === "set" || key === "replace_all"
          ? `ReleaseSpec.secrets.${key} is no longer supported; set values with the secrets API, then use secrets.require[] in the deploy spec.`
          : `Unknown ReleaseSpec.secrets field: ${key}`,
        `secrets.${key}`,
      );
    }
  }

  const required = validateSecretKeyArray(obj.require, "secrets.require");
  const deleted = validateSecretKeyArray(obj.delete, "secrets.delete");
  const deleteSet = new Set(deleted);
  const conflict = required.find((key) => deleteSet.has(key));
  if (conflict) {
    throw invalidSecretSpec(
      `Secret key ${conflict} cannot appear in both secrets.require and secrets.delete`,
      "secrets",
    );
  }
}

function validateSecretKeyArray(value: unknown, resource: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw invalidSecretSpec(`${resource} must be an array of secret keys`, resource);
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const key of value) {
    if (typeof key !== "string" || !SECRET_KEY_RE.test(key)) {
      throw invalidSecretSpec(
        `${resource} entries must match ${SECRET_KEY_RE.source}`,
        resource,
      );
    }
    if (seen.has(key)) {
      throw invalidSecretSpec(`${resource} contains duplicate key ${key}`, resource);
    }
    seen.add(key);
    out.push(key);
  }
  return out;
}

function invalidSecretSpec(message: string, resource: string): Run402DeployError {
  return new Run402DeployError(message, {
    code: "INVALID_SPEC",
    phase: "validate",
    resource,
    retryable: false,
    fix: { action: "set_field", path: resource },
    context: "validating spec",
  });
}

async function normalizeReleaseSpec(
  client: Client,
  spec: ReleaseSpec,
  opts: { inlineMigrationSql?: boolean } = {},
): Promise<{
  normalized: NormalizedReleaseSpec;
  byteReaders: Map<string, ByteReader>;
}> {
  const byteReaders = new Map<string, ByteReader>();
  // Slice-tagged `remember`. Each slice category creates its own remember
  // closure so the registered reader carries `reader.slice = "release" |
  // "asset"`. On cross-kind dedup (same SHA from both a release-bound
  // slice and the asset slice) the value escalates to `"mixed"`. This
  // value surfaces on `content.upload.*` events so agents can group
  // upload telemetry by slice kind.
  const makeRemember = (slice: "release" | "asset") =>
    (resolved: ResolvedContent): ContentRef => {
      // Propagate the final content-type onto the deferred reader so the CAS
      // upload session can declare it correctly. Callers may set
      // ref.contentType *after* resolveContent returns (e.g. normalizeFileSet
      // sets it from the path extension), so do this at remember time.
      if (resolved.ref.contentType && !resolved.reader.contentType) {
        resolved.reader.contentType = resolved.ref.contentType;
      }
      if (!byteReaders.has(resolved.ref.sha256)) {
        resolved.reader.slice = slice;
        byteReaders.set(resolved.ref.sha256, resolved.reader);
      } else {
        // Already remembered — but if the existing reader has no contentType
        // and we just learned it, fill it in. Also escalate slice tag when
        // the second registration comes from a different kind.
        const existing = byteReaders.get(resolved.ref.sha256)!;
        if (resolved.ref.contentType && !existing.contentType) {
          existing.contentType = resolved.ref.contentType;
        }
        if (existing.slice && existing.slice !== slice && existing.slice !== "mixed") {
          existing.slice = "mixed";
        }
      }
      return resolved.ref;
    };
  const rememberRelease = makeRemember("release");
  const rememberAsset = makeRemember("asset");

  const normalized: NormalizedReleaseSpec = { project: spec.project };
  if (spec.base) normalized.base = spec.base;
  if (spec.subdomains) normalized.subdomains = spec.subdomains;
  if (hasOwn(spec as unknown as Record<string, unknown>, "routes")) {
    normalized.routes = spec.routes;
  }
  if (hasOwn(spec as unknown as Record<string, unknown>, "i18n")) {
    normalized.i18n = spec.i18n;
  }
  if (spec.checks) normalized.checks = spec.checks;
  if (spec.secrets) normalized.secrets = spec.secrets;

  if (spec.database) {
    const db: NormalizedDatabaseSpec = {};
    if (spec.database.expose) db.expose = spec.database.expose;
    if (typeof spec.database.zero_downtime === "boolean") {
      db.zero_downtime = spec.database.zero_downtime;
    }
    if (spec.database.migrations && spec.database.migrations.length > 0) {
      db.migrations = await Promise.all(
        spec.database.migrations.map(async (m) =>
          normalizeMigration(client, spec.project, m, rememberRelease, opts),
        ),
      );
    }
    normalized.database = db;
  }

  if (spec.functions) {
    const fns: NormalizedFunctionsSpec = {};
    if (spec.functions.replace) {
      fns.replace = await normalizeFunctionMap(spec.functions.replace, rememberRelease);
    }
    if (spec.functions.patch) {
      fns.patch = {};
      if (spec.functions.patch.set) {
        fns.patch.set = await normalizeFunctionMap(spec.functions.patch.set, rememberRelease);
      }
      if (spec.functions.patch.delete) fns.patch.delete = spec.functions.patch.delete;
    }
    normalized.functions = fns;
  }

  if (spec.site) {
    const publicPaths =
      "public_paths" in spec.site ? spec.site.public_paths : undefined;
    if ("replace" in spec.site && spec.site.replace) {
      const map = await normalizeFileSet(spec.site.replace, rememberRelease);
      // Re-check post-expansion so `dir("dist")` (a LocalDirRef whose keys are
      // unknown at validateSpec time) is caught too, not just literal FileSets.
      assertNoAstroAdapterTreeInSite(Object.keys(map), "site.replace");
      normalized.site = {
        replace: map,
        ...(publicPaths ? { public_paths: publicPaths } : {}),
      } as NormalizedSiteSpec;
    } else if ("patch" in spec.site && spec.site.patch) {
      const patch: { put?: Record<string, ContentRef>; delete?: string[] } = {};
      if (spec.site.patch.put) {
        patch.put = await normalizeFileSet(spec.site.patch.put, rememberRelease);
        assertNoAstroAdapterTreeInSite(Object.keys(patch.put), "site.patch.put");
      }
      if (spec.site.patch.delete) patch.delete = spec.site.patch.delete;
      normalized.site = {
        patch,
        ...(publicPaths ? { public_paths: publicPaths } : {}),
      } as NormalizedSiteSpec;
    } else if (publicPaths) {
      normalized.site = { public_paths: publicPaths } as NormalizedSiteSpec;
    }
  }

  // v1.48 unified-apply: asset slice normalization. Mirrors the site
  // branch — for each `put` entry with a `source`, hash the bytes and
  // register a byte-reader; emit the wire-shaped `AssetPutEntry[]`.
  // Cross-kind SHA dedup is automatic via the shared `byteReaders` map.
  if (spec.assets) {
    normalized.assets = await normalizeAssetSlice(spec.assets, rememberAsset);
  }

  return { normalized, byteReaders };
}

async function normalizeFunctionMap(
  map: Record<string, FunctionSpecInput>,
  remember: (r: ResolvedContent) => ContentRef,
): Promise<Record<string, NormalizedFunctionSpec>> {
  const out: Record<string, NormalizedFunctionSpec> = {};
  for (const [name, fn] of Object.entries(map)) {
    out[name] = await normalizeFunction(fn, remember);
  }
  return out;
}

type FunctionSpecInput = NonNullable<
  NonNullable<ReleaseSpec["functions"]>["replace"]
>[string];

async function normalizeFunction(
  fn: FunctionSpecInput,
  remember: (r: ResolvedContent) => ContentRef,
): Promise<NormalizedFunctionSpec> {
  const out: NormalizedFunctionSpec = {
    runtime: fn.runtime ?? "node22",
  };
  if (fn.config) out.config = fn.config;
  if (fn.deps !== undefined) out.deps = fn.deps;
  if (fn.schedule !== undefined) out.schedule = fn.schedule;
  if (fn.entrypoint) out.entrypoint = fn.entrypoint;
  if (fn.requireAuth !== undefined) out.requireAuth = fn.requireAuth;
  if (fn.requireRole !== undefined) out.requireRole = fn.requireRole;
  if (fn.class !== undefined) out.class = fn.class;
  if (fn.capabilities !== undefined) out.capabilities = [...fn.capabilities];

  if (fn.source !== undefined) {
    const resolved = await resolveContent(fn.source, "function source");
    out.source = remember(resolved);
  }
  if (fn.files) {
    out.files = await normalizeFileSet(fn.files, remember);
  }
  return out;
}

async function normalizeFileSet(
  set: FileSet | LocalDirRef,
  remember: (r: ResolvedContent) => ContentRef,
): Promise<Record<string, ContentRef>> {
  // `dir(path)` produces a LocalDirRef sentinel that is documented as a
  // valid site.replace / site.patch.put input. Expand it to a plain FileSet
  // before iterating — otherwise Object.entries would walk the sentinel's
  // own keys (__source, path, prefix, ignore, …) and feed each value to
  // resolveContent, throwing "Unsupported byte source for prefix" on the
  // first `undefined` option (kychee-com/run402-private#409).
  const fileSet = isLocalDirRef(set) ? await expandLocalDirRef(set) : set;
  const out: Record<string, ContentRef> = {};
  for (const [path, source] of Object.entries(fileSet)) {
    const resolved = await resolveContent(source, path);
    if (!resolved.ref.contentType) {
      resolved.ref.contentType = guessContentType(path);
    }
    out[path] = remember(resolved);
  }
  return out;
}

function isLocalDirRef(source: unknown): source is LocalDirRef {
  return (
    typeof source === "object" &&
    source !== null &&
    (source as { __source?: unknown }).__source === "local-dir" &&
    typeof (source as { path?: unknown }).path === "string"
  );
}

async function expandLocalDirRef(ref: LocalDirRef): Promise<FileSet> {
  // Lazy import — keeps the root SDK V8-isolate-safe. The site slice's
  // LocalDirRef branch is Node-only by construction (the walker reads
  // from disk).
  let walker: typeof import("../node/files.js");
  try {
    walker = (await import("../node/files.js")) as typeof import("../node/files.js");
  } catch {
    throw new Run402DeployError(
      "site dir() is only supported in Node runtimes (received a LocalDirRef in a non-Node environment)",
      {
        code: "INVALID_SPEC",
        resource: "site.replace",
        retryable: false,
        context: "normalizing byte sources",
      },
    );
  }
  const fileSet = await walker.fileSetFromDir(ref.path, {
    ignore: ref.ignore,
    includeSensitive: ref.includeSensitive,
  });
  if (!ref.prefix) return fileSet;
  const prefixed: Record<string, FileSet[string]> = {};
  const sep = ref.prefix.endsWith("/") ? "" : "/";
  for (const [relPath, source] of Object.entries(fileSet)) {
    prefixed[`${ref.prefix}${sep}${relPath}`] = source;
  }
  return prefixed;
}

// ─── Asset manifest assembly from plan response (v1.48 unified-apply) ───────

/**
 * Build a {@link AssetManifest} from the plan response's `asset_entries[]`
 * array. Each entry's `asset_ref` carries gateway-authoritative URLs that
 * mirror the AssetRef envelope `Assets.put` returns for the single-entry
 * case. Keys are stored in null-prototype objects (design D9) so
 * attacker-controlled or filesystem-derived keys (`__proto__`,
 * `constructor`, `toString`) don't collide with prototype properties.
 *
 * Totals are derived from the plan response's per-entry `status`:
 *   - `"upload_pending"` → bytes_uploaded (the SDK is about to PUT these to S3)
 *   - `"present"` or `"satisfied_by_plan"` → bytes_reused (already in CAS,
 *     dedup hit either project-locally or via a same-spec sibling)
 * `duration_ms` is filled in by `manifestFromResult` at the NodeAssets layer.
 */
function buildAssetManifestFromPlanEntries(
  entries: NonNullable<PlanResponse["asset_entries"]>,
): NonNullable<DeployResult["assets"]> {
  const list: NonNullable<DeployResult["assets"]>["list"] = [];
  const byKey: NonNullable<DeployResult["assets"]>["byKey"] = Object.create(null);
  const manifest: NonNullable<DeployResult["assets"]>["manifest"] = Object.create(null);
  let bytesUploaded = 0;
  let bytesReused = 0;
  for (const entry of entries) {
    const ref = entry.asset_ref;
    const e: NonNullable<DeployResult["assets"]>["list"][number] = {
      key: entry.key,
      sha256: entry.sha256,
      size_bytes: entry.size_bytes,
      content_type: entry.content_type,
      visibility: entry.visibility,
      url: ref.url,
      immutable_url: ref.immutable_url,
      cdn_url: ref.cdn_url,
      cdn_immutable_url: ref.cdn_immutable_url,
      sri: ref.sri,
      etag: ref.etag,
      content_digest: ref.content_digest,
    };
    // v1.49+ image-variant pass-through. Only emitted when the gateway
    // returned them (image MIMEs ≥320×320; HEIC/HEIF sources also include
    // `display_jpeg`). Pre-v1.49 plan responses omit these fields entirely
    // and the manifest entry stays bytewise-identical to before.
    if (ref.width_px !== undefined) e.width_px = ref.width_px;
    if (ref.height_px !== undefined) e.height_px = ref.height_px;
    if (ref.blurhash !== undefined) e.blurhash = ref.blurhash;
    if (ref.variant_spec_version !== undefined) {
      e.variant_spec_version = ref.variant_spec_version;
    }
    if (ref.display_url !== undefined) e.display_url = ref.display_url;
    if (ref.display_immutable_url !== undefined) {
      e.display_immutable_url = ref.display_immutable_url;
    }
    if (ref.variants !== undefined) e.variants = ref.variants;
    // v1.50 pass-through: metadata + EXIF policy + image intrinsics.
    // Pre-v1.50 plan responses omit them; the manifest entry stays
    // bytewise-identical to before for older gateways.
    if (ref.metadata !== undefined) e.metadata = ref.metadata;
    if (ref.image_format !== undefined) e.image_format = ref.image_format;
    if (ref.image_info !== undefined) e.image_info = ref.image_info;
    if (ref.image_exif !== undefined) e.image_exif = ref.image_exif;
    if (ref.image_exif_policy !== undefined) e.image_exif_policy = ref.image_exif_policy;
    // v1.54 pass-through: shape-contract fields. Pre-v1.54 plan responses
    // omit them; the manifest entry stays bytewise-identical to before.
    if (ref.blurhash_data_url !== undefined) e.blurhash_data_url = ref.blurhash_data_url;
    if (ref.asset_schema !== undefined) e.asset_schema = ref.asset_schema;
    list.push(e);
    byKey[entry.key] = e;
    manifest[entry.key] = e;
    if (entry.status === "upload_pending") {
      bytesUploaded += entry.size_bytes;
    } else {
      // "present" or "satisfied_by_plan" — already in CAS or covered by a sibling.
      bytesReused += entry.size_bytes;
    }
  }
  return {
    list,
    byKey,
    manifest,
    totals: {
      files: entries.length,
      bytes_uploaded: bytesUploaded,
      bytes_reused: bytesReused,
      duration_ms: 0,
    },
  };
}

// ─── Asset slice normalization (v1.48 unified-apply) ─────────────────────────

/**
 * Type guard: distinguish the SDK-input shape (`AssetPutEntryInput` with
 * `source: ContentSource`) from the wire shape (`AssetPutEntry` with
 * `sha256` already computed). The two forms can be mixed in the same
 * `assets.put` array — the normalizer handles both branches.
 */
function isAssetPutEntryInput(
  entry: AssetPutEntry | AssetPutEntryInput,
): entry is AssetPutEntryInput {
  return (
    typeof (entry as AssetPutEntryInput).source !== "undefined" &&
    typeof (entry as AssetPutEntry).sha256 === "undefined"
  );
}

/**
 * Normalize the assets slice per design D3 (three-schema fidelity). For
 * each `put` entry:
 *
 * 1. If it's an `AssetPutEntryInput` (has `source`): call `resolveContent`
 *    to hash the bytes, register a byte-reader via `remember()`, and emit
 *    a wire-shaped `AssetPutEntry` (no `source` field).
 * 2. If it's already an `AssetPutEntry` (has `sha256`): pass through.
 *
 * Validates per-spec invariants before any network call: duplicate keys
 * in `put`, key in both `put` and `delete`, empty manifest (only the
 * assets slice was set and it had no `put`/`delete`/`sync` content).
 *
 * `spec.assets.delete` and `spec.assets.sync` pass through unchanged.
 */
async function normalizeAssetSlice(
  slice: AssetSpec,
  remember: (r: ResolvedContent) => ContentRef,
): Promise<NormalizedAssetSpec> {
  const out: NormalizedAssetSpec = {};

  if (slice.put && slice.put.length > 0) {
    const seenKeys = new Set<string>();
    const put: AssetPutEntry[] = [];
    for (let idx = 0; idx < slice.put.length; idx++) {
      const entry = slice.put[idx]!;
      if (!entry.key || typeof entry.key !== "string") {
        throw new Run402DeployError(
          `assets.put[${idx}] missing required \`key\``,
          {
            code: "INVALID_SPEC",
            phase: "validate",
            resource: `assets.put[${idx}]`,
            retryable: false,
            fix: { action: "set_field", path: `assets.put[${idx}].key` },
            context: "validating spec",
          },
        );
      }
      if (seenKeys.has(entry.key)) {
        throw new Run402DeployError(
          `assets.put contains duplicate key \`${entry.key}\``,
          {
            code: "ASSET_DUPLICATE_KEY_IN_PUT",
            phase: "validate",
            resource: `assets.put[${idx}]`,
            retryable: false,
            fix: { action: "set_field", path: `assets.put[${idx}].key` },
            context: "validating spec",
          },
        );
      }
      seenKeys.add(entry.key);

      // v1.50: validate caller-supplied metadata / EXIF policy on BOTH
      // shapes BEFORE any HTTP traffic. Throws LocalError with the
      // canonical gateway code (INVALID_ASSET_METADATA / INVALID_EXIF_
      // POLICY) so consumers see the same `e.code` whether the rejection
      // was local or remote.
      const inputShape = isAssetPutEntryInput(entry) ? entry : null;
      const wireShape = inputShape ? null : (entry as AssetPutEntry);
      const callerMetadata = inputShape?.metadata ?? wireShape?.metadata;
      const callerExifPolicy = inputShape?.exifPolicy ?? wireShape?.exif_policy;
      if (callerMetadata !== undefined) {
        assertAssetMetadata(callerMetadata, "validating asset metadata");
      }
      if (callerExifPolicy !== undefined) {
        assertExifPolicy(callerExifPolicy, "validating asset EXIF policy");
      }

      if (inputShape) {
        const label = `assets.put[${idx}] (${inputShape.key})`;
        const resolved = await resolveContent(inputShape.source, label);
        if (!resolved.ref.contentType) {
          resolved.ref.contentType = inputShape.content_type ?? guessContentType(inputShape.key);
        }
        const ref = remember(resolved);
        put.push({
          key: inputShape.key,
          sha256: ref.sha256,
          size_bytes: ref.size,
          content_type: inputShape.content_type ?? ref.contentType ?? "application/octet-stream",
          visibility: inputShape.visibility ?? "public",
          immutable: inputShape.immutable ?? true,
          // v1.50: thread metadata + exif_policy onto the wire-shape. The
          // SDK input field is camelCase (`exifPolicy`); the wire field is
          // snake_case (`exif_policy`).
          ...(inputShape.metadata !== undefined ? { metadata: inputShape.metadata } : {}),
          ...(inputShape.exifPolicy !== undefined ? { exif_policy: inputShape.exifPolicy } : {}),
        });
      } else {
        // Wire-shaped entry — pass through verbatim. The caller is
        // responsible for ensuring the bytes are already in CAS (or will
        // be uploaded out-of-band).
        const w = wireShape as AssetPutEntry;
        put.push({
          key: w.key,
          sha256: w.sha256,
          size_bytes: w.size_bytes,
          content_type: w.content_type ?? "application/octet-stream",
          visibility: w.visibility ?? "public",
          immutable: w.immutable ?? true,
          // v1.50 wire-shape passthrough (no camelCase conversion needed).
          ...(w.metadata !== undefined ? { metadata: w.metadata } : {}),
          ...(w.exif_policy !== undefined ? { exif_policy: w.exif_policy } : {}),
        });
      }
    }
    out.put = put;
  }

  if (slice.delete && slice.delete.length > 0) {
    out.delete = [...slice.delete];
  }

  // Cross-slice invariant: a key may not be both `put` and `delete`-d.
  if (out.put && out.delete) {
    const putKeys = new Set(out.put.map((e) => e.key));
    for (const k of out.delete) {
      if (putKeys.has(k)) {
        throw new Run402DeployError(
          `assets.put and assets.delete both reference key \`${k}\``,
          {
            code: "ASSET_KEY_IN_PUT_AND_DELETE",
            phase: "validate",
            resource: `assets`,
            retryable: false,
            fix: { action: "remove_field", path: `assets.delete[\`${k}\`]` },
            context: "validating spec",
          },
        );
      }
    }
  }

  if (slice.sync) {
    out.sync = {
      prefix: slice.sync.prefix,
      prune: slice.sync.prune,
      ...(slice.sync.confirm ? { confirm: slice.sync.confirm } : {}),
    };
  }

  return out;
}

type MigrationSpecInput = NonNullable<
  NonNullable<ReleaseSpec["database"]>["migrations"]
>[number];

async function normalizeMigration(
  client: Client,
  projectId: string,
  m: MigrationSpecInput,
  remember: (r: ResolvedContent) => ContentRef,
  opts: { inlineMigrationSql?: boolean } = {},
): Promise<NormalizedMigrationSpec> {
  if (!m.id) {
    throw new Run402DeployError("MigrationSpec.id is required", {
      code: "INVALID_SPEC",
      phase: "validate",
      resource: "database.migrations",
      retryable: false,
      fix: { action: "set_field", path: "database.migrations[].id" },
      context: "validating spec",
    });
  }

  let sql_ref: ContentRef | undefined;
  let sql: string | undefined;
  let checksum: string;
  if (m.sql_ref) {
    sql_ref = m.sql_ref;
    checksum = m.checksum ?? m.sql_ref.sha256;
  } else if (m.sql !== undefined) {
    const bytes = new TextEncoder().encode(m.sql);
    const sha256 = await sha256Hex(bytes);
    if (opts.inlineMigrationSql) {
      sql = m.sql;
    } else {
      const ref: ContentRef = { sha256, size: bytes.byteLength, contentType: "application/sql" };
      remember({ ref, reader: makeBytesReader(bytes, `migration:${m.id}`) });
      sql_ref = ref;
    }
    checksum = m.checksum ?? sha256;
  } else {
    throw new Run402DeployError(
      `MigrationSpec ${m.id} must include sql or sql_ref`,
      {
        code: "INVALID_SPEC",
        phase: "validate",
        resource: `database.migrations.${m.id}`,
        retryable: false,
        fix: {
          action: "set_field",
          path: `database.migrations.${m.id}.sql`,
        },
        context: "validating spec",
      },
    );
  }

  const out: NormalizedMigrationSpec = { id: m.id, checksum };
  if (sql_ref) out.sql_ref = sql_ref;
  if (sql !== undefined) out.sql = sql;
  if (m.transaction) out.transaction = m.transaction;
  return out;
  // projectId / client params reserved for future content-presence preflight.
  void client;
  void projectId;
}

// ─── Content source resolution ───────────────────────────────────────────────

async function resolveContent(
  source: ContentSource,
  label: string,
): Promise<ResolvedContent> {
  // Pre-resolved ContentRef — pass through, no reader needed (caller is
  // responsible for ensuring the bytes are already in CAS).
  if (isContentRef(source)) {
    return {
      ref: { ...source },
      reader: makeUnreadableReader(source.sha256, label),
    };
  }

  // { data, contentType } wrapper — recurse into data, override contentType.
  if (
    typeof source === "object" &&
    source !== null &&
    !Array.isArray(source) &&
    !(source instanceof Uint8Array) &&
    !(source instanceof ArrayBuffer) &&
    !(typeof Blob !== "undefined" && source instanceof Blob) &&
    !isReadableStream(source) &&
    !isFsFileSource(source) &&
    "data" in source
  ) {
    const inner = await resolveContent((source as { data: ContentSource }).data, label);
    if ((source as { contentType?: string }).contentType) {
      inner.ref.contentType = (source as { contentType?: string }).contentType;
    }
    return inner;
  }

  if (isFsFileSource(source)) {
    return await resolveFsFile(source, label);
  }

  if (typeof source === "string") {
    const bytes = new TextEncoder().encode(source);
    return makeMemResolved(bytes, undefined, label);
  }

  if (source instanceof Uint8Array) {
    return makeMemResolved(source, undefined, label);
  }

  if (source instanceof ArrayBuffer) {
    return makeMemResolved(new Uint8Array(source), undefined, label);
  }

  if (typeof Blob !== "undefined" && source instanceof Blob) {
    const bytes = new Uint8Array(await source.arrayBuffer());
    const ct = source.type && source.type.length > 0 ? source.type : undefined;
    return makeMemResolved(bytes, ct, label);
  }

  if (isReadableStream(source)) {
    const bytes = await readStreamFully(source);
    return makeMemResolved(bytes, undefined, label);
  }

  throw new Run402DeployError(
    `Unsupported byte source for ${label}`,
    {
      code: "INVALID_SPEC",
      resource: label,
      retryable: false,
      context: "normalizing byte sources",
    },
  );
}

async function makeMemResolved(
  bytes: Uint8Array,
  contentType: string | undefined,
  label: string,
): Promise<ResolvedContent> {
  const sha256 = await sha256Hex(bytes);
  const ref: ContentRef = { sha256, size: bytes.byteLength };
  if (contentType) ref.contentType = contentType;
  return { ref, reader: makeBytesReader(bytes, label) };
}

async function resolveFsFile(
  source: FsFileSource,
  label: string,
): Promise<ResolvedContent> {
  // Lazy import — keeps the root SDK V8-isolate-safe. fileSetFromDir lives
  // in `@run402/sdk/node`, so any `FsFileSource` we see here must be in a
  // Node runtime where `node:fs/promises` resolves.
  let fsMod: typeof import("node:fs/promises");
  try {
    fsMod = (await import("node:fs/promises")) as typeof import("node:fs/promises");
  } catch {
    throw new Run402DeployError(
      "FsFileSource is only supported in Node runtimes (received in a non-Node environment)",
      {
        code: "INVALID_SPEC",
        resource: label,
        retryable: false,
        context: "normalizing byte sources",
      },
    );
  }
  const buf = await fsMod.readFile(source.path);
  const bytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  const sha256 = await sha256Hex(bytes);
  const ref: ContentRef = { sha256, size: bytes.byteLength };
  if (source.contentType) ref.contentType = source.contentType;
  return {
    ref,
    reader: Object.assign(
      async () => {
        const buf2 = await fsMod.readFile(source.path);
        return new Uint8Array(buf2.buffer, buf2.byteOffset, buf2.byteLength);
      },
      { label },
    ),
  };
}

function makeBytesReader(
  bytes: Uint8Array,
  label: string,
  contentType?: string,
): ByteReader {
  const reader: ByteReader = async () => bytes;
  reader.label = label;
  if (contentType) reader.contentType = contentType;
  return reader;
}

function makeUnreadableReader(sha256: string, label: string): ByteReader {
  const reader: ByteReader = async () => {
    throw new Run402DeployError(
      `ContentRef ${sha256.slice(0, 12)}… was passed pre-resolved but the gateway reports it missing — provide bytes inline instead`,
      {
        code: "CONTENT_UPLOAD_FAILED",
        resource: label,
        retryable: false,
        context: "uploading deploy bytes",
      },
    );
  };
  reader.label = label;
  return reader;
}

// ─── Manifest-ref CAS upload (bypasses the upload phase loop) ────────────────

async function uploadInlineCas(
  client: Client,
  projectId: string,
  bytes: Uint8Array,
  contentType: string,
): Promise<ContentRef> {
  const sha256 = await sha256Hex(bytes);
  const headers = await apikeyHeaders(client, projectId);
  const planRes = await client.request<ContentPlanResponse>("/content/v1/plans", {
    method: "POST",
    headers,
    body: {
      content: [{ sha256, size: bytes.byteLength, content_type: contentType }],
    },
    context: "planning content upload",
  });
  if (planRes.missing.length > 0) {
    const session = planRes.missing[0];
    await uploadOne(client.fetch, session, bytes);
    // v1.48 unified-apply: per-session /storage/v1/uploads/:id/complete is
    // gone (404). The plan-level commit below promotes the session to CAS.
    await client.request<unknown>(
      `/content/v1/plans/${encodeURIComponent(planRes.plan_id)}/commit`,
      { method: "POST", headers, body: {}, context: "committing content upload" },
    );
  }
  return { sha256, size: bytes.byteLength, contentType };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Build the apikey header set for a project. The v1.34 gateway's
 * `/apply/v1/operations/:operation_id*` and `/content/v1/plans*` routes require
 * `apikey: <project.anon_key>` (apikeyAuth middleware). Plan + commit on
 * `/apply/v1/plans*` use SIWX, which the kernel's getAuth provides
 * automatically — only the apikey-gated paths need this helper.
 *
 * Returns an empty object when the credentials provider doesn't know the
 * project (the request will then go out without an apikey and the gateway
 * will reject with 401 — matches the failure mode for unconfigured
 * projects in any of today's other apikey-auth tools).
 */
async function apikeyHeaders(
  client: Client,
  projectId: string,
): Promise<Record<string, string>> {
  if (isCiClient(client)) return {};
  const project = await client.getProject(projectId);
  if (!project) return {};
  return { apikey: project.anon_key };
}

function isCiClient(client: Client): boolean {
  return isCiSessionCredentials(client.credentials);
}

function makeEmitter(
  cb: ((event: DeployEvent) => void) | undefined,
): (event: DeployEvent) => void {
  if (!cb) return () => {};
  return (event) => {
    try {
      cb(event);
    } catch {
      /* swallow */
    }
  };
}

function isContentRef(source: unknown): source is ContentRef {
  return (
    typeof source === "object" &&
    source !== null &&
    typeof (source as { sha256?: unknown }).sha256 === "string" &&
    typeof (source as { size?: unknown }).size === "number" &&
    !("data" in (source as Record<string, unknown>)) &&
    !("__source" in (source as Record<string, unknown>))
  );
}

function isFsFileSource(source: unknown): source is FsFileSource {
  return (
    typeof source === "object" &&
    source !== null &&
    (source as { __source?: unknown }).__source === "fs-file" &&
    typeof (source as { path?: unknown }).path === "string"
  );
}

function isReadableStream(source: unknown): source is ReadableStream<Uint8Array> {
  return (
    typeof source === "object" &&
    source !== null &&
    typeof (source as { getReader?: unknown }).getReader === "function" &&
    typeof (source as { tee?: unknown }).tee === "function"
  );
}

async function readStreamFully(
  stream: ReadableStream<Uint8Array>,
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      total += value.byteLength;
    }
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", bytes as unknown as BufferSource);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function sha256Base64(bytes: Uint8Array): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", bytes as unknown as BufferSource);
  return base64FromBytes(new Uint8Array(buf));
}

function base64FromHex(hex: string): string {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.byteLength; i++) {
    bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return base64FromBytes(bytes);
}

function base64FromBytes(bytes: Uint8Array): string {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(bytes).toString("base64");
  }
  let bin = "";
  for (let i = 0; i < bytes.byteLength; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const CONTENT_TYPE_BY_EXT: Record<string, string> = {
  html: "text/html; charset=utf-8",
  htm: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  cjs: "text/javascript; charset=utf-8",
  json: "application/json",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  ico: "image/x-icon",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
  txt: "text/plain; charset=utf-8",
  md: "text/markdown; charset=utf-8",
  xml: "application/xml",
  pdf: "application/pdf",
  wasm: "application/wasm",
  sql: "application/sql",
};

function guessContentType(path: string): string {
  const ix = path.lastIndexOf(".");
  if (ix < 0) return "application/octet-stream";
  const ext = path.slice(ix + 1).toLowerCase();
  return CONTENT_TYPE_BY_EXT[ext] ?? "application/octet-stream";
}

// ─── Error translation ──────────────────────────────────────────────────────

function translateDeployError(
  err: unknown,
  phase: string,
  planId: string | null,
  operationId: string | null,
): Run402DeployError {
  if (err instanceof Run402DeployError) return err;
  if (err instanceof ApiError) {
    const body =
      err.body && typeof err.body === "object"
        ? (err.body as Record<string, unknown>)
        : null;
    const gw = body && typeof body === "object" ? extractGatewayError(body) : null;
    if (gw) {
      return translateGatewayError(gw, phase, planId, operationId);
    }
    return new Run402DeployError(err.message, {
      code: "INTERNAL_ERROR",
      phase,
      retryable: err.status !== null && err.status >= 500,
      operationId,
      planId,
      status: err.status,
      body: err.body,
      context: err.context,
    });
  }
  // 409 transfer-freeze (PROJECT_HAS_PENDING_TRANSFER) arrives as a dedicated
  // TransferFreezeError, not an ApiError. Route it through the same
  // gateway-envelope path so the structured code, details (transfer_id), and
  // next_actions (cancel/view transfer) survive instead of flattening to
  // INTERNAL_ERROR. Use the structural guard so the check holds across
  // duplicate SDK copies / realm boundaries (V8-isolate code-mode).
  if (isTransferFreezeError(err)) {
    const body =
      err.body && typeof err.body === "object" && !Array.isArray(err.body)
        ? (err.body as Record<string, unknown>)
        : null;
    const gw = body ? extractGatewayError(body) : null;
    if (gw) {
      return translateGatewayError(gw, phase, planId, operationId);
    }
    return new Run402DeployError(err.message, {
      code: "PROJECT_HAS_PENDING_TRANSFER" as Run402DeployErrorCode,
      phase,
      retryable: false,
      operationId,
      planId,
      status: err.status,
      body: err.body,
      context: err.context,
    });
  }
  if (err instanceof NetworkError) {
    return new Run402DeployError(err.message, {
      code: "NETWORK_ERROR",
      phase,
      retryable: true,
      operationId,
      planId,
      context: phase,
    });
  }
  // Re-throw other Run402Error subclasses (PaymentRequired, Unauthorized, etc.)
  // as-is — the consumer handles them at a different layer than
  // deploy-state-machine errors.
  if (err instanceof PaymentRequired || err instanceof Unauthorized) {
    throw err;
  }
  if (err instanceof Error) {
    return new Run402DeployError(err.message, {
      code: "INTERNAL_ERROR",
      phase,
      retryable: false,
      operationId,
      planId,
      context: phase,
    });
  }
  return new Run402DeployError(String(err), {
    code: "INTERNAL_ERROR",
    phase,
    retryable: false,
    operationId,
    planId,
    context: phase,
  });
}

function extractGatewayError(
  body: Record<string, unknown>,
): GatewayDeployError | null {
  // Gateway returns the error in any of:
  //   { error: { code, message?, phase?, ... } }       — nested
  //   { code, message?, phase?, ... }                  — top-level
  //   { error: "<message>", code: "..." }              — older shape, error as string
  // The only required field is `code`; `message` is convenient but
  // optional (some gateway routes return just a code on simple validation
  // failures, e.g. `{code: "invalid_spec"}`).
  if (
    body.error &&
    typeof body.error === "object" &&
    typeof (body.error as { code?: unknown }).code === "string"
  ) {
    const nested = body.error as GatewayDeployError;
    return {
      ...nested,
      category: nested.category ?? stringField(body, "category"),
      retryable: nested.retryable ?? booleanField(body, "retryable"),
      safe_to_retry: nested.safe_to_retry ?? booleanField(body, "safe_to_retry"),
      mutation_state: nested.mutation_state ?? stringField(body, "mutation_state"),
      trace_id: nested.trace_id ?? stringField(body, "trace_id"),
      details: nested.details ?? objectField(body, "details"),
      next_actions: nested.next_actions ?? arrayField(body, "next_actions"),
    };
  }
  if (typeof body.code === "string") {
    const details = objectField(body, "details");
    const out: GatewayDeployError = { code: body.code };
    if (typeof body.message === "string") {
      out.message = body.message;
    } else if (typeof body.error === "string") {
      out.message = body.error;
    } else if (typeof details?.message === "string") {
      out.message = details.message;
    } else {
      out.message = `Deploy error: ${body.code}`;
    }
    const phase = stringField(body, "phase") ?? stringField(details, "phase");
    const resource = stringField(body, "resource") ?? stringField(details, "resource");
    const retryable = booleanField(body, "retryable") ?? booleanField(details, "retryable");
    const rolledBack = booleanField(body, "rolled_back") ?? booleanField(details, "rolled_back");
    const operationId = stringField(body, "operation_id") ?? stringField(details, "operation_id");
    const planId = stringField(body, "plan_id") ?? stringField(details, "plan_id");
    const fix = body.fix !== undefined ? body.fix : details?.fix;
    const logs = arrayField(body, "logs") ?? arrayField(details, "logs");
    if (phase !== undefined) out.phase = phase;
    if (resource !== undefined) out.resource = resource;
    if (retryable !== undefined) out.retryable = retryable;
    if (typeof body.category === "string") out.category = body.category;
    if (typeof body.safe_to_retry === "boolean") out.safe_to_retry = body.safe_to_retry;
    if (typeof body.mutation_state === "string") out.mutation_state = body.mutation_state;
    if (typeof body.trace_id === "string") out.trace_id = body.trace_id;
    if (details !== null) out.details = details;
    if (Array.isArray(body.next_actions)) out.next_actions = body.next_actions;
    if (fix !== undefined) out.fix = fix as GatewayDeployError["fix"];
    if (logs !== undefined) out.logs = logs as string[];
    if (rolledBack !== undefined) out.rolled_back = rolledBack;
    if (operationId !== undefined) out.operation_id = operationId;
    if (planId !== undefined) out.plan_id = planId;
    out.source_body = body;
    return out;
  }
  return null;
}

function stringField(obj: unknown, key: string): string | undefined {
  return obj && typeof obj === "object" && typeof (obj as Record<string, unknown>)[key] === "string"
    ? ((obj as Record<string, unknown>)[key] as string)
    : undefined;
}

function booleanField(obj: unknown, key: string): boolean | undefined {
  return obj && typeof obj === "object" && typeof (obj as Record<string, unknown>)[key] === "boolean"
    ? ((obj as Record<string, unknown>)[key] as boolean)
    : undefined;
}

function objectField(obj: unknown, key: string): Record<string, unknown> | null {
  const value =
    obj && typeof obj === "object" ? (obj as Record<string, unknown>)[key] : undefined;
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function arrayField(obj: unknown, key: string): unknown[] | undefined {
  const value =
    obj && typeof obj === "object" ? (obj as Record<string, unknown>)[key] : undefined;
  return Array.isArray(value) ? value : undefined;
}

function translateGatewayError(
  gw: GatewayDeployError | null | undefined,
  phase: string,
  planId: string | null,
  operationId: string | null,
): Run402DeployError {
  if (!gw) {
    return new Run402DeployError("Deploy failed without a structured error", {
      code: "INTERNAL_ERROR",
      phase,
      retryable: false,
      operationId,
      planId,
      context: phase,
    });
  }
  // Normalize the gateway code to the SCREAMING_SNAKE_CASE convention used
  // by `Run402DeployErrorCode`. Some gateway routes return lowercase
  // (`operation_not_found`) while services return uppercase
  // (`OPERATION_NOT_FOUND`); consumers expect the canonical uppercase form.
  const normalizedCode = gw.code.toUpperCase() as Run402DeployErrorCode;
  // Prefer body-supplied ids — the gateway is the authoritative source for
  // which operation/plan an error belongs to. The caller-provided arguments
  // are only used as a fallback (e.g., commit failures where the call site
  // already knows the plan id but the body omits it).
  const details = objectField(gw, "details");
  const opId =
    (gw && (gw as { operation_id?: string }).operation_id) ??
    stringField(details, "operation_id") ??
    operationId;
  const pId =
    (gw && (gw as { plan_id?: string }).plan_id) ??
    stringField(details, "plan_id") ??
    planId;
  const body = (gw as { source_body?: unknown }).source_body ?? gw;
  const fix = (gw.fix ?? details?.fix ?? null) as Run402DeployErrorFix | null;
  const logs = (gw.logs ?? arrayField(details, "logs") ?? null) as string[] | null;
  return new Run402DeployError(gw.message ?? `Deploy failed: ${gw.code}`, {
    code: normalizedCode,
    phase: gw.phase ?? stringField(details, "phase") ?? phase,
    resource: gw.resource ?? stringField(details, "resource") ?? null,
    retryable: gw.retryable ?? false,
    operationId: opId,
    planId: pId,
    fix,
    logs,
    rolledBack: gw.rolled_back ?? booleanField(details, "rolled_back") ?? false,
    body,
    context: phase,
  });
}
