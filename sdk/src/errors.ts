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
  | "not_authorized"
  | "api_error"
  | "network_error"
  | "payment_attempt_error"
  | "local_error"
  | "deploy_error"
  | "transfer_freeze"
  | "step_up_required"
  | "operator_approval_required";

/**
 * Quota-denial scope discriminator (v1.46+). Indicates whether a quota-related
 * denial was enforced against the pooled organization total (`"organization"`)
 * or against an orphan project whose organization row has been purged but
 * cascade has not yet run (`"project"`). Lifted from `details.scope` on the
 * gateway envelope; absent for errors unrelated to quota.
 */
export type Run402QuotaScope = "organization" | "project";

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
  /**
   * Parsed response body, or null when no body was received. Holds the raw
   * gateway envelope, so additive fields not lifted onto typed properties stay
   * reachable here — notably `correlated_platform_incident`
   * (`{ id, subsystem, status: "ongoing" | "resolved" }`), present ONLY while
   * an OPEN platform incident correlates with this error's `code` (a `poll`
   * action also rides in {@link nextActions}). It is a CORRELATION, not an
   * exoneration: the platform states it was degraded when the call failed and
   * leaves the judgment to you. Treat it as a strong signal to poll the events
   * feed (`r.events.list`) before debugging your own code; the follow-up
   * `platform_incident` feed event carries the project's real failed-invocation
   * count once the incident resolves.
   */
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
  /** Advisory next actions (gateway-authored or SDK-synthesized). Rendering them must not execute them. */
  readonly nextActions?: NextAction[];
  /**
   * Quota-denial scope (v1.46+). `"organization"` for pooled organization
   * denials; `"project"` for the orphan fallback (project whose organization
   * row was purged but cascade has not yet run). Lifted from
   * `details.scope` when the gateway returned it. Undefined for errors
   * that are not quota-related.
   */
  readonly quotaScope?: Run402QuotaScope;

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
    if (Array.isArray(envelope?.next_actions) && envelope.next_actions.length > 0) {
      this.nextActions = envelope.next_actions as NextAction[];
    } else {
      // Verified gateway gap (2026-06-24): `POST /apply/v1/plans` 401 and some
      // validation 400s return `next_actions: []`. Synthesize the canonical
      // action for known codes so the relay never hands an agent an empty array.
      // Only fills gaps — never overrides gateway-authored actions.
      const synthesized = synthesizeNextActions(this.code);
      if (synthesized.length > 0) this.nextActions = synthesized;
    }
    const scope = extractQuotaScope(envelope);
    if (scope !== undefined) this.quotaScope = scope;
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
      quotaScope: this.quotaScope,
      body: this.body,
    };
  }
}

function canonicalEnvelope(body: unknown): Record<string, unknown> | null {
  return body && typeof body === "object" && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : null;
}

function extractQuotaScope(
  envelope: Record<string, unknown> | null,
): Run402QuotaScope | undefined {
  if (!envelope) return undefined;
  const details = envelope.details;
  if (!details || typeof details !== "object" || Array.isArray(details)) return undefined;
  const scope = (details as Record<string, unknown>).scope;
  return scope === "organization" || scope === "project" ? scope : undefined;
}

/**
 * HTTP 402 — a genuine protocol payment challenge (x402 or a successor
 * rail): insufficient balance, or a priced quote that must be paid before
 * the request can proceed. style.md reserves 402 for exactly this; quota,
 * lifecycle (frozen/dormant lease expiry), and budget-cap denials return
 * 403 instead with their own canonical `code` (see the api-error-envelope
 * `HTTP 402 is reserved for protocol payment challenges` requirement,
 * kychee-com/run402#497).
 */
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

