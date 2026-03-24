## Context

The gateway uses `pg` (node-postgres) for all database access. SQL queries are plain strings passed to `pool.query(string)` and `client.query(string)`. TypeScript sees these as `string` — no syntax validation, no way to distinguish SQL from any other string. We have ~421 `pool.query()` and ~155 `client.query()` calls across 34 files.

The current `pool.ts` exports a raw `pg.Pool`. Services and routes import it directly.

## Goals / Non-Goals

**Goals:**
- Every SQL string in the codebase is wrapped with `sql()` and typed as `SQL`
- Passing a raw string to `pool.query()` or `client.query()` is a compile-time type error
- A test validates all `sql()` strings against the PostgreSQL parser at pre-flight time
- Zero runtime overhead — `sql()` is a cast, not a transform

**Non-Goals:**
- Query parameterization or prepared statements (already handled by `pg`)
- Runtime SQL validation (too expensive, parser is for test time only)
- Changing the `pg` library or query patterns
- Validating SQL semantics (table existence, column types) — only syntax

## Decisions

### 1. Branded type via intersection

```ts
type SQL = string & { readonly __brand: unique symbol };
export function sql(query: string): SQL {
  return query as SQL;
}
```

**Why:** Zero runtime cost — `sql()` compiles to a no-op. The brand is erased at runtime. TypeScript enforces the type boundary at compile time. This is the standard TypeScript pattern for nominal/branded types.

**Alternative considered:** Template literal tag (`sql\`...\``) — rejected because it would require changing every backtick-quoted SQL to a tagged template, and the `pg` library's parameterized queries use `$1, $2` syntax which doesn't play well with template literal interpolation.

### 2. Typed pool wrapper, not class extension

Rather than subclassing `pg.Pool`, export a thin wrapper object that narrows the `query` signature to accept `SQL` instead of `string`. The pool itself remains a standard `pg.Pool` — we just control the export type.

```ts
// pool.ts exports a typed wrapper
export const pool: TypedPool = rawPool as unknown as TypedPool;
```

For `client.query()` (used in transactions via `pool.connect()`), the `connect()` return type is also narrowed.

**Why:** Minimal change. No new classes, no monkey-patching. Just type narrowing at the export boundary.

**Alternative considered:** Wrapping every `pool.connect()` call — rejected as too invasive. Instead, we create a `TypedPoolClient` interface and cast the result of `connect()`.

### 3. `libpg-query` for test-time validation

The `libpg-query` npm package wraps the actual PostgreSQL parser (compiled to WASM). It parses SQL and returns an AST or throws on syntax errors. No running database needed.

The test:
1. Reads all `.ts` files in `packages/gateway/src/`
2. Extracts every `sql(...)` or `sql(\`...\`)` call using a regex
3. Replaces `$1, $2, ...` parameter placeholders with dummy values
4. Passes each through `libpg-query.parse()`
5. Reports any syntax errors with file/line info

**Why:** Catches exactly the class of bug that caused the production crash. Runs in <1s. No database, no Docker, no setup.

### 4. Refactor strategy: mechanical find-and-replace

The refactor is ~421 + 155 = ~576 calls. The change is mechanical:
- `pool.query(\`...\`)` → `pool.query(sql(\`...\`))`
- `client.query(\`...\`)` → `client.query(sql(\`...\`))`
- Add `import { sql } from "../db/sql.js"` to each file

The typed pool makes this self-enforcing: if you miss one, `tsc` will error.

## Risks / Trade-offs

**[Large diff]** → ~34 files touched with mechanical wrapping. Mitigation: the change is uniform and reviewable by pattern. `tsc` enforces completeness — any missed call is a compile error.

**[libpg-query size]** → WASM binary adds ~2MB to devDependencies. Mitigation: devDependency only, not in the Docker image.

**[Parameter placeholders]** → SQL with `$1, $2` isn't valid standalone SQL. Mitigation: the test replaces `$N` with `NULL` before parsing, which is syntactically valid in all positions.

**[Dynamic SQL]** → A few places build SQL dynamically (e.g., `DROP SCHEMA IF EXISTS ${slot}`). These can't be statically extracted. Mitigation: use `sql()` on the final composed string; the test skips strings with template interpolation and logs a warning.
