# sdk-interface-api-coverage Specification

## Purpose
TBD - created by archiving change remove-cli-mcp-api-bypasses. Update Purpose after archive.
## Requirements
### Requirement: CLI And MCP Use SDK For Run402 Gateway Calls

CLI and MCP production code SHALL NOT call Run402 gateway endpoints directly. Every Run402 API request made by CLI or MCP SHALL be performed through `@run402/sdk` or the local `getSdk()` wrapper, so request auth, x402/payment wrapping, structured errors, and endpoint typing are owned by the SDK.

#### Scenario: MCP SQL and REST tools use SDK
- **WHEN** `run_sql`, `rest_query`, `apply_expose`, or `get_expose` handles a request
- **THEN** the handler SHALL call the corresponding SDK project namespace method
- **AND** it SHALL NOT import or call the legacy MCP `apiRequest` wrapper for that gateway request

#### Scenario: CLI project direct calls use SDK
- **WHEN** `run402 projects sql`, `rest`, `apply-expose`, `get-expose`, `promote-user`, or `demote-user` runs
- **THEN** the command SHALL perform the Run402 gateway request through SDK methods
- **AND** it SHALL keep argv parsing, local file reading, and JSON output formatting in the CLI layer

#### Scenario: CLI account and status reads use SDK
- **WHEN** `run402 allowance`, `run402 billing`, `run402 init`, or `run402 status` needs Run402 faucet, billing, tier, checkout, or wallet-project data
- **THEN** it SHALL use SDK namespace methods for those Run402 gateway requests
- **AND** it SHALL NOT construct Run402 gateway URLs directly

#### Scenario: Auth provider listing uses SDK
- **WHEN** `run402 auth providers` runs
- **THEN** it SHALL call the SDK auth provider method
- **AND** missing SDK coverage SHALL be fixed in the SDK before the CLI command is wired

### Requirement: Missing Interface Behavior Becomes SDK Surface

When CLI or MCP requires Run402 API behavior that is not represented by the SDK, implementation SHALL add a typed SDK method first and then call that method from the interface layer.

#### Scenario: Resumable blob upload sessions
- **WHEN** CLI `blob put` initializes, resumes/polls, or completes a gateway upload session
- **THEN** the SDK SHALL expose typed low-level blob upload session methods for those gateway calls
- **AND** the CLI MAY still stream file chunks to the returned presigned URLs directly

#### Scenario: Billing reads support wallet and email identifiers
- **WHEN** CLI or MCP needs to read billing account balance or history for an email or wallet identifier
- **THEN** the SDK SHALL expose typed methods that accept the same identifier forms
- **AND** interface code SHALL NOT manually encode `/billing/v1/accounts/:identifier` URLs

#### Scenario: Existing SDK method is present
- **WHEN** a needed gateway operation already has an SDK method
- **THEN** the interface implementation SHALL use that existing method rather than adding another direct request helper

### Requirement: Non-Run402 Network Calls Remain Explicitly Allowed

CLI and MCP SHALL keep any direct network calls limited to targets that are not Run402 gateway endpoints, or to presigned data-plane URLs returned by the SDK. Every allowed direct network call MUST be external, data-plane, or otherwise explicitly documented by the no-bypass guard.

#### Scenario: Presigned blob part upload
- **WHEN** SDK or CLI upload code receives a presigned storage part URL
- **THEN** it MAY `PUT` bytes directly to that URL
- **AND** that direct call SHALL NOT be treated as a Run402 gateway bypass

#### Scenario: External setup and discovery calls
- **WHEN** CLI code calls Tempo JSON-RPC, viem chain RPC transports, or the GitHub API for repository metadata
- **THEN** those direct external calls MAY remain at the CLI edge
- **AND** they SHALL be excluded from the Run402 gateway no-bypass guard by a narrow allowlist or URL-pattern distinction

### Requirement: Direct Gateway Bypass Drift Guard

The test suite SHALL include a mechanical guard that fails when production CLI or MCP code introduces direct Run402 gateway requests outside an explicit allowlist.

#### Scenario: Direct fetch to API constant is introduced
- **WHEN** production CLI or MCP code adds `fetch` usage against `API`, `getApiBase()`, `RUN402_API_BASE`, or a literal Run402 gateway URL
- **THEN** the guard SHALL fail in CI with the offending file and line

#### Scenario: MCP tool imports apiRequest
- **WHEN** a production MCP tool imports or calls `apiRequest` for a Run402 gateway request
- **THEN** the guard SHALL fail in CI

#### Scenario: SDK internals are scanned separately
- **WHEN** SDK or core code uses `fetch` or `client.request`
- **THEN** this CLI/MCP guard SHALL NOT reject it
- **AND** SDK behavior SHALL continue to be covered by SDK namespace tests

### Requirement: Interface Behavior Remains Stable After SDK Refactor

Moving direct Run402 API calls behind the SDK SHALL preserve user-visible CLI and MCP behavior unless the old behavior was inconsistent with existing shared SDK error semantics.

#### Scenario: CLI output remains compatible
- **WHEN** a refactored CLI command succeeds
- **THEN** it SHALL emit the same documented JSON shape as before or an explicitly documented backward-compatible superset

#### Scenario: MCP formatting remains compatible
- **WHEN** a refactored MCP tool succeeds
- **THEN** it SHALL preserve the same Markdown or fenced JSON response contract expected by agents

#### Scenario: SDK errors map through interface formatters
- **WHEN** a refactored SDK call throws a `Run402Error`
- **THEN** CLI and MCP SHALL translate it through their shared SDK error handling paths rather than hand-rolled direct-fetch error envelopes
