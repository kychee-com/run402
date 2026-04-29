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
import {
  ApiError,
  NetworkError,
  Run402DeployError,
  type Run402DeployErrorCode,
  type Run402DeployErrorFix,
} from "../errors.js";
import type {
  ApplyOptions,
  CommitResponse,
  ContentPlanResponse,
  ContentRef,
  ContentSource,
  DeployEvent,
  DeployOperation,
  DeployResult,
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
  ReleaseSpec,
  StartOptions,
} from "./deploy.types.js";

// ─── Constants ───────────────────────────────────────────────────────────────

const PLAN_BODY_LIMIT_BYTES = 5 * 1024 * 1024;
const COMMIT_POLL_INITIAL_MS = 1_000;
const COMMIT_POLL_MAX_MS = 30_000;
const COMMIT_POLL_BACKOFF_AFTER_MS = 30_000;
const COMMIT_POLL_TIMEOUT_MS = 10 * 60 * 1000;
const URL_REFRESH_AT_MS = 50 * 60 * 1000;

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
    const emit = makeEmitter(opts.onEvent);

    emit({ type: "plan.started" });
    const { plan, byteReaders } = await planInternal(this.client, spec, opts.idempotencyKey);
    emit({ type: "plan.diff", diff: plan.diff });

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

    await uploadMissing(this.client, spec.project, plan.missing_content, byteReaders, emit);

    emit({ type: "commit.phase", phase: "validate", status: "started" });
    const commit = await commitInternal(this.client, plan.plan_id, opts.idempotencyKey);
    return await pollUntilReady(this.client, commit, plan.diff, emit, spec.project);
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
    opts: { idempotencyKey?: string } = {},
  ): Promise<{ plan: PlanResponse; byteReaders: Map<string, ByteReader> }> {
    return planInternal(this.client, spec, opts.idempotencyKey);
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
    return await pollUntilReady(this.client, commit, {}, emit, opts.project);
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
    const emit = makeEmitter(opts.onEvent);
    const snapshot = await this.client.request<OperationSnapshot>(
      `/deploy/v2/operations/${operationId}/resume`,
      { method: "POST", context: "resuming deploy operation" },
    );
    return await pollSnapshotUntilReady(this.client, snapshot, {}, emit, opts.project);
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
   * Fetch a release by id. (Endpoint may not be live in early v2 builds —
   * falls through to the gateway's standard 404 handling in that case.)
   */
  async getRelease(releaseId: string): Promise<unknown> {
    return this.client.request<unknown>(`/deploy/v2/releases/${releaseId}`, {
      context: "fetching release",
    });
  }

  /**
   * Diff two releases. (Endpoint may not be live in early v2 builds.)
   */
  async diff(opts: { from: string; to: string }): Promise<unknown> {
    const qs = new URLSearchParams({ from: opts.from, to: opts.to });
    return this.client.request<unknown>(`/deploy/v2/releases/diff?${qs}`, {
      context: "diffing releases",
    });
  }
}

// ─── Internal pipeline ───────────────────────────────────────────────────────

async function planInternal(
  client: Client,
  spec: ReleaseSpec,
  idempotencyKey?: string,
): Promise<{ plan: PlanResponse; byteReaders: Map<string, ByteReader> }> {
  validateSpec(spec);

  const { normalized, byteReaders } = await normalizeReleaseSpec(client, spec);

  // The gateway expects { spec, manifest_ref?, idempotency_key? } with
  // ReleaseSpec.project (singular). For oversized specs the SDK uploads
  // the manifest JSON to CAS first and references it; the gateway still
  // needs `spec` in the body (with at least the project), so we keep a
  // minimal stub there.
  const inlineBody: PlanRequest = { spec: normalized };
  if (idempotencyKey) inlineBody.idempotency_key = idempotencyKey;
  const inlineBytes = new TextEncoder().encode(JSON.stringify(inlineBody)).byteLength;

  let body: PlanRequest;
  if (inlineBytes <= PLAN_BODY_LIMIT_BYTES) {
    body = inlineBody;
  } else {
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
    plan = await client.request<PlanResponse>("/deploy/v2/plans", {
      method: "POST",
      body,
      context: "planning deploy",
    });
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
  // Filter to refs the gateway reported as missing for this project.
  const needsUpload = presence.filter((p) => !p.present);
  if (needsUpload.length === 0) return;

  // Hand off to the CAS content service: hand it the list of missing
  // refs, it issues an upload session per ref with presigned PUT URLs,
  // then we PUT the bytes and commit the content plan.
  const headers = await apikeyHeaders(client, projectId);

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
      body: { content: contentRequest },
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
    await uploadOne(client.fetch, session, bytes);

    // Per-session completion — promotes the staged object to CAS via
    // services/cas-promote.ts. The plan-level `/content/v1/plans/:id/commit`
    // call below is the plan-level finalize; per-session promotion happens
    // here through the existing /storage/v1/uploads/:id/complete handler,
    // which knows how to handle `kind='cas'` sessions and write the
    // internal.content_objects + internal.plan_claims rows the deploy
    // commit's FK constraints rely on.
    const completeBody: Record<string, unknown> = {};
    if (session.mode === "multipart" && session.parts.length > 1) {
      // Multipart completion needs per-part ETags. The SDK doesn't capture
      // ETags during the PUT loop today (it would need a multi-PUT
      // helper); for the common single-PUT case below this is empty.
      // TODO: collect part ETags during uploadOne for true multipart.
    }
    await client.request<unknown>(
      `/storage/v1/uploads/${encodeURIComponent(session.upload_id)}/complete`,
      {
        method: "POST",
        headers,
        body: completeBody,
        context: "completing content upload session",
      },
    );

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

async function uploadOne(
  fetchFn: typeof globalThis.fetch,
  entry: MissingContent,
  bytes: Uint8Array,
): Promise<void> {
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
    return;
  }
  for (const part of entry.parts) {
    const slice = bytes.subarray(part.byte_start, part.byte_end + 1);
    const checksum = await sha256Base64(slice);
    await putToS3(fetchFn, part.url, slice, checksum, part.part_number);
  }
}

async function putToS3(
  fetchFn: typeof globalThis.fetch,
  url: string,
  body: Uint8Array,
  checksumBase64: string,
  partNumber: number,
): Promise<void> {
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
}

async function pollUntilReady(
  client: Client,
  commit: CommitResponse,
  diff: PlanResponse["diff"],
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
    };
  }

  const opHeaders = projectId ? await apikeyHeaders(client, projectId) : {};
  const initialSnapshot: OperationSnapshot = await client.request<OperationSnapshot>(
    `/deploy/v2/operations/${encodeURIComponent(commit.operation_id)}`,
    { headers: opHeaders, context: "fetching deploy operation" },
  );
  return await pollSnapshotUntilReady(client, initialSnapshot, diff, emit, projectId);
}

