---
title: "The patterns"
description: "Native MCP reference — patterns."
order: 30
---

## The patterns

### Paste-and-go assets — content-addressed URLs with SRI

When you upload a file with `assets_put`, the response is an `AssetRef` with these fields:

| Field | Use it for |
|---|---|
| `cdn_url` | Drop straight into `src=` / `href=` in generated HTML. URL is content-addressed — never needs cache invalidation. |
| `sri` | `sha256-<base64>` for `<script integrity="…">` if you build tags by hand |
| `etag` | Strong `"sha256-<hex>"` ETag |
| `cache_kind` | `immutable` / `mutable` / `private` |

`immutable: true` is the default. Pass `false` only on very large uploads where you don't need a content-hashed URL or SRI.

If you suspect cache staleness, `diagnose_public_url` returns expected vs observed SHA, cache headers, invalidation status, and an actionable `hint`. For mutable URLs only, `wait_for_cdn_freshness` polls until the CDN serves the expected SHA. Don't call `wait_for_cdn_freshness` on immutable URLs — they're correct from upload time.

### Dark-by-default tables + the expose manifest

**Tables you create are unreachable via `/rest/v1/*` until your manifest declares them with `expose: true`.** This is the "agent created a table, forgot RLS, data leaked" footgun-eliminator. The manifest is the single source of truth.

JSON Schema: <https://run402.com/schemas/manifest.v1.json>. Set `$schema` on your manifest object and any editor gives autocomplete.

**Preferred: declare `database.expose` in deploy.** When you call `deploy`, put this manifest object under `database.expose`. The gateway validates it against migration SQL and applies it atomically with the rest of the release.

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

If the manifest references a table the migration doesn't create, the deploy is rejected with HTTP 400 and a structured `errors` array listing every violation.

Non-mutating validation. Use `validate_manifest` before applying to validate the auth/expose manifest used by `database.expose` and `apply_expose`. It accepts a manifest object or JSON string, optional `migration_sql`, and optional `project_id`. The SQL is used only for reference checks; it is not executed as a PostgreSQL dry run. This is not deploy-manifest validation.

Imperative escape hatch. For ad-hoc changes outside a deploy: `apply_expose` with `project_id` + `manifest`. `get_expose` returns the live state, with `source: "applied"` (came from a prior apply) or `"introspected"` (no manifest applied; reconstructed from DB state).

Convergent: applying the same manifest twice is a no-op; items removed between applies have their policies, grants, triggers, and views dropped. Always include everything you want exposed.

#### Built-in policies

| Policy | Allows |
|---|---|
| `user_owns_rows` | Rows where `owner_column = auth.uid()`. With `force_owner_on_insert: true`, a BEFORE INSERT trigger sets it automatically. Default for user-scoped data. |
| `public_read_authenticated_write` | Anyone reads. Any authenticated user writes any row. For shared boards / collaborative content. |
| `public_read_write_UNRESTRICTED` | Fully open. Requires `i_understand_this_is_unrestricted: true`. Only for guestbooks / waitlists / feedback forms. |
| `custom` | Escape hatch. Provide `custom_sql` with `CREATE POLICY` statements. |

Views always run with `security_invoker=true` — they inherit the underlying table's RLS. RPCs are not exposed unless listed in `rpcs[]` (a database event trigger revokes PUBLIC EXECUTE on every newly-created function).

### Slick Deploys

Prefer `deploy_site_dir` over `deploy_site` whenever you have a directory path. It walks the directory, hashes each file client-side, asks the gateway _which_ bytes it doesn't already have, and only uploads those. Re-deploying an unchanged tree returns immediately with `bytes_uploaded: 0`.

The response's `content` array includes a fenced `json` block of buffered unified `DeployEvent` objects you can `JSON.parse`.

