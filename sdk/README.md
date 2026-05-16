# @run402/sdk

Typed TypeScript client for the [Run402](https://run402.com) API. The kernel shared by `run402-mcp`, the `run402` CLI, and (eventually) user-deployed functions. Every operation is a method on a resource namespace — `r.projects.provision()`, `r.blobs.put()`, `r.deploy.apply()`, `r.functions.deploy()`, …

```bash
npm install @run402/sdk
```

## Two entry points

| Import | Use when |
|---|---|
| `@run402/sdk/node` | Running in Node 22 with the local keystore + allowance. Auto-loads `~/.config/run402/projects.json` and signs x402 payments from `~/.config/run402/allowance.json`. Includes `r.sites.deployDir(dir)`, `fileSetFromDir(dir)`, `loadDeployManifest(path)`, and `normalizeDeployManifest(input)`. |
| `@run402/sdk` | Isomorphic — works in Node, Deno, Bun, V8 isolates. No filesystem access. Bring your own `CredentialsProvider` (a session-token shim, a remote vault, anything that resolves project keys + auth headers). |

## Quick start (Node)

```ts
import { run402 } from "@run402/sdk/node";

const r = run402();
const project = await r.projects.provision({ tier: "prototype" });
await r.blobs.put(project.project_id, "hello.txt", { content: "hi" });
```

That's it — credentials are read, x402 payments are signed, results are typed.

### Project-scoped sub-client

If you're working on a single project for the duration of a script, bind it once and skip the id arg on every call:

```ts
const p = await r.useProject(projectId);                                  // persists active project + returns scoped handle
await p.blobs.put("hello.txt", { content: "hi" });                        // no projectId arg
await p.functions.list();
await p.deploy.apply({ site: { replace: files({ "index.html": "<h1>hi</h1>" }) } });
```

`r.useProject(id)` writes the active project to the keystore (shared with concurrent CLI runs). For transient in-script scoping that does NOT mutate that state, use `r.project(id)` (or `r.project()` with no arg to resolve from whatever the keystore currently considers active).

## Quick start (isomorphic)

```ts
import { Run402 } from "@run402/sdk";

const r = new Run402({
  apiBase: "https://api.run402.com",
  credentials: {
    async getAuth() { return { Authorization: `Bearer ${session.token}` }; },
    async getProject(id) { return session.projects[id] ?? null; },
  },
});
```

The `CredentialsProvider` interface has two required methods (`getAuth`, `getProject`) plus optional ones (`saveProject`, `removeProject`, `setActiveProject`, `readAllowance`, `saveAllowance`, …) for hosts that want full sticky-default behavior.

## Namespaces (20)

| Namespace | Highlights |
|---|---|
| `projects` | `provision`, `delete`, `list`, `sql`, `rest`, `validateExpose`, `applyExpose`, `getExpose`, `getUsage`, `getSchema`, `info`, `keys`, `use`, `active`, `pin`, `getQuote` |
| `deploy` | **The unified deploy primitive (v1.34+).** `apply` / `start` / `resume` / `status` / `list` / `events` / `resolve` / `getRelease` / `getActiveRelease` / `diff` / `plan` / `upload` / `commit` |
| `ci` | GitHub Actions OIDC federation over `/ci/v1/*`: `createBinding`, `listBindings`, `getBinding`, `revokeBinding`, `exchangeToken`; plus canonical delegation helpers |
| `sites` | `deployDir` — Node entry only (`@run402/sdk/node`); thin wrapper over `r.deploy.apply` |
| `blobs` | `put` (returns `AssetRef` with `cdnUrl` / `sri` / `etag` / `cacheKind` and `scriptTag()`/`linkTag()`/`imgTag()` emitters), `get`, `ls`, `rm`, `sign`, `diagnoseUrl`, `waitFresh` |
| `functions` | `deploy`, `invoke`, `logs`, `update`, `list`, `delete` |
| `secrets` | `set`, `list`, `delete` |
| `subdomains` | `claim`, `list`, `delete` (most agents declare subdomains in `r.deploy.apply({ subdomains: { set: [...] } })` instead) |
| `domains` | `add`, `list`, `status`, `remove` |
| `email` | `createMailbox`, `getMailbox`, `deleteMailbox`, `send`, `list`, `get`, `getRaw`, `webhooks.*` |
| `senderDomain` | `register`, `status`, `remove`, `enableInbound`, `disableInbound` |
| `auth` | `requestMagicLink`, `verifyMagicLink`, `createUser`, `inviteUser`, `setUserPassword`, `settings`, passkey registration/login/list/delete helpers, `providers`, `promote`, `demote` |
| `apps` | `browse`, `getApp`, `fork`, `publish`, `listVersions`, `updateVersion`, `deleteVersion` |
| `tier` | `set`, `status` (tier pricing lives on `r.projects.getQuote()`) |
| `billing` | `createEmailAccount`, `linkWallet`, `tierCheckout`, `buyEmailPack`, `setAutoRecharge`, `checkBalance`, `getAccount`, `getHistory`, `balance`, `history`, `createCheckout` |
| `contracts` | `provisionWallet`, `getWallet`, `listWallets`, `setRecovery`, `setLowBalanceAlert`, `call`, `read`, `callStatus`, `drain`, `deleteWallet` |
| `ai` | `translate`, `moderate`, `usage`, `generateImage` |
| `allowance` | `status`, `create`, `export`, `faucet` |
| `service` | `status`, `health` (no auth, no setup — works on a fresh install) |
| `admin` | Operator/admin endpoints: messages/contact, per-project finance (`getProjectFinance`) |

CLI-style aliases are available for agent ergonomics: `r.image` aliases `r.ai`,
and common command names such as `r.billing.balance`, `r.auth.magicLink`,
`r.projects.schema`, `r.email.create`, and `r.contracts.setAlert` point at the
canonical camelCase methods.

### Casing in returned shapes

Two casings coexist by design — agents reading the type surface should
classify a field by the SHAPE it belongs to:

- **Raw API result shapes preserve the gateway's snake_case fields.** Examples:
  `ProvisionResult.project_id`, `ProvisionResult.anon_key`,
  `ProvisionResult.service_key`, `ProvisionResult.schema_slot`,
  `ProjectInfo.project_id`, `ProjectSummary.lease_expires_at`,
  `UsageReport.api_calls`, `SchemaReport.schema`. These mirror the HTTP
  response bodies one-to-one.
- **SDK-specific helper shapes use camelCase.** Examples:
  `AssetRef.cdnUrl` / `AssetRef.cacheKind` / `AssetRef.contentSha256`,
  `Run402DeployError.safeToRetry` / `operationId` / `mutationState`,
  every `DeployEvent` variant's discriminator (`type`, plus per-variant
  fields like `releaseId`, `urls`).

