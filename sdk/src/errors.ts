/**
 * Error hierarchy for the Run402 SDK. Every failure throws a subclass of
 * {@link Run402Error}. Consumers (MCP handlers, CLI commands, user functions)
 * translate these into their native error shapes at the edge.
 *
 * Branch on {@link Run402Error.kind} (or the exported `is*` type guards) rather
 * than `instanceof`. Discriminator-based checks survive duplicate SDK installs,
 * bundler chunk splits, ESM/CJS interop, and V8-isolate realm boundaries —
 * any setting where a class object's identity might differ from the consumer's
 * own class object reference. `instanceof X` continues to work for callers
 * holding a single SDK copy (back-compat); the guards are the recommended path.
 */

/**
 * Stable string discriminator on every {@link Run402Error} subclass. Use this
 * (or the exported `is*` guards) to branch on errors safely across SDK copies
 * and realms — value comparison, no class-identity dependency.
 */
export type Run402ErrorKind =
  | "payment_required"
  | "project_not_found"
  | "unauthorized"
  | "api_error"
  | "network_error"
  | "local_error"
  | "deploy_error";

export abstract class Run402Error extends Error {
  /**
   * Structural brand. Always `true` on any {@link Run402Error} subclass
   * instance, regardless of which SDK copy created it. The exported
   * {@link isRun402Error} guard checks this field instead of `instanceof`,
   * so cross-realm and cross-bundle errors still match.
   */
  readonly isRun402Error = true as const;
  /**
   * Stable string discriminator. Branch on `e.kind === "..."` (or the
   * exported subclass guards) rather than `e instanceof X`. Equality on
   * `kind` survives duplicate SDK copies and cross-realm errors.
   */
  abstract readonly kind: Run402ErrorKind;
  /** HTTP status, or null for local/network failures that produced no response. */
  readonly status: number | null;
  /** Parsed response body, or null when no body was received. */
  readonly body: unknown;
  /** Short verb phrase identifying the attempted operation (e.g. "provisioning project"). */
  readonly context: string;
  /** Canonical machine-readable Run402 error code, when the gateway provided one. */
  readonly code?: string;
  /** High-level error category, e.g. lifecycle, deploy, auth. */
  readonly category?: string;
  /** Whether the same request may succeed later. */
  readonly retryable?: boolean;
  /** Whether repeating the same request should avoid duplicating/corrupting a mutation. */
  readonly safeToRetry?: boolean;
  /** Gateway-known mutation progress for failed mutating operations. */
  readonly mutationState?: string;
  /** Trace id suitable for support/debugging. */
  readonly traceId?: string;
  /** Canonical structured context. Preserved by reference from the response body. */
  readonly details?: unknown;
  /** Advisory next actions from the gateway. Rendering them must not execute them. */
  readonly nextActions?: unknown[];

  constructor(message: string, status: number | null, body: unknown, context: string) {
    super(message);
    this.name = this.constructor.name;
    this.status = status;
    this.body = body;
    this.context = context;
    const envelope = canonicalEnvelope(body);
    const ctor = this.constructor as typeof Run402Error & {
      DEFAULT_CODE?: string;
      DEFAULT_CATEGORY?: string;
      DEFAULT_RETRYABLE?: boolean;
    };
    const envelopeCode = typeof envelope?.code === "string" ? envelope.code : undefined;
    const envelopeCategory = typeof envelope?.category === "string" ? envelope.category : undefined;
    const envelopeRetryable = typeof envelope?.retryable === "boolean" ? envelope.retryable : undefined;
    if (envelopeCode !== undefined) this.code = envelopeCode;
    else if (ctor.DEFAULT_CODE !== undefined) this.code = ctor.DEFAULT_CODE;
    if (envelopeCategory !== undefined) this.category = envelopeCategory;
    else if (ctor.DEFAULT_CATEGORY !== undefined) this.category = ctor.DEFAULT_CATEGORY;
    if (envelopeRetryable !== undefined) this.retryable = envelopeRetryable;
    else if (ctor.DEFAULT_RETRYABLE !== undefined) this.retryable = ctor.DEFAULT_RETRYABLE;
    if (typeof envelope?.safe_to_retry === "boolean") this.safeToRetry = envelope.safe_to_retry;
    if (typeof envelope?.mutation_state === "string") this.mutationState = envelope.mutation_state;
    if (typeof envelope?.trace_id === "string") this.traceId = envelope.trace_id;
    if (envelope && Object.prototype.hasOwnProperty.call(envelope, "details")) {
      this.details = envelope.details;
    }
    if (Array.isArray(envelope?.next_actions)) this.nextActions = envelope.next_actions;
  }

  /**
   * Canonical structured envelope for `JSON.stringify`. Without this, an
   * `Error` instance serializes as `"{}"` (its built-in fields are
   * non-enumerable), losing every structured detail an agent needs for
   * triage. Subclasses with extra fields (e.g. {@link Run402DeployError})
   * override and spread `super.toJSON()`.
   */
  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      kind: this.kind,
      message: this.message,
      status: this.status,
      code: this.code,
      category: this.category,
      retryable: this.retryable,
      safeToRetry: this.safeToRetry,
      mutationState: this.mutationState,
      traceId: this.traceId,
      context: this.context,
      details: this.details,
      nextActions: this.nextActions,
      body: this.body,
    };
  }
}

