# functions-package

The `@run402/functions` npm package — the in-function helper library users import inside deployed Run402 serverless functions. Source lives at `functions/` in this repo. Published as `@run402/functions` on npm.

## Purpose

Provide a small, ergonomic, in-function API for the platform primitives a Run402 function most often needs: row-level-security-aware DB queries via `db(req)`, BYPASSRLS DB access via `adminDb()`, JWT-based caller identification via `getUser(req)`, sending email via `email.send()`, and AI helpers via `ai.translate()` / `ai.moderate()`.

Distinct from `@run402/sdk` (the typed API client used outside the platform). The two are complementary, not redundant — `@run402/functions` is the in-function shape with ambient request context; `@run402/sdk` is the full API surface for outside-the-platform callers.

## Requirements

### Requirement: Package exports db, adminDb, QueryBuilder, getUser, email, and ai
The `@run402/functions` npm package SHALL export the following named exports: `db`, `adminDb`, `QueryBuilder`, `getUser`, `email`, `ai`. These SHALL be importable via `import { db, adminDb, QueryBuilder, getUser, email, ai } from '@run402/functions'`. There SHALL NOT be a legacy `run402-functions` import path. There SHALL NOT be a legacy `db.from(...)` or `db.sql(...)` admin shim attached to `db` — those calls SHALL fail (TypeScript: missing property; runtime: TypeError) so callers are forced to choose between `db(req).from(...)` (RLS-context) and `adminDb().from(...)` / `adminDb().sql(...)` (BYPASSRLS).

#### Scenario: Import all exports
- **WHEN** a user writes `import { db, adminDb, QueryBuilder, getUser, email, ai } from '@run402/functions'`
- **THEN** all six exports SHALL be available and functional

#### Scenario: Import subset
- **WHEN** a user writes `import { db } from '@run402/functions'`
- **THEN** only `db` SHALL be imported with no side effects from unused exports

