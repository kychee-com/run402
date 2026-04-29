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
  PaymentRequired,
  Unauthorized,
} from "./errors.js";
import type { CredentialsProvider, ProjectKeys } from "./credentials.js";

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
  /** Short verb phrase attached to thrown errors (e.g. "provisioning project"). */
  context: string;
}

/** Internal client surface passed to each namespace. */
export interface Client {
  /** API base URL, e.g. `https://api.run402.com`. Exposed for namespaces that need to compute derived URLs (e.g. REST endpoints). */
  readonly apiBase: string;
  request<T>(path: string, opts: RequestOptions): Promise<T>;
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
  const { apiBase, fetch, credentials } = kernel;
  const { method = "GET", headers = {}, body, rawBody, withAuth = true, context } = opts;
  const url = `${apiBase}${path}`;

  const fetchHeaders: Record<string, string> = { ...headers };

  if (withAuth) {
    const auth = await credentials.getAuth(path);
    if (auth) {
      for (const [k, v] of Object.entries(auth)) {
        if (!(k in fetchHeaders)) fetchHeaders[k] = v;
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

  if (res.ok) return resBody as T;

  if (res.status === 402) {
    throw new PaymentRequired(
      `${displayMessage(resBody, "Payment required")} while ${context}`,
      402,
      resBody,
      context,
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

export function buildClient(kernel: KernelConfig): Client {
  return {
    apiBase: kernel.apiBase,
    request: <T>(path: string, opts: RequestOptions) => request<T>(kernel, path, opts),
    getProject: (id: string) => kernel.credentials.getProject(id),
    credentials: kernel.credentials,
    fetch: kernel.fetch,
  };
}