/**
 * HTTP 401 or 403 — the generic denial bucket: authentication missing,
 * invalid, or insufficient for the operation. Also the fallback for any
 * other 403 that isn't one of the more specific subclasses below (e.g.
 * `NOT_AUTHORIZED`, `STEP_UP_REQUIRED`) — since 402 is reserved for
 * genuine payment challenges, this now also covers non-payment 403 denials
 * such as quota (`QUOTA_EXCEEDED`), lifecycle (`PROJECT_FROZEN` /
 * `PROJECT_DORMANT`), and delegate spend-cap denials. Check `body.code` (or
 * use `formatCanonicalErrorContext`-style parsing) to distinguish these
 * from a true auth failure.
 */
export class Unauthorized extends Run402Error {
  static readonly DEFAULT_CODE = "UNAUTHORIZED";
  static readonly DEFAULT_CATEGORY = "auth";
  static readonly DEFAULT_RETRYABLE = false;
  readonly kind = "unauthorized" as const;
}

/**
 * HTTP 403 `NOT_AUTHORIZED` — the org-owned control plane (gateway v1.77+)
 * denied a control-plane action. A wallet *authenticates* (SIWX resolves it to
 * a principal); *authorization* is an org (organization) membership in the
 * role lattice `owner > admin > developer > billing > viewer`, or a per-project
 * grant for agent/CI principals — never `wallet_address == signer`. High-stakes
 * ops (delete, transfer-of-ownership, membership change) require an active
 * `owner` membership.
 *
 * Distinct from {@link Unauthorized} (authentication missing/invalid): here the
 * caller IS authenticated but lacks the required role/capability, so the fix is
 * to obtain access (a membership/grant), not to re-authenticate. The gateway
 * returns 403 — never 404 — even when the project does not exist, so existence
 * is not leaked to a non-authorized caller (surfaced as `reason:
 * "project_not_found"`). Branch on `kind === "not_authorized"` (or
 * {@link isNotAuthorized}).
 */
export class NotAuthorizedError extends Run402Error {
  static readonly DEFAULT_CODE = "NOT_AUTHORIZED";
  static readonly DEFAULT_CATEGORY = "auth";
  static readonly DEFAULT_RETRYABLE = false;
  readonly kind = "not_authorized" as const;
  /** The control-plane action that was denied, when the gateway named one. */
  readonly action: string | null;
  /** Org role required for the action (e.g. `"owner"`), or null when the denial is capability-based. */
  readonly requiredRole: string | null;
  /** Per-project capability required (e.g. `"deploy"`), or null when the denial is role-based. */
  readonly requiredCapability: string | null;
  /**
   * Why authorization failed. Known values: `"member"` (no active membership),
   * `"grant"` (no per-project grant), `"forbidden"` (role/grant too low), and
   * `"project_not_found"` (returned as 403 to avoid leaking existence). Future
   * strings pass through unchanged.
   */
  readonly reason: string | null;

  constructor(message: string, status: number, body: unknown, context: string) {
    super(message, status, body, context);
    const envelope =
      body && typeof body === "object" && !Array.isArray(body)
        ? (body as Record<string, unknown>)
        : null;
    const details =
      envelope &&
      typeof envelope.details === "object" &&
      envelope.details !== null &&
      !Array.isArray(envelope.details)
        ? (envelope.details as Record<string, unknown>)
        : null;
    this.action = typeof details?.action === "string" ? (details.action as string) : null;
    this.requiredRole =
      typeof details?.required_role === "string" ? (details.required_role as string) : null;
    this.requiredCapability =
      typeof details?.required_capability === "string"
        ? (details.required_capability as string)
        : null;
    this.reason = typeof details?.reason === "string" ? (details.reason as string) : null;
  }