For full-stack deploys (database + migrations + manifest + value-free secret declarations + functions + site + subdomain), use `deploy` / `deploy_resume`. Set secret values first with `set_secret`, then deploy with `secrets.require[]`; never put secret values in a deploy spec. Rehearsal is automatic: a migration-bearing `deploy` / `app_up` against a project with a live release is rehearsed on a contained branch and committed only on a passing report (the result's `rehearsal` block says `passed`, or `skipped` with a reason such as `no_live_release` on a first deploy or `migrations_unchanged` when every migration is already applied with an identical checksum — a page-only redeploy is not rehearsed); pass `no_rehearse` to skip it. ADVANCED: `deploy_rehearse` rehearses an already-persisted plan id without committing; it snapshots the source, creates a contained branch, applies migrations and checks there, and returns a report without mutating the source project.

The `deploy` tool also accepts `site.public_paths` for clean static browser URLs and apply-v1 web routes to functions or exact method-aware static aliases. Release static asset paths and public browser paths are distinct: `events.html` can be a private release asset while `/events` is the public static URL.

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
  "routes": {
    "replace": [
      { "pattern": "/api/*", "methods": ["GET", "POST", "OPTIONS"], "target": { "type": "function", "name": "api" } },
      { "pattern": "/login", "methods": ["POST"], "target": { "type": "function", "name": "login" } }
    ]
  }
}
```

`site.public_paths.mode: "explicit"` means only the complete `public_paths.replace` table is directly reachable as static URLs. In the example, `/events` serves release asset `events.html`, while `/events.html` is not public unless separately declared. `{ "mode": "implicit" }` restores filename-derived public reachability and can widen access; review gateway warnings before confirming that switch. Public-path-only site specs are meaningful deploy content.

`site.embedding.frame_ancestors` opts the site in to being framed by the named embedders, by platform catalog **key** (never a raw origin): `{ "site": { "embedding": { "frame_ancestors": ["localhost"] } } }` makes every response of the host carry `Content-Security-Policy: frame-ancestors http://localhost:* http://127.0.0.1:*` and no `X-Frame-Options`, so a local product (a Buzz desktop panel, a dev server on any port) can show the app in an iframe. Everything else keeps `frame-ancestors 'none'` + `X-Frame-Options: DENY`. Omit the field on a later deploy to carry the previous declaration forward; send `null` to return to deny. Unknown keys fail `INVALID_SPEC` on `site.embedding.frame_ancestors` naming the valid ones. `deploy_release` inventories report `embedding` as keys or `null`; the host's `/_run402/config.json` discloses the expanded policy cross-origin.

Omit `routes` or pass `routes: null` to carry forward base routes. Use `routes: { "replace": [] }` to clear the route table. Route activation is atomic with the release. Function targets use `{ "type": "function", "name": "<materialized function name>" }`. Prefer `site.public_paths` for ordinary clean static URLs e.g. `/events -> events.html`. Static route targets use exact patterns only, methods `["GET"]` or `["GET","HEAD"]`, and `{ "pattern": "/events", "methods": ["GET", "HEAD"], "target": { "type": "static", "file": "events.html" } }` for route-only aliases; `file` is a release static asset path, not a public path, URL, CAS hash, rewrite, or redirect. Direct `/functions/v1/:name` invocation remains API-key protected; routed browser paths are public same-origin ingress, so function code owns application auth, CSRF for cookie-authenticated unsafe methods, CORS/`OPTIONS`, cookies, redirects, and spoofed forwarding-header hygiene.

Matching is exact or final `/*` prefix only. `/admin/*` does not match `/admin`, `/admin/`, `/admin.css`, or `/administrator`; use both `/admin` and `/admin/*` for a dynamic section root. Query strings are ignored for matching and preserved in the handler's full public `req.url`. Exact routes beat prefix routes, longest prefix wins, and method-compatible dynamic routes beat static assets. `POST /login` can route to a function while `GET /login` serves static HTML. Unsafe method mismatch returns `405`; matched dynamic route failures fail closed.

Routed functions use the Node 22 Fetch Request -> Response contract: `export default async function handler(req) { ... }`. `req.method` is the browser method, and `req.url` is the full public URL on managed subdomains, deployment hosts, and verified custom domains. Derive OAuth callbacks from it, for example `new URL("/admin/oauth/google/callback", new URL(req.url).origin)`. Append multiple cookies with `headers.append("Set-Cookie", value)`; redirects, cookies, and query strings are preserved. The raw `run402.routed_http.v1` envelope is internal; do not write route handlers against it.

