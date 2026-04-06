## Context

Custom subdomains (`{name}.run402.com`) currently route through ALB → Express subdomain middleware → S3 GetObject for every request. The middleware resolves the subdomain name to a deployment ID via a 60-second in-memory cache backed by Postgres, fetches the file from S3, injects a fork badge into HTML responses, and serves the result with `Cache-Control: public, max-age=3600` for assets and `max-age=60` for HTML.

Deployment URLs (`*.sites.run402.com`) already use CloudFront with a CloudFront Function that extracts the deployment ID from the hostname and rewrites the S3 path. Those files are served with `max-age=31536000, immutable` — no staleness issues because each deploy gets a unique `dpl_` prefix.

The gap: custom subdomains don't change their URL on redeploy, so browser-cached assets go stale for up to 1 hour.

## Goals / Non-Goals

**Goals:**
- Edge-cache static assets for custom subdomains globally (same performance as `*.sites.run402.com`)
- Eliminate stale assets after redeploy (the original user complaint)
- Preserve fork badge injection on HTML responses
- Zero breaking changes to deploy API, subdomain API, or MCP tools
- Improve resilience (assets survive gateway restarts)

**Non-Goals:**
- Moving HTML serving to the edge (fork badge requires gateway compute)
- Per-subdomain analytics dashboards
- Custom domain support (e.g., `myapp.com` → Run402 deployment)
- CloudFront Functions for HTML transformation

## Decisions

### 1. Split-origin CloudFront distribution (assets at edge, HTML at ALB)

**Decision:** One CloudFront distribution for `*.run402.com` with two cache behaviors:
- **Default behavior** (catch-all): ALB origin. Serves HTML, API fallback. `max-age=60`.
- **Asset behavior** (`*.css`, `*.js`, `*.png`, `*.jpg`, `*.gif`, `*.svg`, `*.ico`, `*.woff`, `*.woff2`, `*.webp`, `*.map`, `*.json` excluding `/rest/`, `/functions/`, `/projects/`, etc.): S3 origin via CloudFront Function + KVS lookup. Immutable caching.

**Alternatives considered:**
- *Full CDN (all requests to S3):* Can't inject fork badge without Lambda@Edge + DynamoDB global table. Over-engineered.
- *Lower max-age only:* Trivial fix but doesn't solve the core problem (stale URLs) and wastes bandwidth.
- *Content-hash rewriting:* Requires HTML parsing at deploy time. Brittle, doesn't handle all asset references.

**Rationale:** ~90% of bandwidth is assets. Edge-caching those eliminates the staleness problem and improves global performance. HTML still goes through the gateway for fork badge injection, keeping that logic simple and database-backed.

### 2. CloudFront KeyValueStore for subdomain → deployment ID mapping

**Decision:** Use CloudFront KeyValueStore (KVS) instead of Lambda@Edge for the subdomain lookup.

**Alternatives considered:**
- *Lambda@Edge origin-request:* Full Node.js runtime, can query DynamoDB. But: cold starts (100-500ms), must deploy in us-east-1, complex lifecycle, higher cost ($0.60/M + duration), painful debugging (logs scattered across edge regions).
- *CloudFront Function with hardcoded mappings:* No external state needed but requires redeploying the function on every subdomain change. Doesn't scale.

**Rationale:** KVS is co-located with CloudFront Functions at every edge — reads are <1ms with no network call. 5MB total storage fits ~50,000+ subdomain mappings. Updates propagate globally in <1 second. The gateway already has exactly 3 mutation points for subdomains (`createOrUpdateSubdomain`, `deleteSubdomain`, `deleteProjectSubdomains`) — adding a KVS put/delete to each is trivial.

### 3. Asset behavior pattern matching (not path-based)

**Decision:** Use file extension patterns to distinguish assets from HTML/API routes, not path prefixes.

CloudFront cache behavior order:
1. `/rest/v1/*` → ALB (API, no caching)
2. `/functions/v1/*` → ALB (API, no caching)
3. `/projects/v1/*` → ALB (API, no caching)
4. `/tiers/v1/*` → ALB (API, no caching)
5. `/auth/v1/*` → ALB (API, no caching)
6. `/health` → ALB (API, no caching)
7. `*.css`, `*.js`, `*.png`, `*.jpg`, `*.gif`, `*.svg`, `*.ico`, `*.woff`, `*.woff2`, `*.webp`, `*.map` → S3 via KVS (immutable cache)
8. Default (`*`) → ALB (HTML, fork badge, `max-age=60`)

