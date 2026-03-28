## Context

The run402 API endpoint `POST /projects/v1/admin/:id/sql` now accepts two content types:
- `text/plain` — raw SQL string (existing behavior)
- `application/json` — `{ "sql": "...", "params": [...] }` for parameterized queries (new)

The `@run402/functions` Lambda runtime has expanded `db.sql()` to accept params and `db.from()` with a full chainable API. The SKILL.md documentation only shows a minimal 2-line example.

This repo's MCP tool (`run-sql.ts`) and CLI (`projects.mjs`) currently send plain text only. They need a JSON path for params.

## Goals / Non-Goals

**Goals:**
- MCP `run_sql` and CLI `projects sql` support optional parameterized queries
- SKILL.md documents the full `db.sql()` and `db.from()` API matching llms.txt
- Backward compatible — omitting params preserves existing plain-text behavior

**Non-Goals:**
- Changing the API endpoint behavior (already done in run402)
- Adding params support to `rest_query` (uses PostgREST, not raw SQL)
- Changing the response format (already returns `{ status, schema, rows, rowCount }`)

## Decisions

**1. JSON body when params present, plain text otherwise**

When `params` is provided and non-empty, send `Content-Type: application/json` with `{ sql, params }`. When omitted, keep existing `text/plain` with raw SQL body. This maintains backward compatibility and avoids unnecessary format changes.

Alternative: Always send JSON. Rejected because it changes behavior for all callers and the API still has the text/plain path documented.

**2. CLI `--params` as JSON array string**

The CLI accepts `--params '[1, "hello"]'` as a JSON string that gets parsed. This matches common CLI patterns (e.g., `aws --cli-input-json`). Alternative: positional args after `--` separator. Rejected as harder to parse and ambiguous with mixed types.

**3. SKILL.md docs mirror llms.txt structure**

Copy the expanded db.sql() and db.from() documentation directly from the llms.txt diff. This keeps the two sources consistent and avoids documentation drift.

## Risks / Trade-offs

- [Params type safety] CLI params arrive as a JSON string — invalid JSON will fail at parse time. → Mitigation: validate with `JSON.parse()` and give a clear error message.
- [SKILL.md size] Adding ~15 lines of API docs. → Acceptable; this is the primary reference for agents using functions.
