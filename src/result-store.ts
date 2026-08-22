/**
 * The bounded result store for the LOSSY surface.
 *
 * MCP is the lossy surface (docs/agent-response-design.md): a tool result is
 * text in an agent's context window, so a listing that would be fine as JSON
 * over HTTP is a context bomb here. The rule that follows is "truncate the
 * VIEW, never the DATA":
 *
 *   1. the FULL result is persisted under an opaque `ref`,
 *   2. the tool returns a bounded window plus `shown` / `total` — so the agent
 *      is TOLD it is looking at a slice, never left to infer it, and
 *   3. `expand_result` is the affordance that fetches the rest.
 *
 * A tool that renders `items.slice(0, 20)` and says nothing is the failure this
 * module exists to prevent: the agent reads twenty rows, concludes there are
 * twenty, and acts on a number that is wrong.
 *
 * BOUNDS. The store is in-process (it dies with the server, which is correct —
 * a ref is a handle on THIS session's answer, not a cache) and doubly bounded:
 * at most {@link RESULT_STORE_MAX_ENTRIES} results are retained, oldest evicted
 * first, and every entry expires {@link RESULT_STORE_TTL_MS} after it was
 * stored. A long-lived agent host cannot grow this without limit. TTL runs from
 * the STORE time and is not refreshed by reads, so a ref cannot be kept alive
 * forever by polling it.
 *
 * SECRET-BEARING RESULTS ARE NEVER STORED. `secret: true` returns the bounded
 * view with `ref: null` and writes nothing — enforced here, in code, not by
 * convention at the call sites. Per docs/agent-response-design.md a
 * secret-bearing response is never cached, never persisted into an
 * agent-surface result store, and never logged; a one-shot credential (a
 * maintenance lease's `holder_token`, a freshly minted key) that landed in a
 * retained buffer would be readable for the next half hour by anything that
 * could name its ref.
 */

import { randomBytes } from "node:crypto";

/** How many results are retained at once. Oldest is evicted first. */
export const RESULT_STORE_MAX_ENTRIES = 32;

/** How long a stored result stays addressable, measured from the store time. */
export const RESULT_STORE_TTL_MS = 30 * 60 * 1000;

/** The default window a tool shows inline before pointing at `expand_result`. */
export const RESULT_STORE_DEFAULT_SHOWN = 20;

/** `expand_result`'s default page size when the caller does not ask for one. */
export const RESULT_STORE_DEFAULT_EXPAND_LIMIT = 100;

/** The ceiling on one `expand_result` window — the surface stays bounded even when expanded. */
export const RESULT_STORE_MAX_EXPAND_LIMIT = 1000;

/** What a tool returns inline: a window, honestly labelled, plus the handle to the rest. */
export interface StoredResultView<T> {
  /** The handle `expand_result` takes. `null` when nothing was stored (a secret-bearing result). */
  ref: string | null;
  /** How many items are in {@link items} — the size of the VIEW. */
  shown: number;
  /** How many items exist in total — the size of the DATA. */
  total: number;
  items: T[];
}

/** One window of a previously stored result. */
export interface ExpandedResult {
  ref: string;
  /** What produced it, e.g. `gitvault_heads`. Lets the caller render it sensibly. */
  kind: string;
  offset: number;
  shown: number;
  total: number;
  items: unknown[];
}

interface StoredEntry {
  kind: string;
  items: unknown[];
  stored_at: number;
}

/** Insertion-ordered, so the first key is always the oldest entry. */
const entries = new Map<string, StoredEntry>();

let now: () => number = () => Date.now();

/**
 * Persist the full result and return a bounded view of it.
 *
 * @param kind   What produced this, e.g. `gitvault_heads`. Echoed by `expand_result`.
 * @param items  The COMPLETE list. Never pre-truncate before calling this.
 * @param opts.shown   Window size. Defaults to {@link RESULT_STORE_DEFAULT_SHOWN}.
 * @param opts.secret  `true` ⇒ store NOTHING and return `ref: null`. See the module header.
 */
export function storeResult<T>(
  kind: string,
  items: T[],
  opts: { shown?: number; secret?: boolean } = {},
): StoredResultView<T> {
  const shown = clampShown(opts.shown);
  const view = items.slice(0, shown);

  // The hard rule, enforced before anything is written: a secret-bearing result
  // is never retained, so it never has a ref that could fetch it back.
  if (opts.secret === true) {
    return { ref: null, shown: view.length, total: items.length, items: view };
  }

  pruneExpired();
  while (entries.size >= RESULT_STORE_MAX_ENTRIES) {
    const oldest = entries.keys().next();
    if (oldest.done) break;
    entries.delete(oldest.value);
  }

  const ref = newRef();
  entries.set(ref, { kind, items: [...items], stored_at: now() });
  return { ref, shown: view.length, total: items.length, items: view };
}

/**
 * Read a window of a stored result.
 *
 * Returns `null` when the ref is unknown, already evicted, or expired — the
 * three are deliberately indistinguishable, because the caller's recovery is
 * the same in all three cases: re-run the tool that produced it.
 */
export function expandResult(
  ref: string,
  opts: { offset?: number; limit?: number } = {},
): ExpandedResult | null {
  pruneExpired();
  const entry = entries.get(ref);
  if (!entry) return null;

  const offset = clampOffset(opts.offset, entry.items.length);
  const limit = clampExpandLimit(opts.limit);
  const items = entry.items.slice(offset, offset + limit);
  return { ref, kind: entry.kind, offset, shown: items.length, total: entry.items.length, items };
}

/** Drop every retained result. Test-only, and the server's own reset if it ever needs one. */
export function _resetResultStore(): void {
  entries.clear();
}

/** Override the clock so TTL behaviour is testable without sleeping. Test-only; `null` restores it. */
export function _setResultStoreClock(clock: (() => number) | null): void {
  now = clock ?? (() => Date.now());
}

/** How many results are currently retained. Test-only introspection. */
export function _resultStoreSize(): number {
  pruneExpired();
  return entries.size;
}

function pruneExpired(): void {
  const cutoff = now() - RESULT_STORE_TTL_MS;
  for (const [ref, entry] of entries) {
    // Insertion order is store order, so the first non-expired entry ends it.
    if (entry.stored_at > cutoff) break;
    entries.delete(ref);
  }
}

function newRef(): string {
  return `res_${randomBytes(8).toString("hex")}`;
}

function clampShown(shown: number | undefined): number {
  if (shown === undefined || !Number.isFinite(shown)) return RESULT_STORE_DEFAULT_SHOWN;
  return Math.max(0, Math.floor(shown));
}

function clampOffset(offset: number | undefined, total: number): number {
  if (offset === undefined || !Number.isFinite(offset)) return 0;
  return Math.min(Math.max(0, Math.floor(offset)), Math.max(0, total));
}

function clampExpandLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return RESULT_STORE_DEFAULT_EXPAND_LIMIT;
  return Math.min(Math.max(1, Math.floor(limit)), RESULT_STORE_MAX_EXPAND_LIMIT);
}
