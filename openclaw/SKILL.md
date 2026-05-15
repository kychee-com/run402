---
name: run402
description: Provision Postgres + REST API + auth + content-addressed storage + serverless functions + email — paid with x402 USDC on Base. Prototype tier is free on testnet.
metadata:
  openclaw:
    emoji: "🐘"
    homepage: https://run402.com
    requires:
      bins:
        - npx
    install:
      - kind: node
        package: "run402"
        bins: [run402]
    primaryEnv: RUN402_API_BASE
---

# Run402 — Postgres, storage & deploys for AI agents

Run402 gives an agent a real Postgres database with REST API and user auth, content-addressed CDN storage, static site hosting, Node 22 serverless functions, email, image generation, and KMS-backed on-chain signing. One command provisions; payment happens automatically with x402 USDC on Base. **Prototype tier is free on testnet** — no real money, no human signup.

Every example below is a CLI command. The CLI prints JSON to stdout, JSON errors to stderr, and exits 0 on success / 1 on failure — designed for shells, scripts, and agent loops.

## 30-second start

```bash
run402 init                                # one-shot: allowance + faucet + tier check
run402 tier set prototype                  # FREE on testnet (verifies x402 setup)
run402 projects provision --name my-app    # → anon_key, service_key, project_id
run402 sites deploy-dir ./dist             # incremental upload of a directory
run402 subdomains claim my-app             # → https://my-app.run402.com
```

That's a real Postgres database + a deployed static site, paid for autonomously with testnet USDC.

## How to think about it

| You want to… | Reach for… |
|---|---|
| Set up a wallet from scratch | `run402 init` |
| Make a database | `run402 projects provision` |
| Run SQL on it | `run402 projects sql` |
| Check an auth manifest before applying | `run402 projects validate-expose` |
| Make a table reachable from the browser | `run402 projects apply-expose` |
| Deploy a frontend from a directory | `run402 sites deploy-dir <path>` |
| Link GitHub Actions deploys | `run402 ci link github` |
| Stash a file with a paste-able CDN URL | `run402 blob put <file>` |
| Run code on the server | `run402 functions deploy` |
| Send email | `run402 email send` |
| Sign on-chain | `run402 contracts call` |
| One-call full-stack deploy | `run402 deploy apply --manifest app.json` |

The active project is sticky — `run402 projects use <id>` makes it the default for every subsequent `<id>`-taking command. Most commands work without an explicit `<id>` once a project is active.

## Project credentials

After `provision`, two keys land in `~/.config/run402/projects.json`:

- **`anon_key`** — for the browser. Read-only by default; safe to embed in HTML. RLS still applies.
- **`service_key`** — server-side admin. **Never embed in browser code.** CORS is intentionally open for x402 clients, so a leaked service_key is exploitable from any origin. Use only inside functions or when running CLI as the agent.

Neither expires. Lease enforcement happens server-side.

```bash
run402 projects keys <id>     # print the project's anon_key + service_key as JSON
run402 projects info <id>     # tier, lease, schema slot, host, …
```

## Error Envelopes and Safe Retry

Run402-originated JSON errors may include canonical fields. Branch on stable `code`, not English `message` or legacy `error` text.

Fields to use:
- `code`: machine-readable reason, e.g. `PROJECT_FROZEN`, `PAYMENT_REQUIRED`, `MIGRATION_FAILED`, `MIGRATE_GATE_ACTIVE`
- `retryable`: the same request may succeed later
- `safe_to_retry`: repeating the same request should not duplicate or corrupt a mutation
- `mutation_state`: one of `none`, `not_started`, `committed`, `rolled_back`, `partial`, `unknown`
- `trace_id`: include when reporting an issue
- `request_id`: routed/function failure handle; use `run402 functions logs <id> <name> --request-id <req_...>` for diagnostics. Distinct from gateway `trace_id`.
- `details`: structured route-specific context
- `next_actions`: advisory actions such as `authenticate`, `submit_payment`, `renew_tier`, `check_usage`, `retry`, `resume_deploy`, `edit_request`, `edit_migration`; never treat them as blindly executable

Retry policy:
- Retry directly only when `retryable: true` and `safe_to_retry: true`; reuse the same idempotency key for mutating operations.
- `safe_to_retry: true` alone is not a retry signal; it means duplicate-safe, not likely-to-succeed. Lifecycle-gated writes, auth token exchanges, and passkey verifies need the indicated action before retrying.
- `run402 deploy apply` already handles safe `BASE_RELEASE_CONFLICT` release races for omitted/current-base specs by re-planning through the SDK. A handled retry appears as a `deploy.retry` stderr event; exhausted retries include `attempts`, `max_retries`, and `last_retry_code`. Do not hand-roll this specific deploy race loop.
- For mutating 5xx errors with `safe_to_retry: false`, or `mutation_state: "committed"`, `"partial"`, or `"unknown"`, inspect/poll/reconcile state before retrying. For deploys, inspect events or resume the existing operation instead of starting a duplicate deploy.
- Lifecycle/payment codes usually require an action: `PROJECT_FROZEN`/`PROJECT_DORMANT`/`PROJECT_PAST_DUE` -> check usage or renew tier; `PAYMENT_REQUIRED`/`INSUFFICIENT_FUNDS` -> submit/fund payment.

