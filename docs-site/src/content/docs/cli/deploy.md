---
title: "Deploying apps"
description: "Unified Apply: the ReleaseSpec manifest, site, functions, routes, public paths, migrations, secrets, warnings, rehearsal, CI/OIDC deploys, and release observability."
order: 2
slice: deploy
summary: "ReleaseSpec manifest: site, functions, routes, public paths, migrations, secrets, warnings, CI deploys"
---

Use `run402 up` for normal releases. The commands below expose advanced planning, apply, inspection and recovery primitives. They share the same release model; none promises to reverse committed database migrations.

## Deploying Apps

### Unified Apply

Canonical deploy primitive: CAS bytes (no inline-body cap), per-resource `replace`/`patch`, atomic multi-resource activation, resumable failures. SDK: `r.project(id).apply(...)`.

Runtime config tokens are opaque credentials: equivalent claims can have different ES256 signatures. Do not compare token strings to determine project identity; use `project_id` and `api_base`.

Your HTML never needs a pasted key: load `/_run402/config.js` and read `window.RUN402.anon_key` (see "Runtime config on every host"). Wire fields — manifests, plan and commit bodies — are `snake_case` (`content_type`, never `contentType`; `contentType` is only the in-function `assets.put` JS option).

Manifest format mirrors a v2 `ReleaseSpec`. For editor autocomplete, use top-level `"$schema": "https://run402.com/schemas/release-spec.v1.json"`; the CLI accepts that metadata and strips it before planning.

The example uses prototype-compatible function limits: 10 seconds and 128 MB. Larger values require a tier that supports them. `--check` validates locally; it does not certify the target organization's tier limits.

```json
{
  "$schema": "https://run402.com/schemas/release-spec.v1.json",
  "project_id": "prj_1741340000_42",
  "database": {
    "migrations": [
      {
        "id": "001_init",
        "sql": "CREATE TABLE IF NOT EXISTS items (id serial PRIMARY KEY, title text NOT NULL); INSERT INTO items (title) VALUES ('Buy groceries');"
      },
      {
        "name": "seed_items",
        "sql": "INSERT INTO items (title) SELECT 'Welcome' WHERE NOT EXISTS (SELECT 1 FROM items WHERE title = 'Welcome');"
      }
    ],
    "expose": {
      "version": "1",
      "tables": [
        { "name": "items", "expose": true, "policy": "public_read_authenticated_write" }
      ]
    }
  },
  "secrets": { "require": ["OPENAI_API_KEY"], "delete": ["OLD_KEY"] },
  "functions": {
    "replace": {
      "api": {
        "runtime": "node22",
        "source": { "data": "export default async (req) => new Response('ok')" },
        "config": { "timeout_seconds": 10, "memory_mb": 128 },
        "triggers": [{
          "id": "api_every_15m",
          "type": "schedule",
          "cron": "*/15 * * * *",
          "run": { "event_type": "api.tick", "payload": {} }
        }]
      }
    }
  },
  "site": {
    "replace": {
      "index.html": { "data": "<!doctype html><html>...</html>" },
      "assets/logo.png": { "data": "iVBORw0KGgo...", "encoding": "base64" }
    }
  },
  "subdomains": { "set": ["my-app"] },
  "routes": {
    "replace": [
      { "pattern": "/api/*", "methods": ["GET", "POST"], "target": { "type": "function", "name": "api" } }
    ]
  },
  "i18n": {
    "default_locale": "en",
    "locales": ["en", "es", "fr"],
    "detect": ["cookie:wl_locale", "accept-language"]
  }
}
```

File entries: bare UTF-8 string; `{ "data": "...", "encoding": "utf-8" | "base64", "content_type": "..." }`; or `{ "path": "dist/index.html", "content_type": "text/html" }`. `site.replace` / `site.patch.put` may also be `{ "__source": "local-dir", "path": "dist/client" }` for a static-site directory. Function `source` may be `{ "path": "dist/run402/functions/api.js" }`. `--manifest` relative paths resolve from manifest dir; `--spec`/stdin paths resolve from cwd. Authoring-only local paths and `__source` markers are stripped/staged before the apply request. Migrations may use `"sql_path"` / `"sql_file"` instead of `"sql"`. Each migration declares exactly one of `"id"` or `"name"`: use `id` for immutable versioned migrations, and `name` for generated/idempotent SQL whose compiled id should track content changes. CLI/MCP share SDK `normalizeDeployManifest`; JSON can become SDK-native `ReleaseSpec`. Strict adapter: only top-level `$schema` and app-kit evidence `x-run402-omitted_features` are ignored before planning; unknown fields/no-op specs fail (`"subdomain"`, `"site.replcae"`, `"functions.replace.api.deps"`, `"functions.replace.api.config.schedule"`).

Binary files are safe in every form. A `{ "path": ... }` entry is read from disk as bytes and uploaded as-is, never decoded as text, with the content type inferred from the extension (`.webp` → `image/webp`, `.png`, `.woff2`, `.pdf`, ...) unless `content_type` says otherwise; only a bare string is treated as UTF-8 text, and a string paired with a binary path or type is refused locally as `BINARY_CONTENT_REQUIRES_BYTES` before any request. So an image ships as `"sigil.webp": { "path": "assets/sigil.webp" }` next to `"index.html": { "path": "site/index.html" }`. To see what a manifest will ship before it ships, `run402 up --manifest run402.json --check` prints the preflight with `summary.site` (path count and a per-content-type tally) and makes no gateway call.

Function specs: `runtime: "node22"`, exactly one code source (`source` or `files`+`entrypoint`), `config.timeout_seconds`, `config.memory_mb`, and optional `triggers[]`. Schedule triggers require a stable `id`, `type: "schedule"`, 5-field `cron`, and nested `run: { event_type, payload?, retry?, expires_after_seconds? }`; each tick creates a durable function run. Email triggers use `{ id, type: "email", mailbox, events, run }`, where `mailbox` is a mailbox slug/id and `events` is any of `reply_received`, `delivery`, `bounced`, `complained`, `mailbox_suspended`; each matching email event creates a durable function run with the canonical event payload under `payload.event`. A `mailbox_suspended` trigger fires when the mailbox is abuse-suspended (payload event carries `suspended_reason`, `suspended_at`, `evidence`, `recovery_actions`) — the run executes independently of the suspended mailbox's send capability, so an app can observe its own outage without polling or a public webhook URL. `deps: string[]` works under `apply-v1-function-deps`; gateway installs/bundles. `run402 functions deploy --deps` builds one `functions.patch.set` and uses unified apply; legacy standalone deploy route removed.