#### Scenario: Legacy admin shim removed
- **WHEN** a function calls `db.from("users")` (object-property access, not function call)
- **THEN** the call SHALL fail with a TypeScript error at type-check time and a TypeError at runtime; there SHALL NOT be a silent BYPASSRLS fallback
- **AND** the only ways to query are `db(req).from(...)` (with RLS based on the caller's JWT) or `adminDb().from(...)` (explicit BYPASSRLS via service_key)

### Requirement: Package provides TypeScript type definitions
The package SHALL ship `.d.ts` type declaration files alongside compiled JavaScript. Users in TypeScript-aware editors SHALL get autocomplete, hover documentation, and type checking for all exports.

#### Scenario: QueryBuilder autocomplete
- **WHEN** a user types `db(req).from("users").` in a TypeScript-aware editor
- **THEN** the editor SHALL suggest `select`, `eq`, `neq`, `gt`, `lt`, `gte`, `lte`, `like`, `ilike`, `in`, `order`, `limit`, `offset`, `insert`, `update`, `delete`

#### Scenario: getUser return type
- **WHEN** a user hovers over `getUser(req)` in a TypeScript-aware editor
- **THEN** the editor SHALL show the return type as `{ id: string, role: string, email: string } | null`

#### Scenario: email.send parameter type
- **WHEN** a user types `email.send({` in a TypeScript-aware editor
- **THEN** the editor SHALL suggest `to`, `subject`, `html`, `text`, `template`, `variables`, `from_name`

#### Scenario: ai.translate parameter type
- **WHEN** a user types `ai.translate(` in a TypeScript-aware editor
- **THEN** the editor SHALL show parameters as `(text: string, to: string, opts?: { from?: string, context?: string })`

### Requirement: Package is ESM-only
The package SHALL use `"type": "module"` in package.json and output ESM (import/export). It SHALL NOT provide a CommonJS build.

#### Scenario: ESM import
- **WHEN** a user's project uses `"type": "module"` and imports `@run402/functions`
- **THEN** the import SHALL resolve successfully

#### Scenario: CommonJS require
- **WHEN** a user's project attempts `require('@run402/functions')`
- **THEN** it SHALL fail with a standard ESM-only error (not a Run402-specific error)

### Requirement: Configuration via environment variables
The package SHALL read configuration from environment variables at call time (lazy getters, not at import time): `RUN402_API_BASE` (default: `https://api.run402.com`), `RUN402_PROJECT_ID`, `RUN402_SERVICE_KEY`, `RUN402_ANON_KEY`, `RUN402_JWT_SECRET`. No explicit initialization call SHALL be required.

#### Scenario: Default API base
- **WHEN** `RUN402_API_BASE` is not set
- **THEN** the package SHALL use `https://api.run402.com` as the API base URL

#### Scenario: All variables set
- **WHEN** all five environment variables are set
- **THEN** all exports SHALL function correctly using those values

#### Scenario: Lazy env-var read
- **WHEN** a test sets `process.env.RUN402_PROJECT_ID = "prj_b"` after the module was imported
- **THEN** subsequent calls into the package SHALL use the new value (not a value frozen at import time)

### Requirement: db(req).from() returns a thenable QueryBuilder
The `db(req).from(table)` call SHALL return a `QueryBuilder` instance that implements the `then` method (thenable). This allows direct `await db(req).from("users").select()` without an explicit `.execute()` call. Calls go through the project's `/rest/v1/*` endpoint and use the caller's auth from `req` so RLS policies apply with the calling user's identity.

#### Scenario: Awaitable query
- **WHEN** a user writes `const rows = await db(req).from("users").select()`
- **THEN** the query SHALL execute via fetch with the caller's bearer token from `req` and resolve to the result array

#### Scenario: Chained filters
- **WHEN** a user writes `await db(req).from("users").select("id, name").eq("role", "admin").order("name").limit(10)`
- **THEN** the fetch SHALL be called with query parameters `select=id%2C+name&role=eq.admin&order=name.asc&limit=10`

### Requirement: adminDb() bypasses RLS using service_key
The `adminDb()` call SHALL return a query builder factory that uses the project's `RUN402_SERVICE_KEY` env var as the bearer token and routes requests through `/admin/v1/rest/*`. Use only when the function acts on behalf of the platform, not the caller.

#### Scenario: Admin query
- **WHEN** a function calls `await adminDb().from("audit_log").insert({ event: "x" })`
- **THEN** the request SHALL be sent to `/admin/v1/rest/audit_log` with `Authorization: Bearer ${RUN402_SERVICE_KEY}` headers

#### Scenario: adminDb without service_key env var
- **WHEN** a function calls `adminDb()` without `RUN402_SERVICE_KEY` set
- **THEN** the call SHALL throw with a clear error: `adminDb() requires RUN402_SERVICE_KEY in the Lambda environment.`

### Requirement: adminDb().sql() executes raw SQL via gateway
The `adminDb().sql(query, params?)` call SHALL POST to `{API_BASE}/projects/v1/admin/{PROJECT_ID}/sql` with the query and optional parameters. Auth uses the function's service_key.

#### Scenario: SQL with parameters
- **WHEN** a user writes `await adminDb().sql("SELECT * FROM users WHERE id = $1", ["abc"])`
- **THEN** the package SHALL POST JSON `{ sql: "SELECT * FROM users WHERE id = $1", params: ["abc"] }` with Content-Type `application/json`

#### Scenario: SQL without parameters
- **WHEN** a user writes `await adminDb().sql("SELECT count(*) FROM users")`
- **THEN** the package SHALL POST the query as plain text with Content-Type `text/plain`

### Requirement: Package declares Node.js engine requirement
The package.json SHALL include `"engines": { "node": ">=18" }` to indicate Node.js is required (due to the `jsonwebtoken` dependency).

#### Scenario: Engine check
- **WHEN** a user runs `npm install @run402/functions` on Node.js 18+
- **THEN** installation SHALL succeed without engine warnings

### Requirement: Package is published as @run402/functions on npm
The package SHALL be published to the npm registry under the `@run402` scope with public access. The package name SHALL be `@run402/functions`. The `package.json` SHALL include `"publishConfig": { "access": "public" }` so the first scoped publish defaults to public access without a CLI flag. The previous flat name `run402-functions` SHALL be `npm deprecate`d after the first `@run402/functions` release with a message pointing at the new name; no further `run402-functions` versions SHALL be published.

#### Scenario: npm install
- **WHEN** a user runs `npm install @run402/functions`
- **THEN** the package SHALL install successfully from the npm registry

#### Scenario: First publish uses public access by default
- **WHEN** the `/publish` skill runs `npm publish` from the `functions/` directory
- **THEN** the publish SHALL succeed without an explicit `--access public` flag, because `publishConfig.access` is set in `package.json`

#### Scenario: Legacy name install warning
- **WHEN** a user runs `npm install run402-functions`
- **THEN** npm SHALL print the deprecation warning pointing at `@run402/functions`, and SHALL still install the last published `run402-functions@1.x` version (npm cannot un-publish; deprecation is the user-facing signal)

### Requirement: Package version is coordinated with sibling packages
The `@run402/functions` package version SHALL match `run402-mcp`, `run402` (CLI), and `@run402/sdk` whenever a release bumps all four. The `/publish` skill SHALL default to bumping all four together (lockstep) but SHALL also support bumping a subset (e.g., `functions` only) when a release fixes only one package.

#### Scenario: Lockstep release
- **WHEN** the `/publish` skill is invoked with default selection
- **THEN** all four packages (`run402-mcp`, `run402`, `@run402/sdk`, `@run402/functions`) SHALL be published at the same version

#### Scenario: Single-package release
- **WHEN** the `/publish` skill is invoked with `functions` selected only
- **THEN** only `@run402/functions` SHALL be republished; the other three SHALL retain their current version

### Requirement: Local dev resolves helper from workspace
The gateway's local function execution mode SHALL resolve `@run402/functions` from the gateway's `node_modules` (registry install in CI/prod; npm-link or similar workspace shortcut in dev).

#### Scenario: Local function import
- **WHEN** a function is executed in local dev mode (no `LAMBDA_ROLE_ARN`)
- **AND** the function code contains `import { db } from '@run402/functions'`
- **THEN** the import SHALL resolve to the gateway's installed `@run402/functions` package

### Requirement: getUser uses static jsonwebtoken import (esbuild-bundle-safe)
The `auth.ts` source SHALL use `import jwt from "jsonwebtoken"` (static ES import). It SHALL NOT use `createRequire(import.meta.url)("jsonwebtoken")` or any other dynamic resolution mechanism that prevents a static bundler (esbuild) from following the dependency.

#### Scenario: Bundle includes jsonwebtoken
- **WHEN** a downstream consumer (e.g. the gateway's deploy bundler in the companion private change) runs esbuild against code that imports `getUser` from `@run402/functions`
- **THEN** the resulting bundle SHALL contain the inlined `jsonwebtoken` source; the bundle SHALL NOT contain a runtime `require("jsonwebtoken")` against an absent `node_modules`

#### Scenario: getUser works from installed tarball
- **WHEN** the published tarball is extracted, installed via `npm install`, and a script imports `getUser` and calls it on a request with a valid JWT signed with the matching `RUN402_JWT_SECRET`
- **THEN** `getUser` SHALL return the decoded `{id, role, email}` user object (no `Cannot find module 'jsonwebtoken'` error)

### Requirement: FunctionRecord includes runtime_version and deps_resolved fields
The `FunctionRecord` type returned by `list_functions` (MCP), `get_function` (MCP), the SDK's `functions.list()` / `functions.get()`, and the CLI's `functions list --json` / `functions get --json` SHALL include two optional, nullable fields:
- `runtime_version: string | null` — the version of `@run402/functions` bundled into the function (set by the companion private change at deploy time; null until that change ships, and null for any function deployed before that change)
- `deps_resolved: Record<string, string> | null` — a map of direct user dep names to their resolved installed versions (set by the companion private change at deploy time; null otherwise)

These fields SHALL be additive — no existing field is removed or renamed. Consumers who don't read them are unaffected.

#### Scenario: Field present and null in this change
- **WHEN** a consumer calls `list_functions` after this change is deployed but before the companion private change
- **THEN** every function record's `runtime_version` and `deps_resolved` SHALL be `null`

#### Scenario: Field present and populated after companion change
- **WHEN** the companion private change is deployed and a function is freshly deployed under the new bundling regime
- **THEN** `runtime_version` SHALL be a string (e.g. `"1.46.0"`) and `deps_resolved` SHALL be a `{name: version}` map (or `{}` for an empty-deps deploy)

#### Scenario: MCP markdown formatter
- **WHEN** the MCP `list_functions` or `get_function` formatter renders a record with non-null `runtime_version`
- **THEN** the rendered text SHALL include a line like `Runtime: @run402/functions@1.46.0` and, if `deps_resolved` is non-empty, a section listing each resolved dep
- **AND** WHEN `runtime_version` is null, the formatter SHALL omit those lines entirely (no "Runtime: null" placeholder)
