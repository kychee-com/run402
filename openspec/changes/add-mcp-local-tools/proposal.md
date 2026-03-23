## Why

The MCP server is missing 4 local-only capabilities that the CLI provides: `status`, `projects:info`, `projects:use`, and `projects:keys`. These are the last gaps between the two interfaces. Without them, the MCP requires the LLM to pass explicit `project_id` on every call (no active project concept), has no single-call account overview, and cannot inspect local project credentials.

## What Changes

- Add MCP tool `status` — full account snapshot (allowance, billing balance, tier, projects, active project) via parallel API calls + local keystore read
- Add MCP tool `project_info` — show local project details (REST URL, keys, site URL) from keystore
- Add MCP tool `project_use` — set the active/default project in the local keystore
- Add MCP tool `project_keys` — return anon_key and service_key for a project from the local keystore
- Update `sync.test.ts` SURFACE entries: set `mcp` field for all 4 capabilities

## Capabilities

### New Capabilities
- `mcp-local-tools`: The 4 remaining local-only MCP tools (status, project_info, project_use, project_keys)

### Modified Capabilities

## Impact

- **New files**: `src/tools/status.ts`, `src/tools/project-info.ts`, `src/tools/project-use.ts`, `src/tools/project-keys.ts`
- **Modified**: `src/index.ts` (register 4 tools), `sync.test.ts` (update 4 SURFACE entries)
- **Dependencies**: None — all use existing core modules (`keystore.ts`, `allowance.ts`, `allowance-auth.ts`, `client.ts`)