Deploy preflights literal function caps after normalization before CAS upload/plan: timeout, memory, schedule-trigger cron interval, scheduled-trigger count. Local failures: `code: "BAD_FIELD"` with `details.field/value/tier`, limit (`tier_max` or `min_interval_minutes`), `details.limit_source` (`tier_status` or `local_static_fallback`). Current caps: prototype 10s/128 MB/1 scheduled trigger/15 min; hobby 30s/256 MB/3/5 min; team 60s/512 MB/10/1 min. `tier status` shows live caps/usage when returned.

Subdomains: one mode per deploy. `"set"` replaces release managed subdomains, `"add"` appends, `"remove"` deletes. Current gateway supports at most one `subdomains.set`; multi-set fails locally with `SUBDOMAIN_MULTI_NOT_SUPPORTED`.

Complete static site + function + route manifest:

```json
{
  "project_id": "prj_...",
  "site": { "replace": {
    "index.html": { "data": "<!doctype html><main id='app'></main><script>fetch('/api/hello')</script>" },
    "events.html": { "data": "<!doctype html><h1>Events</h1>" }
  }, "public_paths": {
    "mode": "explicit",
    "replace": {
      "/events": { "asset": "events.html", "cache_class": "html" }
    }
  } },
  "functions": {
    "replace": {
      "api": {
        "runtime": "node22",
        "source": { "data": "export default async function handler(req) { const url = new URL(req.url); return Response.json({ ok: true, path: url.pathname }); }" }
      },
      "login": {
        "runtime": "node22",
        "source": { "data": "export default async function handler(req) { return Response.json({ ok: true }); }" }
      }
    }
  },
  "routes": { "replace": [
    { "pattern": "/api/*", "methods": ["GET", "POST", "OPTIONS"], "target": { "type": "function", "name": "api" } },
    { "pattern": "/login", "methods": ["POST"], "target": { "type": "function", "name": "login" } }
  ] }
}
```

Static public paths: release asset paths and browser paths differ (`events.html` asset -> `/events` public URL). `mode: "explicit"` exposes only `public_paths.replace`; `/events.html` is not public unless declared. `mode: "implicit"` restores filename-derived reachability and can widen access; review warnings. Known `cache_class`: `"html"`, `"immutable_versioned"`, `"revalidating_asset"`; preserve unknown future strings. Public-path-only specs are deploy content: `{ "site": { "public_paths": { "mode": "explicit", "replace": {} } } }` removes direct public static URLs without changing assets.

Embedding (framing) opt-in: every your host denies framing (`frame-ancestors 'none'` + `X-Frame-Options: DENY`) unless the release declares `site.embedding.frame_ancestors`, a non-empty list of platform catalog **keys** (never raw origins). Catalog: `localhost` -> `http://localhost:*` and `http://127.0.0.1:*`. With it, every response of the host (site files, public paths, SPA fallback, routed functions, `/_run402/*`, on every edge) sends `Content-Security-Policy: frame-ancestors <expanded origins>` and no `X-Frame-Options`. Omitted on a later apply = carried forward from the base release (a one-file `site.patch` never re-denies); `null` = back to deny; unknown key, duplicate, empty array, or extra member -> `INVALID_SPEC` on `site.embedding.frame_ancestors` naming the valid keys. Embedding-only specs are deploy content: `{ "site": { "embedding": { "frame_ancestors": ["localhost"] } } }`. Readback: `release active` -> `embedding` (keys or `null`), `deploy resolve` -> `embedding`, and the host's `/_run402/config.json` -> `embedding: { frame_ancestors: [<origins>] } | null` with `Access-Control-Allow-Origin: *`. Inside a third-party frame the app's cookies are third-party (a session cookie without `SameSite=None; Secure` is not sent) and hosted-auth pages stay unframable.

Route semantics:
- Omit `routes` or pass `null` to carry forward; `{ "replace": [] }` clears; `{ "replace": [...] }` atomically replaces.
- Entries: `pattern`, optional non-empty `methods` (`GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS`), `target`. Function target: `{ "type": "function", "name": "<materialized function name>" }`. Prefer `site.public_paths` for ordinary clean static URLs. Static route target = exact, method-aware alias, e.g. `{ "pattern": "/events", "methods": ["GET", "HEAD"], "target": { "type": "static", "file": "events.html" } }`; `file` is release asset path, not public path/URL/CAS/rewrite/redirect. Static targets require exact patterns only, methods `["GET"]` or `["GET","HEAD"]`, no leading slash/wildcard/dir shorthand/query/fragment. Path-keyed maps like `"routes": { "/api/*": { "function": "api" } }` invalid.
- Exact patterns look like `/admin`; prefix wildcard patterns use final `/*`, like `/admin/*`. `/admin/*` does not match `/admin`, `/admin/`, `/admin.css`, or `/administrator`, so deploy both `/admin` and `/admin/*` for a dynamic section root.
- Query ignored for matching but preserved in full public `req.url`. Exact beats prefix; longest prefix wins; method-compatible dynamic routes beat static assets.
- `POST /login` can coexist with static `GET /login`; unsafe method mismatch returns 405, not SPA HTML. Matched dynamic failures fail closed; no static fallback.
- Routed ingress uses the Node 22 Fetch Request -> Response contract; `req.url` is full public URL across managed subdomains/hosts/custom domains. Derive OAuth origins from `new URL(req.url).origin`. `run402.routed_http.v1` envelope is internal. Direct `/functions/v1/:name` remains API-key protected. Function owns app auth, CSRF, CORS/`OPTIONS`, cookies, redirects, and forwarding-header hygiene.
- Anti-patterns: routing every static file, broad method lists by default, wildcard static route targets, leading-slash static files, directory shorthand, one-static-route-target-per-page route-table exhaustion, wildcard function routes shadowing direct public static paths, and confusing omitted/null `routes` with `routes: { "replace": [] }`.

Apply it:

```bash
run402 deploy apply --manifest app.json
```

Stdout final result includes `release_id`, `operation_id`, `urls`, etc. Stderr streams JSON-line progress events. `--quiet` / `--final-only` silence stderr while preserving stdout.

Recipe — static home page + SPA shell: a SPA site ships `index.html` as the shell serving every unmatched route (match `spa_fallback`), so by default `GET /` serves the shell too. To serve a real static home page at `/` — real bytes under curl and without JavaScript — while keeping the shell for app routes, ship `home.html` at the site root alongside `index.html`, add an exact root static route alias, and `run402 deploy apply --manifest app.json`:

```json
{
  "project_id": "prj_...",
  "site": { "replace": {
    "index.html": { "data": "<!doctype html><main id='app'></main><script src='/app.js'></script>" },
    "home.html": { "data": "<!doctype html><h1>Welcome</h1><a href='/dashboard'>Open the app</a>" },
    "app.js": { "data": "/* SPA bootstrap */" }
  } },
  "routes": { "replace": [
    { "pattern": "/", "target": { "type": "static", "file": "home.html" } }
  ] }
}
```

