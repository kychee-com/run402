## ADDED Requirements

### Requirement: Create mailbox
The system SHALL provide a `create_mailbox` MCP tool and `run402 email create` CLI command that creates a project-scoped mailbox via `POST /mailboxes/v1`. The tool SHALL accept `project_id` and `slug` parameters, validate the slug client-side, send the request with `service_key` auth, and store `mailbox_id` and `mailbox_address` in the project's keystore entry on success. On a 409 conflict response, the tool SHALL automatically discover the existing mailbox via `GET /mailboxes/v1` and return it as a success with an indication that the mailbox already existed.

#### Scenario: Successful mailbox creation
- **WHEN** user calls `create_mailbox` with a valid `project_id` and `slug` (e.g., "my-app")
- **THEN** the system creates the mailbox, stores `mailbox_id` and `mailbox_address` in the keystore, and returns the mailbox address (e.g., "my-app@mail.run402.com")

#### Scenario: Invalid slug format
- **WHEN** user calls `create_mailbox` with a slug that violates format rules (too short, uppercase, consecutive hyphens, etc.)
- **THEN** the system returns an error describing the slug requirements without making an API call

#### Scenario: Project not in keystore
- **WHEN** user calls `create_mailbox` with a `project_id` not found in the local keystore
- **THEN** the system returns the standard `projectNotFound` error

#### Scenario: 409 conflict — mailbox already exists
- **WHEN** the API returns HTTP 409 indicating the project already has a mailbox
- **THEN** the system discovers the existing mailbox via `GET /mailboxes/v1`, stores `mailbox_id` and `mailbox_address` in the keystore, and returns the mailbox info as a success with a note that the mailbox already existed

#### Scenario: 409 conflict — discovery fails
- **WHEN** the API returns HTTP 409 and the subsequent `GET /mailboxes/v1` call fails or returns no mailboxes
- **THEN** the system returns a formatted error via `formatApiError` for the original 409 response

#### Scenario: API returns other error (e.g., 401, 500)
- **WHEN** the API returns a non-OK, non-409 response
- **THEN** the system returns a formatted error via `formatApiError`

#### Scenario: CLI output on 409 recovery
- **WHEN** user runs `run402 email create <slug>` and the project already has a mailbox
- **THEN** the CLI outputs JSON: `{ "status": "ok", "mailbox_id": "mbx_...", "address": "...@mail.run402.com", "already_existed": true }`

### Requirement: Send email
The system SHALL provide a `send_email` MCP tool and `run402 email send` CLI command that sends a template-based email via `POST /mailboxes/v1/:id/messages`. The tool SHALL accept `project_id`, `template`, `to`, and `variables` parameters. It SHALL look up the `mailbox_id` from the keystore and use `service_key` auth.

#### Scenario: Successful email send
- **WHEN** user calls `send_email` with valid `project_id`, `template` ("project_invite"), `to` ("user@example.com"), and `variables` ({"project_name": "My App", "invite_url": "https://..."})
- **THEN** the system sends the email and returns confirmation with the message ID

#### Scenario: No mailbox in keystore
- **WHEN** user calls `send_email` for a project that has no `mailbox_id` in the keystore
- **THEN** the system returns an error suggesting the user run `create_mailbox` first

#### Scenario: Invalid template
- **WHEN** user calls `send_email` with a template not in the allowed set (project_invite, magic_link, notification)
- **THEN** the system returns a validation error listing available templates

#### Scenario: CLI var parsing
- **WHEN** user runs `run402 email send --template project_invite --to user@example.com --var project_name="My App" --var invite_url="https://..."`
- **THEN** the CLI parses `--var` flags into a `variables` object and sends the request

### Requirement: List emails
The system SHALL provide a `list_emails` MCP tool and `run402 email list` CLI command that lists sent messages via `GET /mailboxes/v1/:id/messages`. The tool SHALL accept `project_id` and optional pagination parameters, look up `mailbox_id` from the keystore, and use `service_key` auth.

#### Scenario: Successful list with messages
- **WHEN** user calls `list_emails` with a valid `project_id` that has sent messages
- **THEN** the system returns a formatted list/table of messages with ID, template, recipient, status, and timestamp

#### Scenario: No messages sent
- **WHEN** user calls `list_emails` for a mailbox with no sent messages
- **THEN** the system returns a message indicating no emails have been sent

#### Scenario: No mailbox in keystore
- **WHEN** user calls `list_emails` for a project with no `mailbox_id` in the keystore
- **THEN** the system returns an error suggesting the user run `create_mailbox` first

### Requirement: Get email
The system SHALL provide a `get_email` MCP tool and `run402 email get` CLI command that retrieves a message with replies via `GET /mailboxes/v1/:id/messages/:messageId`. The tool SHALL accept `project_id` and `message_id`, look up `mailbox_id` from the keystore, and use `service_key` auth.

