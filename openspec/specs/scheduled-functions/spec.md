### Requirement: deploy_function accepts schedule parameter

The `deploy_function` MCP tool SHALL accept an optional `schedule` parameter containing a 5-field cron expression string. When provided, the schedule is passed to the API in the request body. When set to `null`, the API removes an existing schedule.

#### Scenario: Deploy with schedule
- **WHEN** an agent calls `deploy_function` with `schedule: "*/15 * * * *"`
- **THEN** the request body SHALL include `"schedule": "*/15 * * * *"` and the output table SHALL show the schedule

#### Scenario: Deploy without schedule
- **WHEN** an agent calls `deploy_function` without a `schedule` parameter
- **THEN** the request body SHALL NOT include a `schedule` field (existing behavior preserved)

#### Scenario: Remove schedule
- **WHEN** an agent calls `deploy_function` with `schedule: null`
- **THEN** the request body SHALL include `"schedule": null` and the API removes the existing schedule

### Requirement: CLI functions deploy accepts --schedule flag

The CLI `functions deploy` subcommand SHALL accept an optional `--schedule <expr>` flag. An empty string (`--schedule ''`) SHALL send `schedule: null` in the request body to remove an existing schedule.

#### Scenario: Deploy with schedule via CLI
- **WHEN** a user runs `run402 functions deploy <id> <name> --file handler.ts --schedule "*/15 * * * *"`
- **THEN** the request body SHALL include `"schedule": "*/15 * * * *"`

#### Scenario: Remove schedule via CLI
- **WHEN** a user runs `run402 functions deploy <id> <name> --file handler.ts --schedule ""`
- **THEN** the request body SHALL include `"schedule": null`

### Requirement: list_functions shows schedule columns

The `list_functions` MCP tool SHALL always display Schedule, Next Run, Last Run, Runs, and Status columns. Functions without schedules SHALL show `—` in schedule columns.

#### Scenario: List with scheduled functions
- **WHEN** an agent calls `list_functions` and functions have schedules
- **THEN** the output table SHALL include schedule expression, next_run_at, last_run_at, run_count, and last_status for each function

#### Scenario: List with no scheduled functions
- **WHEN** an agent calls `list_functions` and no functions have schedules
- **THEN** the output table SHALL still include Schedule, Next Run, Last Run, Runs, and Status columns with `—` values

#### Scenario: Function with last_error
- **WHEN** a function's `schedule_meta.last_error` is non-null
- **THEN** the error SHALL be shown as a note below the table

### Requirement: bundle_deploy accepts schedule on function items

The `bundle_deploy` MCP tool's `functions` array items SHALL accept an optional `schedule` field. When present, it is passed through in the request body. The output SHALL show the schedule next to the function URL.

#### Scenario: Bundle deploy with scheduled function
- **WHEN** an agent calls `bundle_deploy` with `functions: [{ name: "cleanup", code: "...", schedule: "0 3 * * *" }]`
- **THEN** the request body SHALL include the schedule and the output SHALL show `cleanup → url (0 3 * * *)`

### Requirement: SKILL.md documents scheduling

SKILL.md SHALL document the `schedule` parameter on `deploy_function`, tier limits for scheduled functions, and that cron invocations count against API quota.