Route matching runs before all static resolution — including the implicit `/` -> `index.html` root mapping — and SPA-fallback derivation is independent of the route table. So `GET /` serves `home.html` (match `route_static_alias`), unmatched app routes like `/dashboard` still serve the `index.html` shell (match `spa_fallback`), and named static pages keep serving unchanged (match `static_exact`). Root placement of `home.html` keeps its relative asset URLs resolving identically to the direct file and avoids the `STATIC_ALIAS_RELATIVE_ASSET_RISK` warning. Expect two non-blocking plan lints: `STATIC_ALIAS_SHADOWS_STATIC_PATH` (warn — the alias overrides what `/` would otherwise serve; for this recipe that is accurate and expected, and the commit proceeds) and `STATIC_ALIAS_DUPLICATE_CANONICAL_URL` (info — `/home.html` stays directly reachable in implicit public-path mode; add `<link rel="canonical" href="https://<your-site>/">` to `home.html` if duplicate-content SEO matters). Omitting `routes` on later deploys carries the alias forward (informational `ROUTE_TARGET_CARRIED_FORWARD`); a pipeline that sends `routes.replace` must include the alias every time because replace is total. Verify with `run402 deploy resolve --project prj_123 --url https://<your-site>/ --method GET` and confirm `match: "route_static_alias"` with `target_file: "home.html"`.

Typed deploy configs are an authoring format for the same `deploy apply` and `up` verbs, not a separate command family. JSON data manifests (`run402.deploy.json`, `app.json`) may be auto-discovered. TypeScript/JavaScript configs are executable local code, so v1 requires explicit trust with `--manifest`:

```bash
run402 up --manifest run402.deploy.ts --check
run402 up --manifest run402.deploy.ts --print-spec
run402 up --manifest run402.deploy.ts --plan
run402 up --manifest run402.deploy.ts --require-plan plan_...
```

Mode contract:
- `--check`: local-only import/normalize/strict field validation plus local file checks. No gateway calls, uploads, tier/project creation, or `.run402/project.json` writes. Success is raw JSON with `mode: "check"` / `dry_run: true` on `up`, or `{ ok: true, mode: "check", project_id, manifest_path }` on `deploy apply`.
- `--print-spec`: advanced SDK-native inspection JSON; this is not a reloadable authoring manifest.
- `--print-manifest`: canonical snake_case authoring JSON, backed by `serializeDeployManifest`. Save it in the original manifest directory so relative paths keep their meaning. Reloading supported release inputs preserves selectors, file paths, content types and function configuration. Unsupported streams, dynamic directory references, environment-derived values, app/build resources or embedded secrets fail with `MANIFEST_EXPORT_UNSUPPORTED` and `details.field_paths`, with no partial output.

Local success includes `gateway_validated: false`, the app root, nullable target/provenance, file/source evidence counts, local route warnings and deferred gateway policy/quota/cost/secret/migration/content/drift checks. `up` carries this as `result.preflight`; primitive apply includes these fields in its check response. Unresolved intent directs selection before planning. Build output checks are deferred until an approved build. Explicit typed configs execute trusted local code; check/export never executes a build.
- `--plan`: gateway-reviewed plan, no upload or commit. Response includes `plan_id`, `plan_fingerprint`, `plan_expires_at`, `manifest_digest`, diff, warnings, and `next_actions[]`.
- `--require-plan <plan_id>`: exact reviewed apply. The SDK recompiles locally, verifies the reviewed plan before upload, then commit verifies again before release mutation. Add `--plan-fingerprint <fingerprint>` when it was returned by `--plan`.

`run402 up --plan` preserves the `up` surface in `next_actions[0].argv`, e.g. `["run402","up","--manifest","run402.deploy.ts","--require-plan","plan_..."]`. `run402 deploy apply --plan` returns a `deploy apply --require-plan` action. `--allow-warning` / `--allow-warnings` conflict with `--require-plan` because reviewed-plan approval already binds the exact warning/destructive sets. If `run402 up --check` sees only `run402.deploy.ts` and no JSON manifest, it fails with `EXECUTABLE_CONFIG_REQUIRES_EXPLICIT_MANIFEST` and a recovery action to rerun with `--manifest run402.deploy.ts --check`.

Minimal typed config:

```ts
import { defineConfig, dir, nodeFunction, sqlFile } from "@run402/sdk/config";

export default defineConfig(({ env }) => ({
  project: env.required("RUN402_PROJECT_ID"),
  database: { migrations: [sqlFile("db/001_init.sql")] },
  site: { replace: dir("dist"), public_paths: { mode: "implicit" } },
  functions: { replace: { api: nodeFunction("dist/functions/api.js") } },
  secrets: { require: ["OPENAI_API_KEY"] }
}));
```

Helper semantics: `dir()` walks files in stable path order, skips private/dev patterns by default like the existing directory deploy helpers, normalizes `/` separators, rejects symlinks, and infers content types. `file()` resolves relative to the config file directory. `sqlFile()` derives the migration id from the filename unless `id` is supplied; pass `{ name: "seed" }` for generated/idempotent SQL so the SDK compiles `<name>_<sha256(sql)[0:16]>` from post-build file bytes. `nodeFunction()` stages a Node 22 function from built JavaScript; TypeScript function source paths are rejected with `TYPESCRIPT_FUNCTION_REQUIRES_BUNDLE` until a deterministic bundler path is introduced.

Patch semantics — only the listed file changes:

```json
{
  "project_id": "prj_...",
  "site": { "patch": { "put": { "index.html": { "data": "<h1>v2</h1>" } } } }
}
```

Or via `--spec` for a one-line CLI invocation:

```bash
run402 deploy apply --spec '{"project_id":"prj_...","site":{"patch":{"delete":["old.html"]}}}'
```

Astro builds: `--dir <build-output>` reads `dist/run402/adapter.json` and merges build ReleaseSpec slices (site/functions/routes). Combine with `--manifest` for cross-cutting slices (database, secrets, subdomains, i18n):

```bash
# Astro-only: --dir is the whole spec source (requires @run402/astro installed)
run402 deploy apply --dir ./dist --project prj_...

# Astro + cross-cutting slices: --dir owns site/functions/routes, --manifest owns the rest
run402 deploy apply --dir ./dist --manifest run402.config.json --project prj_...
```

