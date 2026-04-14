## ADDED Requirements

### Requirement: Static assets served via custom-domain Worker SHALL be edge-cached by Cloudflare

The `run402-custom-domains` Worker SHALL pass `cf: { cacheEverything: true, cacheTtlByStatus: { "200-299": 31536000, "404": 60, "500-599": 0 } }` on `fetch` subrequests to S3 for non-HTML asset paths, causing Cloudflare's edge to cache the S3 response body at the URL level.

#### Scenario: First request for an asset from a given colo
- **WHEN** a browser requests `https://<custom-domain>/<path-to-image>` and the edge colo has no cached copy for that S3 URL
- **THEN** the Worker fetches the object from S3 and the response is stored in the edge cache under the S3 URL key
- **AND** the response to the browser includes `cache-control: public, max-age=31536000, immutable`

#### Scenario: Warm request for the same asset within TTL
- **WHEN** a second browser requests the same asset path within 31,536,000 seconds and from the same colo
- **THEN** the Worker's `fetch(s3Url, ...)` subrequest is served from CF's edge cache without re-fetching from S3
- **AND** the outer response includes an `x-cache-status: HIT` header (propagated from the subrequest's `cf-cache-status`; CF does not attach `cf-cache-status` to Worker-generated outer responses)
- **AND** warm-request latency is materially lower than cold-request latency (observed ~18× on a kychon.com image: 593ms → 33ms)

#### Scenario: Non-success response from S3 is short-cached
- **WHEN** the Worker's S3 subrequest returns a 404 or 403
- **THEN** the negative response is cached for at most 60 seconds
- **AND** a 5xx response is not cached at all

### Requirement: HTML responses SHALL NOT be edge-cached by this change

The Worker's HTML path (fork-badge-injected responses) SHALL continue to omit `cf:` caching hints on its S3 subrequest and SHALL continue to return `cache-control: public, max-age=60`.

#### Scenario: HTML request
- **WHEN** a browser requests a path that resolves to `index.html` (root or SPA fallback)
- **THEN** the Worker fetches from S3 without `cf.cacheEverything`
- **AND** the response body is fork-badge-injected before being returned
- **AND** the response header is `cache-control: public, max-age=60`

### Requirement: Cache invalidation on site redeploy SHALL be implicit via deployment-scoped S3 keys

Because S3 object keys include the deployment ID (`sites/${deploymentId}/${relativePath}`), a site redeploy writes to a new URL and produces a disjoint cache namespace. The Worker SHALL NOT call any Cloudflare cache-purge API on redeploy.

#### Scenario: Redeploy produces a new deployment ID
- **WHEN** a custom-domain site is redeployed and the KV `domain → deployment_id` mapping updates
- **THEN** subsequent requests resolve to a new S3 URL and produce new cache entries on first hit
- **AND** the old deployment's cache entries age out of the edge without manual purge

#### Scenario: Old deployment assets still reachable until KV propagation completes
- **WHEN** KV propagation is mid-flight (up to ~60s)
- **THEN** colos that still read the old `deployment_id` continue serving the old deployment's cached or origin-fetched assets — no broken state, just staleness bounded by KV propagation
