/**
 * Error hierarchy for the Run402 SDK. Every failure throws a subclass of
 * {@link Run402Error}. Consumers (MCP handlers, CLI commands, user functions)
 * translate these into their native error shapes at the edge.
 */

export abstract class Run402Error extends Error {
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
    if (typeof envelope?.code === "string") this.code = envelope.code;
    if (typeof envelope?.category === "string") this.category = envelope.category;
    if (typeof envelope?.retryable === "boolean") this.retryable = envelope.retryable;
    if (typeof envelope?.safe_to_retry === "boolean") this.safeToRetry = envelope.safe_to_retry;
    if (typeof envelope?.mutation_state === "string") this.mutationState = envelope.mutation_state;
    if (typeof envelope?.trace_id === "string") this.traceId = envelope.trace_id;
    if (envelope && Object.prototype.hasOwnProperty.call(envelope, "details")) {
      this.details = envelope.details;
    }
    if (Array.isArray(envelope?.next_actions)) this.nextActions = envelope.next_actions;
  }
}

function canonicalEnvelope(body: unknown): Record<string, unknown> | null {
  return body && typeof body === "object" && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : null;
}

/** HTTP 402 — the gateway requires payment (lease expired, insufficient balance, or x402 quote). */
export class PaymentRequired extends Run402Error {}

/** Project ID is not present in the credential provider (local miss) or the gateway returned 404. */
export class ProjectNotFound extends Run402Error {
  readonly projectId: string;
  constructor(projectId: string, context: string, status: number | null = null, body: unknown = null) {
    super(`Project ${projectId} not found`, status, body, context);
    this.projectId = projectId;
  }
}

/** HTTP 401 or 403 — authentication missing, invalid, or insufficient for the operation. */
export class Unauthorized extends Run402Error {}

/** Any other non-2xx HTTP response from the gateway. */
export class ApiError extends Run402Error {}

/** The underlying `fetch` threw before producing a response (DNS, connection reset, offline). */
export class NetworkError extends Run402Error {
  readonly cause: unknown;
  constructor(message: string, cause: unknown, context: string) {
    super(message, null, null, context);
    this.cause = cause;
  }
}

/** Local/filesystem error — input validation, missing path, unreadable dir. No HTTP involved. */
export class LocalError extends Run402Error {
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
  readonly code: Run402DeployErrorCode;
  readonly phase: string | null;
  readonly resource: string | null;
  readonly retryable: boolean;
  readonly operationId: string | null;
  readonly planId: string | null;
  readonly fix: Run402DeployErrorFix | null;
  readonly logs: string[] | null;
  readonly rolledBack: boolean;

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
  }
}
