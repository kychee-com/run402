/**
 * `deploy` namespace — the canonical unified deploy primitive.
 *
 * Three layers exposed:
 *   - `apply(spec, opts?)`  — one-shot, awaits to completion or terminal failure.
 *   - `start(spec, opts?)`  — returns a `DeployOperation` with `events()` + `result()`.
 *   - `plan` / `upload` / `commit` — low-level steps for CLI and tests.
 *
 * All bytes ride through the CAS content service via presigned PUTs to S3.
 * The wire body to `POST /deploy/v2/plans` carries `ContentRef` objects only —
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
  type Run402DeployErrorCode,
  type Run402DeployErrorFix,
} from "../errors.js";
import type {
  ApplyOptions,
  ActiveReleaseInventory,
  CommitResponse,
  ContentPlanResponse,
  ContentRef,
  ContentSource,
  DeployEvent,
  DeployEventsResponse,
  DeployDiff,
  DeployListResponse,
  DeployOperation,
  DeployResult,
  DeployResolveOptions,
  DeployResolveResponse,
  FileSet,
  FsFileSource,
  GatewayDeployError,
  MissingContent,
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
  ReleaseDiffOptions,
  ReleaseInventory,
  ReleaseInventoryByIdOptions,
  ReleaseInventoryOptions,
  ReleaseSpec,
  ReleaseToReleaseDiff,
  StartOptions,
  WarningEntry,
} from "./deploy.types.js";

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

const MANIFEST_CONTENT_TYPE =
  "application/vnd.run402.deploy-manifest+json";

const TERMINAL_STATUSES: OperationStatus[] = [
  "ready",
  "failed",
  "rolled_back",
  "needs_repair",
];
const SUCCESS_STATUS: OperationStatus = "ready";

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
   * the inline limit, and call `POST /deploy/v2/plans`. Returns the plan
   * response and a byte-reader map keyed by sha256 (used by `upload`).
   */
  async plan(
    spec: ReleaseSpec,
    opts: { idempotencyKey?: string; dryRun?: boolean } = {},
  ): Promise<{ plan: PlanResponse; byteReaders: Map<string, ByteReader> }> {
    return planInternal(this.client, spec, opts.idempotencyKey, opts.dryRun);
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
   * Low-level commit: `POST /deploy/v2/plans/:id/commit`, then poll
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
    } = {},
  ): Promise<DeployResult> {
    const emit = makeEmitter(opts.onEvent);
    const commit = await commitInternal(this.client, planId, opts.idempotencyKey);
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
        `/deploy/v2/operations/${encodeURIComponent(operationId)}/resume`,
        { method: "POST", context: "resuming deploy operation" },
      );
    } catch (err) {
      throw translateDeployError(err, "resume", null, operationId);
    }
    return await pollSnapshotUntilReady(this.client, snapshot, {}, [], emit, opts.project);
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
    const headers = opts.project ? await apikeyHeaders(this.client, opts.project) : {};
    return this.client.request<OperationSnapshot>(
      `/deploy/v2/operations/${operationId}`,
      { headers, context: "fetching deploy operation" },
    );
  }

  /**
   * List recent deploy operations for a project. The endpoint requires
   * `apikey` auth, so a project id is required — accepted as a bare string
   * (matches `r.functions.list(projectId)` and friends) or as `{ project,
   * limit? }`. `limit` is forwarded to the gateway as a query string when
   * set; the gateway picks a default otherwise.
   */
  async list(
    opts: string | { project: string; limit?: number },
  ): Promise<DeployListResponse> {
    const project = typeof opts === "string" ? opts : opts?.project;
    const limit = typeof opts === "string" ? undefined : opts?.limit;
    if (!project) {
      throw new LocalError(
        "r.deploy.list requires a project id (as a string or { project: 'prj_...' })",
        "listing deploy operations",
      );
    }
    const headers = await apikeyHeaders(this.client, project);
    const qs = new URLSearchParams();
    if (limit !== undefined) qs.set("limit", String(limit));
    const path =
      qs.toString().length > 0
        ? `/deploy/v2/operations?${qs.toString()}`
        : `/deploy/v2/operations`;
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
        `/deploy/v2/operations/${encodeURIComponent(operationId)}/events`,
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
        "r.deploy.getRelease requires a project id ({ project: 'prj_...', releaseId: 'rel_...' })",
        "fetching release inventory",
      );
    }
    if (!opts.releaseId) {
      throw new LocalError(
        "r.deploy.getRelease requires a release id",
        "fetching release inventory",
      );
    }
    const headers = await apikeyHeaders(this.client, opts.project);
    return this.client.request<ReleaseInventory>(
      appendQuery(`/deploy/v2/releases/${encodeURIComponent(opts.releaseId)}`, {
        site_limit: opts.siteLimit,
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
        "r.deploy.getActiveRelease requires a project id ({ project: 'prj_...' })",
        "fetching active release inventory",
      );
    }
    const headers = await apikeyHeaders(this.client, opts.project);
    return this.client.request<ActiveReleaseInventory>(
      appendQuery("/deploy/v2/releases/active", {
        site_limit: opts.siteLimit,
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
        "r.deploy.diff requires a project id ({ project: 'prj_...', from, to })",
        "diffing releases",
      );
    }
    const headers = await apikeyHeaders(this.client, opts.project);
    const qs = new URLSearchParams({ from: opts.from, to: opts.to });
    if (opts.limit !== undefined) qs.set("limit", String(opts.limit));
    return this.client.request<ReleaseToReleaseDiff>(
      `/deploy/v2/releases/diff?${qs.toString()}`,
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
      `/deploy/v2/resolve?${qs.toString()}`,
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

// ─── Internal pipeline ───────────────────────────────────────────────────────

async function applyOnce(
  client: Client,
  spec: ReleaseSpec,
  opts: ApplyOptions,
  emit: (event: DeployEvent) => void,
): Promise<DeployResult> {
  emit({ type: "plan.started" });
  const { plan, byteReaders } = await planInternal(client, spec, opts.idempotencyKey);
  emit({ type: "plan.diff", diff: plan.diff });
  emitPlanWarnings(plan, emit);
  abortOnConfirmationWarnings(plan, opts);

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

  await uploadMissing(client, spec.project, plan.missing_content, byteReaders, emit);

  emit({ type: "commit.phase", phase: "validate", status: "started" });
  const { planId } = requirePersistedPlan(plan, "applying deploy");
  const commit = await commitInternal(client, planId, opts.idempotencyKey);
  return await pollUntilReady(client, commit, plan.diff, plan.warnings, emit, spec.project);
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

async function planInternal(
  client: Client,
  spec: ReleaseSpec,
  idempotencyKey?: string,
  dryRun = false,
): Promise<{ plan: PlanResponse; byteReaders: Map<string, ByteReader> }> {
  const ciCredentials = isCiClient(client);
  validateSpec(spec);
  if (ciCredentials) assertCiDeployableSpec(spec);

  const { normalized, byteReaders } = await normalizeReleaseSpec(client, spec);

  // The gateway expects { spec, manifest_ref?, idempotency_key? } with
  // ReleaseSpec.project (singular). For oversized specs the SDK uploads
  // the manifest JSON to CAS first and references it; the gateway still
  // needs `spec` in the body (with at least the project), so we keep a
  // minimal stub there.
  const inlineBody: PlanRequest = { spec: normalized };
  if (idempotencyKey && !dryRun) inlineBody.idempotency_key = idempotencyKey;
  const inlineBytes = new TextEncoder().encode(JSON.stringify(inlineBody)).byteLength;

  let body: PlanRequest;
  if (inlineBytes <= PLAN_BODY_LIMIT_BYTES) {
    body = inlineBody;
  } else {
    if (dryRun) {
      throw new Run402DeployError(
        "Dry-run deploy planning requires an inline spec under the gateway body cap; the normalized deploy plan would require manifest_ref.",
        {
          code: "DRY_RUN_REQUIRES_INLINE_SPEC",
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
    const manifestBytes = new TextEncoder().encode(JSON.stringify(normalized));
    const ref = await uploadInlineCas(
      client,
      spec.project,
      manifestBytes,
      MANIFEST_CONTENT_TYPE,
    );
    body = { spec: { project: spec.project }, manifest_ref: ref };
    if (idempotencyKey) body.idempotency_key = idempotencyKey;
  }

  let plan: PlanResponse;
  try {
    plan = withClientPlanWarnings(normalized, normalizePlanResponse(await client.request<PlanResponse>(dryRun ? "/deploy/v2/plans?dry_run=true" : "/deploy/v2/plans", {
      method: "POST",
      body,
      context: "planning deploy",
    })));
  } catch (err) {
    throw translateDeployError(err, "plan", null, null);
  }
  return { plan, byteReaders };
}

async function commitInternal(
  client: Client,
  planId: string,
  idempotencyKey?: string,
): Promise<CommitResponse> {
  try {
    return await client.request<CommitResponse>(
      `/deploy/v2/plans/${encodeURIComponent(planId)}/commit`,
      {
        method: "POST",
        body: idempotencyKey ? { idempotency_key: idempotencyKey } : {},
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
    const uploadedParts = await uploadOneWithRetry(client.fetch, session, bytes);

    if (!ciCredentials) {
      // Per-session completion — legacy non-CI promotion path via
      // /storage/v1/uploads/:id/complete. CI sessions skip this route because
      // the gateway contract only allows /content/v1/plans*; under CI the
      // plan-level content commit performs the CAS promotion.
      const completeBody = uploadCompleteBody(session, uploadedParts);
      await client.request<unknown>(
        `/storage/v1/uploads/${encodeURIComponent(session.upload_id)}/complete`,
        {
          method: "POST",
          headers,
          body: completeBody,
          context: "completing content upload session",
        },
      );
    }

    done += 1;
    emit({
      type: "content.upload.progress",
      label: reader.label ?? session.sha256,
      sha256: session.sha256,
      done,
      total,
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
    emit({ type: "ready", releaseId: commit.release_id, urls: commit.urls });
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
    `/deploy/v2/operations/${encodeURIComponent(commit.operation_id)}`,
    { headers: opHeaders, context: "fetching deploy operation" },
  );
  return await pollSnapshotUntilReady(client, initialSnapshot, diff, warnings, emit, projectId);
}

async function pollSnapshotUntilReady(
  client: Client,
  initial: OperationSnapshot,
  diff: PlanResponse["diff"],
  warnings: PlanResponse["warnings"],
  emit: (event: DeployEvent) => void,
  projectId: string | undefined,
): Promise<DeployResult> {
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
    emit({ type: "commit.phase", phase: prev.phase, status: closeStatus });
  };

  while (true) {
    if (lastPhaseEmitted !== snapshot.status) {
      const ev = phaseFor(snapshot.status);
      if (ev) {
        if (ev.type === "commit.phase") closePreviousPhase(ev.phase);
        emit(ev);
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
      emit({ type: "ready", releaseId: snapshot.release_id, urls: snapshot.urls });
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
      `/deploy/v2/operations/${encodeURIComponent(snapshot.operation_id)}`,
      { headers: opHeaders, context: "polling deploy operation" },
    );
  }
}

// ─── start() implementation ──────────────────────────────────────────────────

async function startInternal(
  client: Client,
  spec: ReleaseSpec,
  opts: StartOptions,
): Promise<DeployOperation> {
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
  const { plan, byteReaders } = await planInternal(client, spec, opts.idempotencyKey);
  emit({ type: "plan.diff", diff: plan.diff });
  emitPlanWarnings(plan, emit);
  abortOnConfirmationWarnings(plan, opts);
  if (plan.payment_required) {
    emit({
      type: "payment.required",
      amount: plan.payment_required.amount,
      asset: plan.payment_required.asset,
      payTo: plan.payment_required.payTo,
      reason: plan.payment_required.reason,
    });
  }

  const resultPromise: Promise<DeployResult> = (async () => {
    await uploadMissing(client, spec.project, plan.missing_content, byteReaders, emit);
    emit({ type: "commit.phase", phase: "validate", status: "started" });
    const { planId } = requirePersistedPlan(plan, "starting deploy");
    const commit = await commitInternal(client, planId, opts.idempotencyKey);
    return await pollUntilReady(client, commit, plan.diff, plan.warnings, emit, spec.project);
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
      `/deploy/v2/operations/${encodeURIComponent(operationId)}`,
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
}

interface ResolvedContent {
  ref: ContentRef;
  reader: ByteReader;
}

const RELEASE_SPEC_FIELDS = new Set([
  "project",
  "base",
  "database",
  "secrets",
  "functions",
  "site",
  "subdomains",
  "routes",
  "checks",
]);
const DEPLOYABLE_SPEC_FIELDS = [
  "database",
  "site",
  "functions",
  "secrets",
  "subdomains",
  "routes",
  "checks",
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
  "schedule",
]);
const FUNCTION_CONFIG_FIELDS = new Set(["timeoutSeconds", "memoryMb"]);
const SITE_SPEC_FIELDS = new Set(["replace", "patch", "public_paths"]);
const SITE_PATCH_FIELDS = new Set(["put", "delete"]);
const SITE_PUBLIC_PATHS_FIELDS = new Set(["mode", "replace"]);
const PUBLIC_STATIC_PATH_FIELDS = new Set(["asset", "cache_class"]);
const SUBDOMAINS_SPEC_FIELDS = new Set(["set", "add", "remove"]);
const ROUTES_SPEC_FIELDS = new Set(["replace"]);
const ROUTE_ENTRY_FIELDS = new Set(["pattern", "methods", "target"]);
const FUNCTION_ROUTE_TARGET_FIELDS = new Set(["type", "name"]);
const STATIC_ROUTE_TARGET_FIELDS = new Set(["type", "file"]);
const ROUTE_METHOD_SET = new Set<string>(ROUTE_HTTP_METHODS);

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
    }
    if (entry.files !== undefined) {
      requireObject(entry.files, `${resource}.${name}.files`);
    }
  }
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
  }
  if (obj.patch !== undefined) {
    const patch = requireObject(obj.patch, "site.patch");
    validateKnownFields(patch, "site.patch", SITE_PATCH_FIELDS);
    if (patch.put !== undefined) requireObject(patch.put, "site.patch.put");
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
  if (targetType === "static") {
    validateStaticRouteEntry(entry, resource);
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

function hasDeployableContent(spec: Record<string, unknown>): boolean {
  return (
    hasDatabaseContent(spec.database) ||
    hasSiteContent(spec.site) ||
    hasFunctionsContent(spec.functions) ||
    hasSecretsContent(spec.secrets) ||
    hasSubdomainsContent(spec.subdomains) ||
    hasRecordEntries(spec.routes) ||
    hasArrayEntries(spec.checks)
  );
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
      diff,
      payment_required: raw.payment_required ?? null,
    };
  }
  return {
    ...plan,
    warnings,
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
      if (!route.pattern.endsWith("/*")) return false;
      if (!route.methods) return false;
      const methods = new Set(route.methods);
      return (
        methods.size > 0 &&
        [...methods].every((method) => method === "GET" || method === "HEAD")
      );
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

function abortOnConfirmationWarnings(plan: PlanResponse, opts: ApplyOptions): void {
  if (opts.allowWarnings) return;
  const blocking = plan.warnings.filter(
    (w) => w.requires_confirmation || w.code === "MISSING_REQUIRED_SECRET",
  );
  if (blocking.length === 0) return;
  const missing = blocking.find((w) => w.code === "MISSING_REQUIRED_SECRET");
  const first = missing ?? blocking[0]!;
  throw new Run402DeployError(
    `Deploy plan returned warning ${first.code} that requires confirmation; resolve it or retry with allowWarnings after explicit review.`,
    {
      code: first.code || "DEPLOY_WARNING_REQUIRES_CONFIRMATION",
      phase: "plan",
      resource: "warnings",
      retryable: false,
      fix: { action: "review_warnings", path: "warnings" },
      body: { warnings: blocking },
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
): Promise<{
  normalized: NormalizedReleaseSpec;
  byteReaders: Map<string, ByteReader>;
}> {
  const byteReaders = new Map<string, ByteReader>();
  const remember = (resolved: ResolvedContent): ContentRef => {
    // Propagate the final content-type onto the deferred reader so the CAS
    // upload session can declare it correctly. Callers may set
    // ref.contentType *after* resolveContent returns (e.g. normalizeFileSet
    // sets it from the path extension), so do this at remember time.
    if (resolved.ref.contentType && !resolved.reader.contentType) {
      resolved.reader.contentType = resolved.ref.contentType;
    }
    if (!byteReaders.has(resolved.ref.sha256)) {
      byteReaders.set(resolved.ref.sha256, resolved.reader);
    } else {
      // Already remembered — but if the existing reader has no contentType
      // and we just learned it, fill it in.
      const existing = byteReaders.get(resolved.ref.sha256)!;
      if (resolved.ref.contentType && !existing.contentType) {
        existing.contentType = resolved.ref.contentType;
      }
    }
    return resolved.ref;
  };

  const normalized: NormalizedReleaseSpec = { project: spec.project };
  if (spec.base) normalized.base = spec.base;
  if (spec.subdomains) normalized.subdomains = spec.subdomains;
  if (hasOwn(spec as unknown as Record<string, unknown>, "routes")) {
    normalized.routes = spec.routes;
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
          normalizeMigration(client, spec.project, m, remember),
        ),
      );
    }
    normalized.database = db;
  }

  if (spec.functions) {
    const fns: NormalizedFunctionsSpec = {};
    if (spec.functions.replace) {
      fns.replace = await normalizeFunctionMap(spec.functions.replace, remember);
    }
    if (spec.functions.patch) {
      fns.patch = {};
      if (spec.functions.patch.set) {
        fns.patch.set = await normalizeFunctionMap(spec.functions.patch.set, remember);
      }
      if (spec.functions.patch.delete) fns.patch.delete = spec.functions.patch.delete;
    }
    normalized.functions = fns;
  }

  if (spec.site) {
    const publicPaths =
      "public_paths" in spec.site ? spec.site.public_paths : undefined;
    if ("replace" in spec.site && spec.site.replace) {
      const map = await normalizeFileSet(spec.site.replace, remember);
      normalized.site = {
        replace: map,
        ...(publicPaths ? { public_paths: publicPaths } : {}),
      } as NormalizedSiteSpec;
    } else if ("patch" in spec.site && spec.site.patch) {
      const patch: { put?: Record<string, ContentRef>; delete?: string[] } = {};
      if (spec.site.patch.put) {
        patch.put = await normalizeFileSet(spec.site.patch.put, remember);
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
  if (fn.schedule !== undefined) out.schedule = fn.schedule;
  if (fn.entrypoint) out.entrypoint = fn.entrypoint;

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
  set: FileSet,
  remember: (r: ResolvedContent) => ContentRef,
): Promise<Record<string, ContentRef>> {
  const out: Record<string, ContentRef> = {};
  for (const [path, source] of Object.entries(set)) {
    const resolved = await resolveContent(source, path);
    if (!resolved.ref.contentType) {
      resolved.ref.contentType = guessContentType(path);
    }
    out[path] = remember(resolved);
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

  let sql_ref: ContentRef;
  let checksum: string;
  if (m.sql_ref) {
    sql_ref = m.sql_ref;
    checksum = m.checksum ?? m.sql_ref.sha256;
  } else if (m.sql !== undefined) {
    const bytes = new TextEncoder().encode(m.sql);
    const sha256 = await sha256Hex(bytes);
    const ref: ContentRef = { sha256, size: bytes.byteLength, contentType: "application/sql" };
    remember({ ref, reader: makeBytesReader(bytes, `migration:${m.id}`) });
    sql_ref = ref;
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

  const out: NormalizedMigrationSpec = { id: m.id, checksum, sql_ref };
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
    const uploadedParts = await uploadOne(client.fetch, session, bytes);
    // Per-session promotion to CAS (see uploadMissing for the rationale).
    await client.request<unknown>(
      `/storage/v1/uploads/${encodeURIComponent(session.upload_id)}/complete`,
      {
        method: "POST",
        headers,
        body: uploadCompleteBody(session, uploadedParts),
        context: "completing content upload session",
      },
    );
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
 * `/deploy/v2/operations/:id*` and `/content/v1/plans*` routes require
 * `apikey: <project.anon_key>` (apikeyAuth middleware). Plan + commit on
 * `/deploy/v2/plans*` use SIWX, which the kernel's getAuth provides
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
