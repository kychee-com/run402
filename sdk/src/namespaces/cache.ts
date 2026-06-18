/**
 * `cache` namespace — SSR origin cache inspection and invalidation.
 *
 * Capability `ssr-isr-cache` (Run402 v1.52). Used by AI coding agents
 * and CLI tooling to invalidate cached SSR responses after admin
 * content edits, OR to inspect what's currently cached.
 *
 * All operations are project-scoped: the SDK reads the active project
 * from the credentials provider, and the gateway enforces host
 * ownership (cross-project hosts throw
 * `R402_CACHE_INVALIDATION_HOST_FORBIDDEN`).
 *
 * @see https://docs.run402.com/cache/concepts
 */

import type { Client } from "../kernel.js";
import { LocalError } from "../errors.js";

export interface CacheInvalidateResult {
  /** Number of cache rows DELETEd by this call. */
  deleted: number;
  /** Post-increment generation for the affected (project, host). Used
   *  by the generation guard to prevent in-flight MISS renders from
   *  overwriting after invalidation. */
  generation: string;
  /** The host the invalidation targeted. Empty string for bulk calls
   *  that span multiple hosts. */
  host: string;
  /** Path targeted (single-URL form only). */
  path?: string;
  /** Per-host results for bulk invalidation. */
  results?: Array<{ host: string; deleted: number; generation: string }>;
}

export interface CacheInspectOptions {
  /** Inspect a non-default-locale row. */
  locale?: string;
  /** Inspect a non-active-release row. */
  releaseId?: string;
}

export interface CacheInspectResult {
  /** `HIT` when a fresh row exists; `MISS` when no fresh row.
   *  NEVER `BYPASS` — inspect doesn't issue a request. */
  status: "HIT" | "MISS";
  url?: string;
  host?: string;
  path?: string;
  search?: string;
  method?: string;
  locale?: string;
  release_id?: string;
  cached_at?: string;
  expires_at?: string;
  written_under_generation?: string;
  content_sha256?: string;
  headers?: Record<string, string | string[]>;
}

export interface CacheInvalidatePrefixOptions {
  host: string;
  prefix: string;
}

export interface CacheInvalidateAllOptions {
  host: string;
}

export class Cache {
  constructor(private readonly client: Client) {}

  /**
   * Invalidate a single cached SSR response.
   *
   * @param url - Absolute URL (e.g., `https://eagles.kychon.com/the-guys`).
   *              The host MUST be owned by the SDK's active project;
   *              cross-project calls throw `R402_CACHE_INVALIDATION_HOST_FORBIDDEN`.
   */
  async invalidate(url: string | URL): Promise<CacheInvalidateResult> {
    const u = url instanceof URL ? url : new URL(url);
    return this.client.request<CacheInvalidateResult>("/cache/v1/invalidate", {
      method: "POST",
      body: {
        kind: "exact",
        host: u.host.toLowerCase(),
        path: u.pathname + (u.search || ""),
      },
      context: "invalidating cache (exact URL)",
    });
  }

  /**
   * Invalidate all cache rows under a path prefix on the given host.
   */
  async invalidatePrefix(opts: CacheInvalidatePrefixOptions): Promise<CacheInvalidateResult> {
    if (!opts.prefix.startsWith("/")) {
      throw new LocalError(
        "cache.invalidatePrefix: prefix must start with '/'",
        "invalidating cache (prefix)",
      );
    }
    return this.client.request<CacheInvalidateResult>("/cache/v1/invalidate", {
      method: "POST",
      body: {
        kind: "prefix",
        host: opts.host.toLowerCase(),
        prefix: opts.prefix,
      },
      context: "invalidating cache (prefix)",
    });
  }

  /**
   * Invalidate ALL cache rows for the given host. Use for catastrophic
   * content changes (nav restructure, layout-wide update, etc.) where
   * targeted invalidation would be impractical.
   */
  async invalidateAll(opts: CacheInvalidateAllOptions): Promise<CacheInvalidateResult> {
    return this.client.request<CacheInvalidateResult>("/cache/v1/invalidate", {
      method: "POST",
      body: {
        kind: "all",
        host: opts.host.toLowerCase(),
      },
      context: "invalidating cache (all)",
    });
  }

  /**
   * Bulk-invalidate many absolute URLs in a single round-trip. Groups
   * by host and issues one transaction per host.
   */
  async invalidateMany(urls: Array<string | URL>): Promise<CacheInvalidateResult> {
    const normalized = urls.map((u) => (u instanceof URL ? u.toString() : u));
    return this.client.request<CacheInvalidateResult>("/cache/v1/invalidate", {
      method: "POST",
      body: { kind: "many", urls: normalized },
      context: "invalidating cache (many)",
    });
  }

  /**
   * Inspect the cache row state for a URL. Returns `{ status: 'HIT' | 'MISS', ... }`.
   * Does NOT issue a request to the URL.
   *
   * @param url - Absolute URL.
   * @param options - Optional `--locale` / `--release-id` overrides.
   */
  async inspect(url: string | URL, options: CacheInspectOptions = {}): Promise<CacheInspectResult> {
    const u = url instanceof URL ? url : new URL(url);
    const params = new URLSearchParams();
    params.set("host", u.host.toLowerCase());
    params.set("path", u.pathname + (u.search || ""));
    if (options.locale) params.set("locale", options.locale);
    if (options.releaseId) params.set("release_id", options.releaseId);
    const result = await this.client.request<CacheInspectResult>(
      `/cache/v1/inspect?${params.toString()}`,
      { context: "inspecting cache" },
    );
    return { ...result, url: url.toString() };
  }
}
