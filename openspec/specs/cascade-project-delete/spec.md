### Requirement: Project deletion cascades to Lambda functions
When a project is deleted, the platform SHALL delete all AWS Lambda functions owned by that project and remove their records from `internal.functions`.

#### Scenario: Project with deployed functions is deleted
- **WHEN** a project with 3 deployed Lambda functions is deleted via `DELETE /projects/v1/:id`
- **THEN** the platform SHALL call AWS `DeleteFunction` for each Lambda function and delete all 3 rows from `internal.functions`

#### Scenario: Lambda deletion fails for one function
- **WHEN** a project is deleted and AWS `DeleteFunction` fails for one of its functions (e.g., function already deleted)
- **THEN** the platform SHALL log a warning, continue deleting remaining functions, and still complete the project archive

#### Scenario: Project with no functions is deleted
- **WHEN** a project with no deployed functions is deleted
- **THEN** the platform SHALL skip Lambda cleanup and proceed with the rest of the cascade

### Requirement: Project deletion cascades to secrets
When a project is deleted, the platform SHALL delete all secrets from `internal.secrets` for that project.

#### Scenario: Project with secrets is deleted
- **WHEN** a project with secrets stored in `internal.secrets` is deleted
- **THEN** the platform SHALL delete all rows from `internal.secrets` where `project_id` matches

### Requirement: Project deletion cascades to subdomains
When a project is deleted, the platform SHALL release all subdomains claimed by that project, including removing Route 53 DNS records and deleting rows from `internal.subdomains`.

#### Scenario: Project with a custom subdomain is deleted
- **WHEN** a project that owns subdomain `myapp` (pointing to `myapp.run402.com`) is deleted
- **THEN** the platform SHALL delete the Route 53 CNAME record for `myapp.run402.com` and remove the row from `internal.subdomains`

#### Scenario: Route 53 deletion fails
- **WHEN** a project is deleted and Route 53 record deletion fails for a subdomain
- **THEN** the platform SHALL log a warning and still delete the `internal.subdomains` row so the subdomain can be reclaimed

### Requirement: Project deletion cascades to site deployments
When a project is deleted, the platform SHALL delete all S3 site files for each deployment and remove deployment records from `internal.deployments`.

#### Scenario: Project with site deployments is deleted
- **WHEN** a project with 2 site deployments is deleted
- **THEN** the platform SHALL delete all S3 objects under `sites/{deployment_id}/` for each deployment and remove both rows from `internal.deployments`

#### Scenario: S3 deletion fails for a deployment
- **WHEN** S3 file deletion fails for one deployment
- **THEN** the platform SHALL log a warning, continue with other deployments, and still complete the project archive

### Requirement: Project deletion cascades to published app versions
When a project is deleted, the platform SHALL delete all published app versions from `internal.app_versions` for that project.

#### Scenario: Project with a published app version is deleted
- **WHEN** a project that has been published to the marketplace is deleted
- **THEN** the platform SHALL delete all rows from `internal.app_versions` where `project_id` matches (and cascade to `internal.app_version_functions` via FK)

### Requirement: Project deletion cascades to OAuth transactions
When a project is deleted, the platform SHALL delete all OAuth transactions from `internal.oauth_transactions` for that project.

#### Scenario: Project with OAuth transactions is deleted
- **WHEN** a project with pending or completed OAuth transactions is deleted
- **THEN** the platform SHALL delete all rows from `internal.oauth_transactions` where `project_id` matches

### Requirement: Project deletion cascades to mailbox
When a project is deleted, the platform SHALL tombstone the project's mailbox (if any), setting its status to `tombstoned` and recording `tombstoned_at`. The email address SHALL not be reusable for 90 days.

#### Scenario: Project with active mailbox is deleted
- **WHEN** a project with an active mailbox `myapp@mail.run402.com` is deleted via `DELETE /projects/v1/:id`
- **THEN** the platform SHALL set the mailbox status to `tombstoned`, set `tombstoned_at` to now, and log the tombstoning

#### Scenario: Project without mailbox is deleted
- **WHEN** a project with no mailbox is deleted
- **THEN** the platform SHALL skip mailbox cleanup and proceed with the rest of the cascade

#### Scenario: Mailbox tombstoning fails
- **WHEN** a project is deleted and the mailbox tombstoning DB update fails
- **THEN** the platform SHALL log a warning and still complete the project archive

### Requirement: Cascade cleanup is best-effort
Each cleanup step SHALL execute independently. A failure in any single step (Lambda, S3, Route 53, email) SHALL NOT prevent the remaining steps or the final project archive from completing.

#### Scenario: Multiple cleanup steps fail
- **WHEN** a project is deleted and both Lambda deletion and email tombstoning fail
- **THEN** the platform SHALL log warnings for both failures, complete the remaining cleanup steps (secrets, subdomains DB, deployments DB, app_versions, oauth_transactions, mailbox, schema drop), and still mark the project as archived

### Requirement: Lease expiration triggers the same cascade
The cascade cleanup SHALL apply identically whether the project is deleted explicitly via `DELETE /projects/v1/:id` or automatically via the terminal purge transition at the end of the lifecycle grace window (see `project-lifecycle`). The lease expiration checker SHALL NOT invoke the cascade directly; it SHALL advance the project's lifecycle state instead, and the cascade SHALL fire only when the project reaches `status = 'purged'`.

#### Scenario: Lease expires on a project with subdomains and functions
- **WHEN** a wallet's tier lease expires and the project eventually reaches `status = 'dormant'` with `scheduled_purge_at <= NOW()`
- **THEN** the platform SHALL cascade-delete all resources (Lambda, subdomain, mailbox, etc.) as part of the `purge` transition, using the same logic as explicit deletion

#### Scenario: Lease expires but wallet renews before purge time
- **WHEN** a wallet's lease expires, the project enters grace, and the wallet is renewed before `scheduled_purge_at`
- **THEN** the platform SHALL NOT invoke the cascade, and SHALL transition the project back to `status = 'active'` with all resources intact

### Requirement: Lease expiration cascades to mailbox
The mailbox tombstoning SHALL apply identically whether the project is deleted explicitly or via the terminal purge transition at the end of the lifecycle grace window. Mailbox tombstoning SHALL NOT occur while the project is in `past_due`, `frozen`, or `dormant` — incoming email SHALL continue to be accepted during grace.

#### Scenario: Project enters grace with an active mailbox
- **WHEN** a project with an active mailbox transitions from `active` to `past_due`
- **THEN** the platform SHALL leave the mailbox in its active state and continue accepting inbound email

#### Scenario: Project reaches purge with a mailbox
- **WHEN** a project with an active mailbox reaches `status = 'purged'`
- **THEN** the platform SHALL tombstone the mailbox using the same logic as explicit deletion, setting `tombstoned_at` and preventing reuse of the address for 90 days
