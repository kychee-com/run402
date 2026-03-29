## ADDED Requirements

### Requirement: PATCH endpoint updates function metadata
`PATCH /projects/v1/admin/:id/functions/:name` SHALL accept a JSON body with optional `schedule`, `config.timeout`, and `config.memory` fields. Only provided fields SHALL be updated. The endpoint SHALL require service_key authentication.

#### Scenario: Update schedule only
- **WHEN** a PATCH request includes `{ "schedule": "0 */4 * * *" }`
- **THEN** the function's schedule SHALL be updated in the DB and the cron timer SHALL be registered, without re-deploying code

#### Scenario: Remove schedule
- **WHEN** a PATCH request includes `{ "schedule": null }`
- **THEN** the function's schedule SHALL be removed and the cron timer SHALL be cancelled

#### Scenario: Update timeout and memory
- **WHEN** a PATCH request includes `{ "config": { "timeout": 30, "memory": 256 } }`
- **THEN** the function's timeout and memory SHALL be updated in the DB AND the Lambda configuration SHALL be updated via UpdateFunctionConfigurationCommand

#### Scenario: Update schedule and config together
- **WHEN** a PATCH request includes both `schedule` and `config` fields
- **THEN** both SHALL be applied in a single request

#### Scenario: Empty body is a no-op
- **WHEN** a PATCH request includes `{}` or no recognized fields
- **THEN** the endpoint SHALL return 200 with the current function state (no changes made)

#### Scenario: Function not found
- **WHEN** a PATCH request targets a function name that does not exist
- **THEN** the endpoint SHALL return 404

### Requirement: PATCH enforces tier limits for schedule changes
Schedule updates via PATCH SHALL enforce the same tier limits as POST deploy: maximum scheduled function count and minimum schedule interval.

#### Scenario: Schedule exceeds tier limit via PATCH
- **WHEN** a PATCH request sets a schedule on a function and the project has reached its tier's scheduled function limit
- **THEN** the endpoint SHALL return 403 with the tier limit message

#### Scenario: Schedule interval too frequent via PATCH
- **WHEN** a PATCH request sets a schedule with an interval below the tier's minimum
- **THEN** the endpoint SHALL return 403 with the interval limit message

### Requirement: PATCH enforces tier limits for config changes
Config updates (timeout, memory) via PATCH SHALL enforce the same tier limits as POST deploy.

#### Scenario: Timeout exceeds tier limit via PATCH
- **WHEN** a PATCH request sets `config.timeout` above the tier's `functionTimeoutSec`
- **THEN** the endpoint SHALL return 403 with a message indicating the tier limit

#### Scenario: Memory exceeds tier limit via PATCH
- **WHEN** a PATCH request sets `config.memory` above the tier's `functionMemoryMb`
- **THEN** the endpoint SHALL return 403 with a message indicating the tier limit

### Requirement: PATCH returns updated function state
The response SHALL include the function's full metadata after the update.

#### Scenario: Response shape
- **WHEN** a PATCH request succeeds
- **THEN** the response SHALL be 200 with `{ name, schedule, timeout, memory, runtime, updated_at }`
