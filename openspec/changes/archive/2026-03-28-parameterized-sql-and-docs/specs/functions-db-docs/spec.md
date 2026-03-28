## ADDED Requirements

### Requirement: SKILL.md documents db.sql with params and return type
The SKILL.md "DB access inside functions" section SHALL document:
- `db.sql(query, params?)` signature with optional params
- Return type: `{ status, schema, rows, rowCount }`
- SELECT behavior: `rows` = matching rows, `rowCount` = row count
- INSERT/UPDATE/DELETE behavior: `rows` = `[]`, `rowCount` = affected rows
- Parameterized example: `db.sql('SELECT * FROM t WHERE id = $1', [42])`

#### Scenario: Agent reads SKILL.md for db.sql usage
- **WHEN** an agent reads the SKILL.md functions section
- **THEN** it finds documentation for parameterized queries with `db.sql(query, params?)` and understands the return type shape

### Requirement: SKILL.md documents db.from chainable API
The SKILL.md "DB access inside functions" section SHALL document:
- `db.from(table)` returns a PostgREST-style query builder (service_role, bypasses RLS) that returns a plain array of row objects
- Chainable read methods: `.select(cols?)`, `.eq(col, val)`, `.neq()`, `.gt()`, `.lt()`, `.gte()`, `.lte()`, `.like()`, `.ilike()`, `.in(col, [vals])`, `.order(col, { ascending? })`, `.limit(n)`, `.offset(n)`
- Chainable write methods: `.insert(obj | obj[])`, `.update(obj)`, `.delete()` — all return array of affected rows
- Column narrowing: `.insert({...}).select('col1, col2')` returns only specified columns

#### Scenario: Agent reads SKILL.md for db.from usage
- **WHEN** an agent reads the SKILL.md functions section
- **THEN** it finds the full chainable API for `db.from()` including read methods, write methods, and column narrowing
