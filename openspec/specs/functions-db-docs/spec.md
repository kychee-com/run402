### Requirement: SKILL.md documents dual-surface DB clients (db(req) and adminDb())

The SKILL.md "DB access inside functions" section SHALL document BOTH DB clients the SDK provides and make the caller-context default explicit:

- `db(req).from(table)` — caller-context client. Forwards the incoming request's `Authorization` header to PostgREST; RLS applies to the caller's role. Routes to `/rest/v1/*`. Documented as the default for end-user requests.
- `adminDb().from(table)` — BYPASSRLS client. Uses the project's service_key. Routes to `/admin/v1/rest/*` (the gateway rejects `role=service_role` on `/rest/v1/*`). Documented as explicit opt-in for platform-authored work.

The section SHALL explain *when* to reach for each (default to `db(req)`; use `adminDb()` only when the function is the principal, not the caller) and SHALL note that the legacy `db.from(...)` / `db.sql(...)` call shape remains as a deprecation shim that warns once and routes through `adminDb()`.

#### Scenario: Agent picks the correct client for caller-scoped reads
- **WHEN** an agent reads SKILL.md to implement a function that returns the logged-in user's items
- **THEN** it finds a `db(req).from(...)` example and understands that RLS will scope the rows to the caller

#### Scenario: Agent picks the correct client for platform-authored writes
- **WHEN** an agent reads SKILL.md to implement an audit-log or cron cleanup function
- **THEN** it finds an `adminDb().from(...)` example and understands that BYPASSRLS is the explicit opt-in

### Requirement: SKILL.md documents adminDb().sql() with params and return type

The SKILL.md "DB access inside functions" section SHALL document:
- `adminDb().sql(query, params?)` signature with optional params (always BYPASSRLS — there is no caller-context SQL path)
- Return type: `{ status, schema, rows, rowCount }`
- SELECT behavior: `rows` = matching rows, `rowCount` = row count
- INSERT/UPDATE/DELETE behavior: `rows` = `[]`, `rowCount` = affected rows
- Parameterized example: `adminDb().sql('SELECT * FROM t WHERE id = $1', [42])`

#### Scenario: Agent reads SKILL.md for raw-SQL usage
- **WHEN** an agent reads SKILL.md to run parameterized SQL
- **THEN** it finds `adminDb().sql(query, params?)` documented with the return type shape

### Requirement: SKILL.md documents the shared fluent query surface

The SKILL.md section SHALL document the fluent query-builder methods that work identically on both `db(req).from(t)` and `adminDb().from(t)`:
- Chainable read methods: `.select(cols?)`, `.eq(col, val)`, `.neq()`, `.gt()`, `.lt()`, `.gte()`, `.lte()`, `.like()`, `.ilike()`, `.in(col, [vals])`, `.order(col, { ascending? })`, `.limit(n)`, `.offset(n)`
- Chainable write methods: `.insert(obj | obj[])`, `.update(obj)`, `.delete()` — all return array of affected rows
- Column narrowing: `.insert({...}).select('col1, col2')` returns only specified columns

#### Scenario: Agent reads SKILL.md for chainable API coverage
- **WHEN** an agent reads SKILL.md to build a filtered, ordered, paginated query
- **THEN** it finds the full chainable API applicable to either client (caller-context or admin)
