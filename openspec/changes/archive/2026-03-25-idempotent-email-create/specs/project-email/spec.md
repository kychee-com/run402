## MODIFIED Requirements

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

### Requirement: Unit test coverage for 409 recovery
The existing unit tests in `src/tools/create-mailbox.test.ts` SHALL be updated to cover the 409 recovery path: successful recovery (409 then GET returns mailbox) and failed recovery (409 then GET returns empty).

#### Scenario: 409 recovery tests pass
- **WHEN** `npm test` is executed
- **THEN** the create-mailbox 409 recovery tests pass
