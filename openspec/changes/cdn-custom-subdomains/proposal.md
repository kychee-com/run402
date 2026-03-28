## Why

Custom subdomains (`{name}.run402.com`) serve every request — HTML, CSS, JS, images — through the gateway (ALB → Express middleware → S3 GetObject). This means no edge caching, every asset round-trips to us-east-1, and CSS/JS files cached in the browser for 1 hour go stale after redeploy because the URL doesn't change. Deployment URLs (`*.sites.run402.com`) already use CloudFront with immutable caching and unique `dpl_` prefixes, so they don't have this problem. Custom subdomains should get the same CDN treatment.

## What Changes

- Add a CloudFront distribution for `*.run402.com` with two origin behaviors:
  - **Assets** (requests with file extensions like `.css`, `.js`, `.png`): routed to S3 via a CloudFront Function that resolves subdomain → deployment ID using CloudFront KeyValueStore, then rewrites the URI to the S3 prefix. Served with immutable caching.
  - **HTML** (requests without file extensions or `.html`): routed to the ALB origin so the gateway can inject the fork badge. Served with short TTL (60s).
- Sync the KeyValueStore on subdomain claim, reassign, and delete (3 mutation points in `subdomains.ts`).
- Remove the asset-serving path from the gateway subdomain middleware (HTML-only after migration).
- **BREAKING**: None. Deploy API, subdomain API, and MCP tools are unchanged. Agent code is unaffected.

## Capabilities

### New Capabilities
- `cdn-subdomain-routing`: CloudFront distribution, KeyValueStore sync, and CloudFront Function for resolving custom subdomains to S3 deployment prefixes at the edge.

### Modified Capabilities

(none — no existing spec-level requirements change)

## Impact

- **Infra** (`infra/lib/`): New CDK stack or additions to existing stacks — CloudFront distribution, KVS, CloudFront Function, ACM cert for `*.run402.com`, Route53 records.
- **Gateway** (`packages/gateway/src/services/subdomains.ts`): 3 sync points to update KVS on subdomain mutations. Subdomain middleware simplified to HTML-only.
- **DNS**: `*.run402.com` A/AAAA records change from ALB to CloudFront. API traffic (`api.run402.com`) must remain on ALB — needs explicit record or CloudFront behavior to forward to ALB.
- **ACM**: Need cert for `*.run402.com` (currently only have `*.sites.run402.com`). Check if existing wildcard covers it.
- **Testing**: New E2E test for subdomain asset caching behavior (cache headers, freshness after redeploy).