CLI dynamically imports `@run402/astro/release-slice` from the consuming project. Requires `@run402/astro >=1.2.1` + `@run402/sdk >=2.18.0`; older SDKs reject `FunctionSpec.class: 'ssr'`, helper preflights `R402_ASTRO_SDK_VERSION_TOO_OLD` with upgrade command. Helper bundles SSR server with esbuild into single `source`, marks it with `class: "ssr"` and `capabilities: ["astro.ssr.v1"]`, roots site at `build.client` (`dist/run402/client/`, NOT `dist/`), omits `routes` so gateway's SSR catch-all works and base routes carry forward (also CI-safe without route scopes), defaults `site.public_paths: { mode: "implicit" }`, and colocates `_assets-manifest.json` inside `build.client`. Missing/incompatible manifest errors: `R402_ASTRO_ADAPTER_MANIFEST_MISSING` / `R402_ASTRO_ADAPTER_MANIFEST_VERSION_UNSUPPORTED` with `hint`+`docs`. SDK equivalent: `buildAstroReleaseSlice`. Do not hand-roll `site`/`public_paths`; shipping `run402/adapter.json` or `run402/server/**` as site content means source rooted at `dist/` instead of `dist/run402/client/`; SDK rejects `ASTRO_ADAPTER_TREE_IN_SITE`, gateway warns `SITE_NO_REACHABLE_HTML`.

Stuck deploys: `activation_pending` (rare transient between SQL commit and pointer-swap) auto-resumes hourly. Static spec/config activation failures throw structured deploy errors promptly. Explicit resume:

```bash
run402 deploy resume <operation_id> [--project prj_...]
```

Gateway reruns only failed phase forward; SQL is never replayed.

Destructive apply recovery: `run402 deploy promote <release-id>` re-points live release at a prior ready row without re-running apply (no bytes/bundling/migration), just `internal.projects.live_release_id` pointer swap + ssr_cache flush.

```bash
# rel_old (good)  →  rel_new (bad, destructive)  →  promote back
run402 deploy promote rel_old_abc123 --project prj_xyz \
  --allow-warning MIGRATIONS_NOT_REVERSIBLE

# Promotion is origin-active when it returns; wait for public edge coherence.
run402 deploy verify --operation op_... --wait
```

Read `operation_id` from the promote result and pass it to `deploy verify`. Promote success means the origin pointer is active; mutable public URLs can still be converging. The additive `edge` block reports `state`, `expected_max_lag_seconds`, and pointer-update status. `edge.verify_url` is the direct operation-scoped HTTP verification endpoint.

Promote warnings/errors: `MIGRATIONS_NOT_REVERSIBLE` requires ack when target predates applied migrations; migrations remain applied against current schema. `FUNCTION_VERSION_MISMATCH` informational when overlapping names have different `code_hash` (Lambda code = current `$LATEST`). Rejects: `PROMOTE_TARGET_NOT_FOUND`, `PROMOTE_PROJECT_MISMATCH`, `PROMOTE_RELEASE_NOT_READY` (needs `ready|active|superseded`), `PROMOTE_NO_OP` (use `cache.invalidateAll`), `PROMOTE_WARNING_REQUIRES_ACK`.

Deploy history/observability:

```bash
run402 deploy list --project prj_... --limit 10
run402 deploy events <operation_id> --project prj_...
run402 deploy verify <operation_id> --project prj_... --wait --timeout 120
run402 deploy release active --project prj_... --site-limit 5000
run402 deploy release get rel_... --project prj_...
run402 deploy release diff --from empty --to active --project prj_... --limit 1000
run402 deploy diagnose --project prj_123 https://example.com/events --method GET
run402 deploy resolve --project prj_123 --url https://example.com/events?utm=x#hero --method GET
run402 deploy resolve --project prj_123 --host example.com --path /events --method GET
```

`list` -> `{ operations, cursor }`; SDK/MCP accept non-null cursor. `events` returns same `DeployEvent` shapes as inline apply events. `verify` calls the edge-coherence report endpoint and returns `{ status: "coherent"|"not_coherent", coherent, report }`; with `--wait`, stderr emits per-poll path summaries and exit code 2 means the report was valid but still not coherent before timeout.

`release active|get` -> `{ release: ReleaseInventory }`: metadata, `state_kind` (`current_live|effective|desired_manifest`), `site.paths` (capped by `--site-limit`), `static_public_paths`, functions, secret keys only, subdomains, routes, migrations, `release_generation`, `static_manifest_sha256`, nullable `static_manifest_metadata`, `i18n` (`{ defaultLocale, locales, detect }` or `null`), `embedding` (`{ frame_ancestors: [<catalog keys>] }` or `null`; absent on an older gateway), warnings. `static_public_paths[]` has `public_path`, `asset_path`, `reachability_authority`, `direct`, cache class, content type. `static_manifest_metadata: null` = unavailable; when present has `file_count`, `total_bytes`, `cache_classes`, `cache_class_sources`, `spa_fallback`. Verify i18n with `jq '.release.i18n'`; absent field (older gateway) = unknown, not null.

`release diff` -> `{ diff: ReleaseToReleaseDiff }`; `--from empty|active|release_id`, `--to active|release_id`. Migrations: `migrations.applied_between_releases`; secrets/subdomains: `added`/`removed`; routes: `added`/`removed`/`changed`; `static_assets`: unchanged/changed/added/removed plus `newly_uploaded_cas_bytes`, `reused_cas_bytes`, `deployment_copy_bytes_eliminated`, `legacy_immutable_warnings`, `previous_immutable_failures`, `cas_authorization_failures`.

`deploy diagnose` URL-first; `deploy resolve` lower-level SDK/endpoint parity. Use either `--url` OR `--host` + optional `--path`. Both output `status`, `would_serve`, `diagnostic_status`, `match`, `summary`, normalized `request`, `warnings`, `resolution`, `edge_propagation`, `next_steps`. URL query/fragment ignored for lookup and reported under `request.ignored`. `asset_path`, `reachability_authority`, `direct` identify backing release asset and whether implicit, explicit `site.public_paths`, or route-only alias. Host/path misses exit 0 if resolver succeeded; branch on `would_serve: false`.

Diagnostics may include `authorization_result`, `cas_object` (`sha256`, `exists`, `expected_size`, `actual_size`), `response_variant`, `allow`, `route_pattern`, `target_type`, `target_name`, `target_file`, and `edge_propagation` (`status`, `claimed_at`, `kvs_synced_at`, `expected_visible_by`, `hint`). Known `edge_propagation.status`: `settled`, `propagating`, `sync_pending`; non-settled statuses add warnings such as `edge_propagating` / `edge_sync_pending` and next steps to retry or run `run402 up verify`. Known `match`: `host_missing`, `manifest_missing`, `active_release_missing`, `unsupported_manifest_version`, `path_error`, `none`, `static_exact`, `static_index`, `spa_fallback`, `spa_fallback_missing`, `route_function`, `route_static_alias`, `route_method_miss`. Known `authorization_result`: `authorized`, `not_public`, `not_applicable`, `manifest_missing`, `target_missing`, `active_release_missing`, `unsupported_manifest_version`, `path_error`, `missing_cas_object`, `unfinalized_or_deleting_cas_object`, `size_mismatch`, `unauthorized_cas_object`. Known `fallback_state`: `active_release_missing`, `unsupported_manifest_version`, `negative_cache_hit`. Preserve unknown future strings. `result` = diagnostic body status, not HTTP transport. Resolve/diagnose is not fetch, purge, or cache-policy oracle.

