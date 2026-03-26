### Requirement: Deploy function with schedule
The `POST /projects/v1/admin/:id/functions` endpoint SHALL accept an optional `schedule` field containing a standard 5-field cron expression (minute, hour, day-of-month, month, day-of-week). When provided, the gateway SHALL register a cron timer that invokes the function on the specified schedule.

#### Scenario: Deploy with cron schedule
- **WHEN** an agent deploys a function with `{ "name": "send-reminders", "code": "...", "schedule": "*/15 * * * *" }`
- **THEN** the function SHALL be deployed and a cron timer SHALL be registered to invoke it every 15 minutes

#### Scenario: Deploy without schedule
- **WHEN** an agent deploys a function without a `schedule` field
- **THEN** the function SHALL be deployed normally with no cron timer (existing behavior preserved)

#### Scenario: Remove schedule by redeploying
- **WHEN** an agent redeploys a function with `{ "name": "send-reminders", "code": "...", "schedule": null }`
- **THEN** the existing cron timer SHALL be cancelled and the `schedule` column SHALL be set to null

#### Scenario: Update schedule by redeploying
- **WHEN** an agent redeploys a function with a different cron expression than the currently stored one
- **THEN** the old cron timer SHALL be cancelled and a new timer SHALL be registered with the updated schedule

#### Scenario: Invalid cron expression
- **WHEN** an agent deploys a function with an invalid cron expression (e.g., `"schedule": "not-a-cron"`)
- **THEN** the deploy SHALL fail with 400 and a descriptive error message

### Requirement: Scheduled invocation uses existing invoke path
When a cron timer fires, the gateway SHALL invoke the function using the same `invokeFunction()` code path as HTTP-triggered invocations. The function SHALL receive a synthetic POST request with header `X-Run402-Trigger: cron` and body `{ "trigger": "cron", "scheduled_at": "<ISO timestamp>" }`.

#### Scenario: Function receives cron trigger
- **WHEN** a cron timer fires for function `send-reminders`
- **THEN** the function SHALL receive a POST request with `X-Run402-Trigger: cron` header and a JSON body containing `{ "trigger": "cron", "scheduled_at": "2026-03-26T14:15:00.000Z" }`

#### Scenario: Function does not need to know about cron
- **WHEN** a function is deployed with a schedule but also invoked via HTTP
- **THEN** the function SHALL work identically for both invocation types — the `X-Run402-Trigger` header is informational, not required

### Requirement: Scheduler startup recovery
On gateway startup, the scheduler SHALL query `internal.functions` for all rows where `schedule IS NOT NULL` and register a cron timer for each.

#### Scenario: Gateway restarts with scheduled functions
- **WHEN** the gateway process restarts
- **THEN** all functions with a non-null `schedule` SHALL have their cron timers re-registered within the startup sequence

#### Scenario: Gateway starts with no scheduled functions
- **WHEN** the gateway starts and no functions have schedules
- **THEN** the scheduler SHALL start with an empty timer map and no errors

### Requirement: Schedule execution metadata
The `internal.functions` table SHALL include a `schedule_meta` JSONB column tracking: `last_run_at` (timestamp), `last_status` (integer HTTP status), `next_run_at` (timestamp), `run_count` (integer), `last_error` (string or null). This metadata SHALL be updated after each scheduled invocation.

#### Scenario: Successful scheduled invocation updates metadata
- **WHEN** a scheduled function invocation returns status 200
- **THEN** `schedule_meta` SHALL be updated with `last_run_at` set to the invocation time, `last_status` set to 200, `run_count` incremented by 1, `last_error` set to null, and `next_run_at` set to the next cron tick

#### Scenario: Failed scheduled invocation updates metadata
- **WHEN** a scheduled function invocation throws or returns status 500
- **THEN** `schedule_meta` SHALL be updated with `last_run_at` set to the invocation time, `last_status` set to 500, `run_count` incremented by 1, and `last_error` set to the error message

#### Scenario: Metadata visible in function list
- **WHEN** an agent calls `GET /projects/v1/admin/:id/functions`
- **THEN** each function with a schedule SHALL include `schedule`, `schedule_meta` in the response

### Requirement: Manual trigger endpoint
`POST /projects/v1/admin/:id/functions/:name/trigger` SHALL invoke the named function immediately using the same code path as a cron tick. It SHALL require service key authentication (admin route). The response SHALL contain the function's response status and body.

#### Scenario: Manual trigger succeeds
- **WHEN** an agent calls `POST /projects/v1/admin/:id/functions/send-reminders/trigger` with a valid service key
- **THEN** the function SHALL be invoked immediately and the response SHALL contain `{ "status": 200, "body": <function response> }`

#### Scenario: Manual trigger for nonexistent function
- **WHEN** an agent calls trigger for a function name that does not exist
- **THEN** the endpoint SHALL return 404

#### Scenario: Manual trigger updates schedule_meta
- **WHEN** a function with a schedule is manually triggered
- **THEN** `schedule_meta` SHALL be updated as if it were a cron invocation (last_run_at, last_status, run_count incremented)

### Requirement: Scheduled invocations count against API quota
Each scheduled invocation SHALL be metered as one API call against the project's tier quota, using the same metering middleware as HTTP invocations.

#### Scenario: Cron invocation increments API call counter
- **WHEN** a scheduled function fires
- **THEN** the project's API call counter SHALL be incremented by 1

#### Scenario: Quota exhausted blocks scheduled invocation
- **WHEN** a project has exceeded its API call quota and a cron timer fires
- **THEN** the invocation SHALL be skipped and `schedule_meta.last_error` SHALL be set to "API quota exceeded"

### Requirement: Tier-gated schedule limits
The number of scheduled functions and minimum schedule interval SHALL be gated by the project's tier. Deploying a function with a schedule that violates the tier limit SHALL fail with 403.

#### Scenario: Prototype tier allows one schedule
- **WHEN** a prototype-tier project deploys a second function with a schedule
- **THEN** the deploy SHALL fail with 403 and message indicating the tier limit (1 scheduled function)

#### Scenario: Prototype tier enforces 15-minute minimum
- **WHEN** a prototype-tier project deploys a function with `schedule: "*/5 * * * *"` (every 5 minutes)
- **THEN** the deploy SHALL fail with 403 and message indicating the minimum interval for this tier is 15 minutes

#### Scenario: Team tier allows 10 schedules at 1-minute minimum
- **WHEN** a team-tier project deploys a 10th function with `schedule: "* * * * *"` (every minute)
- **THEN** the deploy SHALL succeed

#### Scenario: Demo tier disallows schedules
- **WHEN** a demo-tier project deploys a function with any schedule
- **THEN** the deploy SHALL fail with 403

### Requirement: Scheduler graceful shutdown
On SIGTERM/SIGINT, the scheduler SHALL cancel all cron timers before the process exits, following the same pattern as existing internal schedulers (metering flush, lease checker).

#### Scenario: Gateway receives SIGTERM
- **WHEN** the gateway process receives SIGTERM
- **THEN** all cron timers SHALL be cancelled and no further invocations SHALL fire
