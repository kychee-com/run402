# AGENTS.md

This file is the single source of truth for AI coding agents working in this repository (Claude Code, Codex, Cursor, Cline, OpenClaw, etc.). `CLAUDE.md` imports it via `@AGENTS.md`.

> **Updating docs?** See [`documentation.md`](documentation.md) — the map of every doc surface (public + private repo), with target audience, content summary, and update triggers. **Scan it before merging code changes.**

## What This Is

run402 is a developer platform that ships Postgres databases, content-addressed CDN storage, static site hosting, Node 22 serverless functions, email, image generation, and KMS-backed Ethereum signing — provisioned by AI agents and paid for autonomously via x402 USDC on Base, MPP pathUSD on Tempo, or Stripe credits. Prototype tier is free on testnet.

This monorepo ships **five interfaces**:

- **SDK** (`sdk/`) — typed TypeScript client for the run402 API. Used by external integrators, MCP/CLI/OpenClaw, and (eventually) inside deployed functions. Published as `@run402/sdk` on npm. Two entry points: root (isomorphic — works in Node 22, Deno, Bun, V8 isolates) and `/node` (zero-config Node defaults — keystore + allowance + x402).
- **MCP server** (root `src/`) — published as `run402-mcp` on npm. Each tool is a thin shim over an SDK call. Read by Claude Desktop / Cursor / Cline / Claude Code.
- **CLI** (`cli/`) — standalone CLI published as `run402` on npm. Each subcommand is a thin shim over an SDK call; argv parsing and JSON output stay at the CLI edge.
- **Functions library** (`functions/`) — in-function helper imported _inside_ deployed serverless functions. Exposes `db(req)`, `adminDb()`, `getUser()`, `email`, `ai`. Published as `@run402/functions` on npm. Distinct from the SDK: this is the request-scoped, in-function shape; the SDK is the typed external client. The two are complementary, not redundant.
- **OpenClaw skill** (`openclaw/`) — script-based skill for OpenClaw agents, re-exports from CLI modules.

Workspace layout: `package.json` declares `cli`, `sdk`, and `functions` as npm workspaces. `core/` is shared internal code, not an npm package.

The first four packages release in lockstep via the `/publish` skill at the same version (the skill also supports per-package selection for off-cycle patches). MCP, CLI, OpenClaw, and the Node SDK all share the request kernel via `@run402/sdk`. `@run402/functions` is the exception — it makes raw `fetch()` calls against the project's own endpoints using ambient request context. `core/` holds filesystem primitives (keystore, allowance, SIWE signing) that the Node SDK provider wraps.

## Build & Test Commands

```bash
npm run build:core         # tsc -p core/tsconfig.json → core/dist/
npm run build:sdk          # tsc -p sdk/tsconfig.json  → sdk/dist/
npm run build:functions    # tsc -p functions/tsconfig.json → functions/dist/
npm run build              # build:core + build:sdk + build:functions + tsc → dist/ (also stages dist copies under cli/)
npm run start              # node dist/index.js (stdio MCP transport)

npm run test:skill         # validates SKILL.md and openclaw/SKILL.md (49 tests across both)
npm run test:sync          # checks MCP/CLI/OpenClaw/SDK stay in sync
npm test                   # SKILL + sync + unit (core/src + sdk/src + src) + CLI e2e
npm run test:e2e           # node --test cli-e2e.test.mjs cli-help.test.mjs cli-provision-active.test.mjs cli-argv.test.mjs cli-env.test.mjs
npm run test:help          # CLI help-text snapshots only
npm run test:integration         # SIWX integration (core/src/siwx-integration.integ.ts)
npm run test:integration:full    # full CLI integration (cli-integration.test.ts)
npm run test:integration:mcp     # MCP integration (mcp-integration.test.ts)
```

Unit tests use Node's built-in `node:test` runner with `tsx` for TypeScript:

```bash
# Run all unit tests
node --test --import tsx core/src/**/*.test.ts sdk/src/**/*.test.ts src/**/*.test.ts

# Run a single test file
node --test --import tsx src/tools/run-sql.test.ts
node --test --import tsx core/src/keystore.test.ts
```

