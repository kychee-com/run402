## ADDED Requirements

### Requirement: MX record for inbound email
The system SHALL have an MX record for `mail.run402.com` pointing to the SES inbound SMTP endpoint in us-east-1.

#### Scenario: DNS lookup for mail.run402.com
- **WHEN** an external mail server looks up MX records for `mail.run402.com`
- **THEN** it SHALL find `10 inbound-smtp.us-east-1.amazonaws.com`

### Requirement: SES receipt rule processes inbound
The system SHALL configure an SES receipt rule set that stores raw inbound email in S3 and triggers a Lambda function for processing.

#### Scenario: Inbound email received
- **WHEN** an email arrives at `workout-tracker@mail.run402.com`
- **THEN** SES SHALL store the raw MIME in S3 under `inbound-email/{message-id}.eml` and invoke the inbound processing Lambda

### Requirement: Reply-only inbound policy
The system SHALL accept inbound email only from addresses that the mailbox has previously sent to. All other inbound SHALL be silently dropped (no bounce to avoid backscatter).

#### Scenario: Valid reply from prior recipient
- **WHEN** `user@example.com` sends a reply to `workout-tracker@mail.run402.com` and the mailbox has a sent record to `user@example.com`
- **THEN** the system SHALL accept the email, parse it, and store it as a reply in `internal.email_messages`

#### Scenario: Unsolicited inbound from unknown sender
- **WHEN** `spammer@evil.com` sends an email to `workout-tracker@mail.run402.com` and no sent record exists for that address
- **THEN** the system SHALL drop the email silently (no bounce, no storage)

#### Scenario: Inbound to non-existent mailbox
- **WHEN** an email arrives at `nonexistent@mail.run402.com` and no mailbox record exists for slug `nonexistent`
- **THEN** the system SHALL drop the email silently

#### Scenario: Inbound to tombstoned mailbox
- **WHEN** an email arrives at a mailbox that has been tombstoned
- **THEN** the system SHALL drop the email silently

### Requirement: Parse inbound email
The Lambda function SHALL parse the raw MIME email and extract: sender address, subject, plain-text body (stripped of quoted reply content where possible), and received timestamp. HTML-only emails SHALL have their text content extracted.

#### Scenario: Plain text reply
- **WHEN** a user replies with a plain-text email
- **THEN** the system SHALL store the body text (with quoted content stripped) as a reply record linked to the original sent message

#### Scenario: HTML-only reply
- **WHEN** a user replies with an HTML-only email
- **THEN** the system SHALL extract text from HTML and store it as the reply body

### Requirement: Link replies to original messages
The system SHALL link inbound replies to the original outbound message using email headers (`In-Reply-To`, `References`) or the recipient address. If no match is found, the reply SHALL be stored as an unlinked message on the mailbox.

#### Scenario: Reply with In-Reply-To header
- **WHEN** a reply includes an `In-Reply-To` header matching a sent message's `Message-ID`
- **THEN** the system SHALL store the reply linked to that original message

#### Scenario: Reply without threading headers
- **WHEN** a reply arrives without `In-Reply-To` or `References` headers
- **THEN** the system SHALL attempt to match by sender address against recent sent messages, or store as unlinked
