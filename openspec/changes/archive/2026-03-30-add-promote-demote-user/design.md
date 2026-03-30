## Context

The Run402 gateway added a `project_admin` role with two admin endpoints for promoting/demoting users. These endpoints follow the same pattern as other admin endpoints (`/projects/v1/admin/:id/...`) and require `service_key` auth. Currently, these endpoints are listed in `IGNORED_ENDPOINTS` in sync.test.ts with the comment "not yet exposed as CLI/MCP tools."

All three interfaces (MCP, CLI, OpenClaw) need to be extended. The existing `set_secret` tool is the closest pattern — a simple admin endpoint with service_key auth, project_id + one additional parameter.

## Goals / Non-Goals

**Goals:**
- Expose `promote-user` and `demote-user` across all three interfaces (MCP, CLI, OpenClaw)
- Follow existing tool/command patterns exactly (same error handling, auth, output format)
- Keep sync.test.ts passing with the new entries

**Non-Goals:**
- Adding `--admin` flag to CLI auth signup (the issue mentions this but there is no existing `auth signup` CLI command or MCP signup tool — this would be a separate change)
- Listing or viewing project admin users (no endpoint exists for this)
- Changing the auth or keystore system

## Decisions

**One MCP tool file per action** — `promote-user.ts` and `demote-user.ts` as separate files, matching the project convention (each tool is its own file). Alternative: a single `user-role.ts` with two exports. Rejected because every existing tool follows the one-file-per-action pattern.

**CLI subcommands under `projects`** — `promote-user` and `demote-user` as subcommands of `run402 projects`, matching the endpoint path structure (`/projects/v1/admin/:id/...`). The CLI convention is that admin operations on a project live under `projects:*`.

**service_key auth, not allowance auth** — These endpoints require service_key (stored in keystore per project), not wallet-based allowance auth. This matches other admin endpoints like `sql`, `schema`, `usage`.

**No separate OpenClaw module** — OpenClaw's `projects.mjs` is already a thin re-export of CLI's `projects.mjs`. Since the new subcommands are added directly to the CLI's run() switch, OpenClaw gets them for free with no changes needed.

## Risks / Trade-offs

**[Risk] Email not found returns error** → The API may return 404 or similar if the email doesn't correspond to a signed-up user. The tools will surface this via `formatApiError` in MCP and JSON error output in CLI, giving actionable feedback.

**[Risk] Demoting the last admin** → The gateway should handle this constraint, not the client tools. No client-side validation needed.