Tests are excluded from the build (`tsconfig.json`, `core/tsconfig.json`, and friends all exclude `**/*.test.ts`).

### Sync Test (`sync.test.ts`)

`sync.test.ts` defines the canonical API surface in a `SURFACE` array and checks:
- MCP tools in `src/index.ts` match the expected set (no missing, no extra)
- CLI commands in `cli/lib/*.mjs` match the expected set
- OpenClaw commands in `openclaw/scripts/*.mjs` match the expected set (follows re-exports to CLI)
- CLI and OpenClaw have identical command sets (parity)
- Every SURFACE capability maps to an SDK method (or explicit `null` in `SDK_BY_CAPABILITY`); every SDK method is referenced by SURFACE (orphan check)
- If `~/Developer/run402-private/site/llms.txt` exists: MCP Tools table lists all tools, all endpoints documented

When adding a new tool/command, add it to the `SURFACE` array **and** `SDK_BY_CAPABILITY` in `sync.test.ts`.

## Architecture

```
@run402/sdk  (typed TypeScript kernel — 20 namespaces, ~100 methods)
   │
   │   /index.ts    (isomorphic: Node + sandbox)
   │   /node        (Node-only: keystore + allowance + x402-wrapped fetch + fileSetFromDir)
   │
   ├─── MCP tools  (src/tools/*.ts)  — thin shim → SDK → markdown format
   ├─── CLI        (cli/lib/*.mjs)   — thin shim → SDK → JSON output + exit code
   └─── OpenClaw   (openclaw/scripts/*.mjs) — re-exports from CLI

core/      ← Node-only primitives (keystore, allowance, SIWE signing, config paths)
              Imported by sdk/src/node via ../../../core/dist/; not an npm package.

functions/ ← @run402/functions in-function helper (db, adminDb, getUser, email, ai).
              Auto-bundled into deployed function zips at deploy time;
              also installable for local TypeScript autocomplete.
```

The SDK is the canonical kernel — a single typed client with a `CredentialsProvider` interface for credential access and a pluggable `fetch` (for x402 wrapping in Node, session tokens in sandboxes). MCP handlers and CLI commands are thin shims: argv/schema parsing + SDK call + output formatting. When code-mode MCP ships, the same SDK runs inside a V8 isolate.

### SDK (`sdk/src/`)

- **`index.ts`** — `Run402` class + `run402()` factory + `files()` helper. Isomorphic entry point.
- **`kernel.ts`** — Request function, `Client` interface. Only place that calls `globalThis.fetch`.
- **`errors.ts`** — `Run402Error` hierarchy: `PaymentRequired`, `ProjectNotFound`, `Unauthorized`, `ApiError`, `NetworkError`, `Run402DeployError` (the v1.34+ structured envelope from the deploy state machine). Never calls `process.exit`.
- **`credentials.ts`** — `CredentialsProvider` interface. Required: `getAuth`, `getProject`. Optional: `saveProject`, `updateProject`, `removeProject`, `setActiveProject`, `getActiveProject`, `readAllowance`, `saveAllowance`, `createAllowance`, `getAllowancePath`.
- **`namespaces/*.ts`** — One class per resource group (projects, blobs, functions, email, CI/OIDC, …). Namespaces hold a `Client` and expose typed methods. The canonical deploy primitive lives at **`namespaces/deploy.ts`** (with shared types in `deploy.types.ts`) — see "Unified Deploy" below.
- **`node/*.ts`** — Node-only entry point (`@run402/sdk/node`). Wraps `core/` keystore + allowance into `NodeCredentialsProvider`. Sets up x402-wrapped fetch via `createLazyPaidFetch()`. Adds `fileSetFromDir(path)` for filesystem byte sources and the deploy manifest adapter (`loadDeployManifest(path)`, `normalizeDeployManifest(input)`) for CLI/MCP-compatible JSON.
- **`scoped.ts`** — `ScopedRun402` sub-client. Returned by `r.project(id?)` and `r.useProject(id)`. Wraps every project-id-bearing namespace method with the id pre-bound, so `p.deploy.apply({ site })` (no `project`), `p.functions.list()`, `p.blobs.put(key, src)` all "just work" once the scope is set. Caller-supplied `project_id` / `project` still wins (override-friendly). The unwrapped namespaces (`r.deploy`, `r.functions`, …) keep their required-id signatures unchanged — scoped is sugar, not a replacement.

