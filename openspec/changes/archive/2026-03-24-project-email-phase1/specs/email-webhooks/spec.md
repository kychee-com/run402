## ADDED Requirements

### Requirement: Track SES delivery events
The system SHALL track delivery, bounce, and complaint events from SES via SNS notifications and update the corresponding message record in `internal.email_messages`.

#### Scenario: Successful delivery
- **WHEN** SES reports a successful delivery for a sent message
- **THEN** the system SHALL update the message status to `delivered`

#### Scenario: Hard bounce
- **WHEN** SES reports a hard bounce for a sent message
- **THEN** the system SHALL update the message status to `bounced` and add the recipient to the project's suppression list

#### Scenario: Complaint (spam report)
- **WHEN** SES reports a complaint for a sent message
- **THEN** the system SHALL update the message status to `complained`, add the recipient to the global suppression list, and suspend the mailbox

### Requirement: Auto-suspend on abuse
The system SHALL automatically suspend a mailbox when it receives a spam complaint or exceeds a bounce threshold (3 hard bounces in a 24-hour window).

#### Scenario: First complaint suspends
- **WHEN** a mailbox receives its first spam complaint
- **THEN** the system SHALL set mailbox status to `suspended` and log the event

#### Scenario: Bounce threshold exceeded
- **WHEN** a mailbox has 3 hard bounces within 24 hours
- **THEN** the system SHALL set mailbox status to `suspended`

#### Scenario: Suspended mailbox requires admin review
- **WHEN** a mailbox is suspended
- **THEN** only an admin SHALL be able to reactivate it via `PUT /v1/mailboxes/:id/status`

### Requirement: Suppression lists
The system SHALL maintain a global suppression list and per-project suppression list. The system SHALL NOT send to any address on either list.

#### Scenario: Send to globally suppressed address
- **WHEN** an agent tries to send to an address that has filed a complaint on any mailbox
- **THEN** the system SHALL return 400 with `{"error": "Recipient address is suppressed"}`

#### Scenario: Send to project-suppressed address
- **WHEN** an agent tries to send to an address that hard-bounced on this project's mailbox
- **THEN** the system SHALL return 400 with `{"error": "Recipient address is suppressed"}`

### Requirement: Project webhook fan-out
The system SHALL allow projects to register a webhook URL to receive email events (delivery, bounce, complaint, reply_received) via `POST /v1/mailboxes/:id/webhooks`.

#### Scenario: Register webhook
- **WHEN** an agent calls `POST /v1/mailboxes/:id/webhooks` with `{"url": "https://myapp.run402.com/api/email-events", "events": ["reply_received", "bounced"]}`
- **THEN** the system SHALL store the webhook config and return 201

#### Scenario: Webhook fired on reply
- **WHEN** a reply is received and the mailbox has a webhook registered for `reply_received`
- **THEN** the system SHALL POST to the webhook URL with `{"event": "reply_received", "mailbox_id", "message_id", "from", "body_text", "received_at"}`

#### Scenario: Webhook delivery failure
- **WHEN** a webhook POST fails (non-2xx response or timeout)
- **THEN** the system SHALL retry up to 3 times with exponential backoff, then mark the event as `webhook_failed`
