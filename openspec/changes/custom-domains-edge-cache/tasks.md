# Tasks: custom-domains-edge-cache

## 1. Baseline measurement

- [x] 1.1 Capture a "before" trace: `curl -sI https://kychon.com/<any-image>` x2 — record absence of `cf-cache-status` / `age`, and note response time for each call. [manual]

## 2. Worker change

- [x] 2.1 In `workers/custom-domains/src/index.ts`, update `fetchFromS3` (or its caller in the static-asset branch of the main handler) to pass a `cf` option on the `fetch(s3Url, ...)` call for non-HTML paths. Use `cacheEverything: true` + `cacheTtlByStatus: { "200-299": 31536000, "404": 60, "500-599": 0 }`. Do NOT add `cf:` options when fetching HTML (the HTML path has its own `max-age=60` semantics). [code]
- [x] 2.2 Keep the response `Cache-Control: public, max-age=31536000, immutable` header unchanged — it still governs browser cache. [code]
- [x] 2.3 Propagate the subrequest's `cf-cache-status` onto the outer response as `x-cache-status` (Worker-generated responses never carry `cf-cache-status`, so this is the only externally visible signal that caching is working). [code]

## 3. Unit-level check

- [x] 3.1 Run `cd workers/custom-domains && npx tsc --noEmit` — TypeScript clean. Worker has no existing unit tests; do not add one for this change (cache behavior is observable only in CF's network). [code]

## 4. Deploy the Worker

- [x] 4.1 `cd workers/custom-domains && npx wrangler deploy` — deploy `run402-custom-domains`. Confirm deploy output shows the new version ID. [ship]

## 5. E2E verification on kychon.com

- [x] 5.1 `curl -sI https://kychon.com/<image>?bust=<unique>` with a cache-busting query string — first call: `x-cache-status: MISS`, ~593ms. [manual]
- [x] 5.2 Second call within ~10s — `x-cache-status: HIT`, ~33ms. [manual]
- [x] 5.3 Measured cold-vs-warm delta: 593ms → 33ms (~18× improvement). Recorded in implementation log. [manual]

## 6. Redeploy safety check

- [ ] 6.1 Trigger a `kychon.com` redeploy (or any custom-domain site you control) via the normal deploy path. [manual]
- [ ] 6.2 Hit the same asset path twice post-redeploy — expect MISS then HIT on the *new* deployment's URL. Confirms deployment-id-scoped cache keys work as expected. [manual]

## 7. Archive

- [ ] 7.1 Move change to `openspec/changes/archive/` with date suffix after all checks pass. [manual]

## Implementation Log

### 2026-04-14 — Initial implementation and verification

**Baseline (before deploy):**
```
curl -sI https://kychon.com/assets/screenshot-barrio.png
# No cf-cache-status, no age header. 60ms per call.
```

**Code change:**
- `workers/custom-domains/src/index.ts`:
  - Added `isHtml` parameter to `fetchFromS3(env, key, isHtml)`.
  - Non-HTML path passes `cf: { cacheEverything: true, cacheTtlByStatus: { "200-299": 31536000, "404": 60, "500-599": 0 } }` on `fetch(s3Url, ...)`.
  - HTML path unchanged (omits `cf:` block).
  - Static-asset outer response now includes `x-cache-status` header propagated from the subrequest (CF doesn't set `cf-cache-status` on Worker-generated responses).

**Deploy:**
- Wrangler deploy: `98c10e6a-25e5-48d4-bd53-2bd7fe4f4aa3` (first version deployed was `beede4d5...` without `x-cache-status`; redeployed with debug header).

**E2E verification (cache-busted URL to force a cold first hit):**
```
https://kychon.com/assets/screenshot-eagles.png?bust=1776186236
Call 1: x-cache-status: MISS, 593ms
Call 2: x-cache-status: HIT, 33ms
Call 3: x-cache-status: HIT, 42ms
```
~18× latency improvement on warm requests. Subrequest-level edge caching confirmed working.

**Design note discovered during verification:** The original tasks.md expected `cf-cache-status: HIT` and an `age:` header on the outer response. Neither appears, because any Worker-generated response bypasses CF's edge-tier cache-status semantics — CF only attaches those headers when it serves directly from the edge cache without a Worker in the path. The fix: propagate the subrequest's `cf-cache-status` as a custom `x-cache-status` header on the outer response. Added task 2.3 to cover this.