  override toJSON(): Record<string, unknown> {
    return {
      ...super.toJSON(),
      action: this.action,
      requiredRole: this.requiredRole,
      requiredCapability: this.requiredCapability,
      reason: this.reason,
    };
  }
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

/**
 * Phase of an automatic x402 payment attempt. `initial_request` and
 * `payment_signing` occur before a payment-bearing request is dispatched;
 * `payment_submission` and `payment_response` are at/after that boundary.
 */
export type PaymentAttemptPhase =
  | "initial_request"
  | "challenge_received"
  | "payment_signing"
  | "payment_submission"
  | "payment_response";

export type PaymentAttemptMutationState =
  | "not_started"
  | "in_progress"
  | "completed"
  | "ambiguous";

/**
 * Node paid-fetch failure with an explicit payment-effect boundary.
 *
 * A caller may repeat the request only when `safeToRetry === true`. Once a
 * payment-bearing request may have reached the target, the SDK reports an
 * ambiguous mutation and directs the caller to reconcile by
 * `paymentAttemptId`; it never turns a post-dispatch transport error into a
 * blind retry. The raw cause remains available in-process but is deliberately
 * omitted from `toJSON()` and the canonical body.
 */
export class PaymentAttemptError extends Run402Error {
  readonly kind = "payment_attempt_error" as const;
  readonly code: string;
  readonly phase: PaymentAttemptPhase;
  readonly paymentAttemptId: string;
  readonly providerStarted: boolean;
  readonly responseStatus: number | null;
  readonly retryable: boolean;
  readonly safeToRetry: boolean;
  readonly mutationState: PaymentAttemptMutationState;
  readonly cause: unknown;

  constructor(init: {
    code: string;
    message: string;
    phase: PaymentAttemptPhase;
    paymentAttemptId: string;
    providerStarted: boolean;
    responseStatus?: number | null;
    mutationState: PaymentAttemptMutationState;
    safeToRetry: boolean;
    /** Operational retryability; defaults to safeToRetry. */
    retryable?: boolean;
    nextActions?: NextAction[];
    cause: unknown;
    request?: { method: string; origin: string | null; path_sha256: string | null };
  }) {
    const retryable = init.retryable ?? init.safeToRetry;
    const nextActions: NextAction[] =
      init.nextActions ??
      (init.safeToRetry && retryable
        ? [
            {
              type: "retry",
              payment_attempt_id: init.paymentAttemptId,
              why: "No payment-bearing request was dispatched; retrying the original request is safe.",
            },
          ]
        : !init.safeToRetry
          ? [
              {
                type: "reconcile_payment",
                payment_attempt_id: init.paymentAttemptId,
                safe_to_auto_execute: false,
                why: "A payment-bearing request may have reached the provider. Reconcile this attempt before issuing another payment.",
              },
              {
                type: "poll",
                payment_attempt_id: init.paymentAttemptId,
                safe_to_auto_execute: true,
                why: "Poll the target or payment provider for the final state of this attempt.",
              },
            ]
          : []);
    const details = {
      payment_attempt_id: init.paymentAttemptId,
      phase: init.phase,
      provider_started: init.providerStarted,
      response_status: init.responseStatus ?? null,
      ...(init.request ? { request: init.request } : {}),
    };
    super(
      init.message,
      null,
      {
        error: "payment_attempt_failed",
        message: init.message,
        code: init.code,
        category: "payment",
        source: "sdk",
        retryable,
        safe_to_retry: init.safeToRetry,
        mutation_state: init.mutationState,
        details,
        next_actions: nextActions,
      },
      "executing x402 paid fetch",
    );
    this.code = init.code;
    this.phase = init.phase;
    this.paymentAttemptId = init.paymentAttemptId;
    this.providerStarted = init.providerStarted;
    this.responseStatus = init.responseStatus ?? null;
    this.retryable = retryable;
    this.safeToRetry = init.safeToRetry;
    this.mutationState = init.mutationState;
    this.cause = init.cause;
  }

