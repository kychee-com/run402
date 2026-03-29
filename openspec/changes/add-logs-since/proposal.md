## Why

Users debugging edge functions have to repeatedly run `run402 functions logs` to check for new errors. Each call returns the last N logs with no way to request only entries newer than what they've already seen — leading to duplicate output and wasted API calls. The CLI also lacks a `--follow` mode for continuous log tailing during active debugging sessions.

GitHub issue: #9

## What Changes

- **API**: Add optional `since` query parameter (epoch ms) to `GET /projects/v1/admin/:id/functions/:name/logs`. Maps directly to CloudWatch `FilterLogEventsCommand`'s `startTime`. Inclusive boundary, so clients should pass `lastSeenTimestamp + 1ms` to avoid duplicates.
- **MCP tool**: Add optional `since` parameter (ISO timestamp string) to `get_function_logs`. Enables LLMs to efficiently poll logs across multiple tool calls without re-fetching old entries.
- **CLI**: Add `--since <timestamp>` flag and `--follow` flag to `run402 functions logs`. Follow mode polls the API at a fixed interval (default 3s), using `since` to fetch only new entries. Ctrl-C to stop.
- **OpenClaw**: Gets `since` support via CLI shim. No follow mode.

## Capabilities

### New Capabilities
- `logs-since`: Incremental log fetching via `since` parameter across API, MCP, and CLI, plus CLI `--follow` polling mode

### Modified Capabilities

## Impact

- **API (run402 gateway)**: `packages/gateway/src/routes/functions.ts` — parse `since` query param, pass to `getFunctionLogs`. `packages/gateway/src/services/functions.ts` — add `startTime` to `FilterLogEventsCommand`.
- **MCP**: `src/tools/get-function-logs.ts` — add `since` to schema and pass to API.
- **CLI**: `cli/lib/functions.mjs` — add `--since` and `--follow` flags with polling loop.
- **OpenClaw**: `openclaw/scripts/functions.mjs` — inherits from CLI shim, no changes needed.
- **Docs**: SKILL.md functions logs section, llms-cli.txt in run402 repo.
- **Sync test**: No new SURFACE entry (same endpoint, new query param).