This split is intentional and stays through `1.x`. Doc examples in this
README and in `llms-sdk.txt` use the exact field names the types export —
copy them verbatim. CI fails any TypeScript-fenced example that accesses a
field that does not exist on the actual type.

> **Reference tables (in `llms-sdk.txt`) use plain code fences, not `ts`
> fences.** They document the type surface in compact form for visual
> scanning — they are not runnable programs and are exempt from CI
> type-checking. Runnable example snippets still use ```` ```ts ```` and are
> CI-gated against the published types.

## Patterns

### Paste-and-go assets — content-addressed URLs with SRI

`r.blobs.put` returns an `AssetRef`. The `cdnUrl` is content-addressed (`pr-<public_id>.run402.com/_blob/<key>-<8hex>.<ext>`), served through CloudFront, and never needs cache invalidation. The browser refuses execution on byte mismatch via SRI:

```ts
const logo = await r.blobs.put(projectId, "logo.png", { bytes });
//   logo.cdnUrl     → drop into <img src="…">
//   logo.sri        → "sha256-…" for <script integrity="…">
//   logo.etag       → strong "sha256-<hex>"
//   logo.cacheKind  → "immutable" | "mutable" | "private"
```

`immutable: true` is the default since v1.45. The SDK always computes and sends the object SHA-256 because upload sessions require it; pass `false` only when you specifically need mutable URL/cache semantics.

For custom resumable upload UX, use the low-level session primitives:
`r.blobs.initUploadSession(...)`, `r.blobs.getUploadSession(...)`, and
`r.blobs.completeUploadSession(...)`. Bytes still go directly to the presigned
part URLs; the Run402 gateway sees only session metadata.
Low-level callers must provide the whole-object `sha256`, send per-part checksums to S3 when the presigned URL requires them, and include each part's `sha256` at completion.

### Expose manifest validation

Validate the auth/expose manifest used by `manifest.json`, `database.expose`, and `apply_expose` before mutating a project:

```ts
const manifest = { version: "1" as const, tables: [] };
const result = await r.projects.validateExpose(manifest, {
  project: projectId,                  // optional live-schema context
  migrationSql: "create table items (id bigint primary key);",
});