  override toJSON(): Record<string, unknown> {
    return {
      ...super.toJSON(),
      phase: this.phase,
      paymentAttemptId: this.paymentAttemptId,
      providerStarted: this.providerStarted,
      responseStatus: this.responseStatus,
    };
  }
}

/** Local/filesystem error — input validation, missing path, unreadable dir. No HTTP involved. */
export class LocalError extends Run402Error {
  static readonly DEFAULT_CODE = "LOCAL_ERROR";
  static readonly DEFAULT_CATEGORY = "local";
  static readonly DEFAULT_RETRYABLE = false;
  readonly kind = "local_error" as const;
  readonly cause?: unknown;
  /**
   * @param message Human-readable error message.
   * @param context Short verb phrase identifying the operation (used for triage).
   * @param opts Optional. Pass a raw `unknown` for back-compat (treated as `cause`),
   *   or an options bag `{ cause?, code?, details?, next_actions? }` to thread a stable error
   *   `code` (mirrors a gateway error code so client-side validators throw with
   *   the same `code` field consumers branch on).
   */
  constructor(
    message: string,
    context: string,
    opts?: unknown | { cause?: unknown; code?: string; details?: unknown; next_actions?: unknown[] },
  ) {
    const bag =
      opts && typeof opts === "object" && !Array.isArray(opts) &&
      ("cause" in (opts as object) ||
        "code" in (opts as object) ||
        "details" in (opts as object) ||
        "next_actions" in (opts as object))
        ? (opts as { cause?: unknown; code?: string; details?: unknown; next_actions?: unknown[] })
        : null;
    const code = bag?.code;
    const details = bag?.details;
    const nextActions = bag?.next_actions;
    const cause = bag ? bag.cause : opts;
    const envelope: Record<string, unknown> | null =
      code !== undefined || details !== undefined || nextActions !== undefined
        ? {
            ...(code !== undefined ? { code } : {}),
            ...(details !== undefined ? { details } : {}),
            ...(nextActions !== undefined ? { next_actions: nextActions } : {}),
          }
        : null;
    super(message, null, envelope, context);
    if (cause !== undefined) this.cause = cause;
  }
}

/** Local credential-cache miss — the project may exist, but no cached keys are available locally. */
export class ProjectCredentialNotFound extends LocalError {
  readonly projectId: string;

  constructor(
    projectId: string,
    context: string,
    details: Record<string, unknown> = {},
  ) {
    super(`No local project credentials cached for ${projectId}`, context, {
      code: "PROJECT_CREDENTIAL_NOT_FOUND",
      details: {
        project_id: projectId,
        source: "local_cache",
        ...details,
      },
      next_actions: [
        {
          type: "run_command",
          command: `run402 credentials project-keys status --project ${projectId}`,
          why: "Inspect whether this profile has cached project keys without revealing secrets.",
        },
        {
          type: "run_command",
          command: `run402 credentials project-keys import --project ${projectId} --service-key-stdin`,
          why: "Import a service key only when this operation is classified as credential-required.",
        },
      ],
    });
    this.name = "ProjectCredentialNotFound";
    this.projectId = projectId;
  }
}

export const PROJECT_CREDENTIAL_ERROR_CODES = [
  "PROJECT_CREDENTIAL_NOT_FOUND",
  "PROJECT_CREDENTIAL_INVALID",
  "PROJECT_CREDENTIAL_EXPIRED",
  "PROJECT_CREDENTIAL_PROJECT_MISMATCH",
] as const;

export type ProjectCredentialErrorCode = typeof PROJECT_CREDENTIAL_ERROR_CODES[number];

const PROJECT_CREDENTIAL_ERROR_CODE_SET = new Set<string>(PROJECT_CREDENTIAL_ERROR_CODES);

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

/**
 * Project has a pending transfer (v1.59+). Gateway returns 409 with
 * `code: "PROJECT_HAS_PENDING_TRANSFER"` from the transfer-freeze middleware
 * mounted on owner-side mutations (deploy, secrets, custom domains, function
 * CRUD, scheduled-function changes, mailbox config, CI bindings, project
 * rename, etc.). The pending transfer must be accepted, cancelled, or
 * allowed to expire (72h) before owner-side mutations resume.
 *
 * The error carries `transferId` (when the gateway resolved it) and
 * `cancelPath` lifted from `next_actions[].path`, so callers can present an
 * actionable resolution path. `previewPath` mirrors the view-transfer
 * next_action when present.
 */
export class TransferFreezeError extends Run402Error {
  static readonly DEFAULT_CODE = "PROJECT_HAS_PENDING_TRANSFER";
  static readonly DEFAULT_CATEGORY = "validation";
  static readonly DEFAULT_RETRYABLE = false;
  readonly kind = "transfer_freeze" as const;
  /** The pending transfer id when the gateway resolved one. */
  readonly transferId: string | null;
  /** API path to cancel the pending transfer (e.g. `/agent/v1/transfers/<id>/cancel`). */
  readonly cancelPath: string | null;
  /** API path to view the pending transfer preview. */
  readonly previewPath: string | null;
  readonly projectId: string | null;