Route warning guidance:

| Code | Meaning | Recover |
|---|---|---|
| `PUBLIC_ROUTED_FUNCTION` | Function becomes public same-origin browser ingress. | Informational (`severity: "info"`, `requires_confirmation: false`): it never blocks a deploy and needs no `--allow-warning`. Review app auth, CSRF, CORS/`OPTIONS`, and cookies; direct `/functions/v1/:name` remains API-key protected. Only warnings with `requires_confirmation: true` need `--allow-warning <code>`. |
| `ROUTE_TARGET_CARRIED_FORWARD` | Carried-forward route still targets a base-release function. | Inspect `run402 deploy release active` and deploy a replacement route table if needed. |
| `ROUTE_SHADOWS_STATIC_PATH` / `WILDCARD_ROUTE_SHADOWS_STATIC_PATHS` | Dynamic route shadows direct public static content. | Inspect warning details, active routes, `static_public_paths`, and resolve diagnostics; confirm only when intentional. |
| `METHOD_SPECIFIC_ROUTE_ALLOWS_GET_STATIC_FALLBACK` | Unmatched methods can serve static content. | Confirm fallback is intended or add method coverage. |
| `WILDCARD_ROUTE_EXCLUDES_MUTATION_METHODS` | Wildcard function route only allows `GET`/`HEAD`. | Add mutation methods e.g. `POST`, omit methods for an API prefix, or set `acknowledge_readonly: true` on an intentionally read-only GET/HEAD final-wildcard function route. `--allow-warning WILDCARD_ROUTE_EXCLUDES_MUTATION_METHODS` is a reviewed CLI escape hatch; broad `--allow-warnings` is last resort. |
| `ROUTE_TABLE_NEAR_LIMIT` | Route table is near a limit. | Consolidate or remove routes. |
| `ROUTES_NOT_ENABLED` | Routes are disabled for the project/environment. | Deploy without `routes` or request enablement; direct function invoke is not a browser-route substitute. |
| `STATIC_ALIAS_SHADOWS_STATIC_PATH` / `STATIC_ALIAS_RELATIVE_ASSET_RISK` | Route-only static alias conflicts with a direct public static path or has relative-asset risk. | Inspect active routes, `static_public_paths`, and the backing `asset_path`; prefer `site.public_paths` for ordinary clean URLs and confirm only when intentional. |
| `STATIC_ALIAS_DUPLICATE_CANONICAL_URL` / `STATIC_ALIAS_EXTENSIONLESS_NON_HTML` | Route-only static alias may duplicate another direct public path or expose extensionless non-HTML. | Use one canonical public path per page and reserve exact static route targets for method-aware aliases. |
| `STATIC_ALIAS_TABLE_NEAR_LIMIT` | Static route targets are near route-table limits. | Avoid one-static-route-target-per-page tables; consolidate. |

Runtime route failure codes: `ROUTE_MANIFEST_LOAD_FAILED` (manifest/propagation), `ROUTED_INVOKE_WORKER_SECRET_MISSING` (custom-domain Worker secret), `ROUTED_INVOKE_AUTH_FAILED` (internal invoke signature), `ROUTED_ROUTE_STALE` (release revalidation failed), `ROUTE_METHOD_NOT_ALLOWED`, `ROUTED_RESPONSE_TOO_LARGE` (>6 MiB).

**Routed functions: locale awareness.** `spec.i18n` negotiates locale per routed-function request and exposes `x-run402-locale` / `x-run402-default-locale` headers (omitted when active release lacks `i18n`). Carry-forward rules are simpler than routes; no `{ replace }` envelope:

```json
{
  "i18n": {
    "default_locale": "en",
    "locales": ["en", "es", "fr", "zh-Hant"],
    "detect": ["cookie:wl_locale", "accept-language"]
  }
}
```

- Omit `i18n` to carry forward from the base release; pass `"i18n": null` to clear the slice on the new release; pass `{ default_locale, locales, detect? }` to replace.
- `default_locale` must byte-match one `locales[]` entry; no silent canonicalization; CLI/SDK validate before planning.
- Locale tags must match `/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/` and RFC 5646 canonical casing: primary lowercase, script Titlecase, 2-alpha region uppercase, 3-digit region preserved, variants/extensions lowercase. Examples: `pt-BR`, `zh-Hant`, `zh-Hant-TW`, `de-1996`. Non-canonical deploy error: `R402_LOCALE_NOT_CANONICAL` (400) with `fix: { input, canonical }`. `locales[]` non-empty, max 50. No silent canonicalization because DB translation keys often use literal locale strings.
- Negotiation returns canonical casing from `locales[]`, NOT the request's casing.
- `detect[]` default `["accept-language"]`, max 10, `[]` = always default; first match wins. Sources: `"accept-language"` (RFC 9110 + RFC 4647 lookup truncation `zh-Hant-TW` -> `zh-Hant` -> `zh`; generic request tag does not match more specific configured tag, e.g. `es` not `es-MX`) and `"cookie:<name>"` (RFC 6265 name regex `/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/`, raw value matched case-insensitively).
- Static-route hits do NOT receive locale negotiation; only routed HTTP function invocations do.
- Run402 does NOT inject `Vary` headers — apps that return public-cacheable responses varying by locale must set their own `Vary` until per-locale edge caching ships.

Routed-function read pattern: single-arg `(req)`, not `(req, ctx)`; bundled runtime translates envelope to Web `Request`, so `context.locale` is not visible.

```ts
export default async (req) => {
  const locale = req.headers.get('x-run402-locale');
  const defaultLocale = req.headers.get('x-run402-default-locale');
  if (locale && locale !== defaultLocale) {
    return renderWithTranslations({ locale });
  }
  return renderBase({ locale: defaultLocale ?? 'en' });
};
```

Language switchers must write a cookie; `localStorage` only is invisible to server-side negotiation. Mirror locale to cookie and declare cookie source in `spec.i18n.detect`:

```js
function setLanguage(lang) {
  localStorage.setItem('wl_locale', lang);
  document.cookie =
    `wl_locale=${encodeURIComponent(lang)}; path=/; max-age=31536000; samesite=lax`;
}
```

Deploy with `"detect": ["cookie:wl_locale", "accept-language"]`.

Migration registry: key = `(id, checksum)`. There are two authoring kinds. Versioned migrations use `id`: same id+SQL = noop; same id+different SQL = `MIGRATION_CHECKSUM_MISMATCH`; if you revise one, ship a new id. Content-tracked migrations use `name`: the SDK compiles `<name>_<sha256(sql)[0:16]>`, so changed generated SQL applies once under a new id and unchanged re-ups noop. SQL declared with `name` MUST be idempotent (`CREATE TABLE IF NOT EXISTS`, `CREATE OR REPLACE`, upserts, `ADD COLUMN IF NOT EXISTS` in a `DO` block) because changed content re-runs against a database where prior versions may already exist. If generated SQL is trapped behind a static id mismatch, replace `"id": "seed"` with `"name": "seed"` as the primary recovery path; admin checksum adoption is only for legacy/out-of-band cases.

---
### GitHub Actions OIDC Deploys

Use this when the same repo should deploy itself from GitHub Actions without storing Run402 service keys, allowance files, or API keys in GitHub secrets. KISS rule: link once locally, then CI runs the same `run402 deploy apply` command agents already know.

Local setup:

```bash
run402 ci link github --project prj_... --manifest run402.deploy.json
run402 ci link github --project prj_... --manifest run402.deploy.json --route-scope /admin --route-scope /api/*
```

Full link syntax:

```bash
run402 ci link github \
  [--project <id>] \
  [--manifest <path>] \
  [--repo <owner/repo>] \
  [--branch <name> | --environment <name>] \
  [--repository-id <numeric_id>] \
  [--workflow <path>] \
  [--expires-at <iso_timestamp>] \
  [--route-scope <pattern> ...] \
  [--force]
```

Defaults:
- `--project`: active project
- `--manifest`: `run402.deploy.json`
- `--repo`: inferred from `git remote get-url origin`
- `--branch`: current branch from `git branch --show-current`
- `--workflow`: `.github/workflows/run402-deploy.yml`
- `--route-scope`: omitted by default, which means no CI route-declaration authority; repeat for exact paths like `/admin` or final wildcard prefixes like `/api/*`
- allowed events: fixed to `push` and `workflow_dispatch`
- allowed action: fixed to `deploy`

The command fetches GitHub's numeric repository id using `GITHUB_TOKEN` or `GH_TOKEN` when available. If lookup fails, pass `--repository-id <numeric_id>` explicitly. The subject is generated from `--branch` as `repo:<owner/repo>:ref:refs/heads/<branch>`, or from `--environment` as `repo:<owner/repo>:environment:<environment>`.

Generated workflow shape:

```yaml
name: Run402 Deploy

on:
  push:
    branches: ["main"]
  workflow_dispatch:

permissions:
  contents: read
  id-token: write

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Deploy to run402
        run: npx --yes run402@3.7.5 deploy apply --manifest 'run402.deploy.json' --project 'prj_...' < /dev/null
```

Output on success:

```json
{
  "binding_id": "cib_...",
  "project_id": "prj_...",
  "provider": "github-actions",
  "subject_match": "repo:owner/name:ref:refs/heads/main",
  "allowed_events": ["push", "workflow_dispatch"],
  "allowed_actions": ["deploy"],
  "route_scopes": ["/admin", "/api/*"],
  "github_repository_id": "123456789",
  "github_repository_id_status": "verified",
  "workflow_path": ".github/workflows/run402-deploy.yml",
  "manifest_path": "run402.deploy.json",
  "run402_version": "3.7.5",
  "delegation_chain_id": "eip155:84532",
  "bootstrap_caveat": "Commit the generated workflow and manifest before expecting GitHub Actions deploys.",
  "consent_summary": ["..."],
  "revocation_residuals": ["..."]
}
```

Management:

```bash
run402 ci list [--project <id>]
run402 ci revoke <binding_id>
```

`list` prints `{ "project_id": "...", "bindings": [...] }`.
`revoke` prints `{ "binding": {...}, "revoked": true, "revocation_residuals": [...] }`.

Intentional omissions in v1: no raw `--subject`, no wildcard flag, no `--allow-event`, no PR deploy flags, and no `--no-repository-id`. Use `--branch` or `--environment`; create a follow-up design before broadening trust.

CI deploy restrictions: when `run402 deploy apply` runs inside GitHub Actions with OIDC env vars present, it uses the GitHub subject token, exchanges it for a Run402 CI session, and skips the local allowance preflight. CI manifests may include only `project_id`, `database`, `functions`, `site`, absent/current `base`, and route declarations covered by the binding's `route_scopes`. Without `--route-scope`, CI cannot ship `routes`. CI cannot ship `secrets`, `subdomains`, `checks`, unknown future top-level fields, non-current base, or oversized manifests that require `manifest_ref`.