Examples:
```json
{ "message": "Project is frozen.", "code": "PROJECT_FROZEN", "category": "lifecycle", "retryable": false, "safe_to_retry": true, "mutation_state": "none", "next_actions": [{ "action": "renew_tier" }, { "action": "check_usage" }] }
```

```json
{ "message": "Payment required.", "code": "PAYMENT_REQUIRED", "category": "payment", "retryable": true, "safe_to_retry": true, "next_actions": [{ "action": "submit_payment" }] }
```

```json
{ "message": "Migration failed.", "code": "MIGRATION_FAILED", "category": "deploy", "retryable": false, "safe_to_retry": true, "mutation_state": "rolled_back", "trace_id": "trc_...", "details": { "operation_id": "op_...", "phase": "migrate" }, "next_actions": [{ "action": "edit_migration" }] }
```

## Deploying

### `deploy-dir` — the modern path

`deploy-dir` walks a local directory, hashes each file client-side, and only PUTs bytes the gateway doesn't already have. Re-deploying an unchanged tree returns immediately with `bytes_uploaded: 0`.

```bash
run402 sites deploy-dir ./dist > result.json 2> events.log
```

Skips `.git/`, `node_modules/`, `.DS_Store` automatically. Symlinks throw (no cycles).

`stderr` streams progress events — one JSON object per line:

| phase | When fired | Extra fields |
|-------|------------|--------------|
| `plan`   | After the planning request | `manifest_size` (file count) |
| `upload` | After each missing file finishes PUTing | `file`, `sha256`, `done`, `total` |
| `commit` | Just before commit | — |
| `poll`   | Per server-side copy poll | `status`, `elapsed_ms` |

Pass `--quiet` to suppress events; the final result envelope still goes to stdout.

### `deploy` — one-call full stack

For a database + migrations + manifest + secret dependencies + functions + site + subdomain, set secret values first, then deploy a value-free manifest:

```bash
run402 secrets set <project_id> OPENAI_API_KEY --file ./.secrets/openai-key
run402 deploy apply --manifest app.json
```

After deploys, inspect release state without starting another mutation:

```bash
run402 deploy release active --project prj_...
run402 deploy release get rel_... --project prj_...
run402 deploy release diff --from empty --to active --project prj_...
```

Inventories expose site paths, `static_public_paths` when returned, functions, secret keys only, subdomains, materialized routes, applied migrations, `release_generation`, `static_manifest_sha256`, nullable `static_manifest_metadata`, and warnings when returned. `site.paths` is the release static asset inventory; `static_public_paths[]` is the browser reachability inventory with `public_path`, `asset_path`, `reachability_authority`, `direct`, cache class, and content type. `static_manifest_metadata: null` means unavailable, not zero. Release diffs use `migrations.applied_between_releases`, route `added` / `removed` / `changed` buckets, and `static_assets` counters for unchanged/changed/added/removed files, CAS byte reuse, eliminated deployment-copy bytes, and immutable/CAS warning counts.

#### Same-origin web routes

Use `run402 deploy apply` for `site.public_paths` clean static browser URLs and public browser routes to functions or exact method-aware static aliases. Release static asset paths and public browser paths are distinct: `events.html` can be a private release asset while `/events` is the public static URL.

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

Use `run402 deploy diagnose --project prj_123 https://example.com/events --method GET` before mutating deploy state when the question is "what would this public URL serve?" For lower-level parity use `run402 deploy resolve --project prj_123 --url https://example.com/events?utm=x#hero --method GET` or `run402 deploy resolve --project prj_123 --host example.com --path /events --method GET`; never combine `--url` with `--host`/`--path`. Output is JSON with `status`, `would_serve`, `diagnostic_status`, `match`, normalized `request`, warnings, full `resolution`, and structured `next_steps`. URL query strings/fragments are disclosed in `request.ignored`. When returned, `asset_path`, `reachability_authority`, and `direct` explain which release asset backs the public URL and whether reachability came from implicit file-path mode, explicit `site.public_paths`, or a route-only static alias. Stable-host diagnostics may also include `authorization_result`, `cas_object` (`sha256`, `exists`, `expected_size`, `actual_size`), hostname-specific `response_variant`, and route/static fields such as `allow`, `route_pattern`, `target_type`, `target_name`, and `target_file`. Known `match` literals are `host_missing`, `manifest_missing`, `active_release_missing`, `unsupported_manifest_version`, `path_error`, `none`, `static_exact`, `static_index`, `spa_fallback`, `spa_fallback_missing`, `route_function`, `route_static_alias`, and `route_method_miss`; preserve unknown future strings. Known `authorization_result` values include `authorized`, `not_public`, `not_applicable`, `manifest_missing`, `target_missing`, `active_release_missing`, `unsupported_manifest_version`, `path_error`, `missing_cas_object`, `unfinalized_or_deleting_cas_object`, `size_mismatch`, and `unauthorized_cas_object`. Known `fallback_state` values include `active_release_missing`, `unsupported_manifest_version`, and `negative_cache_hit`; preserve unknown future strings. `result` is diagnostic body status, not CLI process status, so host misses can exit 0 with `would_serve: false`. Do not use diagnostics as a fetch, cache purge, or reason to hard-code `cache_policy` strings; branch on structured JSON such as `allow` and `cas_object`.

