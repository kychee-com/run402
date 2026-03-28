## Why

The run402 API now supports parameterized queries on `POST /projects/v1/admin/:id/sql` (accepts JSON `{ sql, params }`) and the `@run402/functions` Lambda runtime has expanded `db.sql(query, params?)` and `db.from(table)` APIs. The MCP tool, CLI command, and SKILL.md documentation are out of sync with these backend capabilities.

## What Changes

- **MCP `run_sql` tool**: Add optional `params` array to schema. When provided, send `Content-Type: application/json` with `{ sql, params }` instead of plain text.
- **CLI `projects sql` command**: Add `--params` flag accepting a JSON array string. Same JSON body behavior.
- **SKILL.md**: Expand "DB access inside functions" section to document `db.sql()` return type, parameterized query support, and full `db.from()` chainable API (matching llms.txt).
- OpenClaw inherits CLI changes automatically via shims.

## Capabilities

### New Capabilities
- `parameterized-sql`: Add parameterized query support to the `run_sql` MCP tool and CLI `projects sql` command
- `functions-db-docs`: Expand SKILL.md documentation for `db.sql()` and `db.from()` runtime helpers

### Modified Capabilities

## Impact

- `src/tools/run-sql.ts` — schema + handler changes (JSON body path)
- `src/tools/run-sql.test.ts` — new test cases for params
- `cli/lib/projects.mjs` — `sqlCmd` changes for `--params` flag
- `SKILL.md` — expanded DB section (~15 lines replacing 2)
- `sync.test.ts` — no surface changes (same tool names), but verify tests pass
