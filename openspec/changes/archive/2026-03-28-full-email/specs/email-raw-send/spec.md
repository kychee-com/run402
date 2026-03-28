## ADDED Requirements

### Requirement: Send raw HTML email
The system SHALL allow sending emails with arbitrary HTML content via `POST /v1/mailboxes/:id/messages` when the request includes `subject` and `html` fields (without a `template` field). The same rate limiting, suppression, and recipient tracking SHALL apply as template mode.

#### Scenario: Send raw HTML email
- **WHEN** an agent calls `POST /v1/mailboxes/:id/messages` with `{"to": "alice@example.com", "subject": "Welcome!", "html": "<h1>Welcome to our community</h1><p>We're glad you're here.</p>"}`
- **THEN** the system SHALL send the email via SES with the provided subject and HTML body, append the Run402 transparency footer, auto-generate a plaintext fallback, store a message record with `template: null`, and return 201 with `{"message_id", "to", "subject", "status": "sent", "sent_at"}`

#### Scenario: Raw mode with explicit plaintext
- **WHEN** an agent calls `POST /v1/mailboxes/:id/messages` with `{"to": "alice@example.com", "subject": "Welcome!", "html": "<h1>Welcome</h1>", "text": "Welcome to our community"}`
- **THEN** the system SHALL use the provided `text` as the plaintext body instead of auto-generating it from HTML

#### Scenario: Raw mode with display name
- **WHEN** an agent calls `POST /v1/mailboxes/:id/messages` with `{"to": "alice@example.com", "subject": "Welcome!", "html": "<h1>Hi</h1>", "from_name": "Riverside Club"}`
- **THEN** the system SHALL send from `"Riverside Club" <slug@mail.run402.com>`

### Requirement: Raw mode field validation
The system SHALL validate raw mode fields: `subject` SHALL be a non-empty string (max 998 chars per RFC 5322). `html` SHALL be a non-empty string (max 1,048,576 bytes). `text` is optional. `from_name` is optional (max 78 chars, no `<`, `>`, `"`, or newline characters).

#### Scenario: HTML body too large
- **WHEN** an agent sends a raw email with an `html` field exceeding 1,048,576 bytes
- **THEN** the system SHALL return 400 with `{"error": "HTML body exceeds 1MB limit"}`

#### Scenario: Missing subject in raw mode
- **WHEN** an agent sends `{"to": "alice@example.com", "html": "<p>hello</p>"}` without a `subject` field
- **THEN** the system SHALL return 400 with `{"error": "Subject is required for raw email"}`

#### Scenario: Invalid from_name
- **WHEN** an agent sends a raw email with `"from_name": "Evil <script>"`
- **THEN** the system SHALL return 400 with `{"error": "Display name contains invalid characters"}`

#### Scenario: Empty html field
- **WHEN** an agent sends `{"to": "alice@example.com", "subject": "Hi", "html": ""}`
- **THEN** the system SHALL return 400 with `{"error": "HTML body is required for raw email"}`

### Requirement: Auto-generate plaintext fallback
When `text` is omitted in raw mode, the system SHALL auto-generate a plaintext body by stripping HTML tags from the `html` field. The stripping SHALL remove `<style>` and `<script>` blocks, convert `<br>` to newlines, convert `</p>` and `</div>` to newlines, decode common HTML entities, and collapse excessive blank lines.

#### Scenario: Auto-generated plaintext
- **WHEN** an agent sends `{"to": "a@b.com", "subject": "Hi", "html": "<h1>Hello</h1><p>World</p>"}` without a `text` field
- **THEN** the email's plaintext body SHALL contain "Hello" and "World" with the HTML tags stripped

### Requirement: Transparency footer in raw mode
The system SHALL append the Run402 transparency footer to both the HTML and plaintext bodies of raw-mode emails, using the same footer text and HTML as template-mode emails.

#### Scenario: Footer appended to raw HTML
- **WHEN** an agent sends a raw HTML email
- **THEN** the HTML body SHALL end with a footer containing "Sent by an AI agent via run402.com" with a link to https://run402.com

### Requirement: Display name support on all send modes
The optional `from_name` field SHALL be supported in both raw mode and template mode. When provided, the From header SHALL render as `"Display Name" <slug@mail.run402.com>`.

#### Scenario: Display name in template mode
- **WHEN** an agent sends `{"template": "project_invite", "to": "a@b.com", "variables": {...}, "from_name": "My App"}`
- **THEN** the email SHALL be sent from `"My App" <slug@mail.run402.com>`

#### Scenario: No display name (default)
- **WHEN** an agent sends a message without `from_name`
- **THEN** the email SHALL be sent from `slug@mail.run402.com` (bare address, unchanged from current behavior)

### Requirement: Mode detection
The system SHALL detect the send mode based on fields present in the request body. If `template` is present, template mode is used. If `subject` and `html` are present (without `template`), raw mode is used. If neither mode's required fields are present, the system SHALL return 400.

#### Scenario: Ambiguous request with both template and html
- **WHEN** an agent sends `{"template": "notification", "html": "<p>hi</p>", "subject": "Hi", "to": "a@b.com", "variables": {"project_name": "X", "message": "hi"}}`
- **THEN** the system SHALL use template mode (template field takes precedence)

#### Scenario: Neither mode satisfied
- **WHEN** an agent sends `{"to": "a@b.com", "html": "<p>hi</p>"}` (has html but no subject, and no template)
- **THEN** the system SHALL return 400 with `{"error": "Subject is required for raw email"}`
