## 1. Cloudflare Setup

- [x] 1.1 Create Cloudflare account and add a zone for custom domain routing
- [x] 1.2 Enable Cloudflare for SaaS (Custom Hostnames) on the zone
- [x] 1.3 Create a Cloudflare KV namespace for domain→deployment_id mappings
- [x] 1.4 Create a Cloudflare API token with permissions: Custom Hostnames (edit), Workers KV (edit), Workers Scripts (edit)
- [x] 1.5 Create DNS record: `domains.run402.com` → Cloudflare (CNAME fallback origin for Custom Hostnames)

## 2. Cloudflare Worker

- [x] 2.1 Scaffold the Worker project (wrangler init, configure KV binding and S3 credentials as secrets)
- [x] 2.2 Implement edge routing: read Host header → KV lookup → fetch from S3 (`sites/{deployment_id}/{path}`)
- [x] 2.3 Implement SPA fallback: no file extension → serve `index.html`
- [x] 2.4 Set cache headers: immutable for assets (css/js/images/fonts), max-age=60 for HTML
- [x] 2.5 Implement fork badge injection for HTML responses
- [x] 2.6 Return 404 for unknown domains (not in KV)
- [x] 2.7 Deploy Worker and bind to the Cloudflare zone

## 3. Database

- [x] 3.1 Add `internal.domains` table: domain (PK), subdomain_name, project_id, cloudflare_hostname_id, status, dns_instructions (JSONB), created_at, updated_at
- [x] 3.2 Add indexes on subdomain_name and project_id
- [x] 3.3 Add table creation to gateway startup (initDomainsTable, same pattern as initSubdomainsTable)

## 4. Cloudflare Client Service

- [x] 4.1 Create `packages/gateway/src/services/cloudflare.ts` — Cloudflare API client for Custom Hostnames (create, get status, delete) and KV (put, delete, list)
- [x] 4.2 Add env vars: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ZONE_ID`, `CLOUDFLARE_KV_NAMESPACE_ID`
- [x] 4.3 Implement fire-and-forget pattern (same as kvs.ts): log errors, don't throw on sync failures

## 5. Domains Service

- [x] 5.1 Create `packages/gateway/src/services/domains.ts` — domain CRUD (create, get, list, delete) with Cloudflare sync
- [x] 5.2 Domain validation: valid hostname format, has TLD, not a run402.com subdomain
- [x] 5.3 On create: verify subdomain exists and belongs to caller's project, call Cloudflare Custom Hostnames API, write to Cloudflare KV, insert DB record with dns_instructions from Cloudflare response
- [x] 5.4 On delete: remove Cloudflare custom hostname, delete KV entry, delete DB record
- [x] 5.5 On status check: query Cloudflare Custom Hostnames API for current verification/SSL status

## 6. Subdomain Integration

- [x] 6.1 On subdomain redeployment (createOrUpdateSubdomain): look up linked domain in `internal.domains`, update Cloudflare KV with new deployment_id
- [x] 6.2 On subdomain delete (deleteSubdomain / deleteProjectSubdomains): also delete any linked custom domain

## 7. API Routes

- [x] 7.1 Create `packages/gateway/src/routes/domains.ts` with POST/GET/DELETE endpoints
- [x] 7.2 `POST /v1/domains` — register domain (service_key auth), return domain record with dns_instructions
- [x] 7.3 `GET /v1/domains` — list domains (service_key: project, admin: all)
- [x] 7.4 `GET /v1/domains/:domain` — check status (no auth)
- [x] 7.5 `DELETE /v1/domains/:domain` — release domain (service_key or admin)
- [x] 7.6 Register routes in server.ts

## 8. Reconciliation

- [x] 8.1 Implement Cloudflare KV reconciliation (same pattern as kvsReconcile): diff DB vs KV, add/update/remove
- [x] 8.2 Start reconciliation loop on gateway startup (5-minute interval)

## 9. Infrastructure

- [x] 9.1 Add Cloudflare env vars to ECS task definition (CLOUDFLARE_API_TOKEN, CLOUDFLARE_ZONE_ID, CLOUDFLARE_KV_NAMESPACE_ID)
- [x] 9.2 Create IAM user with read-only S3 access to `sites/*` prefix, store access key as Cloudflare Worker secrets
- [x] 9.3 Store Cloudflare API token in AWS Secrets Manager

## 10. Testing

- [x] 10.1 E2E test: register domain → check status (pending) → verify DNS instructions returned → delete domain
- [x] 10.2 E2E test: redeploy subdomain → verify custom domain KV entry updated
- [x] 10.3 Manual test: register wildlychee.com, configure DNS, verify SSL provisioning and site serving
