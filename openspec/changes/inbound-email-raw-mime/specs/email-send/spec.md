## ADDED Requirements

### Requirement: Raw MIME accessor for inbound messages

The system SHALL expose the original RFC-822 bytes of an inbound email via `GET /v1/mailboxes/:id/messages/:messageId/raw`. The response body SHALL be the exact bytes of the S3 object persisted by the inbound processing Lambda, with no parsing, normalization, charset decoding, CRLF cleanup, or any other modification. The `Content-Type` SHALL be `message/rfc822`. Auth SHALL require a valid `service_key` matching the mailbox's project, using the same authorization model as the existing `GET /v1/mailboxes/:id/messages/:messageId` endpoint.

The raw accessor is the correct access path for applications performing cryptographic verification over inbound email (e.g., DKIM signature verification, zk-email proofs). The `body_text` field returned by the JSON message endpoint is intended for display and threading only; it has been quoted-content-stripped and is NOT suitable for cryptographic verification.

#### Scenario: Fetch raw MIME for an inbound message

- **WHEN** an agent calls `GET /v1/mailboxes/:id/messages/:messageId/raw` with a valid `service_key` for a message where `direction = 'inbound'` and `s3_key` is populated
- **THEN** the system SHALL return 200 with `Content-Type: message/rfc822`, a `Content-Length` matching the S3 object's byte count, and a response body that is byte-identical to the S3 object

#### Scenario: Raw accessor is inbound-only

- **WHEN** an agent calls the raw endpoint for a message with `direction = 'outbound'`
- **THEN** the system SHALL return 404 with `{"error": "Message not found or no raw MIME available"}`

#### Scenario: Missing s3_key on an inbound row

- **WHEN** an agent calls the raw endpoint for an inbound message whose `s3_key` column is NULL (e.g., legacy row, S3 lifecycle expiration)
- **THEN** the system SHALL return 404 with `{"error": "Message not found or no raw MIME available"}`

#### Scenario: Cross-project access denied

- **WHEN** an agent calls the raw endpoint with a `service_key` belonging to a different project than the mailbox's owning project
- **THEN** the system SHALL return 403 with `{"error": "Mailbox owned by different project"}`

#### Scenario: Oversize message rejected

- **WHEN** an agent calls the raw endpoint for an inbound message whose S3 object exceeds 10 MB (10485760 bytes)
- **THEN** the system SHALL return 413 with `{"error": "Raw MIME exceeds 10MB limit", "limit": 10485760}` without loading the object body into memory

#### Scenario: Bytes are preserved verbatim

- **WHEN** the inbound Lambda stores an email to S3 with a `DKIM-Signature:` header, CRLF (`\r\n`) line endings, and raw 8-bit MIME sections
- **AND** an agent later fetches that message via the raw endpoint
- **THEN** the response body SHALL contain the identical `DKIM-Signature:` header with no header unfolding, the identical CRLF line endings, and the identical 8-bit bytes — bit-for-bit

#### Scenario: Existing JSON endpoint is unchanged

- **WHEN** an agent calls the existing `GET /v1/mailboxes/:id/messages/:messageId` on the same inbound message
- **THEN** the system SHALL return the same JSON shape as before this change (message fields plus `replies`), with `body_text` reflecting the quoted-content-stripped parsed representation, unchanged from prior behavior

### Requirement: Inbound routing on custom sender domains (Phase B — may be deferred)

The system SHALL allow a verified custom sender domain (registered via the existing `custom-sender-domain` capability) to opt in to receiving inbound email, so that replies can arrive at `<slug>@<custom-domain>` rather than `<slug>@mail.run402.com`. Inbound on a custom domain SHALL be opt-in, gated on the domain already being DKIM-verified for outbound, and disabled by default.

When inbound is enabled on a custom domain, the system SHALL update the SES receipt rule set to accept mail for the domain, surface the required MX record to the operator via the domain status endpoint, and route accepted mail through the same inbound Lambda pipeline as `mail.run402.com`. All inbound messages received on a custom domain SHALL have their `s3_key` populated identically to existing inbound, and SHALL be accessible via the Raw MIME accessor defined above.

#### Scenario: Enable inbound on a verified custom domain

- **WHEN** an agent with a verified custom sender domain calls `POST /email/v1/domains/:domain/inbound` with a valid `service_key`
- **THEN** the system SHALL set `inbound_enabled = TRUE` on the `internal.email_domains` row, add the domain to the SES receipt rule's recipient list, and return 200 with `{"status": "enabled", "mx_record": "10 inbound-smtp.us-east-1.amazonaws.com"}`

#### Scenario: Enable inbound on an unverified domain rejected

- **WHEN** an agent calls the enable endpoint on a domain whose `status != 'verified'`
- **THEN** the system SHALL return 409 with `{"error": "Domain must be DKIM-verified before enabling inbound"}`

#### Scenario: Domain status exposes inbound state

- **WHEN** an agent calls `GET /email/v1/domains`
- **THEN** the response SHALL include an `inbound` object with `{"enabled": boolean, "mx_record": "10 inbound-smtp.us-east-1.amazonaws.com", "mx_verified": boolean}` alongside the existing domain fields

#### Scenario: Disable inbound

- **WHEN** an agent calls `DELETE /email/v1/domains/:domain/inbound` with a valid `service_key`
- **THEN** the system SHALL set `inbound_enabled = FALSE`, remove the domain from the SES receipt rule's recipient list, and return 200 with `{"status": "disabled"}`

#### Scenario: Removing a sender domain cascades to disable inbound

- **WHEN** an agent removes a custom sender domain via `DELETE /email/v1/domains/:domain` while inbound is currently enabled on that domain
- **THEN** the system SHALL disable inbound (both DB flag and SES receipt rule) before deleting the domain, leaving no orphaned inbound routing

#### Scenario: Inbound delivered on custom domain populates s3_key

- **WHEN** an email is delivered via SES to `<slug>@<custom-domain>` for a domain with `inbound_enabled = TRUE`
- **THEN** the inbound Lambda SHALL resolve the mailbox by `(slug, project_id)` via the `internal.email_domains` lookup, persist the message to `internal.email_messages` with `direction = 'inbound'` and a populated `s3_key`, and the message SHALL be retrievable via the Raw MIME accessor with bit-identical bytes

#### Scenario: Unknown custom domain dropped

- **WHEN** SES delivers a message to a recipient whose host is neither `mail.run402.com` nor a row in `internal.email_domains` with `inbound_enabled = TRUE`
- **THEN** the inbound Lambda SHALL drop the message (log-and-return) without persisting a row, identical to today's drop path for unrecognized hosts
