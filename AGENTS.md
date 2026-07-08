# AGENTS.md

This file is the single source of truth for AI coding agents working in this repository (Claude Code, Codex, Cursor, Cline, OpenClaw, etc.). `CLAUDE.md` imports it via `@AGENTS.md`.

> **Updating docs?** See [`documentation.md`](documentation.md) — the map of every doc surface, with target audience, content summary, and update triggers. **Scan it before merging code changes.**

## What This Is

run402 is a developer platform that ships Postgres databases, content-addressed CDN storage, static site hosting, Node 22 serverless functions, email, image generation, and KMS-backed Ethereum signing — provisioned by AI agents and paid for autonomously via x402 USDC on Base, MPP pathUSD on Tempo, or Stripe credits. Prototype tier is free on testnet.

This monorepo ships **six interfaces**:

- **SDK** (`sdk/`) — typed TypeScript client for the run402 API. Used by external integrators, MCP/CLI/OpenClaw, and (eventually) inside deployed functions. Published as `@run402/sdk` on npm. Two entry points: root (isomorphic — works in Node 22, Deno, Bun, V8 isolates) and `/node` (zero-config Node defaults — keystore + allowance + x402).
- **MCP server** (root `src/`) — published as `run402-mcp` on npm. Each tool is a thin shim over an SDK call. Read by Claude Desktop / Cursor / Cline / Claude Code.
- **CLI** (`cli/`) — standalone CLI published as `run402` on npm. Each subcommand is a thin shim over an SDK call; argv parsing and JSON output stay at the CLI edge.
- **Functions library** — in-function helper imported _inside_ deployed serverless functions. Exposes `auth.*` (the canonical auth namespace — `auth.user`, `requireUser`, `requireRole`, `requireMembership`, `requireFresh`, `fetch`, `csrfToken`/`csrfField`, `sessions.*`, `identities.link`), `db(req?)`, `adminDb()`, `email`, `ai`, and `assets`. Published as `@run402/functions` on npm (v3.0+). **Source lives in the public `run402-core` repo** under `packages/functions`; Run402 Cloud consumes the published npm package when it bundles deployed functions. Distinct from the SDK: this is the request-scoped, in-function shape; the SDK is the typed external client. The two are complementary, not redundant.
- **OpenClaw skill** (`openclaw/`) — script-based skill for OpenClaw agents, re-exports from CLI modules.
- **Astro integration** (`astro/`) — framework integration that wires the SDK into Astro's build pipeline. Ships an `<Image>` component (build-time scan + variant rewrite), an `assetsDir`/manifest pattern for data-driven sites, and runtime helpers (`resolveVariants`, `renderPicture`) for the recommended **AssetRef-persistence pattern** where consumers store the full `AssetRef` returned by `r.assets.put` in their data rows. Published as `@run402/astro` on npm.

Workspace layout: `package.json` declares `cli`, `sdk`, and `astro` as npm workspaces; `pnpm-workspace.yaml` lists only `cli` and `sdk` for pnpm-based hosts (astro is npm-only today). `core/` is shared internal code, not an npm package. `@run402/functions` is NOT a workspace of this repo — its source lives in `kychee-com/run402-core/packages/functions`.

The three packages in this repo (`run402-mcp`, `run402`, `@run402/sdk`) release in lockstep via the `/publish` skill at the same version (the skill also supports per-package selection for off-cycle patches). MCP, CLI, OpenClaw, and the Node SDK all share the request kernel via `@run402/sdk`. `@run402/astro` is a sibling integration on its own release cadence via the `/publish-astro` skill — not part of the kernel lockstep. `@run402/functions` is published separately from `run402-core`, but ships at the same npm name. `core/` holds filesystem primitives (keystore, allowance, SIWE signing) that the Node SDK provider wraps.

## Build & Test Commands

