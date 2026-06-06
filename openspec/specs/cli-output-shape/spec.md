# cli-output-shape Specification

## Purpose

Defines the `run402` CLI's machine-readable output contract across every subcommand — what stdout looks like on success, what stderr looks like on failure, what exit codes mean, and the per-command-class payload conventions agents can rely on. Created by archiving change `cli-drop-status-envelope` (v2.16.0).
## Requirements
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

#### Scenario: Status with no wallet reports null wallet and hint

- **WHEN** a user runs `run402 status` and no allowance file exists
- **THEN** stdout SHALL contain a JSON object with `wallet: null` and `hint: "Run: run402 init"` (or equivalent next-step guidance)
- **AND** stdout SHALL NOT contain an `allowance` block
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

### Requirement: JSON Output Is The Default; No --json Opt-In Flag

The CLI SHALL NOT gate JSON output behind a `--json` opt-in flag. Every subcommand's machine-readable output SHALL be the default behavior; no flag SHALL be required to receive parseable JSON on stdout.

Subcommands MAY accept output-modifying flags for specific shapes (`--raw` for verbatim body passthrough, `--stream` for NDJSON progress events, `--output <file>` for writing binary bytes to disk), but SHALL NOT use a `--json` flag whose effect is "switch to JSON output." The legacy `--json` flag is removed across the CLI; passing it where it once was accepted SHALL produce a structured `UNKNOWN_FLAG` error on stderr with non-zero exit, except where preserved as a deprecated alias with a stderr deprecation warning (the only case is `run402 assets put --json`, an alias for `--stream`).

#### Scenario: Doctor emits JSON by default

- **WHEN** a user runs `run402 doctor` with no flags
- **THEN** stdout SHALL be a single JSON object of shape `{ ok: boolean, checks: [{ name, status, value?, hint?, message? }] }`
- **AND** stdout SHALL NOT contain the legacy ✓/⚠/✗ checkmark text report
- **AND** exit code SHALL be 0 when `ok: true`, non-zero otherwise

#### Scenario: Cache inspect rejects legacy --json flag

- **WHEN** a user runs `run402 cache inspect https://example.com/ --json`
- **THEN** CLI SHALL exit non-zero
- **AND** stderr SHALL contain a structured error envelope with `code: "UNKNOWN_FLAG"` and `details.flag: "--json"`

#### Scenario: Logs --request-id emits JSON envelope by default

- **WHEN** a user runs `run402 logs --request-id req_abc123 --project prj_x`
- **THEN** stdout SHALL be JSON of shape `{ ok, request_id, project_id, scanned, entries, errors? }`
- **AND** stdout SHALL NOT contain `[ts] [fn] msg` text-formatted log lines
- **AND** stdout SHALL NOT contain a top-level `status` field

### Requirement: Function Invoke Result Uses http_status Not status

`run402 functions invoke` SHALL wrap the SDK invoke result on stdout in a JSON envelope where the HTTP status code is exposed as `http_status` (not `status`). This preserves the reserved top-level `status` sentinel for stderr error envelopes only.

Envelope shape: `{ http_status: number, body: unknown, duration_ms: number }`. A `--raw` flag opts back into verbatim body passthrough — string body → text + trailing newline; JSON body → pretty-printed JSON — for the rare CSV / binary-blob piping case. The default behavior SHALL be independent of the function's response content type: a function returning `Response.json(obj)` and a function returning `Response("text")` SHALL produce the same envelope shape on stdout, differing only in `body`.

#### Scenario: Function returns JSON body

- **WHEN** a user runs `run402 functions invoke prj_x hello` and the function returns `Response.json({ hello: "world" })`
- **THEN** stdout SHALL contain a JSON object with `http_status` (a number, typically 200), `body: { hello: "world" }`, and `duration_ms` (a number)
- **AND** stdout SHALL NOT contain a top-level `status` field

#### Scenario: Function returns plain-text body, --raw passthrough

- **WHEN** a user runs `run402 functions invoke prj_x csv --raw` and the function returns `Response("col1,col2\n1,2", { headers: { "Content-Type": "text/plain" } })`
- **THEN** stdout SHALL be the verbatim string `col1,col2\n1,2` followed by a trailing newline
- **AND** stdout SHALL NOT be wrapped in a JSON envelope

#### Scenario: Function returns plain-text body, no --raw

- **WHEN** a user runs `run402 functions invoke prj_x csv` (no `--raw`) and the function returns `Response("col1,col2", { headers: { "Content-Type": "text/plain" } })`
- **THEN** stdout SHALL be a JSON envelope with `http_status`, `body: "col1,col2"` (the string preserved as `body`), and `duration_ms`

### Requirement: Streaming Subcommands Emit NDJSON

CLI subcommands that stream incremental updates from a long-running operation SHALL emit one valid JSON object per line on stdout (NDJSON), with no wrapping envelope and no text-formatted lines.

Each line SHALL be independently parseable as a complete JSON object. Subcommands that BATCH results (non-streaming, single-shot) MAY use a single wrapping object on stdout instead — the NDJSON rule applies only to streaming modes that emit incremental progress.

#### Scenario: functions logs --follow emits NDJSON

- **WHEN** a user runs `run402 functions logs prj_x ssr --follow` and the server returns 3 log entries
- **THEN** stdout SHALL contain 3 separate newline-terminated lines
- **AND** each line SHALL independently parse as a JSON `FunctionLogEntry` object with at minimum `timestamp` and `message` fields
- **AND** stdout SHALL NOT contain `[timestamp] message` text-formatted lines
- **AND** stdout SHALL NOT contain a wrapping `{ logs: [...] }` envelope

