# Custom Domains for Run402 Sites

## Context

here.now supports custom domains (e.g., `example.com`, `docs.example.com`) pointed at their hosted sites. Run402 currently only offers `*.run402.com` subdomains. This doc explains how here.now implements custom domains and the options for adding the same to Run402.

## How here.now Does It

### Cloudflare for SaaS (Custom Hostnames)

here.now runs on Cloudflare and uses **Cloudflare for SaaS** (formerly "SSL for SaaS" / Custom Hostnames). This is the standard way to let users bring their own domains to a Cloudflare-hosted platform.

### The CNAME target: `fallback.here.now`

This is the central routing point. When a user adds `docs.example.com` and points a CNAME to `fallback.here.now`, traffic flows through Cloudflare's edge, which recognizes it as a "custom hostname" belonging to here.now's zone.

### How it works under the hood

1. here.now has a **Cloudflare zone** (the "SaaS zone") that owns custom hostname configuration.
2. When here.now calls the **Cloudflare Custom Hostnames API** (`POST /zones/:zone_id/custom_hostnames`), Cloudflare registers that domain as belonging to here.now's zone.
3. When traffic arrives at Cloudflare's edge for `docs.example.com`, Cloudflare checks: "is this a registered custom hostname?" — yes — route to here.now's origin/worker.
4. **SSL is automatic** — Cloudflare provisions a certificate (Let's Encrypt or Cloudflare CA) once it validates domain control. For CNAME'd domains, the CNAME itself proves control. For apex domains, a TXT record is needed.

### Two domain types

**Subdomains** (`docs.example.com`):
- User adds a CNAME: `docs.example.com → fallback.here.now`
- Cloudflare validates via the CNAME — DNS resolving to Cloudflare is proof of control
- SSL provisioned automatically, no TXT record needed

**Apex domains** (`example.com`):
- DNS spec says apex domains can't have CNAME records (conflicts with SOA/NS)
- User adds an **ALIAS/ANAME record** → `fallback.here.now` (DNS-provider-specific flattening)
- Because ALIAS doesn't resolve as a visible CNAME, Cloudflare can't validate ownership through DNS alone
- here.now returns an `ownership_verification` object with a **TXT record** (e.g., `_cf-custom-hostname.example.com → some-token`)
- Once Cloudflare sees the ALIAS routing traffic AND the TXT record, it provisions SSL

### Routing: Cloudflare Workers + KV

Once traffic arrives at Cloudflare's edge for a custom domain, here.now maps it to the right site:

1. **Cloudflare Worker** intercepts all requests for custom hostnames
2. Worker reads the **hostname + path** from the request
3. Worker looks up hostname+path in **Cloudflare KV** → gets a site slug
4. Worker serves the site's files from storage (likely R2)

KV entries look like:
```
"example.com/"      → "bright-canvas-a7k2"
"example.com/docs"  → "warm-lake-f3k9"
"handle.here.now/"  → "bright-canvas-a7k2"
```

The 60-second propagation delay (mentioned in their docs) is KV's eventual consistency — writes propagate to all edge locations globally within ~60s.

### The Links API

`POST /api/v1/links` is the control plane for the KV routing table:

```json
{"location": "docs", "slug": "bright-canvas-a7k2", "domain": "example.com"}
```

Writes to KV: `example.com/docs → bright-canvas-a7k2`. Same system works for handles (`yourname.here.now`) — just a different hostname key.

### Their API surface

```
POST   /api/v1/domains              — add a domain
GET    /api/v1/domains              — list domains
GET    /api/v1/domains/:domain      — check status (pending → active)
DELETE /api/v1/domains/:domain      — remove domain + all links

POST   /api/v1/links               — link site to domain+path
GET    /api/v1/links               — list links
GET    /api/v1/links/:location     — get link
PATCH  /api/v1/links/:location     — update link
DELETE /api/v1/links/:location     — remove link
```

Limits: 1 domain on free, 5 on hobby.

### Their cost

Cloudflare for SaaS: $0.10/month per custom hostname after the first 100 free. Negligible at scale.

## Options for Run402

Run402 uses CloudFront + S3 for site serving, not Cloudflare. Three options:

### Option A: Stay on AWS (ACM + CloudFront)

Each custom domain needs:
- An ACM certificate (DNS-validated via CNAME record)
- Added as an alternate domain name (CNAME) on the CloudFront distribution

Pros:
- No new infrastructure, stays within existing AWS stack

Cons:
- ACM cert provisioning is slower than Cloudflare (minutes, not seconds)
- CloudFront has a limit of 100 alternate domain names per distribution (can be raised)
- More operational complexity — managing certs, distribution updates
- Each domain addition requires a CloudFront distribution update (takes a few minutes to deploy)

### Option B: Cloudflare Worker proxy

Add a Cloudflare Worker in front of the existing S3/CloudFront setup for custom domains only:
- Cloudflare for SaaS handles custom hostname registration + SSL
- Worker routes custom domain requests and proxies to S3 (directly) or CloudFront
- `*.run402.com` traffic continues through CloudFront as-is

Pros:
- Fast SSL provisioning, simple domain management
- Existing infrastructure untouched for `*.run402.com`
- Cheap ($0.10/hostname/month)

Cons:
- Adds Cloudflare as a dependency for custom domains
- Extra hop (Cloudflare → S3/CloudFront) adds latency
- Two CDN layers if proxying through CloudFront

### Option C: Migrate site serving to Cloudflare

Move static site hosting from CloudFront to Cloudflare Workers + R2:
- Sites stored in R2 (Cloudflare's S3-compatible object storage)
- Worker serves files from R2
- Custom domains come nearly free via Cloudflare for SaaS
- API gateway, DB, functions all stay on AWS

Pros:
- Custom domains are a natural fit
- Cloudflare's edge network is fast and global
- R2 has no egress fees (vs S3 egress costs)
- Simplifies the site serving stack

Cons:
- Migration effort — rewrite site upload to target R2, rewrite serving logic
- Split infrastructure (Cloudflare for sites, AWS for everything else)
- Need to replicate SPA fallback logic, subdomain routing, etc. in Workers

## Decision: Option B (Cloudflare Worker Proxy)

**Chosen: 2026-03-30**

### Why Option B

Option A (AWS-native) is free but operationally painful — ACM cert validation is async, CloudFront distribution updates take minutes, there's a 100-domain cap per distribution (raisable but still a limit), and we'd own the full cert lifecycle (renewal, cleanup, failure handling).

Option C (full Cloudflare migration) is overkill — we'd migrate the entire site-serving stack just to get domain aliasing. The CloudFront Function → KVS → S3 architecture works well for `*.run402.com` and doesn't need replacing.

Option B keeps `*.run402.com` traffic on the existing CloudFront path (untouched) and only routes custom domain traffic through Cloudflare. Cloudflare handles the hard parts: SSL provisioning, domain verification, and edge routing. The gateway just needs a `domains` table and a few API endpoints.

| | Option A (AWS) | **Option B (CF proxy)** | Option C (migrate) |
|---|---|---|---|
| SSL provisioning | 5-15 min | ~30 sec | ~30 sec |
| Apex domains | Needs Route53 or ALIAS | ALIAS + TXT auto-verify | ALIAS + TXT auto-verify |
| Domain limit | 100/distro (raisable) | Unlimited | Unlimited |
| Cost per domain | Free | $0.10/mo (first 100 free) | $0.10/mo (first 100 free) |
| Existing infra impact | Modify CloudFront distro | None | Full migration |
| Cert lifecycle mgmt | Us | Cloudflare | Cloudflare |

### Use case: forkable apps

The driving use case is **WildLychee** (wildlychee.com) — a Wild Apricot clone built on Run402 as a sister repo. wildlychee.com should point to wildlychee.run402.com.

Critically, WildLychee is designed to be **forked**. Anyone who forks it and deploys on Run402 (e.g., angry-eagles.org) will also want a custom domain. This means custom domains must be self-service and automated — not a manual setup by us.

### Scope

**Simple 1:1 domain aliasing.** One custom domain maps to one Run402 subdomain/deployment:

```
wildlychee.com      →  wildlychee.run402.com  →  deployment dpl_xyz
angry-eagles.org    →  angry-eagles.run402.com →  deployment dpl_abc
```

No path-based routing. No multi-site-per-domain. Just "my domain → my Run402 site."

### Architecture

```
CUSTOM DOMAIN TRAFFIC (new):

  angry-eagles.org
       │
       ▼
  ┌─────────────┐     ┌───────────────┐     ┌────────┐
  │ Cloudflare  │────▶│ CF Worker     │────▶│   S3   │
  │  (SSL +     │     │ (KV lookup →  │     │(files) │
  │  hostname)  │     │  proxy to S3) │     │        │
  └─────────────┘     └───────────────┘     └────────┘

*.run402.com TRAFFIC (unchanged):

  myapp.run402.com
       │
       ▼
  ┌─────────────┐     ┌───────────────┐     ┌────────┐
  │ CloudFront  │────▶│ CF Function   │────▶│   S3   │
  │  (edge)     │     │ (KVS lookup → │     │(files) │
  │             │     │  rewrite URI) │     │        │
  └─────────────┘     └───────────────┘     └────────┘

CONTROL PLANE (gateway):

  POST /v1/domains { domain, subdomain_name }
       │
       ▼
  ┌──────────┐     ┌─────────────────┐     ┌──────────┐
  │ Gateway  │────▶│ CF Custom       │────▶│ CF KV    │
  │  (API)   │     │ Hostnames API   │     │(routing) │
  └──────────┘     └─────────────────┘     └──────────┘
       │
       ▼
  ┌──────────┐
  │ domains  │
  │  table   │
  └──────────┘
```

### User flow

1. User calls `POST /v1/domains` with `{ domain: "angry-eagles.org", subdomain_name: "angry-eagles" }`
2. Gateway registers the custom hostname with Cloudflare, stores in `internal.domains` table
3. Gateway returns DNS instructions: "Add CNAME → `domains.run402.com`" (or TXT record for apex)
4. User configures their DNS
5. Cloudflare validates, provisions SSL
6. User polls `GET /v1/domains/angry-eagles.org` until status is `active`
7. Traffic to angry-eagles.org hits Cloudflare Worker → resolves via KV → serves from S3