#### Scenario: Successful get
- **WHEN** user calls `get_email` with a valid `project_id` and `message_id`
- **THEN** the system returns the message details including template, recipient, status, timestamps, and any replies

#### Scenario: Message not found
- **WHEN** user calls `get_email` with a `message_id` that doesn't exist
- **THEN** the system returns a formatted 404 error via `formatApiError`

#### Scenario: No mailbox in keystore
- **WHEN** user calls `get_email` for a project with no `mailbox_id` in the keystore
- **THEN** the system returns an error suggesting the user run `create_mailbox` first

### Requirement: Slug validation
The system SHALL validate mailbox slugs client-side before sending API requests. Valid slugs MUST be 3-63 characters, contain only lowercase alphanumeric characters and hyphens, start and end with an alphanumeric character, and contain no consecutive hyphens.

#### Scenario: Valid slug accepted
- **WHEN** user provides slug "my-cool-app"
- **THEN** validation passes and the request proceeds

#### Scenario: Slug too short
- **WHEN** user provides slug "ab"
- **THEN** validation fails with message about minimum 3 characters

#### Scenario: Slug with consecutive hyphens
- **WHEN** user provides slug "my--app"
- **THEN** validation fails with message about no consecutive hyphens

#### Scenario: Slug with uppercase
- **WHEN** user provides slug "MyApp"
- **THEN** validation fails with message about lowercase only

### Requirement: Mailbox ID auto-lookup
The system SHALL automatically look up the `mailbox_id` from the project's keystore entry for `send_email`, `list_emails`, and `get_email` tools. If the mailbox ID is not found in the keystore, the system SHALL attempt to discover it via `GET /mailboxes/v1` before failing.

#### Scenario: Mailbox ID found in keystore
- **WHEN** user calls `send_email` and the project's keystore entry contains `mailbox_id`
- **THEN** the system uses the stored mailbox ID without an extra API call

#### Scenario: Mailbox ID not in keystore but exists on server
- **WHEN** user calls `send_email` and the project's keystore entry has no `mailbox_id`, but the project has a mailbox on the server
- **THEN** the system discovers the mailbox via `GET /mailboxes/v1`, stores it in the keystore, and proceeds

#### Scenario: No mailbox exists
- **WHEN** user calls `send_email` and no mailbox exists in keystore or on server
- **THEN** the system returns an error suggesting the user run `create_mailbox` first

### Requirement: CLI help documentation
The CLI `email` module SHALL include a HELP string matching the existing module style (title line, usage, subcommands table, examples, notes) and SHALL display it when invoked with no subcommand, `--help`, or `-h`.

#### Scenario: Help displayed on bare command
- **WHEN** user runs `run402 email`
- **THEN** the system prints the full help text and exits with code 0

#### Scenario: Help displayed with --help flag
- **WHEN** user runs `run402 email --help`
- **THEN** the system prints the full help text and exits with code 0

### Requirement: llms-cli.txt documentation
The `~/dev/run402/site/llms-cli.txt` file SHALL include an `### email` section in the Command Reference area documenting all email subcommands with their arguments, matching the existing format.

#### Scenario: Email commands documented in llms-cli.txt
- **WHEN** the llms-cli.txt file is read
- **THEN** it contains an `### email` section listing `create`, `send`, `list`, and `get` subcommands with argument syntax and a brief intro line about templates and rate limits

### Requirement: Sync test coverage
The system SHALL include all email tools/commands in the `SURFACE` array in `sync.test.ts` to enforce parity across MCP, CLI, and OpenClaw interfaces.

#### Scenario: All email capabilities in SURFACE
- **WHEN** `npm run test:sync` is executed
- **THEN** the test validates that `create_mailbox`, `send_email`, `list_emails`, and `get_email` are registered in MCP, CLI (`email:create`, `email:send`, `email:list`, `email:get`), and OpenClaw

### Requirement: Unit test coverage
The system SHALL include unit tests for all 4 MCP email tools following the existing mock-fetch test pattern with temp keystore isolation.

#### Scenario: Tests pass
- **WHEN** `npm test` is executed
- **THEN** all email tool unit tests pass with mocked fetch responses

### Requirement: Unit test coverage for 409 recovery
The existing unit tests in `src/tools/create-mailbox.test.ts` SHALL be updated to cover the 409 recovery path: successful recovery (409 then GET returns mailbox) and failed recovery (409 then GET returns empty).

#### Scenario: 409 recovery tests pass
- **WHEN** `npm test` is executed
- **THEN** the create-mailbox 409 recovery tests pass