  constructor(message: string, status: number, body: unknown, context: string) {
    super(message, status, body, context);
    const envelope =
      body && typeof body === "object" && !Array.isArray(body)
        ? (body as Record<string, unknown>)
        : null;
    const details =
      envelope && typeof envelope.details === "object" && envelope.details !== null
        ? (envelope.details as Record<string, unknown>)
        : null;
    this.transferId = typeof details?.transfer_id === "string" ? (details.transfer_id as string) : null;
    this.projectId = typeof details?.project_id === "string" ? (details.project_id as string) : null;
    const actions = Array.isArray(envelope?.next_actions) ? (envelope?.next_actions as unknown[]) : [];
    this.cancelPath = pickNextActionPath(actions, "cancel_transfer");
    this.previewPath = pickNextActionPath(actions, "view_transfer");
  }
}

/**
 * Known `type` values for a {@link NextAction}. The gateway set (style.md
 * §Errors) extended with the client-side bootstrap verbs `create_project` and
 * `initialize_wallet`, plus `operator_approve` (synthesized for WRITE_AUTH).
 * Tolerates unknown future gateway types via the `(string & {})` fallback.
 */
export type NextActionType =
  | "retry"
  | "poll"
  | "reconcile_payment"
  | "authenticate"
  | "submit_payment"
  | "renew_tier"
  | "check_usage"
  | "resume_deploy"
  | "edit_request"
  | "edit_migration"
  | "create_project"
  | "initialize_wallet"
  | "deploy"
  | "operator_approve"
  | "contact_support";

/**
 * A single advisory "what to do next" entry. Mirrors the gateway's
 * `next_actions[]` shape (`{ type, method?, path?, auth?, why? }`) extended with
 * `command` — the literal CLI invocation — for client-side, CLI-resolvable
 * actions. Rendering an action must never execute it.
 */
export interface NextAction {
  type: NextActionType | (string & {});
  /** Literal CLI invocation for client-side, CLI-resolvable actions. */
  command?: string;
  method?: string;
  path?: string;
  auth?: string;
  why?: string;
  [key: string]: unknown;
}

/**
 * Synthesize a canonical next action when the gateway returned a known error
 * code with an empty/absent `next_actions[]`. Mirrors the WRITE_AUTH synthesis
 * on {@link OperatorApprovalRequiredError}; only fills gaps, never overrides.
 */
function synthesizeNextActions(code: string | undefined): NextAction[] {
  switch (code) {
    case "AUTH_REQUIRED":
      return [
        {
          type: "authenticate",
          auth: "SIWX",
          why: "Provide SIWX wallet auth (or a session/delegate bearer) and retry the request.",
        },
      ];
    default:
      return [];
  }
}

function pickNextActionPath(actions: unknown[], type: string): string | null {
  for (const a of actions) {
    if (a && typeof a === "object" && !Array.isArray(a)) {
      const obj = a as Record<string, unknown>;
      if (obj.type === type && typeof obj.path === "string") return obj.path;
    }
  }
  return null;
}

/**
 * HTTP 403 `STEP_UP_REQUIRED` — the gateway requires a fresh, same-client
 * step-up (a recent `passkey` AMR) before this high-stakes control-plane
 * operation (delete / transfer / membership / invite / payment drain·rotate)
 * may proceed. A `device_flow`-minted session can never satisfy it; the caller
 * must complete the challenge at {@link challengeUrl} (e.g. via
 * `run402 operator login --step-up`) on the same client and retry.
 *
 * Typed fields are lifted from the gateway `details` envelope; the same
 * remediation pointer is also present in {@link Run402Error.nextActions} as an
 * `authenticate` action.
 */
export class StepUpRequiredError extends Run402Error {
  static readonly DEFAULT_CODE = "STEP_UP_REQUIRED";
  static readonly DEFAULT_CATEGORY = "auth";
  static readonly DEFAULT_RETRYABLE = false;
  readonly kind = "step_up_required" as const;
  /** AMRs that would satisfy the step-up (e.g. `["passkey"]`). Empty when the gateway omitted it. */
  readonly requiredAmr: string[];
  /** Max age in seconds the satisfying auth may be; null when the gateway omitted it. */
  readonly maxAgeSeconds: number | null;
  /** Where to run the step-up challenge; null when the gateway omitted it. */
  readonly challengeUrl: string | null;
  /** Why the step-up was demanded (e.g. `"device_flow_forbidden"`); null when absent. */
  readonly reason: string | null;

