## Why

`run402 email create` returns a 409 error when a project already has a mailbox, but doesn't include the existing mailbox ID or address. Deploy scripts can't be idempotent — they fail on re-run with no way to recover the mailbox info. The only workaround (parsing `email list` output) is fragile and requires at least one sent message to exist.

## What Changes

- **Idempotent create_mailbox**: On 409 conflict, automatically discover the existing mailbox via `GET /mailboxes/v1` and return it as a success (with a note it already existed). Applies to both MCP tool and CLI command.
- **New `get_mailbox` tool / `email status` command**: Dedicated command to retrieve mailbox info (id, address, slug) without side effects. Added across all three interfaces (MCP, CLI, OpenClaw).
- **Updated tests**: Unit tests for 409 recovery behavior and the new `get_mailbox` tool.
- **Updated docs**: llms.txt/llms-cli.txt updated with the new `email status` command. SKILL.md updated if needed.
- **Sync test surface**: `get_mailbox` added to the `SURFACE` array in `sync.test.ts`.

## Capabilities

### New Capabilities
- `get-mailbox`: Retrieve a project's mailbox info (id, address, slug) via `GET /mailboxes/v1`

### Modified Capabilities
- `project-email`: The `create_mailbox` requirement changes — on 409 conflict it now auto-recovers by fetching and returning the existing mailbox instead of returning an error

## Impact

- **MCP tools**: New `get_mailbox` tool in `src/tools/`, modified `create-mailbox.ts` handler
- **CLI**: New `email status` subcommand in `cli/lib/email.mjs`, modified `email create` behavior
- **OpenClaw**: New `email:status` shim in `openclaw/scripts/email.mjs`
- **Tests**: New `get-mailbox.test.ts`, updated `create-mailbox.test.ts`, updated `sync.test.ts` surface array
- **Docs**: Updated llms.txt and llms-cli.txt with new command
