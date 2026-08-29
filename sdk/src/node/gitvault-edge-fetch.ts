/**
 * gitvault — CDN-edge read preference + silent fallback (gitvault-read-edge-
 * cache, task 2.4, design D5).
 *
 * The gateway's `POST …/object-reads` (and the composite `GET …/state`
 * read's carrier arm) optionally accompanies its presigned `url` with an
 * `edge_url` naming the SAME bytes, for the five immutable ciphertext kinds
 * eligible for edge caching (`wal_pack`, `ref_state`, `retention_roots`,
 * `checkpoint_manifest`, `checkpoint_pack`) — ABSENT (never `null`) when the
 * platform's edge is unconfigured or the object's kind is ineligible.
 * `edge_url` is a pure transport optimization: every caller verifies the
 * bytes it gets back against pins/receipts identically regardless of which
 * URL served them, so this module carries NO verification logic of its own
 * and is invisible to a caller except as latency.
 *
 * Policy (D5, pinned by the change proposal — do not relitigate here):
 * prefer `edge_url` when present; on ANY edge failure — a thrown fetch
 * error, or a response that is not `ok` (INCLUDING a 404, so an object's
 * actual "absent" signal still comes from `url`, the unchanged source of
 * truth) — silently fall back to `url` for that read AND stop attempting
 * `edge_url` for the remainder of THIS PROCESS. No retry loop, no warning,
 * no new log line; a caller's result and errors flow exactly as they would
 * reading `url` directly, both on the happy path and on fallback.
 *
 * Deliberately a standalone module with no imports of its own, rather than
 * folded into `gitvault-publication.ts` and exported from there:
 * `gitvault-mirror.ts` reimplements its own presigned-read call site
 * specifically so it has NO dependency on the live-push module (see that
 * file's own header comment). Routing both call sites through this one tiny
 * sibling instead keeps that independence intact while STILL sharing the
 * same per-process fallback state — one edge failure anywhere in the
 * process disables edge for the rest of it, not just for whichever module's
 * call site happened to see the failure first.
 */

/**
 * Anything with a `.fetch` shaped like the global one. A `Client`
 * (`sdk/src/kernel.ts`) satisfies this structurally with no cast needed —
 * this module just never imports the `Client` type itself, so it stays
 * usable from any call site without pulling in the kernel.
 */
export interface GitvaultEdgeFetchClient {
  fetch: typeof globalThis.fetch;
}

/**
 * One `object-reads` entry, or the composite state read's carrier arm
 * (`presigned_url` renamed to `url` at the call site) — normalized to the
 * shape this module needs: the always-present authoritative URL, plus the
 * optional same-bytes edge URL.
 */
export interface GitvaultEdgeReadTarget {
  url: string;
  edge_url?: string;
}

/**
 * Process-lifetime, deliberately NOT per-repo/per-vault/per-object: one
 * edge failure anywhere stops every subsequent attempt at `edge_url` for
 * the rest of this process, across every call site that shares this module.
 */
let gitvaultEdgeDisabledForProcess = false;

/**
 * @internal Test seam; not re-exported from `@run402/sdk/node`. Resets the
 * process-lifetime "edge already failed once" flag between test cases.
 */
export function _resetGitvaultEdgeFetchStateForTest(): void {
  gitvaultEdgeDisabledForProcess = false;
}

/**
 * Fetch one gitvault object's bytes, preferring `target.edge_url` over
 * `target.url` per the policy above. Returns the same kind of `Response` a
 * plain `client.fetch(target.url, init)` would — this function never
 * inspects or decodes the body and never throws on a non-ok response; only
 * a thrown fetch error against `url` itself propagates, exactly as it does
 * today for every existing caller.
 */
export async function fetchGitvaultObjectBytes(
  client: GitvaultEdgeFetchClient,
  target: GitvaultEdgeReadTarget,
  init: RequestInit = { method: "GET" },
): Promise<Response> {
  if (target.edge_url && !gitvaultEdgeDisabledForProcess) {
    try {
      const r = await client.fetch(target.edge_url, init);
      if (r.ok) return r;
    } catch {
      // a thrown (network) fetch error against the edge — fall through to `url` below
    }
    gitvaultEdgeDisabledForProcess = true;
  }
  return client.fetch(target.url, init);
}
