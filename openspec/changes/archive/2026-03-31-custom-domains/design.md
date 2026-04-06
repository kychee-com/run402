## Context

Run402 serves static sites via two CloudFront distributions:
- `*.sites.run402.com` — immutable deployment URLs (auto-generated)
- `*.run402.com` — custom subdomains (user-claimed)

Both resolve to S3 files under `sites/{deployment_id}/`. The edge routing uses CloudFront KeyValueStore (KVS) to map subdomain names to deployment IDs. The gateway manages KVS via write-through sync + 5-minute reconciliation.

Custom domains (e.g., `wildlychee.com`) need the same routing — domain → deployment_id → S3 files — but on hostnames we don't control.

See `docs/custom_domains.md` for the full options analysis and decision rationale.

## Goals / Non-Goals

**Goals:**
- Users can serve their Run402 site on their own domain (apex or subdomain)
- Self-service: claim via API, configure DNS, go live — no manual intervention by us
- SSL provisioned automatically via Cloudflare
- Existing `*.run402.com` traffic path completely unchanged

**Non-Goals:**
- Path-based routing (e.g., `example.com/blog` → one deployment, `example.com/app` → another)
- Wildcard custom domains (`*.example.com`)
- DNS hosting or management (we don't touch user DNS beyond telling them what records to add)
- Migrating `*.run402.com` serving away from CloudFront (Option C — ruled out)

## Decisions

### 1. Cloudflare for SaaS (Custom Hostnames) for SSL and domain verification

**Choice:** Use Cloudflare for SaaS to handle SSL provisioning, domain ownership verification, and edge termination for custom domains.

**Alternatives considered:**
- AWS ACM + CloudFront alternate domains: Slow cert provisioning (5-15 min), 100-domain cap per distribution, full cert lifecycle management burden on us. Ruled out.
- Full migration to Cloudflare Workers + R2: Clean architecture but massive migration effort for a domain-aliasing feature. Ruled out.

**How it works:**
1. Gateway calls Cloudflare Custom Hostnames API to register a domain
2. Cloudflare returns DNS instructions (CNAME target for subdomains, CNAME + TXT for apex)
3. User configures DNS at their registrar
4. Cloudflare auto-validates and provisions SSL
5. Traffic for that hostname routes to our Cloudflare Worker

### 2. Cloudflare Worker + KV for edge routing

**Choice:** A Cloudflare Worker reads the `Host` header, looks up the custom domain in Cloudflare KV, gets the deployment_id, and fetches the file from S3.

**Why KV (not the gateway):** Same reason we use CloudFront KVS for `*.run402.com` — edge-local reads are fast (<1ms). Routing through the gateway ALB would add 50-100ms latency and create a single point of failure.

**KV schema:**
```
key: "wildlychee.com"     → value: "dpl_1234_abc"
key: "angry-eagles.org"   → value: "dpl_5678_def"
```

**Worker behavior:**
- Read `Host` header → look up in KV → if found, fetch `s3://agentdb-storage-{account}/sites/{deployment_id}/{path}` → return
- SPA fallback: no extension → serve `/index.html`
- HTML responses: inject fork badge (same as gateway subdomain middleware does today)
- Asset responses: `Cache-Control: public, max-age=31536000, immutable`
- 404 if domain not in KV

### 3. Gateway as control plane — Cloudflare as data plane

**Choice:** The gateway manages the `internal.domains` table and syncs to Cloudflare (Custom Hostnames API + KV). Mirrors the existing pattern where the gateway manages `internal.subdomains` and syncs to CloudFront KVS.

**Domain lifecycle in the gateway:**
1. `POST /v1/domains` → insert into `internal.domains`, call Cloudflare Custom Hostnames API, write to Cloudflare KV
2. User configures DNS
3. `GET /v1/domains/:domain` → return status from Cloudflare (pending/active/error)
4. `DELETE /v1/domains/:domain` → delete from Cloudflare, delete from KV, delete from DB

**Sync pattern:** Write-through (immediate) + periodic reconciliation (same as KVS). Fire-and-forget on mutations; reconciliation job diffs DB vs KV every 5 minutes.

### 4. Domain linked to subdomain, not deployment

**Choice:** A custom domain points to a Run402 subdomain name, not directly to a deployment_id. When the subdomain is redeployed (new deployment_id), the custom domain automatically follows.

**Why:** Users already manage their deployment target via subdomains. `wildlychee.com → wildlychee (subdomain) → dpl_xyz (deployment)`. When they redeploy wildlychee, both `wildlychee.run402.com` and `wildlychee.com` update — no extra API call needed.

**Implementation:** KV stores `domain → deployment_id` (resolved at write time). On subdomain redeployment, the gateway also updates the KV entry for any linked custom domain.

### 5. One custom domain per subdomain (1:1)

**Choice:** Each custom domain maps to exactly one Run402 subdomain. Each subdomain can have at most one custom domain.

**Why:** Simplest model. Covers the WildLychee use case and all foreseeable forkable-app use cases. Path-based routing or multi-domain-per-subdomain can be added later if needed.

### 6. CNAME target: `domains.run402.com`

**Choice:** Users point their domain's CNAME (or ALIAS for apex) to `domains.run402.com`. This is a DNS record pointing to Cloudflare, which serves as the fallback origin for the Cloudflare for SaaS setup.

**For apex domains:** Users also add a TXT record (`_cf-custom-hostname.example.com → <token>`) that Cloudflare returns during custom hostname registration.

### 7. Cloudflare Worker fetches directly from S3

**Choice:** The Worker fetches files from S3 using an AWS IAM access key (stored as a Worker secret), not by proxying through CloudFront.

**Why:** Proxying through CloudFront would add an extra hop (Cloudflare → CloudFront → S3) and create a dual-CDN latency problem. Direct S3 access from the Worker is simpler and faster. Cloudflare's own edge caching handles the CDN layer.

**Credential management:** A dedicated IAM user with read-only access to `s3://agentdb-storage-*/sites/*`. Access key stored as Cloudflare Worker environment secrets.

## Risks / Trade-offs

**[Cloudflare as new dependency]** → Custom domain traffic depends on Cloudflare's availability. Mitigation: `*.run402.com` traffic is unaffected (stays on CloudFront). Cloudflare has >99.99% uptime SLA.

**[S3 egress from Cloudflare Worker]** → Every cache miss fetches from S3, incurring AWS egress costs. Mitigation: Cloudflare Cache API (or `cache-control` headers) will cache assets at the edge. HTML is small; static assets are immutable and cache well.

**[KV eventual consistency]** → Cloudflare KV writes propagate globally in ~60 seconds. After domain claim + DNS verification, there may be a brief window where some edge locations return 404. Mitigation: Same as CloudFront KVS today — acceptable for this use case.

**[Dual sync systems]** → We now sync to both CloudFront KVS (subdomains) and Cloudflare KV (custom domains). Mitigation: Same pattern, same reconciliation approach. The gateway already has the pattern well-established.

**[Fork badge injection]** → The Worker needs to inject the fork badge into HTML responses, duplicating logic currently in the gateway's subdomain middleware. Mitigation: Keep the badge HTML as a shared constant or fetch it from a known URL. The logic is simple (string replace before `</body>`).

## Migration Plan

No migration needed — this is additive. Steps:

1. Set up Cloudflare account, zone, Worker, KV namespace
2. Deploy Worker with routing logic
3. Add `internal.domains` table + gateway API endpoints
4. Configure `domains.run402.com` DNS → Cloudflare
5. Ship — existing traffic unaffected

Rollback: delete the Cloudflare Worker and DNS record. Custom domains stop working; `*.run402.com` is unaffected.

## Open Questions

- **Tier limits:** How many custom domains per tier? (e.g., prototype: 0, hobby: 1, team: 5)
- **Fork badge:** Should custom domain sites show the fork badge? Or is a custom domain a signal that the user wants a "clean" site?
- **Cloudflare plan level:** Cloudflare for SaaS requires at least the $20/month Pro plan (or Enterprise). Verify minimum plan requirements.
