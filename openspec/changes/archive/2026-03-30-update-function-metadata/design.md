## Context

The PATCH endpoint is fully implemented server-side and live-tested. It accepts:
```json
{
  "schedule": "*/15 * * * *",  // set/update cron
  "schedule": null,             // remove schedule
  "config": { "timeout": 10, "memory": 256 }  // update Lambda config
}
```

Returns updated function state: `{ name, runtime, timeout, memory, schedule, schedule_meta, updated_at }`.

Tier validation is enforced server-side (schedule limits, timeout/memory caps).

## Goals / Non-Goals

**Goals:**
- Expose the existing PATCH endpoint through MCP, CLI, and OpenClaw
- Fix the sync test failure (SURFACE missing the PATCH endpoint)

**Non-Goals:**
- No server-side changes — endpoint is already complete
- No new payment handling — PATCH is a free (non-402) endpoint

## Decisions

### 1. MCP tool name: `update_function`

Follows existing naming: `deploy_function`, `list_functions`, `get_function_logs`. The tool accepts optional `schedule`, `timeout`, and `memory` params — at least one must be provided.

### 2. CLI subcommand: `functions update`

```
run402 functions update <id> <name> [--schedule <cron>] [--schedule-remove] [--timeout <s>] [--memory <mb>]
```

`--schedule ""` or `--schedule-remove` sends `null` to remove a schedule (same pattern as deploy). Flags map directly to PATCH body fields.

### 3. Flat params in MCP, not nested config object

The API uses `{ config: { timeout, memory } }` but the MCP tool flattens to `timeout` and `memory` as top-level params. The handler assembles the nested structure. This matches how `deploy_function` already works — users don't think in terms of a config sub-object.

### 4. CLI schedule removal

For removing a schedule, `--schedule ''` (empty string) maps to `null` in the body — same convention as `functions deploy`. Added `--schedule-remove` as an explicit alias for clarity.

## Risks / Trade-offs

- **[Risk] None significant** — this is wiring an existing, tested endpoint. Tier validation is server-side so no client bugs can bypass limits.
