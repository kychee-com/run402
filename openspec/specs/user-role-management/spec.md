### Requirement: MCP promote_user tool
The system SHALL provide a `promote_user` MCP tool that sets a user's `is_admin` flag to `true` for a given project. The tool SHALL accept `project_id` (string) and `email` (string) parameters. It SHALL use `service_key` auth from the local keystore. It SHALL call `POST /projects/v1/admin/:id/promote-user` with `{ email }` in the request body. It SHALL return a success message including the email and project_id, or an error via `formatApiError`.

#### Scenario: Successfully promote a user
- **WHEN** `promote_user` is called with a valid `project_id` and `email` of an existing user
- **THEN** the tool calls the promote-user endpoint with service_key auth and returns a success text response

#### Scenario: Project not in keystore
- **WHEN** `promote_user` is called with a `project_id` not present in the local keystore
- **THEN** the tool returns `projectNotFound` error without making an API call

#### Scenario: API returns error
- **WHEN** the promote-user endpoint returns a non-OK response (e.g. 404 user not found)
- **THEN** the tool returns the formatted error via `formatApiError`

### Requirement: MCP demote_user tool
The system SHALL provide a `demote_user` MCP tool that sets a user's `is_admin` flag to `false` for a given project. The tool SHALL accept `project_id` (string) and `email` (string) parameters. It SHALL use `service_key` auth from the local keystore. It SHALL call `POST /projects/v1/admin/:id/demote-user` with `{ email }` in the request body. It SHALL return a success message including the email and project_id, or an error via `formatApiError`.

#### Scenario: Successfully demote a user
- **WHEN** `demote_user` is called with a valid `project_id` and `email` of an existing admin user
- **THEN** the tool calls the demote-user endpoint with service_key auth and returns a success text response

#### Scenario: Project not in keystore
- **WHEN** `demote_user` is called with a `project_id` not present in the local keystore
- **THEN** the tool returns `projectNotFound` error without making an API call

#### Scenario: API returns error
- **WHEN** the demote-user endpoint returns a non-OK response
- **THEN** the tool returns the formatted error via `formatApiError`

### Requirement: CLI promote-user subcommand
The system SHALL provide a `run402 projects promote-user <id> <email>` CLI subcommand. It SHALL look up the project via `findProject`, call the same API endpoint as the MCP tool, and output JSON to stdout. On error, it SHALL print JSON to stderr and exit with code 1.

#### Scenario: CLI promote-user success
- **WHEN** `run402 projects promote-user <id> <email>` is run with a valid project and email
- **THEN** the command outputs the API response as JSON to stdout

#### Scenario: CLI promote-user project not found
- **WHEN** the project_id is not in the local keystore
- **THEN** the command prints an error and exits with code 1

### Requirement: CLI demote-user subcommand
The system SHALL provide a `run402 projects demote-user <id> <email>` CLI subcommand. It SHALL look up the project via `findProject`, call the same API endpoint as the MCP tool, and output JSON to stdout. On error, it SHALL print JSON to stderr and exit with code 1.

#### Scenario: CLI demote-user success
- **WHEN** `run402 projects demote-user <id> <email>` is run with a valid project and email
- **THEN** the command outputs the API response as JSON to stdout

#### Scenario: CLI demote-user project not found
- **WHEN** the project_id is not in the local keystore
- **THEN** the command prints an error and exits with code 1

### Requirement: OpenClaw commands via re-export
The OpenClaw `projects.mjs` SHALL continue to re-export the CLI `projects.mjs` run function, which means the new `promote-user` and `demote-user` subcommands are automatically available with no additional OpenClaw changes.

#### Scenario: OpenClaw promote-user available
- **WHEN** OpenClaw dispatches `projects promote-user <id> <email>`
- **THEN** the CLI's promote-user handler is invoked via the re-export

### Requirement: sync.test.ts surface entries
The `SURFACE` array in `sync.test.ts` SHALL include entries for `promote_user` and `demote_user` with their correct MCP tool names, CLI commands (`projects:promote-user`, `projects:demote-user`), OpenClaw commands, and API endpoints. The two endpoints SHALL be removed from `IGNORED_ENDPOINTS`.

#### Scenario: Sync test passes with new tools
- **WHEN** `npm run test:sync` is executed
- **THEN** the test passes with the new promote_user and demote_user entries in SURFACE and removed from IGNORED_ENDPOINTS

### Requirement: MCP tool registration
Both `promote_user` and `demote_user` tools SHALL be registered in `src/index.ts` following the existing pattern (import schema + handler, register with `server.tool()`).

#### Scenario: Tools appear in MCP tool list
- **WHEN** the MCP server starts
- **THEN** both `promote_user` and `demote_user` appear in the tool list with their Zod schemas
