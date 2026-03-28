## ADDED Requirements

### Requirement: Static assets for custom subdomains are served from CloudFront edge
The system SHALL serve static asset requests (CSS, JS, images, fonts, etc.) for custom subdomains (`{name}.run402.com`) from CloudFront edge locations using the S3 storage bucket as origin. Asset responses SHALL include `Cache-Control: public, max-age=31536000, immutable`.

#### Scenario: CSS file served from edge with immutable caching
- **WHEN** a browser requests `https://myapp.run402.com/style.css`
- **THEN** CloudFront SHALL resolve `myapp` to its deployment ID, fetch `sites/{deployment_id}/style.css` from S3, and return the file with `Cache-Control: public, max-age=31536000, immutable`

#### Scenario: Image served from edge
- **WHEN** a browser requests `https://myapp.run402.com/logo.png`
- **THEN** CloudFront SHALL serve the file from the edge cache (or S3 on miss) with immutable caching

#### Scenario: Subsequent requests served from cache
- **WHEN** a browser requests an asset that has been previously fetched at the same edge location
- **THEN** CloudFront SHALL return the cached response without contacting S3 (response includes `x-cache: Hit from cloudfront`)

### Requirement: HTML requests for custom subdomains are served through the gateway
The system SHALL route HTML requests (paths without file extensions, or `.html` paths) for custom subdomains through the ALB gateway origin. The gateway SHALL inject the fork badge and return responses with `Cache-Control: public, max-age=60`.

#### Scenario: Root page served through gateway with fork badge
- **WHEN** a browser requests `https://myapp.run402.com/`
- **THEN** the request SHALL reach the gateway, which injects the fork badge (if applicable) and returns HTML with `Cache-Control: public, max-age=60`

#### Scenario: SPA route served through gateway
- **WHEN** a browser requests `https://myapp.run402.com/dashboard/settings`
- **THEN** the request SHALL reach the gateway (path has no file extension), which serves `index.html` with fork badge injection

### Requirement: Redeploying a site immediately serves new assets
The system SHALL ensure that after a site redeploy and subdomain reassignment, all subsequent asset requests return the new deployment's files with no stale-cache window.

#### Scenario: CSS updated after redeploy
- **WHEN** an agent deploys a new version of a site and the subdomain is reassigned to the new deployment
- **THEN** the subdomain-to-deployment mapping SHALL be updated in the KeyValueStore, and subsequent requests for `style.css` SHALL resolve to the new deployment's S3 prefix, returning the updated file

#### Scenario: No stale assets from previous deployment
- **WHEN** a browser requests an asset after a redeploy and the browser has no cached copy
- **THEN** the response SHALL contain the new deployment's file content (not the previous deployment's)

### Requirement: KeyValueStore contains subdomain-to-deployment mappings
The system SHALL maintain a CloudFront KeyValueStore with entries mapping each custom subdomain name to its current deployment ID. The KVS SHALL be updated synchronously on every subdomain mutation.

#### Scenario: Subdomain claim updates KVS
- **WHEN** an agent claims a subdomain via the API (`POST /subdomains/v1`)
- **THEN** the system SHALL write the subdomain name → deployment ID mapping to the KeyValueStore after the database write succeeds

#### Scenario: Subdomain reassignment updates KVS
- **WHEN** a subdomain is reassigned to a new deployment
- **THEN** the system SHALL update the KeyValueStore entry with the new deployment ID

#### Scenario: Subdomain deletion removes KVS entry
- **WHEN** a subdomain is deleted via the API
- **THEN** the system SHALL remove the subdomain entry from the KeyValueStore

#### Scenario: KVS write failure does not fail the API request
- **WHEN** the KeyValueStore write fails (network error, throttling)
- **THEN** the API request SHALL still succeed (database is source of truth), the error SHALL be logged, and the periodic reconciliation job SHALL fix the KVS within 5 minutes

### Requirement: Periodic reconciliation syncs KVS with database
The system SHALL run a periodic reconciliation check (every 5 minutes) that compares the database subdomain table with the KeyValueStore and corrects any drift.

#### Scenario: KVS missing an entry that exists in database
- **WHEN** the reconciliation job finds a subdomain in the database that is not in the KVS
- **THEN** the job SHALL add the missing entry to the KVS and log the correction

#### Scenario: KVS has stale deployment ID
- **WHEN** the reconciliation job finds a KVS entry whose deployment ID differs from the database
- **THEN** the job SHALL update the KVS entry to match the database

#### Scenario: KVS has entry for deleted subdomain
- **WHEN** the reconciliation job finds a KVS entry that has no corresponding database record
- **THEN** the job SHALL remove the orphaned KVS entry

### Requirement: API traffic is not affected by CloudFront
The system SHALL ensure that requests to `api.run402.com` continue to route directly to the ALB, bypassing CloudFront entirely.

#### Scenario: API health check bypasses CloudFront
- **WHEN** a client requests `https://api.run402.com/health`
- **THEN** the request SHALL route to the ALB directly (no CloudFront headers in response)

#### Scenario: REST API bypasses CloudFront
- **WHEN** a client requests `https://api.run402.com/rest/v1/items`
- **THEN** the request SHALL route to the ALB directly

### Requirement: Unknown subdomain returns 404 for assets
The system SHALL return a 404 response when a CloudFront Function cannot resolve a subdomain name in the KeyValueStore.

#### Scenario: Non-existent subdomain asset request
- **WHEN** a browser requests `https://nonexistent.run402.com/style.css` and `nonexistent` is not in the KVS
- **THEN** CloudFront SHALL return 404
