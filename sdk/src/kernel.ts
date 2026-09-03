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
  isRun402Error,
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
  clientMetadata?: Run402ClientMetadata | false;
  /**
   * Per-client observability accumulator, mutated by every request made
   * through this kernel config. Set by {@link buildClient} — a fresh
   * {@link ClientStats} object per `Run402` instance, monotonic (no reset)
   * for the instance's lifetime. Exposed to callers via `Client.stats()` /
   * `Run402.stats()`. Not meant to be set directly by SDK consumers.
   * @internal
   */
  stats?: ClientStats;
}

export interface Run402ClientMetadata {
  surface?: string;
  version?: string;
  sdkVersion?: string;
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
  /**
   * Logical retry attempt number, surfaced verbatim in the `RUN402_TRACE`
   * line's `attempt=<n>` field. Default 1 — the kernel itself never retries
   * a request; a caller that re-issues the same logical request after a
   * higher-level retry (e.g. a safe release-race replan) may pass an
   * incrementing value so the trace reads as one logical operation's history
   * rather than unrelated single-attempt calls.
   */
  attempt?: number;
}

/** Cumulative request-kernel observability for one SDK instance (`Run402.stats()`). Monotonic — never resets. */
export interface ClientStats {
  /** Number of fetch calls made (successful or not). */
  round_trips: number;
  /** Summed wall-clock time spent in fetch + body read, in milliseconds. */
  wire_ms: number;
  /** Summed request body bytes sent, where knowable. */
  bytes_up: number;
  /** Summed response body bytes received (Content-Length when present, measured otherwise). */
  bytes_down: number;
}

function emptyClientStats(): ClientStats {
  return { round_trips: 0, wire_ms: 0, bytes_up: 0, bytes_down: 0 };
}

function recordClientStats(stats: ClientStats | undefined, delta: { ms: number; up: number; down: number }): void {
  if (!stats) return;
  stats.round_trips += 1;
  stats.wire_ms += Math.round(delta.ms);
  stats.bytes_up += delta.up;
  stats.bytes_down += delta.down;
}

/** Monotonic clock, isomorphic-safe (`performance.now()` when present, else `Date.now()`). */
function nowMs(): number {
  try {
    if (typeof performance !== "undefined" && typeof performance.now === "function") return performance.now();
  } catch {
    // fall through to Date.now()
  }
  return Date.now();
}

/** Exact byte length of a request/response body payload. */
function byteLength(value: string | Uint8Array | undefined): number {
  if (value === undefined) return 0;
  if (typeof value === "string") {
    try {
      return new TextEncoder().encode(value).length;
    } catch {
      return value.length;
    }
  }
  return value.byteLength;
}

/**
 * `RUN402_TRACE`: any non-empty value enables one stderr line per request.
 * Feature-detects `process`/`process.env` so this isomorphic file never
 * throws in a runtime (browser, V8 isolate) that lacks either.
 */
function traceEnabled(): boolean {
  try {
    return typeof process !== "undefined" && typeof process.env === "object" && process.env !== null &&
      typeof process.env.RUN402_TRACE === "string" && process.env.RUN402_TRACE.length > 0;
  } catch {
    return false;
  }
}

/**
 * `r402 <METHOD> <path> -> <status> <ms>ms attempt=<n>` on stderr — path
 * WITHOUT its query string, never headers, never bodies, never tokens (same
 * redaction posture as the Node payment-attempt journal). `status` is `ERR`
 * for a request that never got a response (network failure).
 */
function traceLine(method: string, path: string, status: number | "ERR", ms: number, attempt: number): void {
  if (!traceEnabled()) return;
  const pathOnly = path.split("?")[0];
  const line = `r402 ${method} ${pathOnly} -> ${status} ${Math.round(ms)}ms attempt=${attempt}\n`;
  try {
    if (typeof process !== "undefined" && process.stderr && typeof process.stderr.write === "function") {
      process.stderr.write(line);
      return;
    }
  } catch {
    // fall through to console.error
  }
  try {
    if (typeof console !== "undefined" && typeof console.error === "function") console.error(line.trimEnd());
  } catch {
    // tracing must never break a request
  }
}