Known route warning recovery: `PUBLIC_ROUTED_FUNCTION` means review app auth, CSRF, CORS/`OPTIONS`, and cookies before retrying with `--allow-warnings`. `ROUTE_SHADOWS_STATIC_PATH` and `WILDCARD_ROUTE_SHADOWS_STATIC_PATHS` mean inspect affected paths, active routes, `static_public_paths`, and resolve diagnostics before confirming. `STATIC_ALIAS_SHADOWS_STATIC_PATH`, `STATIC_ALIAS_RELATIVE_ASSET_RISK`, `STATIC_ALIAS_DUPLICATE_CANONICAL_URL`, `STATIC_ALIAS_EXTENSIONLESS_NON_HTML`, and `STATIC_ALIAS_TABLE_NEAR_LIMIT` are route-only static alias warnings; prefer `site.public_paths` for ordinary clean URLs, inspect the backing `asset_path`, fix relative assets/canonical URLs, and avoid table-exhausting page-by-page routes. `ROUTE_TARGET_CARRIED_FORWARD` means inspect carried-forward function targets. `METHOD_SPECIFIC_ROUTE_ALLOWS_GET_STATIC_FALLBACK` means confirm static fallback is intended. `WILDCARD_ROUTE_EXCLUDES_MUTATION_METHODS` means a wildcard API prefix only allows `GET`/`HEAD`; add mutation methods such as `POST` or confirm it is read-only. `ROUTE_TABLE_NEAR_LIMIT` means consolidate routes. `ROUTES_NOT_ENABLED` means deploy without `routes` or request enablement. Runtime route failure codes to branch on: `ROUTE_MANIFEST_LOAD_FAILED` (manifest/propagation), `ROUTED_INVOKE_WORKER_SECRET_MISSING` (custom-domain Worker secret), `ROUTED_INVOKE_AUTH_FAILED` (internal invoke signature), `ROUTED_ROUTE_STALE` (selected route failed release revalidation), `ROUTE_METHOD_NOT_ALLOWED` (method mismatch), and `ROUTED_RESPONSE_TOO_LARGE` (body over 6 MiB).

The deploy manifest is a v2 `ReleaseSpec`; put the auth manifest under `database.expose`:

```json
{
  "project_id": "prj_…",
  "database": {
    "migrations": [{ "id": "001_init", "sql_path": "setup.sql" }],
    "expose": {
      "$schema": "https://run402.com/schemas/manifest.v1.json",
      "version": "1",
      "tables": [
        { "name": "items", "expose": true, "policy": "user_owns_rows",
          "owner_column": "user_id", "force_owner_on_insert": true }
      ]
    }
  },
  "secrets": { "require": ["OPENAI_API_KEY"] },
  "functions": {
    "replace": {
      "my-fn": {
        "runtime": "node22",
        "source": { "data": "export default async (req) => new Response('ok')" },
        "config": { "timeoutSeconds": 30, "memoryMb": 256 }
      }
    }
  },
  "site": {
    "replace": {
      "index.html": { "data": "<!doctype html>…" },
      "logo.png": { "data": "iVBORw0…", "encoding": "base64" }
    }
  },
  "subdomains": { "set": ["my-app"] }
}
```

The `database.expose` entry is **auth-as-SDLC** — your authorization travels with the release. The gateway validates it against the migration SQL and applies it atomically. If the manifest references a table the migration doesn't create, the deploy is rejected with HTTP 400 and a structured `errors` array listing every violation.

Provision first (`run402 projects provision`) so you have the `anon_key` to embed in your HTML before deploying.

### GitHub Actions OIDC deploys

Link once locally, then let GitHub Actions run the same deploy command agents already use:

```bash
run402 ci link github --project prj_... --manifest run402.deploy.json
# Optional route authority for CI route declarations:
run402 ci link github --project prj_... --manifest run402.deploy.json --route-scope /admin --route-scope /api/*
git add .github/workflows/run402-deploy.yml run402.deploy.json
git commit -m "Add run402 deploy workflow"
```

The generated workflow uses a pinned `run402@<current>` CLI via `npx`, includes `permissions: id-token: write` and `contents: read`, and runs:

```bash
run402 deploy apply --manifest run402.deploy.json --project prj_...
```

Useful follow-ups:

```bash
run402 ci list --project prj_...
run402 ci revoke cib_...
```

V1 intentionally keeps the shape narrow: `push` and `workflow_dispatch` only, no PR deploy flags, no raw subject or wildcard flags, and no soft repository-id binding. Without `--route-scope`, CI cannot deploy `routes`; with repeatable route scopes, it may deploy only matching exact paths such as `/admin` or final-wildcard prefixes such as `/api/*`. If CI returns `CI_ROUTE_SCOPE_DENIED`, re-link with covering scopes or run the route-changing deploy locally. Revocation stops future CI gateway requests but does not undo already-deployed code, stop in-flight deploy operations, rotate exfiltrated keys, or remove deployed functions.

## Authorization — the expose manifest

