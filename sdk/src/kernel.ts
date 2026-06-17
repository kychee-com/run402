/**
 * Request kernel — the one place in the SDK that touches `fetch`.
 *
 * Isomorphic: uses only platform globals, no Node-only APIs. The kernel is
 * safe to execute inside a V8 isolate where `fs`, `child_process`, and
 * `process` are absent.
 *
 * Failure translation: maps HTTP status codes and network errors to the
 * appropriate {@link Run402Error} subclass. Callers never see `undefined`
 * or a response-shaped error value — they either get the parsed body as T
 * or an exception.
 */

import {
  ApiError,
  NetworkError,
  NotAuthorizedError,
  OperatorApprovalRequiredError,
  PaymentRequired,
  StepUpRequiredError,
  TransferFreezeError,
  Unauthorized,
} from "./errors.js";

/** Gateway 403 codes that mean "a passkey operator approval is needed for this (capability, target)". */
const WRITE_AUTH_CODES = new Set([
  "WRITE_AUTH_REQUIRED",
  "WRITE_AUTH_BINDING_MISMATCH",
  "WRITE_AUTH_SESSION_INVALID",
]);
import type { AuthRequestMeta, CredentialsProvider, ProjectKeys } from "./credentials.js";

export interface KernelConfig {
  apiBase: string;
  fetch: typeof globalThis.fetch;
  credentials: CredentialsProvider;
}

export interface RequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  /** Send body as a raw string (e.g. `text/plain` SQL) or bytes, skipping JSON.stringify. */
  rawBody?: string | Uint8Array;
  /** Include credential headers from `credentials.getAuth(path)`. Default: true. */
  withAuth?: boolean;
  /** Optional write capability + target, passed to `getAuth` for operator-approval matching. */
  authMeta?: AuthRequestMeta;
  /** Short verb phrase attached to thrown errors (e.g. "provisioning project"). */
  context: string;
}

export interface ResponseEnvelope<T = unknown> {
  status: number;
  body: T;
}

/** Internal client surface passed to each namespace. */
export interface Client {
  /** API base URL, e.g. `https://api.run402.com`. Exposed for namespaces that need to compute derived URLs (e.g. REST endpoints). */
  readonly apiBase: string;
  request<T>(path: string, opts: RequestOptions): Promise<T>;
  requestWithResponse<T>(path: string, opts: RequestOptions): Promise<ResponseEnvelope<T>>;
  getProject(id: string): Promise<ProjectKeys | null>;
  /** The underlying credentials provider. Namespaces use this to access optional methods (saveProject, setActiveProject, ...). */
  readonly credentials: CredentialsProvider;
  /**
   * The injected fetch (or default `globalThis.fetch`). Namespaces use this
   * when they need to hit a non-gateway URL — e.g. an S3 presigned URL from
   * a multipart upload, where auth + apiBase injection would be wrong.
   */
  readonly fetch: typeof globalThis.fetch;
}

export async function request<T>(
  kernel: KernelConfig,
  path: string,
  opts: RequestOptions,
): Promise<T> {
  return (await requestWithResponse<T>(kernel, path, opts)).body;
}

/**
 * Auth header families. If a request explicitly sets ANY of these, it owns its
 * credentials and the kernel will not merge a provider auth header alongside —
 * preventing duplicate/contradictory credentials once dual-header auth exists.
 */
const AUTH_HEADER_NAMES = ["authorization", "sign-in-with-x", "x-run402-write-auth"];

/** Case-insensitive header presence check. */
function hasHeader(headers: Record<string, string>, name: string): boolean {
  const lower = name.toLowerCase();
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === lower) return true;
  }
  return false;
}