#### Scenario: functions logs non-follow batches into a single object

- **WHEN** a user runs `run402 functions logs prj_x ssr --tail 50` (no `--follow`)
- **THEN** stdout SHALL contain a single JSON object `{ logs: [...] }`
- **AND** stdout SHALL NOT be NDJSON (batch mode keeps the wrapping envelope)

#### Scenario: assets put --stream emits per-file NDJSON

- **WHEN** a user runs `run402 assets put a.png b.png c.png --stream`
- **THEN** stdout SHALL contain one NDJSON line per per-file progress event (`start`, `done`)
- **AND** each line SHALL independently parse as a JSON object containing an `event` field

### Requirement: Binary Or Verbatim Output Requires Explicit Caller Flag

CLI subcommands that produce non-JSON bytes (binary, raw RFC-822 MIME, verbatim text body) SHALL NOT write those bytes to stdout by default. The caller SHALL be required to opt into raw output via an explicit flag — either by specifying an output file path (`--output <file>`) for binary content or by passing a `--raw` flag for verbatim body passthrough.

The default behavior SHALL emit a JSON envelope describing the operation (e.g. `{ message_id, bytes, output }` after writing to disk, or `{ http_status, body, duration_ms }` for a wrapped body). Stdout SHALL never produce content-dependent shapes that pipe consumers cannot predict in advance.

#### Scenario: email get-raw without --output errors before network

- **WHEN** a user runs `run402 email get-raw msg_abc` without `--output`
- **THEN** CLI SHALL exit non-zero with `code: "BAD_USAGE"` and `details.flag: "--output"`
- **AND** stdout SHALL be empty
- **AND** the CLI SHALL NOT make a network call

#### Scenario: email get-raw with --output writes to file, emits JSON on stdout

- **WHEN** a user runs `run402 email get-raw msg_abc --output /tmp/msg.eml`
- **THEN** raw RFC-822 bytes SHALL be written to `/tmp/msg.eml`
- **AND** stdout SHALL be a JSON envelope `{ message_id, bytes, output }`
- **AND** stdout SHALL NOT contain binary bytes

#### Scenario: functions invoke --raw streams string body verbatim

- **WHEN** a user runs `run402 functions invoke prj_x csv --raw` and the function returns a `text/plain` string body
- **THEN** stdout SHALL be the verbatim string followed by a trailing newline
- **AND** stdout SHALL NOT be JSON-wrapped

### Requirement: Long-Running Setup Commands Route Progress To Stderr

CLI subcommands whose primary purpose is long-running interactive setup or scaffolding — specifically `run402 init` and `run402 init astro` — SHALL emit a structured JSON summary on stdout and informational progress lines on stderr. Stdout SHALL remain JSON-parseable end-to-end so scripts piping to `jq` work without filtering; stderr SHALL carry the human-readable narration that lets a person re-running interactively see what's happening (faucet status, files being written, next-step suggestions).

This is distinct from the plain-text carve-out at Requirement "Plain-Text Output Commands Remain Plain Text" (which covers `run402 allowance export` and similar single-value commands whose natural output IS plain text). The setup commands have a structured payload AND informational narration; the narration moves to stderr so the structured payload on stdout stays clean.

The progress-on-stderr split SHALL NOT use the stderr error envelope format (no `status: "error"` sentinel) — progress lines are free-form human text, distinguishable from error envelopes by not starting with `{`.

#### Scenario: init emits JSON summary on stdout, progress on stderr

- **WHEN** a user runs `run402 init`
- **THEN** stdout SHALL be a JSON object of shape `{ config_dir, wallet, rail, network, balances, tier, projects_saved, next_step }`
- **AND** the `wallet` object SHALL carry `local_label`, `server_label`, and `address`, and SHALL NOT carry a `funded` field
- **AND** the `balances` object SHALL match the `run402 status` shape (`on_chain_usd_micros`, `on_chain_token`, `prepaid_credit_usd_micros`, `held_usd_micros`)
- **AND** stdout SHALL NOT contain an `allowance` block or a top-level `balance` field
- **AND** stderr SHALL contain human progress lines including labels such as `Config`, `Allowance`, `Balance`, `Tier`, `Next`
- **AND** stderr SHALL NOT contain a structured error envelope (no JSON object starting with `{ "status": "error"`)

#### Scenario: init astro emits JSON summary on stdout, scaffold narration on stderr

- **WHEN** a user runs `run402 init astro ./my-app`
- **THEN** stdout SHALL be a JSON object of shape `{ dir, files_created, created, next_steps }`
- **AND** stderr SHALL contain `Scaffolded Astro project at <dir>` and `Files created:` and `Next steps:` narration
- **AND** stdout SHALL NOT contain the scaffolded-file list as a text bullet list

#### Scenario: init astro scaffold template does not import retired getUser

- **WHEN** a user runs `run402 init astro ./my-app` and inspects `./my-app/src/pages/[slug].astro`
- **THEN** the scaffolded file SHALL NOT contain `getUser` (the retired bare export from `@run402/functions` v2.x that throws `R402_AUTH_UNKNOWN_EXPORT` at runtime under v3.0+)
- **AND** the scaffolded file SHALL import only the symbols it actually uses from `@run402/functions`

