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

  constructor(message: string, status: number | null, body: unknown, context: string) {
    super(message);
    this.name = this.constructor.name;
    this.status = status;
    this.body = body;
    this.context = context;
  }
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
