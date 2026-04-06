## Why

Run402 only supports `*.run402.com` subdomains. Users building real products on Run402 — starting with WildLychee (a forkable Wild Apricot clone) — need to serve their sites on their own domains (e.g., `wildlychee.com`, `angry-eagles.org`). Every fork of a template app will want this. Without custom domains, Run402 sites look like side projects, not products.

## What Changes

- New `internal.domains` table mapping custom domains to Run402 subdomains/deployments
- New gateway API endpoints: `POST/GET/DELETE /v1/domains` for self-service domain management
- Cloudflare for SaaS integration for SSL provisioning and domain verification
- Cloudflare Worker + KV for edge routing of custom domain traffic to S3
- Gateway writes to Cloudflare KV on domain claim/delete (mirrors existing KVS sync pattern)
- `*.run402.com` traffic path is completely unchanged (stays on CloudFront)

## Capabilities

### New Capabilities
- `custom-domains`: Register, verify, and serve custom domains (e.g., `example.com`) that resolve to a Run402 deployment. Covers the API surface (claim, status, delete), Cloudflare integration (Custom Hostnames API, Worker, KV), DNS verification flow, and edge routing.

### Modified Capabilities
_(none — existing subdomain system is untouched)_

## Impact

- **New infrastructure**: Cloudflare account, zone, Worker, KV namespace, Cloudflare for SaaS subscription
- **Gateway code**: New routes (`/v1/domains`), new service (`domains.ts`), new Cloudflare client (`cloudflare.ts`)
- **Database**: New `internal.domains` table
- **Environment**: New env vars for Cloudflare API token, zone ID, KV namespace ID
- **Dependencies**: Cloudflare becomes a runtime dependency for custom domain traffic (not for `*.run402.com`)
- **Cost**: $0.10/hostname/month after first 100 free; Worker requests on free tier up to 100k/day