**Rationale:** Custom subdomains share the `*.run402.com` wildcard with API routes. CloudFront must route API traffic to the ALB untouched. Explicit API path exclusions (behaviors 1-6) ensure API requests never hit S3. Asset extensions (behavior 7) are safe because user-deployed files are always under a subdomain host, not `api.run402.com`.

Wait — actually, CloudFront behaviors match on path patterns, but the Host header determines whether this is `api.run402.com` or `myapp.run402.com`. The existing `api.run402.com` DNS points to the ALB directly. If we make `*.run402.com` point to CloudFront, then `api.run402.com` would also hit CloudFront.

**Revised decision:** Either:
- (a) Keep `api.run402.com` as an explicit A record pointing to ALB (Route53 explicit record takes priority over wildcard), OR
- (b) Add a CloudFront behavior that forwards `api.run402.com` traffic to ALB with caching disabled.

Option (a) is simpler — the existing `api.run402.com` Route53 record already points to the ALB. A wildcard `*.run402.com` record pointing to CloudFront won't override it. Custom subdomains go through CloudFront; `api.run402.com` stays on ALB directly.

### 4. Gateway subdomain middleware: HTML-only after migration

**Decision:** After CloudFront handles asset serving, simplify the subdomain middleware to only handle requests that reach the ALB (HTML and any cache misses). The middleware still:
- Resolves subdomain → deployment ID (from DB, with in-memory cache)
- Fetches HTML from S3
- Injects fork badge
- Returns with `Cache-Control: public, max-age=60`

Remove the asset-serving code path from the middleware. If an asset request somehow reaches the gateway (CloudFront miss, direct ALB access), serve it but with a short TTL rather than the old 1-hour TTL.

### 5. KVS sync: write-through with periodic reconciliation

**Decision:** Update KVS synchronously on every subdomain mutation (write-through). Add a periodic reconciliation check (every 5 minutes) that diffs DB vs KVS and fixes drift.

**Sync points in `subdomains.ts`:**
1. `createOrUpdateSubdomain()` line 172 → after DB upsert, `kvs.put(name, deploymentId)`
2. `deleteSubdomain()` line 256 → after DB delete, `kvs.delete(name)`
3. `deleteProjectSubdomains()` line 274 → for each deleted name, `kvs.delete(name)`

**Failure handling:** If KVS put/delete fails, log the error (Bugsnag) but don't fail the API request. The reconciliation job will fix it within 5 minutes. KVS is the cache; DB is the source of truth.

## Risks / Trade-offs

**[Risk] KVS out of sync with DB** → Subdomain serves wrong deployment or 404s for assets.
*Mitigation:* Write-through sync + 5-minute reconciliation job. KVS propagation is <1s. Monitor reconciliation drift count.

**[Risk] `*.run402.com` wildcard cert** → Current ACM cert is for `*.sites.run402.com` only. Need a separate cert for `*.run402.com` or a multi-domain cert.
*Mitigation:* Create a new ACM cert for `*.run402.com` in us-east-1 (required for CloudFront). DNS validation via existing Route53 hosted zone.

**[Risk] CloudFront behavior ordering** → Wrong order could route API requests to S3 or assets to ALB.
*Mitigation:* Explicit API path behaviors first (highest priority). Test with curl + `x-cache` header inspection.

**[Risk] Fork badge bypass on direct S3 access** → Assets served from CloudFront edge don't go through the gateway, so if someone requests `index.html` with a `.html` extension it hits the asset behavior and skips fork badge injection.
*Mitigation:* SPA fallback means most HTML requests have no extension (→ default behavior → ALB). Explicit `.html` requests are rare. Could add `.html` to the default behavior exclusion if needed.

**[Risk] Migration cutover** → Changing `*.run402.com` DNS from ALB to CloudFront.
*Mitigation:* Deploy CloudFront distribution first. Populate KVS from DB. Test with direct CloudFront domain. Then update DNS. Rollback = revert DNS record (TTL 60s).
