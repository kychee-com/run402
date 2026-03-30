## Why

The Run402 gateway now supports a `project_admin` role — app-level admins who can manage secrets from the browser. Two new admin endpoints (`promote-user`, `demote-user`) exist in the API but have no MCP tools, CLI commands, or OpenClaw shims. The signup endpoint also now accepts `is_admin` but the CLI doesn't expose that flag. Without tooling, developers can't manage project admins through any of the three interfaces.

## What Changes

- **New MCP tools**: `promote_user(project_id, email)` and `demote_user(project_id, email)` — call the admin endpoints with service_key auth
- **New CLI commands**: `run402 projects promote-user` and `run402 projects demote-user` — same endpoints, CLI output format
- **New OpenClaw shims**: thin re-exports of the CLI commands
- **CLI enhancement**: `--admin` flag on `run402 auth signup` — passes `is_admin: true` in the signup request body (requires service_key)
- **MCP enhancement**: optional `is_admin` parameter on the existing signup flow (if an MCP signup tool exists; otherwise skip)
- **sync.test.ts**: add both tools to the `SURFACE` array and remove them from `IGNORED_ENDPOINTS`

## Capabilities

### New Capabilities
- `user-role-management`: Promote and demote project users to/from the `project_admin` role via MCP, CLI, and OpenClaw

### Modified Capabilities
<!-- No existing specs are changing at the requirement level -->

## Impact

- **MCP server** (`src/tools/`): two new tool files (`promote-user.ts`, `demote-user.ts`)
- **CLI** (`cli/lib/projects.mjs`): two new subcommands (`promote-user`, `demote-user`)
- **OpenClaw** (`openclaw/scripts/projects.mjs`): re-export the new CLI subcommands
- **sync.test.ts**: update `SURFACE` array (add entries) and `IGNORED_ENDPOINTS` (remove the two endpoints)
- **API endpoints used**: `POST /projects/v1/admin/:id/promote-user`, `POST /projects/v1/admin/:id/demote-user` — both require service_key auth
- **No new dependencies** — uses existing `apiRequest`, `getProject`, `formatApiError` patterns