**Tables you create are dark by default.** Until your manifest declares a table with `expose: true`, it's invisible to anon and authenticated callers. This eliminates the "agent forgot RLS, data leaked" footgun. The manifest is the single source of truth for what's reachable via `/rest/v1/*`.

JSON Schema: <https://run402.com/schemas/manifest.v1.json>. Set `$schema` on your manifest file and your editor gets autocomplete for free.

### Preferred: ship `manifest.json` in your bundle

Authorization travels with your code. Put a file named `manifest.json` in the bundle's `files[]` and the gateway reads it, validates it against your migration SQL, applies it, and **strips it from `files[]` before the site deploys** — so it's never publicly reachable on your subdomain. The deploy response includes `manifest_applied: true` on success.

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

If the manifest references a table the migration doesn't create, the deploy is rejected with HTTP 400 and a structured `errors` array listing **every** violation (not just the first).

### Non-mutating validation: `validate-expose`

Before applying, run:

```bash
run402 projects validate-expose [id] --file manifest.json --migration-file migrations.sql
```

This validates the auth/expose manifest used by `manifest.json`, `database.expose`, and `apply-expose`; it is not deploy-manifest validation. Migration SQL is used only for reference checks and is not executed as a PostgreSQL dry run. The command prints `{ "status": "ok", "hasErrors": boolean, "errors": [...], "warnings": [...] }` and exits successfully even when `hasErrors` is true.

### Imperative escape hatch: `apply-expose`

For ad-hoc changes outside a deploy — same JSON shape, no bundle:

```bash
run402 projects apply-expose <id> --file manifest.json
run402 projects get-expose   <id>     # source: "applied" | "introspected"
```

`get-expose` returns the live state. `source: "applied"` means it came from a prior `apply-expose` (or a bundled `manifest.json`); `"introspected"` means no manifest has ever been applied and the response was reconstructed from live DB state.

**Convergent**: applying the same manifest twice is a no-op. Items removed between applies have their policies, grants, triggers, and views dropped. Always include everything you want exposed.

### Built-in policies

| Policy | Allows |
|---|---|
| `user_owns_rows` | Rows where `owner_column = auth.uid()`. With `force_owner_on_insert: true`, a BEFORE INSERT trigger sets it automatically. **Default for anything user-scoped.** |
| `public_read_authenticated_write` | Anyone reads. Any authenticated user writes any row. For shared boards / collaborative content. |
| `public_read_write_UNRESTRICTED` | Fully open. Requires `i_understand_this_is_unrestricted: true` on the table entry. Only for guestbooks / waitlists / feedback forms. |
| `custom` | Escape hatch. Provide `custom_sql` with `CREATE POLICY` statements. |

Views always run with `security_invoker=true` — they inherit the underlying table's RLS, so they can't accidentally leak hidden columns. RPCs are not exposed unless listed in `rpcs[]` (a database event trigger revokes PUBLIC EXECUTE on every newly-created function).

## Storage — paste-and-go assets

`run402 blob put` returns an `AssetRef`. The URL is content-addressed (`pr-<public_id>.run402.com/_blob/<key>-<8hex>.<ext>`), served through CloudFront, and never needs cache invalidation:

```bash
run402 blob put ./logo.png    --json
run402 blob put ./app.js      --json
run402 blob put ./styles.css  --json
run402 blob put ./asset       --key assets/logo --content-type image/svg+xml --json
```

Each response includes:

| Field | Use |
|---|---|
| `cdn_url` | The content-addressed URL — paste straight into `src=` / `href=` |
| `sri` | `sha256-<base64>` for `<script integrity="…">` if you build tags by hand |
| `etag` | Strong `"sha256-<hex>"` ETag |
| `cache_kind` | `immutable` / `mutable` / `private` |

Immutable upload is the default since v1.45 — the SDK computes the SHA-256 client-side and pairs the URL with SRI. The browser refuses execution on byte mismatch. No invalidation choreography.

`blob put` infers MIME type from the destination key. Use `--content-type <mime>` for extensionless assets, unusual file types, or deliberate overrides.

### List, fetch, remove, sign

```bash
run402 blob ls --prefix images/
run402 blob get images/logo.png --output /tmp/logo.png
run402 blob rm images/old.png
run402 blob sign secrets/report.pdf --ttl 3600    # presigned URL for private blobs
```

### Diagnose a stale CDN

```bash
run402 blob diagnose <url>                                  # exit 0 if fresh, 1 if stale
run402 cdn wait-fresh <url> --sha <hex> --timeout 120       # poll until fresh
```

`diagnose` is shell-loop friendly: `until run402 blob diagnose <url>; do sleep 1; done` blocks until the CDN catches up. Vantage is single-region (us-east-1) — other PoPs may differ. **Don't call `wait-fresh` on immutable URLs** — they're correct from the moment of upload.

## Database

```bash
run402 projects sql <id> "CREATE TABLE items (id serial PRIMARY KEY, title text NOT NULL, user_id uuid)"
run402 projects sql <id> --file migrations.sql
run402 projects sql <id> "SELECT * FROM items WHERE id = \$1" --params '[42]'

run402 projects rest <id> items "select=id,title&order=id.desc&limit=10"
run402 projects validate-expose <id> --file manifest.json --migration-file migrations.sql
run402 projects schema <id>          # introspect tables, columns, RLS
run402 projects usage  <id>          # API calls, storage, lease expiry
run402 projects costs <id> --window 30d  # operator-only finance; admin wallet required
```

