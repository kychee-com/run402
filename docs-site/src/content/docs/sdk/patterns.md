---
title: "The patterns"
description: "Native SDK reference — patterns."
order: 70
---

## The patterns

### Paste-and-go assets — content-addressed URLs with SRI

`r.assets.put` returns an `AssetRef`:

```ts
const logo = await (await r.project(projectId)).assets.put("logo.png", { bytes });

logo.cdnUrl        // → "https://pr-<public_id>.run402.com/_blob/logo-3a7fc02e.png"
logo.sri           // → "sha256-…" for <script integrity="…">
logo.etag          // → strong "sha256-<hex>" ETag
logo.cacheKind     // → "immutable" | "mutable" | "private"
```

The URL is content-addressed and served through CloudFront. No cache-invalidation choreography needed. The browser refuses execution on byte mismatch via SRI.

`immutable: true` is the default. The SDK always computes and sends the object SHA-256 because upload sessions require it; pass `false` only when you specifically need mutable URL/cache semantics (the returned `cdnUrl` and `sri` are then `null`).

**Binary files are bytes, never strings.** In Node, call `readFile(path)`
without an encoding; in a browser, read `File.arrayBuffer()`. Do not use
`readFile(path, "utf8")`, `Blob.text()`, or another text decoder for PNG,
WASM, fonts, audio, video, archives, or other binary formats and then hash or
re-encode that string. CAS verifies the submitted bytes against their hash; it
cannot reconstruct bytes discarded by an earlier UTF-8 decode. String sources
for known binary keys/MIME types fail locally before network traffic with
`BINARY_CONTENT_REQUIRES_BYTES`.

```ts
import { readFile } from "node:fs/promises";

const logoBytes = await readFile("./logo.png"); // Buffer is a Uint8Array
await (await r.project(projectId)).assets.put("logo.png", { bytes: logoBytes });
```

Raw `/content/v1` clients have the same obligation: compute `sha256` and
`size` from the original byte buffer, then PUT that exact buffer. The declared
`content_type` is metadata, not proof that the pre-hash bytes were decoded
correctly. Prefer `assets.put`, `fileSetFromDir`, `dir`, or `assets.uploadDir`
so the byte-safe path is automatic.

If you suspect cache staleness on a *mutable* URL, the SDK has helpers:

```ts
const blobUrl = "https://pr-….run402.com/_blob/avatar.png";
const diag = await (await r.project(projectId)).assets.diagnoseUrl( blobUrl);
//   diag.expectedSha256 / observedSha256 / cache.* / invalidation.* / hint

const fresh = await (await r.project(projectId)).assets.waitFresh( {
  url: blobUrl,
  sha256: expectedSha,
  timeoutMs: 60_000,
});
//   `fresh.fresh === false` on timeout — handle by switching to immutable
```

Don't call `waitFresh` on immutable URLs — they're correct from upload time.

### Unified apply — `r.project(id).apply`

The canonical primitive for any deploy (database + migrations + manifest + value-free secret declarations + functions + site + subdomain). Three layers:

```ts
// One-shot — most agents use this. Awaits to a terminal state.
const result = await (await r.project(spec.project)).apply(spec);

// Long-running with progress events. Events are a discriminated union on `type`.
const op = await (await r.project(spec.project)).apply.start(spec);
for await (const ev of op.events()) {
  console.log(ev.type, ev);
}
const final = await op.result();

// Resume by id (e.g. after an interrupted process or a 5xx).
const resumed = await (await r.project(projectId)).apply.resume(operationId);

// Lower-level steps for CLI debugging:
const pScoped = await r.project(spec.project);
const { plan: lowPlan, byteReaders } = await pScoped.apply.plan(spec);
await pScoped.apply.upload(lowPlan, { byteReaders });
if (!lowPlan.plan_id) throw new Error("Preview plans cannot be committed");
const committed = await pScoped.apply.commit(lowPlan.plan_id);

// Gateway-reviewed plan: no bytes uploaded and no release committed, but
// returns a require-able reviewed identity.
const { plan: reviewedPlan } = await pScoped.apply.plan(spec, { mode: "reviewedPlan" });
console.log(reviewedPlan.plan_id);          // plan_...
console.log(reviewedPlan.plan_fingerprint); // pfp_...

await pScoped.apply(spec, {
  requiredPlan: {
    planId: reviewedPlan.plan_id ?? "",
    planFingerprint: reviewedPlan.plan_fingerprint ?? undefined,
  },
});

// Legacy low-level debug preview remains available but is not require-able.
const { plan: debugPreview } = await pScoped.apply.plan(spec, { dryRun: true });
console.log(debugPreview.plan_id);       // null
console.log(debugPreview.operation_id);  // null
```

Release observability reads live on the scoped `deploy` namespace:

```ts
const p = await r.project(projectId);
const release = await p.apply.getRelease("rel_...", { siteLimit: 5000 });
const active = await p.apply.getActiveRelease();
const diff = await p.apply.diff({ from: "empty", to: "active", limit: 1000 });
```

