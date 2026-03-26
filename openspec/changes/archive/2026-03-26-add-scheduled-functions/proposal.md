## Why

The run402 gateway now supports scheduled (cron) functions — deploy a function with a cron expression and it runs automatically on that schedule. The API already ships `schedule` on the deploy endpoint, `schedule`/`schedule_meta` on the list endpoint, and tier-gated limits. But the MCP server, CLI, and SKILL.md don't expose any of it yet. Agents can't deploy scheduled functions or see schedule status.

## What Changes

- `deploy_function` MCP tool gains optional `schedule` parameter (cron expression string, nullable to remove). Output table shows schedule when present.
- `list_functions` MCP tool shows schedule, next run, last run, run count, and status columns for all functions.
- `bundle_deploy` MCP tool gains optional `schedule` field on function items in the `functions` array. Output shows schedule next to function URL when present.
- CLI `functions deploy` gains `--schedule <expr>` flag (empty string removes schedule). No CLI changes needed for `list` or `deploy` (both pass through raw JSON).
- SKILL.md documents the `schedule` parameter, tier limits, and cron invocation metering.

## Capabilities

### New Capabilities

### Modified Capabilities
- `deploy_function`: Optional `schedule` parameter (5-field cron expression). Pass `null` / empty string to remove an existing schedule.
- `list_functions`: Response includes `schedule`, `schedule_meta` fields. MCP output shows schedule columns.
- `bundle_deploy`: Function items in the `functions` array accept optional `schedule` field.

## Impact

- **Modified files**:
  - `src/tools/deploy-function.ts` — add `schedule` to schema, body, response type, and output table
  - `src/tools/list-functions.ts` — add `schedule`/`schedule_meta` to response type, add schedule columns to output table
  - `src/tools/bundle-deploy.ts` — add `schedule` to function item schema/type, show in output
  - `cli/lib/functions.mjs` — add `--schedule` flag to deploy subcommand and help text
  - `SKILL.md` — document schedule parameter and tier limits
- **No new files**
- **No new SURFACE entries** in `sync.test.ts` (no new endpoints exposed)
- **Dependencies**: None — all changes use existing patterns