Use `deploy_diagnose_url` before mutating deploy state when the question is "what would this public URL serve?" The tool accepts `project_id`, either `url` or `host`/`path`, and optional `method`; URL query strings/fragments are disclosed in `request.ignored` and `warnings`. It returns `would_serve`, `diagnostic_status`, `match`, normalized request data, deterministic summary, warnings, structured next steps, full structured response when supported, and a fenced JSON fallback. When returned, `asset_path`, `reachability_authority`, and `direct` explain which release asset backs the public URL and whether reachability came from implicit file-path mode, explicit `site.public_paths`, or a route-only static alias. Stable-host diagnostics may also include `authorization_result`, `cas_object` (`sha256`, `exists`, `expected_size`, `actual_size`), hostname-specific `response_variant`, route/static fields e.g. `allow`, `route_pattern`, `target_type`, `target_name`, and `target_file`, plus `edge_propagation` (`status`, `claimed_at`, `kvs_synced_at`, `expected_visible_by`, `hint`). Known `edge_propagation.status` literals are `settled`, `propagating`, and `sync_pending`; non-settled statuses add warnings such as `edge_propagating` / `edge_sync_pending`, make app HTTP verification report `propagation_pending`, and next steps tell agents to retry or rerun app verification with `run402 up verify`. Known `match` literals are `host_missing`, `manifest_missing`, `active_release_missing`, `unsupported_manifest_version`, `path_error`, `none`, `static_exact`, `static_index`, `spa_fallback`, `spa_fallback_missing`, `route_function`, `route_static_alias`, and `route_method_miss`; preserve unknown future strings. Known `authorization_result` values include `authorized`, `not_public`, `not_applicable`, `manifest_missing`, `target_missing`, `active_release_missing`, `unsupported_manifest_version`, `path_error`, `missing_cas_object`, `unfinalized_or_deleting_cas_object`, `size_mismatch`, and `unauthorized_cas_object`. Known `fallback_state` values include `active_release_missing`, `unsupported_manifest_version`, and `negative_cache_hit`; preserve unknown future strings. `result` is diagnostic body status, not MCP transport status, so host misses can be successful tool calls with `would_serve: false`. Do not treat diagnose as a fetch or cache purge, parse the prose instead of the fenced JSON, or hard-code `cache_policy` strings; branch on structured JSON e.g. `cache_class`, `allow`, `cas_object`, and `edge_propagation`, and preserve unknown cache classes.

Route warning recovery:

| Code | Meaning | Recover |
|---|---|---|
| `PUBLIC_ROUTED_FUNCTION` | Function becomes public same-origin browser ingress. | Informational (`requires_confirmation: false`): it never blocks a deploy and needs no `allow_warning_codes` entry. Review app auth, CSRF, CORS/`OPTIONS`, and cookies; direct `/functions/v1/:name` remains protected. Only warnings with `requires_confirmation: true` need `allow_warning_codes`. |
| `ROUTE_TARGET_CARRIED_FORWARD` | Carried-forward route still targets a base-release function. | Inspect `deploy_release_active` and deploy a replacement route table if needed. |
| `ROUTE_SHADOWS_STATIC_PATH` / `WILDCARD_ROUTE_SHADOWS_STATIC_PATHS` | Dynamic route shadows direct public static content. | Inspect warning details, active routes, `static_public_paths`, and resolve diagnostics; confirm only when intentional. |
| `METHOD_SPECIFIC_ROUTE_ALLOWS_GET_STATIC_FALLBACK` | Unmatched methods can serve static content. | Confirm fallback is intended or add method coverage. |
| `WILDCARD_ROUTE_EXCLUDES_MUTATION_METHODS` | Wildcard function route only allows `GET`/`HEAD`. | Add mutation methods e.g. `POST`, omit methods for an API prefix, or set `acknowledge_readonly: true` on an intentionally read-only GET/HEAD final-wildcard function route. Use `allow_warning_codes` as a reviewed escape hatch; broad `allow_warnings` is last resort. |
| `ROUTE_TABLE_NEAR_LIMIT` | Route table is near a limit. | Consolidate or remove routes. |
| `ROUTES_NOT_ENABLED` | Routes are disabled for the project/environment. | Deploy without `routes` or request enablement; direct function invoke is not a browser-route substitute. |
| `STATIC_ALIAS_SHADOWS_STATIC_PATH` / `STATIC_ALIAS_RELATIVE_ASSET_RISK` | Route-only static alias conflicts with a direct public static path or has relative-asset risk. | Inspect active routes, `static_public_paths`, and the backing `asset_path`; prefer `site.public_paths` for ordinary clean URLs and confirm only when intentional. |
| `STATIC_ALIAS_DUPLICATE_CANONICAL_URL` / `STATIC_ALIAS_EXTENSIONLESS_NON_HTML` | Route-only static alias may duplicate another direct public path or serve extensionless non-HTML content. | Use one canonical public path per page and reserve exact static route targets for method-aware aliases. |
| `STATIC_ALIAS_TABLE_NEAR_LIMIT` | Static route targets are near route-table limits. | Do not route every static file or create one route per page by default; consolidate. |

