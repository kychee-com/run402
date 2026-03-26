## Why

Run402 functions are request-triggered only — there's no way to run a function on a schedule. This blocks an entire class of apps (booking reminders, digest emails, cleanup jobs, lease warnings) and was identified as the single biggest platform gap for the niche marketplace strategy (barbershop booking, church portals, cleaning company OS all need scheduled tasks).

## What Changes

- Add an optional `schedule` field (cron expression) to the function deploy API. One API call = deploy + schedule.
- Gateway maintains an in-memory cron scheduler that invokes functions on their configured schedule, using the same `invokeFunction()` code path as HTTP invocations.
- On startup, the gateway scans `internal.functions` for rows with a schedule and registers timers.
- Scheduled invocations count against the project's API call quota.
- Add a manual trigger endpoint under the existing admin route so functions can be fired on-demand (useful for testing and debugging).
- Track execution metadata (last run time, status, run count) in a `schedule_meta` JSONB column.
- Tier-gate the number of scheduled functions per project.

## Capabilities

### New Capabilities
- `scheduled-functions`: Cron-based scheduled invocation of deployed functions, including deploy-time schedule configuration, in-memory cron scheduling, manual trigger, execution metadata tracking, and tier-based limits.

### Modified Capabilities
- `bootstrap-function`: The deploy API gains a `schedule` field and the functions table gains `schedule` + `schedule_meta` columns.

## Impact

- **Gateway service** (`packages/gateway/src/services/functions.ts`): deploy logic adds schedule column, new scheduler service
- **Gateway routes** (`packages/gateway/src/routes/functions.ts`): manual trigger endpoint under admin route
- **Gateway startup** (`packages/gateway/src/server.ts`): start/stop scheduler
- **DB schema** (`internal.functions` table): two new columns
- **Tier config** (`packages/shared/src/tiers.ts`): new `maxScheduledFunctions` + `minScheduleInterval` per tier
- **MCP server** (separate repo): `deploy_function` tool gains `schedule` parameter (out of scope for this change, tracked separately)
