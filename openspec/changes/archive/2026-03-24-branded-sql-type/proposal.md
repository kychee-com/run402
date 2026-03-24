## Why

We shipped invalid SQL (`COALESCE()` inside a PRIMARY KEY) to production because TypeScript treats SQL as opaque strings — `tsc` can't catch syntax errors, and our unit tests only tested application logic, not the SQL itself. The bug crashed the gateway on startup in production. We need every SQL string in the codebase to be identifiable and validatable at test time, without requiring a running database.

## What Changes

- Introduce a **branded `SQL` type** — a string subtype that marks a value as "intended to be SQL". Raw strings cannot be passed where `SQL` is expected.
- Introduce a **`sql()` helper function** — wraps a string as `SQL`. All SQL in the codebase must go through this function.
- **Wrap `pool.query()` and `client.query()`** to accept only `SQL` (or the helper) as the query parameter. Passing a raw string is a type error.
- **Refactor all ~421 `pool.query()` and `client.query()` calls** across 34 files to use `sql()`.
- Add **`libpg-query`** dependency — the PostgreSQL parser compiled to WASM, validates SQL syntax without a database.
- Add a **pre-flight SQL validation test** that extracts every `sql()` call in the codebase and runs it through `libpg-query`. Syntax errors fail the test before deploy.
- Add the validation test to the **deploy pre-flight checks**.

## Capabilities

### New Capabilities
- `sql-branded-type`: Branded SQL type, `sql()` helper, typed pool wrapper, and pre-flight syntax validation test

### Modified Capabilities

_(none — this is a pure internal refactor with no behavior or API changes)_

## Impact

- **34 gateway source files** — every `pool.query()` / `client.query()` call gets wrapped with `sql()`
- **New dependency**: `libpg-query` (devDependency, WASM-based PostgreSQL parser)
- **New file**: `packages/gateway/src/db/sql.ts` (branded type + helper)
- **Modified file**: `packages/gateway/src/db/pool.ts` (typed wrapper)
- **New test**: SQL syntax validation (pre-flight)
- **No API changes, no behavior changes, no downstream impact**