/**
 * What the seller's `PAYMENT-RESPONSE` receipt says actually settled.
 *
 * OBSERVED, never inferred. `network` is the chain the payment landed on
 * according to the settlement receipt — not a guess from local wallet config.
 * That distinction is the point: a caller must be able to tell a real payment
 * from a testnet one, and a buyer holding mainnet funds makes any config-derived
 * guess wrong.
 */
export interface PaymentSettlement {
  success: boolean;
  network: string;
  transaction: string;
  payer: string | null;
}

export interface ResponseEnvelope<T = unknown> {
  status: number;
  body: T;
  /**
   * Present only when the response carried an x402 settlement receipt, i.e.
   * this request actually moved money. Absent/`null` means no payment was made
   * on this request — NOT that a payment failed.
   */
  settlement?: PaymentSettlement | null;
}

/**
 * Decode the `PAYMENT-RESPONSE` receipt if the response carries one.
 *
 * Deliberately total: a malformed or unexpected receipt yields `null` rather
 * than throwing. A caller asking "what did I just pay?" must never have its
 * SUCCESSFUL response turned into an error by a reporting concern.
 *
 * Strict receipt VALIDATION — matching the receipt against the challenge the
 * buyer accepted — belongs to the paid-fetch buyer path, which does it. This is
 * disclosure of what the seller reported, and is labelled as such.
 */
export function decodeSettlementReceipt(res: {
  headers: { get(name: string): string | null };
}): PaymentSettlement | null {
  const header = res.headers.get("PAYMENT-RESPONSE") ?? res.headers.get("X-PAYMENT-RESPONSE");
  if (!header) return null;
  try {
    const json =
      typeof atob === "function" ? atob(header) : Buffer.from(header, "base64").toString("utf8");
    const raw = JSON.parse(json) as Record<string, unknown>;
    if (typeof raw.network !== "string" || typeof raw.transaction !== "string") return null;
    return {
      success: raw.success === true,
      network: raw.network,
      transaction: raw.transaction,
      payer: typeof raw.payer === "string" ? raw.payer : null,
    };
  } catch {
    return null;
  }
}

/** Internal client surface passed to each namespace. */
export interface Client {
  /** API base URL, e.g. `https://api.run402.com`. Exposed for namespaces that need to compute derived URLs (e.g. REST endpoints). */
  readonly apiBase: string;
  request<T>(path: string, opts: RequestOptions): Promise<T>;
  requestWithResponse<T>(path: string, opts: RequestOptions): Promise<ResponseEnvelope<T>>;
  getProjectCredentials(id: string): Promise<ProjectKeys | null>;
  /** @deprecated Use getProjectCredentials. */
  getProject(id: string): Promise<ProjectKeys | null>;
  /** The underlying credentials provider. Namespaces use this to access optional methods (saveProject, setActiveProject, ...). */
  readonly credentials: CredentialsProvider;
  /**
   * The injected fetch (or default `globalThis.fetch`). Namespaces use this
   * when they need to hit a non-gateway URL — e.g. an S3 presigned URL from
   * a multipart upload, where auth + apiBase injection would be wrong.
   */
  readonly fetch: typeof globalThis.fetch;
  /** Cumulative observability for this client instance. See {@link ClientStats}. */
  stats(): ClientStats;
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
  const { method = "GET", headers = {}, body, rawBody, withAuth = true, context, attempt = 1 } = opts;
  const url = `${apiBase}${path}`;

  const fetchHeaders: Record<string, string> = { ...headers };
  for (const [k, v] of Object.entries(clientMetadataHeaders(kernel.clientMetadata))) {
    if (!hasHeader(fetchHeaders, k)) fetchHeaders[k] = v;
  }

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