### Idempotent migrations

`CREATE TABLE IF NOT EXISTS` only handles "already exists" errors — it won't add new columns to an existing table. For evolving schemas, wrap `ALTER TABLE` in a `DO` block:

```sql
CREATE TABLE IF NOT EXISTS items (id serial PRIMARY KEY, title text NOT NULL);
DO $$ BEGIN
  ALTER TABLE items ADD COLUMN priority int DEFAULT 0;
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;
```

This pattern is safe to re-run on every deploy.

### SQL guardrails

The SQL endpoint blocks: `CREATE EXTENSION`, `COPY ... PROGRAM`, `ALTER SYSTEM`, `SET search_path`, `CREATE/DROP SCHEMA`, `GRANT/REVOKE`, `CREATE/DROP ROLE`. Table and sequence permissions are granted automatically — use the expose manifest for access control instead of `GRANT`.

## Functions

Node 22 runtime. Handler: `export default async (req: Request) => Response`.

```bash
run402 functions deploy <id> my-fn --file fn.ts \
  --timeout 30 --memory 256 \
  --schedule "*/15 * * * *" \
  --deps "stripe,zod@^3,date-fns@3.6.0"

run402 functions invoke <id> my-fn --body '{"hello":"world"}'
run402 functions logs   <id> my-fn --tail 100 --request-id req_abc123 --follow
run402 functions update <id> my-fn --schedule "0 */6 * * *"
run402 functions list   <id>
run402 functions delete <id> my-fn
```

`--deps` accepts npm specs: bare names (`lodash`) resolve to the latest version at deploy time, pinned (`lodash@4.17.21`) and ranges (`date-fns@^3.0.0`) are honored verbatim. Max 30 entries, 200 chars each. **Native binary modules (`sharp`, `canvas`, native bcrypt, etc.) are rejected** — pure JS only. Don't list `@run402/functions` (auto-bundled).

The deploy response surfaces:
- `runtime_version` — the bundled `@run402/functions` version
- `deps_resolved` — `{ name: version }` for every package the gateway pinned, including transitives
- `warnings` — non-fatal notes (e.g. when a bare spec resolved to a version that's later than what's typical)

### Inside the function — `@run402/functions`

The one place to write code, not commands. Built-in helpers are auto-bundled:

```ts
import { db, adminDb, getUser, email, ai } from "@run402/functions";

export default async (req: Request) => {
  const user = await getUser(req);
  if (!user) return new Response("unauthorized", { status: 401 });

  // Caller-context — Authorization header is forwarded; RLS evaluates against the caller's role.
  const mine = await db(req).from("items").select("*").eq("user_id", user.id);

  // Bypass RLS — only when the function acts on behalf of the platform.
  await adminDb().from("audit").insert({ event: "items_read", user_id: user.id });

  if (mine.length === 0) {
    await email.send({ to: user.email, subject: "Welcome", html: "<h1>Hi</h1>" });
  }

  return Response.json(mine);
};
```

- **`db(req)`** — caller-context. Forwards Authorization header. RLS applies. Default choice.
- **`adminDb()`** — bypass RLS. Use only for audit logs, cron cleanup, webhook handlers, platform-authored writes.
- **`adminDb().sql(query, params?)`** — raw parameterized SQL. Always bypass.

Fluent surface on both `db(req).from(t)` and `adminDb().from(t)`:
- Reads: `.select()`, `.eq()`, `.neq()`, `.gt()`, `.lt()`, `.gte()`, `.lte()`, `.like()`, `.ilike()`, `.in()`, `.order()`, `.limit()`, `.offset()`
- Writes: `.insert(obj | obj[])`, `.update(obj)`, `.delete()` — return arrays of affected rows
- Column narrowing on writes: `.insert({…}).select("id, title")`

For TypeScript autocomplete in your editor: `npm install @run402/functions` in your project. Also works at build time for static-site generation if you set `RUN402_SERVICE_KEY` + `RUN402_PROJECT_ID` in `.env`.

### Calling a function from the browser

Agent-side calls should use `run402 functions invoke`; this direct `fetch()`
shape is only for app/browser code that needs to call the deployed function
from the user's session.

```js
const res = await fetch("https://api.run402.com/functions/v1/my-fn", {
  method: "POST",
  headers: {
    apikey: ANON_KEY,
    Authorization: "Bearer " + session.access_token,   // optional, for authenticated calls
    "Content-Type": "application/json",
  },
  body: JSON.stringify({ hello: "world" }),
});
```

### Scheduled functions

Pass a 5-field cron expression. To remove a schedule: `--schedule-remove`. Tier limits:

| Tier | Max scheduled | Min interval |
|------|---------------|--------------|
| Prototype | 1 | 15 min |
| Hobby | 3 | 5 min |
| Team | 10 | 1 min |

## Secrets

Injected as `process.env.<KEY>` inside every function. Values are write-only — `list` returns keys and timestamps only, never values or value-derived hashes. Deploy manifests use `secrets.require[]` to assert keys exist; they never carry secret values.

