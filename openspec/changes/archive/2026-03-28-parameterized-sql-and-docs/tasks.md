## 1. MCP run_sql parameterized queries

- [x] 1.1 Add optional `params` field (z.array(z.unknown()).optional()) to `runSqlSchema` in `src/tools/run-sql.ts`
- [x] 1.2 Update `handleRunSql` to send JSON body when params is non-empty, plain text otherwise
- [x] 1.3 Add test cases in `src/tools/run-sql.test.ts`: parameterized query sends JSON, no params sends plain text, empty params sends plain text

## 2. CLI projects sql --params flag

- [x] 2.1 Add `--params` flag parsing to `sqlCmd` in `cli/lib/projects.mjs`
- [x] 2.2 Validate JSON.parse of params value, exit with error on invalid JSON
- [x] 2.3 Send JSON body with `{ sql, params }` when params provided, plain text otherwise

## 3. SKILL.md documentation

- [x] 3.1 Replace the 2-line db example (lines 206-211) with expanded `db.sql(query, params?)` docs including return type and parameterized example
- [x] 3.2 Add `db.from(table)` chainable API documentation (read methods, write methods, column narrowing)

## 4. Verify

- [x] 4.1 Run `npm test` — all unit and sync tests pass
