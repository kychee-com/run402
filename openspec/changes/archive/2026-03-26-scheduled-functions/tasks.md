## 1. Database Schema

- [x] 1.1 Add `schedule` (TEXT, nullable) and `schedule_meta` (JSONB, nullable) columns to `internal.functions` table in `initFunctionsTable()` (`packages/gateway/src/services/functions.ts`)
- [x] 1.2 Add ALTER TABLE migration logic for existing tables (the init function uses IF NOT EXISTS, so add column-add statements that are safe to re-run)

## 2. Deploy API — Schedule Field

- [x] 2.1 Accept optional `schedule` field in `POST /projects/v1/admin/:id/functions` route handler, validate it's a valid 5-field cron expression using `croner`
- [x] 2.2 Validate tier limits at deploy time: check max scheduled functions count and minimum interval against project tier, return 403 if violated
- [x] 2.3 Persist `schedule` to DB on deploy/redeploy; set `schedule_meta` to `{ "run_count": 0 }` on first schedule, null when schedule is removed
- [x] 2.4 Add `maxScheduledFunctions` and `minScheduleIntervalMinutes` to tier config in `packages/shared/src/tiers.ts`

## 3. Scheduler Service

- [x] 3.1 Install `croner` dependency in `packages/gateway`
- [x] 3.2 Create `packages/gateway/src/services/scheduler.ts` with: in-memory `Map<string, Cron>` for active timers, `registerSchedule(projectId, functionName, cronExpr)`, `cancelSchedule(projectId, functionName)`, `cancelAll()`
- [x] 3.3 Implement the cron tick handler: call `invokeFunction()` with synthetic POST request (header `X-Run402-Trigger: cron`, body `{ "trigger": "cron", "scheduled_at": "<ISO>" }`), update `schedule_meta` after each invocation (last_run_at, last_status, run_count, last_error, next_run_at)
- [x] 3.4 Handle quota-exceeded case: skip invocation, set `schedule_meta.last_error` to "API quota exceeded"
- [x] 3.5 Implement `startScheduler()`: query `internal.functions WHERE schedule IS NOT NULL`, register a cron timer for each
- [x] 3.6 Implement `stopScheduler()`: call `cancelAll()` to clean up timers on shutdown

## 4. Gateway Lifecycle Integration

- [x] 4.1 Call `startScheduler()` in `server.ts` startup sequence (after DB init, alongside existing `startMeteringFlush()` etc.)
- [x] 4.2 Call `stopScheduler()` in SIGTERM/SIGINT handlers alongside existing stop functions
- [x] 4.3 On function deploy/redeploy: if schedule changed, call `cancelSchedule()` then `registerSchedule()` with new expression (or just cancel if schedule removed)
- [x] 4.4 On function delete: call `cancelSchedule()` to remove any active timer

## 5. Manual Trigger Endpoint

- [x] 5.1 Add `POST /projects/v1/admin/:id/functions/:name/trigger` route with service key auth
- [x] 5.2 Invoke the function using the same code path as the cron tick handler (synthetic request, same headers)
- [x] 5.3 Update `schedule_meta` on manual trigger (same as cron invocation)
- [x] 5.4 Return function response status and body to the caller

## 6. Function List — Schedule Info

- [x] 6.1 Include `schedule` and `schedule_meta` fields in `GET /projects/v1/admin/:id/functions` response

## 7. Testing

- [x] 7.1 Unit test: cron expression validation (valid, invalid, edge cases)
- [x] 7.2 Unit test: tier limit enforcement (schedule count, minimum interval per tier)
- [x] 7.3 Integration test: deploy function with schedule → verify DB columns set → trigger manually → verify schedule_meta updated
- [x] 7.4 Integration test: deploy with schedule, redeploy with `schedule: null` → verify timer cancelled and DB cleared
- [x] 7.5 Integration test: deploy exceeding tier schedule limit → verify 403
