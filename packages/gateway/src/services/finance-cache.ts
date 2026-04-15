/**
 * Finance cache — TTL cache + in-flight request coalescer for /admin/finance.
 *
 * Why: the finance dashboard fires ~12 live Postgres queries per page load.
 * Two concurrent admin sessions once OOM-killed the gateway (2026-04-15 09:25
 * local, exit 137). Caching + coalescing collapses N concurrent opens into a
 * single DB round-trip set per (key, TTL-window).
 *
 * Operational switch: set `FINANCE_CACHE_TTL_MS=0` to disable caching entirely
 * while keeping coalescing (in-flight requests still share).
 */

export interface FinanceCacheOptions {
  ttlMs: number;
  now?: () => number;
}

export interface FinanceCacheGetOptions {
  refresh?: boolean;
}

export interface FinanceCache {
  get<T>(
    key: string,
    fetcher: () => Promise<T>,
    opts?: FinanceCacheGetOptions,
  ): Promise<T>;
  invalidate(key?: string): void;
}

interface CacheEntry {
  value: unknown;
  expiresAt: number;
}

export function createFinanceCache(opts: FinanceCacheOptions): FinanceCache {
  const ttlMs = opts.ttlMs;
  const now = opts.now ?? Date.now;
  const entries = new Map<string, CacheEntry>();
  const inFlight = new Map<string, Promise<unknown>>();

  return {
    async get<T>(
      key: string,
      fetcher: () => Promise<T>,
      getOpts?: FinanceCacheGetOptions,
    ): Promise<T> {
      const refresh = getOpts?.refresh === true;

      if (!refresh && ttlMs > 0) {
        const cached = entries.get(key);
        if (cached && cached.expiresAt > now()) {
          return cached.value as T;
        }
      }

      // Coalesce: if a fetch for this key is already in flight, subscribe.
      // Skip coalescing on explicit refresh so the caller gets fresh data.
      if (!refresh) {
        const pending = inFlight.get(key);
        if (pending) return pending as Promise<T>;
      }

      const p = (async () => {
        try {
          const value = await fetcher();
          if (ttlMs > 0) {
            entries.set(key, { value, expiresAt: now() + ttlMs });
          }
          return value;
        } finally {
          inFlight.delete(key);
        }
      })();

      inFlight.set(key, p);
      return p;
    },

    invalidate(key?: string) {
      if (key === undefined) {
        entries.clear();
        return;
      }
      entries.delete(key);
    },
  };
}