  const upBytes = byteLength(fetchBody);
  const startedAt = nowMs();
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: fetchHeaders,
      body: fetchBody as BodyInit | undefined,
    });
  } catch (err) {
    const elapsed = nowMs() - startedAt;
    recordClientStats(kernel.stats, { ms: elapsed, up: upBytes, down: 0 });
    traceLine(method, path, "ERR", elapsed, attempt);
    // The kernel's `fetch` is injectable, and the paid clients inject an x402
    // payment fetch. That fetch throws DOMAIN errors, not just transport ones —
    // a confirmed balance miss (`X402_INSUFFICIENT_FUNDS`) surfaces here exactly
    // like a dead socket would. Those errors arrive fully classified
    // (`category: "payment_required"`, `retryable: false`, a `fund_wallet`
    // next_action, the actual balances and requirements in `details`).
    //
    // Blanket-wrapping them as NetworkError destroyed all of it: a buyer whose
    // wallet ran dry was told `NETWORK_ERROR` / `retryable: true` and given no
    // remedy, so a retrying agent would loop forever on a condition that only
    // funding can clear.
    //
    // Anything already carrying the Run402 brand is a classified SDK error and
    // is strictly more informative than the wrapper — pass it through untouched.
    // Genuine transport faults are unbranded and still become NetworkError.
    if (isRun402Error(err)) throw err;
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

  const elapsed = nowMs() - startedAt;
  const downBytes = measureDownBytes(res, resBody, ct);
  recordClientStats(kernel.stats, { ms: elapsed, up: upBytes, down: downBytes });
  traceLine(method, path, res.status, elapsed, attempt);

  if (res.ok) {
    // OMIT the key entirely when no payment settled, rather than setting null.
    // `restResponse` hands this envelope straight to CLI/MCP shims, and callers
    // compare it by exact shape — always adding the key silently widened a
    // public surface for every consumer to serve a field only paid responses
    // use. Caught by an existing deepEqual test, which was right to fail.
    const settlement = decodeSettlementReceipt(res);
    return settlement
      ? { status: res.status, body: resBody as T, settlement }
      : { status: res.status, body: resBody as T };
  }

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

/** Response body bytes: `Content-Length` when present and well-formed, else measured from the parsed body. */
function measureDownBytes(res: { headers: { get(name: string): string | null } }, resBody: unknown, ct: string): number {
  const headerLen = res.headers.get("content-length");
  if (headerLen !== null) {
    const n = Number(headerLen);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  try {
    if (typeof resBody === "string") return byteLength(resBody);
    if (ct.includes("application/json") && resBody !== null && resBody !== undefined) {
      return byteLength(JSON.stringify(resBody));
    }
  } catch {
    // best-effort measurement only
  }
  return 0;
}

function envelopeCode(body: unknown): string | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const code = (body as Record<string, unknown>).code;
  return typeof code === "string" ? code : null;
}

export function buildClient(kernel: KernelConfig): Client {
  // One stats accumulator per client: every request this `Run402` instance
  // makes (directly or through a namespace) mutates the SAME object, because
  // every closure below captures `kernelWithStats`, not the caller's `kernel`.
  const stats: ClientStats = kernel.stats ?? emptyClientStats();
  const kernelWithStats: KernelConfig = kernel.stats === stats ? kernel : { ...kernel, stats };
  const getProjectCredentials = (id: string) =>
    kernel.credentials.getProjectCredentials
      ? kernel.credentials.getProjectCredentials(id)
      : kernel.credentials.getProject?.(id) ?? Promise.resolve(null);
  return {
    apiBase: kernel.apiBase,
    request: <T>(path: string, opts: RequestOptions) => request<T>(kernelWithStats, path, opts),
    requestWithResponse: <T>(path: string, opts: RequestOptions) =>
      requestWithResponse<T>(kernelWithStats, path, opts),
    getProjectCredentials,
    getProject: getProjectCredentials,
    credentials: kernel.credentials,
    fetch: kernel.fetch,
    stats: () => ({ ...stats }),
  };
}

export function clientMetadataHeaders(metadata: KernelConfig["clientMetadata"]): Record<string, string> {
  if (!metadata || typeof metadata !== "object") return {};
  const parts: string[] = [];
  const surface = sanitizeMetadataToken(metadata.surface, 40);
  const version = sanitizeMetadataToken(metadata.version, 64);
  const sdk = sanitizeMetadataToken(metadata.sdkVersion, 64);
  if (surface) parts.push(`surface=${quoteStructuredValue(surface)}`);
  if (version) parts.push(`version=${quoteStructuredValue(version)}`);
  if (sdk) parts.push(`sdk=${quoteStructuredValue(sdk)}`);
  const value = parts.join(", ");
  if (!value || value.length > 200) return {};
  return { "Run402-Client": value };
}

function sanitizeMetadataToken(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxLength) return null;
  if (!/^[A-Za-z0-9_.+-]+$/.test(trimmed)) return null;
  return trimmed;
}

function quoteStructuredValue(value: string): string {
  return `"${value.replace(/["\\]/g, "\\$&")}"`;
}