async function pollSnapshotUntilReady(
  client: Client,
  initial: OperationSnapshot,
  diff: PlanResponse["diff"],
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

  while (true) {
    if (lastPhaseEmitted !== snapshot.status) {
      const ev = phaseFor(snapshot.status);
      if (ev) emit(ev);
      lastPhaseEmitted = snapshot.status;
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
      emit({ type: "ready", releaseId: snapshot.release_id, urls: snapshot.urls });
      return {
        release_id: snapshot.release_id,
        operation_id: snapshot.operation_id,
        urls: snapshot.urls,
        diff,
      };
    }

    if (TERMINAL_STATUSES.includes(snapshot.status)) {
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
    const commit = await commitInternal(client, plan.plan_id, opts.idempotencyKey);
    return await pollUntilReady(client, commit, plan.diff, emit, spec.project);
  })();
  // Avoid an unhandled-rejection at construction time. Consumers must call
  // .result() to actually observe the error.
  resultPromise.catch(() => {});

  let snapshot: OperationSnapshot | null = null;
  const startHeaders = await apikeyHeaders(client, spec.project);
  const fetchSnapshot = async (): Promise<OperationSnapshot> => {
    if (snapshot && TERMINAL_STATUSES.includes(snapshot.status)) return snapshot;
    snapshot = await client.request<OperationSnapshot>(
      `/deploy/v2/operations/${encodeURIComponent(plan.operation_id)}`,
      { headers: startHeaders, context: "fetching deploy operation" },
    );
    return snapshot;
  };

  return {
    id: plan.operation_id,
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
          // Surface terminal failure as iterator end.
          resultPromise.catch(() => {
            done = true;
            if (resolveNext) {
              const r = resolveNext;
              resolveNext = null;
              r({ value: undefined as unknown as DeployEvent, done: true });
            }
          });

          return {
            next(): Promise<IteratorResult<DeployEvent>> {
              if (queue.length > 0) {
                return Promise.resolve({ value: queue.shift()!, done: false });
              }
              if (done) {
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

function validateSpec(spec: ReleaseSpec): void {
  if (!spec || typeof spec !== "object") {
    throw new Run402DeployError("ReleaseSpec must be an object", {
      code: "INVALID_SPEC",
      retryable: false,
      context: "validating spec",
    });
  }
  if (!spec.project || typeof spec.project !== "string") {
    throw new Run402DeployError("ReleaseSpec.project is required", {
      code: "INVALID_SPEC",
      retryable: false,
      context: "validating spec",
    });
  }
  if (spec.subdomains?.set && spec.subdomains.set.length > 1) {
    throw new Run402DeployError(
      "subdomains.set accepts at most one subdomain per project; multi-subdomain support is not yet available",
      {
        code: "SUBDOMAIN_MULTI_NOT_SUPPORTED",
        resource: "subdomains.set",
        retryable: false,
        context: "validating spec",
      },
    );
  }
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
  if (spec.routes) normalized.routes = spec.routes;
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
    if ("replace" in spec.site && spec.site.replace) {
      const map = await normalizeFileSet(spec.site.replace, remember);
      normalized.site = { replace: map } as NormalizedSiteSpec;
    } else if ("patch" in spec.site && spec.site.patch) {
      const patch: { put?: Record<string, ContentRef>; delete?: string[] } = {};
      if (spec.site.patch.put) {
        patch.put = await normalizeFileSet(spec.site.patch.put, remember);
      }
      if (spec.site.patch.delete) patch.delete = spec.site.patch.delete;
      normalized.site = { patch } as NormalizedSiteSpec;
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
      resource: "database.migrations",
      retryable: false,
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
        resource: `database.migrations.${m.id}`,
        retryable: false,
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
    await uploadOne(client.fetch, session, bytes);
    // Per-session promotion to CAS (see uploadMissing for the rationale).
    await client.request<unknown>(
      `/storage/v1/uploads/${encodeURIComponent(session.upload_id)}/complete`,
      {
        method: "POST",
        headers,
        body: {},
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
  const project = await client.getProject(projectId);
  if (!project) return {};
  return { apikey: project.anon_key };
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
    return body.error as GatewayDeployError;
  }
  if (typeof body.code === "string") {
    const out: GatewayDeployError = { code: body.code };
    if (typeof body.message === "string") {
      out.message = body.message;
    } else if (typeof body.error === "string") {
      out.message = body.error;
    } else {
      out.message = `Deploy error: ${body.code}`;
    }
    if (typeof body.phase === "string") out.phase = body.phase;
    if (typeof body.resource === "string") out.resource = body.resource;
    if (typeof body.retryable === "boolean") out.retryable = body.retryable;
    if (body.fix !== undefined) out.fix = body.fix as GatewayDeployError["fix"];
    if (Array.isArray(body.logs)) out.logs = body.logs as string[];
    if (typeof body.rolled_back === "boolean") out.rolled_back = body.rolled_back;
    return out;
  }
  return null;
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
  return new Run402DeployError(gw.message ?? `Deploy failed: ${gw.code}`, {
    code: gw.code as Run402DeployErrorCode,
    phase: gw.phase ?? phase,
    resource: gw.resource ?? null,
    retryable: gw.retryable ?? false,
    operationId,
    planId,
    fix: (gw.fix ?? null) as Run402DeployErrorFix | null,
    logs: gw.logs ?? null,
    rolledBack: gw.rolled_back ?? false,
    body: gw,
    context: phase,
  });
}
