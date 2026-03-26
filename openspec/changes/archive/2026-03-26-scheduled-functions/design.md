## Context

Run402 functions are deployed via `POST /projects/v1/admin/:id/functions` and invoked via `ALL /functions/v1/:name`. Invocation is always request-triggered — either by an external HTTP call or internally (e.g., bootstrap after fork). There is no way to run a function on a timer.

The gateway already runs four internal periodic tasks using `setInterval()` (metering flush, lease checker, faucet refill, demo resets). These follow a simple pattern: async function + `startXxx()` on startup + `stopXxx()` on shutdown. The gateway runs as a single ECS task (desiredCount: 1), so there are no distributed scheduling concerns.

Functions are stored in `internal.functions` with columns for `project_id`, `name`, `lambda_arn`, `runtime`, `timeout_seconds`, `memory_mb`, `code_hash`, `deps`, `source`. Invocation goes through `invokeFunction()` which handles both Lambda mode (production) and local mode (dev).

## Goals / Non-Goals

**Goals:**
- Deploy a function with a cron schedule in a single API call
- Gateway invokes scheduled functions automatically using the existing `invokeFunction()` path
- Track execution metadata (last run, status, count) for observability
- Manual trigger endpoint for testing and on-demand execution
- Tier-gated limits on scheduled function count and minimum interval
- Scheduled invocations count against API call quota

**Non-Goals:**
- Distributed scheduling / multi-instance coordination (single ECS task is fine for now)
- Catch-up for missed ticks during restarts (best-effort, like existing internal schedulers)
- EventBridge integration (future v2 — skip the gateway, target Lambda directly)
- Sub-minute scheduling (minimum interval: 1 minute)
- Retry on failure (function fails → log it, next tick runs independently)
- MCP server changes (separate repo, tracked separately)

## Decisions

### 1. Schedule as a deploy-time field (not a separate API)

Add an optional `schedule` field to the existing deploy endpoint. One API call = deploy + schedule. Remove the schedule by redeploying with `schedule: null`.

**Alternatives considered:**
- Separate `/schedules` CRUD API: More flexible (pause without redeploy, multiple schedules per function) but adds 3+ routes, a new MCP tool, and more cognitive load. Multiple schedules per function is a YAGNI.
- In-code `export const schedule = "..."`: Elegant but requires parsing user code, which is fragile.

**Rationale:** Minimal API surface. Agents already call deploy — adding one field is zero learning curve. The MCP `deploy_function` tool just gains a `schedule` parameter.

### 2. Cron library: `croner`

Use `croner` (npm) for cron expression parsing and scheduling. It's small (~5KB), has no dependencies, supports standard 5-field cron syntax, and provides `.nextRun()` for the `next_run_at` metadata.

**Alternatives considered:**
- `node-cron`: Larger, more dependencies, similar API.
- Raw `setInterval`: Can't express "every Monday at 9am." Cron expressions are the standard.
- `pg_cron`: Would require Postgres extension installation on Aurora, non-trivial ops change.

### 3. In-memory scheduler with DB persistence

Schedules are stored in `internal.functions.schedule` (TEXT column) and `schedule_meta` (JSONB column). On startup, the gateway scans for all functions with a non-null schedule and registers cron timers in memory. On deploy/redeploy, the old timer is cancelled and a new one registered (if schedule changed).

**State stored in memory:** `Map<string, CronJob>` keyed by `"projectId:functionName"`.

**State stored in DB:**
- `schedule`: the cron expression (or null)
- `schedule_meta`: `{ last_run_at, last_status, next_run_at, run_count, last_error }`

### 4. Manual trigger as admin sub-route

`POST /projects/v1/admin/:id/functions/:name/trigger` — fires the function immediately, same as a cron tick. Uses the same `invokeFunction()` code path. Requires service key auth (admin route). Returns the function's response.

This serves double duty: testing in CI (deploy → trigger → assert) and debugging in production ("run my reminders now").

### 5. Cron invocations synthesize an HTTP request

When the scheduler fires, it calls `invokeFunction()` with a synthetic request:
- Method: `POST`
- Path: `/functions/v1/{name}`
- Header: `X-Run402-Trigger: cron`
- Body: `{ "trigger": "cron", "scheduled_at": "<ISO timestamp>" }`

The function can check `X-Run402-Trigger` if it needs to distinguish cron from HTTP, but doesn't have to. This keeps functions unaware of their invocation source by default.

### 6. Tier limits

| Tier       | Max scheduled functions | Min interval |
|------------|------------------------|--------------|
| Demo       | 0                      | —            |
| Prototype  | 1                      | 15 min       |
| Hobby      | 3                      | 5 min        |
| Team       | 10                     | 1 min        |

Validated at deploy time. Deploying a function with a schedule that violates tier limits returns 403.

## Risks / Trade-offs

**[Single-instance scheduling]** → All timers live in one ECS task. If it restarts, ticks are missed until the new task boots (~35s). Mitigation: acceptable for v1 — same risk as existing internal schedulers. For v2, move to EventBridge rules targeting Lambda directly.

**[No retry on failure]** → If a scheduled function fails, the error is logged and `schedule_meta` is updated, but there's no automatic retry. Mitigation: the next tick runs independently. For transient failures (DB timeout), the function will succeed on the next tick. For persistent failures, the owner checks `schedule_meta.last_error`.

**[Memory growth]** → Each scheduled function is one `CronJob` object in memory — negligible. Even 2000 projects × 10 schedules = 20K timers, which is fine.

**[Clock drift]** → Node.js timers are not guaranteed to fire at exact times under load. Mitigation: cron libraries use `setTimeout` to the next tick rather than `setInterval`, which self-corrects. Acceptable for the granularity we support (minutes, not seconds).

**[Overlapping invocations]** → If a function takes longer than the schedule interval, the next tick fires while the previous is still running. Mitigation: for v1, allow overlap — functions should be idempotent. Track `running` state in `schedule_meta` for future "skip if running" option.
