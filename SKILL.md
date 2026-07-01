---
name: run402
description: Provision Postgres + REST API + auth + content-addressed storage + serverless functions + email — paid with x402 USDC on Base. Prototype tier is free on testnet. Use when the user asks to build a webapp, deploy a site, create a database, generate images, or mentions Run402.
metadata:
  openclaw:
    emoji: "🐘"
    homepage: https://run402.com
    requires:
      bins:
        - npx
    install:
      - kind: node
        package: "run402-mcp"
        bins: [run402-mcp]
    primaryEnv: RUN402_API_BASE
---

# Run402 — Postgres, storage & deploys for AI agents

Run402 gives an agent a real Postgres database with REST API and user auth, content-addressed CDN storage, static site hosting, Node 22 serverless functions, email, image generation, and KMS-backed on-chain signing. **Prototype tier is free on testnet** — no real money, no human signup. Payment happens automatically via x402 USDC on Base, MPP pathUSD on Tempo, or Stripe credits.

This skill assumes you're calling `run402-mcp` tools directly (Claude Desktop, Cursor, Cline, Claude Code). The body teaches you which tool to reach for and what the modern patterns are; full parameter schemas live in the MCP tool descriptions.

## Quickstart

Six tool calls, zero-to-deployed:

1. **`init`** — set up the local allowance, request the testnet faucet, snapshot tier + projects.
2. **`set_tier`** with `tier: "prototype"` — free on testnet; verifies x402 setup end-to-end.
3. **`provision_postgres_project`** with `name` — returns `project_id`, `anon_key`, `service_key`. Embed `anon_key` in your HTML before deploying.
4. **`run_sql`** with `sql: "CREATE TABLE …"` — set up your schema. Make migrations idempotent.
5. **`validate_manifest`**, then **`apply_expose`** with a manifest — check and declare which tables are reachable via PostgREST. Tables are dark by default.
6. **`deploy_site_dir`** with `dir` (or `deploy_site` with inline files) — incremental upload, only PUTs bytes the gateway doesn't already have. Returns a live URL plus auto-claimed subdomain on subsequent deploys.

Optional next: **`deploy_function`** for server logic, **`assets_put`** to host images/JS/CSS with paste-and-go URLs, **`create_mailbox` → `list_mailboxes` / `set_mailbox_defaults` / `update_mailbox` → `send_email`** for transactional mail.

Typed `run402.deploy.ts` config files are executable local code and are handled by the CLI/SDK, not by a separate MCP tool in v1. For repo-level typed config, run `run402 up --manifest run402.deploy.ts --check`, then `--plan`, then `--require-plan <plan_id>`. `--check` is local-only; `--plan` is gateway-reviewed and returns `plan_fingerprint`; `--require-plan` applies only that reviewed intent.

## Error Envelopes and Safe Retry

Run402-originated JSON errors may include a canonical envelope. Branch on the stable `code`, not English `message` or legacy `error` text. `message` is for display; `error` is a legacy fallback.

Important fields:
- `code` — stable machine-readable reason, e.g. `PROJECT_FROZEN`, `PAYMENT_REQUIRED`, `MIGRATION_FAILED`, `MIGRATE_GATE_ACTIVE`
- `retryable` — the same request may succeed later
- `safe_to_retry` — repeating the same request should not duplicate or corrupt a mutation
- `mutation_state` — gateway-known mutation progress: `none`, `not_started`, `committed`, `rolled_back`, `partial`, or `unknown`
- `trace_id` — include this when reporting a Run402 issue
- `request_id` — routed/function failure handle; use `get_function_logs` with `request_id` for function diagnostics. This is distinct from gateway `trace_id`.
- `details` — structured route-specific context
- `next_actions` — advisory suggestions such as `authenticate`, `submit_payment`, `renew_tier`, `check_usage`, `retry`, `resume_deploy`, `edit_request`, `edit_migration`, `create_project`, `initialize_wallet`, or `deploy`; render or follow them only after validating the action is safe. On a cold start, follow the chain rather than memorizing it: a deploy with no allowance points to wallet setup, no tier points to `renew_tier`, no project points to `create_project` — do each, then retry the deploy

Safe retry policy:
- If `retryable: true` and `safe_to_retry: true`, retry the same request, preferably with the same idempotency key for mutating operations.
- `safe_to_retry: true` alone is not a retry signal; it means duplicate-safe, not likely-to-succeed. Lifecycle-gated writes, auth token exchanges, and passkey verifies need the indicated action before retrying.
- The unified **`deploy`** tool already handles safe `BASE_RELEASE_CONFLICT` release races for omitted/current-base specs by re-planning through the SDK. A handled retry appears as a `deploy.retry` progress event; exhausted retries include `attempts`, `max_retries`, and `last_retry_code`. Do not hand-roll this specific deploy race loop.
- If a mutating request returns a 5xx with `safe_to_retry: false`, or `mutation_state` is `committed`, `partial`, or `unknown`, inspect or poll state before retrying. For deploys, use deploy events/list/resume context before sending another mutation.
- Lifecycle/payment errors usually want an action rather than a blind retry: `PROJECT_FROZEN`/`PROJECT_DORMANT`/`PROJECT_PAST_DUE` -> `get_usage` or `set_tier`; `PAYMENT_REQUIRED`/`INSUFFICIENT_FUNDS` -> submit/fund payment.

Examples:
```json
{
  "message": "Project is frozen.",
  "code": "PROJECT_FROZEN",
  "category": "lifecycle",
  "retryable": false,
  "safe_to_retry": true,
  "mutation_state": "none",
  "next_actions": [{ "type": "renew_tier" }, { "type": "check_usage" }]
}
```

```json
{
  "message": "Payment required.",
  "code": "PAYMENT_REQUIRED",
  "category": "payment",
  "retryable": true,
  "safe_to_retry": true,
  "next_actions": [{ "type": "submit_payment" }]
}
```

```json
{
  "message": "Migration failed.",
  "code": "MIGRATION_FAILED",
  "category": "deploy",
  "retryable": false,
  "safe_to_retry": true,
  "mutation_state": "rolled_back",
  "trace_id": "trc_...",
  "details": { "phase": "migrate", "operation_id": "op_..." },
  "next_actions": [{ "type": "edit_migration" }]
}
```

## Project credentials

After `provision_postgres_project`, two keys are saved automatically to `~/.config/run402/projects.json` and reused by every subsequent tool call:

- **`anon_key`** — read-only by default; safe in browser HTML. RLS still applies.
- **`service_key`** — server-side admin. **Never embed in browser code.** CORS is intentionally open for x402 clients, so a leaked service_key is exploitable from any origin. Use only inside functions or when calling tools as the agent.

Neither key expires. Lease enforcement happens server-side. To inspect, call **`project_keys`**; to switch the active project for sticky-default tools, call **`project_use`**.

## The patterns

### Paste-and-go assets — content-addressed URLs with SRI

When you upload a file with **`assets_put`**, the response is an `AssetRef`. The URL is content-addressed (`pr-<public_id>.run402.com/_blob/<key>-<8hex>.<ext>`), served through CloudFront, and never needs cache invalidation:

| Field on the response | Use it for |
|---|---|
| `cdn_url` | Drop straight into `src=` / `href=` in generated HTML |
| `sri` | `sha256-<base64>` for `<script integrity="…">` if you build tags by hand |
| `etag` | Strong `"sha256-<hex>"` ETag |
| `cache_kind` | `immutable` / `mutable` / `private` |

`immutable: true` is the default — the gateway hashes the bytes client-side, returns a content-hashed URL, and the browser refuses execution on byte mismatch. No cache-invalidation choreography. Pass `immutable: false` only for very large uploads where you don't need a content-hashed URL or SRI.

When you need to verify a deployed asset is fresh (e.g. you suspect cache staleness), call **`diagnose_public_url`** — it returns expected vs observed SHA, cache headers, invalidation status, and an actionable `hint`. For mutable URLs only, **`wait_for_cdn_freshness`** polls until the CDN serves the expected SHA. **Don't call `wait_for_cdn_freshness` on immutable URLs** — they're correct from the moment of upload.

### Dark-by-default tables + the expose manifest

**Tables you create are dark by default.** Until your manifest declares a table with `expose: true`, it's invisible to anon and authenticated callers via `/rest/v1/*`. This eliminates the "agent created a table, forgot to set RLS, data leaked" footgun. The manifest is the single source of truth for what's reachable.

JSON Schema: <https://run402.com/schemas/manifest.v1.json>. Set `$schema` on your manifest object and any editor gives autocomplete.

