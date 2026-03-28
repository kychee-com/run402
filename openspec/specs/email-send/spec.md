## ADDED Requirements

### Requirement: Send template-based email
The system SHALL allow sending emails via `POST /v1/mailboxes/:id/messages` using predefined templates. Auth SHALL require a valid `service_key` matching the mailbox's project.

#### Scenario: Send a project invite
- **WHEN** an agent calls `POST /v1/mailboxes/:id/messages` with `{"template": "project_invite", "to": "user@example.com", "variables": {"project_name": "Workout Tracker", "invite_url": "https://myapp.run402.com/invite/abc"}}`
- **THEN** the system SHALL send the email via SES from the mailbox address, store a record in `internal.email_messages`, and return 201 with `{"message_id", "to", "template", "status": "sent", "sent_at"}`

#### Scenario: Invalid template name
- **WHEN** an agent sends a message with `"template": "marketing_blast"`
- **THEN** the system SHALL return 400 with `{"error": "Unknown template. Valid templates: project_invite, magic_link, notification"}`

### Requirement: Available email templates
The system SHALL support the following templates:
- `project_invite` — requires `project_name`, `invite_url`
- `magic_link` — requires `project_name`, `link_url`, `expires_in`
- `notification` — requires `project_name`, `message` (freeform text, max 500 chars)

#### Scenario: Missing template variable
- **WHEN** an agent sends a `project_invite` without the `invite_url` variable
- **THEN** the system SHALL return 400 with `{"error": "Missing required variable: invite_url"}`

#### Scenario: Notification message too long
- **WHEN** an agent sends a `notification` with a `message` variable exceeding 500 characters
- **THEN** the system SHALL return 400 with `{"error": "Message exceeds 500 character limit"}`

### Requirement: Single recipient per send
The system SHALL accept exactly one recipient email address per send request. The `to` field SHALL be a single email string, not an array.

#### Scenario: Send to one recipient
- **WHEN** an agent sends a message with `"to": "user@example.com"`
- **THEN** the system SHALL send to that single recipient

#### Scenario: Array of recipients rejected
- **WHEN** an agent sends a message with `"to": ["a@x.com", "b@x.com"]`
- **THEN** the system SHALL return 400 with `{"error": "Only one recipient per send"}`

### Requirement: Branded footer on all outbound
The system SHALL append a footer to every outbound email: "Sent by an AI agent via run402.com". The footer SHALL include a link to `https://run402.com`.

#### Scenario: Footer present
- **WHEN** any email is sent through the system
- **THEN** the email body SHALL end with the branded footer line

### Requirement: Daily send rate limit
The system SHALL enforce a daily send limit per mailbox based on the project's tier: prototype=10, hobby=50, team=500. The counter resets at midnight UTC.

#### Scenario: Daily limit reached
- **WHEN** a prototype-tier mailbox has sent 10 emails today and the agent sends another
- **THEN** the system SHALL return 429 with `{"error": "Daily send limit reached", "limit": 10, "resets_at": "2026-03-25T00:00:00Z"}`

### Requirement: Unique recipient cap per lease
The system SHALL enforce a unique-recipient cap per mailbox over the project's lease period: prototype=25, hobby=200, team=1000.

#### Scenario: Unique recipient limit reached
- **WHEN** a prototype-tier mailbox has sent to 25 unique addresses this lease and the agent sends to a new address
- **THEN** the system SHALL return 429 with `{"error": "Unique recipient limit reached", "limit": 25}`

#### Scenario: Repeat recipient allowed
- **WHEN** a mailbox has sent to 25 unique addresses and the agent sends to one of those same addresses again
- **THEN** the system SHALL allow the send (subject to daily limit)

### Requirement: Return 402 on cap exhaustion
When a mailbox hits its tier cap and the project could upgrade to a higher tier, the system SHALL return 402 with a tier upgrade quote instead of a plain 429.

#### Scenario: Prototype hits limit, upgrade available
- **WHEN** a prototype-tier mailbox hits its daily limit
- **THEN** the system SHALL return 402 with `{"error": "Daily send limit reached", "upgrade": {"tier": "hobby", "price": "$5.00", "daily_limit": 50}}`

### Requirement: List sent messages
The system SHALL return sent messages for a mailbox via `GET /v1/mailboxes/:id/messages` with pagination.

#### Scenario: List messages
- **WHEN** an agent calls `GET /v1/mailboxes/:id/messages` with a valid service_key
- **THEN** the system SHALL return 200 with `{"messages": [{"message_id", "to", "template", "status", "sent_at"}], "has_more", "next_cursor"}`

### Requirement: Get single message
The system SHALL return a single message's details via `GET /v1/mailboxes/:id/messages/:messageId`.

#### Scenario: Get message with reply
- **WHEN** an agent calls `GET /v1/mailboxes/:id/messages/:messageId` for a message that has received a reply
- **THEN** the system SHALL return the message with `"replies": [{"from", "body_text", "received_at"}]`
