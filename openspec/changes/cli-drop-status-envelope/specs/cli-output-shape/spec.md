## ADDED Requirements

### Requirement: CLI Success Stdout Has No Top-Level Status Wrapper

Every CLI subcommand SHALL emit its success-path stdout as the natural JSON payload (object, array, or string) without a top-level `status` field.

The stdout payload SHALL be the command's domain-relevant fields directly — never an envelope of the shape `{ status: "ok", ...payload }`. This applies uniformly to read commands, list commands, mutation commands, and local-state inspection commands.

A `status` field MAY appear inside a payload as a per-item label (for example, individual `checks[]` entries in `run402 doctor` output), but SHALL NOT appear at the top level of any success-path stdout emission.

#### Scenario: Read command emits raw payload

- **WHEN** a user runs `run402 projects info prj_abc`
- **THEN** stdout SHALL contain a JSON object with the project's fields directly (e.g. `project_id`, `rest_url`, `anon_key`, `service_key`, `site_url`)
- **AND** stdout SHALL NOT contain a top-level `status` field

#### Scenario: List command emits raw array

- **WHEN** a user runs `run402 projects list` and the keystore has entries
- **THEN** stdout SHALL contain a JSON array of project descriptors
- **AND** stdout SHALL NOT contain a top-level `status` field on any element or wrapper

#### Scenario: Validation command does not contradict its payload

- **WHEN** a user runs `run402 projects validate-expose` and the validator reports `hasErrors: true`
- **THEN** stdout SHALL contain a JSON object with `hasErrors`, `errors`, and `warnings` fields directly
- **AND** stdout SHALL NOT contain a top-level `status: "ok"` field that contradicts `hasErrors`

### Requirement: Mutations With No Natural Payload Echo Identifier And Explicit State

CLI mutation subcommands that previously returned `{ status: "ok", message: "..." }` SHALL instead return a JSON object containing the identifying fields of the affected resource plus one explicit boolean state field naming what happened.

The emitted object SHALL NOT be empty. The state field SHALL be a past-participle boolean such as `deleted: true`, `set: true`, `released: true`, `revoked: true`, `created: true`, or another verb that unambiguously names the mutation. The CLI SHALL NOT emit a top-level `status` or `message` field in place of the structured payload.

#### Scenario: Secret set echoes key and project

- **WHEN** a user runs `run402 secrets set prj_abc FOO bar` and the secret is written
- **THEN** stdout SHALL contain a JSON object with at least `key: "FOO"`, `project_id: "prj_abc"`, and `set: true`
- **AND** stdout SHALL NOT contain a top-level `status` field

#### Scenario: Delete echoes identifier and deleted flag

- **WHEN** a user runs `run402 functions delete prj_abc api` and the function is removed
- **THEN** stdout SHALL contain a JSON object with at least `name: "api"`, `project_id: "prj_abc"`, and `deleted: true`
- **AND** stdout SHALL NOT contain a top-level `status` field

### Requirement: Local-State Inspection Uses Typed Nullable Payload Fields

CLI subcommands that report on local configuration state (allowance, wallet, keystore) SHALL represent absent state through typed nullable payload fields, never through a top-level `status` value.

When the inspected resource is absent, the payload SHALL contain the resource's field set to `null` and a `hint` string giving the next actionable command. When the inspected resource is present, the payload SHALL contain the resource's field set to a non-null object. Exit code SHALL be 0 in both absent and present cases — absence is an informational read, not a command failure.

The `hint` field SHALL use the same name as the existing stderr error envelope's `hint` so agents see consistent guidance-field naming across success and error channels.

#### Scenario: Status with no allowance reports null allowance and hint

- **WHEN** a user runs `run402 status` and no allowance file exists
- **THEN** stdout SHALL contain a JSON object with `allowance: null` and `hint: "Run: run402 init"` (or equivalent next-step guidance)
- **AND** exit code SHALL be 0
- **AND** stdout SHALL NOT contain a top-level `status` field

#### Scenario: Allowance status with no wallet reports null wallet and hint

- **WHEN** a user runs `run402 allowance status` and no wallet has been created
- **THEN** stdout SHALL contain a JSON object with `wallet: null` and `hint: "Run: run402 allowance create"` (or equivalent next-step guidance)
- **AND** exit code SHALL be 0
- **AND** stdout SHALL NOT contain a top-level `status` field

#### Scenario: Allowance status with a wallet reports the wallet object

- **WHEN** a user runs `run402 allowance status` and a wallet exists
- **THEN** stdout SHALL contain a JSON object with `wallet: { ... }` populated by wallet fields
- **AND** stdout SHALL NOT contain a top-level `status` field

### Requirement: Plain-Text Output Commands Remain Plain Text

The small set of CLI subcommands whose natural output is a single plain-text value (for example, `run402 allowance export` returning a wallet address) SHALL continue to emit plain text without JSON wrapping.