#### Preferred: declare `database.expose` in deploy

Authorization travels with your release. When you call **`deploy`**, put the manifest object under `database.expose`; the gateway validates it against the migration SQL and applies it atomically with the rest of the release.

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

#### Non-mutating validation: `validate_manifest`

Before applying, call **`validate_manifest`** with `manifest` (object or JSON string), optional `migration_sql`, and optional `project_id`. It validates the auth/expose manifest used by `database.expose` and `apply_expose`; it does not validate deploy manifests. Migration SQL is only reference context for manifest checks and is not executed as a PostgreSQL dry run. The result preserves `{ has_errors, errors, warnings }` in fenced JSON, and `has_errors: true` is data rather than a tool failure.

#### Imperative: `apply_expose` and `get_expose`

For ad-hoc changes outside a deploy — same JSON shape, no bundle:

- **`apply_expose`** with `project_id` + `manifest` — applies the manifest. Convergent: applying the same manifest twice is a no-op; items removed between applies have their policies, grants, triggers, and views dropped.
- **`get_expose`** with `project_id` — returns the live state. `source: "applied"` means it came from a prior apply or deploy; `source: "introspected"` means no manifest has ever been applied and the response was reconstructed from live DB state.

#### Built-in policies

| Policy | Allows |
|---|---|
| `user_owns_rows` | Rows where `owner_column = auth.uid()`. With `force_owner_on_insert: true`, a BEFORE INSERT trigger sets it automatically. **Default for anything user-scoped.** |
| `public_read_authenticated_write` | Anyone reads. Any authenticated user writes any row. For shared boards / collaborative content. |
| `public_read_write_UNRESTRICTED` | Fully open. Requires `i_understand_this_is_unrestricted: true` on the table entry. Only for guestbooks / waitlists / feedback forms. |
| `custom` | Escape hatch. Provide `custom_sql` with `CREATE POLICY` statements. |

Views always run with `security_invoker=true` — they inherit the underlying table's RLS, so they can't accidentally leak hidden columns. RPCs are not exposed unless listed in `rpcs[]` (a database event trigger revokes PUBLIC EXECUTE on every newly-created function).

### Slick deploys — `deploy_site_dir` + plan/commit

Prefer **`deploy_site_dir`** over `deploy_site` whenever you have a directory path. It walks the directory, hashes each file client-side, asks the gateway _which_ bytes it doesn't already have, and only uploads those. Re-deploying an unchanged tree returns immediately with `bytes_uploaded: 0`.

The response's `content` array includes a fenced `json` block of buffered unified `DeployEvent` objects you can `JSON.parse`.

For full-stack deploys (database + migrations + manifest + secret dependencies + functions + site + subdomain), use **`deploy`**. Set secret values first with **`set_secret`**, then deploy with value-free `secrets.require[]`; never put secret values in deploy specs.

After deploys, use read-only release observability instead of starting another mutation: **`deploy_release_active`** for the current-live inventory, **`deploy_release_get`** for a specific release id, and **`deploy_release_diff`** to compare `empty`, `active`, or release-id targets. Inventories expose site paths, `static_public_paths` when returned, functions, secret keys only, subdomains, materialized routes, applied migrations, `release_generation`, `static_manifest_sha256`, nullable `static_manifest_metadata`, and warnings when returned. `site.paths` is the release static asset inventory; `static_public_paths[]` is the browser reachability inventory with `public_path`, `asset_path`, `reachability_authority`, `direct`, cache class, and content type. Diffs use `migrations.applied_between_releases`, route `added` / `removed` / `changed` buckets, and `static_assets` counters for unchanged/changed/added/removed files, CAS byte reuse, eliminated deployment-copy bytes, and immutable/CAS warning counts.

#### Same-origin web routes

Use the unified **`deploy`** tool for `site.public_paths` clean static browser URLs and public browser routes to functions or exact method-aware static aliases. Release static asset paths and public browser paths are distinct: `events.html` can be a private release asset while `/events` is the public static URL.

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

Omit `routes` or pass `routes: null` to carry forward base routes. Use `routes: { "replace": [] }` to clear the route table. Do not use path-keyed maps. Function targets use `{ "type": "function", "name": "<materialized function name>" }`. Prefer `site.public_paths` for ordinary clean static URLs such as `/events -> events.html`. Static route targets use exact patterns only, methods `["GET"]` or `["GET","HEAD"]`, and `{ "pattern": "/events", "methods": ["GET", "HEAD"], "target": { "type": "static", "file": "events.html" } }` for route-only aliases; `file` is a release static asset path, not a public path, URL, CAS hash, rewrite, or redirect. Direct `/functions/v1/:name` remains API-key protected; browser-routed paths are public same-origin ingress, so the function owns application auth, CSRF for cookie-authenticated unsafe methods, CORS/`OPTIONS`, cookies, redirects, and spoofed forwarding-header hygiene.

Matching is exact or final `/*` prefix only. `/admin/*` does not match `/admin`; use both `/admin` and `/admin/*` for a dynamic area root. Query strings are ignored for matching and preserved in the handler's full public `req.url`. Exact beats prefix, longest prefix wins, and method-compatible dynamic routes beat static assets. A `POST /login` route can coexist with static `GET /login` HTML. Unsafe method mismatch returns `405`; matched dynamic route failures fail closed.

Routed functions use the Node 22 Fetch Request -> Response contract: `export default async function handler(req) { ... }`. `req.method` is the browser method, and `req.url` is the full public URL on managed subdomains, deployment hosts, and verified custom domains. Derive OAuth callbacks from it, for example `new URL("/admin/oauth/google/callback", new URL(req.url).origin)`. Append multiple cookies with `headers.append("Set-Cookie", value)`; redirects, cookies, and query strings are preserved. The raw `run402.routed_http.v1` envelope is internal; do not write route handlers against it.

Use **`deploy_diagnose_url`** before changing deploys when the question is "what would this public URL serve?" Pass `project_id`, either `url` or `host`/`path`, and optional `method`. It returns `would_serve`, `diagnostic_status`, `match`, normalized request data, warnings, structured next steps, and fenced JSON. Query strings/fragments in URL mode are reported under `request.ignored`. When returned, `asset_path`, `reachability_authority`, and `direct` explain which release asset backs the public URL and whether reachability came from implicit file-path mode, explicit `site.public_paths`, or a route-only static alias. Stable-host diagnostics may also include `authorization_result`, `cas_object` (`sha256`, `exists`, `expected_size`, `actual_size`), hostname-specific `response_variant`, and route/static fields such as `allow`, `route_pattern`, `target_type`, `target_name`, and `target_file`. Known `match` literals are `host_missing`, `manifest_missing`, `active_release_missing`, `unsupported_manifest_version`, `path_error`, `none`, `static_exact`, `static_index`, `spa_fallback`, `spa_fallback_missing`, `route_function`, `route_static_alias`, and `route_method_miss`; preserve unknown future strings. Known `authorization_result` values include `authorized`, `not_public`, `not_applicable`, `manifest_missing`, `target_missing`, `active_release_missing`, `unsupported_manifest_version`, `path_error`, `missing_cas_object`, `unfinalized_or_deleting_cas_object`, `size_mismatch`, and `unauthorized_cas_object`. Known `fallback_state` values include `active_release_missing`, `unsupported_manifest_version`, and `negative_cache_hit`; preserve unknown future strings. `result` is diagnostic body status, not MCP transport status, so host misses can be successful calls with `would_serve: false`. Do not use diagnostics as a fetch, cache purge, or reason to parse prose instead of the fenced JSON. For `route_method_miss`, inspect `allow`; for CAS authorization/health failures, inspect `cas_object` or redeploy the affected static asset.

