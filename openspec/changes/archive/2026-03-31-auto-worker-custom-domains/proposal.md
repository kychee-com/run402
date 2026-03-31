## Why

The `POST /v1/domains` endpoint registers a Cloudflare Custom Hostname (for SSL) and writes a KV entry (for routing), but does not create a **Worker Custom Domain binding** — the piece that actually routes requests to the `run402-custom-domains` Worker. Without this binding, custom domain traffic reaches Cloudflare's edge, SSL terminates correctly, but no Worker handles the request, resulting in HTTP 522. Today each new custom domain requires a manual `PUT /accounts/:id/workers/domains` call, which is why `wildlychee.com` (manually set up) works but domains added via the API do not.

## What Changes

- Add a `cfWorkerCustomDomainCreate()` function to `cloudflare.ts` that calls `PUT /accounts/{account_id}/workers/domains` to bind a hostname to the `run402-custom-domains` Worker.
- Add a corresponding `cfWorkerCustomDomainDelete()` for cleanup on domain removal.
- Call these functions from `createDomain()` and `deleteDomain()` in the domains service.
- Add a new env var `CLOUDFLARE_WORKER_NAME` (default: `run402-custom-domains`) for the Worker service name.
- Handle the zone_id requirement: for domains on Run402's Cloudflare account, resolve the zone_id via the Cloudflare API; for domains on external Cloudflare accounts or non-Cloudflare DNS, skip the Worker Custom Domain binding and document the limitation.

## Capabilities

### New Capabilities
- `worker-custom-domain-binding`: Automatic creation/deletion of Cloudflare Worker Custom Domain bindings when custom domains are registered or released via the gateway API.

### Modified Capabilities

_(none — no existing spec-level requirements change)_

## Impact

- **Code**: `packages/gateway/src/services/cloudflare.ts` (new functions), `packages/gateway/src/services/domains.ts` (call new functions in create/delete flows)
- **APIs**: No API contract changes — existing `POST/DELETE /v1/domains` behavior is augmented, not altered
- **Env vars**: New `CLOUDFLARE_WORKER_NAME` needed in gateway (ECS task definition + local `.env`)
- **Cloudflare API**: Additional API calls per domain registration (zone lookup + Worker Custom Domain create); Cloudflare API token needs `Workers Scripts:Edit` permission
- **Limitation**: Domains on external Cloudflare accounts cannot have Worker Custom Domain bindings created by Run402's API token — these will still require manual setup or an alternative routing approach