```bash
run402 secrets set    <id> STRIPE_KEY --file ./.secrets/stripe-key
run402 secrets set    <id> JWT_PRIVATE --file ./private.pem
run402 secrets list   <id>
run402 secrets delete <id> STALE_KEY
```

## Email

One mailbox per project at `<slug>@mail.run402.com`. Optionally bring your own domain.

```bash
run402 email create my-app                          # idempotent
run402 email send --to user@example.com \
  --template notification \
  --var project_name="My App" --var message="Hello"

run402 email send --to user@example.com \
  --subject "Welcome" --html '<h1>Hi</h1>' --from-name "My App"

run402 email list
run402 email get <message_id>
run402 email get-raw <message_id> --output msg.eml   # raw RFC-822 for DKIM / zk-email
```

Templates: `project_invite` (`project_name`, `invite_url`), `magic_link` (`project_name`, `link_url`, `expires_in`), `notification` (`project_name`, `message` ≤ 500 chars).

Tier rate limits: prototype 10/day, hobby 50/day, team 500/day. Unique recipients per lease: 25 / 200 / 1000.

### Webhooks

```bash
run402 email webhooks register --url https://… --events delivery,bounced,reply_received
run402 email webhooks list
run402 email webhooks update <id> --events delivery,bounced,complained,reply_received
run402 email webhooks delete <id>
```

### Custom sender domain

```bash
run402 sender-domain register example.com         # → DKIM CNAMEs to add to DNS
run402 sender-domain status                       # poll until verified
run402 sender-domain inbound-enable example.com   # → MX record (opt-in)
```

## User auth

Auth supports passwords, magic links, Google OAuth, and WebAuthn passkeys. Google is on for all projects with **zero config**; passkeys require an exact allowed `app_origin` (claimed subdomain, project public-id host, active custom domain, or localhost when allowed).

```bash
run402 auth magic-link --email user@example.com --redirect https://my-app.run402.com/cb
run402 auth verify --token <token>                       # → access_token + refresh_token
run402 auth invite-user --email admin@example.com --redirect https://my-app.run402.com/cb --admin true
run402 auth set-password --token <bearer> --new <pwd>    # change | reset | set
run402 auth passkey-login-options --app-origin https://my-app.run402.com
run402 auth passkey-login-verify --challenge <id> --response '<json>'
run402 auth providers
```

Magic-link tokens are single-use, expire in 15 min, and are rate-limited. The `access_token` works as `apikey` for user-scoped REST calls subject to RLS. Use `run402 auth settings --preferred passkey --require-admin-passkey true` to require eligible passkey auth for `project_admin` sessions.

For browser-side flows (PKCE, Google OAuth, refresh-token rotation), see <https://run402.com/llms-cli.txt>.

## Subdomains and custom domains

```bash
run402 subdomains claim my-app                    # → https://my-app.run402.com
run402 subdomains list
run402 subdomains delete my-app --confirm

run402 domains add example.com my-app             # → DNS records to set
run402 domains status example.com                 # poll until active
run402 domains list
run402 domains delete example.com --confirm
```

**Subdomain auto-reassignment**: claim once. Every subsequent `run402 sites deploy-dir` to the same project automatically points the subdomain at the new deployment. The deploy response includes `subdomain_urls` showing what got reassigned. No re-claim needed.

## On-chain — KMS contract wallets

For agents that need to sign Ethereum transactions. Private keys never leave AWS KMS — there is no export, ever. **$0.04/day rental + $0.000005/call.** Wallet creation requires $1.20 in cash credit (30 days prepaid). **Non-custodial** — see <https://run402.com/humans/terms.html#non-custodial-kms-wallets>.

```bash
run402 contracts provision-wallet --chain base-mainnet [--recovery-address 0x…]
run402 contracts list-wallets
run402 contracts get-wallet <wallet_id>          # metadata + live balance + USD value

run402 contracts call --wallet <id> --to 0x… \
  --abi @abi.json --fn transfer --args '["0x…", "1000000"]' \
  [--value-wei 0] [--idempotency-key <k>]

run402 contracts read --chain base-mainnet \
  --to 0x… --abi @abi.json --fn balanceOf --args '["0x…"]'

run402 contracts status <call_id>
run402 contracts drain  <wallet_id> --to 0x… --confirm     # safety valve (works on suspended)
run402 contracts delete <wallet_id> --confirm              # 7-day KMS deletion window
```

## Tier and billing

```bash
run402 tier set prototype     # FREE on testnet (verifies x402 setup)
run402 tier set hobby         # $5 / 30 days
run402 tier set team          # $20 / 30 days
run402 tier status

# Pay with Stripe instead of x402
run402 billing create-email user@example.com
run402 billing tier-checkout hobby --email user@example.com
run402 billing buy-email-pack       --email user@example.com   # $5 / 10k emails (never expire)
run402 billing auto-recharge <account_id> on --threshold 2000
run402 billing balance <email-or-wallet>
run402 billing history <email-or-wallet>
```

After subscribing you can create unlimited projects, deploy unlimited sites, fork apps — all free with your active tier. Only image generation ($0.03/image) is per-call.

