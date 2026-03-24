## MODIFIED Requirements

### Requirement: Cascade cleanup is best-effort
Each cleanup step SHALL execute independently. A failure in any single step (Lambda, S3, Route 53, email) SHALL NOT prevent the remaining steps or the final project archive from completing.

#### Scenario: Multiple cleanup steps fail
- **WHEN** a project is deleted and both Lambda deletion and email tombstoning fail
- **THEN** the platform SHALL log warnings for both failures, complete the remaining cleanup steps (secrets, subdomains DB, deployments DB, app_versions, oauth_transactions, mailbox, schema drop), and still mark the project as archived

## ADDED Requirements

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

### Requirement: Lease expiration cascades to mailbox
The mailbox tombstoning SHALL apply identically whether the project is deleted explicitly or via lease expiration.

#### Scenario: Lease expires on project with mailbox
- **WHEN** a wallet's tier lease expires and the lease checker archives a project with an active mailbox
- **THEN** the platform SHALL tombstone the mailbox using the same logic as explicit deletion
