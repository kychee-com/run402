## MODIFIED Requirements

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