The server auto-detects the action: no tier or expired → subscribe; same tier active → renew; higher tier → upgrade (prorated refund); lower tier → downgrade (prorated refund if usage fits).

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

Project-level rate limit: **100 req/sec**. Exceeding returns 429 with `retry_after`. Each project has its own Postgres schema; cross-schema access is blocked.

## Project lifecycle (~104-day soft delete)

After lease expires, projects go through a state machine. The live data plane keeps serving the whole time — only the owner's control plane gets gated:

| State | When | What happens |
|-------|------|--------------|
| `active` | — | Full read/write |
| `past_due` | day 0 | Site, REST, email keep serving. Owner gets first email. |
| `frozen` | +14d | Control plane (deploys, secrets, subdomain claims, function upload) returns 402 with `lifecycle_state` / `entered_state_at` / `next_transition_at`. Site still serves. Subdomain reserved so the brand can't be claimed by another wallet. |
| `dormant` | +44d | Scheduled (cron) functions pause. |
| `purged` | +104d | Cascade: schema dropped, Lambdas deleted, mailbox tombstoned. Subdomain becomes claimable 14 days later. |

`run402 tier set …` at any point during grace reactivates the project and clears all timers in one transaction. Pinned projects bypass the state machine entirely.

## Image generation

```bash
run402 image generate "a serif logo for a coffee shop" --aspect square --output logo.png
```

$0.03 per image. Aspects: `square`, `landscape`, `portrait`. Without `--output`, returns base64 in JSON.

## AI helpers

```bash
run402 ai translate <id> "Hello world" --to es --context "marketing tagline"
run402 ai moderate  <id> "<text>"
run402 ai usage     <id>
```

Translation requires the AI Translation add-on on the project. Moderation is free.

## Apps marketplace

```bash
run402 apps browse [--tag <tag>]
run402 apps inspect <version_id>
run402 apps fork    <version_id> my-clone --bootstrap '{"admin_email":"me@example.com"}'
run402 apps publish <id> --description "…" --tags todo,demo --visibility public --fork-allowed
run402 apps versions <id>
run402 apps update   <id> <version_id> --description "…" --tags a,b
run402 apps delete   <id> <version_id>
```

Forking clones schema + site + functions into a new project. If the source app has a `bootstrap` function, it runs automatically with the variables you pass via `--bootstrap`. The fork response includes `bootstrap_result` (the function's return value) or `bootstrap_error`. Use `apps inspect` to see what `bootstrap_variables` an app expects.

## Service status (no auth, no setup)

These work on a fresh install before `init` — useful for evaluating Run402 or distinguishing platform problems from your own:

```bash
run402 service status   # 24h/7d/30d uptime per capability, operator, deployment topology
run402 service health   # per-dependency liveness (postgres, postgrest, s3, cloudfront)
```

Don't confuse with `run402 status` (your account's allowance, balance, tier, projects).

## Send feedback

```bash
run402 message send "deploy-dir was magical, but the cdn wait-fresh timeout default felt too aggressive"
```

Free with active tier. The team reads every message.

## Standard Workflow — zero to deployed

```bash
# 1. Set up (once per machine)
run402 init
run402 tier set prototype

# 2. Provision the project — copy the anon_key from the response into your HTML before deploying.
run402 projects provision --name my-app
PROJECT=$(run402 status | jq -r '.active_project')

# 3. Schema
cat > setup.sql <<'EOF'
CREATE TABLE IF NOT EXISTS items (
  id serial PRIMARY KEY,
  title text NOT NULL,
  user_id uuid,
  created_at timestamptz DEFAULT now()
);
EOF
run402 projects sql $PROJECT --file setup.sql

# 4. Authorization manifest
cat > manifest.json <<'EOF'
{ "version": "1",
  "tables": [{ "name": "items", "expose": true, "policy": "user_owns_rows",
               "owner_column": "user_id", "force_owner_on_insert": true }],
  "views": [], "rpcs": [] }
EOF
run402 projects validate-expose $PROJECT --file manifest.json --migration-file setup.sql
run402 projects apply-expose $PROJECT --file manifest.json

# 5. Deploy site + claim subdomain
run402 sites deploy-dir ./dist
run402 subdomains claim my-app

# 6. Optional: a server function
run402 functions deploy $PROJECT my-fn --file fn.ts
```

## Payment Handling

Two payment rails work with the same wallet key:

- **x402** (default): USDC on Base. Prototype = Base Sepolia testnet (free from faucet). Hobby/Team = Base mainnet.
- **MPP**: pathUSD on Tempo Moderato. Prototype = testnet (instant faucet, no rate limit). Hobby/Team = Tempo mainnet.

Switch rails via `run402 init mpp` instead of `run402 init`.

The CLI handles all signing automatically — never ask the human for a private key or set up payment libraries by hand. When a paid call returns 402, the CLI parses the requirements and signs from the local allowance. If funds are short, you get a structured error and a `renew_url`.

For real-money tiers, two paths to fund:

- **Path A — fund the agent allowance**: human sends USDC on Base mainnet to the address from `run402 allowance export`. Agent pays Run402 autonomously via x402 from then on.
- **Path B — Stripe credits**: `run402 billing create-email <human@email>` → `run402 billing tier-checkout hobby --email <human@email>` returns a checkout URL the human pays once.