`getRelease` / `getActiveRelease` return `ReleaseInventory` (`kind: "release_inventory"`, `state_kind: "current_live" | "effective" | "desired_manifest"`, site paths, `static_public_paths`, functions, secret keys, subdomains, materialized routes, applied migrations, `release_generation`, `static_manifest_sha256`, nullable `static_manifest_metadata`, `embedding` (the release's framing opt-in as catalog keys, or `null`; absent on an older gateway), and inventory warnings when returned). `site.paths` is the release static asset inventory; `static_public_paths[]` is the browser reachability inventory with `public_path`, `asset_path`, `reachability_authority`, `direct`, `cache_class`, `content_type`, and optional route metadata. `reachability_authority` explains whether reachability came from implicit file-path mode, explicit `site.public_paths`, or a route-only static alias. `static_manifest_metadata: null` means unavailable, not zero; when present it includes `file_count`, `total_bytes`, `cache_classes`, `cache_class_sources`, and `spa_fallback`. `diff` returns `ReleaseToReleaseDiff` (`kind: "release_diff"`) with `migrations.applied_between_releases`; secret and subdomain diffs have only `added` / `removed`, never `changed`; route diffs expose `routes.added` / `removed` / `changed`; `static_assets` exposes unchanged/changed/added/removed files, `newly_uploaded_cas_bytes`, `reused_cas_bytes`, `deployment_copy_bytes_eliminated`, `legacy_immutable_warnings`, `previous_immutable_failures`, and `cas_authorization_failures`.

#### `ReleaseSpec` shape

The full type is exported as `ReleaseSpec` from `@run402/sdk` and `@run402/sdk/node`. Sketch:

```
{
  $schema?: "https://run402.com/schemas/release-spec.v1.json", // editor metadata; stripped before planning
  project: "prj_…",                        // SDK field is `project`, not `project_id`
  base?: { release: "current" | "empty" } | { release_id: "rel_…" },
  database?: {
    migrations?: MigrationSpec[],          // each has exactly one of id or name, plus sql? | sql_ref?, checksum?, transaction?
    expose?: ExposeManifest,               // dark-by-default authorization manifest
    zero_downtime?: boolean,
  },
  secrets?: SecretsSpec,                   // { require?: string[], delete?: string[] }
  functions?: FunctionsSpec,               // { replace? } | { patch?: { set?, delete? } }
  site?: SiteSpec,                         // replace/patch, public_paths, embedding: { frame_ancestors: EmbeddingKey[] } | null
  subdomains?: SubdomainsSpec,             // { set? } | { add? } | { remove? }
  routes?: ReleaseRoutesSpec,              // null or { replace: RouteSpec[] }
  checks?: SmokeCheck[],
}
```

- Replace vs patch semantics per resource. `site.replace` = "this is the whole site" (files absent are removed). `site.patch.put` / `patch.delete` = surgical updates. `site.public_paths` is the browser reachability table and is separate from release asset paths: `{ mode: "explicit", replace: { "/events": { asset: "events.html", cache_class: "html" } } }` serves public `/events` from release asset `events.html`; in explicit mode `/events.html` is not public unless separately declared. `{ mode: "implicit" }` restores filename-derived public reachability and can widen access. Public-path-only site specs are deployable. Known static `cache_class` inputs are `html`, `immutable_versioned`, and `revalidating_asset`; preserve unknown strings returned by observability APIs. `functions` has the same replace/patch split. Secrets are declaration-only: use `r.project(id).secrets.set(key, { value })` for values, then `secrets.require[]` to assert keys exist and `secrets.delete[]` to remove keys at activation. `subdomains` supports exactly one mode per spec: `set` replaces the release's managed subdomain list, `add` appends without removing existing entries, and `remove` deletes named entries. Today `subdomains.set` accepts at most one subdomain per project; multi-subdomain `set` is rejected locally with `SUBDOMAIN_MULTI_NOT_SUPPORTED`. Top-level absence = leave untouched.
- FunctionSpec. `functions.replace` is the complete desired function map; `functions.patch.set` updates only listed functions, and `functions.patch.delete` removes listed names. Each function accepts `runtime?: "node22"`, exactly one code source (`source` for a single bundled module, or `files` plus `entrypoint` for multi-file functions), optional `config.timeoutSeconds`, optional `config.memoryMb`, optional required-id `triggers[]`, and the auth-gate fields `requireAuth` and `requireRole`. Schedule triggers use `{ id, type: "schedule", cron, run }`; `run` contains at least `event_type` and may include `payload`, `retry`, and `expires_after_seconds`. Each scheduled tick creates a durable function run. Email triggers use `{ id, type: "email", mailbox, events, run }`, where `mailbox` is a mailbox slug/id and `events` is any of `reply_received`, `delivery`, `bounced`, `complained`, `mailbox_suspended`; each matching email event creates a durable function run with the canonical event payload under `payload.event`. A `mailbox_suspended` trigger fires when the mailbox is abuse-suspended (payload event carries `suspended_reason`, `suspended_at`, `evidence`, `recovery_actions`) and executes independently of the suspended mailbox's send capability — the app observes its own outage without polling or a public webhook URL. In typed deploy configs, prefer `scheduleTrigger(...)` and `emailTrigger(...)`. `FunctionSpec` also accepts `deps?: string[]` (npm specs) under capability `apply-v1-function-deps`; the gateway installs and bundles them. `r.functions.deploy(..., { deps })` builds a one-function `functions.patch.set` and rides this same unified-apply path.
- Function-level auth gates. Each `FunctionSpec` carries two optional declarative fields enforced by the gateway before invocation:
  - `requireAuth?: boolean` — when `true`, gateway rejects callers without a valid project user JWT with `Run402DeployError`-shaped envelope or `401` at request time. No DB lookup. Independent from `requireRole`.
  - `requireRole?: RequireRoleSpec | null` — gateway resolves the caller's role from the project-schema table and rejects callers whose role is not in `allowed` with `403`. Implies authentication (no JWT → 401). Pass `null` in patch mode to remove an existing gate. `RequireRoleSpec` is `{ table: string; idColumn: string; roleColumn: string; allowed: string[]; cacheTtl?: number }`. All identifiers are unqualified; `cacheTtl` is seconds (default 60, max 600, 0 disables caching for instant-revocation paths).
  When a gate passes, the gateway injects `x-run402-user-id` (always when any gate ran) and `x-run402-user-role` (only when `requireRole` ran) into the request. In-function code reads them directly from `req.headers.get("x-run402-user-id")` / `req.headers.get("x-run402-user-role")`. The bare `getUserId(req)` / `getRole(req)` exports throw `R402_AUTH_UNKNOWN_EXPORT`. For the canonical cookie-session flow, use the `auth.*` namespace (see below). All `requireRole` blocks in a single release must share the same `(table, idColumn, roleColumn)` triple; mixed-table specs are rejected at plan time with `Run402DeployError.code === "INVALID_SPEC"`. The SDK does not validate gate shape — the gateway is authoritative. Missing table or column at activation throws `Run402DeployError.code === "DEPLOY_INVALID_ROLE_GATE"` (HTTP 422) before flipping the live release.
- Routes. `ReleaseRoutesSpec` is `undefined | null | { replace: RouteSpec[] }`. Omitted and `null` carry forward base routes; `{ replace: [] }` clears dynamic routes; `{ replace: [...] }` replaces the route table. `RouteSpec` is one entry: `{ pattern: string, methods?: RouteHttpMethod[], target: RouteTarget }`. Function targets are `{ type: "function", name: string }`; static route targets are `{ type: "static", file: string }` for exact method-aware static aliases, not ordinary clean URLs, rewrites, or redirects. Prefer `site.public_paths` for clean static URLs e.g. `/events -> events.html`; use static routes for cases like static `GET /login` plus function `POST /login`. Static targets require exact patterns only, methods `["GET"]` or `["GET","HEAD"]`, and a relative deployed asset path with no leading slash, wildcard, directory shorthand, query, or fragment. `methods` omitted means all supported methods for function routes; `methods: []` is invalid. Supported methods are exported as `ROUTE_HTTP_METHODS` and `RouteHttpMethod` (`GET`, `HEAD`, `POST`, `PUT`, `PATCH`, `DELETE`, `OPTIONS`). Function target names are materialized release function names.
- Strict validation is SDK-owned. `apply.plan/start/apply` reject unknown raw `ReleaseSpec` fields before normalization can drop them; only top-level `$schema` metadata is tolerated and stripped before the plan request. `project_id`, `subdomain`, `site.replcae`, `functions.replace.api.deps`, `functions.replace.api.config.schedule`, and similar typos are `Run402DeployError.code === "INVALID_SPEC"` before any hash/upload/plan request. Use `loadDeployManifest` / `normalizeDeployManifest` for CLI/MCP JSON that legitimately uses `project_id`, `{ path }`, base64 file entries, or migration `sql_path`.
- No-op specs fail locally. A spec with only `project` / `base`, or empty containers e.g. `site.replace: {}`, `functions.patch.delete: []`, `secrets.require: []`, or `subdomains.set: []`, throws `Run402DeployError.code === "MANIFEST_EMPTY"` before any network call. Delete-only patches with non-empty `delete` arrays still count as deployable.
- Tier preflight is local but gateway remains authoritative. After normalization and before manifest CAS upload or `/apply/v1/plans`, `apply.plan/start/apply` check literal function `config.timeoutSeconds`, `config.memoryMb`, schedule-trigger cron minimum interval, and scheduled-trigger count when computable. Failures are `Run402DeployError.code === "BAD_FIELD"` with `details.field`, `details.value`, `details.tier`, `tier_max` or `min_interval_minutes`, and `details.limit_source` (`tier_status` or `local_static_fallback`). Current caps: prototype 10s / 128 MB / 1 scheduled trigger / 15 min, hobby 30s / 256 MB / 3 / 5 min, team 60s / 512 MB / 10 / 1 min. `tier.status()` exposes `function_limits` / `limits.functions` when returned, including current scheduled usage.
- Plan warnings are structured. `PlanResponse.warnings` and `DeployResult.warnings` are `WarningEntry[]`; `apply()` emits `plan.warnings` and aborts before upload/commit when a warning requires confirmation unless broad `allowWarnings` is set or every blocking warning code is listed in `allowWarningCodes`. `MISSING_REQUIRED_SECRET` means set the affected keys with `r.secrets.set`, then retry. For `WILDCARD_ROUTE_EXCLUDES_MUTATION_METHODS`, prefer route-level `acknowledge_readonly: true` on intentionally read-only GET/HEAD final-wildcard function routes; use code-level allowance only after inspecting all affected entries.
- Deploy summaries are derived SDK helpers. `summarizeDeployResult(result: DeployResult): DeploySummary` is exported from `@run402/sdk` and `@run402/sdk/node`. It makes no gateway calls and summarizes only current reliable `DeployResult.diff` / `DeployResult.warnings` data: site path counts, CAS new/reused bytes, functions, migrations, routes, secrets, subdomains, and warning counts. Missing buckets are omitted, not zero-filled. It intentionally has no timings, client-side duration estimates, server phase estimates, or function old/new code hash fields.
- Safe release-race retries are automatic. For omitted/current-base specs, `apply()` re-plans and retries `BASE_RELEASE_CONFLICT` only when the gateway marks the error `safe_to_retry: true`. Pinned `base.release_id` and `{ release: "empty" }` stay caller-owned. Static activation/spec failures inside `activation_pending` throw immediately with gateway metadata preserved instead of polling until timeout. Pass `maxRetries: 0` to opt out.
- Plan envelopes are normalized. New gateways return `kind: "plan_response"` with `is_noop`, `summary`, `warnings`, `expected_events`, and resource buckets at top level. The SDK preserves those fields and also folds them into `PlanResponse.diff` for compatibility. Dry-run plans return `plan_id: null` and `operation_id: null` and cannot be uploaded or committed.
- Modern plan/diff types are split. Deploy plans may expose `PlanDiffEnvelope` with migration buckets `{ new, noop }`; release-to-release diffs expose `{ applied_between_releases }`. Migration checksum mismatch is a hard deploy error (`Run402DeployError`), not a normal successful diff bucket. Legacy flag-off plan arrays remain represented by `DeployDiff` for compatibility.

`WarningEntry` is a compatibility union. Legacy plan warnings used low/medium/high severity; deploy-observability warnings use info/warn/high severity with heuristic confidence. Shared fields:

```
{
  code: string,
  severity: "low" | "medium" | "high" | "info" | "warn",
  requires_confirmation: boolean,
  message: string,
  affected?: string[],
  details?: Record<string, unknown>,
  confidence?: "low" | "medium" | "high" | "heuristic",
}
```
- All bytes ride through CAS. Plan request bodies never carry inline bytes — only `ContentRef` objects. When the spec exceeds 5 MB JSON, the SDK uploads the manifest itself as a CAS object and references it (`manifest_ref` escape hatch — no body-size cliff).
- Server-authoritative manifest digest. The gateway returns the canonical digest; the SDK does not require byte-for-byte canonicalize agreement.

The Node entry adds `fileSetFromDir(path)` for filesystem byte sources:

```ts
import { run402, fileSetFromDir } from "@run402/sdk/node";

const r = run402();
const p = await r.project(projectId);
const result = await p.apply({
  site: { replace: await fileSetFromDir("./dist") },
  subdomains: { set: ["my-app"] },
});
```

`fileSetFromDir` walks the directory and returns an `FsFileSource`-backed `FileSet`. The deploy normalizer hashes and uploads each file lazily during `apply`, so collection does not load the tree into memory. Skips `.git/`, `node_modules/`, `.DS_Store`, dotenv/npmrc files, and private-key-like filenames by default. Pass `{ includeSensitive: true }` only when those files are intentional deploy artifacts. Symlinks throw.

The Node entry also owns the typed manifest adapter used by CLI/MCP:

```ts
import { loadDeployManifest, normalizeDeployManifest, run402 } from "@run402/sdk/node";

const r = run402();

const loaded = await loadDeployManifest("./run402.deploy.json");
await (await r.project(loaded.spec.project)).apply(loaded.spec, { idempotencyKey: loaded.idempotencyKey });

const inMemory = await normalizeDeployManifest({
  project_id: projectId,
  site: { patch: { put: { "index.html": { data: "<h1>hi</h1>" } } } },
});
await (await r.project(inMemory.spec.project)).apply(inMemory.spec, { idempotencyKey: inMemory.idempotencyKey });
```

`DeployManifestInput` is the agent-facing JSON shape: `project_id` becomes SDK `project`, `idempotency_key` is returned separately for deploy options, `{ data, encoding: "base64", content_type? }` decodes to bytes, `{ path, content_type? }` becomes a lazy `FsFileSource`, and `database.migrations[].sql_path` / `sql_file` are read as UTF-8 SQL. Each migration declares exactly one of `id` or `name`: use `id` for immutable versioned migrations, and `name` for generated/idempotent SQL whose compiled id should track content changes. Snake manifest fields such as `config.timeout_seconds`, `require_auth`, `require_role.id_column`, and `i18n.default_locale` normalize to the SDK's camelCase `ReleaseSpec`. `loadDeployManifest(path)` resolves relative paths against the manifest file's directory; `normalizeDeployManifest(input, { baseDir? })` defaults relative paths to `process.cwd()`. Manifest normalization is strict too: unknown fields are rejected instead of dropped, so a valid site deploy plus typoed `subdomain` cannot become a partial site-only deploy.

Route manifest example:

```ts
import { run402, type ReleaseSpec, type RouteSpec } from "@run402/sdk/node";

const r = run402();
const routes: RouteSpec[] = [
  { pattern: "/api/*", methods: ["GET", "POST", "OPTIONS"], target: { type: "function", name: "api" } },
  { pattern: "/admin", target: { type: "function", name: "admin" } },
  { pattern: "/admin/*", target: { type: "function", name: "admin" } },
  { pattern: "/login", methods: ["POST"], target: { type: "function", name: "auth" } },
];
const specWithRoutes: ReleaseSpec = {
  project: projectId,
  site: { replace: {
    "index.html": "<!doctype html><main id='app'></main>",
    "events.html": "<!doctype html><h1>Events</h1>",
  }, public_paths: { mode: "explicit", replace: { "/events": { asset: "events.html", cache_class: "html" } } } },
  functions: {
    replace: {
      api: { source: "export default async function handler(req) { const url = new URL(req.url); return Response.json({ ok: true, path: url.pathname }); }" },
      admin: { source: "export default async () => new Response('admin')" },
      auth: { source: "export default async () => new Response('login')" },
    },
  },
  routes: { replace: routes },
};
await (await r.project(specWithRoutes.project)).apply(specWithRoutes);
```

Route matching and routed HTTP contract:
- Release static asset paths and public browser paths are distinct. In the example, `events.html` is a release asset and `/events` is the public static URL declared by `site.public_paths`. In explicit mode, `/events.html` is not public unless separately declared. `{ mode: "implicit" }` restores filename-derived public reachability and can widen access.
- Exact patterns look like `/admin`; prefix wildcard patterns use a final `/*`, e.g. `/admin/*`.
- `/admin/*` does not match `/admin`, `/admin/`, `/admin.css`, or `/administrator`; deploy both `/admin` and `/admin/*` for a dynamic section root. `/admin` and `/admin/` are trailing-slash equivalents for exact matching.
- Prefer `site.public_paths` for ordinary clean static URLs e.g. `/events -> events.html`. Static route targets are exact, method-aware route-table aliases e.g. `{ pattern: "/events", methods: ["GET", "HEAD"], target: { type: "static", file: "events.html" } }`; `target.file` is a release asset path, not a public path, URL, CAS hash, rewrite, or redirect. In explicit public path mode, a route-only static alias can serve a private asset without making `/events.html` directly reachable.
- Avoid routing ordinary static files, wildcard static targets, leading-slash files, directory shorthand, broad method lists by default, and one-static-route-target-per-page route-table exhaustion.
- Query strings are ignored for matching and preserved in the handler's full public `req.url`.
- Exact routes beat prefix routes, longest prefix wins among prefixes, and method-compatible dynamic routes beat static assets.
- A method-specific `POST /login` route can coexist with static `GET /login` HTML. Unsafe method mismatch returns `405`, not SPA HTML.
- Matched dynamic routes fail closed: function/platform errors are returned and Run402 does not continue to static lookup.
- Routed browser ingress uses Node 22 Fetch Request -> Response. The handler receives `req.method` and full public `req.url` on managed subdomains, deployment hosts, and verified custom domains. The raw `run402.routed_http.v1` envelope is internal; do not write browser route handlers against it. Direct `/functions/v1/:name` remains API-key protected.
- Request/response bodies are capped at 6 MiB. Run402 adds no wildcard CORS, does not store routed dynamic responses in a shared cache, and adds `Cache-Control: private, no-store` plus `x-run402-cache: dynamic-bypass` when the function sets no cache header.
- The function owns application auth, CSRF for cookie-authenticated unsafe methods, CORS/`OPTIONS`, cookies, redirects, and not trusting spoofable forwarding headers.

Recipe — static home page + SPA shell. A SPA site ships `index.html` as the shell serving every unmatched route (match `spa_fallback`), so by default `GET /` serves the shell too. To serve a real static home page at `/` — real bytes under curl and without JavaScript — while keeping the shell for app routes, ship `home.html` at the site root alongside `index.html` and add an exact root static route alias:

```ts
const spaWithStaticHome: ReleaseSpec = {
  project: projectId,
  site: { replace: {
    "index.html": "<!doctype html><main id='app'></main><script src='/app.js'></script>",
    "home.html": "<!doctype html><h1>Welcome</h1><a href='/dashboard'>Open the app</a>",
    "app.js": "/* SPA bootstrap */",
  } },
  routes: { replace: [
    { pattern: "/", target: { type: "static", file: "home.html" } },
  ] },
};
await (await r.project(spaWithStaticHome.project)).apply(spaWithStaticHome);
```

- Route matching runs before all static resolution — including the implicit `/` -> `index.html` root mapping — and SPA-fallback derivation is independent of the route table. So `GET /` serves `home.html` (match `route_static_alias`), unmatched app routes e.g. `/dashboard` still serve the `index.html` shell (match `spa_fallback`), and named static pages keep serving unchanged (match `static_exact`).
- Root placement of `home.html` keeps its relative asset URLs resolving identically to the direct file and avoids the `STATIC_ALIAS_RELATIVE_ASSET_RISK` warning.
- Expected non-blocking plan lints: `STATIC_ALIAS_SHADOWS_STATIC_PATH` (warn — the alias overrides what `/` would otherwise serve; for this recipe that is accurate and expected, and the commit proceeds) and `STATIC_ALIAS_DUPLICATE_CANONICAL_URL` (info — `/home.html` stays directly reachable in implicit public-path mode; add `<link rel="canonical" href="https://<your-site>/">` to `home.html` if duplicate-content SEO matters).
- Omitting `routes` on later deploys carries the alias forward (informational `ROUTE_TARGET_CARRIED_FORWARD`); a pipeline that sends `routes.replace` must include the alias every time because replace is total.
- Verify with `p.apply.resolve({ url: "https://<your-site>/", method: "GET" })` (below) and confirm `match: "route_static_alias"` with `target_file: "home.html"`.

URL-first public diagnostics:

```ts
import {
  buildDeployResolveSummary,
  normalizeDeployResolveRequest,
  run402,
  type DeployResolveAuthorizationResult,
  type DeployResolveCasObject,
  type DeployResolveResponse,
  type DeployResolveResponseVariant,
} from "@run402/sdk/node";

const r = run402();
const request = normalizeDeployResolveRequest({
  project: projectId,
  url: "https://example.com/events?utm=x#hero",
  method: "GET",
});
const p = await r.project(projectId);
const resolution: DeployResolveResponse = await p.apply.resolve(request);
const summary = buildDeployResolveSummary(resolution, request);
const auth: DeployResolveAuthorizationResult | undefined = resolution.authorization_result ?? undefined;
const cas: DeployResolveCasObject | undefined = resolution.cas_object ?? undefined;
const variant: DeployResolveResponseVariant | undefined = resolution.response_variant ?? undefined;
console.log(summary.would_serve, summary.diagnostic_status, summary.match, request.ignored);
void auth; void cas; void variant;
```

`r.project(id).apply.resolve({ url, method })` also accepts lower-level `{ host, path?, method? }`. URL query strings/fragments are ignored for lookup and surfaced in `request.ignored`. When returned, `asset_path`, `reachability_authority`, and `direct` explain which release asset backs the public URL and whether reachability came from implicit file-path mode, explicit `site.public_paths`, or a route-only static alias. Stable-host diagnostics may also include `authorization_result`, `cas_object` (`sha256`, `exists`, `expected_size`, `actual_size`), hostname-specific `response_variant`, route/static fields e.g. `allow`, `route_pattern`, `target_type`, `target_name`, and `target_file`, plus `edge_propagation` (`status`, `claimed_at`, `kvs_synced_at`, `expected_visible_by`, `hint`). Current known `edge_propagation.status` literals are `settled`, `propagating`, and `sync_pending`; non-settled statuses add `edge_propagating` / `edge_sync_pending` warnings and next steps such as `retry_after_edge_propagation` or `retry_after_edge_sync`. Current known `match` literals are `host_missing`, `manifest_missing`, `active_release_missing`, `unsupported_manifest_version`, `path_error`, `none`, `static_exact`, `static_index`, `spa_fallback`, `spa_fallback_missing`, `route_function`, `route_static_alias`, and `route_method_miss`; preserve unknown future strings. Known `authorization_result` values include `authorized`, `not_public`, `not_applicable`, `manifest_missing`, `target_missing`, `active_release_missing`, `unsupported_manifest_version`, `path_error`, `missing_cas_object`, `unfinalized_or_deleting_cas_object`, `size_mismatch`, and `unauthorized_cas_object`. Known `fallback_state` values include `active_release_missing`, `unsupported_manifest_version`, and `negative_cache_hit`; preserve unknown future strings. `result` is diagnostic body status, not SDK HTTP transport status, so host misses can be successful calls with `would_serve: false`. Do not use resolve as a fetch, cache purge, or cache-policy oracle; branch on structured fields e.g. `cache_class`, `allow`, `cas_object`, and `edge_propagation`, and preserve unknown cache classes.

For post-deploy convergence checks, `DeployResult.edge` carries the gateway's edge block when returned by apply/commit polling. Call `p.apply.edgeCoherence(operationId)` to fetch the canonical report (`coherent`, pointer updates, probed paths, stale-release evidence, and `next_actions`), or `p.apply.waitEdgeCoherent(operationId, { timeoutMs, intervalMs, onPoll })` to poll until coherent or the timeout elapses. A non-coherent report is not a transport error; branch on `report.coherent` / `result.coherent` and inspect `report.paths[]`, `pending_count`, and `pointer_updates`.

Known route warning codes and recovery:

| Code | Meaning | Recovery |
|---|---|---|
| `PUBLIC_ROUTED_FUNCTION` | A route makes the target function public same-origin browser ingress. | Informational (`requires_confirmation: false`): it never blocks `apply` and needs no `allowWarningCodes` entry. Review app auth, CSRF, CORS/`OPTIONS`, and cookies; direct `/functions/v1/:name` remains API-key protected. Only warnings with `requires_confirmation: true` need `allowWarningCodes`. |
| `ROUTE_TARGET_CARRIED_FORWARD` | A carried-forward route still points at a base-release function target. | Inspect active routes with release observability and deploy `routes.replace` if the target should change. |
| `ROUTE_SHADOWS_STATIC_PATH` | A dynamic route shadows one static path. | Inspect warning details and active release routes; confirm only when intentional. |
| `WILDCARD_ROUTE_SHADOWS_STATIC_PATHS` | A prefix route shadows static paths. | Review affected paths, split exact routes if needed, and confirm only when intentional. |
| `METHOD_SPECIFIC_ROUTE_ALLOWS_GET_STATIC_FALLBACK` | Unmatched methods can fall back to static content. | Confirm static fallback is intended or add method coverage. |
| `WILDCARD_ROUTE_EXCLUDES_MUTATION_METHODS` | A wildcard function route only allows `GET`/`HEAD`. | Add mutation methods e.g. `POST`, omit methods for an API prefix, or set `acknowledge_readonly: true` on an intentionally read-only GET/HEAD final-wildcard function route. `allowWarningCodes` is a reviewed escape hatch; broad `allowWarnings` is last resort. |
| `ROUTE_TABLE_NEAR_LIMIT` | The route table is near the gateway/project limit. | Consolidate or remove routes before adding more. |
| `ROUTES_NOT_ENABLED` | Routes are not enabled for this project/environment. | Deploy without `routes` or request enablement; direct function invoke is not a browser-route substitute. |
| `STATIC_ALIAS_SHADOWS_STATIC_PATH` / `STATIC_ALIAS_RELATIVE_ASSET_RISK` | Route-only static alias conflicts with a direct public static path or has relative-asset risk. | Inspect active routes, `static_public_paths`, and the backing `asset_path`; prefer `site.public_paths` for ordinary clean URLs and confirm only when intentional. |
| `STATIC_ALIAS_DUPLICATE_CANONICAL_URL` / `STATIC_ALIAS_EXTENSIONLESS_NON_HTML` | Route-only static alias may duplicate another direct public path or expose extensionless non-HTML. | Use one canonical public path per page and reserve exact static route targets for method-aware aliases. |
| `STATIC_ALIAS_TABLE_NEAR_LIMIT` | Static route targets are near route-table limits. | Avoid one-static-route-target-per-page tables; consolidate. |

Runtime route failure codes to branch on: `ROUTE_MANIFEST_LOAD_FAILED` (manifest/propagation), `ROUTED_INVOKE_WORKER_SECRET_MISSING` (custom-domain Worker secret), `ROUTED_INVOKE_AUTH_FAILED` (internal invoke signature), `ROUTED_ROUTE_STALE` (selected route failed release revalidation), `ROUTE_METHOD_NOT_ALLOWED` (method mismatch), and `ROUTED_RESPONSE_TOO_LARGE` (body over 6 MiB).

#### Node deploy convenience

- `r.sites.deployDir(...)` — Node-only thin wrapper that uses `fileSetFromDir(dir)`, delegates to `apply`, and emits unified `DeployEvent` shapes.

### GitHub Actions OIDC — CI credentials + the same deploy primitive

CI/OIDC federation is deliberately credential-driven. Link a GitHub repository or environment once, then keep using `r.project(id).apply(...)`; the deploy namespace detects SDK-marked CI credentials internally. Do not invent an `r.ci.deployApply(...)` path and do not pass a public `ci` deploy flag.

The setup side is `r.ci` plus the Node-only signing helper. Use the SDK builders exactly; the gateway validates the SIWX Statement and Resource URI against golden vectors.

```ts
import {
  CI_GITHUB_ACTIONS_PROVIDER,
  V1_CI_ALLOWED_ACTIONS,
  V1_CI_ALLOWED_EVENTS_DEFAULT,
  run402,
  signCiDelegation,
} from "@run402/sdk/node";

const values = {
  project_id: projectId,
  subject_match: "repo:owner/name:ref:refs/heads/main",
  allowed_actions: V1_CI_ALLOWED_ACTIONS,
  allowed_events: V1_CI_ALLOWED_EVENTS_DEFAULT,
  // Optional: omit or [] for no CI route authority.
  // Use exact paths and/or final wildcard prefixes for route declarations.
  route_scopes: ["/admin", "/api/*"],
  github_repository_id: "123456789",
  expires_at: null,
  nonce: "0123456789abcdef0123456789abcdef",
};

const r = run402({ disablePaidFetch: true });
await r.ci.createBinding({
  ...values,
  provider: CI_GITHUB_ACTIONS_PROVIDER,
  signed_delegation: signCiDelegation(values),
});
```

Inside GitHub Actions, prefer `githubActionsCredentials({ projectId })`. It:
- Requires `permissions: id-token: write`
- Requests a GitHub OIDC token for `CI_AUDIENCE` (`https://api.run402.com`) unless overridden
- Calls `/ci/v1/token-exchange` without local auth
- Caches the Run402 session token until `expires_in - refreshBeforeSeconds` (default refresh cushion: 60 seconds)
- Marks the credential provider so deploy uses CI Bearer auth and never local `apikey` headers

```ts
import { githubActionsCredentials, run402, type ReleaseSpec } from "@run402/sdk/node";

const r = run402({
  credentials: githubActionsCredentials({ projectId }),
  disablePaidFetch: true,
});

const ciSpec: ReleaseSpec = {
  project: projectId,
  base: { release: "current" },
  site: { patch: { put: { "index.html": "<h1>ship</h1>" } } },
};

await (await r.project(ciSpec.project)).apply(ciSpec);
```

CI deploy restrictions are part of the client contract: allowed top-level fields are only `project`, `database`, `functions`, `site`, absent/current `base`, and `routes` authorized by the binding's `route_scopes`. Omitted or empty `route_scopes` preserves the original no-routes CI posture. `spec.secrets`, `spec.subdomains`, `spec.checks`, unknown future fields, non-current `base`, and oversized specs that would require `manifest_ref` are rejected before any upload or plan call. Non-CI deploy behavior is unchanged. Gateway planning enforces route diffs and returns `CI_ROUTE_SCOPE_DENIED` when a route declaration falls outside the delegated exact paths or final wildcard prefixes.

### Dark-by-default tables + the expose manifest

Tables you create are unreachable via `/rest/v1/*` until your manifest declares them with `expose: true`. The manifest is convergent — applying it twice is a no-op; items removed between applies have their policies, grants, triggers, and views dropped.

The manifest itself is a JSON object:

```json
{
  "$schema": "https://run402.com/schemas/manifest.v1.json",
  "version": "1",
  "tables": [
    { "name": "items", "expose": true, "policy": "user_owns_rows",
      "owner_column": "user_id", "force_owner_on_insert": true },
    { "name": "audit", "expose": false }
  ],
  "views": [
    { "name": "leaderboard", "base": "items", "select": ["user_id", "score"], "expose": true }
  ],
  "rpcs": [
    { "name": "compute_streak", "signature": "(user_id uuid)", "grant_to": ["authenticated"] }
  ]
}
```

Built-in policies: `user_owns_rows` (rows where `owner_column = auth.uid()`), `public_read_authenticated_write` (anyone reads, any auth user writes), `public_read_write_UNRESTRICTED` (fully open; requires `i_understand_this_is_unrestricted: true`), `custom` (provide `custom_sql`).

For `user_owns_rows`, `force_owner_on_insert: true` creates an idempotent per-table trigger named `<table>_set_owner` backed by `<table>_set_owner_fn`. The generated shape is:

```sql
CREATE OR REPLACE FUNCTION "<table>_set_owner_fn"() RETURNS trigger
LANGUAGE plpgsql AS $body$
BEGIN
  IF NEW."<owner_column>" IS NULL THEN
    NEW."<owner_column>" := auth.uid();
  END IF;
  RETURN NEW;
END;
$body$;

CREATE TRIGGER "<table>_set_owner"
  BEFORE INSERT ON "<table>"
  FOR EACH ROW EXECUTE FUNCTION "<table>_set_owner_fn"();
```

The trigger only fills omitted or explicit `null` owner values; it does not overwrite a non-null owner. Ordinary authenticated inserts still pass through the `WITH CHECK (owner_column = auth.uid())` policy, so an explicit different owner is rejected. `service_key` / service-role writes bypass RLS, but the trigger still runs; if the request has no JWT subject, `auth.uid()` is null, so admin writes should set `owner_column` explicitly when the row needs an owner.

**Preferred path: put the manifest object under `database.expose` in a v2 `ReleaseSpec`.** The gateway validates it against migration SQL and applies it atomically with the rest of the release.

**Non-mutating validation:** `r.projects.validateExpose(manifestOrJsonString, { project?, project_id?, migrationSql? })` validates the auth/expose manifest used by `database.expose` and `apply_expose`. With `project` / `project_id`, validation uses the live project schema through a server-authoritative endpoint; without it, validation is projectless. Invalid JSON strings return `{ hasErrors: true, errors, warnings }` instead of throwing. `migrationSql` is reference context only and is not executed as a PostgreSQL dry run. This is not deploy-manifest validation.

**Imperative path:** `r.projects.applyExpose(projectId, manifest)` POSTs the same JSON shape to `/projects/v1/admin/:id/expose`; `r.projects.getExpose(projectId)` reads the currently-applied manifest. Prefer `r.project(id).apply` for production deploys so schema migrations and expose policy land together, but the direct methods are useful for round-tripping an existing manifest.

### In-function helpers — `@run402/functions`

A separate package. Imported _inside_ a deployed serverless function, not by the SDK. Auto-bundled at deploy time (don't list `@run402/functions` in `--deps`). See <https://www.npmjs.com/package/@run402/functions> for full details.

```ts
import { db, adminDb, auth, email, ai, assets, getRoutedPaymentContext } from "@run402/functions";

export default async (req: Request) => {
  const user = await auth.requireUser();

  // No .eq("user_id", user.id) — RLS already binds the visitor's rows via run402.current_user_id();
  // the redundant filter is a deploy-fail (R402_AUTH_REDUNDANT_USER_FILTER).
  const mine = await db().from("items").select("*");
  await adminDb().from("audit").insert({ event: "items_read", user_id: user.id });
  return Response.json(mine);
};
```

- `db(req)` — caller-context. Forwards Authorization header. RLS applies.
- `adminDb()` — bypass RLS. Routes to `/admin/v1/rest/*`.
- `adminDb().sql(query, params?)` — raw parameterized SQL.
- `auth.user()` / `auth.requireUser()` — read the verified actor from the SSR runtime context. `auth.user()` returns `Actor | null`; `auth.requireUser()` returns `Actor` and throws (303 redirect for HTML / 401 envelope for JSON, decided by the gateway from the `Accept` header). `Actor` has `id`, `projectId`, `sessionId`, `email`, `emailVerified`, `authTime`, `amr`, `amrTimes`. Calling either taints the SSR ISR cache (the response now depends on per-request actor state). Do NOT catch the throw from `auth.requireUser()` — the platform decides response shape. Bare `getUser` / `getUserId` / `getRole` / `getSession` / `currentUser` / `getCurrentUser` / `getServerSession` exports throw `R402_AUTH_UNKNOWN_EXPORT` at runtime AND fail `run402 doctor` source scan at deploy.
- For per-user gating in functions OUTSIDE the cookie-session flow (a `requireAuth` / `requireRole` deploy-spec gate, not the SSR auth namespace), read the gateway-injected headers directly: `req.headers.get("x-run402-user-id")` / `req.headers.get("x-run402-user-role")`. The gateway strips inbound `x-run402-*` headers before injection, so the values are trustworthy. Returns `null` when no corresponding gate ran (function has no gate, only `requireAuth` declared without `requireRole`, or local-invoke outside the gateway).
- `getRoutedPaymentContext(req)` (`@run402/functions` 3.7+) — confirmed x402 payment context for priced routed function requests. Returns `{ scheme, paymentId, amountUsdMicros, payer, network, asset, payTo, transaction, settledAt }` or `null` for unpriced/direct/malformed calls. Use `payment.paymentId` for app-side idempotency.
- `ai.generateImage({ prompt, aspect? })` — project-billed runtime image generation for deployed functions. `aspect` is `"square" | "landscape" | "portrait"`; result is `{ image, content_type, aspect }` with base64 image bytes. Uses `RUN402_SERVICE_KEY` against `/ai/v1/generate-image`, not the wallet/x402 `/generate-image/v1` endpoint. Gateway rate limits and spend caps are project-owned; public routed functions should add app auth or their own rate limiting before calling it.
- `assets.put(key, source, opts?)` — runtime asset upload through `/apply/v1/service-asset-put`. Uses `RUN402_SERVICE_KEY`, shares the deploy-time CAS/activation substrate, and returns an SDK-compatible `AssetRef`.

The helper makes raw `fetch()` calls to the project's own gateway endpoints using ambient request context (`RUN402_PROJECT_ID` / `RUN402_SERVICE_KEY` baked at deploy time). It does NOT use `@run402/sdk`.