Known route warning recovery: `PUBLIC_ROUTED_FUNCTION` means review app auth, CSRF, CORS/`OPTIONS`, and cookies before retrying with `allow_warning_codes` for that code; broad `allow_warnings` is last resort after every warning is reviewed. `ROUTE_SHADOWS_STATIC_PATH` and `WILDCARD_ROUTE_SHADOWS_STATIC_PATHS` mean inspect affected paths, active routes, `static_public_paths`, and resolve diagnostics before confirming. `STATIC_ALIAS_SHADOWS_STATIC_PATH`, `STATIC_ALIAS_RELATIVE_ASSET_RISK`, `STATIC_ALIAS_DUPLICATE_CANONICAL_URL`, `STATIC_ALIAS_EXTENSIONLESS_NON_HTML`, and `STATIC_ALIAS_TABLE_NEAR_LIMIT` are route-only static alias warnings; prefer `site.public_paths` for ordinary clean URLs, inspect the backing `asset_path`, fix relative assets/canonical URLs, and avoid table-exhausting page-by-page routes. `ROUTE_TARGET_CARRIED_FORWARD` means inspect carried-forward function targets. `METHOD_SPECIFIC_ROUTE_ALLOWS_GET_STATIC_FALLBACK` means confirm static fallback is intended. `WILDCARD_ROUTE_EXCLUDES_MUTATION_METHODS` means a wildcard API prefix only allows `GET`/`HEAD`; add mutation methods such as `POST`, omit methods for an API prefix, or set `acknowledge_readonly: true` on an intentionally read-only GET/HEAD final-wildcard function route. `ROUTE_TABLE_NEAR_LIMIT` means consolidate routes. `ROUTES_NOT_ENABLED` means deploy without `routes` or request enablement. Runtime route failure codes to branch on: `ROUTE_MANIFEST_LOAD_FAILED` (manifest/propagation), `ROUTED_INVOKE_WORKER_SECRET_MISSING` (custom-domain Worker secret), `ROUTED_INVOKE_AUTH_FAILED` (internal invoke signature), `ROUTED_ROUTE_STALE` (selected route failed release revalidation), `ROUTE_METHOD_NOT_ALLOWED` (method mismatch), and `ROUTED_RESPONSE_TOO_LARGE` (body over 6 MiB).

#### Routed functions: locale awareness

Declare supported locales as a `spec.i18n` release slice and the gateway negotiates a locale per routed-function request, then surfaces it to user code through two request headers. Use the unified **`deploy`** tool with an `i18n` block alongside `functions` and `routes`:

```json
{
  "project_id": "prj_...",
  "functions": {
    "replace": {
      "api": {
        "runtime": "node22",
        "source": { "data": "export default async (req) => { const locale = req.headers.get('x-run402-locale'); const def = req.headers.get('x-run402-default-locale'); return Response.json({ locale, default: def }); }" }
      }
    }
  },
  "routes": {
    "replace": [
      { "pattern": "/api/*", "target": { "type": "function", "name": "api" } }
    ]
  },
  "i18n": {
    "default_locale": "en",
    "locales": ["en", "es", "fr", "zh-Hant"],
    "detect": ["cookie:wl_locale", "accept-language"]
  }
}
```

Carry-forward semantics: omit `i18n` to carry forward from base release; pass `"i18n": null` to clear the slice on the new release; pass `{ default_locale, locales, detect? }` to replace. Simpler than `routes` — no `{ replace }` envelope.

Locale-tag rules (strict, no canonicalization):
- `default_locale` MUST be byte-identical to one entry in `locales[]`. The gateway does NOT silently canonicalize; adapters normalize this to SDK `defaultLocale` before planning.
- Each tag MUST match `/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/` AND be in RFC 5646 canonical casing: primary subtag lowercase, script subtag Titlecase, 2-alpha region UPPERCASE, 3-digit (UN M.49) region preserved, variants/extensions lowercase. Examples: `pt-BR`, `zh-Hant`, `zh-Hant-TW`, `de-1996`. Non-canonical casing is rejected at deploy time with `code: "R402_LOCALE_NOT_CANONICAL"` (HTTP 400) carrying `fix: { input, canonical }` so agents can auto-correct and retry. The platform refuses to silently canonicalize because translations are typically keyed on the literal locale string in your DB (`section_translations.language = 'pt-BR'`) — auto-fixing would split the spec from your column values.
- `locales[]` is non-empty, max 50 entries.
- Negotiation returns canonical casing from `locales[]`, NOT the request's casing.

Detection (`detect[]`, default `["accept-language"]`, max 10, `[]` allowed and means "always default"):
- Walked in order; first match wins.
- `"accept-language"` parses per RFC 9110, drops `q=0` and `*`, sorts by q descending; applies RFC 4647 §3.4 lookup-style truncation (`zh-Hant-TW` → `zh-Hant` → `zh`); longest matching prefix wins. A generic request tag does NOT match a more-specific `locales[]` entry — `Accept-Language: es` does NOT match `locales: ["es-MX"]`.
- `"cookie:<name>"` does a case-sensitive cookie-name lookup; the raw cookie value (no percent-decode) is matched case-insensitively against `locales[]`. Cookie names MUST match RFC 6265 grammar (`/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/`).

Read the negotiated locale inside a routed function:

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

`x-run402-locale` and `x-run402-default-locale` are OMITTED entirely when the active release has no `i18n` slice (additive-compat). The gateway injects them at request time, so already-deployed function bundles see new headers on the next deploy that adds `i18n` — no function redeploy required. The bundled `@run402/functions` runtime translates the routed envelope into a Web-standard `Request` before calling user code, so the routed-envelope `context.locale` is NOT visible to typical user functions — read the headers instead. Single-arg `(req)` signature, not `(req, ctx)`.

Static-route hits do NOT receive locale negotiation; only routed HTTP function invocations do. Run402 does NOT inject `Vary` headers — apps that return public-cacheable responses varying by locale must set their own `Vary` until per-locale edge caching ships.

#### Client-side gotcha: language switchers must write a cookie

Apps that persist locale to `localStorage` only (a common pattern from Astro/Next i18n tutorials) won't be seen by Run402's server-side negotiation. Mirror the locale to a cookie so the next request hits the right translations, then declare a cookie source in `spec.i18n.detect`:

```js
function setLanguage(lang) {
  localStorage.setItem('wl_locale', lang);
  document.cookie =
    `wl_locale=${encodeURIComponent(lang)}; path=/; max-age=31536000; samesite=lax`;
}
```

```json
{ "i18n": { "default_locale": "en", "locales": ["en", "es"], "detect": ["cookie:wl_locale", "accept-language"] } }
```

### In-function helpers — `db(req)` vs `adminDb()`

Inside a deployed function, import from `@run402/functions`. Two distinct DB clients keep RLS clean:

```ts
import { db, adminDb, getUser, email, ai, assets } from "@run402/functions";

export default async (req: Request) => {
  const user = await getUser(req);
  if (!user) return new Response("unauthorized", { status: 401 });

  // Caller-context — Authorization header forwarded; RLS evaluates against the caller's role.
  const mine = await db(req).from("items").select("*").eq("user_id", user.id);

  // Bypass RLS — only when the function acts on behalf of the platform.
  await adminDb().from("audit").insert({ event: "items_read", user_id: user.id });

  if (mine.length === 0) {
    await email.send({ to: user.email, subject: "Welcome", html: "<h1>Hi</h1>" });
  }

  return Response.json(mine);
};
```