### Project-scoped sub-client (`r.project(id?)`)

- `r.project(id)` — bind to an explicit id; no keystore lookup at construction (lazy: errors surface from the first method call that needs keys).
- `r.project()` — resolve from `credentials.getActiveProject()`. Throws `LocalError` (context: "scoping client to project") when the provider has no active-project state or returns null.
- `r.useProject(id)` — sugar: `r.projects.use(id)` + `r.project(id)` in one call. Mutates persistent keystore state (the active project is shared with concurrent CLI runs); use `r.project(id)` for transient in-script scoping.
- The drift-protection test in `sdk/src/scoped.test.ts` asserts every project-id-bearing namespace method has a corresponding wrapper — adding a new method without a wrapper fails CI.

### Unified Deploy (v1.34+)

- **`namespaces/deploy.ts`** — `Deploy` class exposing the canonical primitive. Three layers:
  - `r.deploy.apply(spec, opts?)` — one-shot, awaits to terminal (most agents use this).
  - `r.deploy.start(spec, opts?)` — returns a `DeployOperation` with `events()` async iterator + `result()` promise.
  - `r.deploy.plan` / `upload` / `commit` — low-level steps for CLI debugging.
  - Plus `r.deploy.resume(operationId)`, `status`, `getRelease`, `getActiveRelease`, `diff`.
