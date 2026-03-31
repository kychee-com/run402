## Context

Custom domains on Run402 use three Cloudflare mechanisms:

1. **Custom Hostnames** (SaaS zone `run402.net`) — provisions SSL and validates domain ownership
2. **Workers KV** — maps `hostname → deployment_id` for the edge Worker
3. **Worker Custom Domains** — binds a hostname to the `run402-custom-domains` Worker so it actually handles requests

Today the gateway automates (1) and (2) but not (3). The Worker Custom Domain for `wildlychee.com` was created manually. Any new domain added via `POST /v1/domains` gets SSL and a KV entry but no Worker binding, resulting in 522 errors.

Worker Custom Domains require a `zone_id` — the Cloudflare zone that contains the hostname. For domains on Run402's Cloudflare account (e.g., `wildlychee.com`, `run402.net`), the gateway can resolve this via the Zones API. For domains on external Cloudflare accounts or non-Cloudflare DNS, the gateway cannot create the binding.

## Goals / Non-Goals

**Goals:**
- Automatically create/delete Worker Custom Domain bindings when domains on Run402's Cloudflare account are registered/released
- Resolve zone_id automatically from the hostname via the Cloudflare Zones API
- Make the `domains add` CLI command fully self-service for domains on Run402's Cloudflare account
- Graceful degradation: if the zone isn't on Run402's account, log a warning and continue (Custom Hostname + KV still created)

**Non-Goals:**
- Supporting domains on external Cloudflare accounts (requires cross-account auth — future work)
- Changing the Custom Hostname or KV flows (these remain as-is)
- Adding a fallback origin / catch-all Worker route on the SaaS zone (Worker Custom Domains is the chosen approach per prior learnings)
- UI for custom domain management

## Decisions

### 1. Zone resolution via Zones API, not stored zone_id

The gateway will call `GET /zones?name=<base_domain>` to resolve the zone_id at domain registration time, rather than requiring the user to supply it or storing a mapping.

**Why:** Keeps the API surface unchanged (`POST /v1/domains` still takes `{ domain, subdomain_name }`). The Zones API returns zones the API token has access to, which naturally scopes to Run402's account.

**Alternative considered:** Require zone_id as input — rejected because it leaks Cloudflare internals to users and breaks the existing CLI flow.

### 2. Fire-and-forget for Worker Custom Domain creation (same as KV)

The Worker Custom Domain binding is created fire-and-forget: log errors but don't fail the domain registration. The Custom Hostname and KV entry are the critical path; the Worker binding is the routing path.

**Why:** Matches the existing KV pattern. If the binding fails (e.g., zone not on our account), the domain is still registered and can be manually fixed. A reconciliation job can catch drift.

**Alternative considered:** Make it blocking and fail the registration — rejected because it would break domain registration for non-Run402-account domains.

### 3. Store zone_id in the domains table

Add a `cloudflare_zone_id` column to `internal.domains`. This avoids re-resolving the zone on delete and enables future reconciliation of Worker Custom Domain bindings.

**Why:** The delete flow needs the zone to identify the Worker Custom Domain. Re-resolving is wasteful and may fail if the zone was removed.

### 4. Worker Custom Domain ID tracking

The Cloudflare Worker Custom Domains API uses the hostname as the identifier (not a separate ID). The `PUT` is idempotent and the `DELETE` uses the hostname. No additional ID column is needed.

## Risks / Trade-offs

- **[Zone not found]** → Domain registration continues without Worker binding. Logged as warning. Manual binding required. Could add reconciliation in future.
- **[API token permissions]** → Token needs `Workers Scripts:Edit` and `Zone:Read` permissions. If missing, binding silently fails. → Document required permissions.
- **[Rate limits]** → Each domain registration adds 1-2 extra Cloudflare API calls (zone lookup + binding create). Cloudflare's default rate limit is 1200 req/5min. → Negligible for expected volume.
- **[Cloudflare-on-Cloudflare for external accounts]** → Domains on external Cloudflare accounts still get 522. → Documented limitation. Future: fallback origin approach or user-side Worker setup instructions.
