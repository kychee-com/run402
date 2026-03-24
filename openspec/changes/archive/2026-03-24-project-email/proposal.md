## Why

Run402 now supports project-scoped email at `<slug>@mail.run402.com`. Each project can create one mailbox and send template-based emails (invites, magic links, notifications). The backend is live in production — we need MCP tools, CLI commands, and OpenClaw shims so developers can use email from all three interfaces.

## What Changes

- Add MCP tools: `create_mailbox`, `send_email`, `list_emails`, `get_email`
- Add CLI command group: `run402 email {create, send, list, get}`
- Add OpenClaw shims that re-export CLI email module
- Add unit tests for MCP tools (mock fetch pattern)
- Update `sync.test.ts` SURFACE array with new email tools/commands
- Update SKILL.md with email tool references

## Capabilities

### New Capabilities
- `project-email`: Project-scoped mailbox creation, template-based email sending, and message listing via `/mailboxes/v1` API endpoints

### Modified Capabilities
<!-- None — this is a new feature with no changes to existing spec-level behavior -->

## Impact

- **MCP server** (`src/tools/`): 4 new tool files + registration in `src/index.ts`
- **CLI** (`cli/lib/`): New `email.mjs` module + registration in CLI entry point
- **OpenClaw** (`openclaw/scripts/`): New `email.mjs` shim
- **Core**: No core changes needed — existing `apiRequest()` and keystore are sufficient
- **Tests**: New tool test files, sync test updates
- **API**: Consumes 9 new `/mailboxes/v1` endpoints (service_key auth, one admin-only)