- **All bytes ride through CAS.** The plan request body never carries inline bytes — only `ContentRef` objects. When the normalized spec exceeds 5 MB JSON, the SDK uploads the manifest itself as a CAS object and references it (`manifest_ref` escape hatch — no body-size cliff).
- **Manifest adapters live in the Node SDK.** `loadDeployManifest(path)` and `normalizeDeployManifest(input)` accept the agent/CLI/MCP JSON shape (`project_id`, `{data,encoding}`, `{path}`, migration `sql_path` / `sql_file`) and return an SDK-native `ReleaseSpec` plus optional `idempotencyKey`. CLI/MCP should call these helpers instead of reimplementing adapter logic.
- **Strict/no-op validation lives in the SDK.** `Deploy.validateSpec` rejects unknown raw `ReleaseSpec` fields before normalization can drop them, and rejects project/base-only or empty nested specs with `MANIFEST_EMPTY` before hashing, uploading, or planning. The Node manifest adapter is strict too, so agent JSON typos such as `subdomain` or `sqlPath` do not become partial deploys.
- **Replace vs patch semantics per resource.** `site.replace` = "this is the whole site" (files absent are removed in the new release); `site.patch.put` / `patch.delete` = surgical updates. Same for `functions`. Secrets are value-free declarations: `secrets.require` asserts keys already exist, and `secrets.delete` removes keys at activation. Set secret values out-of-band through the secrets API. `subdomains` use `set` / `add` / `remove`. `routes` is `undefined | null | { replace: RouteSpec[] }`: omitted/null carries forward base routes, `replace: []` clears dynamic routes, and route entries target materialized functions with `{ type: "function", name }`. Top-level absence = leave untouched.
- **Structured warnings.** Plan responses include `warnings: WarningEntry[]`. `deploy.apply` emits `plan.warnings` and aborts before upload/commit when a warning requires confirmation (including `MISSING_REQUIRED_SECRET`) unless the caller explicitly passes `allowWarnings`.
- **Server-authoritative dry-runs.** `deploy.plan(spec, { dryRun: true })` calls `POST /deploy/v2/plans?dry_run=true`; the gateway returns the v2 flat plan envelope without creating plan or operation rows, so `plan_id` and `operation_id` are `null` and the response cannot be uploaded or committed.
- **Release observability.** `getRelease({ project, releaseId, siteLimit? })`, `getActiveRelease({ project, siteLimit? })`, and `diff({ project, from, to, limit? })` are typed apikey reads over `/deploy/v2/releases*`. `active` means the current-live target; inventories expose materialized routes and warnings when returned; release-to-release diffs expose `migrations.applied_between_releases`, not plan migration buckets. Secret diffs expose keys only; route diffs expose `added` / `removed` / `changed`.
- **Server-authoritative manifest digest.** The gateway returns the canonical digest in the plan response. The SDK no longer requires byte-for-byte canonicalize agreement — `canonicalize.ts` is now a UX helper only.
- **Backward-compat shims.** `apps.bundleDeploy` translates legacy options into a `ReleaseSpec` and delegates to `deploy.apply` (the `inherit: true` flag is silently ignored — deprecation is preserved in the JSDoc only, the runtime warning was removed in #162 because it misled callers when an unrelated error followed). `sites.deployDir` is a thin wrapper that uses `fileSetFromDir(dir)` and synthesizes both unified `DeployEvent` shapes and the legacy `{ phase: ... }` shapes for v1.32-era event consumers.
- **MCP/CLI surface.** `deploy` and `deploy_resume` MCP tools (in `src/tools/deploy.ts` and `src/tools/deploy-resume.ts`) expose the new primitive directly; `deploy_release_get` / `deploy_release_active` / `deploy_release_diff` expose release observability reads. CLI subcommands `run402 deploy apply`, `run402 deploy resume`, and `run402 deploy release <get|active|diff>` (in `cli/lib/deploy-v2.mjs`) mirror them. The legacy `bundle_deploy`/`deploy_site`/`deploy_site_dir` MCP tools and `run402 deploy --manifest` CLI continue to work and route through the same SDK shim.

### CI/OIDC Federation (GitHub Actions)

- **`namespaces/ci.ts`** — `/ci/v1/*` SDK surface: `createBinding`, `listBindings`, `getBinding`, `revokeBinding`, `exchangeToken`, plus canonical delegation builders (`buildCiDelegationStatement`, `buildCiDelegationResourceUri`) and validators.
- **`ci-credentials.ts`** — isomorphic CI-session credential providers. `githubActionsCredentials({ projectId })` requests the GitHub OIDC subject token, exchanges it through `ci.exchangeToken`, caches the Run402 session until `expires_in - refreshBeforeSeconds`, and marks credentials with `CI_SESSION_CREDENTIALS`.
- **`node/ci.ts`** — Node-only `signCiDelegation(values, opts?)`; reads the local allowance and signs the canonical SIWX delegation for `/ci/v1/bindings`. Default delegation chain id is `eip155:84532` unless overridden.
- **Deploy integration is credential-driven.** `Deploy` detects the CI credential marker internally. Do not add public `ci` options, `r.ci.deployApply`, or broad MCP wrappers without a new design. CI deploys allow only `project`, `database`, `functions`, `site`, and absent/current `base`; every `spec.secrets` shape (including value-free `require`/`delete`), subdomains, routes, checks, unknown top-level fields, non-current base, and `manifest_ref` are rejected before upload/plan.
- **CLI DX.** `run402 ci link github` creates a deploy-scoped binding and generated workflow that calls `run402 deploy apply --manifest <manifest> --project <project>`. `run402 ci list` and `run402 ci revoke` manage bindings. V1 intentionally omits raw subject/wildcard/event/PR-deploy flags and requires GitHub repository-id binding.

### Shared Core (`core/src/`)

The `core/` module contains shared logic imported by all interfaces:

- **`config.ts`** — Path resolution and env vars: `getApiBase()`, `getConfigDir()`, `getKeystorePath()`, `getAllowancePath()`.
- **`allowance.ts`** — `readAllowance()`, `saveAllowance()` with atomic writes (temp-file + rename, mode 0600).
- **`allowance-auth.ts`** — EIP-191 signing with `@noble/curves`. `getAllowanceAuthHeaders()` returns headers or null.
- **`keystore.ts`** — Unified project credential store. Object schema: `{projects: {id: {anon_key, service_key, tier, lease_expires_at}}}`. Auto-migrates legacy array format and `expires_at` → `lease_expires_at`. Functions: `loadKeyStore()`, `saveKeyStore()`, `getProject()`, `saveProject()`, `removeProject()`.
- **`client.ts`** — `apiRequest()` fetch wrapper. Handles JSON/text responses, 402 payment detection.

Core functions return `null` or throw — they never call `process.exit()`. Each interface wraps with its own error behavior.

### Functions library (`functions/`)

- **`functions/src/index.ts`** — Public exports: `db`, `adminDb`, `getUser`, `email`, `ai`, `routedHttp`, and routed HTTP envelope types/helpers (`text`, `json`, `bytes`, `isRequest`). Each helper makes raw `fetch()` calls against the project's own gateway endpoints using ambient request context (the function's `RUN402_PROJECT_ID` / `RUN402_SERVICE_KEY` env vars baked at deploy time), except routed HTTP helpers which encode/decode the public browser ingress envelope.
- **`db(req)`** — caller-context PostgREST client. Forwards the incoming `Authorization` header; RLS evaluates against the caller's role.
- **`adminDb()`** — service-key client. Routes to `/admin/v1/rest/*` (the gateway rejects `role=service_role` on `/rest/v1/*`, so bypass traffic lives on its own surface). Use only when the function acts on behalf of the platform.
- **`adminDb().sql(query, params?)`** — raw parameterized SQL, always BYPASSRLS.
- **`routedHttp`** — non-framework helpers for the `run402.routed_http.v1` same-origin browser ingress contract. Direct `/functions/v1/:name` remains API-key protected; routed function code owns app auth, CSRF, CORS/`OPTIONS`, cookies, redirects, cache headers, and spoofed forwarding-header hygiene.
- This library is auto-bundled into deployed function zips alongside any user-declared `--deps` (npm-installed and esbuild-bundled at deploy time, native binaries rejected). Also installable in your editor for full TypeScript autocomplete.

