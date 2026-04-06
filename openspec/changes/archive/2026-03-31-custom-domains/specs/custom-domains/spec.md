## ADDED Requirements

### Requirement: Register a custom domain
The system SHALL allow a user to register a custom domain for an existing Run402 subdomain via `POST /v1/domains`. The request MUST include `domain` (the custom domain, e.g., `wildlychee.com`) and `subdomain_name` (the Run402 subdomain it maps to). Auth: service_key or admin.

#### Scenario: Successful domain registration
- **WHEN** user calls `POST /v1/domains` with `{ "domain": "wildlychee.com", "subdomain_name": "wildlychee" }`
- **THEN** the system creates an `internal.domains` record, registers the custom hostname with Cloudflare, writes the domain→deployment_id mapping to Cloudflare KV, and returns the domain record with status `pending` and DNS instructions

#### Scenario: Subdomain does not exist
- **WHEN** user calls `POST /v1/domains` with a `subdomain_name` that has no matching subdomain record
- **THEN** the system returns 404 with message "Subdomain not found"

#### Scenario: Subdomain belongs to different project
- **WHEN** user calls `POST /v1/domains` with a `subdomain_name` owned by a different project
- **THEN** the system returns 403 with message "Subdomain owned by another project"

#### Scenario: Domain already registered
- **WHEN** user calls `POST /v1/domains` with a domain that is already registered (by any project)
- **THEN** the system returns 409 with message "Domain already registered"

#### Scenario: Invalid domain format
- **WHEN** user calls `POST /v1/domains` with an invalid domain (e.g., no TLD, invalid characters)
- **THEN** the system returns 400 with a validation error message

### Requirement: Check domain status
The system SHALL allow checking the verification and SSL status of a registered domain via `GET /v1/domains/:domain`. No auth required.

#### Scenario: Domain is pending verification
- **WHEN** user calls `GET /v1/domains/wildlychee.com` and the domain's DNS is not yet configured
- **THEN** the system returns the domain record with `status: "pending"` and the DNS instructions (CNAME target and/or TXT record)

#### Scenario: Domain is active
- **WHEN** user calls `GET /v1/domains/wildlychee.com` and Cloudflare has verified DNS and provisioned SSL
- **THEN** the system returns the domain record with `status: "active"`

#### Scenario: Domain not found
- **WHEN** user calls `GET /v1/domains/unknown.com`
- **THEN** the system returns 404

### Requirement: List project domains
The system SHALL allow listing all custom domains for a project via `GET /v1/domains`. Auth: service_key (lists project domains) or admin (lists all).

#### Scenario: List project domains
- **WHEN** user calls `GET /v1/domains` with service_key auth
- **THEN** the system returns all custom domains belonging to the authenticated project

#### Scenario: Admin lists all domains
- **WHEN** admin calls `GET /v1/domains`
- **THEN** the system returns all custom domains across all projects

### Requirement: Delete a custom domain
The system SHALL allow deleting a custom domain via `DELETE /v1/domains/:domain`. Auth: service_key (must own the linked subdomain) or admin. The system MUST remove the Cloudflare custom hostname, delete the Cloudflare KV entry, and delete the `internal.domains` record.

#### Scenario: Successful deletion
- **WHEN** user calls `DELETE /v1/domains/wildlychee.com` and owns the linked subdomain
- **THEN** the system removes the Cloudflare hostname and KV entry, deletes the DB record, and returns `{ "status": "deleted", "domain": "wildlychee.com" }`

#### Scenario: Domain owned by different project
- **WHEN** user calls `DELETE /v1/domains/wildlychee.com` and the linked subdomain belongs to a different project
- **THEN** the system returns 403

#### Scenario: Domain not found
- **WHEN** user calls `DELETE /v1/domains/unknown.com`
- **THEN** the system returns 404

### Requirement: Custom domain follows subdomain redeployment
When a subdomain is redeployed (new deployment_id), the system SHALL automatically update the Cloudflare KV entry for any linked custom domain so the custom domain serves the new deployment without additional API calls.

#### Scenario: Subdomain redeployed with linked custom domain
- **WHEN** subdomain `wildlychee` is reassigned to deployment `dpl_new_456` and `wildlychee.com` is linked to it
- **THEN** the Cloudflare KV entry for `wildlychee.com` is updated to `dpl_new_456`

### Requirement: Custom domain deleted on subdomain release
When a subdomain is deleted, the system SHALL automatically delete any linked custom domain (Cloudflare hostname, KV entry, DB record).

#### Scenario: Subdomain released with linked custom domain
- **WHEN** subdomain `wildlychee` is deleted and `wildlychee.com` is linked to it
- **THEN** the custom domain `wildlychee.com` is also deleted from Cloudflare and the database

### Requirement: Edge routing for custom domains
The Cloudflare Worker SHALL serve files from S3 for verified custom domains. It MUST support SPA fallback (serve `index.html` for paths without file extensions) and set appropriate cache headers.

#### Scenario: Asset request on custom domain
- **WHEN** a request arrives at `wildlychee.com/style.css` and the domain is active
- **THEN** the Worker looks up `wildlychee.com` in KV, gets the deployment_id, fetches `sites/{deployment_id}/style.css` from S3, and returns it with `Cache-Control: public, max-age=31536000, immutable`

#### Scenario: HTML request on custom domain
- **WHEN** a request arrives at `wildlychee.com/` (or any path without a file extension)
- **THEN** the Worker serves `sites/{deployment_id}/index.html` from S3 with `Cache-Control: public, max-age=60`

#### Scenario: Unknown domain
- **WHEN** a request arrives at a domain not in KV
- **THEN** the Worker returns 404

### Requirement: Domain table schema
The system SHALL store custom domain registrations in `internal.domains` with columns: `domain` (TEXT PRIMARY KEY), `subdomain_name` (TEXT NOT NULL, references internal.subdomains), `project_id` (TEXT), `cloudflare_hostname_id` (TEXT — the Cloudflare custom hostname ID for API operations), `status` (TEXT — pending/active/error), `dns_instructions` (JSONB — CNAME target, TXT records), `created_at` (TIMESTAMPTZ), `updated_at` (TIMESTAMPTZ).

#### Scenario: Table is created on gateway startup
- **WHEN** the gateway starts
- **THEN** the `internal.domains` table exists with the specified schema and indexes on `subdomain_name` and `project_id`

### Requirement: Cloudflare KV reconciliation
The system SHALL periodically reconcile Cloudflare KV with the `internal.domains` table, using the same pattern as the existing CloudFront KVS reconciliation: add missing entries, update stale entries, remove orphaned entries.

#### Scenario: Drift detected and corrected
- **WHEN** the reconciliation job runs and finds a domain in the DB but not in KV
- **THEN** the system writes the missing entry to KV

#### Scenario: Orphaned KV entry
- **WHEN** the reconciliation job finds a domain in KV but not in the DB
- **THEN** the system deletes the orphaned KV entry
