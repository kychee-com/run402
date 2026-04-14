# Proposal: custom-domains-edge-cache

**Status:** Ready to implement
**Severity:** Medium — user-visible perf regression. Custom-domain sites built on Run402 currently re-fetch every image from S3 on every request, even though the Worker sets `cache-control: public, max-age=31536000, immutable`. CloudFront-style edge caching is silently disabled.

## Problem

The `run402-custom-domains` Worker serves static assets for every custom-domain site (e.g. `kychon.com`). The response includes the correct immutable caching directives:

```
cache-control: public, max-age=31536000, immutable
```

But Cloudflare's edge does not honor it:

```
$ curl -sI https://kychon.com/logo.png | grep -iE "cache|age"
cache-control: public, max-age=31536000, immutable
# no cf-cache-status, no age header
```

Every image request reaches the Worker → S3, every time. Browser cache works, but cold visitors, cross-colo requests, and every new session pay full origin latency.

## Root cause

Two distinct CF behaviors conspire:

1. **Worker responses skip the edge cache by default.** A response returned from `fetch` handler is not automatically placed in CF's edge cache, regardless of `cache-control`. `cache-control` governs the *browser*, not CF's edge tier.
2. **Worker subrequests skip the cache by default.** `fetch(s3Url)` without `cf:` hints does not cache the S3 response, because S3 returns no `cache-control` and CF treats unknown-cacheability origins as uncacheable.

Current code (`workers/custom-domains/src/index.ts`):

```ts
const s3Response = await fetchFromS3(env, s3Key);  // no cf:{} hints
// ...
return new Response(s3Response.body, {
  headers: {
    "Content-Type": contentType,
    "Cache-Control": "public, max-age=31536000, immutable",  // browser-only
  },
});
```

## Fix

Force-cache S3 subrequests for non-HTML assets using `cf.cacheEverything` + `cf.cacheTtlByStatus`. HTML stays uncached (short max-age=60 is intentional for fork-badge freshness — out of scope).

```ts
return fetch(url, {
  headers: { Host: host, "x-amz-date": amzDate, /* sigv4 */ },
  cf: {
    cacheEverything: true,
    cacheTtlByStatus: {
      "200-299": 31536000,
      "404": 60,
      "500-599": 0,
    },
  },
});
```

## Why this is safe and invalidation-free

The S3 object key already embeds the deployment ID: `sites/${deploymentId}/${relativePath}`. Each redeploy writes to a new deployment ID, so the cache key (which CF derives from the subrequest URL) naturally changes on every redeploy. Old cache entries age out on their own; new entries appear on first hit. **No manual cache purge is ever required.**

Contrast with the gateway's CloudFront flow, which must explicitly call `CreateInvalidation` on subdomain redeploy — that machinery is not needed here because the cache key is deployment-scoped by construction.

## Non-goals

- **HTML caching.** HTML responses already set `cache-control: public, max-age=60` and are hostname-specific (fork-badge injection). Caching HTML at the edge would work but is outside this change's scope; user priority is images and static assets.
- **Cache-key customization.** We use CF's default URL-based cache key. The SigV4 `x-amz-date` and `Authorization` headers differ per request, but CF's subrequest cache key ignores request headers by default, so signature rotation does not fragment the cache.
- **Tiered cache / Cache Reserve.** Enabling these zone-level features would amplify the hit rate further, but they're dashboard-level toggles unrelated to the Worker code. Recommend enabling separately after this ships.
- **SigV4 deferral.** The Worker still constructs a fresh SigV4 signature per request even on a cache hit (because the `fetch` call is made before CF decides to serve from cache). That CPU cost is ~1ms and not worth optimizing unless it becomes a Worker CPU-time bottleneck.

## Alternatives considered

1. **`caches.default` on the outer response.** Explicit cache using Workers Cache API. Would also cache the Worker's own response-shaping (content-type, cache-control header), not just the S3 body. Rejected as the primary approach — more code, same invalidation guarantees (deployment-id-in-URL). Kept as an option if `cf.cacheEverything` shows unexpected edge cases.
2. **Cache Rules in the CF dashboard.** Force cache on URL patterns matching image extensions. Rejected — config lives out-of-repo, not version-controlled, hard to reproduce across zones (we'd need rules on every custom zone like `kychon.com`).
3. **Long `cache-control: s-maxage=...` on Worker response.** Does not help because Worker responses bypass edge cache regardless of headers unless `caches.default` is used explicitly.

## Verification

- **Unit-ish:** Wrangler local dev + manual request — not useful for this (cache lives in CF's network, not in `workerd`).
- **E2E:** After deploy, hit `https://kychon.com/<image>` twice with `curl -sI`. First response: no `cf-cache-status` or `cf-cache-status: MISS`. Second response within ~10s: `cf-cache-status: HIT`, `age: <small>`.
- **Regression:** The existing CDN e2e (`test/cdn-e2e.ts`) covers custom-subdomain caching via CloudFront, not custom-domain caching via CF Worker. Add a parallel test or extend an existing one to assert `cf-cache-status: HIT` on a warm image hit.
- **Redeploy safety:** Redeploy `kychon.com`'s site, confirm new asset URLs get new deployment IDs in S3, confirm second hit is still `HIT` (new entry, not stale).
