## ADDED Requirements

### Requirement: BundleFunction accepts optional schedule field
The `BundleFunction` interface SHALL accept an optional `schedule` field containing a standard 5-field cron expression. When provided, the function SHALL be deployed with the cron schedule registered.

#### Scenario: Bundle deploy with scheduled function
- **WHEN** a bundle deploy includes `{ "functions": [{ "name": "cleanup", "code": "...", "schedule": "0 3 * * *" }] }`
- **THEN** the function SHALL be deployed AND the cron schedule SHALL be registered

#### Scenario: Bundle deploy without schedule
- **WHEN** a bundle deploy includes `{ "functions": [{ "name": "handler", "code": "..." }] }`
- **THEN** the function SHALL be deployed with no schedule (existing behavior preserved)

#### Scenario: Bundle deploy with null schedule
- **WHEN** a bundle deploy includes `{ "functions": [{ "name": "cleanup", "code": "...", "schedule": null }] }`
- **THEN** any existing schedule on that function SHALL be removed

### Requirement: Bundle validates cron expressions before deploying
`validateBundle` SHALL check that all `schedule` fields contain valid 5-field cron expressions. Invalid expressions SHALL fail the entire bundle with 400 before any deploy step runs.

#### Scenario: Invalid cron in bundle
- **WHEN** a bundle includes `{ "functions": [{ "name": "fn", "code": "...", "schedule": "not-a-cron" }] }`
- **THEN** the bundle SHALL fail with 400 and a message identifying the invalid expression and function name

### Requirement: Bundle enforces schedule tier limits
When deploying functions with schedules, the bundle SHALL enforce the same tier limits as individual function deploy: maximum scheduled function count and minimum schedule interval.

#### Scenario: Schedule exceeds tier limit
- **WHEN** a prototype-tier project bundle deploys a second function with a schedule (limit is 1)
- **THEN** the deploy SHALL fail with 403 and the tier limit message

#### Scenario: Schedule interval too frequent
- **WHEN** a prototype-tier project bundle deploys a function with `"schedule": "* * * * *"` (every minute, minimum is 15 min)
- **THEN** the deploy SHALL fail with 403 and the interval limit message
