## Why

The gateway already supports `PATCH /projects/v1/admin/:id/functions/:name` to update a function's schedule and config (timeout, memory) without re-deploying code. But the CLI, MCP, and OpenClaw don't expose it — users have to redeploy the full function just to change a cron expression. This also causes the sync test to fail because `llms-cli.txt` documents the PATCH endpoint but SURFACE doesn't include it.

GitHub issue: #4

## What Changes

- **MCP**: New `update_function` tool that sends PATCH with optional `schedule` and `config` fields
- **CLI**: New `run402 functions update <id> <name> [--schedule <cron>] [--timeout <s>] [--memory <mb>]` subcommand
- **OpenClaw**: Shim re-exporting CLI's `run` function (automatic via existing pattern)
- **Sync test**: New SURFACE entry for `update_function`

## Capabilities

### New Capabilities
- `update-function`: Update function metadata (schedule, timeout, memory) without re-deploying code

### Modified Capabilities

## Impact

- **MCP**: New tool file `src/tools/update-function.ts` with schema + handler
- **CLI**: New subcommand in `cli/lib/functions.mjs`
- **OpenClaw**: No changes needed (shim re-exports CLI)
- **Sync test**: Add entry to SURFACE array in `sync.test.ts`
- **Docs**: SKILL.md new tool section, llms-cli.txt already documents the endpoint
