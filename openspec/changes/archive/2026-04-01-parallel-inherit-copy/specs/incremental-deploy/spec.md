## MODIFIED Requirements

### Requirement: Inherited files use S3 server-side copy

Inherited files SHALL be copied using S3 CopyObject (server-side copy) to avoid transferring file content through the gateway. Copies SHALL execute concurrently with a bounded concurrency limit to prevent ALB timeouts on large deployments.

#### Scenario: S3 mode
- **WHEN** the gateway is running with S3 configured
- **THEN** inherited files are copied via `CopyObject` from `sites/{prev_id}/{path}` to `sites/{new_id}/{path}`
- **AND** copies execute concurrently (up to 20 in parallel)

#### Scenario: Local dev mode
- **WHEN** the gateway is running without S3 (local filesystem)
- **THEN** inherited files are copied via filesystem copy from the old deployment directory to the new one

#### Scenario: Inherit copy cannot complete
- **WHEN** an S3 CopyObject call fails during the inherit loop
- **THEN** the gateway returns an HTTP 502 JSON error with the count of files copied vs total
- **AND** no deployment record is inserted into the database
