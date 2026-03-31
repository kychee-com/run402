## Why

The backend shipped custom domain support (POST/GET/DELETE `/domains/v1`) in commit `699f77c`, but there are no MCP tools, CLI commands, or OpenClaw shims to expose it. The sync test is already failing because `llms.txt` documents 4 domain endpoints with no SURFACE entries. Agents and CLI users have no way to register, check, or remove custom domains.

## What Changes

- Add 4 MCP tools: `add_custom_domain`, `list_custom_domains`, `check_domain_status`, `remove_custom_domain`
- Add CLI module `cli/lib/domains.mjs` with subcommands: `add`, `list`, `status`, `delete`
- Add OpenClaw shim `openclaw/scripts/domains.mjs` re-exporting CLI module
- Register all in `cli/cli.mjs`, `src/index.ts`, and the SURFACE array in `sync.test.ts`
- Add `### domains` section to `llms-cli.txt` in the run402 repo
- All 4 endpoints require `service_key` auth (assumes MajorTal/run402#34 is merged — status endpoint gets auth added)

## Capabilities

### New Capabilities
- `custom-domains`: Register, list, check status, and remove custom domains mapped to Run402 subdomains

### Modified Capabilities

## Impact

- **MCP server** (`src/tools/`): 4 new tool files + registration in `index.ts`
- **CLI** (`cli/`): new `domains.mjs` module + dispatch in `cli.mjs`
- **OpenClaw** (`openclaw/`): new shim script
- **Tests**: `sync.test.ts` SURFACE array gains 4 entries; new unit tests for MCP tools
- **Docs**: `llms-cli.txt` in `~/dev/run402` gets a domains section