function canonicalEnvelope(body: unknown): Record<string, unknown> | null {
  return body && typeof body === "object" && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : null;
}

/** HTTP 402 — the gateway requires payment (lease expired, insufficient balance, or x402 quote). */
export class PaymentRequired extends Run402Error {
  static readonly DEFAULT_CODE = "PAYMENT_REQUIRED";
  static readonly DEFAULT_CATEGORY = "payment_required";
  static readonly DEFAULT_RETRYABLE = false;
  readonly kind = "payment_required" as const;
}

/** Project ID is not present in the credential provider (local miss) or the gateway returned 404. */
export class ProjectNotFound extends Run402Error {
  static readonly DEFAULT_CODE = "PROJECT_NOT_FOUND";
  static readonly DEFAULT_CATEGORY = "not_found";
  static readonly DEFAULT_RETRYABLE = false;
  readonly kind = "project_not_found" as const;
  readonly projectId: string;
  constructor(projectId: string, context: string, status: number | null = null, body: unknown = null) {
    super(`Project ${projectId} not found`, status, body, context);
    this.projectId = projectId;
  }
}

/** HTTP 401 or 403 — authentication missing, invalid, or insufficient for the operation. */
export class Unauthorized extends Run402Error {
  static readonly DEFAULT_CODE = "UNAUTHORIZED";
  static readonly DEFAULT_CATEGORY = "auth";
  static readonly DEFAULT_RETRYABLE = false;
  readonly kind = "unauthorized" as const;
}

/** Any other non-2xx HTTP response from the gateway. */
export class ApiError extends Run402Error {
  static readonly DEFAULT_CODE = "API_ERROR";
  static readonly DEFAULT_CATEGORY = "api";
  static readonly DEFAULT_RETRYABLE = false;
  readonly kind = "api_error" as const;
}

/** The underlying `fetch` threw before producing a response (DNS, connection reset, offline). */
export class NetworkError extends Run402Error {
  static readonly DEFAULT_CODE = "NETWORK_ERROR";
  static readonly DEFAULT_CATEGORY = "network";
  static readonly DEFAULT_RETRYABLE = true;
  readonly kind = "network_error" as const;
  readonly cause: unknown;
  constructor(message: string, cause: unknown, context: string) {
    super(message, null, null, context);
    this.cause = cause;
  }
}

/** Local/filesystem error — input validation, missing path, unreadable dir. No HTTP involved. */
export class LocalError extends Run402Error {
  static readonly DEFAULT_CODE = "LOCAL_ERROR";
  static readonly DEFAULT_CATEGORY = "local";
  static readonly DEFAULT_RETRYABLE = false;
  readonly kind = "local_error" as const;
  readonly cause?: unknown;
  constructor(message: string, context: string, cause?: unknown) {
    super(message, null, null, context);
    if (cause !== undefined) this.cause = cause;
  }
}

/**
 * Deploy-state-machine failure surfaced from the v2 deploy flow. Carries the
 * structured error envelope the gateway returns alongside the operation
 * snapshot — phase, resource, retryability, and an optional remediation hint.
 *
 * The `code` enumerates the gateway's deploy error codes; consumers may
 * switch on it to decide whether to retry, prompt the user for payment, ask
 * for a fix, or escalate. Unknown codes from a newer gateway pass through
 * verbatim — callers should treat unrecognized values as opaque.
 */
export type Run402DeployErrorCode =
  | "MIGRATION_FAILED"
  | "MIGRATION_CHECKSUM_MISMATCH"
  | "MIGRATION_SQL_NOT_FOUND"
  | "BASE_RELEASE_CONFLICT"
  | "PAYMENT_REQUIRED"
  | "SUBDOMAIN_MULTI_NOT_SUPPORTED"
  | "SCHEMA_SETTLE_TIMEOUT"
  | "ACTIVATION_FAILED"
  | "STORAGE_UNAVAILABLE"
  | "SITE_STAGE_FAILED"
  | "FUNCTION_BUILD_FAILED"
  | "CONTENT_UPLOAD_FAILED"
  | "INVALID_SPEC"
  | "OPERATION_NOT_FOUND"
  | "PLAN_NOT_FOUND"
  | "MIGRATE_GATE_ACTIVE"
  | "NOT_RESUMABLE"
  | "INVALID_STATE"
  | "RESUME_FAILED"
  | "INTERNAL_ERROR"
  | "NETWORK_ERROR"
  | "PROJECT_NOT_FOUND"
  | (string & {});

export interface Run402DeployErrorFix {
  action: string;
  path?: string;
  [key: string]: unknown;
}