- **`db(req)`** — caller-context. Forwards the Authorization header. RLS applies. Default choice.
- **`adminDb()`** — bypasses RLS. Use only for audit logs, cron cleanup, webhook handlers, platform-authored writes.
- **`adminDb().sql(query, params?)`** — raw parameterized SQL, always bypasses RLS.
- **`ai.generateImage({ prompt, aspect? })`** — live image generation from deployed functions, billed/rate-limited against the project organization through `RUN402_SERVICE_KEY`. Aspects: `square`, `landscape`, `portrait`; result: `{ image, content_type, aspect }`. For public routed functions, authenticate/rate-limit app users before calling it.
- **`assets.put(key, source, opts?)`** — upload runtime bytes through the same CAS-backed apply substrate as deploy-time assets. `source` is a string, `Uint8Array`, or `{ content | bytes }`; returns an SDK-compatible `AssetRef`. v1.50 `opts` accept `metadata` (flat bag, ≤4 KB, leaves `string | number | boolean | string[]`) and `exifPolicy` (`"keep"` | `"strip"`); the returned `AssetRef` includes `image_format`, `image_info`, `image_exif`, and `image_exif_policy` for image MIMEs.
- **`getUserId(req)` / `getRole(req)`** (v1.51+, `@run402/functions` 2.5+) — typed reads of the `x-run402-user-id` / `x-run402-user-role` headers the gateway injects when a `FunctionSpec.requireAuth` / `requireRole` gate passed. Both return `string | null`. Use these inside a gated function instead of re-decoding the JWT — the gate already verified the caller and resolved the application role. `getRole(req)` is non-null only when `requireRole` ran (the value is guaranteed to be in `requireRole.allowed`). The JWT `role` from `getUser(req)` is the system role (`anon`/`authenticated`/…), NOT the app role — don't conflate them.
- **`getRun402Context(req)`** (v1.52+, `@run402/functions` 2.7+) — zero-dependency reader for the full per-request context the gateway populates as `x-run402-*` headers. Returns `{ requestId, projectId, releaseId, host, locale, defaultLocale }` (all `string | null`). Use this in non-Astro functions (plain webhook handlers, auth endpoints) instead of hand-rolling `request.headers.get('x-run402-...')` per field — the helper papers over `Request`/`Headers`/plain-object header shapes and any future gateway header renames. Same return shape as `Astro.locals.run402`, so Astro and plain-function code share one mental model. The helper never throws; missing headers come back as `null`.
- **`assets.fromRef(raw)`** (`@run402/functions` 2.7+) — re-hydrate a stored AssetRef (e.g., a JSONB column read from your DB) back into the typed `AssetRef` shape with camelCase aliases + variant map. Pure-local; no network. The recommended persistence pattern is to store the full `AssetRef` returned by `r.assets.put` as JSONB so the variant SHAs + immutable URLs the gateway computed at upload time survive the round-trip (these can't be re-derived from `(source_sha, key)` alone). Tolerant of partial inputs: pre-v1.49 blobs come back without `variants` / `width_px` rather than synthesizing them. Throws only on null/undefined or non-object input.

Fluent surface on both `db(req).from(t)` and `adminDb().from(t)`:
- Reads: `.select()`, `.eq()`, `.neq()`, `.gt()`, `.lt()`, `.gte()`, `.lte()`, `.like()`, `.ilike()`, `.in()`, `.order()`, `.limit()`, `.offset()`
- Writes: `.insert()`, `.update()`, `.delete()` — return arrays of affected rows
- Column narrowing on writes: `.insert({…}).select("id, title")`

For TypeScript autocomplete, `npm install @run402/functions` in your editor's project. Same package also works at build time for static-site generation if you set `RUN402_SERVICE_KEY` + `RUN402_PROJECT_ID` in `.env`.

### Function-level auth gates (v1.51+)

Skip the hand-rolled "decode JWT → query members table → return 403" boilerplate. Declare the gate on your `FunctionSpec` and the gateway enforces it before invoking the function. Unauthorized callers get `401`/`403` without your code running, and the gateway injects the resolved identity into request headers your function can trust.

Two independent fields on `FunctionSpec`:

- **`require_auth: true`** — gateway rejects callers without a valid project user JWT with `401`. No DB lookup.
- **`require_role: { table, id_column, role_column, allowed[], cache_ttl? }`** — gateway resolves the caller's role from the project-schema table (RLS-bypass — the gateway is the trusted intermediary, not the caller) and rejects callers whose role is not in `allowed` with `403`. Implies authentication.

Three worked examples — pass these through the `deploy` MCP tool's `spec.functions.patch.set`:

```jsonc
{
  // 1. Auth-only — any valid project JWT passes.
  "list-my-items": {
    "source": { /* … */ },
    "require_auth": true
  },

  // 2. Single-role — members.role must be "admin".
  "delete-content": {
    "source": { /* … */ },
    "require_role": {
      "table": "members",
      "id_column": "user_id",
      "role_column": "role",
      "allowed": ["admin"],
      "cache_ttl": 60
    }
  },

  // 3. Multi-role — any role in allowed passes.
  "moderate-content": {
    "source": { /* … */ },
    "require_role": {
      "table": "members",
      "id_column": "user_id",
      "role_column": "role",
      "allowed": ["admin", "moderator"]
    }
  }
}
```

Reading the gate result inside the function:

```ts
import { getUserId, getRole } from "@run402/functions";

export default async (req: Request): Promise<Response> => {
  const userId = getUserId(req);   // string | null
  const role = getRole(req);       // string | null
  // For a gated function reached through the gateway:
  //   getUserId is non-null whenever any gate ran;
  //   getRole is non-null whenever requireRole ran (one of `allowed`).
  return Response.json({ actor: userId, role });
};
```

Rules and footnotes:

- **One role table per release.** All `require_role` blocks in a single release must share the same `(table, id_column, role_column)` triple. Different `allowed` sets are fine; different tables are rejected at plan time with `INVALID_SPEC`.
- **Unqualified identifiers.** Schema-qualified names (e.g. `"public.members"`) are rejected. The project schema is resolved server-side.
- **Deploy-time validation.** Missing table or column at activation fails with `DEPLOY_INVALID_ROLE_GATE` (422) *before* flipping the live release.
- **Cache TTL.** Default 60s, max 600s. A demoted user keeps the cached role until expiry — for instant revocation, set `cache_ttl: 0` (fresh lookup per request).
- **Gate applies to both** routed (`/your/route`) and direct (`POST /functions/v1/:name` with API key) invocation. Direct invocation still requires the API key at the edge; the gate runs after API-key auth, against the user JWT.
- **Reading the role — TWO approaches (`@run402/functions` 3.4.0+; `{ from }` since 3.5.0).** The edge gate now authenticates BOTH Bearer and cookie-session SSR callers (`ssr-aware-role-gate`), so pick by function topology. (1) **Dedicated function/route → edge gate:** with a `require_role` gate, `await auth.requireRole("operator")` returns `{ user, role }` (throwing `RoleGateNotConfiguredError` 500 if no gate vs `InsufficientRoleError` 403 for a mismatch); for multi-role gates read `await auth.role()`. It authenticates Bearer AND cookie session, enforces before dispatch, and caches (TTL). For a browser console add `on_deny: "redirect"` + `sign_in_path` (same-origin path) → unauthenticated HTML requests get a `303` to sign-in (401-class only; wrong-role 403 stays an envelope). PER-FUNCTION. (2) **Catch-all SSR function (one fn = console + public fallback), or finer per-path control → in-function `{ from }`:** the per-function edge gate would also gate public 404s + `/admin/login`, so pass `{ from: { table, idColumn, roleColumn } }` — resolves the cookie user + reads their role from your tenant table (RLS-bypass), scoped in-app. On `.astro` pages use `await auth.role({ from })` + `Astro.redirect("/admin/login", 303)` (a throw in frontmatter renders a 500).
- **Scaffold + first-operator bootstrap.** `run402 auth scaffold-roles --roles operator` emits the `app_roles` migration, the `requireRole` snippet, and a service-role `INSERT` for the FIRST operator — the table starts empty, so the first grant bypasses RLS with the service key. The gate keys on the tenant user id (JWT `sub`), not a wallet.

### Astro SSR runtime + ISR cache (v1.52+)

Authoring Astro apps on Run402 uses the `@run402/astro` 1.0+ preset (one-line `export default run402();` in `astro.config.mjs`). The preset wires SnapStart-enabled AWS Lambda SSR with an origin ISR cache. Per-function opt-in is declarative in the release spec:

```json
{
  "functions": {
    "ssr": {
      "class": "ssr",
      "code": { "data": "...", "encoding": "base64" }
    }
  }
}
```

The gateway provisions SnapStart and reverse-validates the published version before activation; failure surfaces as a non-blocking `DEPLOY_FUNCTION_SSR_SNAPSTART_VALIDATION_FAILED` warning.

**Cache behavior is bypass-by-default.** SSR responses only get stored when `Cache-Control` explicitly allows it AND no `Set-Cookie` AND no auth-taint flag — `getUser()` / `getUserId()` / `getRole()` from `@run402/functions` 2.5+ automatically taint per-request caching so personalized renders never get stored. Payment primitives (the `withPaymentTaint()` helper) taint the same way.

**Invalidation is project-scoped and sub-second.** The MCP-exposed surface is the SDK's `cache` namespace (no direct MCP tool yet; use `mcp__run402_sdk` via the SDK or `mcp__shell` to run `run402 cache invalidate`):

- `r.cache.invalidate(url)` — single URL
- `r.cache.invalidatePrefix({ host, prefix })` — path prefix on a host
- `r.cache.invalidateAll({ host })` — all rows for a host
- `r.cache.invalidateMany(urls)` — multiple URLs in one round-trip
- `r.cache.inspect(url)` — returns `{ status: 'HIT' | 'MISS', cachedAt, expiresAt, contentSha256, writtenUnderGeneration }`

Host ownership is server-validated — cross-project invalidation throws `R402_CACHE_INVALIDATION_HOST_FORBIDDEN` (403). Writes are generation-guarded: an in-flight MISS render started before an invalidate cannot overwrite the freshly-cleared state.

Reference: [`astro/README.md`](./astro/README.md) (top section), [`cli/llms-cli.txt`](./cli/llms-cli.txt) (R402_* SSR Runtime Error Codes section).

## Portable project archives (Cloud -> Core)

Use portable archives when the user wants no vendor lock-in for the supported Run402 Core runtime slice. This is a portability trust claim: Cloud is the easiest place to start, not the only place the supported application can run. Keep it separate from allowance/spend-cap financial-risk claims.

Canonical CLI path:

```bash
run402 cloud archives create <project_id> --scope portable-runtime-v1 --auth stubs --consistency pause-writes --wait --output ./project.r402ar --json
run402 archives inspect ./project.r402ar --json
run402 archives verify ./project.r402ar --json
run402 core projects import ./project.r402ar --name imported-project --env-file ./required.env --json
```

MCP tools mirror the same flow: `export_project_archive`, `inspect_project_archive`, `verify_project_archive`, and `import_project_archive`. SDK helpers live under `r.archives`; the Node entry adds local `inspect`, `verify`, and `importToCore`, plus standalone `inspectArchive`, `verifyArchive`, and `importArchiveToCore`.

Archive v1 exports active release/apply state, supported Postgres/RLS/REST data, storage/static bytes, functions, Astro SSR artifacts, disabled auth subject stubs, and value-free secret requirements. It does not export secret values, auth credentials, logs, billing/allowance/spend state, Cloud provider/fleet operations metadata, Cloud import, or existing-project merge import. `verify` is local/offline integrity and compatibility checking, not trust; Core import verifies again and creates a new local project only.

## Tools by category

### Database

- **`provision_postgres_project`** — provision a new database. Auto-handles x402 payment.
- **`run_sql`** — execute SQL (DDL or queries). Service-key-authenticated.
- **`rest_query`** — query/mutate via PostgREST. Pass `key_type: "anon"` (default) for RLS-applied access, `"service"` to bypass.
- **`validate_manifest`** / **`apply_expose`** / **`get_expose`** — declarative authorization manifest (see "expose manifest" above).
- **`get_schema`** — introspect tables, columns, types, constraints, RLS policies.
- **`get_usage`** — per-project usage counters (API calls, storage, lease expiry). The reported tier and capacity limits are **organization-level** — pooled across every project on the same organization. Use `tier_status` for the authoritative pooled total.
- **`promote_user`** / **`demote_user`** — manage `project_admin` role on a project user.
- **`delete_project`** — cascade purge. Irreversible.

### Blob storage (content-addressed CDN)

- **`assets_put`** — upload (any size, up to 5 TiB). Returns an `AssetRef` with `cdn_url`, `sri`, `etag`, `cache_kind`. v1.50: accepts `metadata` (flat bag with `string | number | boolean | string[]` leaves, ≤4 KB) and `exif_policy` (`"keep"` | `"strip"`); response includes `image_format`, `image_info`, `image_exif`, and `image_exif_policy` for image MIMEs. Bad shapes throw `INVALID_ASSET_METADATA` / `INVALID_EXIF_POLICY` before the HTTP call. v1.54: image uploads also return `blurhash_data_url` (pre-decoded ~600-byte PNG data URL — embed as `background-image` for the placeholder, no client-side decoder) and `asset_schema` (semver shape-contract stamp: `"v1.49"` | `"v1.50"` | `"v1.54"` | `null` for partial-shape rows). When persisting an AssetRef for later render, store the full object as JSONB — the variant SHAs and immutable URLs can't be re-derived from `(source_sha, key)` alone. For Astro consumers, **`<Run402Image>` from `@run402/astro@1.0+`** consumes all of the above directly with zero render-time decode and optional strict-mode schema filtering.
- **`assets_get`** — download to a local file (no context-window bloat).
- **`assets_ls`** — keyset-paginated list with prefix filter. v1.50: accepts `sort` (`key:asc` default, `createdAt:asc`, `createdAt:desc`) and `filter` (keys: `uploaded_by`, `tag`, `format`, `is_image`, `min_width`/`max_width`/`min_height`/`max_height`). Cursor is sort-pinned — cross-sort reuse returns `INVALID_CURSOR_FOR_SORT`.
- **`assets_rm`** — delete.
- **`assets_sign`** — time-boxed presigned GET URL for a private blob.
- **`diagnose_public_url`** — live CDN state for a public URL — expected vs observed SHA, cache headers, invalidation status.
- **`wait_for_cdn_freshness`** — poll a mutable URL until it serves the expected SHA-256.

### Sites & subdomains

- **`deploy_site`** — deploy from inline file bytes.
- **`deploy_site_dir`** — deploy from a local directory. Routes through the unified apply primitive (CAS-backed) — only uploads bytes the gateway doesn't have.
- **`claim_subdomain`** — claim `<name>.run402.com` (idempotent; auto-reassigns to latest deployment on subsequent deploys, no re-claim needed).
- **`list_subdomains`** / **`delete_subdomain`** — manage subdomains.
- **`add_custom_domain`** / **`list_custom_domains`** / **`check_domain_status`** / **`remove_custom_domain`** — point your own domain at a Run402 subdomain.
- **`deploy`** / **`deploy_resume`** / **`deploy_list`** / **`deploy_events`** — apply, resume, list, and inspect deploy operations.
- **`deploy_release_get`** / **`deploy_release_active`** / **`deploy_release_diff`** — inspect release inventory and release-to-release diffs.
- **`deploy_diagnose_url`** — URL-first public deploy resolver diagnostics. Params: `project_id`, either `url` or `host`/`path`, optional `method`.

### CI/OIDC bindings

- **`ci_create_binding`** — create a GitHub Actions CI deploy binding from a locally signed delegation. This MCP tool does not sign or broaden authority; the signed delegation defines the repository/branch or environment, allowed events/actions, and optional `route_scopes`.
- **`ci_list_bindings`** / **`ci_get_binding`** / **`ci_revoke_binding`** — inspect and revoke CI bindings, preserving returned `route_scopes`.

No `route_scopes` means no CI route-declaration authority. With route scopes, CI can deploy only matching exact public paths such as `/admin` or final-wildcard prefixes such as `/api/*`. If deploy returns `CI_ROUTE_SCOPE_DENIED`, re-create the binding with covering scopes or run the route-changing deploy locally.

### Functions & secrets

- **`deploy_function`** — deploy a Node 22 serverless function. Cron-schedulable via `schedule`. Pass `deps` as npm specs (bare names → latest at deploy time, pinned `lodash@4.17.21` or ranges `date-fns@^3.0.0` honored verbatim, max 30 entries / 200 chars each, native binaries rejected). Response surfaces `runtime_version`, `deps_resolved`, `warnings`.
- **`invoke_function`** — invoke for testing over the direct `/functions/v1/:name` API-key-protected path.
- **`get_function_logs`** — recent logs (CloudWatch). Use `since` for incremental polling and `request_id` (`req_...`, `fnrun_...`, or `fnatt_...`) to follow a routed browser failure or durable run/attempt.
- **`update_function`** — change schedule / timeout / memory without redeploying code.
- **`functions_rebuild`** — opt-in refresh onto the platform's current runtime WITHOUT changing source (gateway v1.69+). Pass `name` for one function, or omit it to rebuild every function in the project. Re-bundles each function's stored source with deps pinned to the recorded versions, so `code_hash` is unchanged and no new release is created — this is how a gateway-side wrapper fix (e.g. an SSR `auth.*` fix) reaches an already-deployed function; a plain redeploy with unchanged source does not. Wallet-authed, allowed during billing grace. Functions deployed before dependency locking fail with `CANNOT_REBUILD_UNLOCKED_DEPS` — redeploy them from source with `deploy_function`. Find stale functions via `list_functions` (`runtime_stale`) or `run402 doctor`.
- **Durable function runs** — use **`create_function_run`** with required `idempotency_key`, `event_type`, optional JSON `payload`, `delay`/`run_at`, expiry, retry policy, and optional wait. Use **`list_function_runs`**, **`get_function_run`**, **`get_function_run_logs`**, **`cancel_function_run`**, and **`redrive_function_run`** to observe and recover work. Prefer this over ad hoc cron tables or polling loops when delayed work, webhook redrive, or retry safety matters.
- **`list_functions`** / **`delete_function`** — list / remove.
- **`set_secret`** / **`list_secrets`** / **`delete_secret`** — `process.env` secrets injected into every function. Values are write-only; `list_secrets` returns keys and timestamps only. Deploy specs use `secrets.require[]` as a dependency gate, not as a value carrier or per-function allowlist.
- **`jobs_submit`** / **`jobs_get`** / **`jobs_logs`** / **`jobs_cancel`** / **`jobs_purge`** / **`jobs_download_artifact`** — platform-managed jobs. Submit the gateway-shaped request with `job_type`, `input.input_json`, and `max_cost_usd_micros`; this is not arbitrary Docker execution. When a job completes, `jobs_get` returns an `artifacts` map of `{ url, content_type, sha256, size_bytes }` objects (the old `run402://` refs were retired); `jobs_download_artifact` writes one recorded artifact to a local path.

Function authoring limits per tier: prototype 10s / 128 MB / 1 scheduled fn / 15 min, hobby 30s / 256 MB / 3 / 5 min, team 60s / 512 MB / 10 / 1 min. Deploy preflights literal unified-deploy function values before plan/upload and returns structured `BAD_FIELD` details.

### Auth & email

- **`request_magic_link`** / **`verify_magic_link`** — passwordless login and trusted invite links. Tokens single-use, 15-min TTL, rate limited.
- **`create_auth_user`** / **`invite_auth_user`** — service-key user create/update and trusted invite bootstrap.
- **`set_user_password`** — change, reset, or set a user's password.
- **`auth_settings`** — configure password set, preferred sign-in method, public signup policy, and project-admin passkey enforcement.
- **`passkey_register_options`** / **`passkey_register_verify`** — create and verify WebAuthn passkey registration ceremonies.
- **`passkey_login_options`** / **`passkey_login_verify`** — create and verify WebAuthn passkey login ceremonies.
- **`list_passkeys`** / **`delete_passkey`** — list or delete the authenticated user's passkeys.
- **`create_mailbox`** / **`get_mailbox`** / **`update_mailbox`** / **`delete_mailbox`** — up to 5 mailboxes per project at `<slug>@mail.run402.com`. `create_mailbox` is not idempotent (a 409 — slug taken / cooldown / 5-mailbox limit — is surfaced, not recovered). `update_mailbox` sets `footer_policy` (`run402_transparency` or `none`); `none` requires hobby/team, while prototype projects are locked to `run402_transparency` and return `FOOTER_POLICY_TIER_REQUIRED`.
- **`list_mailboxes`** / **`set_mailbox_defaults`** — inspect candidates/default-role/readiness/footer-policy metadata (`is_default_outbound`, `is_auth_sender`, `can_send`, `send_blocked_reason`, `domain_kind`, `footer_policy`, `effective_footer_policy`, `footer_policy_locked_reason`) and explicitly set `default_outbound_mailbox_id` / `auth_sender_mailbox_id`. Happy path: `create_mailbox` → `list_mailboxes` → `set_mailbox_defaults` if `next_actions` says defaults are missing → optionally `update_mailbox` for footer policy → `send_email`.
- **`send_email`** — template (`project_invite`, `magic_link`, `notification`) or raw HTML. Single recipient. Optional `mailbox` selector; if omitted, the configured `default_outbound_mailbox_id` is used. Missing/ambiguous/invalid defaults return typed errors such as `DEFAULT_MAILBOX_REQUIRED` / `DEFAULT_MAILBOX_INVALID` with `next_actions`; successful sends echo the actual `mailbox_id` and `from_address` when the gateway returns them.
- **`list_emails`** / **`get_email`** / **`get_email_raw`** — read messages. `get_email_raw` returns RFC-822 bytes for DKIM / zk-email verification.
- **`register_mailbox_webhook`** / **`list_mailbox_webhooks`** / **`get_mailbox_webhook`** / **`update_mailbox_webhook`** / **`delete_mailbox_webhook`** — email-event webhooks (delivery, bounced, complained, reply_received).
- **`list_mailbox_webhook_deliveries`** / **`redrive_mailbox_webhook_delivery`** — durable-delivery visibility + replay. Delivery is at-least-once (bounded retries + exponential backoff); failures land in `failed_permanent`, the dead-letter queue. The delivered body is the canonical envelope `{ id, type, created_at, schema_version, idempotency_key, payload }` — consumers MUST dedupe on `idempotency_key`. `list_emails` accepts an optional `direction` (`inbound`|`outbound`); `inbound` lists received replies as the reconciliation backstop if a `reply_received` webhook is lost.
- **`register_sender_domain`** / **`sender_domain_status`** / **`remove_sender_domain`** — send from your own domain (DKIM verified).
- **`enable_sender_domain_inbound`** / **`disable_sender_domain_inbound`** — receive replies on your custom sender domain.

Tier rate limits: prototype 10/day, hobby 50/day, team 500/day. Unique recipients per lease: 25 / 200 / 1000. Google OAuth is on for all projects with zero config — `http://localhost:*` and any claimed subdomain are allowed redirect origins.

### AI helpers

- **`generate_image`** — text-to-PNG via x402 ($0.03/image). Aspects: `square`, `landscape`, `portrait`.
- **`ai_translate`** — translate text. Metered per project (requires AI Translation add-on).
- **`ai_moderate`** — moderate text. Free.
- **`ai_usage`** — translation quota.

### Apps marketplace

- **`browse_apps`** — browse public forkable apps.
- **`get_app`** — inspect including expected `bootstrap_variables`.
- **`fork_app`** — clone schema + site + functions into a new project. Runs the app's `bootstrap` function with provided variables.
- **`publish_app`** — publish a project as a forkable app.
- **`list_versions`** / **`update_version`** / **`delete_version`** — manage published versions.

### Tier & billing

Tier is per **organization**, not per project. One subscribe / renew / upgrade applies immediately to every project in the organization, and `api_calls` / `storage_bytes` quotas are enforced against the pooled sum across every non-terminal project in the organization. Multi-wallet organizations (via `link_wallet_to_organization`) share that same pool. Quota-denial errors carry `details.scope: "organization" | "project"` — `"organization"` for the pooled path, `"project"` for the orphan fallback when a project's organization row has been purged but cascade has not yet run.

- **`set_tier`** — subscribe / renew / upgrade. Auto-detects action. x402 payment. Effect is organization-wide.
- **`tier_status`** — current organization tier, lease, **pool_usage across every project in the organization**, and function caps when returned.
- **`get_quote`** — pricing (free, no auth).
- **`create_email_organization`** / **`link_wallet_to_organization`** — email-based organizations; hybrid Stripe + x402. `link_wallet_to_organization` returns a `pool_implications` block (organization tier, current pooled api_calls/storage, tier_limits, `over_limit`) so agents can warn before merging a wallet into a pool that would exceed the cap.
- **`billing_history`** — ledger.
- **`set_auto_recharge`** — auto-buy email packs when credits run low.
- **`create_checkout`** — org checkout for balance top-ups, tiers, or email packs.

### KMS signers (on-chain signing)

For agents that need to sign Ethereum transactions. Private keys never leave AWS KMS. **$0.04/day rental + $0.000005/call.** Signer creation requires $1.20 cash credit (30 days prepaid). **Non-custodial.**

- **`provision_signer`** — `chain: "base-mainnet"` or `"base-sepolia"`. Optional `recovery_address`.
- **`get_signer`** / **`list_signers`** — metadata + live balance + USD value.
- **`set_recovery_address`** / **`set_low_balance_alert`** — optional safety nets.
- **`contract_call`** — submit a write call (chain gas at-cost + KMS sign fee). Idempotent on `idempotency_key`.
- **`contract_deploy`** — deploy a contract from the signer (signs `to: null + bytecode` creation tx). Returns deterministic CREATE address synchronously. Same pricing as `contract_call`. Caller supplies pre-compiled bytecode + ABI-encoded constructor args (run402 doesn't compile Solidity).
- **`contract_read`** — read-only call (free).
- **`get_contract_call_status`** — lifecycle, gas, receipt.
- **`drain_signer`** — drain native balance (works on suspended signers — the safety valve).
- **`delete_signer`** — schedule KMS key deletion (refused if balance ≥ dust).

### Allowance & organization

- **`init`** — one-shot setup: allowance + faucet + tier check + project list.
- **`status`** — full organization snapshot. Includes a `wallet` object naming the active named wallet.

**Multiple wallets.** A user can hold several named wallets (profiles) on one machine — keys never leave the machine. The MCP server picks its wallet from the `RUN402_WALLET` environment variable in your server config (default `default`); set it to a wallet name (e.g. `kychon`) to operate that wallet's projects. The `status` tool surfaces which wallet is active. Wallet creation/selection/binding is done from the CLI (`run402 wallets …`), not via MCP tools.
- **`allowance_status`** / **`allowance_create`** / **`allowance_export`** — local allowance management.
- **`request_faucet`** — testnet USDC.
- **`check_balance`** — USDC for an allowance address.
- **`list_projects`** — the named, domain-aware project inventory (project-findability). Each row carries `name`, `site_url`, `custom_domains`, and the v1.57 lifecycle fields (`status`/`effective_status`, `organization_lifecycle_state`, `lease_perpetual`, `deleted_at`, `archived_at`); the owning org is `org_id` and the provisioning principal is `created_by`. Membership-scoped by default (org-owned control plane, v1.77+): a wallet *authenticates* but does not *own* — lists projects owned by orgs the wallet's resolved principal is an active member of, plus any with an active per-project grant. Pass `org_id` to filter to one org (authorize-before-reveal), `all: true` to read the cross-wallet inventory across every wallet controlling your operator email, or `limit`/`cursor` to paginate.
- **`rename_project`** — rename a project to fix an auto-generated name. Needs org `admin`+ (or a `project:write` grant) on the owning org; authorize-before-reveal. Works even if the project isn't in the local key store (uses the wallet's SIWX auth, not a service key).
- **`admin_set_lease_perpetual`** — operator escape hatch (v1.57+). Toggles the organization's `lease_perpetual` flag so the organization never advances past `active` regardless of lease expiry. Replaces the v1.56 per-project pin tool (gateway endpoint was removed). Enabling on a grace-state organization reactivates inline.
- **`admin_archive_project`** / **`admin_reactivate_project`** — operator moderation actions on a single project (`projects.archived_at`). Independent of organization-level lifecycle.
- **`project_info`** / **`project_keys`** / **`project_use`** — inspect / set the active project.
- **`send_message`** — send feedback to the Run402 team.
- **`set_agent_contact`** / **`get_agent_contact_status`** / **`verify_agent_contact_email`** — register agent contact info, read assurance status, and start the operator email reply challenge.
- **`start_operator_passkey_enrollment`** — email a Run402 operator passkey enrollment link to the verified contact email.
- **`get_operator_status`** — compact operator-health snapshot (contact assurance, critical items, skipped notifications, organizations, projects, active thresholds). Consumed by `run402 doctor`.
- **`get_notification_preferences`** / **`set_notification_preferences`** — read/update operator notification preferences (cadence, channels, per-class toggles, locale, timezone). Cross-wallet effects need `email_verified`; webhook URL changes need `operator_passkey`.
- **`list_notifications`** — per-delivery-attempt audit log. Paginated; filter by event_type / since.
- **`test_notification`** — fire a real test through the full pipeline. Audit row marked `is_test=true`. Rate-limited per wallet at 1/min.
- **`rotate_webhook_secret`** — new HMAC signing secret for the operator webhook (returned once). Previous remains valid 24h. Requires `operator_passkey`.

### Service status (no auth, no setup)

- **`service_status`** — public availability report (24h/7d/30d uptime per capability).
- **`service_health`** — liveness probe with per-dependency results.

These work before `init` — useful for evaluating Run402 or distinguishing platform problems from your own.

## Idempotent migrations

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

The SQL endpoint blocks: `CREATE EXTENSION`, `COPY ... PROGRAM`, `ALTER SYSTEM`, `SET search_path`, `CREATE/DROP SCHEMA`, `GRANT/REVOKE`, `CREATE/DROP ROLE`. Table and sequence permissions are granted automatically — use the expose manifest for access control instead of `GRANT`.

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

Project rate limit: **100 req/sec**. Exceeding returns 429 with `retry_after`. Each project runs in its own Postgres schema; cross-schema access is blocked.

## Project lifecycle (~104-day soft delete)

Gateway v1.57 moved the lifecycle state machine from `internal.projects` to `internal.organizations`. The grace clock now ticks per **organization** — every project on the same organization inherits the same `organization_lifecycle_state`. The live data plane keeps serving the whole time; only the owner's control plane gets gated:

| State | When | What happens |
|-------|------|--------------|
| `active` | — | Full read/write |
| `past_due` | day 0 | Site, REST, email keep serving. Owner gets first email. |
| `frozen` | +14d | Control plane (deploys, secrets, subdomain claims, function upload) returns 402 with `lifecycle_state` / `entered_state_at` / `next_transition_at`. Site still serves. Subdomain reserved so the brand can't be claimed by another wallet. |
| `dormant` | +44d | Scheduled functions pause. |
| `purged` | +104d | Cascade: schemas dropped, Lambdas deleted, mailboxes tombstoned. Subdomains become claimable 14 days later. |

Calling **`set_tier`** during grace reactivates the **organization** inline and clears every project's timers in one transaction. Per-project fields on each `list_projects` row:

- `effective_status` — derived for serving / UX. Equals `organization_lifecycle_state` unless the project is individually archived (`archived_at` set → `archived`) or deleted (`deleted_at` set → `deleted`).
- `organization_lifecycle_state` — the raw per-organization state. Identical across every project on the same organization.
- `lease_perpetual` — operator escape hatch flag on the owning organization. When `true`, the organization never advances past `active`. Replaces the v1.56 per-project `pinned`. Toggle via **`admin_set_lease_perpetual`** (platform-admin only).

Operator moderation actions (independent of lifecycle, scoped to a single project): **`admin_archive_project`** and **`admin_reactivate_project`**.

## Project transfer (unified noun, owned-org recipient v1.96+)

A project can be transferred to a new owner without redeploying — one noun, three recipient shapes. A **wallet** recipient is a two-party SIWX transfer completed by `accept`; an **email** recipient is an email→org transfer the recipient completes by `claim` (claiming the project into an org they own); an **owned org** recipient (`to_org_id`) is a same-actor move into another org the caller already owns and completes immediately in the first gateway release. Owner-side mutations on pending wallet/email transfers freeze for the 72-hour window — the recipient sees exactly what they review.

**Seven tools**: **`initiate_project_transfer`** (owner-or-admin; exactly one of `to_wallet`, `to_email`, or `to_org_id`), **`preview_project_transfer`** (kind-agnostic), **`accept_project_transfer`** (wallet recipient), **`claim_project_transfer`** (email recipient), **`cancel_project_transfer`** (any authorized party), **`list_incoming_transfers`**, **`list_outgoing_transfers`**.

**Flow:**

1. Owner runs **`initiate_project_transfer`** with `project_id` and exactly one of `to_wallet`, `to_email`, or `to_org_id` (optional `message`; the email path adds optional `retain_collaborator_role`; the wallet path adds optional `billing_policy`/`kysigned_record_id`). Wallet/email transfers create a `pending` row with 72h expiry. `to_org_id` is same-actor only at first: caller must own both source and destination orgs, and success returns an accepted result plus project keys.
2. Either party runs **`preview_project_transfer`** with the `transfer_id`. Preview shows custom domains, subdomains, function names, secret NAMES (values are NEVER returned), CI bindings to be revoked, billing implications, and — on email transfers — the `retain_collaborator` offer.
3. The recipient completes by kind:
   - **Wallet** → **`accept_project_transfer`**. Atomic: ownership flips, the previous owner's CI bindings are revoked, both sides get notification emails, the project carries a persistent `secrets_rotation_advised` advisory, and the response returns the new owner's project keys (persisted to the local keystore).
   - **Email** → **`claim_project_transfer`** (`org_id` optional; omit to claim into a new org). Atomic ownership flip, the email analog of accept. Like accept, the response returns the new owner's project keys (persisted to the keystore) and the project carries the `secrets_rotation_advised` advisory.
   - **Owned org** → no separate completion step in the same-actor release; `initiate_project_transfer` completes the move immediately and persists returned project keys.
4. Either side can **`cancel_project_transfer`** at any time before completion. After 72h the gateway auto-expires the pending row.

**Freeze invariant.** While `pending`, every owner-side mutation against the project (deploy, secret CRUD, function CRUD, custom-domain bind/unbind, scheduled-function changes, mailbox config, CI binding CRUD, project rename) returns **409 `PROJECT_HAS_PENDING_TRANSFER`** with `details.transfer_id` and a `next_actions[]` cancel route. Data-plane traffic keeps serving. Payment-path routes (tier renew, billing) keep working. The `cancel_project_transfer` route is intentionally unblocked so recovery is always possible.

**What does NOT transfer:**

- Tier lease stays with the original owner's organization (no proration in Phase 1A).
- KMS signers (`provision_signer`) remain wallet-scoped, not project-scoped.
- GitHub repository ownership — handle that out of band.
- On-chain balance attached to any wallet — `to_wallet` does NOT gain access to `from_wallet`'s funds.

**Billing policy.** Wallet transfers support only `migrate` (default): the project moves into the recipient's organization. The recipient must already have an active organization; if not, the accept returns `409 RECIPIENT_ORGANIZATION_NOT_ACTIVE`. Email and owned-org transfers always migrate ownership; do not send `billing_policy` on those rails.

**Secrets rotation prompt.** After accept, `tier_status` surfaces `projects[].secrets_rotation_advised: { advised_at, reason }` for the transferred project. Use **`set_secret`** to rotate every inherited name; the advisory clears once every one has been re-written.

`list_incoming_transfers` is also surfaced on the top-level `tier_status` response as `incoming_transfers[]` (each entry carries `preview_path`), so a single `tier_status` call shows pending offers without a separate fetch.

## Organization, membership & grants (v1.77+)

A wallet **authenticates**; an **org** owns projects. What a principal may do is decided by its org membership role (`owner > admin > developer > billing > viewer`) or a per-project grant - never by `wallet == signer`. A fresh wallet that subscribes + provisions auto-owns its org-of-one, so this layer stays invisible until a second principal joins. Memberships carry `org_id` + `display_name`.

- **`create_org`** / **`get_org`** / **`rename_org`** - create an empty org (prototype tier; you become owner; optional `display_name`, no tier at create), read one org (`org_id`, `display_name`, `tier`, your `role`), or set/clear its label (owner-only). The free-org cap may return `FREE_ORG_OWNER_LIMIT_EXCEEDED`.
- **`whoami`** - resolve your control-plane principal + every org membership (role + status). The remote identity; for local wallet/profile state use `status`.
- **`list_orgs`** / **`list_org_members`** - read your orgs, and an org's members + roles.
- **`add_org_member`** - add a member BY WALLET (a new wallet is provisioned as a `human` principal); role defaults to `developer`. Owner-gated. Email-first invite is a separate, not-yet-shipped flow.
- **`set_org_member_role`** / **`remove_org_member`** - owner-gated. Removing or demoting the org's only active owner fails with `409 LAST_OWNER` - promote another member to `owner` first.
- **`create_project_grant`** / **`revoke_project_grant`** - per-project capability grants (e.g. `deploy`, `functions:write`) for agent/CI principals that aren't broad org members. Requires owner of the project's org.

## Standard Workflow

```
1. init                                                    → allowance + faucet
2. set_tier(tier: "prototype")                             → free on testnet
3. provision_postgres_project(name: "my-app")              → keys + project_id
4. run_sql(project_id, sql: "CREATE TABLE …")              → schema
5. validate_manifest(manifest, project_id, migration_sql?) → check reachability manifest
6. apply_expose(project_id, manifest: {…})                 → declare reachability
7. deploy_site_dir(project, dir: "./dist")                 → live URL
8. claim_subdomain(project_id, name: "my-app")             → my-app.run402.com
   (optional) deploy_function(project_id, name, code, …)
   (optional) assets_put(project_id, key, content/local_path) for assets
```

Provision before authoring HTML — the `anon_key` is permanent and you embed it in your frontend.

## Payment Handling

Two payment rails work with the same wallet key:

- **x402** (default): USDC on Base. Prototype uses Base Sepolia testnet (free from faucet); hobby/team use Base mainnet.
- **MPP**: pathUSD on Tempo Moderato (testnet) / Tempo (mainnet). Same wallet key, different chain.

The MCP server handles all signing automatically. When a paid tool returns 402, the response includes payment details as **informational text** (not an error) — guide the user through funding, then retry the same tool call. **`provision_postgres_project`**, **`set_tier`**, **`deploy`**, and **`generate_image`** are the paid surfaces; everything else is free with an active tier.

For real-money tiers, two paths to fund:

- **Path A — fund the agent allowance**: human sends USDC on Base mainnet to the address from **`allowance_export`**. Agent pays autonomously via x402.
- **Path B — Stripe credits**: create or pick the organization, then **`create_checkout`** with `product: "tier"` returns a Stripe URL the human pays once.

Suggest $10 to your human for two Hobby projects, or $20 for one Team plus renewal buffer.

## Tips & Guardrails

- **Provision before authoring HTML.** The `anon_key` is permanent; write your frontend HTML *after* `provision_postgres_project` returns it.
- **Use the manifest for access control**, never raw `GRANT`/`REVOKE` (the SQL endpoint blocks those).
- **`user_owns_rows` is the default for user-scoped data.** Reach for `public_read_write_UNRESTRICTED` only on intentionally-public tables (and pass `i_understand_this_is_unrestricted: true`).
- **Make migrations idempotent** with `CREATE TABLE IF NOT EXISTS` and `DO`-block `ALTER TABLE`.
- **Use the immutable `cdn_url` from `assets_put` directly.** It's correct from the moment of upload — no `wait_for_cdn_freshness` needed for fresh uploads.
- **Don't bake unconditional `request_faucet` calls into deploy scripts** — the faucet rate-limits and breaks already-funded flows.
- **Per-project rate limit is 100 req/sec.** On 429, back off using `retry_after`.
- **`service_status` works without auth.** Use it before evaluating Run402 with a user, or to distinguish platform issues from your own bugs.

## Agent Allowance Setup

The MCP server manages a local agent allowance — a wallet key dedicated to paying Run402, stored at `~/.config/run402/allowance.json` (mode `0600`). You never touch the private key directly.

- **`init`** — composes `allowance_create` + `request_faucet` + `tier_status` + `list_projects`. Use this on a fresh install.
- **`allowance_create`** / **`allowance_status`** / **`allowance_export`** — granular allowance ops.
- **`request_faucet`** — Base Sepolia testnet USDC.
- **`check_balance`** — run402 organization balance (available + held) for the agent's wallet; resolves the wallet to its organization over SIWX.

Other allowance options:
- **Coinbase AgentKit** — MPC wallet on Base with built-in x402.
- **AgentPayy** — auto-bootstraps an MPC wallet on Base via Coinbase CDP.

## Troubleshooting

| You see | Likely cause / fix |
|---|---|
| `402 payment_required` on `set_tier` | Allowance is empty. Call `request_faucet` (testnet) or fund with real USDC. |
| `402` with `lifecycle_state: frozen` | Project past lease + 14 days. `set_tier` reactivates instantly. |
| `403 admin_required` | Tool is platform-admin only (e.g., `admin_set_lease_perpetual`, `admin_archive_project`, `admin_reactivate_project`). Use a platform admin allowance wallet; project owners can't toggle these on their own. |
| `403 NOT_AUTHORIZED` on a control-plane action | Org-owned control plane (v1.77+): the wallet authenticated, but its principal lacks the org role/grant for this action — not a payment or lease issue. `details` carries `required_role` / `required_capability` / `reason`. Obtain a covering org membership/role or grant; high-stakes ops (delete, transfer, membership change) need an active `owner` membership. Returned as 403 even when the project doesn't exist, so also re-check the project id. |
| `409 LAST_OWNER` on `remove_org_member` / `set_org_member_role` | An org must keep at least one active `owner`. The change would remove or demote the last one. Promote another member to `owner` first (`set_org_member_role`), then retry. |
| Empty `[]` from `rest_query` for anon | Table not in manifest with `expose: true`. Call `apply_expose`. |
| `403 forbidden_function` calling an RPC | Function not in the manifest's `rpcs[]`. Add `{ name, signature, grant_to: ["authenticated"] }` and re-apply. |
| `409 reserved` from `claim_subdomain` | Original owner's grace period — subdomain held until +118 days from lease expiry. |
| `429 rate_limited` | 100 req/sec project cap. Back off using `retry_after`. |
| CDN serves old bytes | Use the immutable `cdn_url` from `assets_put`, or call `wait_for_cdn_freshness` on a mutable URL. |
| `422 relation already exists` on redeploy | Wrap migrations in `CREATE TABLE IF NOT EXISTS` + `DO`-block `ALTER TABLE`. |
| `insufficient_funds` right after faucet | Wait for the faucet tx to confirm (~5s on Base Sepolia) before subscribing. |

## Tools Reference

This skill is `run402-mcp` — every action above is an MCP tool. Full parameter schemas live in each tool's MCP description; the skill body teaches you when to reach for which.

For the corresponding HTTP API reference, see <https://run402.com/llms.txt>. For the CLI shape (terminal / shell / CI use cases), see <https://docs.run402.com/llms-cli.txt>.

## Links

- HTTP API reference: <https://run402.com/llms.txt>
- CLI reference: <https://docs.run402.com/llms-cli.txt>
- Status: <https://api.run402.com/status>
- Health: <https://api.run402.com/health>
- npm: [`run402-mcp`](https://www.npmjs.com/package/run402-mcp) · [`run402`](https://www.npmjs.com/package/run402) · [`@run402/sdk`](https://www.npmjs.com/package/@run402/sdk) · [`@run402/functions`](https://www.npmjs.com/package/@run402/functions)
- Homepage: <https://run402.com>
