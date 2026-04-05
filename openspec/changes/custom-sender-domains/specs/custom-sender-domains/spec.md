### Requirement: Register custom sender domain

The gateway SHALL expose `POST /email/v1/domains` for registering a custom sending domain.

#### Scenario: Successful registration

- **WHEN** `POST /email/v1/domains` is called with `{ "domain": "kysigned.com" }` and a valid `service_key`
- **THEN** the gateway SHALL call SES `CreateEmailIdentity` for the domain
- **AND** return HTTP 201 with the domain record including DNS records to add:
  - Three DKIM CNAME records (from SES response)
  - Recommended SPF TXT record (`v=spf1 include:amazonses.com ~all`)
  - Recommended DMARC TXT record (`v=DMARC1; p=quarantine; rua=mailto:dmarc@<domain>`)
- **AND** the domain SHALL be stored with status `pending`

#### Scenario: One domain per project

- **WHEN** a project already has a registered domain (any status) and attempts to register another
- **THEN** the gateway SHALL return HTTP 409 with an error message

#### Scenario: Domain already verified by same wallet

- **WHEN** a domain is already verified by another project owned by the same wallet
- **THEN** the gateway SHALL allow the registration (reuse the existing SES identity)
- **AND** the domain SHALL be stored with status `verified` immediately (no re-verification needed)

#### Scenario: Domain already registered by a different wallet

- **WHEN** a domain is already registered by a project owned by a different wallet
- **THEN** the gateway SHALL return HTTP 409

#### Scenario: Invalid domain format

- **WHEN** the domain is not a valid DNS name (e.g., empty, has spaces, starts with dot)
- **THEN** the gateway SHALL return HTTP 400

#### Scenario: Blocklisted domains

- **WHEN** the domain is `run402.com`, `mail.run402.com`, or any other platform-owned domain
- **THEN** the gateway SHALL return HTTP 400

### Requirement: Check domain verification status

The gateway SHALL expose `GET /email/v1/domains` for checking domain verification status.

#### Scenario: Pending domain

- **WHEN** `GET /email/v1/domains` is called with a valid `service_key`
- **AND** the project has a domain with status `pending`
- **THEN** the gateway SHALL poll SES `GetEmailIdentity` for the current DKIM status
- **AND** return the domain record with `status: "pending"` and the DNS records still needed

#### Scenario: Domain becomes verified

- **WHEN** SES reports DKIM status as `SUCCESS` for the domain
- **THEN** the gateway SHALL update the domain status to `verified`
- **AND** set `verified_at` timestamp
- **AND** return the updated domain record

#### Scenario: No domain registered

- **WHEN** the project has no registered sender domain
- **THEN** the gateway SHALL return HTTP 200 with `{ "domain": null }`

### Requirement: Remove custom sender domain

The gateway SHALL expose `DELETE /email/v1/domains` for removing a custom sender domain.

#### Scenario: Successful removal

- **WHEN** `DELETE /email/v1/domains` is called with a valid `service_key`
- **AND** the project has a registered domain
- **THEN** the gateway SHALL call SES `DeleteEmailIdentity`
- **AND** remove the domain record from the database
- **AND** return HTTP 200
- **AND** subsequent email sends SHALL fall back to `mail.run402.com`

#### Scenario: No domain to remove

- **WHEN** the project has no registered sender domain
- **THEN** the gateway SHALL return HTTP 404

### Requirement: Email sending with custom domain

The email sending service SHALL use the project's verified custom domain when available.

#### Scenario: Verified custom domain

- **WHEN** a project has a verified custom sender domain (e.g., `kysigned.com`)
- **AND** the mailbox slug is `notifications`
- **THEN** outbound email SHALL be sent from `notifications@kysigned.com`

#### Scenario: Unverified custom domain

- **WHEN** a project has a registered but not yet verified custom domain
- **THEN** outbound email SHALL fall back to `<slug>@mail.run402.com`

#### Scenario: No custom domain

- **WHEN** a project has no registered custom sender domain
- **THEN** outbound email SHALL be sent from `<slug>@mail.run402.com` (unchanged behavior)

### Requirement: IAM permissions

#### Scenario: SES send permissions

- **WHEN** the gateway sends email from a custom domain
- **THEN** the ECS task role SHALL have `ses:SendEmail` and `ses:SendRawEmail` permissions for all SES identities (not just `run402.com`)

#### Scenario: SES management permissions

- **WHEN** the gateway registers or removes a domain
- **THEN** the ECS task role SHALL have `ses:CreateEmailIdentity`, `ses:DeleteEmailIdentity`, and `ses:GetEmailIdentity` permissions

### Requirement: DNS record guidance

#### Scenario: Record format

- **WHEN** DNS records are returned to the caller
- **THEN** each record SHALL include `type` (CNAME, TXT), `name` (record name), and `value` (record value)
- **AND** records SHALL be formatted ready for copy-paste into a DNS provider

#### Scenario: Verification instructions

- **WHEN** a domain is registered
- **THEN** the response SHALL include a human-readable `instructions` field explaining what DNS records to add and how to check verification status
