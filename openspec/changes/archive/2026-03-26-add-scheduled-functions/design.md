## Context

The run402 gateway already supports scheduled functions via:
- `POST /projects/v1/admin/:id/functions` — accepts optional `schedule` field (5-field cron expression)
- `GET /projects/v1/admin/:id/functions` — returns `schedule` and `schedule_meta` per function
- `POST /deploy/v1` — bundle deploy, function items can include `schedule`

The MCP server, CLI, and SKILL.md in run402-public need to expose this existing API surface. No new API endpoints are being created — this is purely client-side plumbing.

## Goals / Non-Goals

**Goals:**
- Add `schedule` parameter to `deploy_function` MCP tool and CLI `functions deploy`
- Surface `schedule` and `schedule_meta` in `list_functions` MCP output
- Add `schedule` to function items in `bundle_deploy` MCP schema
- Document scheduling in SKILL.md with tier limits
- CLI `--schedule ''` (empty string) removes an existing schedule

**Non-Goals:**
- No `trigger_function` tool (the trigger endpoint was built for gateway testing, not agent use)
- No changes to `sync.test.ts` (no new surface entries)
- No changes to OpenClaw scripts (they re-export CLI, which passes through)
- No CLI changes for `list` or bundle `deploy` (both output raw JSON already)

## Decisions

### 1. `schedule` as nullable optional string

The MCP schema uses `z.string().nullable().optional()`. Three states:
- Omitted/undefined: no change to schedule (for redeploys that don't touch scheduling)
- String value (e.g. `"*/15 * * * *"`): set or update the schedule
- `null`: explicitly remove an existing schedule

The CLI maps `--schedule ''` (empty string) to `schedule: null` in the request body.

### 2. Always show schedule columns in list output

The `list_functions` MCP output always includes Schedule, Next Run, Last Run, Runs, and Status columns, using `—` for functions without schedules. This keeps output predictable for the agent reader.

### 3. schedule_meta display

`schedule_meta` contains `{ last_run_at, last_status, next_run_at, run_count, last_error }`. The MCP table shows all of these. When `last_error` is present (non-null), it's appended as a note below the table.

### 4. Bundle deploy schedule display

When a function in the bundle deploy response has a schedule, show it inline: `` `send-reminders` → url (*/15 * * * *) ``. Keeps the output compact.

## Risks / Trade-offs

**[Minimal]** — All changes are client-side display and parameter passthrough. The API already validates cron expressions, tier limits, and schedule counts server-side. No risk of breaking existing functionality.
