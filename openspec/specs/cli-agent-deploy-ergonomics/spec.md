# cli-agent-deploy-ergonomics Specification

## Purpose
TBD - created by archiving change reduce-agent-deploy-friction. Update Purpose after archive.
## Requirements
### Requirement: Deploy Apply Has Final-Only Output Mode

`run402 deploy apply` SHALL expose `--final-only` as an explicit result-parsing mode for agents and CI.

When `--final-only` is set, the CLI SHALL suppress the stderr deploy event stream and SHALL still emit the final JSON result envelope to stdout. The output contract SHALL match existing `--quiet` behavior. `--quiet` SHALL remain supported and documented as an alias for suppressing the event stream while preserving the final stdout result.

#### Scenario: Final-only emits only result envelope

- **WHEN** a user runs `run402 deploy apply --manifest deploy.json --final-only`
- **THEN** stderr SHALL contain no per-event JSON-line stream
- **AND** stdout SHALL contain the final `{ "status": "ok", ... }` or structured error behavior already used by deploy apply

#### Scenario: Quiet remains equivalent

- **WHEN** a user runs the same successful deploy with `--quiet` and with `--final-only`
- **THEN** the stdout result envelopes SHALL be equivalent
- **AND** both invocations SHALL suppress deploy progress events on stderr

### Requirement: Deploy Apply Supports Warning-Code Acknowledgement

`run402 deploy apply` SHALL support a repeatable `--allow-warning <code>` flag.

When one or more confirmation-required plan warnings are present, the CLI SHALL continue only if every blocking warning is covered by `--allow-warnings` or by a code supplied through `--allow-warning`. If any blocking warning is not covered, the CLI SHALL fail before upload or commit and SHALL include the unacknowledged warning codes and affected resources in its structured error output.

The broad `--allow-warnings` flag SHALL remain available for compatibility but docs SHALL recommend `--allow-warning <code>` when acknowledging a known warning class.

#### Scenario: Specific warning code is allowed

- **WHEN** a deploy plan returns only `WILDCARD_ROUTE_EXCLUDES_MUTATION_METHODS` as a confirmation-required warning
- **AND** the user runs `run402 deploy apply --allow-warning WILDCARD_ROUTE_EXCLUDES_MUTATION_METHODS`
- **THEN** the CLI SHALL proceed past warning confirmation
- **AND** the final result SHALL preserve the warning in the result warnings array

#### Scenario: Different warning remains blocked

- **WHEN** a deploy plan returns `WILDCARD_ROUTE_EXCLUDES_MUTATION_METHODS` and `MISSING_REQUIRED_SECRET`
- **AND** the user supplies only `--allow-warning WILDCARD_ROUTE_EXCLUDES_MUTATION_METHODS`
- **THEN** the CLI SHALL stop before upload or commit
- **AND** the structured error SHALL identify `MISSING_REQUIRED_SECRET` as unacknowledged

### Requirement: Deploy Apply Preflights Tier Function Limits Before Side Effects

`run402 deploy apply` SHALL validate manifest function resource values against known tier limits before CAS upload, migration execution, function build, commit, or activation.

The preflight SHALL cover literal `functions.replace` and `functions.patch.set` values for `config.timeoutSeconds`, `config.memoryMb`, scheduled-function cron minimum interval, and scheduled-function count when the count can be determined from the manifest or read-only release inventory. Failures SHALL be structured local errors with `code: "BAD_FIELD"` and details containing the field path, value, tier, and relevant limit.

Gateway validation SHALL remain authoritative for limits that cannot be known locally or that change after preflight.

#### Scenario: Timeout cap fails before deploy work

- **WHEN** prototype tier allows at most 10 seconds and the manifest contains `functions.replace.api.config.timeoutSeconds: 20`
- **THEN** `run402 deploy apply` SHALL fail before content upload, migration, build, commit, or activation
- **AND** stderr SHALL include a structured error with `code: "BAD_FIELD"`, `details.field: "functions.api.config.timeoutSeconds"`, `details.value: 20`, and `details.tier_max: 10`

#### Scenario: Valid values still deploy

- **WHEN** the manifest function timeout, memory, schedule interval, and scheduled count fit the active tier limits
- **THEN** tier preflight SHALL allow deploy apply to proceed to normal SDK deploy planning

### Requirement: Tier Status Reports Function Limits

`run402 tier status` SHALL include function authoring limits in its JSON output and human-readable help/docs.

At minimum, the status output SHALL expose max function timeout, max function memory, max scheduled functions, minimum cron interval, and current scheduled-function usage when the gateway provides it. The CLI SHALL preserve unknown additional limit fields without crashing.

#### Scenario: Tier status shows deploy-relevant caps

- **WHEN** a user runs `run402 tier status`
- **THEN** the output SHALL include the active tier's function timeout and memory caps
- **AND** it SHALL include scheduled-function limit information when available

### Requirement: Secrets Set Accepts Stdin In Agent-Friendly Form

`run402 secrets set` SHALL document and support an stdin-safe value path suitable for pipes.

The CLI SHALL accept `--stdin`, and MAY accept `--file -` or `/dev/stdin` as aliases, while preserving mutual exclusivity with inline values and ordinary `--file` paths.

#### Scenario: Pipe secret through stdin

- **WHEN** a user runs `printf %s "$VALUE" | run402 secrets set prj_123 SITE_URL --stdin`
- **THEN** the CLI SHALL read the complete stdin stream as the secret value
- **AND** it SHALL set the secret without requiring a temporary file