Runtime route failure codes to branch on: `ROUTE_MANIFEST_LOAD_FAILED` (manifest/propagation), `ROUTED_INVOKE_WORKER_SECRET_MISSING` (custom-domain Worker secret), `ROUTED_INVOKE_AUTH_FAILED` (internal invoke signature), `ROUTED_ROUTE_STALE` (selected route failed release revalidation), `ROUTE_METHOD_NOT_ALLOWED` (method mismatch), and `ROUTED_RESPONSE_TOO_LARGE` (body over 6 MiB).

#### Recipe: static home page + SPA shell

A SPA site ships `index.html` as the shell serving every unmatched route (match `spa_fallback`), so by default `GET /` serves the shell too. To serve a real static home page at `/` — real bytes under curl and without JavaScript — while keeping the shell for app routes, ship `home.html` at the site root alongside `index.html` and add an exact root static route alias in the same `deploy` manifest:

```json
{
  "project_id": "prj_...",
  "site": { "replace": {
    "index.html": { "data": "<!doctype html><main id='app'></main><script src='/app.js'></script>" },
    "home.html": { "data": "<!doctype html><h1>Welcome</h1><a href='/dashboard'>Open the app</a>" },
    "app.js": { "data": "/* SPA bootstrap */" }
  } },
  "routes": {
    "replace": [
      { "pattern": "/", "target": { "type": "static", "file": "home.html" } }
    ]
  }
}
```

Route matching runs before all static resolution — including the implicit `/` -> `index.html` root mapping — and SPA-fallback derivation is independent of the route table. So `GET /` serves `home.html` (match `route_static_alias`), unmatched app routes e.g. `/dashboard` still serve the `index.html` shell (match `spa_fallback`), and named static pages keep serving unchanged (match `static_exact`). Root placement of `home.html` keeps its relative asset URLs resolving identically to the direct file and avoids the `STATIC_ALIAS_RELATIVE_ASSET_RISK` warning.

Expect two non-blocking plan lints: `STATIC_ALIAS_SHADOWS_STATIC_PATH` (warn — the alias overrides what `/` would otherwise serve; for this recipe that is accurate and expected, and the commit proceeds) and `STATIC_ALIAS_DUPLICATE_CANONICAL_URL` (info — `/home.html` stays directly reachable in implicit public-path mode; add `<link rel="canonical" href="https://<your-site>/">` to `home.html` if duplicate-content SEO matters). Omitting `routes` on later deploys carries the alias forward (informational `ROUTE_TARGET_CARRIED_FORWARD`); a pipeline that sends `routes.replace` must include the alias every time because replace is total. Verify with `deploy_diagnose_url` on the site root URL and confirm `match: "route_static_alias"` with `target_file: "home.html"`.

### In-function helpers — `db(req)` vs `adminDb()`

Inside a deployed function, import from `@run402/functions` (auto-bundled at deploy time):

```ts
import { db, adminDb, auth, email, ai, assets, getRoutedPaymentContext } from "@run402/functions";

export default async (req: Request) => {
  const user = await auth.user();
  if (!user) return new Response("unauthorized", { status: 401 });

  // Caller-context — Authorization header forwarded; RLS evaluates against the caller's role.
  // Do not add `.eq("user_id", user.id)`; RLS already binds the visitor's rows.
  const mine = await db(req).from("items").select("*");

  // Bypass RLS — only when the function acts on behalf of the platform.
  await adminDb().from("audit").insert({ event: "items_read", user_id: user.id });

  if (mine.length === 0) {
    await email.send({ to: user.email, subject: "Welcome", html: "<h1>Hi</h1>" });
  }

  return Response.json(mine);
};
```

