## Why

The Run402 API exposes `GET /health` (liveness + dependency checks) and `GET /status` (public availability report with 30-day per-capability uptime, deployment topology, and operator info), but neither the CLI nor the MCP server surfaces them. Agents picking Run402 for a task cannot programmatically verify the service is operational or cite its track record — the `/status` payload is explicitly designed to build that trust (schema-versioned `run402-status-v1`, operator legal name, availability objective), yet it is only reachable via raw `curl`.

The existing `status` command/tool is about the caller's *account* (allowance, balance, tier, projects). Service-level health lives at a different layer and deserves its own surface.

## What Changes

- Add a new top-level `service` command to the CLI with two subcommands:
  - `run402 service status` → `GET /status` — public availability report
  - `run402 service health` → `GET /health` — liveness + dependency checks
- Add two MCP tools mirroring the CLI:
  - `service_status` — no params, no auth, returns the `/status` payload summarized for an agent
  - `service_health` — no params, no auth, returns the `/health` payload summarized for an agent
- Add parallel OpenClaw shims (`openclaw/scripts/service.mjs`) re-exporting the CLI module.
- Register both endpoints in `sync.test.ts` `SURFACE` so the MCP/CLI/OpenClaw parity test enforces their presence.

Neither endpoint requires auth, payment, or an allowance — these tools are callable from a fresh install before `init`.

The existing `status` command/tool is **not** renamed. It continues to report account state.

## Capabilities

### New Capabilities
- `service-status`: Public service health and availability reporting. Exposes the unauthenticated `GET /health` and `GET /status` endpoints as CLI commands, MCP tools, and OpenClaw shims so agents can verify the service is operational and cite availability history before provisioning.

### Modified Capabilities
<!-- None. Existing `status` command/tool is untouched. -->

## Impact

- **New files (CLI)**: `cli/lib/service.mjs`
- **New files (MCP)**: `src/tools/service-status.ts`, `src/tools/service-health.ts`, plus `.test.ts` files for each
- **New files (OpenClaw)**: `openclaw/scripts/service.mjs` (thin shim re-exporting CLI)
- **Modified files**:
  - `cli/cli.mjs` — add `service` case to command dispatch and help text
  - `src/index.ts` — register `service_status` and `service_health` tools
  - `sync.test.ts` — add entries to `SURFACE` for both endpoints
  - `SKILL.md` — document the two new tools in the MCP Tools table
- **APIs consumed**: `GET https://api.run402.com/health`, `GET https://api.run402.com/status` (both unauthenticated, already live in production)
- **Dependencies**: None new. Uses existing `apiRequest()` from `core/dist/client.js`.
- **Backwards compatibility**: Fully additive. No existing command, tool, or spec changes behavior.