```bash
npm run build:core         # tsc -p core/tsconfig.json → core/dist/
npm run build:sdk          # tsc -p sdk/tsconfig.json  → sdk/dist/
npm run build              # build:core + build:sdk + tsc → dist/ (also stages dist copies under cli/)
npm run start              # node dist/index.js (stdio MCP transport)

npm run test:skill         # validates SKILL.md and openclaw/SKILL.md (49 tests across both)
npm run test:sync          # checks MCP/CLI/OpenClaw/SDK stay in sync
npm test                   # runs build first, then SKILL + sync + unit (core/src + sdk/src + src) + CLI e2e
npm run test:e2e           # runs build first, then CLI end-to-end tests
npm run test:help          # runs build first, then CLI help-text snapshots only
npm run test:integration         # SIWX integration (core/src/siwx-integration.integ.ts)
npm run test:integration:full    # full CLI integration (cli-integration.test.ts)
npm run test:integration:mcp     # MCP integration (mcp-integration.test.ts)
npm run test:integration:fullstack # full-stack live platform integration (fullstack-integration.test.ts)
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
- If a local `llms.txt` reference is available: MCP Tools table lists all tools, all endpoints documented

When adding a new tool/command, add it to the `SURFACE` array **and** `SDK_BY_CAPABILITY` in `sync.test.ts`.

## Architecture

```
@run402/sdk  (typed TypeScript kernel — focused namespaces including snapshots, branches, and apply rehearsal)
   │
   │   /index.ts    (isomorphic: Node + sandbox)
   │   /node        (Node-only: keystore + allowance + x402-wrapped fetch + fileSetFromDir)
   │
   ├─── MCP tools  (src/tools/*.ts)  — thin shim → SDK → markdown format
   ├─── CLI        (cli/lib/*.mjs)   — thin shim → SDK → JSON output + exit code
   └─── OpenClaw   (openclaw/scripts/*.mjs) — re-exports from CLI

core/      ← Node-only primitives (keystore, allowance, SIWE signing, config paths)
              Imported by sdk/src/node via ../../../core/dist/; not an npm package.

@run402/functions ← in-function helper (auth.*, db, adminDb, email, ai, assets, routedHttp).
              v3.0+ ships the `auth.*` namespace; legacy bare exports
              (`getUser`, `getUserId`, `getRole`, `getSession`, `currentUser`,
              `getCurrentUser`, `getServerSession`) throw R402_AUTH_UNKNOWN_EXPORT at
              runtime AND fail `run402 doctor` source scan at deploy.
              SOURCE LIVES IN THE PUBLIC run402-core REPO — NOT in this repo.
              Treated as platform code, not a user dependency: the gateway bundles
              its installed @run402/functions package via esbuild alias at deploy
              time (users should not list @run402/functions in --deps). The npm
              package (@run402/functions) is both the editor-autocomplete artifact
              and the artifact Run402 Cloud consumes. To change the surface, edit
              run402-core/packages/functions, publish @run402/functions from
              run402-core, then bump the Cloud gateway dependency and redeploy.
```

The SDK is the canonical kernel — a single typed client with a `CredentialsProvider` interface for credential access and a pluggable `fetch` (for x402 wrapping in Node, session tokens in sandboxes). MCP handlers and CLI commands are thin shims: argv/schema parsing + SDK call + output formatting. They must not call Run402 gateway endpoints directly; add missing SDK methods first. The only direct `fetch()` calls allowed at those edges are non-Run402 external services (Tempo RPC, GitHub API) and presigned storage part URLs returned by the SDK. `sync.test.ts` enforces this boundary. When code-mode MCP ships, the same SDK runs inside a V8 isolate.

### SDK (`sdk/src/`)

- **`index.ts`** — `Run402` class + `run402()` factory + `files()` helper. Isomorphic entry point.
- **`kernel.ts`** — Request function, `Client` interface. Only place that calls `globalThis.fetch`.
- **`errors.ts`** — `Run402Error` hierarchy: `PaymentRequired`, `ProjectNotFound`, `Unauthorized`, `ApiError`, `NetworkError`, `Run402DeployError` (the v1.34+ structured envelope from the deploy state machine). Never calls `process.exit`.
- **`credentials.ts`** — `CredentialsProvider` interface. Required: `getAuth`, `getProject`. Optional: `saveProject`, `updateProject`, `removeProject`, `setActiveProject`, `getActiveProject`, `readAllowance`, `saveAllowance`, `createAllowance`, `getAllowancePath`.
- **`namespaces/*.ts`** — One class per resource group (projects, assets, functions, jobs, email, CI/OIDC, …). Namespaces hold a `Client` and expose typed methods. The canonical apply primitive is implemented in **`namespaces/deploy.ts`**; the public-facing symbol is `r.project(id).apply`, with no public `r.deploy` surface. The internal engine is `_applyEngine`. Shared types live in `deploy.types.ts` — see "Unified Apply" below.
- **Timestamp contract.** Public API and SDK response timestamps are ISO-8601 strings (`created_at`, `updated_at`, `expires_at`, `lease_expires_at`, `timestamp`, etc.), nullable only when the gateway state is genuinely absent. Public SDK types must never expose JavaScript `Date` objects or numeric epochs for absolute instants. Public absolute-time inputs such as `since` should be ISO-8601 strings too; legacy numeric epochs are allowed only when the route/SDK docs explicitly name the compatibility path. Numeric time values are only for relative durations or local measurements and must carry units in the field name (`expires_in`, `duration_ms`, `elapsedMs`, `ttl_seconds`). Local credential/session caches may store epoch milliseconds internally, but CLI/user-visible output converts them back to ISO strings. `sdk/src/timestamp-conventions.test.ts` enforces this.
- **`node/*.ts`** — Node-only entry point (`@run402/sdk/node`). Wraps `core/` keystore + allowance into `NodeCredentialsProvider`. Sets up x402-wrapped fetch via `createLazyPaidFetch()`. Adds `fileSetFromDir(path)` for filesystem byte sources and the deploy manifest adapter (`loadDeployManifest(path)`, `normalizeDeployManifest(input)`) for CLI/MCP-compatible JSON.
- **`scoped.ts`** — `ScopedRun402` sub-client. Returned by `r.project(id?)` and `r.useProject(id)`. Wraps every project-id-bearing namespace method with the id pre-bound, so `p.apply({ site })` (no `project`), `p.functions.list()`, `p.jobs.get(jobId)`, `p.assets.put(key, src)` all "just work" once the scope is set. Caller-supplied `project_id` / `project` still wins (override-friendly). The unwrapped namespaces (`r.assets`, `r.functions`, `r.jobs`, …) keep their required-id signatures unchanged — scoped is sugar, not a replacement. The apply primitive is only exposed via the scoped client (`r.project(id).apply(spec)`); there is no public `r.deploy`.
- **`namespaces/org.ts` + `namespaces/grants.ts` + `namespaces/wallets.ts`** — Org-owned control plane. `r.orgs` is the org collection + control-plane identity (`create`, `list`, `whoami`); `r.org(id)` is the scoped per-org sub-client (the org analog of `r.project(id)` — `get`, `rename`, `members.*`, `invites.*`, `audit`). `r.grants` is per-project capability grants (`create`, `revoke`) for agent/CI principals, also reachable as `r.project(id).grants`. `r.wallets` carries the signed server-side wallet label (`getLabel`, `setLabel`, gateway `/wallets/v1/:address/label`) surfaced in the operator console. A principal *authenticates* via SIWX but its org-membership role (or a per-project grant) decides authorization — never `wallet_address == signer`.

### Project-scoped sub-client (`r.project(id?)`)

- `r.project(id)` — bind to an explicit id; no keystore lookup at construction (lazy: errors surface from the first method call that needs keys).
- `r.project()` — resolve from `credentials.getActiveProject()`. Throws `LocalError` (context: "scoping client to project") when the provider has no active-project state or returns null.
- `r.useProject(id)` — sugar: `r.projects.use(id)` + `r.project(id)` in one call. Mutates persistent keystore state (the active project is shared with concurrent CLI runs); use `r.project(id)` for transient in-script scoping.
- The drift-protection test in `sdk/src/scoped.test.ts` asserts every project-id-bearing namespace method has a corresponding wrapper — adding a new method without a wrapper fails CI.

### Unified Apply

- **`namespaces/deploy.ts`** — `Deploy` class (the internal `_applyEngine`; not exposed as `r.deploy`). The public surface is the scoped `r.project(id).apply` hero, callable with `.plan`/`.start`/`.resume` sub-methods. Three layers:
  - `r.project(id).apply(spec, opts?)` — one-shot, awaits to terminal (most agents use this).
  - `r.project(id).apply.start(spec, opts?)` — returns a `DeployOperation` with `events()` async iterator + `result()` promise.
  - `r.project(id).apply.plan` / `upload` / `commit` — low-level steps for CLI debugging.
  - Plus `r.project(id).apply.resume(operationId)`, `status`, `getRelease`, `getActiveRelease`, `diff`.
- **First-class `assets` slice (v2.0).** `ReleaseSpec.assets` joins `site` / `functions` / `database` / `secrets` as a top-level slice with the same atomic guarantees. Two shapes: `{ put: AssetPutEntry[] }` (additive batch) and `{ put: [...], sync: { prefix, prune: true, confirm? } }` (declarative sync with prune-confirmation-token semantics; gateway re-checks via `ASSET_SYNC_DRIFT` on activation). All bytes ride through the same CAS substrate as the site slice — only new shas trigger S3 PUTs. The Node-only `NodeAssets` enrichment (`r.assets.uploadDir` / `syncDir` / `prepareDir` / `putMany`) walks directories and streams SHA-256s before submitting through this same slice. `LocalDirRef` (from `dir(path)`) is SDK-input-only and never leaks to the wire (HTTP 400 `INVALID_WIRE_SCHEMA` if it does).
- **Safe release-race retries are SDK-owned.** `apply` automatically re-plans and retries omitted/current-base specs on `BASE_RELEASE_CONFLICT` only when the gateway marks the error `safe_to_retry: true`. Default budget is 2 retries after the initial attempt; `maxRetries: 0` opts out. Each retry emits `deploy.retry`; exhausted retries preserve the last `Run402DeployError` and add `attempts`, `maxRetries`, and `lastRetryCode`. Static activation/spec failures reported from `activation_pending` throw immediately with gateway metadata preserved.
- **All bytes ride through CAS.** The plan request body never carries inline bytes — only `ContentRef` objects. When the normalized spec exceeds 5 MB JSON, the SDK uploads the manifest itself as a CAS object and references it (`manifest_ref` escape hatch — no body-size cliff).
- **Manifest adapters live in the Node SDK.** `loadDeployManifest(path)` and `normalizeDeployManifest(input)` accept the agent/CLI/MCP JSON shape (`project_id`, `{data,encoding,content_type?}`, `{path,content_type?}`, `config.timeout_seconds`, `require_auth` / `require_role`, migration `sql_path` / `sql_file`) and return an SDK-native camelCase `ReleaseSpec` plus optional `idempotencyKey`. CLI/MCP should call these helpers instead of reimplementing adapter logic.
- **Strict/no-op validation lives in the SDK.** `Deploy.validateSpec` rejects unknown raw `ReleaseSpec` fields before normalization can drop them, and rejects project/base-only or empty nested specs with `MANIFEST_EMPTY` before hashing, uploading, or planning. The Node manifest adapter is strict too, so agent JSON typos such as `subdomain` or `sqlPath` do not become partial deploys.
- **Replace vs patch semantics per resource.** `site.replace` = "this is the whole site" (files absent are removed in the new release); `site.patch.put` / `patch.delete` = surgical updates; `site.public_paths` is the direct browser reachability table for static assets. Explicit mode uses a complete map such as `{ "/events": { asset: "events.html", cache_class: "html" } }`, so `/events` serves the release asset `events.html` while `/events.html` is not public unless separately declared. `mode: "implicit"` restores filename-derived reachability and can widen access. Public-path-only site specs are deployable. Same replace/patch split for `functions`. Secrets are value-free declarations: `secrets.require` asserts keys already exist, and `secrets.delete` removes keys at activation. Set secret values out-of-band through the secrets API. `subdomains` use `set` / `add` / `remove`. `routes` is `undefined | null | { replace: RouteSpec[] }`: omitted/null carries forward base routes, `replace: []` clears dynamic routes, and route entries target materialized functions with `{ type: "function", name }` or exact method-aware static aliases with `{ type: "static", file: "events.html" }`, where `file` is a release asset path, not a public path, URL, CAS hash, rewrite, or redirect. Prefer `site.public_paths` for ordinary clean static URLs. Top-level absence = leave untouched.
- **Structured warnings.** Plan responses include `warnings: WarningEntry[]`. `apply` emits `plan.warnings` and aborts before upload/commit when a warning requires confirmation (including `MISSING_REQUIRED_SECRET`) unless the caller explicitly passes broad `allowWarnings` or covers every blocking warning through `allowWarningCodes`. Read-only wildcard function routes may use `acknowledge_readonly: true` only for GET/HEAD final-wildcard function routes.
- **Tier preflight.** After normalization and before manifest CAS upload or deploy planning, deploy checks literal function timeout, memory, cron interval, and scheduled-function count when limits are known from `tier.status()` or the static fallback. Local cap failures are structured `Run402DeployError.code === "BAD_FIELD"` with field/value/tier/limit details and `limit_source`; gateway validation remains authoritative.
- **Server-authoritative dry-runs.** `r.project(id).apply.plan(spec, { dryRun: true })` calls `POST /apply/v1/plans?dry_run=true`; the gateway returns the v2 flat plan envelope without creating plan or operation rows, so `plan_id` and `operation_id` are `null` and the response cannot be uploaded or committed.
- **Release observability.** `getRelease({ project, releaseId, siteLimit? })`, `getActiveRelease({ project, siteLimit? })`, `diff({ project, from, to, limit? })`, and `resolve({ project, url|host, method? })` are typed apikey reads over `/apply/v1/releases*` and `/apply/v1/resolve`. `active` means the current-live target; inventories expose materialized routes, `static_public_paths` when returned, and warnings when returned. `site.paths` is the release static asset inventory; `static_public_paths[]` is the browser reachability inventory with `public_path`, `asset_path`, `reachability_authority`, `direct`, cache class, and content type. Resolve diagnostics preserve stable-host fields such as `authorization_result`, `cas_object`, `response_variant`, `allow`, `route_pattern`, `target_type`, `target_name`, and `target_file`; known match literals include `active_release_missing`, `unsupported_manifest_version`, `route_function`, `route_static_alias`, and `route_method_miss`, and known fallback states include `negative_cache_hit`, but future strings remain valid. Release-to-release diffs expose `migrations.applied_between_releases`, not plan migration buckets. Secret diffs expose keys only; route diffs expose `added` / `removed` / `changed`.
- **Server-authoritative manifest digest.** The gateway returns the canonical digest in the plan response. The SDK no longer requires byte-for-byte canonicalize agreement — `canonicalize.ts` is now a UX helper only.
- **Convenience shims.** `sites.deployDir` is a Node-only wrapper that uses `fileSetFromDir(dir)` and delegates to `apply`; its event callback emits only unified `DeployEvent` shapes.
- **MCP/CLI surface.** `deploy`, `deploy_resume`, and `deploy_rehearse` MCP tools expose the apply primitive directly; `deploy_release_get` / `deploy_release_active` / `deploy_release_diff` expose release observability reads. CLI subcommands `run402 deploy apply`, `run402 deploy rehearse`, `run402 deploy resume`, and `run402 deploy release <get|active|diff>` (in `cli/lib/deploy-v2.mjs`) mirror them. `run402 apply` is the root alias for the rehearse-first one-shot deploy flow. Snapshot and branch primitives live in `cli/lib/snapshots.mjs`, `cli/lib/branches.mjs`, `src/tools/project-snapshots.ts`, and `src/tools/project-branches.ts`. Use a v2 `ReleaseSpec` through `deploy` / `deploy apply`.
- **Function-level auth gates.** `FunctionSpec` carries two optional declarative fields: `requireAuth?: boolean` and `requireRole?: RequireRoleSpec | null`. When set, the gateway enforces them before invoking the function — unauthorized callers get `401`/`403` without the function body running, and the gateway injects `x-run402-user-id` (always when any gate ran) and `x-run402-user-role` (only when `requireRole` ran) into the request. In-function code reads them directly from `req.headers.get("x-run402-user-id")` / `req.headers.get("x-run402-user-role")` (the legacy `getUserId(req)` / `getRole(req)` bare exports threw R402_AUTH_UNKNOWN_EXPORT as of `@run402/functions` v3.0; for the canonical cookie-session flow see the auth-aware SSR bullet below). `requireRole` describes a single-table lookup against the project schema (`table`, `idColumn`, `roleColumn`, `allowed[]`, optional `cacheTtl` in seconds — default 60, max 600, 0 disables). All `requireRole` blocks in a release must share the same `(table, idColumn, roleColumn)` triple — gateway rejects mixed tables at plan time. Schema-qualified identifiers, empty `allowed`, and out-of-range `cacheTtl` are rejected with the canonical `INVALID_SPEC` envelope; missing-table at activation fails with `DEPLOY_INVALID_ROLE_GATE` (422) before flipping the live release. SDK does not validate shape — gateway is authoritative.
- **Astro SSR runtime + ISR cache.** `FunctionSpec.class?: "ssr" | "standard"` opts a function into the SSR class — gateway provisions it with SnapStart enabled and reverse-validates the published version before activation. Activation surfaces `DEPLOY_FUNCTION_SSR_SNAPSTART_VALIDATION_FAILED` (warning, non-blocking; function still ships, just without SnapStart). Routed invocations to `class: "ssr"` functions go through an origin ISR cache (`internal.ssr_cache`, keyed by `(host, path, search, method, locale, release_id)` with WHATWG-conservative canonicalization). Cache hot path checks `tryServeFromCache` BEFORE invoking; misses go to `storeIfCacheable` AFTER rendering. Hot path is bypass-by-default — only stores when `cacheable: true` (Cache-Control parsing) AND no `Set-Cookie` AND no auth-taint flag (`taintCacheBypass()` from `@run402/functions/runtime-context` — automatically set by every `auth.*` helper and by `withPaymentTaint()` payment primitives). Generation-guarded writes (per-`(project,host)` counter incremented on every invalidate) prevent in-flight MISS renders from clobbering a freshly-cleared state. Single-flight dedup per cache key collapses concurrent misses to one render. Invalidation: `r.cache.invalidate(url)` / `invalidatePrefix({ host, prefix })` / `invalidateAll({ host })` / `invalidateMany(urls)` (SDK), `run402 cache invalidate <url>` / `--prefix` / `--all` (CLI). Inspect: `r.cache.inspect(url)` / `run402 cache inspect <url>` — returns `{ status: 'HIT' | 'MISS', cachedAt, expiresAt, contentSha256, writtenUnderGeneration }`. Host ownership is enforced server-side (`R402_CACHE_INVALIDATION_HOST_FORBIDDEN` 403 on cross-project hosts). Authored via `@run402/astro` 2.0+: `export default run402();` returns an `AstroUserConfig` composing the SSR adapter (Lambda + SnapStart + ISR cache + ALS context) + image integration + build-time detectors (dynamic `<Image>` / server islands / sessions / `<Run402Picture>`) + hosted-auth components (`<SignIn />`, `<SignUp />`, `<UserButton />`, `<AccountSecurity />`, `<SignedIn>`, `<SignedOut>`). 17 R402_* error codes catalog at `astro/README.md` (top section) and `cli/llms-cli.txt` (R402_* SSR Runtime Error Codes section).
- **auth-aware SSR (v3.0+).** Browser sessions are opaque server-side handles backed by `internal.sessions` — `__Host-Http-r402_session=v1.<session_id>.<secret>` cookie carries no client-readable identity; the gateway resolves it on every request (no positive validity cache, so revocation is instant). The SDK's `auth.*` namespace is the single canonical surface — `auth.user()` / `requireUser()` / `requireRole(role)` / `requireMembership(m)` / `requireFresh({maxAge, amr?})` / `fetch(input, init?)` (same-origin only) / `csrfToken()` / `csrfField()` / `sessions.createResponseFromIdentity({provider, subject, proof, amr, createUser?})` / `sessions.endResponse()` / `identities.link({...})`. Hallucinated names (`getUser`, `getSession`, `currentUser`, `getServerSession`, `auth.protect`, `auth.signIn`, `auth.logout`, …) throw `R402_AUTH_UNKNOWN_EXPORT` at runtime AND fail `run402 doctor` source scan at deploy with structured fix-it pointing at the canonical helper. The `Actor` type uses `id` (not `userId`) as the canonical public user-id field — matches Supabase / Clerk / Auth.js convention. Cookie + JWT precedence: `R402_AUTH_BEARER_COOKIE_MISMATCH` on actor disagreement, `R402_AUTH_INVALID_BEARER` on valid cookie + malformed Bearer. Origin enforcement is mandatory on cookie-authenticated unsafe-method requests; `Origin: null` always fails; Referer fallback uses full-origin equality. The `@run402/astro` `<UserButton />` component renders the canonical sign-out POST form + double-submit CSRF token from `auth.csrfField()`. Hosted routes: `/auth/sign-in`, `/auth/sign-up`, `/auth/sign-out` (GET redirect-safe; POST revokes), `/auth/re-auth` (per-AMR step-up), `/auth/sign-in/oauth/google/start` (Google OAuth bridge mints session + 303s to server-validated returnTo). 22 `R402_AUTH_*` error codes catalogued at `run402.com/errors/`. **Never catch `auth.*` errors** — the platform decides 303-vs-envelope from the `Accept` header. **Never write `.eq("user_id", user.id)` against an RLS-bound table** — RLS already binds visitor's rows via `run402.current_user_id()`; the redundant filter is a deploy-fail (`R402_AUTH_REDUNDANT_USER_FILTER`). For per-user gating in functions outside the cookie-session flow, the existing `requireAuth` / `requireRole` deploy-spec gates inject `x-run402-user-id` / `x-run402-user-role` headers — read them from `req.headers.get(...)` directly.

### CI/OIDC Federation (GitHub Actions)

- **`namespaces/ci.ts`** — `/ci/v1/*` SDK surface: `createBinding`, `listBindings`, `getBinding`, `revokeBinding`, `exchangeToken`, plus canonical delegation builders (`buildCiDelegationStatement`, `buildCiDelegationResourceUri`) and validators.
- **`ci-credentials.ts`** — isomorphic CI-session credential providers. `githubActionsCredentials({ projectId })` requests the GitHub OIDC subject token, exchanges it through `ci.exchangeToken`, caches the Run402 session until `expires_in - refreshBeforeSeconds`, and marks credentials with `CI_SESSION_CREDENTIALS`.
- **`node/ci.ts`** — Node-only `signCiDelegation(values, opts?)`; reads the local allowance and signs the canonical SIWX delegation for `/ci/v1/bindings`. Default delegation chain id is `eip155:84532` unless overridden.
- **Deploy integration is credential-driven.** `Deploy` detects the CI credential marker internally. Do not add public `ci` options, `r.ci.deployApply`, or broad CI deploy wrapper tools without a new design. CI deploys allow only `project`, `database`, `functions`, the complete `site` resource including `site.public_paths`, absent/current `base`, and `routes` authorized by the binding's `route_scopes`; every `spec.secrets` shape (including value-free `require`/`delete`), subdomains, checks, unknown top-level fields, non-current base, and `manifest_ref` are rejected before upload/plan. Gateway planning enforces route diffs and nested public-path validation/authorization, returning canonical errors such as `CI_ROUTE_SCOPE_DENIED` for out-of-scope route declarations.
- **CLI DX.** `run402 ci link github` creates a deploy-scoped binding and generated workflow that calls `run402 deploy apply --manifest <manifest> --project <project>`. Repeatable `--route-scope <pattern>` delegates exact public paths such as `/admin` or final-wildcard prefixes such as `/api/*`; no scopes means no CI route authority. `run402 ci list` and `run402 ci revoke` manage bindings. V1 intentionally omits raw subject/wildcard/event/PR-deploy flags and requires GitHub repository-id binding.

### Shared Core (`core/src/`)

The `core/` module contains shared logic imported by all interfaces:

- **`config.ts`** — Path resolution and env vars: `getApiBase()`, `getConfigDir()`, `getKeystorePath()`, `getAllowancePath()`.
- **`allowance.ts`** — `readAllowance()`, `saveAllowance()` with atomic writes (temp-file + rename, mode 0600).
- **`allowance-auth.ts`** — EIP-191 signing with `@noble/curves`. `getAllowanceAuthHeaders()` returns headers or null.
- **`keystore.ts`** — Unified project credential store. Object schema: `{projects: {id: {anon_key, service_key, tier, lease_expires_at}}}`. Auto-migrates legacy array format and `expires_at` → `lease_expires_at`. Functions: `loadKeyStore()`, `saveKeyStore()`, `getProject()`, `saveProject()`, `removeProject()`.
- **`operator-session.ts`** — Operator-session cache for the **human/email** principal (distinct from the per-wallet allowance/keystore). `readOperatorSession()`, `saveOperatorSession()`, `clearOperatorSession()`, `isOperatorSessionExpired()`, `loadLiveOperatorSession()`, `operatorSessionFromTokenResponse()` over `{base}/operator-session.json` (mode 0600, **base** config dir — email-scoped, so it is shared across named wallets, not per-profile). Backs `r.operator` and `run402 operator login/logout/overview/whoami`.
- **`control-plane-session.ts`** — Cache for the **write-capable** control-plane session (the 5th auth principal, distinct from the read-only operator session). `readControlPlaneSession()`, `saveControlPlaneSession()`, `clearControlPlaneSession()`, `controlPlaneSessionFromTokenResponse()` over `{base}/control-plane-session.json` (mode 0600, base config dir). Minted by the loopback-PKCE CLI write-login (`run402 operator login --loopback`/`--step-up`) and carried SDK-wide via `controlPlaneSessionCredentials({ token })`. The hosted browser session surface (email magic-link / passkey / OAuth / step-up / authenticators / recovery) is `r.operator.session.*` (`sdk/src/namespaces/operator-session.ts`) — console-side, no MCP/CLI verb.

Core functions return `null` or throw — they never call `process.exit()`. Each interface wraps with its own error behavior.

### Functions library (`@run402/functions` v3.0+)

**Source location: public `run402-core`.** Not in this repo. The package source lives in `kychee-com/run402-core/packages/functions`; the npm package (`@run402/functions`) on the registry is what users install for TypeScript autocomplete and what Run402 Cloud consumes when it bundles deployed functions.

v3.0 is BREAKING:

- `getUser` / `getUserId` / `getRole` removed as working bare exports; throw `R402_AUTH_UNKNOWN_EXPORT` at runtime with a structured fix-it pointing at `auth.*`.
- `auth.sessions.createResponse({ userId })` removed from the public API. Replaced with `auth.sessions.createResponseFromIdentity({ provider, subject, proof, amr, createUser? })` — the platform verifies the proof end-to-end; agent code never holds a raw `userId`.
- `Actor.id` is canonical (not `userId`).
- Per-AMR freshness: a recent password proof does NOT satisfy `auth.requireFresh({amr: ["passkey"]})`.
- `auth.fetch` is same-origin-only with synchronous URL validation.
- Origin enforcement is mandatory on cookie-authenticated unsafe-method requests.

See `cli/llms-cli.txt` for the full v3.0 in-function helper reference + the R402_AUTH_* code catalog.

Quick reference of the public surface (full package docs live in `run402-core`):

- **`auth.user()`** — `Actor | null`. Reads the verified actor from the SSR runtime context. Triggers cache-bypass taint.
- **`auth.requireUser()`** — `Actor`. 303 → `/auth/sign-in?returnTo=` (HTML) or 401 envelope (JSON) on anonymous. Don't catch.
- **`auth.requireRole<const R>(role: R)`** / **`auth.requireMembership<const M>(m: M)`** — gate helpers; imply requireUser; return `{ user, role }` / `{ user, membership }`.
- **`auth.requireFresh({ maxAge, amr? })`** — per-AMR step-up. Recent password proof does NOT satisfy `{amr: ["passkey"]}`.
- **`auth.fetch(input, init?)`** — same-origin-only fetch with synchronous URL validation; `redirect: "manual"` default.
- **`auth.csrfToken()`** / **`auth.csrfField()`** — double-submit token for hosted forms.
- **`auth.sessions.createResponseFromIdentity({ provider, subject, proof, amr, createUser? })`** — custom identity proof bridge.
- **`auth.sessions.endResponse()`** — sign-out.
- **`auth.identities.link({ provider, subject, proof })`** — atomic nonce consumption + identity insert.
- **`db(req?)`** — caller-context PostgREST client. Inside an SSR request with a verified actor, mints a 60s actor JWT (`sub`, `project_id`, `session_id`, `authz_version`) so `run402.current_user_id()` resolves in RLS without any client-side header plumbing.
- **`adminDb()`** — service-key client. Routes to `/admin/v1/rest/*`. Use only when the function acts on behalf of the platform, not the caller.
- **`adminDb().sql(query, params?)`** — raw parameterized SQL, always BYPASSRLS.
- For per-user gating in functions OUTSIDE the cookie-session flow: read `req.headers.get("x-run402-user-id")` / `req.headers.get("x-run402-user-role")` directly (the gateway injects these when a `requireAuth` / `requireRole` deploy-spec gate ran). The legacy `getUser(req)` / `getUserId(req)` / `getRole(req)` bare exports were retired in v3.0 — they now throw `R402_AUTH_UNKNOWN_EXPORT`. For the canonical cookie-session flow, use `auth.*` above.
- **`email.send(opts)`** — send email from the project's mailbox (raw HTML or template).
- **`ai.translate(text, to, opts?)`**, **`ai.moderate(text)`**, **`ai.generateImage({ prompt, aspect? })`** — project-billed AI helpers using the function's service-key auth.
- **`assets.put(key, source, opts?)`** — in-function asset upload through the service-key `/apply/v1/service-asset-put` path. Uses the same CAS/activation substrate as deploy-time assets and returns SDK-compatible `AssetRef` snake_case + camelCase fields.
- **`getRoutedPaymentContext(req)`** (`@run402/functions` 3.7+) — confirmed x402 payment context for priced routed function requests. Returns `{ scheme, paymentId, amountUsdMicros, payer, network, asset, payTo, transaction, settledAt }` or `null`; key app-side idempotency by `payment.paymentId`.
- **`routedHttp`** — non-framework helpers for the `run402.routed_http.v1` same-origin browser ingress contract. Direct `/functions/v1/:name` remains API-key protected; routed function code owns app auth, CSRF, CORS/`OPTIONS`, cookies, redirects, cache headers, and spoofed forwarding-header hygiene.

**Bundling model:** the gateway bundles its installed copy of this library into every function zip via esbuild `alias` at deploy time — it is **platform code, not a user dependency**. User-declared `--deps` are npm-installed and esbuild-bundled separately. Native binaries are rejected. Publish a new `@run402/functions` to npm from `run402-core` for API/type/runtime changes, then bump the Cloud gateway dependency and redeploy. Also installable locally for full TypeScript autocomplete.

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
- **`cli/lib/assets.mjs`** (v2.2.0) delegates `put` to `sdk.assets.put`, which routes through the unified-apply hero (`/apply/v1/plans` → `/content/v1/plans` → S3 PUT → commit). The pre-v2.x multipart S3 PUT + resumable session machinery is gone; resume semantics now live at the apply-plan level (24h plan TTL). `--concurrency` and `--no-resume` flags are accepted for backward compatibility but ignored.
- **`cli/lib/deploy.mjs`** is the deploy command-group dispatcher. `cli/lib/deploy-v2.mjs` owns `apply`, `resume`, `list`, `events`, diagnostics, and release observability subcommands.
- **`cli/lib/deploy-v2.mjs`** — `run402 deploy apply`, `rehearse`, `resume`, `list`, `events`, and `release <get|active|diff>` subcommands. Thin wrappers over the apply engine and scoped `r.project(id).apply.*` shape; `apply` supports `--final-only` as a `--quiet` alias, repeatable `--allow-warning <code>`, and `--rehearse` for the plan → branch rehearsal gate.
- **`cli/lib/snapshots.mjs` / `cli/lib/branches.mjs`** — `run402 snapshots create|list|get|restore|delete` and `run402 branches create|list|renew|delete`; OpenClaw re-exports both.
- **`cli/lib/ci.mjs`** — `run402 ci link github`, `run402 ci list`, and `run402 ci revoke`. Link signs the canonical delegation locally, verifies/inserts the GitHub repository id, optionally includes normalized `route_scopes`, and writes a workflow using GitHub OIDC (`permissions: id-token: write`) plus the existing `deploy apply` command.

### OpenClaw (`openclaw/`)

- **`openclaw/scripts/config.mjs`** — Re-exports from `cli/lib/config.mjs`
- **`openclaw/scripts/*.mjs`** — Thin shims: `export { run } from "../../cli/lib/<name>.mjs"`
- **`openclaw/scripts/init.mjs`** — Calls CLI's `run()` at top level (executable script)

### Astro integration (`astro/`)

Sibling framework package — wires `@run402/sdk` into Astro's build pipeline. Independent release cadence from the SDK/CLI/MCP lockstep.

- **`src/index.ts`** — `run402(options?)` integration factory. Pure JS (must evaluate cleanly in vanilla Node so `astro.config.mjs` can load it before Vite is alive). Wires the Vite plugin into Astro's lifecycle and validates configuration up front.
- **`src/vite-plugin.ts`** — Scans `.astro` templates for `<Image>` references, dedupes by absolute path, uploads sources via the SDK's `assets.put`, and rewrites the component HTML with v1.49 variant URLs + blurhash.
- **`src/Image.astro`** — Component that emits the `<picture>` markup. Shipped as a separate subpath export (`@run402/astro/Image.astro`) because root must stay pure JS.
- **`src/manifest.ts`** — Runtime helpers for the `assetsDir` data-driven path: `resolveVariants(manifest, key)` (build-time manifest lookup) and `renderPicture(ref, opts)` (HTML emitter). The renderer also serves the recommended **AssetRef-persistence pattern**: consumers persist the full `AssetRef` returned by `r.assets.put` in their data rows and call `renderPicture(row.image, opts)` directly with no manifest lookup, no cache, and no synchronization layer. See [`astro/README.md`](astro/README.md) "Data-driven consumers" for the schema-shift example and trade-offs.
- **`src/picture-builder.ts`** — Pure HTML builder shared by the `.astro` component and the runtime `renderPicture` helper, so both paths emit identical CLS-safe markup.
- **Three entry points:** root (integration factory + types), `/Image.astro` (the component), `/manifest` (runtime helpers).

Published via OIDC Trusted Publisher (`.github/workflows/publish-astro.yml`) — triggered by the `/publish-astro` skill. Bumps independently of `run402-mcp` / `run402` / `@run402/sdk`.

### Tool Pattern

Every tool in `src/tools/` exports two things:
1. A Zod schema object (e.g., `provisionSchema`) defining input parameters
2. An async handler function (e.g., `handleProvision`) returning `{ content: [{type: "text", text: string}], isError?: boolean }`

Tools that require payment (provision, renew, deploy_site, deploy) return 402 payment details as **informational text** (not errors) so the LLM can reason about payment flow.

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

- **`SKILL.md`** (root) — MCP-host skill. Frontmatter `install: run402-mcp`. Body teaches the platform via MCP tool names (`provision_postgres_project`, `apply_expose`, `deploy_site_dir`, `assets_put`, …) in natural-language framings — no JSON tool-call blobs. Read by Claude Desktop / Cursor / Cline / Claude Code agents that already have the run402-mcp tools loaded.
- **`openclaw/SKILL.md`** — OpenClaw script-based skill. Frontmatter `install: run402` (the CLI). Body teaches the platform exclusively via `run402 <verb>` commands. Read by OpenClaw's script runner, where `openclaw/scripts/*.mjs` re-export from the CLI's lib.

`SKILL.test.ts` validates both files with shape-appropriate guards (root requires the run402-mcp install + 9 MCP tool names; openclaw requires the run402 CLI install + 7 CLI verbs). Both ban `setup_rls` / `get_deployment` / `projects rls` / `sites status` / `inherit:true` regressions. Run with `npm run test:skill`.

## Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `RUN402_API_BASE` | `https://api.run402.com` | API base URL (override for testing/staging) |
| `RUN402_CONFIG_DIR` | `~/.config/run402` | Local credential storage **base** directory. The `default` wallet lives here directly; named wallets live under `{base}/profiles/<name>/`. |
| `RUN402_WALLET` | `default` | Active named wallet (profile). Selects which wallet a command uses; the `--wallet <name>` flag overrides it, and a per-directory `.run402.json` binding sets it. `RUN402_PROFILE` is an accepted alias. |
| `RUN402_ALLOWANCE_PATH` | `{config_dir}/allowance.json` | Custom allowance (wallet) file path |

**Named wallets (profiles).** Hold multiple wallets on one machine via `run402 wallets` (`list`, `new <name>`, `use <name>`, `rename`, `bind`/`unbind`, `import`, `rm`). Selection precedence: `--wallet <name>` flag > `RUN402_WALLET` env > nearest `.run402.json`/`.run402.local.json` directory binding > global `wallets use` default > `default`. A `--wallet`/binding that conflicts with `RUN402_WALLET` is a hard error (pass `--wallet`, unset the env, or `wallets unbind`). The binding file holds only a wallet *name* (no key) and is safe to commit. Each wallet has its own `allowance.json`, `projects.json`, and non-secret `meta.json` under `profiles/<name>/`; the human-readable name surfaces in `run402 status`, `r.whoami()` (SDK), the MCP `status` tool, and — via a signed server-side label (`r.wallets.setLabel`/`getLabel`, gateway endpoint `/wallets/v1/:address/label`) — the operator console (WEB). The label push is on by default (`RUN402_WALLET_LABEL_SYNC=0` opts out). Core path resolution lives in `core/src/config.ts` (`getConfigBaseDir`/`getActiveProfile`/`getConfigDir`) + `core/src/profiles.ts`; CLI-edge resolution in `cli/lib/wallet-context.mjs`.