  constructor(message: string, status: number, body: unknown, context: string) {
    super(message, status, body, context);
    const envelope =
      body && typeof body === "object" && !Array.isArray(body)
        ? (body as Record<string, unknown>)
        : null;
    const details =
      envelope &&
      typeof envelope.details === "object" &&
      envelope.details !== null &&
      !Array.isArray(envelope.details)
        ? (envelope.details as Record<string, unknown>)
        : null;
    this.requiredAmr = Array.isArray(details?.required_amr)
      ? (details!.required_amr as unknown[]).filter((x): x is string => typeof x === "string")
      : [];
    this.maxAgeSeconds =
      typeof details?.max_age_seconds === "number" ? (details.max_age_seconds as number) : null;
    this.challengeUrl =
      typeof details?.challenge_url === "string" ? (details.challenge_url as string) : null;
    this.reason = typeof details?.reason === "string" ? (details.reason as string) : null;
  }

  override toJSON(): Record<string, unknown> {
    return {
      ...super.toJSON(),
      requiredAmr: this.requiredAmr,
      maxAgeSeconds: this.maxAgeSeconds,
      challengeUrl: this.challengeUrl,
      reason: this.reason,
    };
  }
}

/**
 * HTTP 403 — a wallet-less human (control-plane session) write needs a
 * passkey-fresh **operator approval** scoped to a specific `(capability,
 * target)`. Maps the gateway codes `WRITE_AUTH_REQUIRED` (no approval),
 * `WRITE_AUTH_BINDING_MISMATCH` (cached approval targeted the wrong org/project),
 * and `WRITE_AUTH_SESSION_INVALID` (stale approval).
 *
 * The gateway envelope is bare, so the SDK synthesizes a fully-resolved
 * remediation from the failing request's capability+target: read
 * {@link approveCommand} (e.g. `run402 operator approve --action project.deploy
 * --project prj_x`) or the structured {@link nextActions}. The SIWX wallet path
 * never triggers this. Never catch-and-swallow — surface the command to the
 * human/agent. Branch on `kind === "operator_approval_required"` (or
 * {@link isOperatorApprovalRequired}).
 */
export class OperatorApprovalRequiredError extends Run402Error {
  static readonly DEFAULT_CODE = "WRITE_AUTH_REQUIRED";
  static readonly DEFAULT_CATEGORY = "auth";
  static readonly DEFAULT_RETRYABLE = false;
  readonly kind = "operator_approval_required" as const;
  /** The principal class the approval belongs to. Always `"operator"` (the human). */
  readonly principal = "operator" as const;
  /** The gateway write capability needing approval, when known from the request. */
  readonly capability: string | null;
  /** The capability's target (`{ org_id }` or `{ project_id }`), when known. */
  readonly target: { org_id?: string; project_id?: string } | null;
  /** Fully-resolved CLI command that mints the missing approval, or null if unresolvable. */
  readonly approveCommand: string | null;

