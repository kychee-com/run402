## ADDED Requirements

### Requirement: Package exports db, getUser, email, and ai
The `@run402/functions` npm package SHALL export the following named exports: `db`, `getUser`, `email`, `ai`. These SHALL be importable via `import { db, getUser, email, ai } from '@run402/functions'`.

#### Scenario: Import all exports
- **WHEN** a user writes `import { db, getUser, email, ai } from '@run402/functions'`
- **THEN** all four exports SHALL be available and functional

#### Scenario: Import subset
- **WHEN** a user writes `import { db } from '@run402/functions'`
- **THEN** only `db` SHALL be imported with no side effects from unused exports

### Requirement: Package provides TypeScript type definitions
The package SHALL ship `.d.ts` type declaration files alongside compiled JavaScript. Users in TypeScript-aware editors SHALL get autocomplete, hover documentation, and type checking for all exports.

#### Scenario: QueryBuilder autocomplete
- **WHEN** a user types `db.from("users").` in a TypeScript-aware editor
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
The package SHALL read configuration from environment variables at import time: `RUN402_API_BASE` (default: `https://api.run402.com`), `RUN402_PROJECT_ID`, `RUN402_SERVICE_KEY`, `RUN402_JWT_SECRET`. No explicit initialization call SHALL be required.

#### Scenario: Default API base
- **WHEN** `RUN402_API_BASE` is not set
- **THEN** the package SHALL use `https://api.run402.com` as the API base URL

#### Scenario: All variables set
- **WHEN** all four environment variables are set
- **THEN** all exports (`db`, `getUser`, `email`, `ai`) SHALL function correctly using those values

### Requirement: db.from() returns a thenable QueryBuilder
The `db.from(table)` call SHALL return a `QueryBuilder` instance that implements the `then` method (thenable). This allows direct `await db.from("users").select()` without an explicit `.execute()` call.

#### Scenario: Awaitable query
- **WHEN** a user writes `const rows = await db.from("users").select()`
- **THEN** the query SHALL execute via fetch and resolve to the result array

#### Scenario: Chained filters
- **WHEN** a user writes `await db.from("users").select("id, name").eq("role", "admin").order("name").limit(10)`
- **THEN** the fetch SHALL be called with query parameters `select=id%2C+name&role=eq.admin&order=name.asc&limit=10`

### Requirement: db.sql() executes raw SQL via gateway
The `db.sql(query, params?)` call SHALL POST to `{API_BASE}/projects/v1/admin/{PROJECT_ID}/sql` with the query and optional parameters.

#### Scenario: SQL with parameters
- **WHEN** a user writes `await db.sql("SELECT * FROM users WHERE id = $1", ["abc"])`
- **THEN** the package SHALL POST JSON `{ sql: "SELECT * FROM users WHERE id = $1", params: ["abc"] }` with Content-Type `application/json`

#### Scenario: SQL without parameters
- **WHEN** a user writes `await db.sql("SELECT count(*) FROM users")`
- **THEN** the package SHALL POST the query as plain text with Content-Type `text/plain`

### Requirement: Package declares Node.js engine requirement
The package.json SHALL include `"engines": { "node": ">=18" }` to indicate Node.js is required (due to `jsonwebtoken` dependency).

#### Scenario: Engine check
- **WHEN** a user runs `npm install @run402/functions` on Node.js 18+
- **THEN** installation SHALL succeed without engine warnings

### Requirement: Package is published as @run402/functions on npm
The package SHALL be published to the npm registry under the `@run402` scope with public access. The package name SHALL be `@run402/functions`.

#### Scenario: npm install
- **WHEN** a user runs `npm install @run402/functions`
- **THEN** the package SHALL install successfully from the npm registry

### Requirement: Lambda layer installs package instead of inlining
The `build-layer.sh` script SHALL install `@run402/functions` via npm instead of writing the helper code as a heredoc. The layer's `package.json` SHALL pin the package version.

#### Scenario: Layer build
- **WHEN** `build-layer.sh` runs
- **THEN** the built layer SHALL contain `node_modules/@run402/functions/` installed from npm (or workspace link)

#### Scenario: Layer includes convenience deps
- **WHEN** `build-layer.sh` runs
- **THEN** the layer SHALL continue to include convenience dependencies (stripe, openai, etc.) alongside `@run402/functions`

### Requirement: Local dev resolves helper from workspace
The gateway's local function execution SHALL resolve `@run402/functions` from the monorepo workspace instead of inlining helper code into each `.mjs` file.

#### Scenario: Local function import
- **WHEN** a function is executed in local dev mode (no `LAMBDA_ROLE_ARN`)
- **AND** the function code contains `import { db } from '@run402/functions'`
- **THEN** the import SHALL resolve to the `packages/functions/` workspace package

#### Scenario: Inline helper removed
- **WHEN** the gateway writes a local function `.mjs` file
- **THEN** the file SHALL NOT contain inlined helper code — only the user's original function code (with import statements preserved)