export async function requestWithResponse<T>(
  kernel: KernelConfig,
  path: string,
  opts: RequestOptions,
): Promise<ResponseEnvelope<T>> {
  const { apiBase, fetch, credentials } = kernel;
  const { method = "GET", headers = {}, body, rawBody, withAuth = true, context } = opts;
  const url = `${apiBase}${path}`;

  const fetchHeaders: Record<string, string> = { ...headers };

  if (withAuth) {
    const auth = await credentials.getAuth(path, opts.authMeta);
    if (auth) {
      // Credential-family atomicity: if the request already set any auth header
      // (any casing), it owns its credentials — never merge provider auth over
      // or beside it. Other provider headers still merge (case-insensitively).
      const requestOwnsAuth = AUTH_HEADER_NAMES.some((h) => hasHeader(fetchHeaders, h));
      for (const [k, v] of Object.entries(auth)) {
        if (hasHeader(fetchHeaders, k)) continue;
        if (requestOwnsAuth && AUTH_HEADER_NAMES.includes(k.toLowerCase())) continue;
        fetchHeaders[k] = v;
      }
    }
  }

  let fetchBody: string | Uint8Array | undefined;
  if (rawBody !== undefined) {
    fetchBody = rawBody;
  } else if (body !== undefined) {
    if (!("Content-Type" in fetchHeaders) && !("content-type" in fetchHeaders)) {
      fetchHeaders["Content-Type"] = "application/json";
    }
    fetchBody = JSON.stringify(body);
  }

  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: fetchHeaders,
      body: fetchBody as BodyInit | undefined,
    });
  } catch (err) {
    throw new NetworkError(
      `Network error while ${context}: ${(err as Error).message}`,
      err,
      context,
    );
  }

  const ct = res.headers.get("content-type") ?? "";
  let resBody: unknown;
  if (ct.includes("application/json")) {
    resBody = await res.json().catch(() => null);
  } else {
    resBody = await res.text();
  }

  if (res.ok) return { status: res.status, body: resBody as T };

  if (res.status === 402) {
    throw new PaymentRequired(
      `${displayMessage(resBody, "Payment required")} while ${context}`,
      402,
      resBody,
      context,
    );
  }
  if (res.status === 403 && envelopeCode(resBody) === "STEP_UP_REQUIRED") {
    throw new StepUpRequiredError(
      `${displayMessage(resBody, "Step-up authentication required")} while ${context}`,
      res.status,
      resBody,
      context,
    );
  }
  if (res.status === 403 && envelopeCode(resBody) === "NOT_AUTHORIZED") {
    // Org-owned control-plane denial (gateway v1.77+): authenticated but lacks
    // the required org membership/role or per-project grant. Distinct from a
    // generic 401/403 so callers can prompt for access, not re-authentication.
    throw new NotAuthorizedError(
      `${displayMessage(resBody, "Not authorized")} while ${context} (HTTP ${res.status})`,
      res.status,
      resBody,
      context,
    );
  }
  if (res.status === 403 && WRITE_AUTH_CODES.has(envelopeCode(resBody) ?? "")) {
    throw new OperatorApprovalRequiredError(
      `${displayMessage(resBody, "Operator approval required")} while ${context}`,
      res.status,
      resBody,
      context,
      { capability: opts.authMeta?.capability ?? null, target: opts.authMeta?.target ?? null },
    );
  }
  if (res.status === 401 || res.status === 403) {
    throw new Unauthorized(
      `${displayMessage(resBody, "Unauthorized")} while ${context} (HTTP ${res.status})`,
      res.status,
      resBody,
      context,
    );
  }
  if (res.status === 409 && envelopeCode(resBody) === "PROJECT_HAS_PENDING_TRANSFER") {
    throw new TransferFreezeError(
      `${displayMessage(resBody, "Project has a pending transfer")} while ${context}`,
      res.status,
      resBody,
      context,
    );
  }

  throw new ApiError(
    `${displayMessage(resBody, "API error")} while ${context} (HTTP ${res.status})`,
    res.status,
    resBody,
    context,
  );
}

function displayMessage(body: unknown, fallback: string): string {
  if (body && typeof body === "object" && !Array.isArray(body)) {
    const obj = body as Record<string, unknown>;
    if (typeof obj.message === "string" && obj.message.length > 0) return obj.message;
    if (typeof obj.error === "string" && obj.error.length > 0) return obj.error;
  }
  return fallback;
}

function envelopeCode(body: unknown): string | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const code = (body as Record<string, unknown>).code;
  return typeof code === "string" ? code : null;
}

export function buildClient(kernel: KernelConfig): Client {
  return {
    apiBase: kernel.apiBase,
    request: <T>(path: string, opts: RequestOptions) => request<T>(kernel, path, opts),
    requestWithResponse: <T>(path: string, opts: RequestOptions) =>
      requestWithResponse<T>(kernel, path, opts),
    getProject: (id: string) => kernel.credentials.getProject(id),
    credentials: kernel.credentials,
    fetch: kernel.fetch,
  };
}
