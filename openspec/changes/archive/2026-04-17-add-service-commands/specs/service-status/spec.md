## ADDED Requirements

### Requirement: CLI exposes `service` command with `status` and `health` subcommands

The CLI SHALL provide a top-level `service` command with exactly two subcommands: `status` and `health`. The command SHALL be registered in `cli/cli.mjs` and listed in the main help text. The implementation module SHALL live at `cli/lib/service.mjs` and export an async `run(sub, args)` function.

#### Scenario: User runs `run402 service status`
- **WHEN** a user runs `run402 service status` with no other arguments
- **THEN** the CLI performs a `GET` request to `${RUN402_API_BASE}/status` without any authentication headers
- **AND** writes the parsed JSON response body to stdout
- **AND** exits with code 0

#### Scenario: User runs `run402 service health`
- **WHEN** a user runs `run402 service health` with no other arguments
- **THEN** the CLI performs a `GET` request to `${RUN402_API_BASE}/health` without any authentication headers
- **AND** writes the parsed JSON response body to stdout
- **AND** exits with code 0

#### Scenario: User runs `run402 service` with no subcommand
- **WHEN** a user runs `run402 service` with no subcommand
- **THEN** the CLI prints usage help listing `status` and `health` subcommands
- **AND** exits with code 0

#### Scenario: User runs `run402 service` with an unknown subcommand
- **WHEN** a user runs `run402 service foo`
- **THEN** the CLI prints an error indicating the subcommand is unknown
- **AND** prints usage help
- **AND** exits with a non-zero code

#### Scenario: Upstream endpoint returns a non-2xx response
- **WHEN** the CLI calls `/status` or `/health` and the response status is not in the 2xx range
- **THEN** the CLI writes a JSON error object to stdout containing at least the HTTP status code and the response body text
- **AND** exits with code 0

#### Scenario: Upstream request throws a network error
- **WHEN** the underlying `fetch` call rejects with an error
- **THEN** the CLI writes a JSON error object to stdout containing the error message
- **AND** exits with code 0

### Requirement: MCP server exposes `service_status` and `service_health` tools

The MCP server SHALL register two tools — `service_status` and `service_health` — in `src/index.ts`. Each tool SHALL accept no parameters (empty Zod schema object). Each tool's description SHALL explicitly distinguish it from the account-level `status` tool in its first sentence.

#### Scenario: Agent invokes `service_status`
- **WHEN** an MCP client invokes the `service_status` tool
- **THEN** the server performs a `GET` request to `${RUN402_API_BASE}/status` without any authentication headers
- **AND** returns a result with `content: [{ type: "text", text: <markdown summary> }]` where the markdown summary includes the current status, 30-day uptime percentage, operator legal name, and a link to the full status page
- **AND** does not set `isError`

#### Scenario: Agent invokes `service_health`
- **WHEN** an MCP client invokes the `service_health` tool
- **THEN** the server performs a `GET` request to `${RUN402_API_BASE}/health` without any authentication headers
- **AND** returns a result with `content: [{ type: "text", text: <markdown summary> }]` where the markdown summary includes the overall `status` field and the per-dependency check results
- **AND** does not set `isError`

#### Scenario: Tool is invoked without an allowance configured
- **WHEN** `service_status` or `service_health` is invoked and no allowance file exists on disk
- **THEN** the tool still performs the request and returns a valid result
- **AND** does not prompt the user to run `init` or `allowance_create`

#### Scenario: Upstream endpoint returns a non-2xx response
- **WHEN** the MCP tool calls `/status` or `/health` and the response status is not in the 2xx range
- **THEN** the tool returns a result with `isError: true` and a `content[0].text` message including the HTTP status code

#### Scenario: Upstream request throws a network error
- **WHEN** the underlying `apiRequest` call rejects with an error
- **THEN** the tool returns a result with `isError: true` and a `content[0].text` message including the error text

### Requirement: OpenClaw skill exposes `service` command as a shim

The OpenClaw skill SHALL provide `openclaw/scripts/service.mjs` as a thin re-export of the CLI module. The file contents SHALL consist of a single `export { run } from "../../cli/lib/service.mjs";` line (plus optional leading comments). This matches the existing shim pattern for every other OpenClaw command.

#### Scenario: Sync test verifies OpenClaw-CLI parity
- **WHEN** `npm run test:sync` runs
- **THEN** the test detects both `cli/lib/service.mjs` and `openclaw/scripts/service.mjs`
- **AND** confirms CLI and OpenClaw command sets remain identical

### Requirement: Sync test surface includes both endpoints

The `SURFACE` array in `sync.test.ts` SHALL include two new entries mapping `GET /health` and `GET /status` to their CLI command (`service:health`, `service:status`), MCP tool (`service_health`, `service_status`), and OpenClaw command (`service:health`, `service:status`). The existing bare `"GET /health"` entry in the endpoint-only section SHALL be replaced by the new structured entry.

#### Scenario: Sync test enforces MCP registration
- **WHEN** `npm run test:sync` runs
- **THEN** the test asserts `service_status` and `service_health` are registered in `src/index.ts`
- **AND** fails if either is missing

#### Scenario: llms.txt coverage check
- **WHEN** `npm run test:sync` runs and `~/Developer/run402-private/site/llms.txt` exists
- **THEN** the test asserts both `service_status` and `service_health` are listed in the MCP Tools table
- **AND** asserts both `GET /health` and `GET /status` are documented as endpoints

### Requirement: Tools require no authentication, allowance, or keystore

The `service` CLI subcommands and `service_*` MCP tools SHALL NOT call `readAllowance()`, `getAllowanceAuthHeaders()`, `requireAllowanceAuth()`, or `loadKeyStore()`. They SHALL succeed on a fresh install before `init` has been run.

#### Scenario: Fresh install invocation
- **WHEN** `service_status` or `service_health` is invoked on a system with no `~/.config/run402/` directory
- **THEN** the tool succeeds and returns the expected result
- **AND** does not create any files on disk