if (result.hasErrors) console.log(result.errors);
```

`migrationSql` is reference context only; it is not executed as a PostgreSQL dry run. This method validates authorization manifests, not deploy manifests.

### Unified deploy (v1.34+) — `r.deploy.apply`

The canonical primitive for any deploy (database + migrations + manifest + value-free secret declarations + functions + site + subdomain). Three layers:

```ts
import { run402, summarizeDeployResult, type ReleaseSpec } from "@run402/sdk/node";

const r = run402();
const spec: ReleaseSpec = {
  project: "prj_...",
  site: {
    patch: {
      put: {
        "index.html": "<h1>Hello</h1>",
        "events.html": "<h1>Events</h1>",
      },
    },
    public_paths: {
      mode: "explicit",
      replace: { "/events": { asset: "events.html", cache_class: "html" } },
    },
  },
};

// One-shot — most agents use this.
const result = await r.deploy.apply(spec);
const summary = summarizeDeployResult(result);
console.log(summary.headline);

// Long-running with progress events. Events are a discriminated union on `type`.
const op = await r.deploy.start(spec);
for await (const ev of op.events()) console.log(ev.type);
const final = await op.result();

// Resume a previously-started deploy by id.
const resumed = await r.deploy.resume("op_...");
```

- **All bytes ride through CAS.** The plan request body never carries inline bytes — only `ContentRef` objects. When the spec exceeds 5 MB JSON, the SDK uploads the manifest itself as a CAS object (`manifest_ref` escape hatch).
- **Per-resource semantics on the spec.** `site.replace` = "this is the whole site" (files absent are removed). `site.patch.put` / `patch.delete` are surgical updates. `site.public_paths` controls browser-visible static paths separately from backing release asset paths: explicit mode uses a complete map such as `{ "/events": { asset: "events.html", cache_class: "html" } }`, so `/events` serves `events.html` while `/events.html` is not public unless separately declared. Implicit mode restores filename-derived reachability and can widen access. A public-path-only site spec is deployable. `functions.replace` / `functions.patch.set` / `functions.patch.delete` mirror that. Secrets are value-free: set values first with `r.secrets.set(project, key, value)`, then deploy with `secrets.require` and/or `secrets.delete`. `subdomains.set` / `subdomains.add` / `subdomains.remove` use their own shape. Top-level absence = leave untouched.
- **Same-origin web routes.** `routes` is `undefined | null | { replace: RouteSpec[] }`. Omit it or pass `null` to carry forward base routes, pass `{ replace: [] }` to clear routes, or pass route entries to replace the table. Function targets use `{ type: "function", name }`; exact static route targets use `{ type: "static", file }` with methods `["GET"]` or `["GET","HEAD"]`, no wildcard pattern, and a relative deployed asset path with no leading slash. `file` is not a public path, URL, CAS hash, rewrite, or redirect. Prefer `site.public_paths` for ordinary clean static URLs like `/events -> events.html`; use static route targets for method-aware aliases such as static `GET /login` plus function `POST /login`. Routed browser ingress invokes Node 22 Fetch Request -> Response handlers; `req.url` is the full public URL on managed subdomains, deployment hosts, and verified custom domains. Direct `/functions/v1/:name` invocation remains API-key protected. Runtime route failure codes include `ROUTE_MANIFEST_LOAD_FAILED`, `ROUTED_INVOKE_WORKER_SECRET_MISSING`, `ROUTED_INVOKE_AUTH_FAILED`, `ROUTED_ROUTE_STALE`, `ROUTE_METHOD_NOT_ALLOWED`, and `ROUTED_RESPONSE_TOO_LARGE`.
- **Strict spec validation happens before network calls.** Raw `ReleaseSpec` objects reject unknown fields (for example `project_id` or `subdomain`) instead of silently dropping them during normalization, and project/base-only or empty nested specs fail with `Run402DeployError.code === "MANIFEST_EMPTY"`. Use the Node manifest helpers when starting from CLI/MCP-style JSON.
- **Tier preflight happens before deploy side effects.** After normalization and before manifest CAS upload or `/deploy/v2/plans`, deploy checks literal function timeout, memory, cron minimum interval, and scheduled-function count when known. Violations throw `Run402DeployError.code === "BAD_FIELD"` with `details.field`, `details.value`, `details.tier`, the relevant cap, and `details.limit_source`; gateway validation remains authoritative.
- **Warnings are structured.** `DeployResult.warnings` contains `WarningEntry[]` (`code`, `severity`, `requires_confirmation`, `message`, optional `affected`/`details`/`confidence`); the type preserves legacy low/medium/high plan warnings and modern deploy-observability info/warn/high warnings. `apply()` emits `plan.warnings` and stops before upload/commit on confirmation-required warnings unless broad `allowWarnings` is set or every blocking code is listed in `allowWarningCodes`. For `MISSING_REQUIRED_SECRET`, set the affected keys with `r.secrets.set`, then retry.
- **Deploy summaries are SDK-owned convenience.** `summarizeDeployResult(result)` returns `DeploySummary` (`schema_version: "deploy-summary.v1"`) with a headline plus reliable current buckets for site path counts, CAS new/reused bytes, functions, migrations, routes, secrets, subdomains, and warning counts. It is derived from `DeployResult.diff` / `DeployResult.warnings`; it makes no extra gateway calls, omits sections the gateway did not return, and intentionally excludes timings, client-side duration estimates, and function old/new code hashes.
- **Safe release-race retries are SDK-owned.** `deploy.apply()` automatically re-plans and retries omitted/current-base specs when the gateway returns `BASE_RELEASE_CONFLICT` with `safe_to_retry: true`. Static activation/config failures reported from `activation_pending` throw immediately with gateway metadata preserved. The default retry budget is two retries after the initial attempt; pass `{ maxRetries: 0 }` to opt out.
- **Planning supports dry-runs.** `r.deploy.plan(spec, { dryRun: true })` calls the server-authoritative dry-run route and returns the normalized v2 plan envelope without uploading bytes or creating plan/operation rows (`plan_id` and `operation_id` are `null`).
- **Release observability is typed.** Use `r.deploy.getRelease({ project, releaseId, siteLimit? })`, `r.deploy.getActiveRelease({ project, siteLimit? })`, and `r.deploy.diff({ project, from, to, limit? })` to inspect release inventory and release-to-release diffs. Inventories include `release_generation`, `static_manifest_sha256`, nullable `static_manifest_metadata` (`file_count`, `total_bytes`, `cache_classes`, `cache_class_sources`, `spa_fallback`), and `static_public_paths[]` when returned. `site.paths` lists release static assets; `static_public_paths[]` lists browser reachability with `public_path`, `asset_path`, `reachability_authority`, `direct`, cache class, and content type. `diff` returns `ReleaseToReleaseDiff` with `migrations.applied_between_releases`; secret diffs expose keys only; `static_assets` exposes unchanged/changed/added/removed files, CAS byte reuse, eliminated deployment-copy bytes, and immutable/CAS warning counts.
- **Server-authoritative manifest digest** — no byte-for-byte canonicalize requirement on the client.
- The Node entry adds `fileSetFromDir(path)` for filesystem byte sources:

  ```ts
  import { run402, fileSetFromDir } from "@run402/sdk/node";
  const r = run402();
  await r.deploy.apply({
    project: projectId,
    site: { replace: await fileSetFromDir("./dist") },
    subdomains: { set: ["my-app"] },
  });
  ```

  `fileSetFromDir` skips `.git/`, `node_modules/`, `.DS_Store`, dotenv/npmrc files, and private-key-like filenames by default; pass `{ includeSensitive: true }` only when those files are intentional deploy artifacts.

- Route manifests are ordinary deploy specs:

  ```ts
  import { run402, type RouteSpec, type ReleaseSpec } from "@run402/sdk/node";

  const r = run402();
  const routes: RouteSpec[] = [
    { pattern: "/api/*", methods: ["GET", "POST", "OPTIONS"], target: { type: "function", name: "api" } },
    { pattern: "/admin", target: { type: "function", name: "admin" } },
    { pattern: "/admin/*", target: { type: "function", name: "admin" } },
    { pattern: "/login", methods: ["POST"], target: { type: "function", name: "auth" } },
  ];
  const spec: ReleaseSpec = {
    project: projectId,
    functions: {
      replace: {
        api: { source: "export default async function handler(req) { const url = new URL(req.url); return Response.json({ ok: true, path: url.pathname }); }" },
        admin: { source: "export default async () => new Response('admin')" },
        auth: { source: "export default async () => new Response('login')" },
      },
    },
    site: { replace: {
      "index.html": "<!doctype html><main id='app'></main>",
      "events.html": "<!doctype html><h1>Events</h1>",
    }, public_paths: { mode: "explicit", replace: { "/events": { asset: "events.html", cache_class: "html" } } } },
    routes: { replace: routes },
  };

  await r.deploy.apply(spec);
  ```

  Matching is exact or final `/*` prefix only. `/admin/*` does not match `/admin`; deploy both `/admin` and `/admin/*` when the section root is dynamic. Release static asset paths and public browser paths are distinct. In the example, `events.html` is a release asset and `/events` is the public static URL declared by `site.public_paths`; `/events.html` is not public in explicit mode unless separately declared. A route-only static alias looks like `{ pattern: "/events", methods: ["GET", "HEAD"], target: { type: "static", file: "events.html" } }`; prefer `site.public_paths` for ordinary clean URLs and reserve static route targets for exact method-aware route-table behavior. Avoid routing every static file, wildcard static targets, leading-slash files, directory shorthand, broad method lists by default, and one-static-route-target-per-page route-table exhaustion. Query strings are ignored for matching and preserved in the handler's full public `req.url`. Exact beats prefix, longest prefix wins, and method-compatible dynamic routes beat static files. A method-specific `POST /login` route lets static `GET /login` serve HTML. Unsafe method mismatch returns `405`; matched dynamic route failures do not fall back to static assets.

  Routed functions use Node 22 Fetch Request -> Response. `req.url` is the full public URL on managed subdomains, deployment hosts, and verified custom domains. The raw `run402.routed_http.v1` envelope is internal; direct `/functions/v1/:name` remains API-key protected.

- URL-first public diagnostics:

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
  const resolution: DeployResolveResponse = await r.deploy.resolve(request);
  const summary = buildDeployResolveSummary(resolution, request);
  const auth: DeployResolveAuthorizationResult | undefined = resolution.authorization_result ?? undefined;
  const cas: DeployResolveCasObject | undefined = resolution.cas_object ?? undefined;
  const variant: DeployResolveResponseVariant | undefined = resolution.response_variant ?? undefined;
  void auth; void cas; void variant;
  console.log(summary.would_serve, summary.match, request.ignored);
  ```

  `r.deploy.resolve({ project, url, method })` and scoped `p.deploy.resolve({ url, method })` also accept lower-level `{ project, host, path?, method? }`. URL query strings/fragments are ignored for lookup and surfaced in `request.ignored`. When returned, `asset_path`, `reachability_authority`, and `direct` explain which release asset backs the public URL and whether reachability came from implicit file-path mode, explicit `site.public_paths`, or a route-only static alias. Stable-host diagnostics may also include `authorization_result`, `cas_object` (`sha256`, `exists`, `expected_size`, `actual_size`), hostname-specific `response_variant`, and route/static fields such as `allow`, `route_pattern`, `target_type`, `target_name`, and `target_file`. Current known `match` literals are `host_missing`, `manifest_missing`, `active_release_missing`, `unsupported_manifest_version`, `path_error`, `none`, `static_exact`, `static_index`, `spa_fallback`, `spa_fallback_missing`, `route_function`, `route_static_alias`, and `route_method_miss`; preserve unknown future strings. Known `authorization_result` values include `authorized`, `not_public`, `not_applicable`, `manifest_missing`, `target_missing`, `active_release_missing`, `unsupported_manifest_version`, `path_error`, `missing_cas_object`, `unfinalized_or_deleting_cas_object`, `size_mismatch`, and `unauthorized_cas_object`. Known `fallback_state` values include `active_release_missing`, `unsupported_manifest_version`, and `negative_cache_hit`; preserve unknown future strings. `result` is diagnostic body status, not SDK HTTP transport status, so host misses can be successful calls with `would_serve: false`. Do not use resolve as a fetch, cache purge, or cache-policy oracle; branch on structured fields such as `cache_class`, `allow`, and `cas_object`, and preserve unknown cache classes.

  Route warning recovery:

  | Code | Why it matters | Recovery |
  |------|----------------|----------|
  | `PUBLIC_ROUTED_FUNCTION` | Function becomes public same-origin browser ingress. | Review app auth, CSRF, CORS/`OPTIONS`, and cookies; direct `/functions/v1/:name` remains API-key protected. Prefer `allowWarningCodes` after review; broad `allowWarnings` only after every warning was reviewed. |
  | `ROUTE_TARGET_CARRIED_FORWARD` | Carried-forward route still targets a base-release function. | Inspect active routes and deploy `routes.replace` if the target should change. |
  | `ROUTE_SHADOWS_STATIC_PATH` / `WILDCARD_ROUTE_SHADOWS_STATIC_PATHS` | Dynamic route shadows direct public static content. | Inspect warning details, active routes, `static_public_paths`, and resolve diagnostics; confirm only when intentional. |
  | `METHOD_SPECIFIC_ROUTE_ALLOWS_GET_STATIC_FALLBACK` | Unmatched methods can serve static content. | Confirm fallback is intended or add method coverage. |
  | `WILDCARD_ROUTE_EXCLUDES_MUTATION_METHODS` | Wildcard function route only allows `GET`/`HEAD`. | Add mutation methods such as `POST`, omit methods for an API prefix, or set `acknowledge_readonly: true` on an intentionally read-only GET/HEAD final-wildcard function route. |
  | `ROUTE_TABLE_NEAR_LIMIT` | Route table is near a limit. | Consolidate or remove routes. |
  | `ROUTES_NOT_ENABLED` | Routes are disabled for the project/environment. | Deploy without `routes` or request enablement; direct function invoke is not a browser-route substitute. |
  | `STATIC_ALIAS_SHADOWS_STATIC_PATH` / `STATIC_ALIAS_RELATIVE_ASSET_RISK` | Route-only static alias conflicts with a direct public static path or has relative-asset risk. | Inspect active routes, `static_public_paths`, and the backing `asset_path`; prefer `site.public_paths` for ordinary clean URLs and confirm only when intentional. |
  | `STATIC_ALIAS_DUPLICATE_CANONICAL_URL` / `STATIC_ALIAS_EXTENSIONLESS_NON_HTML` | Route-only static alias may duplicate another direct public path or expose extensionless non-HTML. | Use one canonical public path per page and reserve exact static route targets for method-aware aliases. |
  | `STATIC_ALIAS_TABLE_NEAR_LIMIT` | Static route targets are near route-table limits. | Avoid one-static-route-target-per-page tables; consolidate. |

- The Node entry also has the typed manifest adapter shared by CLI/MCP:

  ```ts
  import { loadDeployManifest, run402 } from "@run402/sdk/node";

  const r = run402();
  const { spec, idempotencyKey } = await loadDeployManifest("./run402.deploy.json");
  await r.deploy.apply(spec, { idempotencyKey });
  ```

  `loadDeployManifest(path)` parses JSON relative to the manifest file, maps
  agent-friendly `project_id` into `ReleaseSpec.project`, decodes base64 file
  entries, turns `{ path }` entries into lazy `FsFileSource` values, and reads
  migration `sql_path` / `sql_file`. It rejects unknown manifest fields before
  they can become partial deploys. Use `normalizeDeployManifest(input)` when the
  manifest object is already in memory.

### GitHub Actions OIDC — CI credentials drive deploy

The v1 CI path keeps the deploy primitive simple: link a GitHub repository once, then call the existing `r.deploy.apply` with CI-marked credentials. There is no separate `r.ci.deployApply` method and no public `ci: true` deploy option.

The CLI is the easiest setup path (`run402 ci link github`), but the SDK exposes the building blocks:

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
const signed_delegation = signCiDelegation(values);
await r.ci.createBinding({
  ...values,
  provider: CI_GITHUB_ACTIONS_PROVIDER,
  signed_delegation,
});
```

Inside GitHub Actions, use `githubActionsCredentials`. It reads GitHub's OIDC environment, exchanges the subject token through `r.ci.exchangeToken`, caches the Run402 session until `expires_in - refreshBeforeSeconds`, and marks the credentials so deploy uses CI Bearer auth:

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

await r.deploy.apply(ciSpec);
```

CI deploys intentionally allow only `project`, `database`, `functions`, `site`, absent/current `base`, and `routes` authorized by the binding's `route_scopes`. Omitted or empty `route_scopes` preserves the original no-routes CI posture. The SDK normalizes scopes, sends `route_scopes` only when non-empty, and still rejects `secrets`, `subdomains`, `checks`, unknown future top-level fields, non-current `base`, and specs large enough to require `manifest_ref` before upload/plan. Gateway planning enforces route diffs and can return `CI_ROUTE_SCOPE_DENIED`; re-link with covering exact scopes like `/admin` or final-wildcard scopes like `/api/*`, or deploy locally. Use the canonical builders (`buildCiDelegationStatement`, `buildCiDelegationResourceUri`) instead of hand-rolling SIWX text; gateway tests pin those strings as golden vectors.

### Errors

All failures throw subclasses of `Run402Error`. Every subclass carries a stable
`kind` discriminator string and an `isRun402Error` brand:

| Class | `kind` | When | Notable fields |
|---|---|---|---|
| `PaymentRequired` | `"payment_required"` | HTTP 402 | x402 payment requirements in `body` |
| `ProjectNotFound` | `"project_not_found"` | Project ID not in the credential provider | `projectId` |
| `Unauthorized` | `"unauthorized"` | HTTP 401 / 403 | — |
| `ApiError` | `"api_error"` | Other non-2xx responses | `status`, `body` |
| `NetworkError` | `"network_error"` | Fetch rejected with no HTTP response | `cause` |
| `LocalError` | `"local_error"` | Local-host issues (filesystem, signing) | `cause` |
| `Run402DeployError` | `"deploy_error"` | Structured envelope from the deploy state machine (v1.34+) | `code`, `phase`, `operationId`, `safeToRetry`, `mutationState`, `nextActions` |

**Branch with type guards, not `instanceof`.** `instanceof X` is an identity
check on the class object — it fails silently when the consumer's runtime
holds a different copy of the SDK (duplicate npm installs, bundler chunk
splits, ESM/CJS interop, V8-isolate realms). The exported guards
(`isPaymentRequired`, `isDeployError`, …) check `isRun402Error` + `kind`,
which is identity-free and survives all of those scenarios. `instanceof`
continues to work for back-compat in the simple single-copy case.

```ts
import {
  run402,
  isPaymentRequired,
  isDeployError,
  type ReleaseSpec,
} from "@run402/sdk/node";

declare const spec: ReleaseSpec;
const r = run402();

try {
  await r.deploy.apply(spec);
} catch (e) {
  if (isPaymentRequired(e)) {
    // e is narrowed to PaymentRequired
    // present payment requirements to the user — read e.body, e.context, etc.
  } else if (isDeployError(e)) {
    // e is narrowed to Run402DeployError.
    // deploy.apply auto-retries safe BASE_RELEASE_CONFLICT races for current-base specs.
    // Log the structured envelope for policy errors, exhausted retries, or caller-owned recovery.
  } else throw e;
}
```

`Run402Error.toJSON()` returns a canonical envelope, so `JSON.stringify(e)`
produces a populated structured object instead of the empty `"{}"` plain
`Error` produces. Use this for telemetry, MCP tool results, CLI JSON output,
and any inter-process boundary where the error needs to survive serialization.

#### Retry idempotent operations with `withRetry`

`withRetry(fn, opts?)` wraps any async call with exponential backoff. It uses
`isRetryableRun402Error` (the canonical "should I retry this?" policy: 408 /
425 / 429 / 5xx / `NetworkError` / gateway-flagged `retryable`) by default.
`safeToRetry` by itself is not a retry signal; it means the repeated mutation
should not duplicate or corrupt state, not that lifecycle/payment/auth gates
will become allowed without an action. Pair retries with the SDK method's own
`idempotencyKey` so retried mutations dedup server-side:

For `r.deploy.apply()`, safe `BASE_RELEASE_CONFLICT` release races are already
handled by the deploy namespace with a fresh plan and visible `deploy.retry`
events. Use `withRetry` for caller-owned retry policies around other operations,
or pass `maxRetries: 0` to `deploy.apply` when you want to handle deploy races
yourself.

```ts
import {
  run402,
  withRetry,
  isPaymentRequired,
  isDeployError,
  type ReleaseSpec,
} from "@run402/sdk/node";

declare const spec: ReleaseSpec;
const r = run402();

try {
  const release = await withRetry(
    () => r.deploy.apply(spec, { idempotencyKey: "deploy-2026-05-01" }),
    {
      attempts: 3,
      onRetry: (e, attempt, delayMs) =>
        process.stderr.write(`retry ${attempt} in ${delayMs}ms\n`),
    },
  );
  console.log(release.urls);
} catch (e) {
  if (isPaymentRequired(e)) {
    // ... present payment
  } else if (isDeployError(e)) {
    // log structured envelope for triage
    process.stderr.write(JSON.stringify(e) + "\n");
  } else throw e;
}
```

Defaults: 3 attempts (1 initial + 2 retries), 250 ms base delay, 5 s cap. Pass
a custom `retryIf` to override the default policy (e.g., retry on
`PaymentRequired` if your sandbox auto-funds). After exhausting attempts
`withRetry` throws the LAST error — your catch handler sees the original
structured envelope, not a wrapper.

The SDK never calls `process.exit`. Each interface (MCP tools, CLI, your code) wraps with its own error behavior.

## Stability

This package is on the `1.x` line. The CLI (`run402`), MCP server (`run402-mcp`), SDK (`@run402/sdk`), and `@run402/functions` release in lockstep at the same version. Pin an exact version in production dependencies.

## Other interfaces

`@run402/sdk` is the kernel that powers four sibling packages:

- [`run402`](https://www.npmjs.com/package/run402) — CLI (terminal / scripts / CI)
- [`run402-mcp`](https://www.npmjs.com/package/run402-mcp) — MCP server (Claude Desktop / Cursor / Cline / Claude Code)
- [`@run402/functions`](https://www.npmjs.com/package/@run402/functions) — in-function helper imported _inside_ deployed functions
- OpenClaw skill — script-based skill for OpenClaw agents

All five release in lockstep.

## Links

- HTTP API reference: <https://run402.com/llms.txt>
- CLI reference: <https://run402.com/llms-cli.txt>
- Run402: <https://run402.com>

## License

MIT
