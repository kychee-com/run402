## Context

The MCP server has 48 tools matching the CLI but is missing 4 local-only commands: `status`, `projects:info`, `projects:use`, and `projects:keys`. All 4 operate on the same local state files (`keystore.json`, `allowance.json`) that the MCP already reads/writes. The `init` tool (added in v1.15.0) established the pattern for composite local+API tools in the MCP.

## Goals / Non-Goals

**Goals:**
- Add 4 MCP tools to achieve full CLI parity
- Each tool follows the existing MCP tool pattern (Zod schema + async handler)
- Share the same state files as CLI — full interoperability
- `status` makes parallel API calls (tier, billing, projects) like the CLI does

**Non-Goals:**
- Not changing how existing tools resolve project_id (they still require explicit project_id)
- Not adding active-project fallback to existing tools — that's a separate concern

## Decisions

### 1. Four separate tool files

One file per tool (`status.ts`, `project-info.ts`, `project-use.ts`, `project-keys.ts`), consistent with the existing `src/tools/` convention where each tool is its own file.

### 2. `status` uses `apiRequest()` with parallel calls

The CLI's `status` command makes 3 parallel API calls (tier, billing, projects). The MCP tool does the same via `Promise.all` on `apiRequest()` calls, plus reads local keystore for the active project. Returns a markdown summary table.

### 3. `project_info` / `project_keys` read-only from keystore

These tools only read the local keystore — no API calls. `project_info` returns REST URL, keys, site URL, and deployment info. `project_keys` returns just the two keys. Both require a `project_id` parameter.

### 4. `project_use` writes active_project_id

Calls `setActiveProjectId()` from core keystore module. Validates the project exists in the keystore first.

### 5. Tool names match SURFACE IDs

`status`, `project_info`, `project_use`, `project_keys` — matching the existing SURFACE capability IDs in `sync.test.ts`.

## Risks / Trade-offs

- **[status API failures]** Any of the 3 API calls in `status` may fail. The tool handles each independently — a failed call results in null for that section, not a tool error. Same approach as the CLI. → Low risk.

- **[project_keys exposes secrets]** The `project_keys` tool returns `service_key` in the response. This is the same behavior as the CLI's `projects:keys` command and is needed for debugging/scripting. The keys are already stored locally. → Acceptable.
