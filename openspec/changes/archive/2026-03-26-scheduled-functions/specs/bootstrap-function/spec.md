## MODIFIED Requirements

### Requirement: Deploy accepts bootstrap variables
The `POST /deploy/v1` endpoint SHALL accept an optional `bootstrap` field in the request body, with the same semantics as fork.

The `POST /projects/v1/admin/:id/functions` endpoint SHALL accept an optional `schedule` field (string, cron expression) and persist it to the `internal.functions` table alongside the existing columns. The `internal.functions` table SHALL include two new columns: `schedule` (TEXT, nullable) for the cron expression and `schedule_meta` (JSONB, nullable) for execution tracking metadata.

#### Scenario: Bundle deploy with bootstrap
- **WHEN** an agent sends `POST /deploy/v1` with a bundle that includes a function named `bootstrap` and a `bootstrap` field with variables
- **THEN** the platform SHALL deploy the bundle and invoke the bootstrap function with the provided variables after all other deployment steps complete

#### Scenario: Deploy function with schedule field
- **WHEN** an agent sends `POST /projects/v1/admin/:id/functions` with `{ "name": "cleanup", "code": "...", "schedule": "0 3 * * *" }`
- **THEN** the function SHALL be deployed with the `schedule` column set to `"0 3 * * *"` and `schedule_meta` initialized to `{ "run_count": 0 }`

#### Scenario: Redeploy function clears schedule
- **WHEN** an agent redeploys a function with `"schedule": null`
- **THEN** the `schedule` column SHALL be set to null and `schedule_meta` SHALL be set to null