  constructor(
    message: string,
    status: number,
    body: unknown,
    context: string,
    meta?: { capability?: string | null; target?: { org_id?: string; project_id?: string } | null },
  ) {
    super(message, status, body, context);
    this.capability = meta?.capability ?? null;
    this.target = meta?.target ?? null;
    this.approveCommand = buildApproveCommand(this.capability, this.target);
    // The gateway WRITE_AUTH_* envelope carries no next_actions — synthesize a
    // structured one so generic consumers get the remediation too.
    if ((!this.nextActions || this.nextActions.length === 0) && this.approveCommand) {
      (this as { nextActions?: unknown[] }).nextActions = [
        { type: "operator_approve", command: this.approveCommand, why: approveWhy(this.code) },
      ];
    }
  }

  override toJSON(): Record<string, unknown> {
    return {
      ...super.toJSON(),
      principal: this.principal,
      capability: this.capability,
      target: this.target,
      approveCommand: this.approveCommand,
    };
  }
}

function buildApproveCommand(
  capability: string | null,
  target: { org_id?: string; project_id?: string } | null,
): string | null {
  if (!capability) return null;
  if (target?.org_id) return `run402 operator approve --action ${capability} --org ${target.org_id}`;
  if (target?.project_id) return `run402 operator approve --action ${capability} --project ${target.project_id}`;
  return `run402 operator approve --action ${capability}`;
}

function approveWhy(code?: string): string {
  if (code === "WRITE_AUTH_BINDING_MISMATCH")
    return "A cached approval targets a different org/project. Re-approve for this exact target.";
  if (code === "WRITE_AUTH_SESSION_INVALID")
    return "The cached approval is stale (its control-plane session changed). Re-approve.";
  return "This write needs a passkey operator approval.";
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

/** True if `e` is a local project credential-cache miss. */
export function isProjectCredentialNotFound(e: unknown): e is ProjectCredentialNotFound {
  return isLocalError(e) && e.code === "PROJECT_CREDENTIAL_NOT_FOUND";
}

/** True if `e` carries any stable project-credential error code. */
export function isProjectCredentialError(e: unknown): e is Run402Error & { code: ProjectCredentialErrorCode } {
  return isRun402Error(e) && typeof e.code === "string" && PROJECT_CREDENTIAL_ERROR_CODE_SET.has(e.code);
}

/** True if cached or supplied project credentials were rejected as invalid. */
export function isProjectCredentialInvalid(e: unknown): e is Run402Error & { code: "PROJECT_CREDENTIAL_INVALID" } {
  return isRun402Error(e) && e.code === "PROJECT_CREDENTIAL_INVALID";
}

/** True if cached or supplied project credentials were rejected as expired. */
export function isProjectCredentialExpired(e: unknown): e is Run402Error & { code: "PROJECT_CREDENTIAL_EXPIRED" } {
  return isRun402Error(e) && e.code === "PROJECT_CREDENTIAL_EXPIRED";
}

/** True if service-key auth was supplied for a different explicit project id. */
export function isProjectCredentialProjectMismatch(e: unknown): e is Run402Error & { code: "PROJECT_CREDENTIAL_PROJECT_MISMATCH" } {
  return isRun402Error(e) && e.code === "PROJECT_CREDENTIAL_PROJECT_MISMATCH";
}

/** True if `e` is an {@link Unauthorized}. */
export function isUnauthorized(e: unknown): e is Unauthorized {
  return isRun402Error(e) && e.kind === "unauthorized";
}

/** True if `e` is a {@link NotAuthorizedError} (org-owned control-plane denial, gateway v1.77+). */
export function isNotAuthorized(e: unknown): e is NotAuthorizedError {
  return isRun402Error(e) && e.kind === "not_authorized";
}

/** True if `e` is an {@link ApiError}. */
export function isApiError(e: unknown): e is ApiError {
  return isRun402Error(e) && e.kind === "api_error";
}

/** True if `e` is a {@link NetworkError}. */
export function isNetworkError(e: unknown): e is NetworkError {
  return isRun402Error(e) && e.kind === "network_error";
}

/** True if `e` is a phase-aware automatic x402 payment failure. */
export function isPaymentAttemptError(e: unknown): e is PaymentAttemptError {
  return isRun402Error(e) && e.kind === "payment_attempt_error";
}

/** True if `e` is a {@link LocalError}. */
export function isLocalError(e: unknown): e is LocalError {
  return isRun402Error(e) && e.kind === "local_error";
}

/** True if `e` is a {@link Run402DeployError}. */
export function isDeployError(e: unknown): e is Run402DeployError {
  return isRun402Error(e) && e.kind === "deploy_error";
}

/** True if `e` is a {@link TransferFreezeError}. */
export function isTransferFreezeError(e: unknown): e is TransferFreezeError {
  return isRun402Error(e) && e.kind === "transfer_freeze";
}

/** True if `e` is a {@link StepUpRequiredError}. Survives duplicate SDK copies and realms. */
export function isStepUpRequired(e: unknown): e is StepUpRequiredError {
  return isRun402Error(e) && e.kind === "step_up_required";
}

/** True if `e` is an {@link OperatorApprovalRequiredError} (wallet-less write needs a passkey approval). */
export function isOperatorApprovalRequired(e: unknown): e is OperatorApprovalRequiredError {
  return isRun402Error(e) && e.kind === "operator_approval_required";
}

/**
 * Extract the v1.46+ quota-denial scope from an error. Returns `"organization"`
 * for pooled denials, `"project"` for the orphan fallback, or `undefined`
 * when the error is not quota-related (or originated from a pre-v1.46
 * gateway that did not set `details.scope`). Safe to call with `unknown`.
 */
export function getQuotaScope(e: unknown): Run402QuotaScope | undefined {
  return isRun402Error(e) ? e.quotaScope : undefined;
}

/**
 * Canonical "should I retry this?" policy. Returns true when `e` is a
 * {@link Run402Error} AND any of:
 *   - `e.retryable === true` (gateway flagged it)
 *   - `e.kind === "network_error"` (fetch never produced a response)
 *   - `e.status` is 408 (Request Timeout), 425 (Too Early), or 429 (Too Many
 *     Requests)
 *   - `e.status` is a 5xx server error
 *
 * `safeToRetry` is deliberately NOT sufficient by itself: it means a repeated
 * mutation should not duplicate/corrupt state, not that the request can succeed
 * without a lifecycle/payment/auth action first.
 *
 * Returns false for non-Run402 errors so it can be safely called with
 * `unknown` from a catch block. Used as the default `retryIf` in
 * {@link withRetry}.
 */
export function isRetryableRun402Error(e: unknown): boolean {
  if (!isRun402Error(e)) return false;
  if (e.retryable === true) return true;
  if (e.kind === "deploy_error" && e.retryable === false) return false;
  if (hasExplicitRetryableFalse(e.body)) return false;
  if (e.kind === "network_error") return true;
  const s = e.status;
  if (s === 408 || s === 425 || s === 429) return true;
  if (typeof s === "number" && s >= 500) return true;
  return false;
}

function hasExplicitRetryableFalse(body: unknown): boolean {
  return Boolean(
    body &&
      typeof body === "object" &&
      !Array.isArray(body) &&
      Object.prototype.hasOwnProperty.call(body, "retryable") &&
      (body as Record<string, unknown>).retryable === false,
  );
}
