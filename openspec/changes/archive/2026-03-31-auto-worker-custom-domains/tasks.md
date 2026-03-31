## 1. Database Schema

- [x] 1.1 Add `cloudflare_zone_id TEXT` column to `internal.domains` in `initDomainsTable()` via `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`

## 2. Cloudflare API Functions

- [x] 2.1 Add `cfZoneResolve(hostname: string)` to `cloudflare.ts` — extracts base domain (last two labels), calls `GET /zones?name={base_domain}`, returns zone_id or null
- [x] 2.2 Add `cfWorkerCustomDomainCreate(hostname: string, zoneId: string)` to `cloudflare.ts` — calls `PUT /accounts/{account_id}/workers/domains` with service name from `CLOUDFLARE_WORKER_NAME` env var (default: `run402-custom-domains`). Fire-and-forget pattern (log errors, don't throw).
- [x] 2.3 Add `cfWorkerCustomDomainDelete(hostname: string)` to `cloudflare.ts` — calls `DELETE /accounts/{account_id}/workers/domains/{hostname}`. Fire-and-forget pattern.

## 3. Domains Service Integration

- [x] 3.1 Update `createDomain()` in `domains.ts` — after Custom Hostname creation, call `cfZoneResolve()` then `cfWorkerCustomDomainCreate()`. Store `cloudflare_zone_id` in the INSERT.
- [x] 3.2 Update `deleteDomain()` in `domains.ts` — if record has non-null `cloudflare_zone_id`, call `cfWorkerCustomDomainDelete()` before/alongside existing cleanup.

## 4. Configuration

- [x] 4.1 Add `CLOUDFLARE_WORKER_NAME` to gateway env var handling (read from `process.env` with default `run402-custom-domains`)

## 5. Verification

- [ ] 5.1 Test with a new custom domain on Run402's Cloudflare account — verify Worker Custom Domain binding is created and traffic routes correctly (no 522)
- [ ] 5.2 Test domain deletion — verify Worker Custom Domain binding is removed
- [ ] 5.3 Test with a domain whose zone is NOT on Run402's account — verify graceful fallback (domain registered, warning logged, no binding created)
