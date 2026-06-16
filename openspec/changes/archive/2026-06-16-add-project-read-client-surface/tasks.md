## 1. SDK — types

- [x] 1.1 In `sdk/src/namespaces/projects.types.ts`, add `ProjectLastDeploy = { release_id: string; activated_at: string }`, `ProjectUsageWithLimits = { api_calls: number; storage_bytes: number; api_calls_limit: number; storage_bytes_limit: number }`, and `ProjectDetail` with the 13 faithful snake_case fields (`site_url: string | null`, `last_deploy: ProjectLastDeploy | null`, `custom_domains: string[]`, `mailbox: string[]`, `usage: ProjectUsageWithLimits`), with an open container (`[key: string]: unknown`) for forward-compat. Field names verified against gateway `3e60da4b` (`api_calls_limit`/`storage_bytes_limit`).
- [x] 1.2 Export `ProjectDetail` (+ the two sub-types) from the SDK public type-surface entry so `sdk-public-type-surface` stays complete. — No edit needed: `index.ts:413` already does `export type * from "./namespaces/projects.types.js"` (wildcard); `public-type-exports.test.ts` covers the new types automatically.

## 2. SDK — `get` method + scoped wrapper

- [x] 2.1 Add `async get(id: string): Promise<ProjectDetail>` to `sdk/src/namespaces/projects.ts`: `this.client.request<ProjectDetail>(\`/projects/v1/${id}\`, { context: "getting project" })` (withAuth defaults true). Does NOT call `getProject(id)` — works without the project in the keystore.
- [x] 2.2 Verified: kernel maps generic `403`→`Unauthorized` and `403`+`NOT_AUTHORIZED`→`NotAuthorizedError` (sibling of `Unauthorized`); `ProjectNotFound` is only thrown from local keystore misses, never an HTTP status. No kernel change needed. (Note: real authz denials carry `NOT_AUTHORIZED` → `NotAuthorizedError`; the unit test asserts both 403 variants are non-`ProjectNotFound`.)
- [x] 2.3 Added the `get()` wrapper to `ScopedRun402` in `sdk/src/scoped.ts` (`return this.parent.projects.get(this.projectId)`), beside `info()`; imported `ProjectDetail`.

## 3. MCP — `project_get` tool

- [x] 3.1 Added `src/tools/project-get.ts`: Zod schema `{ project_id }`, handler calls `getSdk().projects.get(project_id)` and renders the detail as a markdown table (status, lifecycle, org, tier, `last_deploy`, `mailbox`, usage-vs-limits, domains); errors via `mapSdkError(err, "getting project")`.
- [x] 3.2 Registered `project_get` in `src/index.ts` (import + `server.tool` next to `project_info`, description clarifies live server read / no keys).

## 4. CLI — `projects get` subcommand

- [x] 4.1 Added `async function get(projectId)` to `cli/lib/projects.mjs` calling `getSdk().projects.get(projectId)` and printing the `ProjectDetail` as JSON; `reportSdkError(err)` on failure.
- [x] 4.2 Wired the `get` case into the `projects` dispatcher (`resolvePositionalProject(args, { rejectBareFirst: true })`, like `info`/`keys`; no `FLAGS_BY_SUB` entry needed); added the help-list line + example, and clarified `info`/`keys` as local-keystore-only.

## 5. Docs

- [x] 5.1 In `cli/llms-cli.txt`, documented `run402 projects get <id>` + the `ProjectDetail` fields + the get-vs-info/keys split (live server vs local cache).
- [x] 5.2 In `sdk/llms-sdk.txt`, documented `r.projects.get(id)` / `r.project(id).get()` + the `ProjectDetail` shape + the no-secrets/authorize-before-reveal contract.

## 6. Sync + tests

- [x] 6.1 In `sync.test.ts`, added the `SURFACE` row `{ id: "project_get", endpoint: "GET /projects/v1/:project_id", mcp: "project_get", cli: "projects:get", openclaw: "projects:get" }` and the `SDK_BY_CAPABILITY` entry `project_get: "projects.get"`. Sync test green (CLI/OpenClaw parity + orphan check).
- [x] 6.2 Added the SDK unit suite in `sdk/src/namespaces/projects.test.ts`: asserts `get` issues `GET /projects/v1/:id`, parses every `ProjectDetail` field, preserves explicit `null`s, works for a keystore-absent project, carries no key fields, maps generic `403`→`Unauthorized` and `403`+`NOT_AUTHORIZED`→`NotAuthorizedError` (never `ProjectNotFound`), and exercises the scoped path `(await r.project(id)).projects.get()`. 45/45 pass.
- [x] 6.3 Confirmed the `scoped.test.ts` drift guard passes with the new `get()` wrapper on `ScopedProjects`.
- [x] 6.4 Extended the already-wired `cli-e2e.test.mjs` (mock gateway) with a `GET /projects/v1/:id` handler + a happy-path `projects get` test asserting JSON-out and no leaked keys (257/257 pass). No new file → no `package.json` allow-list change. Help snapshots (`test:help`) pass unchanged (239/239).
- [x] 6.5 `npm test` green — 675/675 unit+e2e pass, 0 fail; docs-snippet check compiled 43 TS snippets cleanly. `npm run build` (full `tsc` typecheck of core+sdk+mcp) clean.
