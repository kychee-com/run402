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
 *     The kernel stays the one caller of the SDK's transport fetch for
 *     REQUEST traffic; this is connection plumbing on the OWNED dispatcher
 *     (gitvault-owned-dispatcher), so the warmed socket lands in the exact
 *     per-origin pool — the API origin's single multiplexed Client — that
 *     the verb's first request draws from. That non-kernel fetch is
 *     sanctioned here and nowhere else.
 */
import { getApiBase } from "../../core-dist/config.js";
import { getAllowanceAuthHeaders } from "../../core-dist/allowance-auth.js";
import { sdkFetch } from "./http-dispatcher.js";

/** Injectable for tests. */
export const prewarmDeps: {
  fetch: typeof globalThis.fetch;
  warmSigner: () => unknown;
  warmPaidStack: () => unknown;
} = {
  // The OWNED dispatcher, deliberately (gitvault-owned-dispatcher D5): the
  // warmed socket must land in the exact pool the verb's first request
  // draws from — warming the built-in dispatcher would warm the wrong one.
  fetch: (...args) => sdkFetch(...args),
  // One throwaway header build against the local allowance: reads the file
  // and runs the first EIP-191 sign, so the curve library's precomputation
  // happens now instead of inside the verb's first authenticated request.
  // Returns null harmlessly when no allowance is configured.
  warmSigner: () => getAllowanceAuthHeaders("/health"),
  // The verb's first kernel request initializes the paid-fetch buyer, whose
  // dominant cost is the dynamic viem/@x402 (or mpp) stack import (~360 ms
  // measured). Every verb pays it exactly once regardless, so loading it
  // during the prewarm wastes nothing and overlaps it with git's local
  // plumbing (gitvault-owned-dispatcher — the first-op decomposition that
  // motivated this: ~360 ms stack + ~200 ms dial + ~120 ms request).
  warmPaidStack: () => {
    void (async () => {
      const [{ loadX402Stack, loadMppStack }, { readAllowance }] = await Promise.all([import("./_paid-stack.js"), import("../../core-dist/allowance.js")]);
      const rail = (readAllowance() as { rail?: string } | null)?.rail;
      await (rail === "mpp" ? loadMppStack() : loadX402Stack());
    })().catch(() => {});
  },
};

/**
 * The connection-dial half alone (gitvault-first-op-premium task 2.1 —
 * "pre-connect on session accept"). A RESIDENT daemon already ran the full
 * prewarm (dial + signer + paid-stack) exactly once at boot; re-running
 * `warmPaidStack` on every forwarded session was measured to cost an EXTRA
 * ~150-300ms per session (two live Base RPC probes, `sepolia.base.org` +
 * `mainnet.base.org`, that a gitvault session never actually needs) for no
 * benefit — the paid-fetch buyer stack only needs loading once per process.
 * This is the narrow half a session-accept hook should call: kick the owned
 * dispatcher's connection (so a dead/never-dialed socket redials NOW,
 * overlapping git's own helper handshake) and nothing else. Same contract as
 * the full prewarm: fire-and-forget, every failure swallowed, no side effects.
 */
export function kickGitvaultConnection(apiBase?: string): void {
  try {
    const base = apiBase ?? getApiBase();
    void prewarmDeps
      .fetch(new URL("/health", base), { signal: AbortSignal.timeout(5000) })
      .then((r) => void r.body?.cancel().catch(() => {}))
      .catch(() => {});
  } catch {
    /* a malformed base or missing fetch must never reach a verb */
  }
}

/**
 * Start the connection + signer prewarm. Returns immediately; nothing to
 * await, nothing thrown, ever. Call this ONCE per process (verb startup, or
 * daemon boot) — see `kickGitvaultConnection` for the narrower, repeatable
 * connection-only half a resident daemon should use per forwarded session.
 */
export function prewarmGitvaultConnection(apiBase?: string): void {
  kickGitvaultConnection(apiBase);
  // Deferred so a remote helper's `capabilities` reply is never delayed by
  // the synchronous sign — the warmup only has to land before the verb's
  // first authenticated request, which is several stdin exchanges away.
  setImmediate(() => {
    try {
      prewarmDeps.warmSigner();
    } catch {
      /* no allowance / unreadable file — the verb's own auth path reports it */
    }
    try {
      prewarmDeps.warmPaidStack();
    } catch {
      /* stack load failure surfaces from the verb's own first request */
    }
  });
}
