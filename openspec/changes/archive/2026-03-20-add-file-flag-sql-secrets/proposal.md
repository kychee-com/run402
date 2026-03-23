## Why

Two CLI commands (`projects sql` and `secrets set`) require users to pass potentially complex content as inline shell arguments. SQL with JSONB literals, multi-line statements, and PEM keys all require painful escaping. Every other content-heavy CLI command already supports `--file` — these two should too.

Additionally, the MCP `deploy_function` tool still uses `code` as its schema field name while the CLI now uses `--file`. The MCP schema should stay as `code` (it's inline content, not a file path), but this is worth documenting as a conscious decision.

## What Changes

- **`projects sql`**: Add `--file <path>` flag as alternative to inline `"<query>"` positional arg. When provided, reads SQL from disk.
- **`secrets set`**: Add `--file <path>` flag as alternative to inline `<value>` positional arg. When provided, reads secret value from disk.
- **MCP tools**: No schema changes needed. MCP tools receive content inline from the LLM — they don't read from the filesystem. The existing `sql` and `value` params are the correct interface for MCP. Document this as intentional asymmetry.
- **Docs**: Update `llms-cli.txt` to document the new `--file` flags.

## Capabilities

### New Capabilities
- `cli-file-flag`: Add `--file` flag to `projects sql` and `secrets set` CLI commands for reading content from disk instead of inline args

### Modified Capabilities

## Impact

- `cli/lib/projects.mjs` — `sqlCmd` function and help text
- `cli/lib/secrets.mjs` — `set` function and help text
- `cli-e2e.test.mjs` — new test cases for `--file` flag on both commands
- `~/dev/run402/site/llms-cli.txt` — updated CLI reference docs
- No MCP tool changes needed
- No breaking changes — inline args continue to work as before
