## ADDED Requirements

### Requirement: email.send() helper in functions runtime
The `@run402/functions` module SHALL export an `email` object with a `send()` method. Functions SHALL import it as `import { db, email, getUser } from '@run402/functions'`.

#### Scenario: Send raw HTML email from a function
- **WHEN** a function calls `await email.send({ to: "alice@example.com", subject: "Welcome!", html: "<h1>Hi</h1>" })`
- **THEN** the helper SHALL POST to the gateway's mailbox messages endpoint using the project's service key, and return the message result

#### Scenario: Send template email from a function
- **WHEN** a function calls `await email.send({ to: "alice@example.com", template: "project_invite", variables: { project_name: "My App", invite_url: "https://..." } })`
- **THEN** the helper SHALL POST to the gateway's mailbox messages endpoint in template mode

#### Scenario: Send with display name from a function
- **WHEN** a function calls `await email.send({ to: "a@b.com", subject: "Hi", html: "<p>hi</p>", from_name: "My App" })`
- **THEN** the email SHALL be sent with the display name in the From header

### Requirement: Lazy mailbox discovery
The email helper SHALL discover the project's mailbox ID by calling `GET /v1/mailboxes` on the first `send()` invocation. The mailbox ID SHALL be cached for subsequent calls within the same function invocation.

#### Scenario: First send discovers mailbox
- **WHEN** a function calls `email.send()` for the first time in an invocation
- **THEN** the helper SHALL call `GET /v1/mailboxes` with the service key, extract the first mailbox ID from the response, cache it, and proceed with the send

#### Scenario: Subsequent sends use cached mailbox
- **WHEN** a function calls `email.send()` a second time in the same invocation
- **THEN** the helper SHALL reuse the cached mailbox ID without making another discovery request

#### Scenario: No mailbox configured
- **WHEN** a function calls `email.send()` but the project has no mailbox
- **THEN** the helper SHALL throw an error with message `"No mailbox configured for this project"`

### Requirement: email helper available in both Lambda and local dev
The email helper SHALL work both when deployed to Lambda (via the Lambda layer) and when running locally (via the inlined helper in `writeLocalFunction()`). Both code paths SHALL include the email helper code.

#### Scenario: Local function sends email
- **WHEN** a function using `email.send()` runs locally via the gateway's in-process executor
- **THEN** the inlined helper SHALL route the send through `localhost` gateway API

#### Scenario: Lambda function sends email
- **WHEN** a function using `email.send()` runs on Lambda
- **THEN** the Lambda layer helper SHALL route the send through the production gateway API

### Requirement: Error propagation
The email helper SHALL propagate gateway errors to the calling function. Rate limit errors (429/402), suppression errors (400), and mailbox errors (403/404) SHALL be thrown as errors with the gateway's error message.

#### Scenario: Rate limit hit from function
- **WHEN** a function calls `email.send()` and the daily limit is exceeded
- **THEN** the helper SHALL throw an error with the gateway's rate limit error message (e.g., "Daily send limit reached")

#### Scenario: Recipient suppressed
- **WHEN** a function calls `email.send()` for a suppressed recipient
- **THEN** the helper SHALL throw an error with message "Recipient address is suppressed"
