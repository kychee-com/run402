/**
 * `r.diagnostics` — anonymous reachability probes, owned by the Node SDK.
 *
 * `probeOrigin(url)` makes one bounded, unauthenticated `GET` that never
 * follows a redirect and never reads more of the body than it must, and
 * CLASSIFIES the outcome, so a caller can tell a DNS failure from a TLS
 * failure from a redirect from an HTTP error from success — distinctions an
 * SDK request (which retries, authenticates, and parses) deliberately
 * erases. `r.buzz.doctor()` measures the Run402 API and console origins with
 * it; nothing else needs a raw `fetch` of its own for this.
 */

/** How a probe ended. `ok` is a 2xx; `redirect` a 3xx (never followed); `http` any other status. */
export type OriginClassification = "ok" | "dns" | "tls" | "redirect" | "http" | "timeout" | "network";

export interface OriginProbeResult {
  /** True exactly for a 2xx. */
  reachable: boolean;
  classification: OriginClassification;
  /** The HTTP status, when a response arrived. */
  status?: number;
  /** The `Location` of a redirect, when one was answered. */
  redirect_to?: string;
  /** The failure, classified and bounded (never the raw transport message). */
  error?: string;
  elapsed_ms: number;
}

export interface ProbeOriginOptions {
  /** Abort after this many milliseconds. Default 3000. */
  timeoutMs?: number;
  /** The `Accept` header sent. */
  accept?: string;
}

/** Classify a transport failure from its message, code, and cause. */
export function classifyTransportFailure(error: unknown): { classification: Exclude<OriginClassification, "ok" | "http">; error: string } {
  const e = error as { name?: string; message?: string; code?: string; cause?: { message?: string; code?: string } } | null;
  if (e?.name === "AbortError") return { classification: "timeout", error: "timeout" };
  const text = error instanceof Error
    ? `${e!.message} ${e!.code ?? ""} ${e!.cause?.message ?? ""} ${e!.cause?.code ?? ""}`
    : String(error);
  if (/certificate|tls|ssl|eproto|secure tls connection|handshake/i.test(text)) return { classification: "tls", error: "tls_handshake_failed" };
  if (/dns|dns_empty|getaddrinfo|enotfound|eai_again/i.test(text)) return { classification: "dns", error: "dns" };
  if (/timeout|timed out|abort/i.test(text)) return { classification: "timeout", error: "timeout" };
  if (/redirect/i.test(text)) return { classification: "redirect", error: "redirect_rejected" };
  return { classification: "network", error: "network" };
}

export class Diagnostics {
  /**
   * One anonymous `GET` of `url`, bounded by `timeoutMs`, redirects never
   * followed, the body discarded. Never throws for a network outcome: every
   * failure is a classification.
   */
  async probeOrigin(url: string | URL, opts: ProbeOriginOptions = {}): Promise<OriginProbeResult> {
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 3_000);
    try {
      const response = await fetch(url, {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
        headers: { accept: opts.accept ?? "application/json,text/html;q=0.5" },
      });
      await response.body?.cancel().catch(() => {});
      const elapsed_ms = Date.now() - started;
      const status = response.status;
      if (status >= 200 && status < 300) return { reachable: true, classification: "ok", status, elapsed_ms };
      if (status >= 300 && status < 400) {
        const location = response.headers.get("location");
        return { reachable: false, classification: "redirect", status, ...(location ? { redirect_to: location } : {}), error: `http_${status}`, elapsed_ms };
      }
      return { reachable: false, classification: "http", status, error: `http_${status}`, elapsed_ms };
    } catch (err) {
      const failure = classifyTransportFailure(err);
      return { reachable: false, classification: failure.classification, error: failure.error, elapsed_ms: Date.now() - started };
    } finally {
      clearTimeout(timer);
    }
  }
}
