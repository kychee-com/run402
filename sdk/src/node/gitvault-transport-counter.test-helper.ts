/**
 * gitvault-client-round-trips (task 1.1) — the measuring stick.
 *
 * Counts TRANSPORT OPERATIONS (network round trips, not wall-clock — see
 * the client-surface spec's "Per-verb transport-operation budgets" — and
 * not raw method calls either, since one interface call can cost more than
 * one real round trip): each `GitvaultTransport` method costs exactly what
 * {@link createGitvaultHttpTransport} (the real, network-backed
 * implementation in `gitvault-publication.ts`) actually sends over the
 * wire to fulfill it —
 *
 *   - `getObject` on a generation-addressed path (a head or admission
 *     record, `getGenerationBytes`) — ONE direct GET.
 *   - `getObject` on an `object-reads`-addressed path (a carrier: ref_state,
 *     retention_roots, a WAL/checkpoint pack, …) — TWO: the presign POST
 *     plus the GET.
 *   - `getObjects` (design D2's plural sibling) for N objects — `1 + N`:
 *     one batched presign POST, then N GETs (concurrent, but concurrency
 *     changes wall-clock, never the op COUNT this file measures).
 *   - `uploadObjects`/`putObject` for N objects — `2 + N` when N > 0 (a
 *     session POST, N create-only PUTs, a finalize POST) — `putObject`
 *     always wraps exactly one object; zero objects costs nothing (the real
 *     transport's own early return).
 *   - every OTHER method — exactly one real HTTP request, so it costs 1.
 *     A Proxy default handles these automatically, so a transport method
 *     added later is counted correctly with no edit here.
 *
 * Wraps ANY `GitvaultTransport` implementation (the in-memory test fixture
 * in the counted-budget tests; nothing stops it wrapping the real HTTP
 * transport too) — it never touches storage or crypto itself, only counts.
 */

import { gitvaultWireRefForPath } from "./gitvault-publication.js";
import type { GitvaultTransport } from "./gitvault-publication.js";

/** One counted unit, tagged by kind — `ops.length` is the total; group by kind for a breakdown. */
export class GitvaultOpCounter {
  readonly ops: string[] = [];

  count(kind: string, n = 1): void {
    for (let i = 0; i < n; i++) this.ops.push(kind);
  }

  get total(): number {
    return this.ops.length;
  }

  reset(): void {
    this.ops.length = 0;
  }

  /** Op kind → count, for a human-readable assertion failure message. */
  byKind(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const op of this.ops) out[op] = (out[op] ?? 0) + 1;
    return out;
  }
}

/**
 * A per-test assertion helper: fails with the op-kind breakdown attached
 * (not just a bare number), so a budget regression names WHICH operation
 * grew instead of leaving that to a follow-up debugging session.
 */
export function assertOpBudget(counter: GitvaultOpCounter, budget: number, label: string): void {
  if (counter.total > budget) {
    throw new Error(`${label}: ${counter.total} transport op(s) exceeds the budget of ${budget} — breakdown: ${JSON.stringify(counter.byKind())}`);
  }
}

const VARIABLE_WEIGHT_METHODS = new Set(["getObject", "getObjects", "uploadObjects", "putObject"]);

/** Wrap `inner` so every call is counted into `counter`, then delegated unchanged. */
export function countingGitvaultTransport(inner: GitvaultTransport, counter: GitvaultOpCounter): GitvaultTransport {
  return new Proxy(inner, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== "function" || typeof prop !== "string") return value;

      if (prop === "getObject") {
        return async (req: { repo_id: string; path: string }) => {
          const ref = gitvaultWireRefForPath(req.path);
          if (ref && ref.kind === "object") counter.count("object-read(presign+get)", 2);
          else counter.count("generation-read", 1);
          return Reflect.apply(value, target, [req]);
        };
      }
      if (prop === "getObjects") {
        return async (req: { repo_id: string; paths: string[] }) => {
          if (req.paths.length > 0) {
            counter.count("object-reads-batch(presign)", 1);
            counter.count("object-reads-batch(get)", req.paths.length);
          }
          return Reflect.apply(value, target, [req]);
        };
      }
      if (prop === "uploadObjects") {
        return async (req: { repo_id: string; objects: unknown[]; resource_binding?: unknown }) => {
          if (req.objects.length > 0) {
            counter.count("upload-session", 1);
            counter.count("upload-put", req.objects.length);
            counter.count("upload-finalize", 1);
          }
          return Reflect.apply(value, target, [req]);
        };
      }
      if (prop === "putObject") {
        return async (req: unknown) => {
          counter.count("upload-session", 1);
          counter.count("upload-put", 1);
          counter.count("upload-finalize", 1);
          return Reflect.apply(value, target, [req]);
        };
      }
      if (VARIABLE_WEIGHT_METHODS.has(prop)) return value; // unreachable (every case above returns) — keeps the set/switch honest under future edits

      // Every other GitvaultTransport method — one real HTTP request per call.
      return async (...args: unknown[]) => {
        counter.count(prop);
        return Reflect.apply(value, target, args);
      };
    },
  });
}
