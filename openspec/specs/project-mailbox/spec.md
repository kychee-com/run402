## ADDED Requirements

### Requirement: Create a mailbox for a project
The system SHALL allow creating one mailbox per project via `POST /v1/mailboxes`. The mailbox address SHALL be `<slug>@mail.run402.com` where slug is derived from the project name. Auth SHALL require a valid `service_key`.

#### Scenario: Successful mailbox creation
- **WHEN** an agent calls `POST /v1/mailboxes` with a valid service_key and body `{"slug": "workout-tracker"}`
- **THEN** the system SHALL create a mailbox record in `internal.mailboxes`, return 201 with `{"mailbox_id", "address": "workout-tracker@mail.run402.com", "project_id", "created_at"}`

#### Scenario: Slug already taken
- **WHEN** an agent calls `POST /v1/mailboxes` with a slug that is already claimed by another project
- **THEN** the system SHALL return 409 with `{"error": "Slug already in use"}`

#### Scenario: Slug is tombstoned
- **WHEN** an agent calls `POST /v1/mailboxes` with a slug that was deleted less than 90 days ago
- **THEN** the system SHALL return 409 with `{"error": "Address is in cooldown period"}`

#### Scenario: Project already has a mailbox
- **WHEN** an agent calls `POST /v1/mailboxes` and the project already has an active mailbox
- **THEN** the system SHALL return 409 with `{"error": "Project already has a mailbox"}`

### Requirement: Mailbox slug validation
The system SHALL validate mailbox slugs with the same rules as subdomain names: 3-63 characters, lowercase alphanumeric and hyphens, no consecutive hyphens, must start and end with alphanumeric.

#### Scenario: Invalid slug
- **WHEN** an agent calls `POST /v1/mailboxes` with slug `"AB!"`
- **THEN** the system SHALL return 400 with a validation error message

#### Scenario: Reserved slug
- **WHEN** an agent calls `POST /v1/mailboxes` with slug `"admin"`
- **THEN** the system SHALL return 400 with `{"error": "Slug \"admin\" is reserved"}`

### Requirement: Reserved email slug blocklist
The system SHALL reject the following slugs (at minimum): `admin`, `info`, `support`, `help`, `hello`, `contact`, `sales`, `billing`, `accounts`, `legal`, `privacy`, `security`, `press`, `media`, `jobs`, `careers`, `team`, `ops`, `status`, `api`, `docs`, `dashboard`, `run402`, `agentdb`, `abuse`, `postmaster`, `hostmaster`, `webmaster`, `mailer-daemon`, `bounce`, `bounces`, `smtp`, `imap`, `pop`, `mx`, `dkim`, `dmarc`, `noreply`, `no-reply`, `tal`, `barry`, `ceo`, `founder`, `owner`, `finance`, `payroll`, `hr`.

#### Scenario: Blocklist check
- **WHEN** an agent calls `POST /v1/mailboxes` with slug `"postmaster"`
- **THEN** the system SHALL return 400 with `{"error": "Slug \"postmaster\" is reserved"}`

### Requirement: Get mailbox details
The system SHALL return mailbox details including address, usage stats, and current limits via `GET /v1/mailboxes/:id`.

#### Scenario: Get existing mailbox
- **WHEN** an agent calls `GET /v1/mailboxes/:id` with a valid service_key matching the mailbox's project
- **THEN** the system SHALL return 200 with `{"mailbox_id", "address", "project_id", "sends_today", "unique_recipients", "daily_limit", "recipient_limit", "status", "created_at"}`

#### Scenario: Mailbox not found
- **WHEN** an agent calls `GET /v1/mailboxes/:id` with a non-existent ID
- **THEN** the system SHALL return 404

### Requirement: List project mailboxes
The system SHALL return all mailboxes for the authenticated project via `GET /v1/mailboxes`.

#### Scenario: List mailboxes
- **WHEN** an agent calls `GET /v1/mailboxes` with a valid service_key
- **THEN** the system SHALL return 200 with `{"mailboxes": [...]}` containing all mailboxes for the project (currently max 1)

### Requirement: Delete a mailbox
The system SHALL allow deleting a mailbox via `DELETE /v1/mailboxes/:id`. The slug SHALL enter a 90-day tombstone period.

#### Scenario: Successful deletion
- **WHEN** an agent calls `DELETE /v1/mailboxes/:id` with a valid service_key matching the mailbox's project
- **THEN** the system SHALL mark the mailbox as `tombstoned`, set `tombstoned_at` to now, and return 200 with `{"status": "deleted", "address": "..."}`

#### Scenario: Wrong project
- **WHEN** an agent calls `DELETE /v1/mailboxes/:id` with a service_key for a different project
- **THEN** the system SHALL return 403

### Requirement: Mailbox lifecycle tied to project
The system SHALL archive a project's mailbox when the project is archived (explicit delete or lease expiration). The mailbox SHALL enter the tombstone period automatically.

#### Scenario: Project archived with active mailbox
- **WHEN** a project with an active mailbox is archived via `DELETE /projects/v1/:id`
- **THEN** the system SHALL tombstone the mailbox as part of the cascade cleanup

### Requirement: Mailbox status reflects suspension
The system SHALL track mailbox status as one of: `active`, `suspended`, `tombstoned`. A suspended mailbox SHALL reject all send requests.

#### Scenario: Send from suspended mailbox
- **WHEN** an agent calls `POST /v1/mailboxes/:id/messages` on a suspended mailbox
- **THEN** the system SHALL return 403 with `{"error": "Mailbox is suspended due to abuse"}`
