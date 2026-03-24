## ADDED Requirements

### Requirement: SQL strings use a branded type
All SQL query strings passed to `pool.query()` or `client.query()` SHALL use the `SQL` branded type. Passing a raw `string` SHALL be a TypeScript compile error.

#### Scenario: Raw string rejected at compile time
- **WHEN** a developer writes `pool.query("SELECT 1")`
- **THEN** TypeScript SHALL emit a type error because `string` is not assignable to `SQL`

#### Scenario: Wrapped string accepted
- **WHEN** a developer writes `pool.query(sql("SELECT 1"))`
- **THEN** TypeScript SHALL accept the call and the query SHALL execute normally

### Requirement: sql() helper has zero runtime overhead
The `sql()` function SHALL be a pure type cast with no runtime transformation. The returned value SHALL be identical to the input string at runtime.

#### Scenario: Runtime identity
- **WHEN** `sql("SELECT 1")` is called
- **THEN** the returned value SHALL be strictly equal (`===`) to the input string `"SELECT 1"` at runtime

### Requirement: Typed pool wrapper narrows query signature
The exported `pool` object SHALL accept `SQL` as the query parameter. The `pool.connect()` method SHALL return a client whose `query()` also accepts `SQL`.

#### Scenario: Pool query with SQL type
- **WHEN** `pool.query(sql("SELECT 1"))` is called
- **THEN** the query SHALL execute and return a `pg.QueryResult`

#### Scenario: Pool client query with SQL type
- **WHEN** `const client = await pool.connect(); client.query(sql("BEGIN"))`
- **THEN** the query SHALL execute normally

### Requirement: Pre-flight test validates all SQL syntax
A test SHALL extract every `sql()` call from the gateway source code and validate it against the PostgreSQL parser (`libpg-query`). Any SQL syntax error SHALL fail the test.

#### Scenario: Valid SQL passes
- **WHEN** all `sql()` calls in the codebase contain syntactically valid PostgreSQL
- **THEN** the test SHALL pass

#### Scenario: Invalid SQL fails
- **WHEN** a `sql()` call contains `CREATE TABLE foo (id TEXT, COALESCE(x, ''))`
- **THEN** the test SHALL fail with the file path, line number, and PostgreSQL parser error message

#### Scenario: Parameterized queries handled
- **WHEN** a `sql()` call contains `SELECT * FROM t WHERE id = $1`
- **THEN** the test SHALL replace `$1` with `NULL` and validate the resulting SQL

### Requirement: All existing pool.query calls use sql()
Every `pool.query()` and `client.query()` call in the gateway codebase SHALL wrap its SQL string with `sql()`. No raw string queries SHALL remain.

#### Scenario: TypeScript compilation succeeds
- **WHEN** `npx tsc --noEmit -p packages/gateway` is run after the refactor
- **THEN** compilation SHALL succeed with zero errors

#### Scenario: No raw string queries remain
- **WHEN** the codebase is searched for `pool.query(` or `client.query(` calls not using `sql()`
- **THEN** zero matches SHALL be found (excluding test mocks and the pool wrapper itself)