### MCP Server (`src/`)

- **`sdk.ts`** — Lazy SDK singleton (`getSdk()`). Tests call `_resetSdk()` in beforeEach to pick up env changes.
- **`errors.ts`** — `formatApiError`, `projectNotFound`, and `mapSdkError` which translates `Run402Error` → MCP `{isError, content}` shape.
- **`config.ts`**, **`keystore.ts`**, **`allowance.ts`** — re-export from `core/dist/` (still used by a few compound handlers like `init`/`status` that read local state directly).
- **`allowance-auth.ts`** — re-exports core's `getAllowanceAuthHeaders()` + adds `requireAllowanceAuth()` (early-exit with MCP error when no allowance). Kept for handlers where the UX message is more specific than the SDK's `Unauthorized`.
- **`index.ts`** — Entry point. Registers all tools via `McpServer`.
- **`tools/*.ts`** — Each tool exports a Zod schema + async handler. The handler is a thin shim: `getSdk().ns.op(...)` in a try/catch that translates errors via `mapSdkError`.

### CLI (`cli/`)

- **`cli/lib/sdk.mjs`** — Fresh SDK per call via `getSdk()`. Sidesteps stale-env issues across test-file boundaries.
- **`cli/lib/sdk-errors.mjs`** — `reportSdkError(err)` writes JSON envelope `{status: "error", http?, message?, body_preview?, ...body}` to stderr and calls `process.exit(1)`. Preserves `ProjectNotFound` plain-text format with the "Hint: project IDs start with prj_" guidance.
- **`cli/lib/config.mjs`** — Imports from `../core-dist/`, adds CLI wrappers (`allowanceAuthHeaders()` with process.exit, `findProject()` with process.exit). Re-exports core keystore functions.
- **`cli/lib/*.mjs`** — Each module exports `async run(sub, args)`. Subcommand bodies: argv parse + SDK call + JSON output + `reportSdkError` on failure.
- **`cli/lib/blob.mjs`** retains raw `fetch` for the `put` subcommand only — resumable uploads + per-part concurrency are CLI-specific UX not modeled in the SDK.
- **`cli/lib/deploy.mjs`** delegates to `getSdk().apps.bundleDeploy(...)` (the v2 shim). The legacy custom undici dispatcher and retry-on-5xx logic was retired with the v1 route removal — v2 doesn't ship inline bytes, so the long-timeout rationale no longer applies.
- **`cli/lib/deploy-v2.mjs`** — `run402 deploy apply`, `resume`, `list`, `events`, and `release <get|active|diff>` subcommands. Thin wrappers over `r.deploy.*`.
- **`cli/lib/ci.mjs`** — `run402 ci link github`, `run402 ci list`, and `run402 ci revoke`. Link signs the canonical delegation locally, verifies/inserts the GitHub repository id, and writes a workflow using GitHub OIDC (`permissions: id-token: write`) plus the existing `deploy apply` command.

