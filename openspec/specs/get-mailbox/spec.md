### Requirement: Get mailbox info
The system SHALL provide a `get_mailbox` MCP tool and `run402 email status` CLI command that retrieves a project's mailbox information via `GET /mailboxes/v1`. The tool SHALL accept a `project_id` parameter, look up the project in the keystore, call the API with `service_key` auth, and return the mailbox ID, address, and slug. The result SHALL be cached in the keystore for future commands.

#### Scenario: Successful mailbox retrieval
- **WHEN** user calls `get_mailbox` with a valid `project_id` that has a mailbox
- **THEN** the system returns the mailbox ID, address, and slug, and caches `mailbox_id` and `mailbox_address` in the keystore

#### Scenario: No mailbox exists
- **WHEN** user calls `get_mailbox` with a valid `project_id` that has no mailbox
- **THEN** the system returns an error: "No mailbox found for this project. Use `create_mailbox` to create one first."

#### Scenario: Project not in keystore
- **WHEN** user calls `get_mailbox` with a `project_id` not found in the local keystore
- **THEN** the system returns the standard `projectNotFound` error

#### Scenario: API returns error
- **WHEN** the API returns a non-OK response (e.g., 401, 500)
- **THEN** the system returns a formatted error via `formatApiError`

#### Scenario: CLI output format
- **WHEN** user runs `run402 email status`
- **THEN** the CLI outputs JSON: `{ "status": "ok", "mailbox_id": "mbx_...", "address": "slug@mail.run402.com", "slug": "slug" }`

#### Scenario: CLI help includes status subcommand
- **WHEN** user runs `run402 email --help`
- **THEN** the help text includes the `status` subcommand in the subcommands table

### Requirement: Sync test coverage for get_mailbox
The `SURFACE` array in `sync.test.ts` SHALL include `get_mailbox` with MCP tool name `get_mailbox`, CLI command `email:status`, and OpenClaw command `email:status`.

#### Scenario: Sync test validates get_mailbox
- **WHEN** `npm run test:sync` is executed
- **THEN** the test validates that `get_mailbox` is registered in MCP, CLI (`email:status`), and OpenClaw (`email:status`)

### Requirement: Unit test coverage for get_mailbox
The system SHALL include unit tests for the `get_mailbox` MCP tool in `src/tools/get-mailbox.test.ts` following the existing mock-fetch test pattern with temp keystore isolation. Tests SHALL cover: successful retrieval, no mailbox found, project not in keystore, and API error scenarios.

#### Scenario: All get_mailbox tests pass
- **WHEN** `npm test` is executed
- **THEN** all `get-mailbox.test.ts` tests pass

### Requirement: Documentation for email status
The llms-cli.txt documentation SHALL include the `status` subcommand in the `### email` section. The SKILL.md tool list SHALL include `get_mailbox` if email tools are listed there.

#### Scenario: llms-cli.txt documents email status
- **WHEN** the llms-cli.txt file is read
- **THEN** it contains `status` in the email subcommands listing