Common CI error codes:
- `invalid_token`: check `permissions: id-token: write` and the workflow's OIDC environment
- `access_denied`: no active binding matched this repo/branch/environment
- `binding_revoked`: a matching binding existed but was revoked (most often the project was transferred/handed off, which suspends the prior org's CI bindings) — re-run `run402 ci link github` to re-create it; do NOT run `set-asset-scopes` (it 409s on a revoked binding)
- `event_not_allowed`: v1 allows only `push` and `workflow_dispatch`
- `repository_id_mismatch`: re-link from the current repo or pass the correct numeric `--repository-id`
- `forbidden_spec_field` / `forbidden_plan`: remove disallowed CI manifest fields or run the deploy locally
- `CI_ROUTE_SCOPE_DENIED`: re-link with covering `--route-scope` patterns e.g. `/admin` or `/api/*`, or run the route-changing deploy locally
- `payment_required`: renew/upgrade/fund the project tier outside CI, then rerun the workflow

---
### Unified Deploy Details

Use `run402 deploy apply --manifest app.json` for full-stack releases; see the Unified Apply example above. Use `project_id`, `--project`, `RUN402_PROJECT_ID`, or an app-local `.run402/project.json` link. Global active state is never a deploy selector; conflicting selectors fail before mutations. Omitted top-level sections carry forward. Strict adapter: only top-level `$schema` ignored; typo/no-op fields fail before planning.

Function specs add auth gates:
- `require_auth: true`: valid project user JWT required; 401 on anonymous; no DB lookup; independent from `require_role`.
- `require_role: { table, id_column, role_column, allowed[], cache_ttl? } | null`: implies auth; gateway reads project-schema table with RLS bypass; 403 if role not in `allowed`; `null` removes gate in patch mode; `cache_ttl` default 60, max 600, 0 disables cache.
- Passing gate injects `x-run402-user-id` (any gate) and `x-run402-user-role` (`require_role`) into request; read headers directly or use `auth.*`.
- Validation: all `require_role` blocks in one release share `(table,id_column,role_column)`; schema-qualified identifiers rejected; `0 <= cache_ttl <= 600`; empty `allowed` rejected; missing table/column fails activation with `DEPLOY_INVALID_ROLE_GATE` (422) before live flip.

Auth-gate fragment:

```json
{
  "functions": {
    "patch": {
      "set": {
        "list-my-items": {
          "source": { "path": "functions/list.ts" },
          "require_auth": true
        },
        "delete-content": {
          "source": { "path": "functions/delete.ts" },
          "require_role": {
            "table": "members",
            "id_column": "user_id",
            "role_column": "role",
            "allowed": ["admin"],
            "cache_ttl": 60
          }
        },
        "moderate-content": {
          "source": { "path": "functions/moderate.ts" },
          "require_role": {
            "table": "members",
            "id_column": "user_id",
            "role_column": "role",
            "allowed": ["admin", "moderator"]
          }
        }
      }
    }
  }
}
```

Role reads (`@run402/functions` 3.4.0+, `{ from }` needs 3.5.0+): edge gate authenticates Bearer JWT and cookie-session SSR browsers (`ssr-aware-role-gate`). Choose by topology:
- Dedicated function/route: prefer deploy-spec `require_role`; per-function, pre-dispatch, TTL-cached. `await auth.requireRole("operator")` returns `{ user, role }`; throws distinct `RoleGateNotConfiguredError` (500) vs `InsufficientRoleError` (403). Multi-role: `await auth.role()` and branch. Browser console can set gate `on_deny: "redirect"` + same-origin `sign_in_path` for anonymous HTML 303 to sign-in; authenticated wrong-role remains 403 JSON.
- Catch-all SSR/finer per-path control: use in-function `{ from }` guard; edge gate would also gate public catch-all/404 and `/admin/login`.

```ts
const { user } = await auth.requireRole("operator", { from: { table: "staff", idColumn: "user_id", roleColumn: "role" } });
// or, for an .astro page (a throw in frontmatter renders a 500, not a redirect) use the non-throwing read:
const role = await auth.role({ from: { table: "staff", idColumn: "user_id", roleColumn: "role" } });
if (role !== "operator") return Astro.redirect("/admin/login", 303);
```

`run402 auth scaffold-roles --roles operator` emits conventional `app_roles(user_id uuid, role text)` migration, matching `requireRole` snippet, and service-role `INSERT` for FIRST role (table starts empty; first grant bypasses RLS). Gate keys on end-user id (`internal.users.id` / JWT `sub`), not wallet. Applies to routed and direct (`POST /functions/v1/:name` with API key + user JWT); direct still requires API key before gate.

Binary files (images, fonts, PDFs): Set `"encoding": "base64"` and provide base64-encoded data. MIME types are auto-detected from the file extension (`.png` → `image/png`, `.woff2` → `font/woff2`, etc.). Text files use `"encoding": "utf-8"` (the default — can be omitted).

Assets slice: top-level `ReleaseSpec.assets` stages content-addressed asset entries with the release. Activation changes the active release pointer; applied migrations and external side effects are not undone.

```json
"assets": {
  "put": [
    { "key": "static/app.css", "sha256": "<64-hex>", "size_bytes": 1234, "content_type": "text/css", "visibility": "public", "immutable": true }
  ]
}
```

Additive batch: locally computed `sha256`; gateway dedupes CAS; only new shas upload through same S3 presign flow as `assets put`. Defaults `visibility: "public"`, `immutable: true`; other keys untouched.

```json
"assets": {
  "put": [...],
  "sync": {
    "prefix": "static/",
    "prune": true,
    "confirm": { "base_revision": "<hex>", "delete_set_digest": "<hex>", "expected_delete_count": 42 }
  }
}
```

Declarative sync: `prune: true` deletes keys under explicit `prefix` absent from new `put`; no implicit project-root prune. First apply without `confirm` returns `asset_sync` (`base_revision`, `delete_set_digest`, `expected_delete_count`, `sample_keys`); re-run with `confirm`. Activation rechecks and fails `ASSET_SYNC_DRIFT` if inventory mutates between commit/activation. No `run402 assets sync`; use manifest + `deploy apply` or SDK helpers (`uploadDir`, `syncDir`, `prepareDir`, `putMany`).

Verify block (authoring-only): deploy manifests accept a top-level `verify` with post-apply HTTP checks — the same `verify.http[]` shape app manifests use. It is stripped before the wire `ReleaseSpec` (like `$schema`); `run402 up` runs the checks after a successful apply (propagation-tolerant, results in `result.verification.http[]` + a `result.verify` rollup) and `run402 up verify` reruns them on demand. Verification-only output reports `mode: "verify"`, `read_only: true`, and `dry_run: false` because it performs real probes without applying a release. Each check: `id` (unique, required), `path` (resolved against the project public origin) or `url`, `expect: { status }` (snake alias `expected_status`), optional `retries`. Each executed HTTP check includes `observed_release` with nullable `release_id` and `generation`, response `url`, `observed_at`, `source: "response_headers"`, and `unavailable_reason`. These are observations from that response, not proof that all routes agree or that a release stayed unchanged throughout the run. Missing or malformed headers remain unknown and do not fail an otherwise successful HTTP check.

```json
"verify": {
  "http": [
    { "id": "home", "path": "/", "expect": { "status": 200 } },
    { "id": "api", "path": "/v1/health", "expected_status": 204 }
  ]
}
```

Migrations: inline `sql` or per-entry `sql_path` / `sql_file`. Make re-runnable: `CREATE TABLE/INDEX IF NOT EXISTS`; new columns need `ALTER TABLE ... ADD COLUMN` in an idempotent `DO` block:

```sql
CREATE TABLE IF NOT EXISTS items (id serial PRIMARY KEY, title text NOT NULL);
DO $$ BEGIN
  ALTER TABLE items ADD COLUMN priority int DEFAULT 0;
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;
```

Authorization manifest (`https://run402.com/schemas/manifest.v1.json`): new tables are dark until declared with `expose: true`. Prefer `database.expose` or a `manifest.json` in bundle `files[]`; platform validates against migration SQL, applies it, and strips `manifest.json` before site deploy so it is never public. Success includes `manifest_applied: true`; missing migration table -> HTTP 400 with structured `errors[]`. Dry feedback: `run402 projects validate-expose [project_id] --file manifest.json [--migration-file setup.sql]`; validates auth/expose manifest only, does not execute SQL, exits 0 even with `has_errors: true`.

Built-in table policies:

- `user_owns_rows` — owner column matches `auth.uid()`; requires `owner_column`. With `force_owner_on_insert: true`, per-table trigger fills owner only when `NEW.<owner_column>` is `NULL`; explicit different owners still fail `WITH CHECK`. `service_key` bypasses RLS but trigger still runs; admin writes should set owner if no JWT. Best for user-scoped data. `uuid` owner columns get index-friendly policies; other types use `::text` cast with warning; btree index auto-created.
- `public_read_authenticated_write` — anyone reads; any authenticated user can INSERT/UPDATE/DELETE any row (not just their own). For collaborative content (shared boards, announcements).
- `public_read_write_UNRESTRICTED` — ⚠ fully open; `anon_key` can read AND write any row. For intentionally public tables only (guestbooks, waitlists, feedback forms). Requires `"i_understand_this_is_unrestricted": true` on the table entry.
- `custom` — escape hatch. Provide `custom_sql` containing `CREATE POLICY` statements; they run inside the apply transaction after RLS is enabled + forced.

| Policy | anon SELECT | anon writes | auth SELECT | auth writes |
|---|:---:|:---:|:---:|:---:|
| (omitted from manifest) | — | — | — | — |
| `user_owns_rows` | — | — | own rows | own rows |
| `public_read_authenticated_write` | all | — | all | all rows |
| `public_read_write_UNRESTRICTED` | all | yes | all | yes |

`—` = denied. `service_key` bypasses all policies. Views are always created with `security_invoker=true` — they inherit the underlying table's RLS. RPCs require an entry in `rpcs[*]` with `grant_to` to be callable as `/rest/v1/rpc/<fn>` — `CREATE FUNCTION` revokes PUBLIC EXECUTE automatically.

Worked example covering all three slices (drop in as `manifest.json` or under `database.expose` in a deploy manifest):

```json
{
  "$schema": "https://run402.com/schemas/manifest.v1.json",
  "version": "1",
  "tables": [
    { "name": "posts", "expose": true, "policy": "public_read_authenticated_write" },
    { "name": "notes", "expose": true, "policy": "user_owns_rows", "owner_column": "user_id", "force_owner_on_insert": true }
  ],
  "views": [
    { "name": "posts_public", "base": "posts", "select": ["id", "title", "published_at"], "expose": true }
  ],
  "rpcs": [
    { "name": "increment_counter", "signature": "(counter_name text)", "grant_to": ["authenticated"] },
    { "name": "now_utc", "signature": "()", "grant_to": ["anon", "authenticated"] }
  ]
}
```

`rpcs[*].signature`: parenthesized args (`"()"` for none), regex `^\([^;]*\)$`; `grant_to` non-empty roles (`anon`, `authenticated`, `service_role`, `project_admin`). Function must exist in migration SQL; manifest grants EXECUTE only. Views require `base` + non-empty `select`, are `security_invoker=true`, inherit base RLS. Ad-hoc: `projects apply-expose <project_id> --file manifest.json`; inspect with `projects get-expose <project_id>` (`source: "applied" | "introspected"`). Manifest is convergent; removed items revoke policies/grants/triggers/views, so include full desired exposed surface each apply.

Deploy:

```bash
run402 deploy apply --manifest app.json
```

Deploy stages migrations, `database.expose`, functions/site/assets, subdomains and routes before activation. Inspect each stage and any resumable operation; activation is not a transaction that rolls back every prior effect. Set secret values first with `run402 secrets set`; deploy manifests only declare value-free `secrets.require` / `secrets.delete`.

### Step-by-Step Deploy

If you want more control:

```bash
# 1. Provision a database
run402 projects provision --name my-app

# 2. Create tables
run402 projects sql <project_id> "CREATE TABLE items (id serial PRIMARY KEY, title text NOT NULL, done boolean DEFAULT false)"

# 3. Insert seed data
run402 projects sql <project_id> "INSERT INTO items (title) VALUES ('Buy groceries'), ('Read a book')"

# 4. Declare authorization. Write manifest.json first:
#    {"version":"1","tables":[{"name":"items","expose":true,"policy":"public_read_authenticated_write"}]}
run402 projects validate-expose <project_id> --file manifest.json
run402 projects apply-expose    <project_id> --file manifest.json

# 5. Deploy a static site (uses active project automatically)
run402 sites deploy --manifest site.json

# 6. Claim a subdomain (uses active project + its live release automatically)
run402 subdomains claim my-app
```

---

### Interpreting deploy evidence

`up --verify` replaces the current `deploy.edge` summary with the latest probe result and retains the earlier summary in `activation_snapshot`, whose timestamp can be null for an older gateway. Reports disclose path sampling, vantage, check time, and `verification_basis`: release identity, content hash, or inconclusive weak metadata. Identity checks may legitimately have `observed_sha256: null`; a hash is never inferred from HTTP 200. `no_mutable_paths` is explicit.

A successful first vault push reports `repo.first_push.snapshot` (ID, kind, backup status) separately from `repo.local_git` (branch, HEAD, unborn, dirty). A synthetic backup does not advance your branch or stage files. An unborn branch with untracked files after backup is expected.

Function HTTP 400/429 responses can carry `x-cache: Error from cloudfront`. Judge them against the application’s expected status and body; preserve `Retry-After` for rate limits. That header alone does not establish edge failure.

Source-resolution steps report `source_available: true` after resolving an existing directory. `git_state` distinguishes `has_commit`, `unborn`, `not_repository`, and `unavailable`. A null `commit` does not mean the source is missing; an unborn repository has local files but no local commit. Resolution does not create a commit.

## Deploy output

`run402 up` returns JSON with the destination, release, verification and backup outcomes, warnings and next actions. Repetitive progress is opt-in with `--json-stream`. Applied runs can include a local `result_ref` pointing to redacted detail in `.run402/diagnostics/`; read the returned file to inspect that same execution. Diagnostics are private, bounded and excluded from source snapshots. Check, plan-only and read-only output does not create diagnostic files. MCP uses its existing `expand_result` handle instead of a local path. SDK scripts retain the full typed result.

An initial connection failure before payment dispatch is classified as `network`, preserving `X402_INITIAL_REQUEST_FAILED` and safe retry details. A failure after possible payment dispatch still requires reconciliation.

An explicitly declared append-only policy on a new table deploys without a second acknowledgment. Public-write widening on existing tables, changed custom policies and legacy custom-policy convergence still require review; the CLI reports the precise `--allow-warning` flag. An unchanged compiler-applied custom policy does not prompt again. Default results contain one verification summary, release URLs and backup outcome; repeated inventories remain in `result_ref`.