Plain-text outputs SHALL NOT contain JSON, MAY contain a trailing newline, and MUST be distinguishable from JSON output by their absence of `{` or `[` as the first non-whitespace character. The command's help text SHALL document the plain-text format.

#### Scenario: Allowance export emits a single address line

- **WHEN** a user runs `run402 allowance export` with an existing wallet
- **THEN** stdout SHALL contain the wallet address as plain text followed by a trailing newline
- **AND** stdout SHALL NOT be JSON

### Requirement: Stderr Error Envelope Retains Status Sentinel Field

CLI command failures SHALL emit a structured JSON error envelope on stderr with non-zero exit code. The error envelope SHALL retain `status: "error"` as a sentinel field together with `code`, `message`, and the existing optional fields (`retryable`, `safe_to_retry`, `hint`, `retry_after`, `http`, `body_preview`, plus any envelope-specific structured details).

The `status` field on stderr is preserved because stderr's role as the error channel makes the sentinel unambiguous; it is the inverse of the stdout success rule rather than an exception to it. Stdout SHALL be empty (or whatever partial data was written before failure) on any non-zero-exit invocation; the canonical machine-readable failure data SHALL be on stderr only.

#### Scenario: Error envelope on stderr identifies itself

- **WHEN** any CLI subcommand fails with an SDK or API error
- **THEN** stderr SHALL contain a JSON object with at least `status: "error"`, `code`, and `message`
- **AND** the process SHALL exit with a non-zero code

#### Scenario: Stdout silent on failure

- **WHEN** any CLI subcommand fails before any partial output is written
- **THEN** stdout SHALL be empty
- **AND** the structured failure SHALL appear only on stderr

### Requirement: Exit Code Is The Authoritative Success Signal

Agents and automation consuming CLI output SHALL rely on process exit code as the authoritative success signal. Exit code 0 SHALL mean the subcommand completed; any non-zero exit code SHALL mean the subcommand failed and stderr SHALL contain the structured error envelope.

The CLI SHALL NOT use exit code to communicate sub-states of success (for example, validation finding issues SHALL NOT cause non-zero exit when the validation command itself completed). Subcommand-specific success states SHALL be communicated through payload fields.

#### Scenario: Validation finds issues but exits zero

- **WHEN** `run402 projects validate-expose` completes and the response includes `hasErrors: true`
- **THEN** exit code SHALL be 0
- **AND** stdout SHALL contain the validation result payload with `hasErrors: true`
- **AND** stderr SHALL be empty

#### Scenario: API failure exits non-zero

- **WHEN** any CLI subcommand fails at the network or API layer
- **THEN** exit code SHALL be non-zero
- **AND** stderr SHALL contain the structured error envelope

### Requirement: Output Contract Is Documented In llms-cli.txt

The canonical CLI agent reference at `cli/llms-cli.txt` SHALL include a top-level "Output Contract" section that specifies the stdout shape, the stderr shape, the exit-code rule, and the per-command-class payload conventions defined by this capability.

The section SHALL be placed before the per-command reference so agents reading the file in order encounter the contract before any per-command examples. All per-command examples in the file SHALL be consistent with the documented contract.

#### Scenario: Output Contract section exists and precedes examples

- **WHEN** an agent reads `cli/llms-cli.txt` from the top
- **THEN** the file SHALL contain an "Output Contract" section that describes stdout shape, stderr shape, exit codes, and payload conventions
- **AND** that section SHALL appear before any per-subcommand documentation

#### Scenario: Per-command examples match the contract

- **WHEN** any per-command example in `cli/llms-cli.txt` shows JSON success output
- **THEN** that example SHALL be a raw payload without a top-level `status` field

### Requirement: Drift-Protection Test Enforces Contract

The CLI test suite SHALL include a static-scan regression test that fails on any new CLI emission of `JSON.stringify({ status: <non-error-literal>, ... })` on a success path.

The test SHALL scan `cli/lib/*.mjs` for top-level `status` literal emissions on stdout-bound code paths, SHALL maintain an explicit allowlist of legitimate stderr-bound error envelope emissions (the body of `cli/lib/sdk-errors.mjs`), and SHALL fail CI on any unallowlisted match.

Per-item `status` fields inside payload objects (for example, the per-check status entries in `run402 doctor`'s `checks[]` array) SHALL NOT trigger the regression test, because those are payload contents rather than top-level envelope fields.

#### Scenario: New wrapped emission fails the test

- **WHEN** a contributor adds `console.log(JSON.stringify({ status: "ok", ...payload }))` to any `cli/lib/*.mjs` subcommand handler
- **THEN** the drift-protection test SHALL fail in CI
- **AND** the failure SHALL identify the offending file and line

#### Scenario: Stderr error envelope emissions pass the test

- **WHEN** the test scans `cli/lib/sdk-errors.mjs` and finds the existing `{ status: "error", ... }` emission
- **THEN** the test SHALL recognize it as an allowlisted stderr-bound emission
- **AND** the test SHALL pass