### OpenClaw (`openclaw/`)

- **`openclaw/scripts/config.mjs`** — Re-exports from `cli/lib/config.mjs`
- **`openclaw/scripts/*.mjs`** — Thin shims: `export { run } from "../../cli/lib/<name>.mjs"`
- **`openclaw/scripts/init.mjs`** — Calls CLI's `run()` at top level (executable script)

### Tool Pattern

Every tool in `src/tools/` exports two things:
1. A Zod schema object (e.g., `provisionSchema`) defining input parameters
2. An async handler function (e.g., `handleProvision`) returning `{ content: [{type: "text", text: string}], isError?: boolean }`

Tools that require payment (provision, renew, deploy_site, bundle_deploy, deploy) return 402 payment details as **informational text** (not errors) so the LLM can reason about payment flow.

### Error Handling Pattern

All tools use shared error helpers from `src/errors.ts`:

- **`formatApiError(res, context)`** — Formats a non-OK API response into the standard `{ content: [...], isError: true }` shape. Includes HTTP status, extracts `hint`/`retry_after`/`renew_url`/`usage`/`expires_at` from the response body, and adds actionable guidance based on status code. The `context` parameter is a short verb phrase describing what failed (e.g. "running SQL").
- **`projectNotFound(projectId)`** — Returns a consistent "project not found in key store" error with guidance to provision first.
- **`mapSdkError(err)`** — Translates a thrown `Run402Error` subclass into the same `{isError, content}` shape, preserving payment-required envelopes as informational text.

When adding a new tool, use these helpers instead of inline error formatting:
```ts
if (!project) return projectNotFound(args.project_id);
// ...
if (!res.ok) return formatApiError(res, "doing the thing");
```

### Test Pattern

Tests mock `globalThis.fetch` and use temp directories for keystore isolation. Each test file follows:
- `beforeEach`: set `RUN402_API_BASE` env, create temp keystore, mock fetch
- `afterEach`: restore original fetch and env, clean up temp dir

### Skill files

Two skill files coexist, serving different runtimes:

- **`SKILL.md`** (root) — MCP-host skill. Frontmatter `install: run402-mcp`. Body teaches the platform via MCP tool names (`provision_postgres_project`, `apply_expose`, `deploy_site_dir`, `blob_put`, …) in natural-language framings — no JSON tool-call blobs. Read by Claude Desktop / Cursor / Cline / Claude Code agents that already have the run402-mcp tools loaded.
- **`openclaw/SKILL.md`** — OpenClaw script-based skill. Frontmatter `install: run402` (the CLI). Body teaches the platform exclusively via `run402 <verb>` commands. Read by OpenClaw's script runner, where `openclaw/scripts/*.mjs` re-export from the CLI's lib.

`SKILL.test.ts` validates both files with shape-appropriate guards (root requires the run402-mcp install + 9 MCP tool names; openclaw requires the run402 CLI install + 7 CLI verbs). Both ban `setup_rls` / `get_deployment` / `projects rls` / `sites status` / `inherit:true` regressions. Run with `npm run test:skill`.

## Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `RUN402_API_BASE` | `https://api.run402.com` | API base URL (override for testing/staging) |
| `RUN402_CONFIG_DIR` | `~/.config/run402` | Local credential storage directory |
| `RUN402_ALLOWANCE_PATH` | `{config_dir}/allowance.json` | Custom allowance (wallet) file path |
