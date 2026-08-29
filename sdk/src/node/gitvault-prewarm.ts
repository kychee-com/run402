/**
 * gitvault-connection-amortization (bench P5) — boot-time prewarm for the
 * gitvault verb paths.
 *
 * The 4.53.0 benchmark retest showed a fresh `git push`/`git fetch` process
 * pays a ~650–700 ms premium on whichever transport op runs FIRST (DNS +
 * TCP + TLS to the API origin, plus the signer's first-use curve-table
 * build) — invariant to which op that is, so removing round trips just
 * moves it. This module moves the setup OFF the verb's critical path by
 * starting it concurrently with the local work every invocation already
 * does (git's capabilities/option/list stdin exchange, keystore reads,
 * offline pin resolution).
 *
 * Guarantees (spec-pinned in gitvault-client-surface, "Verb startup
 * amortizes connection setup off the critical path"):
 *   - fire-and-forget: `void` return, never awaited on any verb path;
 *   - every failure is swallowed — an unreachable gateway surfaces exactly
 *     once, from the verb's own first operation, exactly as without this;
 *   - never holds the process open (abort timer unref'd via
 *     AbortSignal.timeout; response body cancelled immediately);
 *   - ZERO footprint on the counted transport budgets, `sdk.stats()`, and
 *     `RUN402_TRACE` — deliberately NOT routed through the request kernel.
 *     The kernel stays the one caller of `globalThis.fetch` for REQUEST
 *     traffic; this is connection plumbing on the same global dispatcher,
 *     so the warmed socket lands in the exact per-origin pool the verb's
 *     first request draws from. That non-kernel fetch is sanctioned here
 *     and nowhere else.
 */
import { getApiBase } from "../../core-dist/config.js";
import { getAllowanceAuthHeaders } from "../../core-dist/allowance-auth.js";

/** Injectable for tests. */
export const prewarmDeps: {
  fetch: typeof globalThis.fetch;
  warmSigner: () => unknown;
} = {
  fetch: (...args) => globalThis.fetch(...args),
  // One throwaway header build against the local allowance: reads the file
  // and runs the first EIP-191 sign, so the curve library's precomputation
  // happens now instead of inside the verb's first authenticated request.
  // Returns null harmlessly when no allowance is configured.
  warmSigner: () => getAllowanceAuthHeaders("/health"),
};

/**
 * Start the connection + signer prewarm. Returns immediately; nothing to
 * await, nothing thrown, ever.
 */
export function prewarmGitvaultConnection(apiBase?: string): void {
  try {
    const base = apiBase ?? getApiBase();
    void prewarmDeps
      .fetch(new URL("/health", base), { signal: AbortSignal.timeout(5000) })
      .then((r) => void r.body?.cancel().catch(() => {}))
      .catch(() => {});
  } catch {
    /* a malformed base or missing fetch must never reach a verb */
  }
  // Deferred so a remote helper's `capabilities` reply is never delayed by
  // the synchronous sign — the warmup only has to land before the verb's
  // first authenticated request, which is several stdin exchanges away.
  setImmediate(() => {
    try {
      prewarmDeps.warmSigner();
    } catch {
      /* no allowance / unreadable file — the verb's own auth path reports it */
    }
  });
}
