## MODIFIED Requirements

### Requirement: Deploy Apply Has Final-Only Output Mode

`run402 deploy apply` SHALL expose `--final-only` as an explicit result-parsing mode for agents and CI.

When `--final-only` is set, the CLI SHALL suppress the stderr deploy event stream and SHALL still emit the final JSON result payload to stdout. The stdout result payload SHALL conform to the CLI output contract defined by the `cli-output-shape` capability — that is, a raw payload with no top-level `status: "ok"` wrapper on success. `--quiet` SHALL remain supported and documented as an alias for suppressing the event stream while preserving the final stdout result.

On failure, the structured error envelope SHALL appear on stderr (with `status: "error"`) and exit code SHALL be non-zero, as specified by the `cli-output-shape` capability's stderr requirement.

#### Scenario: Final-only emits only the result payload

- **WHEN** a user runs `run402 deploy apply --manifest deploy.json --final-only` and the deploy succeeds
- **THEN** stderr SHALL contain no per-event JSON-line stream
- **AND** stdout SHALL contain the final deploy result payload as a raw JSON object (fields such as `release_id`, `operation_id`, `warnings`, `apply` summary)
- **AND** stdout SHALL NOT contain a top-level `status` field

#### Scenario: Quiet remains equivalent

- **WHEN** a user runs the same successful deploy with `--quiet` and with `--final-only`
- **THEN** the stdout result payloads SHALL be equivalent
- **AND** both invocations SHALL suppress deploy progress events on stderr
- **AND** neither stdout payload SHALL contain a top-level `status` field

#### Scenario: Final-only deploy failure surfaces on stderr

- **WHEN** a user runs `run402 deploy apply --manifest deploy.json --final-only` and the deploy fails at any stage
- **THEN** stderr SHALL contain the structured error envelope with `status: "error"`, `code`, and `message`
- **AND** exit code SHALL be non-zero
- **AND** stdout SHALL be empty (or contain only data written before the failure point)