- `db(req)` — caller-context. Default choice.
- `adminDb()` — bypass RLS. Use only for audit logs, cron cleanup, webhook handlers, platform-authored writes.
- `adminDb().sql(query, params?)` — raw parameterized SQL, always bypass RLS.
- `ai.generateImage({ prompt, aspect? })` — live image generation from deployed functions, billed/rate-limited against the project organization through `RUN402_SERVICE_KEY`. Aspects: `square`, `landscape`, `portrait`; result: `{ image, content_type, aspect }`. For public routed functions, authenticate/rate-limit app users before calling it.
- `assets.put(key, source, opts?)` — upload runtime bytes through the same CAS-backed apply substrate as deploy-time assets. `source` is a string, `Uint8Array`, or `{ content | bytes }`; returns an SDK-compatible `AssetRef`.
- `auth.*` — canonical cookie/session auth namespace (`auth.user`, `auth.requireUser`, `auth.requireRole`, `auth.requireMembership`, `auth.fetch`, `auth.sessions.*`, `auth.identities.link`). Bare helpers such as `getUser`, `getUserId`, and `getRole` are not exported — they throw `R402_AUTH_UNKNOWN_EXPORT` and fail `run402 doctor`.
- Function-level gate headers — when `FunctionSpec.requireAuth` / `requireRole` passes, read `req.headers.get("x-run402-user-id")` and `req.headers.get("x-run402-user-role")` directly. Use these inside a gated function instead of re-decoding the JWT. See "Function-level auth gates" below for declaring the gate on the deploy spec.
- `getRoutedPaymentContext(req)` (`@run402/functions` 3.7+) — confirmed x402 payment context for priced routed function requests. Returns `{ scheme, paymentId, amountUsdMicros, payer, network, asset, payTo, transaction, settledAt }` or `null`; key app-side idempotency by `payment.paymentId`.

Fluent surface on both: `.select() / .eq() / .neq() / .gt() / .lt() / .gte() / .lte() / .like() / .ilike() / .in() / .order() / .limit() / .offset()` for reads; `.insert(obj | obj[]) / .update(obj) / .delete()` for writes (chain with `.eq()` to scope; return arrays of affected rows).

For TypeScript autocomplete, `npm install @run402/functions` in your editor's project. Same package also works at build time for static-site generation if you set `RUN402_SERVICE_KEY` + `RUN402_PROJECT_ID` in `.env`.

### Function-level auth gates

Declare auth requirements directly on each function spec — the gateway enforces them before invoking the function, so unauthorized callers get `401`/`403` without your code running, and the gateway injects the resolved identity into trustworthy request headers.

Two independent optional fields on each `FunctionSpec` inside `deploy`'s `spec.functions.replace` / `spec.functions.patch.set`:

- `require_auth: true` — gateway rejects callers without a valid project user JWT with `401`. No DB lookup. Independent from `require_role`.
- `require_role: { table, id_column, role_column, allowed[], cache_ttl? } | null` — gateway resolves the caller's role from the project-schema table (RLS-bypass — the gateway is the trusted intermediary) and rejects callers whose role is not in `allowed` with `403`. Implies authentication. Pass `null` in patch mode to remove an existing gate. `cache_ttl` is seconds; default 60, max 600, 0 disables caching (use for instant-revocation paths).

Worked spec fragment for the `deploy` tool — three common shapes:

```json
{
  "spec": {
    "functions": {
      "patch": {
        "set": {
          "list-my-items": {
            "source": { "data": "/* … */", "encoding": "utf-8" },
            "require_auth": true
          },
          "delete-content": {
            "source": { "data": "/* … */", "encoding": "utf-8" },
            "require_role": {
              "table": "members",
              "id_column": "user_id",
              "role_column": "role",
              "allowed": ["admin"],
              "cache_ttl": 60
            }
          },
          "moderate-content": {
            "source": { "data": "/* … */", "encoding": "utf-8" },
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
}
```

Validation rules (gateway-authoritative):

- One role table per release. All `require_role` blocks in a single release must share the same `(table, id_column, role_column)` triple. Different `allowed` sets are fine; different tables are rejected at plan time with the canonical `INVALID_SPEC` envelope.
- Unqualified identifiers only. Schema-qualified names (e.g. `"public.members"`) are rejected with `INVALID_SPEC`. The project schema is resolved server-side.
- `cache_ttl` range. `0 ≤ cache_ttl ≤ 600`. Out-of-range → `INVALID_SPEC`.
- Empty `allowed`. Rejected with `INVALID_SPEC`.
- Deploy-time validation. Missing table or column at activation fails with `DEPLOY_INVALID_ROLE_GATE` (HTTP 422) *before* flipping the live release. The `deploy` tool surfaces the structured envelope.

The gate applies to both routed (`/your/route`) and direct (`POST /functions/v1/:name` with API key plus user JWT) invocation. Direct invocation still requires the API key at the edge; the gate runs after API-key auth, against the user JWT.
