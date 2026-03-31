## ADDED Requirements

### Requirement: Worker Custom Domain binding created on domain registration

When a custom domain is registered via `POST /v1/domains`, the gateway SHALL resolve the Cloudflare zone_id for the domain's base domain and create a Worker Custom Domain binding (`PUT /accounts/{account_id}/workers/domains`) that routes the hostname to the `run402-custom-domains` Worker.

#### Scenario: Domain on Run402's Cloudflare account
- **WHEN** a domain is registered and the base domain's zone exists on Run402's Cloudflare account
- **THEN** the gateway creates a Worker Custom Domain binding with `hostname`, `service: run402-custom-domains`, `zone_id`, and `environment: production`
- **AND** the `cloudflare_zone_id` is stored in the `internal.domains` table

#### Scenario: Domain zone not found on Run402's account
- **WHEN** a domain is registered but the Cloudflare Zones API returns no matching zone
- **THEN** the gateway logs a warning and continues domain registration without creating a Worker Custom Domain binding
- **AND** the Custom Hostname and KV entry are still created
- **AND** `cloudflare_zone_id` is stored as NULL

#### Scenario: Worker Custom Domain API call fails
- **WHEN** the zone is resolved but the Worker Custom Domain creation fails (network error, permissions, etc.)
- **THEN** the gateway logs the error and continues domain registration
- **AND** the Custom Hostname and KV entry are still created

### Requirement: Worker Custom Domain binding deleted on domain removal

When a custom domain is deleted via `DELETE /v1/domains/:domain`, the gateway SHALL delete the corresponding Worker Custom Domain binding if one exists.

#### Scenario: Domain with stored zone_id
- **WHEN** a domain is deleted and the `internal.domains` record has a non-null `cloudflare_zone_id`
- **THEN** the gateway calls the Worker Custom Domains delete API for the hostname
- **AND** the Custom Hostname and KV entry are also deleted (existing behavior)

#### Scenario: Domain without stored zone_id
- **WHEN** a domain is deleted and the `internal.domains` record has a null `cloudflare_zone_id`
- **THEN** the gateway skips the Worker Custom Domain delete call
- **AND** the Custom Hostname and KV entry are still deleted (existing behavior)

#### Scenario: Worker Custom Domain delete fails
- **WHEN** the Worker Custom Domain delete API call fails
- **THEN** the gateway logs the error and continues with the rest of the domain deletion

### Requirement: Zone resolution via Cloudflare Zones API

The gateway SHALL resolve a domain's Cloudflare zone_id by calling `GET /zones?name={base_domain}` where `base_domain` is extracted by taking the last two labels of the hostname (e.g., `barrio.wildlychee.com` → `wildlychee.com`).

#### Scenario: Single matching zone
- **WHEN** the Zones API returns exactly one zone matching the base domain
- **THEN** the gateway uses that zone's ID

#### Scenario: No matching zone
- **WHEN** the Zones API returns no results
- **THEN** the zone resolution returns null

#### Scenario: Cloudflare API not configured
- **WHEN** `CLOUDFLARE_API_TOKEN` or `CLOUDFLARE_KV_ACCOUNT_ID` is not set
- **THEN** zone resolution returns null without making an API call

### Requirement: Database schema stores zone_id

The `internal.domains` table SHALL include a `cloudflare_zone_id` column to store the resolved zone_id for each custom domain.

#### Scenario: New column added on startup
- **WHEN** the gateway starts and the `cloudflare_zone_id` column does not exist
- **THEN** the gateway adds the column via `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`

#### Scenario: Existing domains unaffected
- **WHEN** the column is added and existing domain records have no zone_id
- **THEN** the column defaults to NULL for existing records

### Requirement: Worker name configurable via env var

The Worker service name used in the Worker Custom Domain binding SHALL be configurable via the `CLOUDFLARE_WORKER_NAME` environment variable, defaulting to `run402-custom-domains`.

#### Scenario: Env var set
- **WHEN** `CLOUDFLARE_WORKER_NAME` is set to `my-worker`
- **THEN** Worker Custom Domain bindings use `service: my-worker`

#### Scenario: Env var not set
- **WHEN** `CLOUDFLARE_WORKER_NAME` is not set
- **THEN** Worker Custom Domain bindings use `service: run402-custom-domains`