export class Run402DeployError extends Run402Error {
  readonly kind = "deploy_error" as const;
  readonly code: Run402DeployErrorCode;
  readonly phase: string | null;
  readonly resource: string | null;
  readonly retryable: boolean;
  readonly operationId: string | null;
  readonly planId: string | null;
  readonly fix: Run402DeployErrorFix | null;
  readonly logs: string[] | null;
  readonly rolledBack: boolean;
  readonly attempts?: number;
  readonly maxRetries?: number;
  readonly lastRetryCode?: Run402DeployErrorCode;

  constructor(
    message: string,
    init: {
      code: Run402DeployErrorCode;
      phase?: string | null;
      resource?: string | null;
      retryable?: boolean;
      operationId?: string | null;
      planId?: string | null;
      fix?: Run402DeployErrorFix | null;
      logs?: string[] | null;
      rolledBack?: boolean;
      attempts?: number;
      maxRetries?: number;
      lastRetryCode?: Run402DeployErrorCode;
      status?: number | null;
      body?: unknown;
      context: string;
    },
  ) {
    super(message, init.status ?? null, init.body ?? null, init.context);
    this.code = init.code;
    this.phase = init.phase ?? null;
    this.resource = init.resource ?? null;
    this.retryable = init.retryable ?? false;
    this.operationId = init.operationId ?? null;
    this.planId = init.planId ?? null;
    this.fix = init.fix ?? null;
    this.logs = init.logs ?? null;
    this.rolledBack = init.rolledBack ?? false;
    if (init.attempts !== undefined) this.attempts = init.attempts;
    if (init.maxRetries !== undefined) this.maxRetries = init.maxRetries;
    if (init.lastRetryCode !== undefined) this.lastRetryCode = init.lastRetryCode;
  }

  override toJSON(): Record<string, unknown> {
    return {
      ...super.toJSON(),
      phase: this.phase,
      resource: this.resource,
      operationId: this.operationId,
      planId: this.planId,
      fix: this.fix,
      logs: this.logs,
      rolledBack: this.rolledBack,
      retryable: this.retryable,
      attempts: this.attempts,
      maxRetries: this.maxRetries,
      lastRetryCode: this.lastRetryCode,
    };
  }
}

// ─── Type guards ─────────────────────────────────────────────────────────────
//
// Identity-free guards. Each one checks the structural brand and (for subclass
// guards) the `kind` discriminator. Use these instead of `instanceof X` so the
// check survives duplicate SDK installs, bundler chunk splits, ESM/CJS interop,
// and V8-isolate realm boundaries — anywhere the consumer's class object
// reference might differ from the throw site's.

/** True if `e` is any {@link Run402Error} subclass instance, regardless of which SDK copy created it. */
export function isRun402Error(e: unknown): e is Run402Error {
  return Boolean(
    e &&
      typeof e === "object" &&
      (e as { isRun402Error?: unknown }).isRun402Error === true,
  );
}

/** True if `e` is a {@link PaymentRequired}. Survives duplicate SDK copies and realms. */
export function isPaymentRequired(e: unknown): e is PaymentRequired {
  return isRun402Error(e) && e.kind === "payment_required";
}

/** True if `e` is a {@link ProjectNotFound}. */
export function isProjectNotFound(e: unknown): e is ProjectNotFound {
  return isRun402Error(e) && e.kind === "project_not_found";
}

/** True if `e` is an {@link Unauthorized}. */
export function isUnauthorized(e: unknown): e is Unauthorized {
  return isRun402Error(e) && e.kind === "unauthorized";
}

/** True if `e` is an {@link ApiError}. */
export function isApiError(e: unknown): e is ApiError {
  return isRun402Error(e) && e.kind === "api_error";
}

/** True if `e` is a {@link NetworkError}. */
export function isNetworkError(e: unknown): e is NetworkError {
  return isRun402Error(e) && e.kind === "network_error";
}

/** True if `e` is a {@link LocalError}. */
export function isLocalError(e: unknown): e is LocalError {
  return isRun402Error(e) && e.kind === "local_error";
}

/** True if `e` is a {@link Run402DeployError}. */
export function isDeployError(e: unknown): e is Run402DeployError {
  return isRun402Error(e) && e.kind === "deploy_error";
}

/**
 * Canonical "should I retry this?" policy. Returns true when `e` is a
 * {@link Run402Error} AND any of:
 *   - `e.retryable === true` (gateway flagged it)
 *   - `e.safeToRetry === true` (gateway flagged it)
 *   - `e.kind === "network_error"` (fetch never produced a response)
 *   - `e.status` is 408 (Request Timeout), 425 (Too Early), or 429 (Too Many
 *     Requests)
 *   - `e.status` is a 5xx server error
 *
 * Returns false for non-Run402 errors so it can be safely called with
 * `unknown` from a catch block. Used as the default `retryIf` in
 * {@link withRetry}.
 */
export function isRetryableRun402Error(e: unknown): boolean {
  if (!isRun402Error(e)) return false;
  if (e.retryable === true || e.safeToRetry === true) return true;
  if (e.kind === "network_error") return true;
  const s = e.status;
  if (s === 408 || s === 425 || s === 429) return true;
  if (typeof s === "number" && s >= 500) return true;
  return false;
}
