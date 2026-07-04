---
title: MCP reference
description: Comprehensive run402-mcp tool reference (the agent-facing llms-mcp.txt, rendered).
order: 1
---

> Package: `run402-mcp` (npm)
> Connect via: Claude Desktop / Cursor / Cline / Claude Code
> Wayfinder: https://run402.com/llms.txt
> Sibling references: SDK at https://docs.run402.com/llms-sdk.txt · CLI at https://docs.run402.com/llms-cli.txt · HTTP at https://run402.com/llms-full.txt
> Source: cli/llms-mcp.txt in https://github.com/kychee-com/run402

This file is canonical reference for the `run402-mcp` MCP server's tool surface. Every action is an MCP tool call — natural-language framings work because the schemas are loaded into your context by the host.

If you're an MCP-host agent that already has the run402-mcp tools available, this is your reference. If you don't have the tools loaded, install the server first (instructions at the bottom).

## Mental model

`run402-mcp` is a thin shim over [`@run402/sdk`](https://docs.run402.com/llms-sdk.txt). Each MCP tool is an argv-parsing wrapper around an SDK method. The configured API target, active project state, allowance, and local project-key cache are shared with the CLI; provisioning a project from any surface makes its `anon_key` and `service_key` available to credential-required operations without treating cached keys as project inventory.

Tools that require payment (`provision_postgres_project`, `set_tier`, `deploy`, `generate_image`) return 402 payment details as informational text (not an error) — the LLM should reason about cost, guide the user through funding if needed, and retry the same tool call.

## Quickstart

Six tool calls take you from zero to a deployed static site backed by a real Postgres:

1. `init` — set up the local allowance, request the testnet faucet, snapshot tier + projects.
2. `set_tier` with `tier: "prototype"` — free on testnet; verifies x402 setup end-to-end.
3. `provision_postgres_project` with `name` — returns `project_id`, `anon_key`, `service_key`. Embed `anon_key` in your HTML before deploying.
4. `run_sql` with `sql: "CREATE TABLE …"` — set up your schema. Make migrations idempotent.
5. `validate_manifest`, then `apply_expose` with a manifest — check and declare which tables are reachable via PostgREST. Tables are dark by default.
6. `deploy_site_dir` with `dir` — incremental upload, only PUTs bytes the gateway doesn't already have. Auto-claims the subdomain on subsequent deploys.

Optional next: `deploy_function` for server logic, `assets_put` for paste-and-go CDN assets, `create_mailbox` → `list_mailboxes` / `set_mailbox_defaults` / `update_mailbox` → `send_email` for transactional mail.

## Portable project archives

Portable archives let an agent export the supported Run402 Core runtime slice of a Cloud project, verify it locally, and import it into a new local Core project. This is the vendor-lock-in trust claim: Cloud is the easiest place to start, not the only place the supported application can run. It is separate from allowance/spend-cap financial-risk controls.

MCP happy path:

1. `export_project_archive` with `project_id`, optional `output_path`, `scope: "portable-runtime-v1"`, `auth: "stubs"`, `consistency: "pause-writes"`, and `wait: true`.
2. `inspect_project_archive` with `archive_path`.
3. `verify_project_archive` with `archive_path`.
4. Fill the required secret values from the archive's `secrets/required.env.template` or the `required_secrets` list.
5. `import_project_archive` with `archive_path`, `name`, `env_file` or `secret_values`, and optional `require_runnable: true`.

Tool outputs use the same agent fields as CLI/SDK: `code`, `severity`, `resource_type`, `resource_id`, `message`, `next_action`, `retryable`, and safe `context`. `verify_project_archive` is offline and checks integrity and compatibility only; archives remain untrusted input. Import verifies before mutation, creates a new Core project only, and never imports secret values, auth credentials, logs, billing/allowance state, or managed Cloud operations from Cloud export.

## Project credentials

After `provision_postgres_project`, two keys are saved automatically and reused by every subsequent tool call:

- `anon_key` — read-only by default; safe in browser HTML. RLS policies apply.
- `service_key` — server-side admin. Never embed in browser code. CORS is intentionally open for x402 clients, so a leaked service_key is exploitable from any origin. Use only inside functions or when calling tools as the agent.

Neither key expires. To inspect, call `project_keys`; to switch the active project for sticky-default tools, call `project_use`.

## Error envelopes and safe retry

Run402 JSON errors carry a canonical envelope. Branch on `code`, not English `message`.

Important fields:
- `code` — stable machine-readable reason: `PROJECT_FROZEN`, `PAYMENT_REQUIRED`, `MIGRATION_FAILED`, `MIGRATE_GATE_ACTIVE`, `RATE_LIMITED`, `INSUFFICIENT_FUNDS`, `CI_ROUTE_SCOPE_DENIED`
- `retryable` — the same request may succeed later
- `safe_to_retry` — repeating the same request will not duplicate or corrupt a mutation
- `mutation_state` — `none` / `not_started` / `committed` / `rolled_back` / `partial` / `unknown`
- `trace_id` — include this when reporting an issue
- `request_id` — routed/function failure handle. Use `get_function_logs` with `request_id` for function diagnostics; it is distinct from gateway `trace_id`.
- `details` — structured route-specific context
- `next_actions` — `authenticate`, `submit_payment`, `renew_tier`, `check_usage`, `retry`, `resume_deploy`, `edit_request`, `edit_migration`

Safe retry policy:
- `retryable: true` + `safe_to_retry: true` → retry, ideally with the same idempotency key for mutations
- `safe_to_retry: true` alone is not a retry signal; it means duplicate-safe, not likely-to-succeed. Lifecycle-gated writes, auth token exchanges, and passkey verifies need the indicated action before retrying.
- The `deploy` tool uses SDK `apply`, which already re-plans and retries safe `BASE_RELEASE_CONFLICT` races for omitted/current-base specs. A handled retry appears as a `deploy.retry` progress event; exhausted retries include `attempts`, `max_retries`, and `last_retry_code`. Static activation/config failures reported from `activation_pending` throw promptly with gateway metadata instead of polling until timeout. Do not hand-roll this specific deploy race loop around MCP calls.
- 5xx with `safe_to_retry: false`, or `mutation_state` is `committed` / `partial` / `unknown` → inspect or poll state before retrying. For deploys, use `deploy_resume` / event polling.
- Lifecycle / payment errors → take the action, don't blind-retry. `PROJECT_FROZEN` → `set_tier`; `PAYMENT_REQUIRED` → submit payment, then retry.

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

For full-stack deploys (database + migrations + manifest + value-free secret declarations + functions + site + subdomain), use `deploy` / `deploy_resume`. Set secret values first with `set_secret`, then deploy with `secrets.require[]`; never put secret values in a deploy spec.

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

Omit `routes` or pass `routes: null` to carry forward base routes. Use `routes: { "replace": [] }` to clear the route table. Route activation is atomic with the release. Function targets use `{ "type": "function", "name": "<materialized function name>" }`. Prefer `site.public_paths` for ordinary clean static URLs e.g. `/events -> events.html`. Static route targets use exact patterns only, methods `["GET"]` or `["GET","HEAD"]`, and `{ "pattern": "/events", "methods": ["GET", "HEAD"], "target": { "type": "static", "file": "events.html" } }` for route-only aliases; `file` is a release static asset path, not a public path, URL, CAS hash, rewrite, or redirect. Direct `/functions/v1/:name` invocation remains API-key protected; routed browser paths are public same-origin ingress, so function code owns application auth, CSRF for cookie-authenticated unsafe methods, CORS/`OPTIONS`, cookies, redirects, and spoofed forwarding-header hygiene.

Matching is exact or final `/*` prefix only. `/admin/*` does not match `/admin`, `/admin/`, `/admin.css`, or `/administrator`; use both `/admin` and `/admin/*` for a dynamic section root. Query strings are ignored for matching and preserved in the handler's full public `req.url`. Exact routes beat prefix routes, longest prefix wins, and method-compatible dynamic routes beat static assets. `POST /login` can route to a function while `GET /login` serves static HTML. Unsafe method mismatch returns `405`; matched dynamic route failures fail closed.

Routed functions use the Node 22 Fetch Request -> Response contract: `export default async function handler(req) { ... }`. `req.method` is the browser method, and `req.url` is the full public URL on managed subdomains, deployment hosts, and verified custom domains. Derive OAuth callbacks from it, for example `new URL("/admin/oauth/google/callback", new URL(req.url).origin)`. Append multiple cookies with `headers.append("Set-Cookie", value)`; redirects, cookies, and query strings are preserved. The raw `run402.routed_http.v1` envelope is internal; do not write route handlers against it.

Use `deploy_diagnose_url` before mutating deploy state when the question is "what would this public URL serve?" The tool accepts `project_id`, either `url` or `host`/`path`, and optional `method`; URL query strings/fragments are disclosed in `request.ignored` and `warnings`. It returns `would_serve`, `diagnostic_status`, `match`, normalized request data, deterministic summary, warnings, structured next steps, full structured response when supported, and a fenced JSON fallback. When returned, `asset_path`, `reachability_authority`, and `direct` explain which release asset backs the public URL and whether reachability came from implicit file-path mode, explicit `site.public_paths`, or a route-only static alias. Stable-host diagnostics may also include `authorization_result`, `cas_object` (`sha256`, `exists`, `expected_size`, `actual_size`), hostname-specific `response_variant`, and route/static fields e.g. `allow`, `route_pattern`, `target_type`, `target_name`, and `target_file`. Known `match` literals are `host_missing`, `manifest_missing`, `active_release_missing`, `unsupported_manifest_version`, `path_error`, `none`, `static_exact`, `static_index`, `spa_fallback`, `spa_fallback_missing`, `route_function`, `route_static_alias`, and `route_method_miss`; preserve unknown future strings. Known `authorization_result` values include `authorized`, `not_public`, `not_applicable`, `manifest_missing`, `target_missing`, `active_release_missing`, `unsupported_manifest_version`, `path_error`, `missing_cas_object`, `unfinalized_or_deleting_cas_object`, `size_mismatch`, and `unauthorized_cas_object`. Known `fallback_state` values include `active_release_missing`, `unsupported_manifest_version`, and `negative_cache_hit`; preserve unknown future strings. `result` is diagnostic body status, not MCP transport status, so host misses can be successful tool calls with `would_serve: false`. Do not treat diagnose as a fetch or cache purge, parse the prose instead of the fenced JSON, or hard-code `cache_policy` strings; branch on structured JSON e.g. `cache_class`, `allow`, and `cas_object`, and preserve unknown cache classes.

Route warning recovery:

| Code | Meaning | Recover |
|---|---|---|
| `PUBLIC_ROUTED_FUNCTION` | Function becomes public same-origin browser ingress. | Review app auth, CSRF, CORS/`OPTIONS`, and cookies; direct `/functions/v1/:name` remains protected. Prefer `allow_warning_codes: ["PUBLIC_ROUTED_FUNCTION"]` after review; broad `allow_warnings: true` only after every warning was reviewed. |
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

### In-function helpers — `db(req)` vs `adminDb()`

Inside a deployed function, import from `@run402/functions` (auto-bundled at deploy time):

```ts
import { db, adminDb, auth, email, ai, assets } from "@run402/functions";

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
- `auth.*` — canonical cookie/session auth namespace (`auth.user`, `auth.requireUser`, `auth.requireRole`, `auth.requireMembership`, `auth.fetch`, `auth.sessions.*`, `auth.identities.link`). Bare legacy helpers such as `getUser`, `getUserId`, and `getRole` were retired in `@run402/functions` v3.0 and fail `run402 doctor`.
- Function-level gate headers — when `FunctionSpec.requireAuth` / `requireRole` passes, read `req.headers.get("x-run402-user-id")` and `req.headers.get("x-run402-user-role")` directly. Use these inside a gated function instead of re-decoding the JWT. See "Function-level auth gates" below for declaring the gate on the deploy spec.

Fluent surface on both: `.select() / .eq() / .neq() / .gt() / .lt() / .gte() / .lte() / .like() / .ilike() / .in() / .order() / .limit() / .offset()` for reads; `.insert(obj | obj[]) / .update(obj) / .delete()` for writes (chain with `.eq()` to scope; return arrays of affected rows).

For TypeScript autocomplete, `npm install @run402/functions` in your editor's project. Same package also works at build time for static-site generation if you set `RUN402_SERVICE_KEY` + `RUN402_PROJECT_ID` in `.env`.

### Function-level auth gates (v1.51+)

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

## Tools by category

### Database

- `provision_postgres_project` — provision a new database. Auto-handles x402 payment. Params: `tier?` (default `"prototype"`), `name?`, `org_id?` (provision into an EXISTING org — needs `developer`+ on it; omit for the cold-start path; tier is org-governed). Returns `project_id`, `anon_key`, `service_key`, `tier`, `schema_slot`, `lease_expires_at`.
- `run_sql` — execute SQL (DDL or queries). Service-key-authenticated. Params: `project_id?` (defaults to the active project), `sql`. Returns a markdown table for result sets; mutations report "N rows affected" and DDL reports "Statement executed".
- `rest_query` — query/mutate via PostgREST. Params: `project_id?` (defaults to the active project), `table`, `method?` (`GET`/`POST`/`PATCH`/`DELETE`), `params?` (PostgREST query syntax: `select=…`, `eq.value`, `order=…`, `limit=…`), `body?`, `key_type?` (`"anon"` default — RLS applies; `"service"` — bypasses RLS via the admin REST path).
- `apply_expose` — apply the declarative authorization manifest. Params: `project_id`, `manifest` (`{ version: "1", tables: [...], views: [...], rpcs: [...] }`).
- `validate_manifest` — validate the auth/expose manifest without applying it. Params: `manifest` (object or JSON string), `migration_sql?`, `project_id?`. Returns fenced JSON with `has_errors`, `errors`, and `warnings`; validation findings are data, not MCP errors.
- `get_expose` — return the current manifest. Params: `project_id`. Returns the manifest plus `source: "applied" | "introspected"`.
- `get_schema` — introspect tables, columns, types, constraints, RLS policies. Params: `project_id?` (defaults to the active project).
- `get_usage` — per-project usage counters (API calls, storage, lease expiry). Params: `project_id`. The reported tier and capacity limits are organization-level (pooled across every project on the same organization); use `tier_status` for the pooled total.
- `promote_user` / `demote_user` — manage `project_admin` role on a project user. Params: `project_id`, `email`.
- `delete_project` — cascade purge. Params: `project_id`. Irreversible.

### Asset storage (content-addressed CDN)

Single-asset MCP tools below. For bulk directory work, the `deploy` tool
accepts an `assets` slice (`assets: { put: [...] }` for additive batch and
`assets: { put: [...], sync: { prefix, prune, confirm? } }` for declarative
sync with a prune confirmation token — see [Slick Deploys](#slick-deploys)
and "Bulk asset directories" below).

- `assets_put` — upload (any size up to 5 TiB) via direct-to-S3. Params: `project_id`, `key`, `local_path?` OR `content?` (≤ 1 MB inline), `content_type?`, `visibility?` (`"public"` / `"private"`), `immutable?` (default `true`), `sha256?` (auto-computed when `immutable: true`). Returns `AssetRef`.
- `assets_get` — download to a local file. Params: `project_id`, `key`, `local_path`.
- `assets_ls` — keyset-paginated list. Params: `project_id`, `prefix?`, `limit?` (default 100, max 1000), `cursor?`.
- `assets_rm` — delete and decrement project storage usage. Params: `project_id`, `key`.
- `assets_sign` — time-boxed presigned GET URL. Params: `project_id`, `key`, `ttl_seconds?` (default 3600, max 604800).
- `diagnose_public_url` — live CDN state. Params: `project_id`, `url`. Returns `expected_sha256`, `observed_sha256`, `cache.{x_cache,age_seconds,cache_kind}`, `invalidation.{id,status}`, `vantage`, `hint`. Vantage is single-region (us-east-1).
- `wait_for_cdn_freshness` — poll a mutable URL until it serves the expected SHA. Params: `project_id`, `url`, `sha256`, `timeout_ms?` (default 60_000, max 600_000). `isError: true` on timeout.

#### Bulk asset directories — via the `deploy` tool's `assets` slice

`assets` is a top-level `ReleaseSpec` slice the gateway treats with the same atomic guarantees as `site` / `functions` / `database`. Two shapes:

- Additive batch: `assets: { put: [{ key, sha256, size_bytes, content_type, visibility, immutable }, ...] }`. Existing keys outside the batch are left untouched. Use this for incremental adds.
- Declarative sync: `assets: { put: [...], sync: { prefix, prune: true, confirm?: { base_revision, delete_set_digest, expected_delete_count } } }`. Without `confirm`, the gateway returns the sync `asset_sync` block in the plan response — surface the delete count and sample keys to the user, then re-call with `confirm` populated. `prune: true` requires an explicit `prefix` — there's no implicit project-root prune.

Each `AssetPutEntry` carries the locally-computed `sha256` so the gateway can deduplicate against the CAS substrate; bytes for new shas are uploaded via the same direct-to-S3 presigned URL flow as `assets_put`.

### Sites & subdomains

- `deploy_site` — deploy from inline file bytes. Params: `project`, `target?`, `files: [{ file, data, encoding? }]`. Free with active tier.
- `deploy_site_dir` — deploy from a local directory. Routes through the unified apply primitive (CAS-backed) — only uploads bytes the gateway doesn't have. Params: `project`, `dir`, `target?`. Skips `.git/`, `node_modules/`, `.DS_Store`. Symlinks throw.
- `claim_subdomain` — claim `<name>.run402.com`. Idempotent; auto-reassigns to latest deployment on subsequent deploys. Params: `project_id`, `name`, `deployment_id?`.
- `list_subdomains` / `delete_subdomain` — manage subdomains.
- `domains_ensure` / `domains_get` / `domains_list` / `domains_check` — manage project-scoped ProjectDomain desired state for web, email sending, inbound receive, mailbox addresses, and health checks.
- `domains_apply` / `domains_repair` / `domains_test_receive` / `domains_activate` / `domains_disconnect` — apply safe provider actions, repair Run402-owned routing, create inbound receive tests, activate custom mailbox addresses, or disconnect a domain.
- `deploy` — the unified apply primitive (with first-class assets slice). Pass a `ReleaseSpec` with replace-vs-patch semantics per resource, value-free `secrets.require` / `secrets.delete`, and optional `assets: { put: [...], sync?: { prefix, prune, confirm? } }` for batch/declarative-sync asset directories. Returns the apply operation and structured warnings; stops before upload/commit on confirmation-required warnings unless every blocking code is covered by `allow_warning_codes` or broad `allow_warnings`.
- Typed `run402.deploy.ts` configs are executable local code and are not a separate MCP tool in v1. For that workflow, use the canonical CLI/SDK path: `run402 up --manifest run402.deploy.ts --check` -> `run402 up --manifest run402.deploy.ts --plan` -> `run402 up --manifest run402.deploy.ts --require-plan <plan_id>`, or the SDK `r.up({ manifest }, { mode })` execution-mode union. MCP callers should pass already-normalized `ReleaseSpec` objects to `deploy`; do not ask MCP to auto-execute TypeScript configs from a checkout.
- `deploy_resume` — resume a deploy operation by `operation_id`.
- `deploy_list` — list recent deploy operations. Params: `project_id`, `limit?`, `cursor?`.
- `deploy_events` — fetch recorded events for a deploy operation. Params: `project_id`, `operation_id`.
- `deploy_release_get` — fetch release inventory by id. Params: `project_id`, `release_id`, `site_limit?`. Returns release metadata, state kind, site paths, `static_public_paths` browser reachability entries, functions, secret keys, subdomains, materialized routes, applied migrations, `release_generation`, `static_manifest_sha256`, nullable `static_manifest_metadata` (`file_count`, `total_bytes`, `cache_classes`, `cache_class_sources`, `spa_fallback`), and warnings when returned. `site.paths` is release static assets; `static_public_paths[]` carries `public_path`, `asset_path`, `reachability_authority`, and `direct`.
- `deploy_release_active` — fetch the current-live release inventory. Params: `project_id`, `site_limit?`.
- `deploy_release_diff` — diff release targets. Params: `project_id`, `from` (`empty` / `active` / release id), `to` (`active` / release id), `limit?`. Returns `migrations.applied_between_releases`; secret and subdomain diffs expose `added` / `removed` only; route diffs expose `added` / `removed` / `changed`; `static_assets` exposes unchanged/changed/added/removed, newly uploaded CAS bytes, reused CAS bytes, eliminated deployment-copy bytes, `legacy_immutable_warnings`, `previous_immutable_failures`, and `cas_authorization_failures`.
- `deploy_diagnose_url` — URL-first deploy resolver diagnostics. Params: `project_id`, either `url` or `host`/`path`, optional `method`. Returns `would_serve`, `diagnostic_status`, `match`, summary, warnings, next steps, and fenced JSON with the full resolution.

### Portable archives

- `export_project_archive` — operation-backed Cloud export. Params: `project_id`, optional `output_path`, `scope` (`portable-runtime-v1`), `auth` (`stubs` or `none`), `consistency` (`pause-writes` or `cloud_write_pause_v1`), `idempotency_key`, `wait`, `poll_interval_ms`, and `timeout_ms`. Returns archive id/status, output path and byte count when downloaded, `sha256`, `verify_command`, `import_command`, `next_action`, and the archive reports.
- `inspect_project_archive` — local/offline archive inspection. Params: `archive_path`. Returns archive digest/version, transport, file/descriptor counts, required capabilities, required secrets, auth stub count, export report, portability report, and diagnostics.
- `verify_project_archive` — local/offline verification. Params: `archive_path`. Same shape as inspect, with `ok`; an error result still avoids Cloud credentials and network access.
- `import_project_archive` — import into local Run402 Core as a new project only. Params: `archive_path`, optional `name`, `env_file`, `secret_values`, `core_url`, `dry_run`, and `require_runnable`. Automatically verifies before Core import and reports `SECRET_VALUES_REQUIRED`, `PROJECT_ALREADY_EXISTS`, `IMPORT_VERIFY_FAILED`, or `IMPORT_CONFORMANCE_FAILED` with next actions.

### CI/OIDC bindings

- `ci_create_binding` — create a GitHub Actions CI deploy binding by sending a locally signed delegation to the SDK. Params: `project_id`, `provider?` (`github-actions`), `subject_match`, `allowed_actions`, `allowed_events`, `route_scopes?`, `github_repository_id?`, `expires_at?`, `nonce`, `signed_delegation`. The MCP tool does not sign; the signed delegation is the authority boundary.
- `ci_list_bindings` — list project CI bindings, including `route_scopes`. Params: `project_id`.
- `ci_get_binding` — fetch one binding by id. Params: `binding_id`.
- `ci_revoke_binding` — revoke one binding by id. Params: `binding_id`. Revocation stops future CI requests only.

No `route_scopes` means no CI route-declaration authority. Route scopes are exact paths like `/admin` or final wildcard prefixes like `/api/*`. Gateway deploy planning returns `CI_ROUTE_SCOPE_DENIED` when CI tries to ship a route outside the delegated scopes; re-create the binding with covering scopes or run the route-changing deploy locally.

### Functions

- `deploy_function` — deploy a Node 22 serverless function. Params: `project_id`, `name`, `code`, `config?` (`{ timeout?, memory? }`), `deps?` (npm specs: bare names → latest; pinned `lodash@4.17.21`; ranges `date-fns@^3.0.0`; max 30 entries / 200 chars; native binaries rejected; don't list `@run402/functions`). Response surfaces `runtime_version`, `deps_resolved`, `warnings`. For background work, prefer unified deploy manifests with `functions.replace.<name>.triggers[]`; schedule and email triggers create durable function runs.
- `invoke_function` — invoke for testing over the direct `/functions/v1/:name` API-key-protected path. Params: `project_id`, `name`, `method?`, `body?`, `headers?`.
- `get_function_logs` — recent logs (CloudWatch). Params: `project_id`, `name`, `tail?` (default 50, max 1000), `since?` (ISO 8601, locally validated), `request_id?` (`req_...`, `fnrun_...`, or `fnatt_...` for routed/function/run correlation). Returned lines include optional metadata e.g. `request_id`, `event_id`, log stream, and ingestion time.
- `update_function` — change timeout / memory without redeploying code. Legacy schedule mutation exists for old simple-function surfaces; new background work should be declared as ReleaseSpec `triggers[]`.
- `functions_rebuild` — opt-in refresh onto the platform's current entry wrapper + bundled runtime WITHOUT changing source (gateway v1.69+). Params: `project_id`, `name?` (omit to rebuild every function in the project). Re-bundles from each function's STORED source with deps pinned to the recorded exact versions, so the source `code_hash` is unchanged and no new release is created — this is how a gateway-side wrapper fix (e.g. an SSR `auth.*` fix) reaches an already-deployed function; a plain redeploy with unchanged source does NOT pick it up. Wallet-authed (project ownership; no service key) and allowed during billing grace. Functions deployed before dependency locking fail with `CANNOT_REBUILD_UNLOCKED_DEPS` — redeploy them from source via `deploy_function`. Surface stale functions with `list_functions` (`runtime_stale`) or `run402 doctor`.
- `create_function_run` — create a durable function request. Params: `project_id`, `name`, `event_type`, required `idempotency_key`, optional `payload` JSON object, `delay` or `delay_seconds` or `run_at`, `expires_at` or `expires_after`, `retry` (`preset`, `max_attempts`, `min_delay_seconds`, `max_delay_seconds`), and optional `wait` / `timeout_ms` / `poll_interval_ms`.
- `list_function_runs` / `get_function_run` / `get_function_run_logs` — inspect durable function runs by function name or `fnrun_...`; logs use the run correlation path.
- `cancel_function_run` / `redrive_function_run` — cancel queued/scheduled work or redrive a terminal run. Redrive accepts the same retry override and optional wait fields.
- `list_functions` / `delete_function` — list / remove.

For routed browser 500s, copy `X-Run402-Request-Id` or the JSON `request_id` from the response and call `get_function_logs` with that `request_id`. If the incident is older than the default recent lookup window, also pass `since`.

Scheduled function tier limits: prototype 1 trigger / 15 min, hobby 3 / 5 min, team 10 / 1 min. Deploying scheduled triggers beyond the limit returns 403/402 before activation when the cap is known.

### Secrets

- `set_secret` — set a secret as `process.env.<KEY>` inside every function. Params: `project_id`, `key` (uppercase alphanumeric + underscores), `value`.
- `list_secrets` — list secret keys and timestamps. Values and value-derived hashes are write-only and never returned.
- `delete_secret` — params: `project_id`, `key`.

### Managed jobs

Platform-managed jobs. These tools do not run arbitrary Docker images; they submit a run402-configured gateway `job_type` with a JSON `input.input_json` object and a hard `max_cost_usd_micros` cap. The SDK supplies the required idempotency header.

- `jobs_submit` — submit a managed job. Params: `project_id`, `request` (`job_type`, `input`, `max_cost_usd_micros`).
- `jobs_get` — get a job run. Params: `project_id`, `job_id`.
- `jobs_logs` — read runner logs. Params: `project_id`, `job_id`, `tail?` (max 1000), `since?` (ISO 8601; legacy epoch milliseconds also accepted).
- `jobs_cancel` — cancel a queued or running job. Params: `project_id`, `job_id`.
- `jobs_purge` — purge all job runs for a project. Params: `project_id`. Returns `{deleted_jobs, cancelled_active_jobs, terminated_instances}`.

### Auth & email

- `request_magic_link` — passwordless login, trusted invite, claim, or recovery link. Params: `project_id`, `email`, `redirect_url`, `intent?`, `client_state?`. `intent=invite` requires service key state.
- `verify_magic_link` — exchange token for `access_token` + `refresh_token`. Params: `project_id`, `token`. Magic-link metadata is included when present.
- `create_auth_user` / `invite_auth_user` — service-key create/update auth users and optionally send trusted invite links. Params include `project_id`, `email`, `is_admin?`, `redirect_url?`, `client_state?`.
- `set_user_password` — change / reset / set. Params: `project_id`, `access_token`, `new_password`, `current_password?`.
- `auth_settings` — update auth controls. Params: `project_id`, `allow_password_set?`, `preferred_sign_in_method?`, `public_signup?`, `require_passkey_for_project_admin?`.
- `passkey_register_options` / `passkey_register_verify` — WebAuthn passkey registration. Params: `project_id`, `access_token`, `app_origin` then `challenge_id`, `response`, `label?`.
- `passkey_login_options` / `passkey_login_verify` — WebAuthn passkey login. Params: `project_id`, `app_origin`, `email?` then `challenge_id`, `response`.
- `list_passkeys` / `delete_passkey` — list or delete the authenticated user's passkeys. Params: `project_id`, `access_token`, `passkey_id?`.
- `create_mailbox` / `get_mailbox` / `update_mailbox` / `delete_mailbox` — up to 5 project-scoped mailbox local parts. The exact managed address is returned as `managed_address` (`<slug>@<project-mail-host>.mail.run402.com`); matching slugs in other projects are allowed. `create_mailbox` is NOT idempotent — a 409 (same-project slug in use / cooldown / project at its 5-mailbox limit) is surfaced as an error, not recovered. `update_mailbox` accepts `mailbox?` (slug or id) and `footer_policy` (`run402_transparency` or `none`); `none` requires hobby/team, while prototype projects return `FOOTER_POLICY_TIER_REQUIRED`. `delete_mailbox` requires `confirm: true` and takes the target via `mailbox_id` (slug or id).
- `list_mailboxes` / `set_mailbox_defaults` — inspect mailbox candidates/default-role/readiness/footer-policy metadata (`is_default_outbound`, `is_auth_sender`, `can_send`, `send_blocked_reason`, `domain_kind`, `footer_policy`, `effective_footer_policy`, `footer_policy_locked_reason`) and set `default_outbound_mailbox_id` / `auth_sender_mailbox_id`. Happy path: `create_mailbox` → `list_mailboxes` → set missing defaults from `next_actions` → optionally `update_mailbox` for footer policy → `send_email`.
- `send_email` — template (`project_invite`, `magic_link`, `notification`) or raw HTML. Single recipient. Params: `project_id`, `to`, `template?` + `variables?` OR `subject?` + `html?` + `text?` + `attachments?`, `from_name?`, `in_reply_to?`, `mailbox?`. If `mailbox` is omitted, the configured outbound default is used; missing/invalid defaults surface typed errors such as `DEFAULT_MAILBOX_REQUIRED` / `DEFAULT_MAILBOX_INVALID` with `next_actions`. Successful sends echo the actual `mailbox_id` and `from_address` when the gateway returns them. `attachments?` (raw mode only): `{ filename, content_base64, content_type }[]`, max 5, ≤ 7 MB total.
- `list_emails` / `get_email` — read messages. Both take an optional `mailbox`.
- `get_email_raw` — return raw RFC-822 bytes for DKIM / zk-email verification (inbound only). Params: `project_id`, `message_id`, `mailbox?`.
- `register_mailbox_webhook` / `list_mailbox_webhooks` / `get_mailbox_webhook` / `update_mailbox_webhook` / `delete_mailbox_webhook` — email-event webhooks (events: `delivery`, `bounced`, `complained`, `reply_received`). Each takes an optional `mailbox`.
- `list_mailbox_webhook_deliveries` / `redrive_mailbox_webhook_delivery` — durable-delivery visibility + replay. Webhook delivery is **at-least-once** with bounded retries + exponential backoff; failures that exhaust the budget (or fail permanently) land in `failed_permanent` — the dead-letter queue. `list_mailbox_webhook_deliveries` (optional `status` filter) inspects pending/delivered/dead-lettered rows; `redrive_mailbox_webhook_delivery` re-queues a dead-lettered delivery after you fix the consumer. The delivered body is the canonical envelope `{ id, type, created_at, schema_version, idempotency_key, payload }` — **consumers MUST dedupe on `idempotency_key`** (also sent as the `Run402-Webhook-Id` header). Mailbox webhooks are unsigned.
- `list_emails` also takes an optional `direction` (`inbound` | `outbound`); omit for both. `direction: inbound` lists received replies — the reconciliation backstop if a `reply_received` webhook is ever lost.
- ProjectDomain email: use `domains_ensure`, `domains_check`, `domains_repair`, and `domains_test_receive` for custom email sending and inbound receive. The retired sender-domain tools are no longer registered.

Tier rate limits: prototype 10/day, hobby 50/day, team 500/day. Unique recipients per lease: 25 / 200 / 1000. Google OAuth is on for all projects with zero config.

### AI helpers

- `generate_image` — text-to-PNG. $0.03 via x402. Params: `prompt`, `aspect?` (`square` / `landscape` / `portrait`).
- `ai_translate` — translate text. Metered per project (requires AI Translation add-on). Params: `project_id`, `text`, `to`, `from?`, `context?`.
- `ai_moderate` — moderate text. Free. Params: `project_id`, `text`.
- `ai_usage` — translation quota.

### Apps marketplace

- `browse_apps` — list public forkable apps. Params: `tag?`.
- `get_app` — inspect app metadata, including expected `bootstrap_variables`. Params: `version_id`.
- `fork_app` — clone schema + site + functions into a new project. If the source has a `bootstrap` function, it runs automatically with the variables you pass. Params: `version_id`, `name`, `subdomain?`, `bootstrap?`. Response includes `bootstrap_result` or `bootstrap_error`.
- `publish_app` — publish a project as a forkable app. Params: `project_id`, `description?`, `tags?`, `visibility?`, `fork_allowed?`.
- `list_versions` / `update_version` / `delete_version` — manage published versions.

### Tier & billing

Tier is per organization, not per project. `set_tier` applies immediately to every project in the organization. `api_calls` / `storage_bytes` / `emailsPerDay` / `maxFunctions` / `maxScheduledFunctions` / `maxSecrets` are pooled across every non-terminal project in the organization; per-function caps (`functionTimeoutSec`, `functionMemoryMb`, `minScheduleIntervalMinutes`) stay per-instance. Multi-wallet organizations (via `link_wallet_to_organization`) share the same pool. Quota-denial error envelopes include `details.scope: "organization" | "project"` — `"organization"` for the pooled path, `"project"` for the orphan fallback (project whose organization row was purged but cascade has not yet run).

- `set_tier` — subscribe / renew / upgrade. Auto-detects action. x402 payment. Params: `tier` (`prototype` / `hobby` / `team`). Organization-wide effect.
- `tier_status` — current organization tier, lease, and `pool_usage` pooled across every project in the organization; function authoring caps when returned.
- `get_quote` — pricing (free, no auth).
- `create_email_organization` — Stripe-only organization by email (no wallet). Params: `email`. Idempotent.
- `link_wallet_to_organization` — link a wallet to an email organization for hybrid Stripe + x402. Response surfaces a `pool_implications` block (organization `tier`, `projects_in_pool_count`, `organization_api_calls_current`, `organization_storage_bytes_current`, `tier_limits`, `over_limit`) so an agent can warn before merging a wallet whose existing usage would push the pool past the cap.
- `billing_history` — ledger.
- `set_auto_recharge` — auto-buy email packs when credits run low.
- `create_checkout` — org checkout for `balance_topup`, `tier`, or `email_pack`. Params: `org_id`, `product`, plus `amount_usd_micros` for balance top-ups or `tier` for tiers.

### KMS signers (on-chain signing)

For agents that sign Ethereum transactions. Private keys never leave AWS KMS. $0.04/day rental + $0.000005/call. Signer creation requires $1.20 cash credit (30 days prepaid). Non-custodial.

- `provision_signer` — params: `project_id`, `chain` (`base-mainnet` / `base-sepolia`), `recovery_address?`.
- `get_signer` / `list_signers` — metadata + live native balance + USD value.
- `set_recovery_address` — set/clear the optional auto-drain address used at day-90 deletion.
- `set_low_balance_alert` — wei threshold; email alerts on drop (24h cooldown).
- `contract_call` — submit a write call. Idempotent on `idempotency_key`. Params: `project_id`, `signer_id`, `chain`, `contract_address`, `abi_fragment`, `function_name`, `args`, `value_wei?`, `idempotency_key?`.
- `contract_deploy` — deploy a contract from the signer (signs `to: null + data: bytecode` creation tx). Same pricing + idempotency as `contract_call`. Params: `project_id`, `signer_id`, `chain`, `bytecode` (0x-prefixed hex; full creation calldata = creation bytecode + ABI-encoded constructor args, concatenated client-side; ≤ 128 KB), `value?`, `idempotency_key?`. Returns `contract_address` synchronously (deterministic CREATE address from `(signer, nonce)`). run402 does NOT compile Solidity — bring your own bytecode.
- `contract_read` — read-only call (free).
- `get_contract_call_status` — lifecycle, gas, receipt.
- `drain_signer` — drain native balance. Works on suspended signers — the safety valve. Requires `X-Confirm-Drain` header equivalent.
- `delete_signer` — schedule KMS key deletion (7-day window). Refused if balance ≥ dust.

### Allowance & organization

- `init` — one-shot setup: allowance + faucet + tier check + project list.
- `status` — full organization snapshot.
- `allowance_status` / `allowance_create` / `allowance_export` — local allowance management.
- `request_faucet` — Base Sepolia testnet USDC.
- `check_balance` — USDC for an allowance address.
- `list_projects` — the named, domain-aware project inventory (project-findability, `GET /projects/v1`). Each row carries `name`, `site_url`, `custom_domains`, the owning org `organization_id`, `created_by`, and v1.57 lifecycle fields (`status`/`effective_status`, `organization_lifecycle_state`, `lease_perpetual`, `deleted_at`, `archived_at`). Membership-scoped by default (org-owned control plane, v1.77+): a wallet *authenticates* but does not *own* — lists projects owned by orgs the wallet's resolved principal is an active member of, ∪ projects with an active per-project grant. Args: `org_id` filters to one org (authorize-before-reveal — non-member/guessed id → 403, non-UUID → 400), `all: true` reads the cross-wallet inventory across every wallet controlling your operator email, and `limit`/`cursor` paginate.
- `rename_project` — rename a project (project-findability, `PATCH /projects/v1/:id`) to fix an auto-generated name. Org `admin`+ (or a `project:write` grant) on the owning org; authorize-before-reveal (unauthorized/guessed id → 403, never a not-found oracle). Uses the wallet's SIWX auth, not a service key, so it works even if the project isn't in the local key store.
- `admin_set_lease_perpetual` — operator escape hatch (v1.57+). Toggles `lease_perpetual` on a organization; when `true`, the organization never advances past `active`. Replaces the v1.56 per-project pin tool (gateway endpoint /projects/v1/admin/:id/pin was removed). Platform-admin only.
- `admin_archive_project` — operator moderation. Sets `projects.archived_at = NOW()` on a single project; siblings on the same organization keep serving. Platform-admin only.
- `admin_reactivate_project` — un-archive a project (flips `archived_at` to NULL). In v1.57 this no longer touches organization lifecycle. Platform-admin only.
- `project_info` / `project_keys` / `project_use` — inspect / set the active project.
- `send_message` — feedback to the Run402 team. Free with active tier.
- `set_agent_contact` — register agent contact info. New or changed emails start an operator reply challenge and return `assurance_level`.
- `get_agent_contact_status` — current contact fields plus `email_verification_status`, `passkey_binding_status`, `assurance_level`, and proof timestamps.
- `verify_agent_contact_email` — start or resend the operator email reply challenge. The challenge secret is never returned.
- `start_operator_passkey_enrollment` — email a short-lived passkey enrollment link to the verified contact email. Requires `email_verified`.

### Project transfer (unified noun, owned-org recipient v1.96+)

Hand off or move a project without redeploying — one noun, three recipient shapes. A **wallet** recipient completes via `accept_project_transfer` (both sides sign SIWX); an **email** recipient completes via `claim_project_transfer` (the recipient claims into an org); an **owned org** recipient (`to_org_id`) is a same-actor move into another org the caller already owns and completes immediately in the first gateway release. Owner-side mutations on pending wallet/email transfers return `409 PROJECT_HAS_PENDING_TRANSFER` for the 72h pending window, so the recipient reviews exactly what they take on.

- `initiate_project_transfer` — start a transfer from the current owner/admin. Provide EXACTLY ONE of `to_wallet`, `to_email`, or `to_org_id`. Wallet inputs: `project_id`, `to_wallet`, optional `billing_policy` (`migrate`, the default), `message`, `kysigned_record_id` → returns `transfer_id`, `expires_at`, `terms_sha256`, project summary. Email inputs: `project_id`, `to_email`, optional `message`, `retain_collaborator_role` (v1.91, `developer` only) → returns `{ status, transfer_id, to_email, expires_at }`. Owned-org inputs: `project_id`, `to_org_id`, optional `message` → same-actor only at first (caller must own source and destination orgs) and returns an accepted result plus `anon_key`/`service_key`, which the SDK/MCP runtime persists locally. You must currently own/admin the project (gateway re-verifies against fresh DB state, not the 60s project cache). `billing_policy`/`kysigned_record_id` are wallet-only; `retain_collaborator_role` is email-only.
- `preview_project_transfer` — fetch the safe review document for any pending transfer kind. Any party may view. Returns project name, custom domains, subdomains, function names, secret NAMES (values are NEVER returned), CI bindings that will be revoked on completion, mailbox summary, billing implications, the verbatim "GitHub repo ownership is not transferred" note, and — on email transfers — the `retain_collaborator` offer.
- `accept_project_transfer` — WALLET completion. Recipient's wallet must equal `to_wallet`. Atomically flips ownership, revokes the previous owner's CI bindings, and stamps a persistent `secrets_rotation_advised` advisory. Secret VALUES are inherited; the response returns `secret_names_inherited[]` so the recipient can rotate them with `set_secret`. (Email transfers complete via `claim_project_transfer`.)
- `claim_project_transfer` — EMAIL completion (the analog of accept). The transfer's addressed email must match your verified email. Inputs: `transfer_id`, optional `organization_id` (omit to create a new org), optional `accept_retained_collaborator`. Like accept, returns the new owner's project keys (persisted to the local project-key cache) so credential-required operations can use them immediately; the project carries a `secrets_rotation_advised` advisory (keys are `project_id`-derived and don't rotate on transfer).
- `cancel_project_transfer` — cancel a pending transfer of any kind (any authorized party). Already-processed transfers return `409 TRANSFER_ALREADY_PROCESSED`. Optional free-text `reason` is recorded on the audit row.
- `list_incoming_transfers` — pending transfers OFFERED TO you (wallet-, email-, and future org-addressed rows, unioned; each entry carries `recipient_kind` + `preview_path`).
- `list_outgoing_transfers` — pending transfers INITIATED BY you (pending rows unioned and tagged by `recipient_kind`).

The freeze covers owner-side mutations (deploy, secret CRUD, function CRUD, custom-domain bind/unbind, scheduled-function changes, mailbox config, CI binding CRUD, project rename). Data-plane traffic (`/rest/v1/*`, function invocation, mailbox send/receive) keeps serving. Payment-path routes (`set_tier`, billing) keep working. The cancel route is intentionally never blocked.

What does NOT transfer: tier lease (stays with the original owner's organization; no Phase 1A proration), KMS signers (wallet-scoped, not project-scoped), GitHub repo ownership (handle out of band), on-chain balance on any wallet.

After accept, `tier_status` surfaces `projects[].secrets_rotation_advised: { advised_at, reason }` on the transferred project, and `incoming_transfers[]` at the top level lists pending offers (each with `preview_path`) so the inbox is visible without a separate `list_incoming_transfers` fetch.

### Organization, membership & grants (v1.77+ org-owned control plane)

A wallet **authenticates**; the **org (organization)** owns projects. Authorization is an org membership role (`owner > admin > developer > billing > viewer`) or a per-project grant. Member/grant mutations require an active `owner`.

- `whoami` — resolve YOUR control-plane principal + every org membership (role + status) + `authenticator_id` (GET `/agent/v1/whoami`). The remote identity; for local wallet/profile state use `status`.
- `list_orgs` — orgs you are a member of, with each org's `org_id`, `display_name`, your role + membership status.
- `create_org` — create an empty org on the prototype tier; you become owner. Params: optional `display_name` (no tier input). Response includes `org_id`, `display_name`, `tier`, `lease_started_at`, `lease_expires_at`. May return `FREE_ORG_OWNER_LIMIT_EXCEEDED`.
- `get_org` — read one org: `{ org_id, display_name, tier, lease_started_at, lease_expires_at, role }`. Any active member; a guessed id gets the same non-revealing 403. Params: `org_id`.
- `rename_org` — set or clear an org's display label (owner-only). Params: `org_id`, `display_name` (`null`/`""` clears). Response includes `org_id`, `display_name`, `tier`, `lease_started_at`, `lease_expires_at`.
- `list_org_members` — members + roles of an org. Params: `org_id`.
- `add_org_member` — add a member BY WALLET (a new wallet is provisioned as a `human` principal). Params: `org_id`, `wallet`, optional `role` (default `developer`). Owner-gated. (Email-first invite is a separate, not-yet-shipped flow.)
- `set_org_member_role` — change a member's role. Params: `org_id`, `principal_id`, `role`. Owner-gated. Demoting the only active owner → `409 LAST_OWNER`.
- `remove_org_member` — remove a member. Params: `org_id`, `principal_id`. Owner-gated. Removing the only active owner → `409 LAST_OWNER`.
The wallet-org CLAIM flow is CLI/SDK only (browser loopback login + step-up); there is no MCP claim tool.
- `create_project_grant` — issue a per-project capability grant to a wallet (agent/CI principals). Params: `project_id`, `wallet`, `capability` (e.g. `deploy`, `functions:write`), optional `policy` / `expires_at`. Requires owner of the project's org.
- `revoke_project_grant` — revoke a grant. Params: `project_id`, `grant_id`. Requires owner of the project's org.

### Service status (no auth, no setup)

- `service_status` — public availability report (24h/7d/30d uptime per capability, operator, deployment topology, schema `run402-status-v1`). Cache: server-side 30s.
- `service_health` — liveness probe with per-dependency results (postgres, postgrest, s3, cloudfront).

These work before `init` — useful for evaluating Run402 or distinguishing platform problems from your own.

## Resource limits

| | Prototype | Hobby | Team |
|---|---|---|---|
| Lease | 7 days | 30 days | 30 days |
| Storage | 250 MB | 1 GB | 10 GB |
| API calls | 500K | 5M | 50M |
| Functions | 5 | 25 | 100 |
| Function timeout | 10s | 30s | 60s |
| Function memory | 128 MB | 256 MB | 512 MB |
| Secrets | 10 | 50 | 200 |
| Scheduled fns | 1 / 15min | 3 / 5min | 10 / 1min |

Deploy preflights literal unified-deploy timeout, memory, cron interval, and scheduled-count values before plan/upload when caps are known; failures are structured `BAD_FIELD` errors with field/value/tier/limit details.

Project rate limit: 100 req/sec. Exceeding returns 429 with `retry_after`. Each project runs in its own Postgres schema; cross-schema access is blocked.

## Project lifecycle (~104-day soft delete)

Gateway v1.57 moved the lifecycle state machine from `internal.projects` to `internal.organizations`. The grace clock now ticks per **organization** — every project on the same organization inherits the same `organization_lifecycle_state`. The live data plane keeps serving the whole time; only the owner's control plane gets gated:

| State | When | What happens |
|---|---|---|
| `active` | — | Full read/write |
| `past_due` | day 0 | Site, REST, email keep serving. Owner gets first email. |
| `frozen` | +14d | Control plane returns 402 with `lifecycle_state` / `entered_state_at` / `next_transition_at`. Site still serves. Subdomain reserved. |
| `dormant` | +44d | Scheduled functions pause. |
| `purged` | +104d | Cascade: schemas dropped, Lambdas deleted, mailboxes tombstoned. Subdomains become claimable 14 days later. |

`set_tier` at any point during grace reactivates the **organization** inline and clears every project's timers in one transaction. Each `list_projects` entry exposes:

- `effective_status` — derived for serving / UX (`active` / `past_due` / `frozen` / `dormant` / `archived` / `deleted`). When a single project is moderate-archived or user-deleted, this differs from the organization lifecycle.
- `organization_lifecycle_state` — the raw per-organization state; identical across all projects on the same organization.
- `lease_perpetual` — operator escape hatch on the owning organization. When `true`, the organization never advances past `active`. Toggle via `admin_set_lease_perpetual`. Replaces the v1.56 per-project `pinned` flag.

Operator moderation actions are independent of lifecycle and scoped to a single project: `admin_archive_project` and `admin_reactivate_project`.

## Idempotent migrations

Deploy migration entries declare exactly one of `id` or `name`. Use `id` for immutable versioned migrations: same id+SQL noops, same id+different SQL fails with `MIGRATION_CHECKSUM_MISMATCH`, and real revisions need a new id. Use `name` for generated/idempotent SQL; the SDK compiles `<name>_<sha256(sql)[0:16]>` before calling the gateway, so changed content applies once and unchanged re-ups noop. SQL declared with `name` MUST be idempotent because it re-runs when content changes.

`CREATE TABLE IF NOT EXISTS` only handles "already exists" — it won't add new columns. For evolving schemas, wrap `ALTER TABLE` in a `DO` block:

```sql
CREATE TABLE IF NOT EXISTS items (id serial PRIMARY KEY, title text NOT NULL);
DO $$ BEGIN
  ALTER TABLE items ADD COLUMN priority int DEFAULT 0;
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;
```

Safe to re-run on every deploy.

## SQL guardrails

The SQL endpoint blocks: `CREATE EXTENSION`, `COPY ... PROGRAM`, `ALTER SYSTEM`, `SET search_path`, `CREATE/DROP SCHEMA`, `GRANT/REVOKE`, `CREATE/DROP ROLE`. Use the expose manifest for access control instead of `GRANT`.

## Payment Handling

Two payment rails work with the same wallet key:

- x402 (default): USDC on Base. Prototype = Base Sepolia testnet (free from faucet). Hobby/team = Base mainnet.
- MPP: pathUSD on Tempo Moderato (testnet) / Tempo (mainnet). Switch rails via `run402 init mpp` in the user's shell.

The MCP server handles all signing automatically. When a paid tool returns 402, the response includes payment details as informational text — guide the user through funding, then retry the same tool call.

For real-money tiers, two paths to fund:
- Path A — fund the agent allowance: human sends USDC on Base mainnet to the address from `allowance_export`. Agent pays autonomously via x402 from then on.
- Path B — Stripe credits: create or pick the organization, then `create_checkout` with `product: "tier"` returns a Stripe URL the human pays once.

Suggest $10 to your human for two Hobby projects, or $20 for one Team plus renewal buffer.

## Troubleshooting

| You see | Likely cause / fix |
|---|---|
| `402 payment_required` on `set_tier` | Allowance is empty. Call `request_faucet` (testnet) or fund with real USDC. |
| `402` with `lifecycle_state: frozen` | Project past lease + 14 days. `set_tier` reactivates instantly. |
| `403 admin_required` | Tool is platform-admin only (e.g., `admin_set_lease_perpetual`, `admin_archive_project`, `admin_reactivate_project`). Use a platform admin allowance wallet; project owners can't toggle these on their own. |
| `403 NOT_AUTHORIZED` on a control-plane action | Org-owned control plane (v1.77+): the wallet authenticated, but its principal lacks the org role/grant for this action — not a payment or lease issue. `details` carries `required_role` / `required_capability` / `reason`. Obtain a covering org membership/role or per-project grant; high-stakes ops (delete, transfer, membership change) need an active `owner` membership. Returned as 403 even when the project doesn't exist (existence isn't leaked), so also re-check the `project_id`. |
| `409 LAST_OWNER` on `remove_org_member` / `set_org_member_role` | An org must keep at least one active `owner`. The change would remove or demote the last one. Promote another member to `owner` first (`set_org_member_role`), then retry. |
| `409 PROJECT_HAS_PENDING_TRANSFER` on an owner-side mutation | A pending project transfer is freezing the control plane. `details.transfer_id` carries the id; `next_actions[]` has the cancel route. Run `cancel_project_transfer` to unblock, or `preview_project_transfer` to view what's pending. The freeze auto-clears 72h after init. |
| Empty `[]` from `rest_query` for anon | Table not in manifest with `expose: true`. Call `apply_expose`. |
| `403 forbidden_function` calling an RPC | Function not in the manifest's `rpcs[]`. Add `{ name, signature, grant_to: ["authenticated"] }` and re-apply. |
| `409 reserved` from `claim_subdomain` | Original owner's grace period — subdomain held until +118 days from lease expiry. |
| `429 rate_limited` | 100 req/sec project cap. Back off using `retry_after`. |
| CDN serves old bytes | Use the immutable `cdn_url` from `assets_put`, or call `wait_for_cdn_freshness` on a mutable URL. |
| `422 relation already exists` on redeploy | Wrap migrations in `CREATE TABLE IF NOT EXISTS` + `DO`-block `ALTER TABLE`. |
| `insufficient_funds` right after faucet | Wait for the faucet tx to confirm (~5s on Base Sepolia) before subscribing. |

## Install

Stdio MCP transports must keep stdout reserved for JSON-RPC. Use the package bin (`npx -y run402-mcp`) or `node dist/index.js` from a built checkout. If a host insists on `npm start`, set `npm_config_loglevel=silent`; npm's lifecycle banner is stdout and otherwise appears as non-JSON prelude. The repo `.npmrc` and Docker image set this for source/container hosts.

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "run402": { "command": "npx", "args": ["-y", "run402-mcp"] }
  }
}
```

### Cursor

Add to `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "run402": { "command": "npx", "args": ["-y", "run402-mcp"] }
  }
}
```

### Cline

Add to your Cline MCP settings (same shape as above).

### Claude Code

```bash
claude mcp add run402 -- npx -y run402-mcp
```

## See also

- Wayfinder: <https://run402.com/llms.txt>
- SDK reference: <https://docs.run402.com/llms-sdk.txt>
- CLI reference: <https://docs.run402.com/llms-cli.txt>
- HTTP API reference: <https://run402.com/llms-full.txt>
- Site: <https://run402.com>