Suggest $10 to your human for two Hobby projects, or $20 for one Team plus renewal buffer.

## Tips & Guardrails

- **Provision before authoring HTML**. The `anon_key` is permanent and must be embedded in your frontend; write the HTML *after* `provision` returns it.
- **Use the manifest for access control**, never raw `GRANT/REVOKE` (the SQL endpoint blocks those).
- **`user_owns_rows` is the default for user-scoped data.** Reach for `public_read_write_UNRESTRICTED` only on intentionally-public tables (and pass `i_understand_this_is_unrestricted: true`).
- **Make migrations idempotent** with `CREATE TABLE IF NOT EXISTS` and `DO`-block `ALTER TABLE` (see Database section).
- **Use immutable URLs from `blob put`** — they're correct from the moment of upload, no `wait-fresh` needed.
- **Don't bake unconditional faucet calls into deploy scripts** — they hit the rate limit and break already-funded flows.
- **Per-project rate limit is 100 req/sec.** On 429, back off using `retry_after`.
- **`run402 service status` works without auth.** Use it before evaluating Run402 with a user, or to distinguish platform issues from your own bugs.

## Agent Allowance Setup

The CLI manages a local agent allowance — a wallet key dedicated to paying Run402, stored at `~/.config/run402/allowance.json` (mode `0600`). You never touch the private key directly.

```bash
run402 allowance create               # generate a fresh allowance
run402 allowance status               # address, network, funding state
run402 allowance fund                 # request testnet USDC from the faucet
run402 allowance balance              # USDC on mainnet + testnet + billing balance
run402 allowance history              # ledger
run402 allowance export               # print the address (NOT the private key)
run402 allowance checkout --amount 5000000   # Stripe top-up to billing balance ($5)
```

Most agents only need `run402 init` once — it composes `create` + `fund` + `tier status` + `projects list`.

Other allowance options:

- **Coinbase AgentKit** — MPC wallet on Base with built-in x402.
- **AgentPayy** — auto-bootstraps an MPC wallet on Base via Coinbase CDP.

## Troubleshooting

| You see | Likely cause / fix |
|---|---|
| `402 payment_required` on `tier set` | Allowance is empty. `run402 allowance fund` (testnet) or fund with real USDC. |
| `402` with `lifecycle_state: frozen` | Project past lease + 14 days. `run402 tier set <tier>` reactivates instantly. |
| `403 admin_required` | Tool is admin-only (e.g., `pin_project`). Use a platform admin allowance wallet; project owners can't pin. |
| Empty `[]` from `/rest/v1/items` for anon | Table not in manifest with `expose: true`. Run `run402 projects apply-expose`. |
| `403 forbidden_function` calling an RPC | Function's not in the manifest's `rpcs[]`. Add `{ name, signature, grant_to: ["authenticated"] }`. |
| `409 reserved` on subdomain claim | Original owner's grace period — subdomain held until +118 days from lease expiry. |
| `429 rate_limited` | 100 req/sec project cap. Back off using `retry_after`. |
| CDN serves old bytes | Use the immutable URL from the upload response, or `run402 cdn wait-fresh <url> --sha <hex>`. |
| `422 relation already exists` on redeploy | Wrap migrations in `CREATE TABLE IF NOT EXISTS` + `DO`-block `ALTER TABLE`. |
| `insufficient_funds` right after faucet | Wait for the faucet tx to confirm (~5s on Base Sepolia) before subscribing. |

## Tools Reference

This skill is the CLI — every action above is `run402 <verb>`. The full command reference (every flag, every subcommand) lives at <https://run402.com/llms-cli.txt>. Treat that file as canonical when this body is silent on detail.

Top-level command groups:

```
run402 init | status | message | service
run402 allowance   | tier      | projects | sites      | subdomains
run402 domains     | functions | secrets  | blob       | cdn
run402 email       | sender-domain | auth | apps       | image
run402 deploy      | ai        | contracts | billing   | agent
```

Agent operator binding commands: `run402 agent contact --name <name> [--email <email>] [--webhook <url>]`, `run402 agent status`, `run402 agent verify-email`, and `run402 agent passkey enroll`. The assurance labels are `wallet_only`, `email_pending`, `email_verified`, `passkey_pending`, and `operator_passkey`; they describe mailbox/passkey continuity, not a humanhood claim.

Renewal: `run402 tier set <same-tier>` extends the lease in place and clears any grace-state timers. The CLI handles 402 negotiation automatically — call the same command again if a payment was just made.

## Links

- Full CLI reference: <https://run402.com/llms-cli.txt>
- HTTP API reference: <https://run402.com/llms.txt>
- Status: <https://api.run402.com/status>
- Health: <https://api.run402.com/health>
- npm: [`run402`](https://www.npmjs.com/package/run402) · [`@run402/sdk`](https://www.npmjs.com/package/@run402/sdk) · [`@run402/functions`](https://www.npmjs.com/package/@run402/functions) · [`run402-mcp`](https://www.npmjs.com/package/run402-mcp)
- Homepage: <https://run402.com>
