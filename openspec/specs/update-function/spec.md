## ADDED Requirements

### Requirement: MCP tool to update function metadata
The MCP server SHALL expose an `update_function` tool that sends `PATCH /projects/v1/admin/:id/functions/:name` with optional `schedule`, `timeout`, and `memory` parameters. At least one parameter MUST be provided.

#### Scenario: Update schedule via MCP
- **WHEN** an LLM calls `update_function({ project_id, name, schedule: "*/15 * * * *" })`
- **THEN** the tool sends PATCH with `{ schedule: "*/15 * * * *" }` and returns the updated function state

#### Scenario: Remove schedule via MCP
- **WHEN** an LLM calls `update_function({ project_id, name, schedule: null })`
- **THEN** the tool sends PATCH with `{ schedule: null }` and the function's schedule is removed

#### Scenario: Update timeout and memory via MCP
- **WHEN** an LLM calls `update_function({ project_id, name, timeout: 15, memory: 256 })`
- **THEN** the tool sends PATCH with `{ config: { timeout: 15, memory: 256 } }` and returns the updated function state

#### Scenario: Server rejects invalid config
- **WHEN** the server returns 403 (tier limit exceeded)
- **THEN** the tool returns an error with the server's message

#### Scenario: Project not in keystore
- **WHEN** the project ID is not found in the local keystore
- **THEN** the tool returns a "project not found" error

### Requirement: CLI subcommand to update function metadata
The CLI SHALL expose `run402 functions update <id> <name>` with `--schedule`, `--schedule-remove`, `--timeout`, and `--memory` flags.

#### Scenario: Update schedule via CLI
- **WHEN** user runs `run402 functions update <id> <name> --schedule "0 */4 * * *"`
- **THEN** the CLI sends PATCH and outputs the updated function state as JSON

#### Scenario: Remove schedule via CLI
- **WHEN** user runs `run402 functions update <id> <name> --schedule ''` or `--schedule-remove`
- **THEN** the CLI sends PATCH with `{ schedule: null }`

#### Scenario: Update config via CLI
- **WHEN** user runs `run402 functions update <id> <name> --timeout 15 --memory 256`
- **THEN** the CLI sends PATCH with `{ config: { timeout: 15, memory: 256 } }`

### Requirement: SURFACE entry for update_function
The sync test SURFACE array SHALL include an entry for `update_function` mapping to `PATCH /projects/v1/admin/:id/functions/:name`.

#### Scenario: Sync test passes
- **WHEN** `npm test` runs the sync test
- **THEN** the PATCH endpoint is accounted for in SURFACE and no longer causes a test failure
