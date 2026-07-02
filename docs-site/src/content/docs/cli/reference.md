---
title: CLI reference
description: Comprehensive run402 CLI reference (the agent-facing llms-cli.txt, rendered).
order: 1
---

> CLI: `npm install -g run402`
> SDK: `npm install @run402/sdk` (typed TS client; same namespaces; Node/Deno/Bun/V8 isolates)
> Docs URL: https://docs.run402.com/llms-cli.txt
> API Docs: https://run402.com/llms.txt
> Operator: Kychee, Inc.
> Terms: https://run402.com/humans/terms.html
> Contact: `run402 message send "your message"` (requires active tier)

## TL;DR

Run402 = Postgres + REST + Auth + Storage + static & Astro-SSR site hosting + same-origin routes + Node 22 functions + email + image generation behind one CLI.

Agent-critical facts:
- Atomic full-stack apply: `run402 deploy apply --manifest app.json` ships DB migrations, site files, function code, secrets, assets, subdomains, i18n, and routes as one transaction; partial failures roll back.
- No platform token: local allowance (`~/.config/run402/allowance.json`) signs requests. Per-project `anon_key` / `service_key` are runtime data-plane keys (PostgREST/Storage/Functions), permanent, and embeddable/server-side respectively.
- Agent-paid usage: x402 USDC on Base or MPP pathUSD on Tempo, signed by allowance. Humans may fund via Stripe credits; CLI behavior is unchanged.

Install + deploy:

```bash
npm install -g run402
run402 up --name "my-app" -y                 # validates manifest, bootstraps prerequisites, deploys
```

`up` is the agent-first path when the repo has `run402.deploy.json` or `app.json`. It is a thin CLI shim over the SDK action runner; the SDK owns manifest validation, project resolution, recursive prerequisites, idempotency-key derivation, and deploy apply. Provision before writing frontend code when you need the real `anon_key` embedded. `prototype` is free with the testnet faucet; use `hobby` / `team` for mainnet.

Self-hosted Run402 Core target:

```bash
npm install -g run402
run402 init --api-base=http://my-core:4020
run402 projects provision --name "my-app"    # returns anon_key, service_key, project_id
run402 deploy apply --manifest app.json      # uses the active Core project
```

`init --api-base` stores the API base in the active profile (`target.json`) so the CLI, Node SDK, and MCP use the same target by default. Against Core, `projects provision` and `deploy apply` do not require Cloud tier, allowance, or x402 setup. Unsupported Cloud-only manifest slices fail as Core capability errors; they are not silently deployed to Run402 Cloud.

App build scripts should read the same target/profile store through `resolveRun402TargetProfile()` from `@run402/sdk/node`, not by parsing `target.json` or `projects.json` themselves.

## Core facts

- Allowance: `~/.config/run402/allowance.json` (0600); projects: `~/.config/run402/projects.json` (0600)
- Credentials saved automatically after provision or fork
- `<id>` in commands = `project_id` from `run402 projects list`
- Output: JSON stdout on success; JSON stderr on failure; exit 0 success, non-zero error. See Output Contract.
- CLI handles x402 signing; do not request private keys or payment libraries.
- `run402 up` is the only compound CLI command. It emits natural JSON with `steps[]` (no top-level success `status`). Use `--check` for local-only validation, `--plan` for gateway-reviewed intent, and `--require-plan` for exact reviewed apply.
- GitHub Actions deploys use OIDC: link once with `run402 ci link github`; generated workflow calls `run402 deploy apply` with `permissions: id-token: write`.
- Projects, sites, subdomains, forks, functions, secrets, blob storage: free with active tier. Only image generation ($0.03) is per-call
- Env overrides: `RUN402_API_BASE` (overrides stored target; default `https://api.run402.com`), `RUN402_CONFIG_DIR` (base credential dir, default `~/.config/run402`), `RUN402_WALLET` (active named wallet/profile, default `default`; alias `RUN402_PROFILE`), `RUN402_ALLOWANCE_PATH` (custom allowance file path, default `{config_dir}/allowance.json`). `run402 init --api-base=<url>` persists the active target in `{config_dir}/target.json` or `{config_dir}/profiles/<name>/target.json`.
- Wallets: `run402 wallets` manages named profiles. Select via `--wallet <name>` (`--profile`), `RUN402_WALLET`, or nearest `.run402.json` binding (commit-safe name only). Precedence: flag > env > `.run402.json`/`.run402.local.json` > `wallets use` default > `default`. Env/binding conflict hard-fails unless flag passed. `default` stays at config root; named wallets live under `{base}/profiles/<name>/`. Non-default active wallet is echoed on stderr and shown in `status` / `wallets current`.

## Output Contract

Uniform contract:
- Success: stdout emits the natural payload, never wrapped; no top-level `status`.
- Reads/list/info: resource directly, e.g. `projects info` -> `{ project_id, anon_key, ... }`, `projects list` -> `{ projects: [...], scope?, has_more?, next_cursor? }`.
- Mutations without natural payload: affected ids + boolean action field, e.g. `{ key, project_id, set: true }`, `{ name, project_id, deleted: true }`, `{ domain, project_id, released: true }`; never `{}`.
- Local-state reads (`status`, `allowance status`): nullable typed fields, e.g. `{ wallet: null, hint: "Run: run402 init" }`; absence exits 0.
- Plain text: a few documented commands (e.g. `allowance export`) emit one newline-terminated value.
- Failure: stderr JSON envelope with top-level `status: "error"` + non-zero exit. That sentinel appears on stderr only.
- Validation commands may exit 0 with payload issues, e.g. `validate-expose` prints `has_errors: true`; branch on payload fields.
- Payload-internal `status` fields are not envelopes, e.g. `doctor.checks[].status`.
- `cli-output-contract.test.mjs` guards this; violations are regressions.
- v3.0 breaking change: success wrapper `{ status: "ok", ...payload }` removed; gate on exit code. Stderr error envelope unchanged.

## `run402 up` (SDK action runner)

`run402 up [--name <name>] [--project <id>] [--manifest <path>] [--dir <path>] [--tier <prototype|hobby|team>] [-y|--yes] [--check|--print-spec|--plan|--require-plan <id>] [--quiet] [--allow-warning <code> ...] [--allow-warnings]`

Use `up` for a repo-level app deploy when the workspace has a deploy manifest. It discovers `run402.deploy.json`, then `app.json` under `--dir` / cwd, validates the manifest and filesystem references before any mutation, then executes the SDK action plan.

Project resolution order:
- explicit `--project`
- workspace link `.run402/project.json` (`schema_version: "run402.workspace-project.v1"`, `project_id`, optional `name`, `target`)
- manifest `project_id`
- approved project creation from `--name`
- approved active-project fallback

`--name` is only project creation/link metadata. It is not part of the deploy manifest, does not select a project when another selector already resolved one, and never renames an existing project. The workspace link is a local convenience file; it is written atomically and skipped in local check / reviewed-plan modes.

Approval and recursion:
- Non-interactive recursive mutations require `-y/--yes`; without it the command fails before mutating and returns a structured approval-required error.
- If allowance/tier/project/workspace link are already configured, plain `run402 up` runs the requested deploy without `-y`.
- In a TTY, the CLI prompts for SDK-planned mutations. In SDK code, pass `{ approval: "yes" }`, `{ approval: "never" }`, or an interactive approval callback.
- `--check` returns local validation `steps[]` without allowance creation, faucet request, tier payment, project creation, workspace-link write, upload, gateway plan, or deploy commit.
- `--print-spec` performs the same local validation and prints normalized `ReleaseSpec` JSON.
- `--plan` calls the gateway reviewed-plan mode without upload or commit; it does not provision projects or write workspace links. The response includes a require-able `plan_id`, `plan_fingerprint`, expiration, warnings, diff, and `next_actions[]`.
- `--require-plan <plan_id>` applies only if the reviewed plan still matches; optional `--plan-fingerprint <fingerprint>` tightens the check.
- Run402 Cloud `up` can create/fund an allowance, ensure a prototype tier by default, create a project from `--name`, write the workspace link, then apply the manifest.
- Run402 Core `up` skips Cloud allowance/tier prerequisites and fails closed if no Core project is selected by `--project`, workspace link, or manifest.
- The SDK derives child idempotency keys for recursive gateway mutations from the root action key; pass `--idempotency-key` when you need a stable external key.
- Deploy warnings use the same review surface as `deploy apply`: prefer repeatable `--allow-warning <code>` and reserve broad `--allow-warnings` for reviewed exceptional cases.

Output: stdout is the action result, e.g. `{ "action": "up", "dry_run": false, "target": "cloud", "steps": [...], "result": { "project_id": "prj_...", "manifest_path": "...", "deploy": {...} } }`. Stderr carries JSON action-step events unless `--quiet`.

## Error JSON and Safe Retry

CLI errors: JSON stderr with outer `"status": "error"`. Run402 JSON bodies may merge into the envelope. Branch on `code`, not `message`/legacy `error`.

Canonical fields:
- `code`: stable machine-readable reason, e.g. `PROJECT_FROZEN`, `PAYMENT_REQUIRED`, `MIGRATION_FAILED`, `MIGRATE_GATE_ACTIVE`. Client-side validation failures (missing flag, malformed JSON, unknown local project) default to `BAD_USAGE`; specific client-side cases use richer codes e.g. `UNKNOWN_FLAG`, `BAD_FLAG`, `PROJECT_NOT_FOUND` (with `details.source: "local_registry"`), `NO_DEPLOYMENT`, `NO_ALLOWANCE`, `BAD_JSON_FLAG`, `CONFIRMATION_REQUIRED`.
- `retryable`: the same request may succeed later
- `safe_to_retry`: repeating the same request should not duplicate or corrupt a mutation
- `mutation_state`: one of `none`, `not_started`, `committed`, `rolled_back`, `partial`, `unknown`
- `trace_id`: include this when reporting the issue
- `request_id`: routed/function handle; diagnose with `run402 functions logs <id> <name> --request-id <req_...>`. Distinct from gateway `trace_id`.
- `details`: structured route-specific context
- `next_actions`: advisory typed suggestions e.g. `authenticate`, `submit_payment`, `renew_tier`, `check_usage`, `retry`, `resume_deploy`, `edit_request`, `edit_migration`, `create_project`, `initialize_wallet`, `deploy`, or `deploy_site_first`. CLI-resolvable entries carry a literal `command`, e.g. `{ "type": "create_project", "command": "run402 projects provision" }`. Do not execute route-like suggestions without validating method/path/auth/safety.
- Cold-start chain: a fresh agent that knows only `run402 deploy apply` is walked to a deployed result by following `next_actions` — no allowance -> `run402 init`, no tier -> `run402 tier set prototype`, no project -> `run402 projects provision` — each step idempotent, then retry the deploy. You do not need to memorize the sequence; follow what each failure hands back.
- Prefer `run402 up` when starting from a local repo: it plans and runs that same cold-start chain through the SDK instead of executing advisory `next_actions[].command` strings.

Retry policy:
- Retry same request only when `retryable: true` and `safe_to_retry: true`; reuse idempotency key for mutations when available.
- `safe_to_retry: true` alone means duplicate-safe, not likely-to-succeed. Lifecycle-gated writes, auth token exchanges, and passkey verifies need the indicated action first.
- `run402 deploy apply` already handles safe `BASE_RELEASE_CONFLICT` release races for omitted/current-base deploy specs: it re-plans, emits `deploy.retry` events on stderr, and stops after its bounded SDK retry budget. Exhausted deploy retries include `attempts`, `max_retries`, and `last_retry_code` in the error envelope. Do not hand-roll this specific retry loop around the CLI unless you intentionally disabled SDK retries upstream.
- For mutating 5xx with `safe_to_retry: false`, or `mutation_state` in `committed|partial|unknown`, inspect/poll/reconcile before retry. For deploys prefer `deploy events`/`deploy resume` over duplicate apply.
- Lifecycle/payment: `PROJECT_FROZEN`/`PROJECT_DORMANT`/`PROJECT_PAST_DUE` -> `projects usage <id>` or `tier set <tier>`; `PAYMENT_REQUIRED`/`INSUFFICIENT_FUNDS` -> submit payment/fund allowance.
- `NOT_AUTHORIZED` (HTTP 403) is an org-owned-control-plane authorization denial (v1.77+), distinct from auth or payment: the wallet *authenticated*, but its resolved principal lacks the org role or per-project grant the action needs. `details` carries `required_role` / `required_capability` / `reason`. Not retryable without obtaining a covering org membership/role or grant; high-stakes ops (delete, transfer-of-ownership, membership change) require an active `owner` membership. The gateway returns 403 even when the project does not exist (so existence isn't leaked) — re-check the `<id>` too. The CLI envelope adds an actionable `hint`.
- `STEP_UP_REQUIRED` (HTTP 403) is a freshness/provenance demand for a high-stakes control-plane op: the session is valid but not fresh enough, or was minted by a read/device-flow path that can't satisfy a passkey step-up. `details` carries `required_amr` / `max_age_seconds` / `challenge_url` / `reason`, plus `next_actions[]`. The SDK raises a typed `StepUpRequiredError` (`isStepUpRequired()` guard). Resolve with `run402 operator login --step-up` on the same client, then retry. Distinct from `NOT_AUTHORIZED` (a role/grant gap, not a freshness gap).
- `WRITE_AUTH_REQUIRED` / `WRITE_AUTH_BINDING_MISMATCH` / `WRITE_AUTH_SESSION_INVALID` (HTTP 403) — a wallet-less human's control-plane session needs a passkey **operator approval** scoped to this `(action, target)` (the SIWX wallet path never hits this). The SDK raises a typed `OperatorApprovalRequiredError` (`isOperatorApprovalRequired()` guard) carrying `capability`, `target`, and a fully-resolved `approveCommand` / `nextActions[]` (e.g. `run402 operator approve --action project.deploy --project prj_x`). `BINDING_MISMATCH` = a cached approval targeted the wrong org/project; `SESSION_INVALID` = it's stale. Resolve by running the surfaced `operator approve` command (or let an interactive `provision`/`deploy` auto-approve).
- Client-side `BAD_JSON_FLAG` errors include `details.flag` (the offending flag, e.g. `--abi`) and `details.value_preview` (truncated value) so callers know which flag value to fix.
- CLI commands reject unknown flags and missing flag values locally with `UNKNOWN_FLAG` or `BAD_FLAG` before network work. Numeric and wei-like flags are strict decimal integers: malformed, fractional, negative, and scientific-notation values fail locally instead of being forwarded to the API.
- Commands with fixed positional shapes also reject extra positional arguments locally. This includes deploy resume/list/events/release subcommands, functions list/delete, and blob get/rm/sign/diagnose.

Examples:
```json
{ "status": "error", "http": 403, "message": "Project is frozen.", "code": "PROJECT_FROZEN", "category": "lifecycle", "retryable": false, "safe_to_retry": true, "mutation_state": "none", "next_actions": [{ "type": "renew_tier" }, { "type": "check_usage" }] }
```

```json
{ "status": "error", "http": 402, "message": "Payment required.", "code": "PAYMENT_REQUIRED", "category": "payment", "retryable": true, "safe_to_retry": true, "next_actions": [{ "type": "submit_payment" }] }
```

```json
{ "status": "error", "message": "Migration failed.", "code": "MIGRATION_FAILED", "category": "deploy", "retryable": false, "safe_to_retry": true, "mutation_state": "rolled_back", "trace_id": "trc_...", "details": { "operation_id": "op_...", "phase": "migrate" }, "next_actions": [{ "type": "edit_migration" }] }
```

---
## Step 1: Install

```bash
npm install -g run402
```

## Step 2: Set Up Allowance and Funding

```bash
run402 init               # creates allowance if absent; checks balance; faucets testnet USDC if zero; shows tier/projects
run402 allowance create    # Generate a new allowance
run402 allowance fund      # Get free testnet USDC (Base Sepolia)
run402 allowance balance   # Check USDC balance (mainnet + testnet + billing)
```

Allowance lives at `~/.config/run402/allowance.json` (0600). CLI signs x402 automatically; never handle private keys/payment libs manually.

For a self-hosted Run402 Core Gateway, skip Cloud allowance setup and configure the target instead:

```bash
run402 init --api-base=http://my-core:4020
```

After that, the same `run402 projects provision` and `run402 deploy apply` commands target Core.

## Step 3: Subscribe to a Tier

```bash
run402 tier set prototype    # FREE on testnet — faucet USDC verifies your x402 setup ($0 real money); 7-day lease
run402 tier set hobby        # $5 for 30 days (real money)
run402 tier set team         # $20 for 30 days (real money)
```

Tier is organization-scoped. Subscribe/renew/upgrade applies to every project in the org; `api_calls` / `storage_bytes` quota is org-pooled across linked wallets (`billing link-wallet`). Quota errors include `details.scope: "organization" | "project"` (`project` = orphan fallback after org purge before cascade). `tier set` refetches status and returns `status_after` with refreshed pool usage.

Retry-safety: `tier set` and `projects provision` accept `--idempotency-key <key>` so a retried subscribe/renew/create collapses onto one charge instead of double-billing. `provision` auto-derives the key from `--name` when omitted (re-running `provision --name X` returns the same project); `tier set` is caller-supplied only — use a fresh key for a deliberate second renewal.

Server action detection:
- No tier or expired -> subscribe
- Same tier, active -> renew (extends from current expiry)
- Higher tier -> upgrade (prorated refund to billing allowance)
- Lower tier, active -> downgrade (prorated refund if usage fits)

```bash
run402 tier status
```

`tier status` `pool_usage` sums `api_calls` and `storage_bytes` across every project on the organization (across every linked wallet), not the requesting wallet's projects.

With active tier: unlimited projects/sites/forks/functions/secrets/storage subject to org-pooled `api_calls`/`storage_bytes`; only image generation is per-call ($0.03/image).

---
## Portable Project Archives (Cloud -> Core)

Portable archives are the vendor-lock-in escape hatch: Cloud is the easiest place to start, not the only place the supported application can run. This is separate from allowance/spend-cap financial-risk controls. Archive v1 exports the supported Run402 Core runtime slice of a Cloud project, not an entire Cloud project.

Canonical agent path:

```bash
run402 cloud archives create prj_... \
  --scope portable-runtime-v1 \
  --auth stubs \
  --consistency pause-writes \
  --wait \
  --output ./project.r402ar \
  --json

run402 archives inspect ./project.r402ar --json
run402 archives verify ./project.r402ar --json

# Create ./required.env from required_secrets or secrets/required.env.template.
run402 core projects import ./project.r402ar \
  --name imported-project \
  --env-file ./required.env \
  --json
```

`cloud archives create` creates an operation-backed Cloud export, waits when `--wait` or `--output` is present, downloads bytes when `--output` is set, and returns `archive_id`, `operation_id`, `archive_status`, `sha256`, `expires_at`, `portability_report`, `export_report`, `verify_command`, and `import_command`. Use `--idempotency-key <key>` for safe retries, `--poll-interval <ms>` and `--timeout <ms>` for waits, and `--json-stream` for NDJSON progress.

Progress events are one JSON object per line:

```json
{"event":"archive_export_created","stage":"create","resource_type":"project_archive","resource_id":"arc_...","project_id":"prj_...","status":"running","completed_units":0,"total_units":1,"code":null,"message":"Archive export status: running","next_action":{"type":"none"},"retryable":true}
```

Every event and diagnostic uses stable agent fields: `code`, `severity`, `resource_type`, `resource_id`, `message`, `next_action`, `retryable`, and safe `context`.

`archives inspect` and `archives verify` are local and offline. They do not require Cloud credentials. `verify` checks descriptor/blob integrity, format compatibility, required capabilities, size/path safety, required secrets, auth stub counts, and portability diagnostics. Verification means integrity and compatibility, not trust; archives remain untrusted input.

`core projects import` verifies before import, targets a new Core project only, and calls a local Core gateway (`RUN402_CORE_URL` or `--core-url`, default `http://127.0.0.1:4020`). It supports `--dry-run`, `--require-runnable`, `--env-file`, and repeated `--secret KEY=VALUE` overrides. Required secret names are reported by inspect/verify and in the archive's `secrets/required.env.template`; secret values are never exported.

Expected v1 exclusions: secret values, password hashes, sessions, refresh/access/OAuth tokens, MFA secrets, signed URLs, logs, billing/allowance/spend state, fleet/Aurora/global-routing/provider operations, managed backups, monitoring, abuse/compliance/support metadata, Cloud import, and existing-project merge import.

Stable archive codes include `EXPORT_CONSISTENCY_UNAVAILABLE`, `EXPORT_SCOPE_UNSUPPORTED`, `ARCHIVE_EXPIRED`, `ARCHIVE_DIGEST_MISMATCH`, `ARCHIVE_UNSUPPORTED_VERSION`, `ARCHIVE_UNSUPPORTED_REQUIRED_CAPABILITY`, `ARCHIVE_PATH_UNSAFE`, `ARCHIVE_BLOB_MISSING`, `SECRET_VALUES_REQUIRED`, `AUTH_CREDENTIALS_NOT_EXPORTED`, `AUTH_SUBJECT_STUBS_IMPORTED`, `CLOUD_ONLY_FEATURE_EXCLUDED`, `PROJECT_ALREADY_EXISTS`, `IMPORT_VERIFY_FAILED`, and `IMPORT_CONFORMANCE_FAILED`.

---
## Deploying Apps

### Unified Apply

Canonical deploy primitive: CAS bytes (no inline-body cap), per-resource `replace`/`patch`, atomic multi-resource activation, resumable failures. SDK: `r.project(id).apply(...)`.

⚠️ You still need the `anon_key` BEFORE writing your manifest -- provision first, then embed the real key in your HTML.

```bash
run402 projects provision --name "my-app"
# → copy anon_key from output into your HTML
```

Manifest format mirrors a v2 `ReleaseSpec`. For editor autocomplete, use top-level `"$schema": "https://run402.com/schemas/release-spec.v1.json"`; the CLI accepts that metadata and strips it before planning.

```json
{
  "$schema": "https://run402.com/schemas/release-spec.v1.json",
  "project_id": "prj_1741340000_42",
  "database": {
    "migrations": [
      {
        "id": "001_init",
        "sql": "CREATE TABLE IF NOT EXISTS items (id serial PRIMARY KEY, title text NOT NULL); INSERT INTO items (title) VALUES ('Buy groceries');"
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
        "config": { "timeout_seconds": 30, "memory_mb": 256 },
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

File entries: bare UTF-8 string; `{ "data": "...", "encoding": "utf-8" | "base64", "content_type": "..." }`; or `{ "path": "dist/index.html", "content_type": "text/html" }`. `site.replace` / `site.patch.put` may also be `{ "__source": "local-dir", "path": "dist/client" }` for a static-site directory. Function `source` may be `{ "path": "dist/run402/functions/api.js" }`. `--manifest` relative paths resolve from manifest dir; `--spec`/stdin paths resolve from cwd. Authoring-only local paths and `__source` markers are stripped/staged before the apply request. Migrations may use `"sql_path"` / `"sql_file"` instead of `"sql"`. CLI/MCP share SDK `normalizeDeployManifest`; JSON can become SDK-native `ReleaseSpec`. Strict adapter: only top-level `$schema` and app-kit evidence `x-run402-omitted_features` are ignored before planning; unknown fields/no-op specs fail (`"subdomain"`, `"site.replcae"`, `"functions.replace.api.deps"`, `"functions.replace.api.config.schedule"`).

Function specs: `runtime: "node22"`, exactly one code source (`source` or `files`+`entrypoint`), `config.timeout_seconds`, `config.memory_mb`, and optional `triggers[]`. Schedule triggers require a stable `id`, `type: "schedule"`, 5-field `cron`, and nested `run: { event_type, payload?, retry?, expires_after_seconds? }`; each tick creates a durable function run. Email triggers use `{ id, type: "email", mailbox, events, run }`, where `mailbox` is a mailbox slug/id and `events` is any of `reply_received`, `delivery`, `bounced`, `complained`; each matching email event creates a durable function run with the canonical event payload under `payload.event`. `deps: string[]` works under `apply-v1-function-deps`; gateway installs/bundles. `run402 functions deploy --deps` builds one `functions.patch.set` and uses unified apply; legacy standalone deploy route removed.

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

Route semantics:
- Omit `routes` or pass `null` to carry forward; `{ "replace": [] }` clears; `{ "replace": [...] }` atomically replaces.
- Entries: `pattern`, optional non-empty `methods` (`GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS`), `target`. Function target: `{ "type": "function", "name": "<materialized function name>" }`. Prefer `site.public_paths` for ordinary clean static URLs. Static route target = exact, method-aware alias, e.g. `{ "pattern": "/events", "methods": ["GET", "HEAD"], "target": { "type": "static", "file": "events.html" } }`; `file` is release asset path, not public path/URL/CAS/rewrite/redirect. Static targets require exact patterns only, methods `["GET"]` or `["GET","HEAD"]`, no leading slash/wildcard/dir shorthand/query/fragment. Path-keyed maps like `"routes": { "/api/*": { "function": "api" } }` invalid.
- Exact patterns look like `/admin`; prefix wildcard patterns use final `/*`, like `/admin/*`. `/admin/*` does not match `/admin`, `/admin/`, `/admin.css`, or `/administrator`, so deploy both `/admin` and `/admin/*` for a dynamic section root.
- Query ignored for matching but preserved in full public `req.url`. Exact beats prefix; longest prefix wins; method-compatible dynamic routes beat static assets.
- `POST /login` can coexist with static `GET /login`; unsafe method mismatch returns 405, not SPA HTML. Matched dynamic failures fail closed; no static fallback.
- Routed ingress uses the Node 22 Fetch Request -> Response contract; `req.url` is full public URL across managed subdomains/deployment hosts/custom domains. Derive OAuth origins from `new URL(req.url).origin`. `run402.routed_http.v1` envelope is internal. Direct `/functions/v1/:name` remains API-key protected. Function owns app auth, CSRF, CORS/`OPTIONS`, cookies, redirects, and forwarding-header hygiene.
- Anti-patterns: routing every static file, broad method lists by default, wildcard static route targets, leading-slash static files, directory shorthand, one-static-route-target-per-page route-table exhaustion, wildcard function routes shadowing direct public static paths, and confusing omitted/null `routes` with `routes: { "replace": [] }`.

Apply it:

```bash
run402 deploy apply --manifest app.json
```

Stdout final result includes `release_id`, `operation_id`, `urls`, etc. Stderr streams JSON-line progress events. `--quiet` / `--final-only` silence stderr while preserving stdout.

Typed deploy configs are an authoring format for the same `deploy apply` and `up` verbs, not a separate command family. JSON data manifests (`run402.deploy.json`, `app.json`) may be auto-discovered. TypeScript/JavaScript configs are executable local code, so v1 requires explicit trust with `--manifest`:

```bash
run402 up --manifest run402.deploy.ts --check
run402 up --manifest run402.deploy.ts --print-spec
run402 up --manifest run402.deploy.ts --plan
run402 up --manifest run402.deploy.ts --require-plan plan_...
```

Mode contract:
- `--check`: local-only import/normalize/strict field validation plus local file checks. No gateway calls, uploads, tier/project creation, or `.run402/project.json` writes. Success is raw JSON with `mode: "check"` / `dry_run: true` on `up`, or `{ ok: true, mode: "check", project_id, manifest_path }` on `deploy apply`.
- `--print-spec`: local-only normalized `ReleaseSpec` JSON to stdout.
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

Helper semantics: `dir()` walks files in stable path order, skips private/dev patterns by default like the existing directory deploy helpers, normalizes `/` separators, rejects symlinks, and infers content types. `file()` resolves relative to the config file directory. `sqlFile()` derives the migration id from the filename unless `id` is supplied and fails duplicate ids/checksum mismatches locally. `nodeFunction()` stages a Node 22 function from built JavaScript; TypeScript function source paths are rejected with `TYPESCRIPT_FUNCTION_REQUIRES_BUNDLE` until a deterministic bundler path is introduced.

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

Destructive apply recovery (v1.58+): `run402 deploy promote <release-id>` re-points live release at a prior ready row without re-running apply (no bytes/bundling/migration), just `internal.projects.live_release_id` pointer swap + ssr_cache flush.

```bash
# rel_old (good)  →  rel_new (bad, destructive)  →  promote back
run402 deploy promote rel_old_abc123 --project prj_xyz \
  --allow-warning MIGRATIONS_NOT_REVERSIBLE
```

Promote warnings/errors: `MIGRATIONS_NOT_REVERSIBLE` requires ack when target predates applied migrations; migrations remain applied against current schema. `FUNCTION_VERSION_MISMATCH` informational when overlapping names have different `code_hash` (Lambda code = current `$LATEST`). Rejects: `PROMOTE_TARGET_NOT_FOUND`, `PROMOTE_PROJECT_MISMATCH`, `PROMOTE_RELEASE_NOT_READY` (needs `ready|active|superseded`), `PROMOTE_NO_OP` (use `cache.invalidateAll`), `PROMOTE_WARNING_REQUIRES_ACK`.

Deploy history/observability:

```bash
run402 deploy list --project prj_... --limit 10
run402 deploy events <operation_id> --project prj_...
run402 deploy release active --project prj_... --site-limit 5000
run402 deploy release get rel_... --project prj_...
run402 deploy release diff --from empty --to active --project prj_... --limit 1000
run402 deploy diagnose --project prj_123 https://example.com/events --method GET
run402 deploy resolve --project prj_123 --url https://example.com/events?utm=x#hero --method GET
run402 deploy resolve --project prj_123 --host example.com --path /events --method GET
```

`list` -> `{ operations, cursor }`; SDK/MCP accept non-null cursor. `events` returns same `DeployEvent` shapes as inline apply events.

`release active|get` -> `{ release: ReleaseInventory }`: metadata, `state_kind` (`current_live|effective|desired_manifest`), `site.paths` (capped by `--site-limit`), `static_public_paths`, functions, secret keys only, subdomains, routes, migrations, `release_generation`, `static_manifest_sha256`, nullable `static_manifest_metadata`, `i18n` (`{ defaultLocale, locales, detect }` or `null`), warnings. `static_public_paths[]` has `public_path`, `asset_path`, `reachability_authority`, `direct`, cache class, content type. `static_manifest_metadata: null` = unavailable; when present has `file_count`, `total_bytes`, `cache_classes`, `cache_class_sources`, `spa_fallback`. Verify i18n with `jq '.release.i18n'`; absent field (older gateway) = unknown, not null.

`release diff` -> `{ diff: ReleaseToReleaseDiff }`; `--from empty|active|release_id`, `--to active|release_id`. Migrations: `migrations.applied_between_releases`; secrets/subdomains: `added`/`removed`; routes: `added`/`removed`/`changed`; `static_assets`: unchanged/changed/added/removed plus `newly_uploaded_cas_bytes`, `reused_cas_bytes`, `deployment_copy_bytes_eliminated`, `legacy_immutable_warnings`, `previous_immutable_failures`, `cas_authorization_failures`.

`deploy diagnose` URL-first; `deploy resolve` lower-level SDK/endpoint parity. Use either `--url` OR `--host` + optional `--path`. Both output `status`, `would_serve`, `diagnostic_status`, `match`, `summary`, normalized `request`, `warnings`, `resolution`, `next_steps`. URL query/fragment ignored for lookup and reported under `request.ignored`. `asset_path`, `reachability_authority`, `direct` identify backing release asset and whether implicit, explicit `site.public_paths`, or route-only alias. Host/path misses exit 0 if resolver succeeded; branch on `would_serve: false`.

Diagnostics may include `authorization_result`, `cas_object` (`sha256`, `exists`, `expected_size`, `actual_size`), `response_variant`, `allow`, `route_pattern`, `target_type`, `target_name`, `target_file`. Known `match`: `host_missing`, `manifest_missing`, `active_release_missing`, `unsupported_manifest_version`, `path_error`, `none`, `static_exact`, `static_index`, `spa_fallback`, `spa_fallback_missing`, `route_function`, `route_static_alias`, `route_method_miss`. Known `authorization_result`: `authorized`, `not_public`, `not_applicable`, `manifest_missing`, `target_missing`, `active_release_missing`, `unsupported_manifest_version`, `path_error`, `missing_cas_object`, `unfinalized_or_deleting_cas_object`, `size_mismatch`, `unauthorized_cas_object`. Known `fallback_state`: `active_release_missing`, `unsupported_manifest_version`, `negative_cache_hit`. Preserve unknown future strings. `result` = diagnostic body status, not HTTP transport. Resolve/diagnose is not fetch, purge, or cache-policy oracle.

Route warning guidance:

| Code | Meaning | Recover |
|---|---|---|
| `PUBLIC_ROUTED_FUNCTION` | Function becomes public same-origin browser ingress. | Review app auth, CSRF, CORS/`OPTIONS`, and cookies; direct `/functions/v1/:name` remains API-key protected. Prefer `--allow-warning PUBLIC_ROUTED_FUNCTION` after review; use `--allow-warnings` only after every warning was reviewed. |
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

Migration registry: key = `(id, checksum)`. Same id+SQL = noop; same id+different SQL = `MIGRATION_CHECKSUM_MISMATCH`. Use idempotent migrations (`CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS` in `DO` block).

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

Use `run402 deploy apply --manifest app.json` for full-stack releases; see the Unified Apply example above. `project_id` is required unless `--project` or active project is used. Omitted top-level sections carry forward. Strict adapter: only top-level `$schema` ignored; typo/no-op fields fail before planning.

Function specs add v1.51+ auth gates:
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

Role reads (`@run402/functions` 3.4.0+, `{ from }` since 3.5.0): edge gate authenticates Bearer JWT and cookie-session SSR browsers (`ssr-aware-role-gate`). Choose by topology:
- Dedicated function/route: prefer deploy-spec `require_role`; per-function, pre-dispatch, TTL-cached. `await auth.requireRole("operator")` returns `{ user, role }`; throws distinct `RoleGateNotConfiguredError` (500) vs `InsufficientRoleError` (403). Multi-role: `await auth.role()` and branch. Browser console can set gate `on_deny: "redirect"` + same-origin `sign_in_path` for anonymous HTML 303 to sign-in; authenticated wrong-role remains 403 JSON.
- Catch-all SSR/finer per-path control: use in-function `{ from }` guard; edge gate would also gate public catch-all/404 and `/admin/login`.

```ts
const { user } = await auth.requireRole("operator", { from: { table: "staff", idColumn: "user_id", roleColumn: "role" } });
// or, for an .astro page (a throw in frontmatter renders a 500, not a redirect) use the non-throwing read:
const role = await auth.role({ from: { table: "staff", idColumn: "user_id", roleColumn: "role" } });
if (role !== "operator") return Astro.redirect("/admin/login", 303);
```

`run402 auth scaffold-roles --roles operator` emits conventional `app_roles(user_id uuid, role text)` migration, matching `requireRole` snippet, and service-role `INSERT` for FIRST role (table starts empty; first grant bypasses RLS). Gate keys on tenant user id (`internal.users.id` / JWT `sub`), not wallet. Applies to routed and direct (`POST /functions/v1/:name` with API key + user JWT); direct still requires API key before gate.

Binary files (images, fonts, PDFs): Set `"encoding": "base64"` and provide base64-encoded data. MIME types are auto-detected from the file extension (`.png` → `image/png`, `.woff2` → `font/woff2`, etc.). Text files use `"encoding": "utf-8"` (the default — can be omitted).

Assets slice (v2.0+): top-level `ReleaseSpec.assets` promotes content-addressed asset entries in the same atomic transaction as site/functions/secrets.

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

`—` = denied. `service_key` bypasses all policies. Views are always created with `security_invoker=true` — they inherit the underlying table's RLS. RPCs require an entry in `rpcs[*]` with `grant_to` to be callable as `/rest/v1/rpc/<fn>` (since v1.30, `CREATE FUNCTION` revokes PUBLIC EXECUTE automatically).

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

Deploy runs migrations, applies `database.expose`, deploys functions/site/assets, claims subdomains, and updates routes atomically. Set secret values first with `run402 secrets set`; deploy manifests only declare value-free `secrets.require` / `secrets.delete`.

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

# 6. Claim a subdomain (uses active project + last deployment automatically)
run402 subdomains claim my-app
```

---
## Command Reference

### up
- `run402 up [--name <name>] [--project <id>] [--manifest <path>] [--dir <path>] [--tier <prototype|hobby|team>] [-y|--yes] [--check|--print-spec|--plan|--require-plan <id>] [--quiet]` — SDK-owned recursive app deploy. Validates `run402.deploy.json`/`app.json`, requires explicit `--manifest` for executable `.ts/.js` configs, ensures missing Cloud prerequisites when approved, resolves/creates/links a project, then applies the manifest. Output includes `steps[]`; success has no top-level `status`. Use `--check` for local-only validation, `--print-spec` for normalized `ReleaseSpec`, `--plan` for a gateway-reviewed non-deploying plan, and `--require-plan` for exact reviewed apply.

### init
- `run402 init` — set up with x402 (Base Sepolia). Creates allowance, requests faucet, checks tier, lists projects.
- `run402 init --api-base <url>` — configure the active profile to target a Run402 Core/API base. For Core, this does not create an allowance, request faucet funds, or require a Cloud tier.
- `run402 init mpp` — set up with MPP (Tempo Moderato testnet). Same steps, different payment rail.

### status
`run402 status` — show full organization state in one shot (wallet, rail, balances, tier, projects, active project). Read-only, JSON output. Includes a `wallet: { local_label, server_label, address }` object naming the active named wallet (`local_label` is the local selector, `server_label` the server-synced display name or null), a top-level `rail`, and a `balances: { on_chain_usd_micros, on_chain_token, prepaid_credit_usd_micros, held_usd_micros }` object. The on-chain token tracks the rail (USDC on x402, pathUSD on mpp); prepaid credit is rail-independent.

### wallets
Manage multiple named wallets (profiles) on one machine. Keys never leave the machine (non-custodial). The `default` wallet lives at the config-dir root; named wallets live under `{config_dir}/profiles/<name>/`.
- `run402 wallets list` — JSON array of `{ local_label, server_label, address, address_short, rail, active }`. Reads non-secret `meta.json`; never loads private keys.
- `run402 wallets current` — the resolved active wallet `{ name, source, source_detail, address, label, warnings }`. `source` ∈ flag|env|binding|config|default. `warnings` surfaces env-vs-binding conflicts and local-name-vs-server-label drift.
- `run402 wallets new <name> [--mpp]` — create a new named wallet (generates a key). `{ name, address, rail, created: true }`.
- `run402 wallets use <name>` — set the global default wallet (`config.json` `active_wallet`). `{ name, active: true }`.
- `run402 wallets rename <old> <new>` — rename a wallet; renaming `default` migrates its root files into `profiles/<new>/`. `{ from, to, renamed: true }`.
- `run402 wallets bind [<name>]` — write `./.run402.json` binding this directory to a wallet (defaults to the active one). Safe to commit (holds only a name). `{ wallet, file, bound: true, safe_to_commit: true }`.
- `run402 wallets unbind` — remove `./.run402.json`. `{ file, unbound }`.
- `run402 wallets import <name> --key <path|->` — adopt an existing 0x-prefixed 64-hex private key (file path or `-` for stdin) as a named wallet. `{ name, address, imported: true }`.
- `run402 wallets rm <name> --yes` — delete a wallet and its keys. Requires `--yes` (agent-first: no interactive prompt). Refuses to remove `default`. `{ name, removed: true }`.
- Server-side display label: `new`/`rename`/`import` push the wallet's name to a server-side label (signed by the wallet — proof of control) so the same name shows cross-machine and in the operator console (WEB). Best-effort and on by default; `RUN402_WALLET_LABEL_SYNC=0` opts out (fully offline wallet ops). The local folder name is the source of truth; the label is a mirror, and `wallets current` flags any drift.
- Selection for ANY command: `--wallet <name>` (alias `--profile`) > `RUN402_WALLET` > nearest `./.run402.json`/`.run402.local.json` > `wallets use` default > `default`. A conflicting env + binding errors with `WALLET_SELECTION_CONFLICT` (resolve via `--wallet`, `unset RUN402_WALLET`, or `wallets unbind`). Selecting a non-existent wallet errors with `WALLET_NOT_FOUND`.

### allowance
- `run402 allowance <create|status|fund|balance|export>`
- `run402 allowance checkout --amount <usd_micros>`
- `run402 allowance history [--limit <n>]`

### tier
Tier and quotas are per organization (not per project) — `set` is organization-wide, `status.pool_usage` is the pooled total across every project in the organization. `set` refetches status after the call and includes it as `status_after`.

- `run402 tier status`
- `run402 tier set <prototype|hobby|team>`

### projects
- `run402 projects quote`
- `run402 projects list [--org <id>] [--all]` — SERVER read of the named, domain-aware inventory (NOT the local keystore). Membership-scoped by default: every project owned by an org your wallet is an active member of, each row `{ project_id, name, site_url, custom_domains, org_id, status, active }` (`active` from local state). `--org <id>` filters to one org (authorize-before-reveal: non-member/guessed id -> 403, non-UUID -> 400). `--all` reads the cross-wallet inventory across every wallet controlling your operator email — run `run402 operator login` first for the union, else it falls back to the current wallet's slice and echoes `scope`. Bare `run402 projects list` is the cold-start path (no login needed). Tier/lifecycle live on the organization — use `run402 status` / `run402 tier status`.
- `run402 projects rename <id> --name <label>` — rename a project (fix an auto-generated name). Needs org `admin`+ (or a `project:write` grant) on the owning org; authorize-before-reveal (unauthorized/guessed id -> 403, never a not-found oracle). Works even if the project isn't in the local keystore. Server-validated name (1-200 chars, no control characters).
- `run402 projects provision [--name <name>] [--org <id>]` — `--org` provisions into an EXISTING org (you need `developer`+ on it); omit for the cold-start path (the wallet's organization). Tier is org-governed — a client-supplied `--tier` is ignored when targeting an org. Against a configured Core target, creates a local Core project without Cloud payment and saves it as the active project.
- `run402 projects use <id>`
- `run402 projects get <id>` — SERVER read of one project's authoritative view: `{ project_id, public_id, name, org_id, tier, effective_status, organization_lifecycle_state, site_url, custom_domains[], last_deploy, mailbox[], usage{api_calls, storage_bytes, api_calls_limit, storage_bytes_limit}, created_at }`. Caller-authed (SIWX/control-plane, no project keys) and works even if the project isn't in the local keystore; authorize-before-reveal (unauthorized/guessed id -> 403, never a not-found oracle). Returns NO keys — use `run402 projects keys <id>` for those. Contrast `info`/`keys`, which read the LOCAL keystore only.
- `run402 projects info <id>`
- `run402 projects sql <id> "<sql>" [--file <path>] [--params '<json_array>']`
- `run402 projects rest <id> <table> "<query>"`
- `run402 projects keys <id>` — print anon_key + service_key as JSON
- `run402 projects costs <id> [--window <24h|7d|30d|90d>]` — admin-only per-project finance: revenue, direct cost, margin, and cost breakdown. Uses the configured allowance wallet for admin auth; `RUN402_ADMIN_COOKIE='run402_admin=...'` is an optional browser-session override.
- `run402 projects promote-user <id> <email>` — promote a user to project_admin role
- `run402 projects demote-user <id> <email>` — demote a user from project_admin role
- `run402 projects <usage|schema> <id>`
- `run402 projects delete <id> --confirm` — cascade deletes all project resources: Lambda functions, subdomains, S3 site files, deployments, secrets, and published app versions. The schema slot is dropped and recreated. This is irreversible. `--confirm` is required.
- `run402 projects validate-expose [id] <manifest_json>` — validate an auth/expose manifest without applying it
- `run402 projects validate-expose [id] --file manifest.json [--migration-file setup.sql]` — validate file input with optional migration-reference SQL
- `run402 projects apply-expose <id> <manifest_json>` — apply a declarative authorization manifest
- `run402 projects apply-expose <id> --file manifest.json` — apply from a JSON file
- `run402 projects get-expose <id>` — print the current manifest (`source: applied | introspected`)

Provisioning automatically sets the new project as the active project. Other commands that take `<id>` default to the active project when omitted.

SQL supports DDL + queries, returns JSON. REST uses PostgREST syntax (`select=`, `eq.`, `order=`, `limit=`).

User auth: password + Google OAuth. See "User Auth" section below.

### admin (platform-admin only, v1.57+)
- `run402 admin lease-perpetual <organization_id> --enable | --disable` — toggle the organization-level escape hatch. When enabled, the organization never advances past `active` regardless of lease expiry; every project on the organization is pinned. Enabling on a grace-state organization (past_due / frozen / dormant) reactivates inline (`reactivated: true` in the response). Replaces the v1.56 `run402 projects pin` (gateway endpoint /projects/v1/admin/:id/pin was removed in v1.57).
- `run402 admin archive <project_id> [--reason "..."]` — operator moderation. Sets `projects.archived_at = NOW()` on a single project; sibling projects on the same organization keep serving. No-op when already archived (returns `note: "already archived"`).
- `run402 admin reactivate <project_id>` — un-archive a project (flips `archived_at` back to NULL). In v1.57 this was narrowed: it no longer touches organization-level lifecycle. To reactivate a grace-state organization, run `run402 tier set <tier>` (the tier flow runs the lifecycle advance inline) or enable `run402 admin lease-perpetual <org_id> --enable`.

All admin subcommands require a platform-admin allowance wallet (or an admin OAuth session). Project owners with a non-admin wallet receive `403 admin_required`.

### deploy
- `run402 deploy apply --manifest app.json [--project <id>] [--check|--print-spec|--plan|--require-plan <id>] [--quiet|--final-only] [--allow-warning <code> ...] [--allow-warnings]` — unified apply primitive with `assets` slice support; accepts JSON data manifests and explicit executable typed configs through the same `--manifest` flag
- `run402 deploy resume <operation_id> [--project <id>] [--quiet]` — re-run a stuck operation forward
- `run402 deploy promote <release-id> [--project <id>] [--allow-warning <code>] [--allow-warnings]` — operator pointer-swap (re-point live release without re-running the apply pipeline); v1.58+
- `run402 deploy list [--project <id>] [--limit <n>]` — list recent deploy operations
- `run402 deploy events <operation_id> [--project <id>]` — fetch the recorded event stream for an operation
- `run402 deploy release get <release_id> [--project <id>] [--site-limit <n>]` — fetch release inventory
- `run402 deploy release active [--project <id>] [--site-limit <n>]` — fetch current-live release inventory
- `run402 deploy release diff --from <empty|active|release_id> --to <active|release_id> [--project <id>] [--limit <n>]` — diff release targets
- `run402 deploy diagnose [--project <id>] <url> [--method GET]` — URL-first public deploy diagnostics
- `run402 deploy resolve [--project <id>] (--url <url> | --host <host> [--path /x]) [--method GET]` — lower-level resolver parity; `--url` cannot be combined with `--host`/`--path`

Requires active tier and a provisioned project on Run402 Cloud. Against a configured Core target, uses the active Core project and does not require Cloud tier/allowance setup. Deploys to an existing project: runs migrations, applies the authorization manifest (from a `manifest.json` entry in `files[]`), deploys functions, deploys static site, and claims subdomain when the target supports that slice. Secret values are write-only: set them with `printf %s "$OPENAI_API_KEY" | run402 secrets set <id> OPENAI_API_KEY --stdin` or `--file <path>` before deploy, then use value-free `secrets.require` in `deploy apply` manifests. `deploy apply` stops before upload/commit on confirmation-required warnings unless each warning is covered by repeatable `--allow-warning <code>` or the broad reviewed `--allow-warnings`; `--require-plan` absorbs the warning approval already bound into the reviewed plan and rejects warning flags. The manifest must include `project_id` (or use `--project` flag, or omit both to use the active project).

Inside GitHub Actions, `deploy apply` automatically uses OIDC credentials when `GITHUB_ACTIONS=true`, `ACTIONS_ID_TOKEN_REQUEST_URL`, and `ACTIONS_ID_TOKEN_REQUEST_TOKEN` are present. In that mode, project id resolution is `--project`, then `manifest.project_id`, then the local active project if present, then `RUN402_PROJECT_ID`.

### ci
- `run402 ci link github [--project <id>] [--manifest <path>] [--repo <owner/repo>] [--branch <name> | --environment <name>] [--repository-id <id>] [--workflow <path>] [--expires-at <iso>] [--route-scope <pattern> ...] [--force]` — create a GitHub Actions OIDC deploy binding and write a workflow
- `run402 ci list [--project <id>]` — list CI bindings for a project
- `run402 ci revoke <binding_id>` — revoke a binding

`link github` requires a local allowance because it signs the delegation. The generated workflow does not require an allowance file or service key in GitHub; it uses GitHub's OIDC token with `id-token: write`. Use repeatable `--route-scope` only when CI should deploy route declarations; no scopes means no CI route authority.

### transfer (unified project transfer — wallet + email + owned-org recipient v1.96+)
One noun, three recipient kinds: wallet = two-party SIWX, completed by `accept`; email = email->org, completed by `claim`; owned org = `--to-org <org_id>` immediate same-actor org move. Same `/projects/v1/:id/transfers`; preview/list/cancel are kind-agnostic; rows carry `recipient_kind`. Pre-v1.93 `/handoffs` and `--handoff(s)` are gone.
- `run402 transfer init (--to <wallet|email> | --to-org <org_id>) [--project <id>] [--billing-policy migrate] [--message <text>] [--kysigned <record_id>] [--retain-collaborator developer]` — owner/admin initiate. `--to` routes by kind. `--to-org`: caller must actively own source+destination org; success completes immediately with accepted result + project keys. `--retain-collaborator developer`: email recipients only, only `developer`, rejected with `BAD_FLAG` on wallet/org rails; recipient must accept at claim; omit = full severance. `--billing-policy`/`--kysigned` wallet-only; email/org reject. Codes: `INVALID_RETAIN_ROLE`, `RETAIN_SUBJECT_REQUIRED`.
- `run402 transfer preview <transfer_id>` — fetch the preview document (any party; kind-agnostic). Lists custom domains, subdomains, function names, secret NAMES (never values), CI bindings that will be revoked on completion, mailbox summary, billing implications, and — on email transfers — the `retain_collaborator` offer.
- `run402 transfer list [--incoming | --outgoing] [--limit N] [--offset N]` — `--incoming` (default) shows transfers OFFERED TO you; `--outgoing` shows transfers you initiated. Pending rows are unioned and each entry carries `recipient_kind` and `preview_path`.
- `run402 transfer accept <transfer_id>` — accept WALLET transfer. Atomically flips ownership, revokes previous owner CI bindings, stamps `secrets_rotation_advised`. Secret values inherited; response has `secret_names_inherited[]`, new owner `anon_key` + `service_key`; SDK/CLI persist keys and set project active.
- `run402 transfer claim <transfer_id> [--into <organization_id>] [--accept-retained-collaborator]` — claim EMAIL transfer into owned org; omit `--into` to create new org. Email analog of `accept`. `--accept-retained-collaborator` accepts retained developer offer from preview; omit = severance. Result includes `retained_collaborator_principal_id|null`, keys persisted + project active. Keys derive from `project_id` and do not rotate; rotate inherited secrets with `run402 secrets set`.
- `run402 transfer cancel <transfer_id> [--reason <text>]` — cancel a pending transfer of any kind (any authorized party).

Pending transfer: 72h TTL; owner-side mutations return `409 PROJECT_HAS_PENDING_TRANSFER` with `details.transfer_id` + cancel `next_actions[]`. Data-plane and payment routes keep serving; `transfer cancel` unblocked. After accept/claim, rotate inherited secrets; `secrets_rotation_advised` clears after every inherited name is rewritten.

Does not transfer: tier lease (stays with original org; no proration), KMS signers, GitHub repo ownership, on-chain balances. Wallet transfers only support `--billing-policy migrate`; if recipient lacks active org, accept -> `409 RECIPIENT_ORGANIZATION_NOT_ACTIVE`. Email/owned-org always migrate; do not pass `--billing-policy`.

### org / grants (v1.77+ org-owned control plane; first-class orgs v1.82)
Wallet authenticates; org owns projects. Authorization = org role (`owner > admin > developer > billing > viewer`) or per-project grant, never `wallet == signer`. Member/invite changes require active `owner`; subresources: `org member ...`, `org invite ...`; memberships carry `org_id` + `display_name`. Create/rename/member/invite are step-up gated for control-plane sessions.
- `run402 org create [--name <label>]` — create an empty org on the prototype tier; you become owner. `--name` is an optional free-text label (non-unique, not an id; no tier input). Response includes `tier`, `lease_started_at`, and `lease_expires_at`. The soft per-owner free-org cap may return `FREE_ORG_OWNER_LIMIT_EXCEEDED`.
- `run402 org get <org>` — read one org: `{ org_id, display_name, tier, lease_started_at, lease_expires_at, role }`. Any active member; a non-member (incl. a guessed id) gets the same non-revealing 403.
- `run402 org rename <org> <display_name>` (or `--clear`) — owner-only; set or clear the org's free-text label. Response includes `tier`, `lease_started_at`, and `lease_expires_at`.
- `run402 org whoami` — resolve your control-plane principal + org memberships (GET `/agent/v1/whoami`). The REMOTE identity; for local wallet/profile state use `run402 status`.
- `run402 org list` — orgs you are a member of (`org_id`, `display_name`, role, status each).
- `run402 org audit <org> [--limit N] [--before <cursor>]` — control-plane audit trail for the org (admin+); newest-first, page with `--before`.
- `run402 org member list <org>` — members + roles of an org.
- `run402 org member add <org> <wallet> [--role <role>]` — add a member BY WALLET (a new wallet is provisioned as a `human` principal); `--role` defaults to `developer`.
- `run402 org member role <org> <principal_id> <role>` — change a member's role.
- `run402 org member rm <org> <principal_id>` — revoke a member.
- `run402 org invite list <org>` — pending email invites.
- `run402 org invite create <org> <email> [--role <role>] [--ttl-hours N]` — invite a person by email; `--role` defaults to `developer`. The invite is **claimed automatically** when the recipient first signs in via that verified email (`run402 operator login --loopback`, or any hosted email/OAuth login) — it then surfaces as an active membership in the login output and `org member list`. There's no invitee-side "accept" step. Owner/admin invites only claim once the recipient has enrolled a passkey; lower roles claim on any login.
- `run402 org invite rm <org> <principal_id>` — revoke a pending invite.
- `run402 grants create <project_id> <wallet> <capability> [--policy <json>] [--expires <iso8601>]` — issue a per-project capability grant (e.g. `deploy`, `functions:write`) to an agent/CI principal. Requires owner of the project's org.
- `run402 grants revoke <project_id> <grant_id>` — revoke a grant.

`org member role`/`org member rm` that would drop the org's only active owner fail with `409 LAST_OWNER` — promote another member to `owner` first. Principal ids (`prn_…`) come from `run402 org member list`.

### functions
Node 22 runtime. Must export `default async (req: Request) => Response`.
Built-in helper: `import { auth, db, adminDb, email, ai, assets } from '@run402/functions'`
- `auth.user()` — `Actor | null`; taints cache bypass. `Actor` = `{ id, projectId, sessionId, email, emailVerified, authTime, amr, amrTimes }`; `id`, not `userId`. Hallucinated names (`getUser`, `getSession`, `currentUser`, `getServerSession`, `auth.protect`, `auth.signIn`, `auth.logout`, …) throw `R402_AUTH_UNKNOWN_EXPORT` and fail `run402 doctor` deploy scan.
- `auth.requireUser()` — `Actor`. 303 → `/auth/sign-in?returnTo=` (HTML) or 401 envelope (JSON) on anonymous. Don't catch — the platform handles redirect-vs-envelope automatically.
- `auth.requireRole<const R>(role: R)` / `auth.requireMembership<const M>(m: M)` — gate helpers; imply `requireUser`; return `{ user, role }` / `{ user, membership }`. Always read fresh server-side grant state (no positive cache, so revocation is instant across tasks).
- `auth.requireFresh({ maxAge, amr? })` — per-AMR step-up. Reads `Actor.amrTimes`; a recent password proof does NOT satisfy `{amr: ["passkey"]}`.
- `auth.fetch(input, init?)` — same-origin-only fetch with synchronous URL validation; `redirect: "manual"` default; never forwards cookies or actor headers across origin hops.
- `auth.csrfToken()` / `auth.csrfField()` — double-submit token for hosted forms (renders `<input type="hidden" name="_csrf" value="...">`).
- `auth.sessions.createResponseFromIdentity({ provider, subject, proof, amr, createUser? })` — custom identity proof bridge. Platform verifies the proof end-to-end; raw-userId session minting is NOT in the public API.
- `auth.sessions.endResponse()` — sign-out: revokes the active session row + returns Set-Cookie clear.
- `auth.identities.link({ provider, subject, proof })` — atomic nonce consumption + identity INSERT; 409 R402_AUTH_IDENTITY_LINK_CONFLICT on duplicate.
- `db(req?)` — caller-context DB client. In SSR with verified actor, mints 60s actor JWT (`sub`, `project_id`, `session_id`, `authz_version`) so `run402.current_user_id()` works in RLS. Routes `/rest/v1/*`. Default choice; RLS handles current-user filters. `.eq("user_id", user.id)` deploy-fails with `R402_AUTH_REDUNDANT_USER_FILTER` unless annotated `// run402-allow-user-filter:`.
- `adminDb()` — BYPASSRLS using `service_key`; routes `/admin/v1/rest/*` (gateway rejects `role=service_role` on `/rest/v1/*`). Use only when function acts as platform: audit logs, webhooks, cron cleanup.
- `getUserId(req)` / `getRole(req)` — v1.51 function-level gate header readers (`x-run402-user-id` / `x-run402-user-role`), distinct from v3.0 `auth.*` cookie sessions. Removed as bare exports; importing from `@run402/functions` throws `R402_AUTH_UNKNOWN_EXPORT`. Use `auth.*` or read headers manually.
- `email.send(opts)` — send email from the project's mailbox (see email section below)
- `ai.generateImage({ prompt, aspect? })` — live image generation from deployed functions using project billing authority, not local allowance/x402 signing. Aspects: `square`, `landscape`, `portrait`; result: `{ image, content_type, aspect }`. Add app auth/rate limits before calling it from public routed functions.
- `assets.put(key, source, opts?)` — upload bytes to the project's blob store from inside a deployed function. Uses the same CAS substrate as deploy-time assets. `source` is a string, `Uint8Array`, or `{ content | bytes }` object. Options: `contentType`, `visibility` (`"public"` | `"private"`, default `"public"`), `immutable` (default `true`). Returns an `AssetRef` with `url`, `immutableUrl`, `cdnUrl`, `sha256`, `size_bytes`, etc. (camelCase aliases included). Use for user-uploaded content, generated images, runtime-produced files.
- `assets.fromRef(raw)` (v2.7+) — local rehydrate stored AssetRef JSONB into typed shape with camelCase aliases + variants. Store full `AssetRef` from `r.assets.put` in JSONB; variant SHAs/immutable URLs cannot be re-derived from `(source_sha,key)`. Tolerates partial legacy inputs; throws only on null/undefined/non-object.
- `getRun402Context(req)` (v2.7+) — reads `x-run402-*` context headers across `Request`/`Headers`/plain objects. Returns `{ requestId, projectId, releaseId, host, locale, defaultLocale }` (`string|null`), same as `Astro.locals.run402`; never throws.

TypeScript types: `npm install @run402/functions@^3` to get full autocomplete for the `auth.*` namespace, `db(req?)`, `adminDb()`, `getRun402Context()`, `email.send()`, `ai.translate()`, `ai.generateImage()`, `assets.put()`, and `assets.fromRef()`. Works in any Node.js/TypeScript project (Astro, Next.js, plain TS). For static site generation, use `adminDb().from()` at build time with `RUN402_SERVICE_KEY` + `RUN402_PROJECT_ID` in your `.env`.

#### db(req).from(table) — caller-context, RLS applies

PostgREST-style queries scoped to the caller's JWT role. Returns a plain array of row objects. Unauthenticated callers resolve to `role=anon` and see only what anon policies allow.

Reads:
- `.select(cols?)` — columns to return (default `"*"`)
- `.eq(col, val)`, `.neq()`, `.gt()`, `.lt()`, `.gte()`, `.lte()` — filters
- `.like(col, pattern)`, `.ilike(col, pattern)` — pattern match
- `.in(col, [values])` — IN clause
- `.order(col, { ascending? })` — sort (default ascending)
- `.limit(n)`, `.offset(n)` — pagination

```
export default async (req: Request) => {
  // Runs with the caller's JWT — RLS decides what they see.
  const myItems = await db(req).from('items').select('title, done').limit(10);
  return new Response(JSON.stringify(myItems), { headers: { 'content-type': 'application/json' } });
};
```

Writes (also return an array of affected rows):
- `.insert(obj | obj[])` — insert one or many rows
- `.update(obj)` — update matched rows (combine with `.eq()`)
- `.delete()` — delete matched rows (combine with `.eq()`)

```
// All three run as the caller — RLS policies decide if the write is allowed.
const created = await db(req).from('items').insert({ title: 'New', done: false });
await db(req).from('items').update({ done: true }).eq('id', 1);
await db(req).from('items').delete().eq('id', 1);
```

Column narrowing works with writes: `.insert({...}).select('id, title')` returns only those columns.

#### adminDb().from(table) — BYPASSRLS, opt-in

Identical fluent surface to `db(req).from(...)` but uses the service_key. Returns all rows regardless of RLS. Use for server-side work where the function itself is the principal.

```
// Audit log — must capture every event regardless of who called the function.
await adminDb().from('audit_log').insert({ event: 'payment_succeeded', user_id: userId });

// Cron cleanup — no caller context.
await adminDb().from('sessions').delete().lt('expires_at', new Date().toISOString());
```

#### adminDb().sql(query, params?) — raw SQL, always BYPASSRLS

Returns `{ status, schema, rows, rowCount }`.
- SELECT: `rows` = matching rows, `rowCount` = row count
- INSERT/UPDATE/DELETE: `rows` = `[]`, `rowCount` = affected rows
- Parameterized: `adminDb().sql('SELECT * FROM t WHERE id = $1', [42])`

```
const result = await adminDb().sql('SELECT * FROM users WHERE active = true');
// { status: "ok", schema: "p0001", rows: [{ id: 1, name: "Alice" }], rowCount: 1 }
const rows = result.rows;
```

`db` is a request-scoped function. Use `db(req).from(...)` for caller-context RLS or `adminDb().from(...)` / `adminDb().sql(...)` for service-key work.

#### Calling functions from the browser

Functions are accessible via HTTP at `https://api.run402.com/functions/v1/<name>`. This direct invoke path remains API-key protected even when apply-v1 web routes expose browser paths to the same function. Use the project's `anon_key` as the `apikey` header. For authenticated calls, also pass the user's `access_token`:

```javascript
const res = await fetch('https://api.run402.com/functions/v1/my-function', {
  method: 'POST',
  headers: {
    apikey: ANON_KEY,
    Authorization: 'Bearer ' + session.access_token,  // optional, for authenticated calls
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({ key: 'value' })
});
```

- `run402 functions deploy <id> <name> --file <file> [--deps "<spec,...>"] [--timeout <s>] [--memory <mb>]` — for triggered background work, prefer `run402 deploy apply --manifest` with `functions.replace.<name>.triggers[]` so schedule ticks and email events create durable function runs.
- `run402 functions invoke <id> <name> [--body '<json>'] [--method <GET|POST|...>] [--raw]` — default emits a JSON envelope `{ http_status, body, duration_ms }` (HTTP status surfaced as `http_status` to avoid colliding with the reserved top-level `status` sentinel on stderr). Safe to pipe to jq even when the function returns `text/plain`. `--raw` skips the envelope: string body → text + newline, JSON body → pretty-printed JSON. Useful when piping a CSV / binary-blob response straight to a file.
- `run402 functions logs <id> <name> [--tail <n>] [--since <iso-timestamp>] [--request-id <req_...|fnrun_...|fnatt_...>] [--follow]` — `--tail` defaults to 50 and is capped at 1000. Non-follow mode emits a single `{ logs: [...] }` JSON object; `--follow` mode emits **NDJSON** (one log entry per line) so streaming consumers can parse incrementally without a wrapping envelope.
- `run402 functions runs create <id> <name> --event-type <type> --idempotency-key <key> [--payload-json <json-object>] [--delay <10m|1h|3d> | --run-at <iso>] [--expires-at <iso> | --expires-after <duration>] [--retry-preset standard] [--max-attempts <n>] [--wait]` — creates a durable function request. The idempotency key is required; reuse it when retrying the same logical work item.
- `run402 functions runs <list|get|logs|cancel|redrive> ...` — list runs by function, fetch one `fnrun_...`, fetch correlated logs, cancel queued/scheduled work, or redrive a terminal run. `redrive` accepts retry options and `--wait`. All outputs are JSON by default.
- `run402 functions update <id> <name> [--timeout <s>] [--memory <mb>]` — background triggers are declarative through ReleaseSpec `triggers[]`; the legacy schedule flags remain only for old simple-function surfaces.
- `run402 functions rebuild <id> <name>` / `run402 functions rebuild <id> --all` — opt-in refresh of a deployed function onto the platform's current runtime/entry-wrapper. Re-bundles from the **stored source** with deps pinned to the recorded exact versions, so the source `code_hash` is unchanged and no new release is created — only the platform wrapper/runtime changes. This is how a gateway-side wrapper fix (e.g. an SSR `auth.*` fix) reaches an already-deployed function: a plain redeploy with unchanged source does **not** pick it up. Single returns `{ name, rebuilt, old_fingerprint, new_fingerprint, runtime_version_before, runtime_version_after, code_hash }`; `--all` returns `{ rebuilt_count, total, results: [...] }` where each result is a rebuild record or `{ name, rebuilt: false, code?, error }`. Functions deployed before dependency locking return `CANNOT_REBUILD_UNLOCKED_DEPS` (HTTP 409 for single, a per-function entry for `--all`) — redeploy them from source instead. Wallet-authed; allowed during billing grace (`past_due` / `frozen` / `dormant`).
- `run402 functions <list|delete> <id> [<name>]`

`run402 doctor` surfaces a `runtime_staleness` check (warning) listing any deployed functions on an older platform runtime, with the `run402 functions rebuild --all` remediation. Staleness is read-only — observing it never mutates a function.

For routed browser 500s, copy `X-Run402-Request-Id` or the JSON `request_id` from the response and run `run402 functions logs <project> <function> --request-id req_...`. `--since` is validated locally and should be supplied for incidents older than the default recent lookup window.
For durable runs, pass the run id or attempt id as the same filter: `--request-id fnrun_...` or `--request-id fnatt_...`.
`--tail` must be a positive safe integer no larger than 1000, and `--request-id` must match `req_...`, `fnrun_...`, or `fnatt_...`.

#### --deps semantics, runtime_version, deps_resolved

`--deps` is a comma-separated list of npm specs that the gateway installs and bundles into the function zip alongside the user code:
- Bare names (`lodash`) resolve to the latest published version at deploy time.
- Pinned (`lodash@4.17.21`) and range (`date-fns@^3.6.0`) specs are honored verbatim.
- Entries are trimmed; empty entries e.g. `--deps "lodash,,date-fns"` are rejected locally.
- `@run402/functions` (auto-bundled) and the legacy `run402-functions` name are rejected.
- Limits: max 30 entries, max 200 chars per spec.
- Native binary modules (sharp, canvas, native bcrypt, etc.) are rejected.

`run402 functions deploy` routes through the unified apply engine, so its **result** sets `runtime_version` and `deps_resolved` to `null` (apply returns release-level data, not per-function build metadata). Read the resolved values from `run402 functions list` (and `update`), whose records carry both fields populated under bundling-at-deploy:
- `runtime_version` — the bundled `@run402/functions` version (e.g. `"1.48.0"`). Surface this as "Functions runtime version" — never bare "runtime", which already names the Node runtime (e.g. `node22`). `null` for legacy functions.
- `deps_resolved` — map of each `--deps` name to the -installed concrete version (e.g. `{"date-fns": "3.7.0"}` for a `^3.6.0` spec). Direct deps only; this is not a lockfile. `{}` for an empty `--deps`; `null` for legacy functions.

The deploy result still includes an optional top-level `warnings: string[]` (sibling to the function record, not inside it) for non-fatal deploy notes e.g. bundle-size advisories. Omitted or `[]` when there are no warnings.

#### Function authoring limits by tier

| | Prototype | Hobby | Team |
|---|---|---|---|
| Max timeout | 10s | 30s | 60s |
| Max memory | 128 MB | 256 MB | 512 MB |
| Max scheduled triggers | 1 | 3 | 10 |
| Min interval | 15 min | 5 min | 1 min |

`run402 deploy apply` preflights literal unified-deploy function specs against these caps before plan/upload when the values are known. Gateway validation remains authoritative; `run402 tier status` includes live function caps and current scheduled usage when returned.

Secrets available as `process.env` (see secrets below).

### secrets
Injected as `process.env` in functions. Values are write-only — `list` returns keys and timestamps only, never values or value-derived hashes. Prefer `--file` or `--stdin` for real values so they do not land in shell history. `--file -` and `--file /dev/stdin` read stdin too.

- `run402 secrets set <id> <KEY> [<VALUE>] [--file <path>|--stdin]`
- `run402 secrets <list|delete> <id> [<KEY>]`

### jobs
Platform-managed jobs. This is not arbitrary Docker execution: submit a gateway-shaped request for a run402-configured `job_type`, then inspect status/logs, cancel one run, or purge all project runs. The SDK supplies the required idempotency header; the CLI does not expose it.

- `run402 jobs submit --file job.json [--project <id>]`
- `run402 jobs submit --stdin [--project <id>]`
- `run402 jobs get <job_id> [--project <id>]`
- `run402 jobs logs <job_id> [--project <id>] [--tail <n>] [--since <iso-timestamp>]`
- `run402 jobs cancel <job_id> [--project <id>]`
- `run402 jobs purge [--project <id>]`
- `run402 jobs artifacts get <job_id> <file> --output <path> [--project <id>]`

Submit request shape:

```json
{
  "job_type": "example.managed_job.v1",
  "input": { "input_json": {} },
  "max_cost_usd_micros": 50000
}
```

Artifacts: when a job completes, `jobs get` returns an `artifacts` map keyed by
filename. Each value is an object — `{ "url", "content_type", "sha256",
"size_bytes" }` — not a bare ref string (the old, never-resolvable
`run402://storage/...` scheme was retired). `sha256`/`size_bytes` are omitted
for jobs created before this change; the `url` still serves. Download the bytes
with `run402 jobs artifacts get <job_id> <file> --output <path>` (auth is the
project service key, same as the rest of the jobs API). Discover recorded
filenames from the `artifacts` map; a 404 means the job has not completed or
the filename was not recorded for that run.

### assets (primary storage API)

Direct-to-S3 asset storage, 1 byte to 5 TiB. Flat key namespace per project; renamed from `blob` in v2.0.

Bulk directories: use `deploy apply` with `assets` slice: additive `assets: { put: [...] }`; declarative sync `assets: { put: [...], sync: { prefix, prune: true, confirm? } }`. No `run402 assets sync`; apply is canonical so HTML + asset URLs stage atomically.

- `run402 assets put <file> [files...] [--project <id>] [--key <dest>] [--content-type <mime>] [--private] [--immutable] [--meta <k=v>] [--exif-policy keep|strip] [--concurrency N] [--no-resume] [--stream]` — without `--stream`, stdout is the final results array (JSON). With `--stream`, stdout is NDJSON per-file progress events. `--json` is a deprecated alias for `--stream` (writes a deprecation warning to stderr).
- `run402 assets get <key> --output <file> [--project <id>]`
- `run402 assets ls [--project <id>] [--prefix <p>] [--limit <n>] [--sort key:asc|createdAt:asc|createdAt:desc] [--filter <k=v> ...]`
- `run402 assets rm <key> [--project <id>]`
- `run402 assets sign <key> [--project <id>] [--ttl <seconds>]` — signed URL TTL must be an integer from 60 to 604800 seconds.
- `run402 assets diagnose <url> [--project <id>]` — inspect live CDN state for a public URL
- `run402 cdn wait-fresh <url> --sha <hex> [--timeout <secs>] [--project <id>]` — poll a mutable URL until it serves the expected SHA-256

`put` flags (v1.50):
- `--meta key=value` repeatable; coercion: numeric-looking -> number, `true|false` -> boolean, comma -> `string[]`, else string. Serialized total <=4 KB; no nested objects; invalid -> `INVALID_ASSET_METADATA`.
- `--exif-policy keep|strip`; default `keep`; `strip` removes EXIF bytes + `image_exif`; invalid -> `INVALID_EXIF_POLICY`.

`ls` flags (v1.50):
- `--sort key:asc|createdAt:asc|createdAt:desc` — result ordering. Default `key:asc` (legacy bare-key cursor). The `createdAt:*` variants use a base64url JSON `{s, ts, key}` cursor; reusing a cursor across sort keys returns `400 INVALID_CURSOR_FOR_SORT`.
- `--filter key=value` — repeatable media-picker filter. Allowed keys: `uploaded_by`, `tag`, `format`, `is_image` (`true`/`false`), `min_width`, `max_width`, `min_height`, `max_height` (non-negative ints). Unknown keys are rejected client-side with `INVALID_FILTER_KEY`.

Examples:

```
run402 assets put ./artifact.tgz --project prj_abc123
run402 assets put ./hero.jpg --project prj_abc123 --meta uploaded_by=agent_abc --meta version=3 --meta tags=hero,banner --exif-policy strip
run402 assets put ./dist/**/*.png --project prj_abc123 --key assets/
run402 assets put ./asset --project prj_abc123 --key assets/logo --content-type image/svg+xml
run402 assets put huge.bin --project prj_abc123 --immutable
run402 assets get images/logo.png --output /tmp/logo.png --project prj_abc123
run402 assets ls --project prj_abc123 --prefix images/
run402 assets ls --project prj_abc123 --sort createdAt:desc --filter is_image=true --filter min_width=320 --filter format=webp
run402 assets ls --project prj_abc123 --filter uploaded_by=agent_abc --filter tag=hero
run402 assets diagnose https://app.run402.com/_blob/avatar.png --project prj_abc123
run402 cdn wait-fresh https://app.run402.com/_blob/avatar.png --sha ba78... --timeout 120
```

`put` response (`AssetRef`):

```js
const asset = await client.assets.put(projectId, key, { bytes });  // v1.45 defaults to immutable: true
html += asset.scriptTag();             // <script src=... defer integrity=... crossorigin></script>
html += asset.linkTag();               // <link rel="stylesheet" href=... integrity=... crossorigin>
html += asset.imgTag("Company logo");  // <img src=... alt="Company logo" width=... height=... loading="lazy" decoding="async">
html += asset.imgTagWithSrcSet({ alt: "Hero", sizes: "(max-width: 800px) 100vw, 1920px" });
// → <picture><source type="image/webp" srcset="<thumb> 320w, <medium> 800w, <large> 1920w" sizes="…">
//             <img src="<display_url>" alt="Hero" width="…" height="…" loading="lazy" decoding="async"></picture>
```

`immutable: true` default since v1.45. SDK/CLI compute SHA-256; gateway returns content-addressed URL + SRI. Immutable URL needs no invalidation/redeploy fix/`cdn wait-fresh`. Use `{ immutable: false }` only for mutable URL/cache semantics; tag emitters throw without immutable URL/SRI. Emitters include `defer`, `loading="lazy"`, `decoding="async"`.

AssetRef fields:
- `cdnUrl` — content-addressed emitter URL, `https://pr-<public_id>.run402.com/_blob/<key-without-ext>-<8hex>.<ext>`, CDN v1.33, guaranteed reachable.
- `cdnMutableUrl` — mutable auto-subdomain URL; eventual consistency; prefer `cdnUrl`.
- `url` / `immutableUrl` — preferred-host forms on claimed/custom domain; currently not CDN-served; use for direct API consumers, not `<script>`/`<img>`.
- `etag` — strong `"sha256-<hex>"` ETag (when `immutable`).
- `sri` — `sha256-<base64>` for `<script integrity={sri}>` if you must construct tags by hand.
- `contentDigest` — RFC 9530 `sha-256=:<base64>:` for HTTP integrity.
- `cacheKind` — `"immutable" | "mutable" | "private"`.
- `cdn.{version,invalidationId,invalidationStatus,ready,hint}` — CloudFront invalidation envelope; `cdn.ready === true` for immutable uploads.

Image variants (v1.49+ gateway, `@run402/sdk@2.3.0+`, image MIME >=320x320):
- `width_px`, `height_px`: post-EXIF display dims; `imgTag` emits width/height to avoid CLS.
- `blurhash`: ~30-byte LQIP; decode with `blurhash` npm package.
- `variant_spec_version`: URL identity tied to encoder generation; bumps create new URLs without invalidating old.
- `display_url` / `display_immutable_url`: browser-displayable; jpeg/png/webp/avif = `cdn_url`; HEIC/HEIF -> JPEG `display_jpeg`, original bytes preserved in CAS. `imgTag`/`imgTagWithSrcSet` default `<img src>` to `display_url`.
- `variants.thumb|medium|large`: WebP 320w/800w/1920w with `url`, `cdn_url`, `width_px`, `height_px`, `format`, `sha256`; use `variants.thumb.cdn_url` for grids.
- `variants.display_jpeg`: HEIC/HEIF only, full-res JPEG quality 90 sRGB.
- `thumbUrl` / `displayUrl` SDK conveniences (v2.3+): `thumbUrl = variants.thumb.cdn_url ?? displayUrl`, `displayUrl = display_url ?? cdn_url`; `undefined` for non-images.
- `imgTagWithSrcSet(opts)` emits WebP `<picture>` + `display_url` fallback; throws on missing `opts.sizes` or missing `variants`; use `imgTag()` when no variants. AVIF deferred.
- `r.assets.put(...)` and `r.project(id).apply({ assets: { put: [...] } })` produce identical `AssetRef` shape.
- Encoder errors: 422 `IMAGE_DECODE_FAILED`, 413 `IMAGE_INPUT_TOO_LARGE` (>40 MP or >12000 px any axis), 504 `IMAGE_ENCODE_TIMEOUT`, 429 `TOO_MANY_ENCODES_QUEUED` (retry after 2s).

Metadata/EXIF/intrinsics (v1.50+ gateway, `@run402/sdk@2.4.0+`; flat shape, not `image:{}`):
- `metadata`: flat `string | number | boolean | string[]`, <=4 KB serialized, `null` if absent; nested invalid client-side `INVALID_ASSET_METADATA`.
- `image_format`: `jpeg|png|webp|avif|heic|tiff|svg|bmp`, `null` non-image.
- `image_info`: `has_alpha`, `color_space`, `animated`, `frame_count`, `bit_depth`, `orientation`; `null` non-image; future keys opaque.
- `image_exif`: EXIF block; `null` non-image, stripped, or formats without EXIF.
- `image_exif_policy`: `"keep"` default or `"strip"`; `null` non-image.

Shape contract (v1.54+ gateway, `@run402/sdk@2.12.0+`, atomic with variants):
- `blurhash_data_url`: pre-decoded PNG data URL (~600-1200 bytes at 16x16); embed as placeholder background; `null` only decoder failed; absent pre-v1.54.
- `asset_schema`: highest satisfied shape contract (`"v1.49" | "v1.50" | "v1.54" | null`); `null` = partial shape; absent pre-v1.54. Strict consumers skip legacy rows without per-field branching.
- Enables `@run402/astro@1.0+` `<Run402Image>`: pre-decoded placeholder + WebP ladder `<picture>` + width/height, optional `imageDefaults.strict: { onSchema: ">=v1.49" }`; Astro + React output byte-identical.

Typed errors a caller can branch on (`catch (e) { if (e.code === "...") }`):
- `INVALID_ASSET_METADATA` (HTTP 400 or `LocalError` pre-network)
- `INVALID_EXIF_POLICY` (HTTP 400 or `LocalError` pre-network)
- `INVALID_FILTER_KEY` (HTTP 400 or `LocalError` pre-network)
- `INVALID_SORT` (HTTP 400 or `LocalError` pre-network)
- `INVALID_CURSOR_FOR_SORT` (HTTP 400 — cross-sort cursor reuse)
- `IMAGE_DECODE_FAILED` (HTTP 422 — no partial row written)

Mutable URL loop only: `run402 cdn wait-fresh <mutable-url> --sha <new-sha>` blocks until CDN serves new SHA. Do not use on immutable URLs.

Resume removed in v2.1.0. CLI delegates to `sdk.assets.put` via unified apply (`apply/v1/plans -> content/v1/plans -> S3 PUT -> commit`). `--concurrency` / `--no-resume` accepted but ignored; resume semantics live at apply-plan level (24h TTL).

Private blobs (`--private`): no CDN URL returned; read via authenticated gateway path `GET /storage/v1/blob/<key>` with apikey, or via `run402 assets sign` for time-boxed external sharing.

Content-Type: infers MIME from destination key extension; use `--content-type <mime>` for extensionless/uncommon/override; applies to every file in invocation.

`diagnose` exit codes: 0 when CDN serves expected SHA, 1 otherwise; `until run402 assets diagnose <url>; do sleep 1; done` waits. Probe vantage single-region us-east-1; stderr caveat `# probed once from gateway-us-east-1; not a global view`.

#### Uploading from Node/agent code

```javascript
import { run402, dir } from "@run402/sdk/node";

const client = run402();

// Single key — bytes/string source.
const asset = await client.assets.put(projectId, "uploads/report.pdf", { bytes });
// asset.cdnUrl is the preferred content-addressed URL for public blobs.

// Whole directory in one apply (atomic with site/functions/secrets if combined).
const manifest = await client.assets.uploadDir("./assets", {
  project: projectId,
  prefix: "static/",
});
console.log(manifest.byKey["static/logo.png"].cdn_url);

// Or as part of a release apply (assets promote inside the same activation
// transaction that flips live_release_id).
await (await client.project(projectId)).apply({
  project: projectId,
  assets: { put: [{ key: "static/logo.png", source: bytes }] },
  site: dir("./dist"),
});
```

### sites
- `run402 sites deploy --manifest <file> [--project <id>]`
- `run402 sites deploy-dir <path> [--project <id>] [--quiet] [--dry-run] [--confirm-prune]`

`--project` defaults to the active project. Manifest: `{"files":[{"file":"index.html","data":"..."},{"file":"style.css","data":"..."}]}`. Must include `index.html`. Free with active tier. If the project already has a subdomain, redeploying auto-reassigns it to the new deployment (response includes `subdomain_urls`).

To inspect deploy status, use `run402 deploy events <operation_id>` or `run402 deploy list --project <id>` instead of polling a deployment artifact.

CAS-backed transport: Both `sites deploy` and `sites deploy-dir` hash each file locally and only PUT bytes the gateway doesn't already have. Re-deploying an unchanged tree returns immediately with `bytes_uploaded: 0`.

Dry-run: `run402 sites deploy-dir ./dist --project prj_... --dry-run` calls the gateway's `POST /apply/v1/plans?dry_run=true`, prints `{status:"ok", dry_run:true, plan_id:null, operation_id:null, manifest_digest, diff, warnings, expected_events, missing_content_count}`, and exits without uploading bytes or committing a release. Use it to preview the server-authoritative plan/diff envelope.

Progress events: `sites deploy` and `sites deploy-dir` stream unified `DeployEvent` JSON lines to stderr by default; the final result payload (release/deployment metadata, no `status` wrapper) still goes to stdout. Pipe streams separately: `run402 sites deploy-dir ./dist --project p > result.json 2> events.log`. Pass `--quiet` to suppress events (stdout still gets the result payload).

### subdomains
- `run402 subdomains claim <name> [--deployment <id>] [--project <id>]`
- `run402 subdomains list [--project <id>]`
- `run402 subdomains delete <name> --confirm [--project <id>]` — `--confirm` required (irreversible release).

All options default to the active project. `claim` also defaults to the project's last deployment. Names: 3-63 chars, lowercase alphanumeric + hyphens. Creates `<name>.run402.com`.

Subdomain auto-reassignment: You only need to `claim` a subdomain once. Every subsequent `run402 sites deploy` or `run402 deploy` to the same project automatically updates the subdomain to point to the new deployment. The response includes `subdomain_urls` showing which subdomains were reassigned. No need to re-claim after each deploy.

### domains
- `run402 domains add <domain> <subdomain_name> [--project <id>]`
- `run402 domains list [--project <id>]`
- `run402 domains status <domain> [--project <id>]`
- `run402 domains delete <domain> --confirm [--project <id>]` — `--confirm` required (irreversible release).

Point a custom domain (e.g. `example.com`) at a Run402 subdomain. The human must already own the domain.

**Setup flow:**
1. `run402 domains add example.com myapp` — registers the domain, returns DNS instructions
2. Human configures DNS at their registrar (CNAME to `domains.run402.com`, or ALIAS + TXT for apex domains)
3. `run402 domains status example.com` — poll until status is `active` (DNS propagation ~60s)
4. Traffic to `example.com` now serves the same site as `myapp.run402.com`

When the linked subdomain is redeployed, the custom domain automatically serves the new deployment.

### apps
- `run402 apps browse [--tag <tag>]`
- `run402 apps fork <version_id> <name> [--subdomain <name>] [--bootstrap '<json>']`
- `run402 apps inspect <version_id>`
- `run402 apps publish <id> [--description "..."] [--tags a,b] [--visibility <public|private>] [--fork-allowed]`
- `run402 apps <versions|delete> <id> [<version_id>]`
- `run402 apps update <id> <version_id> [--description "..."] [--tags a,b]`

Forking clones schema, site, and functions into a new project. If the app includes a `bootstrap` function, it runs automatically with the provided variables — use it for first-admin setup, demo data seeding, or app configuration. Response includes `bootstrap_result` (the function's return value) or `bootstrap_error` if it failed. Use `run402 apps inspect` to see what `bootstrap_variables` an app expects.

### image
$0.03 per image.

- `run402 image generate "<prompt>" [--aspect <square|landscape|portrait>] [--output <file>]`

Without `--output`, returns `{"aspect":"...","content_type":"image/png","image":"<base64>"}`.

### ai
Built-in AI helpers. Translation requires the AI Translation add-on on the project. Moderation is free for all projects.

- `run402 ai translate <id> "<text>" --to <lang> [--from <lang>] [--context "<hint>"]` — translate text to a target language (ISO 639-1 codes). Source language auto-detected if `--from` omitted. Context hint guides tone/register (max 200 chars).
- `run402 ai moderate <id> "<text>"` — run content moderation. Returns flagged status and per-category scores.
- `run402 ai usage <id>` — check translation word quota for the current billing period (used, included, remaining).

### email
Max 5 mailboxes/project. Inspect defaults and footer policy with `email mailboxes`; set `default_outbound_mailbox_id` / `auth_sender_mailbox_id` via `email defaults`; set per-mailbox outbound footer policy with `email update --footer-policy run402_transparency|none`. Omit `--mailbox` to use outbound default; branch on `DEFAULT_MAILBOX_REQUIRED` / `DEFAULT_MAILBOX_INVALID` + `next_actions`. `footer_policy=none` requires hobby/team; prototype projects are locked to `run402_transparency` and return `FOOTER_POLICY_TIER_REQUIRED`. Send modes: template or raw HTML; one recipient/send. Rate limits: prototype 10/day, hobby 50/day, team 500/day. Unique recipients/lease: prototype 25 / 200 / 1000.

Run402 Core uses the same CLI after `run402 init --api-base=http://my-core:4020`. The Core operator must configure the gateway outbound provider first; `email mailboxes` surfaces `provider_readiness`, `can_send`, `send_blocked_reason`, and `next_actions` when setup is missing. Core's first slice supports raw outbound mail with attachments; managed templates, inbound reply handling, sender-domain automation, and delivery operations may remain Cloud-only until the Core gateway adds them.

Templates: `project_invite` (project_name, invite_url), `magic_link` (project_name, link_url, expires_in), `notification` (project_name, message max 500 chars).

- `run402 email create <slug> [--project <id>]` — create a project-scoped mailbox local part. The response's `managed_address` is `<slug>@<project-mail-host>.mail.run402.com`; another project may use the same slug. NOT idempotent: a same-project conflict (slug already in use, address in cooldown, or the project already has 5 mailboxes) returns a 409 error rather than an existing mailbox.
- `run402 email mailboxes [--project <id>]` — list mailboxes plus `mailbox_settings`, `address`/`managed_address`, default-role/readiness/footer-policy metadata (`is_default_outbound`, `is_auth_sender`, `can_send`, `can_receive`, `send_blocked_reason`, `domain_kind`, `footer_policy`, `effective_footer_policy`, `footer_policy_locked_reason`), and gateway `next_actions`.
- `run402 email defaults [--outbound <slug|mbx_id>] [--auth-sender <slug|mbx_id>] [--clear-outbound] [--clear-auth-sender] [--project <id>]` — show current defaults with no flags, or set/clear `default_outbound_mailbox_id` and/or `auth_sender_mailbox_id`. Slugs are resolved through `email mailboxes`; SDK PATCH uses mailbox ids.
- `run402 email update [<slug|mbx_id>] --footer-policy <run402_transparency|none> [--mailbox <slug|mbx_id>] [--project <id>]` — set the mailbox's outbound footer policy through `PATCH /mailboxes/v1/:mailbox_id`. The optional positional target and `--mailbox` are equivalent; omit only on single-mailbox projects.
- `run402 email status [--mailbox <slug|id>] [--project <id>]` — show mailbox info (ID, address, slug, footer policy)
- `run402 email send --template <name> --to <email> [--var key=value ...] [--from-name <name>] [--mailbox <slug|id>] [--project <id>]`
- `run402 email send --to <email> --subject <subject> --html <html> [--text <text>] [--attach <path>[:content-type] ...] [--from-name <name>] [--mailbox <slug|id>] [--project <id>]`
- `run402 email list [--direction <inbound|outbound>] [--mailbox <slug|id>] [--project <id>]` — lists BOTH sent + received by default; `--direction inbound` lists received replies (the reconciliation backstop if a reply_received webhook is lost)
- `run402 email get <message_id> [--mailbox <slug|id>] [--project <id>]`
- `run402 email reply <message_id> --html <html> [--text <text>] [--subject <subject>] [--from-name <name>] [--mailbox <slug|id>] [--project <id>]` — reply to an inbound message (threads via In-Reply-To)
- `run402 email get-raw <message_id> --output <file> [--mailbox <slug|id>] [--project <id>]` — fetch inbound raw RFC-822 bytes (DKIM/zk-email). `--output` required; bytes to file, stdout `{ message_id, bytes, output }`. Outbound returns 404.
- `run402 email delete [<slug|mailbox_id>] --confirm [--project <id>]` — delete a mailbox (irreversible). Target a specific mailbox by slug or id; on a project with one mailbox the target may be omitted.
- `run402 email webhooks list [--mailbox <slug|id>] [--project <id>]` — list all webhooks registered on the mailbox
- `run402 email webhooks get <webhook_id> [--mailbox <slug|id>] [--project <id>]` — get webhook details
- `run402 email webhooks delete <webhook_id> [--mailbox <slug|id>] [--project <id>]` — delete a webhook
- `run402 email webhooks update <webhook_id> [--url <url>] [--events <e1,e2>] [--mailbox <slug|id>] [--project <id>]` — update webhook URL and/or events
- `run402 email webhooks register --url <url> --events <e1,e2> [--mailbox <slug|id>] [--project <id>]` — register a new webhook. Valid events: delivery, bounced, complained, reply_received
- `run402 email webhooks deliveries [--status <pending|in_flight|delivered|failed_permanent>] [--mailbox <slug|id>] [--project <id>]` — durable delivery rows. At-least-once with bounded retries/backoff; `failed_permanent` = DLQ. Body envelope `{ id, type, created_at, schema_version, idempotency_key, payload }`; dedupe on `idempotency_key`.
- `run402 email webhooks redrive <delivery_id> [--mailbox <slug|id>] [--project <id>]` — re-queue a dead-lettered (failed_permanent) delivery for another attempt

Raw HTML: `--subject` max 998 chars, `--html` max 1 MB. If `--text` omitted, plaintext auto-generated. `--attach <path>[:content-type]` raw-HTML only, repeatable max 5, <=7 MB total, content-type inferred if suffix omitted. `--from-name` sets From display name. Success may include `mailbox_id`, `from_address`.

Slug rules: 3-63 chars, lowercase alphanumeric + hyphens, no consecutive hyphens. `--project` defaults to the active project.

Functions: `import { email } from '@run402/functions'`; uses project service context + configured outbound default, so set mailbox defaults first:
```js
import { email } from '@run402/functions';

// Template mode
await email.send({ to: "user@example.com", template: "notification", variables: { project_name: "My App", message: "Hello!" } });

// Raw HTML mode
await email.send({ to: "user@example.com", subject: "Welcome!", html: "<h1>Hi</h1>", from_name: "My App" });
```
Throws on rate limit, suppression, missing/invalid default, no mailbox.

### auth
Manage project user authentication: magic links, trusted invites, passwords, passkeys, and auth settings.

- `run402 auth magic-link --email <addr> --redirect <url> [--intent signin|invite|claim|recovery] [--state <value>] [--project <id>]` — send a magic link email
- `run402 auth verify --token <token> [--project <id>]` — exchange a magic link token for access_token + refresh_token
- `run402 auth create-user --email <addr> [--admin <true|false>] [--invite] [--redirect <url>] [--project <id>]` — service-key create/update auth user
- `run402 auth invite-user --email <addr> --redirect <url> [--admin <true|false>] [--project <id>]` — create/update user and send trusted invite
- `run402 auth set-password --token <bearer> --new <password> [--current <password>]` — change, reset, or set password
- `run402 auth settings [--allow-password-set <true|false>] [--preferred <method|null>] [--public-signup <policy>] [--require-admin-passkey <true|false>] [--allowed-email-domains <csv|none>] [--project <id>]` — update auth settings (requires service_key). `--allowed-email-domains` is a comma-separated list restricting hosted Google sign-in to those domains (enforced at token issuance); `none` clears it; empty = unrestricted.
- `run402 auth passkey-register-options --token <bearer> --app-origin <origin> [--project <id>]` — create WebAuthn registration options
- `run402 auth passkey-register-verify --token <bearer> --challenge <id> --response <json> [--label <text>] [--project <id>]` — verify and store passkey registration
- `run402 auth passkey-login-options --app-origin <origin> [--email <addr>] [--project <id>]` — create WebAuthn login options
- `run402 auth passkey-login-verify --challenge <id> --response <json> [--project <id>]` — verify passkey login and return session tokens
- `run402 auth passkeys --token <bearer> [--project <id>]` — list authenticated user's passkeys
- `run402 auth delete-passkey --token <bearer> --id <passkey_id> [--project <id>]` — delete one passkey
- `run402 auth providers [--project <id>]` — list available auth providers
- `run402 auth scaffold-roles [--table <name>] [--user-col <col>] [--role-col <col>] [--roles <csv>] [--cache-ttl <secs>]` — offline generator: emits a role-table migration + `requireRole` gate snippet + first-operator bootstrap (JSON out; no project/network). Pipe through `jq` (e.g. `| jq -r .migration`).

Magic link flow: request → user clicks email link → frontend extracts token → verify → authenticated. Token expires in 15 minutes, single-use. Rate limited: 5 per email/hour, plus per-project limits by tier.

### sender-domain
Manage custom email sender domain. The mailbox primary `address` switches to your domain only after DKIM is verified and inbound is enabled; `managed_address` stays stable.

- `run402 sender-domain register <domain> [--project <id>]` — register domain, returns DNS records to add
- `run402 sender-domain status [--project <id>]` — check verification status (pending/verified)
- `run402 sender-domain remove [--project <id>]` — remove custom domain, revert to the mailbox `managed_address`
- `run402 sender-domain inbound-enable <domain> [--project <id>]` — enable inbound email on custom domain (requires DKIM-verified), returns MX record to add
- `run402 sender-domain inbound-disable <domain> [--project <id>]` — disable inbound email on custom domain

Flow: register → add DKIM CNAME records to DNS → poll status until verified → email auto-sends from your domain.
Inbound (opt-in): inbound-enable → add MX record to DNS → replies to `<slug>@<your-domain>` route through run402.

### billing
Email orgs + Stripe checkouts; pay by card or scale email beyond tier caps.

- `run402 billing create-email <email>` — create an email-based organization (Stripe-only, no wallet). Sends a verification email. Idempotent.
- `run402 billing link-wallet <org_id> <wallet>` — link a wallet to an email organization for hybrid Stripe + x402 access. Response includes a `pool_implications` block (organization `tier`, `projects_in_pool_count`, `organization_api_calls_current`, `organization_storage_bytes_current`, `tier_limits`, `over_limit`) — inspect `over_limit` before linking a wallet whose usage might push the merged pool past the tier cap.
- `run402 billing checkout <org-id | wallet | email> --product tier --tier <prototype|hobby|team>` — subscribe/renew/upgrade a tier via Stripe (hobby $5 / team $20; prototype is free on testnet — use `run402 tier set prototype`, not a Stripe charge). Returns a checkout URL.
- `run402 billing checkout <org-id | wallet | email> --product email-pack` — buy a $5 email pack (10,000 emails, never expire). Returns a Stripe checkout URL.
- `run402 billing checkout <org-id | wallet | email> --product balance-topup --amount <usd_micros>` — add cash credit to the organization. Returns a Stripe checkout URL.
- `run402 billing auto-recharge <org_id> <on|off> [--threshold <n>]` — auto-repurchase $5 packs when credits drop below threshold. Requires saved Stripe payment method.
- `run402 billing balance <org-id | wallet | email>` — balance + email_credits_remaining + tier + lease + auto_recharge state (response includes `organization_id`). A wallet/email is resolved to its organization via `GET /orgs/v1/lookup?wallet=|?email=`; an organization id (UUID) reads `GET /orgs/v1/:org_id/billing` directly.
- `run402 billing history <org-id | wallet | email> [--limit <n>]` — ledger history. Keyed by organization id: a wallet/email is resolved to its `organization_id` first, then `GET /orgs/v1/:org_id/billing/history`.

Auth: `balance`/`history` require SIWX from linked wallet or admin; wallet lookup requires matching SIWX (email lookup admin-only). `link-wallet` requires body wallet SIWX/admin; `checkout`/`auto-recharge` require linked wallet SIWX/admin. CLI signs from local allowance, so allowance wallet must belong to queried/linked/billed org. Non-member/guessed org id -> 403 no existence leak. `create-email` unauthenticated.

Email packs only activate when the tier daily limit is exhausted AND the project has a verified custom sender domain (spam protection for Run402-managed mail reputation).

### contracts
KMS signers — provision AWS KMS-backed Ethereum signers per project for signing and broadcasting smart-contract transactions. Private keys never leave KMS. **Pricing: $0.04/day rental + $0.000005 per call**. Signer creation requires $1.20 in cash credit (30 days of rent). Non-custodial — see https://run402.com/humans/terms.html#non-custodial-kms-wallets.

- `run402 contracts provision-signer --chain <base-mainnet|base-sepolia> [--recovery-address 0x...]` — provision a KMS signer ($0.04/day rental, requires $1.20 in cash credit at creation). Prompts for confirmation if the project already has ≥1 active signer.
- `run402 contracts get-signer <signer_id>` — get signer metadata + live native balance + USD value (free)
- `run402 contracts list-signers` — list all signers owned by the project, including deleted ones (free)
- `run402 contracts set-recovery <signer_id> [--address 0x... | --clear]` — set/clear the optional recovery address used for auto-drain on day-90 deletion (free)
- `run402 contracts set-alert <signer_id> --threshold-wei <n>` — set the low-balance alert threshold (free; alerts billed via existing email infra)
- `run402 contracts call <project_id> <signer_id> --to 0x... --abi <json> --fn <name> --args <json> [--value-wei <n>] [--idempotency-key <k>]` — submit a contract write call (gas at-cost + $0.000005 KMS sign fee). Returns `{ call_id, tx_hash, status }`.
- `run402 contracts deploy <project_id> <signer_id> --bytecode 0x... [--chain <base-mainnet|base-sepolia>] [--value-wei <n>] [--idempotency-key <k>]` — deploy a contract from the KMS signer (gas at-cost + $0.000005 KMS sign fee). `--bytecode` is the full creation calldata (creation bytecode + ABI-encoded constructor args, concatenated client-side via viem/ethers; ≤ 128 KB). Returns `{ call_id, tx_hash, status, contract_address }` — the deterministic CREATE address is known synchronously. run402 does NOT compile Solidity.
- `run402 contracts read --chain <chain> --to 0x... --abi <json> --fn <name> --args <json>` — read-only contract call (free, no signing, no billing)
- `run402 contracts status <call_id>` — get call status, gas used, gas cost USD-micros, receipt, error (free)
- `run402 contracts drain <signer_id> --to 0x... --confirm` — drain native balance to a destination address (gas at-cost + $0.000005 KMS sign fee). Works on suspended signers — the safety valve.
- `run402 contracts delete <signer_id> --confirm` — schedule the KMS key for deletion (7-day window). Refused if balance ≥ dust — drain first.

### message
- `run402 message send "<text>"`

### agent
- `run402 agent contact --name <name> [--email <email>] [--webhook <url>]`
- `run402 agent status`
- `run402 agent verify-email`
- `run402 agent passkey enroll`

`contact` returns `email_verification_status`, `passkey_binding_status`, `assurance_level`. New/changed emails start reply challenge and remain `email_pending` until owner replies. `passkey enroll` requires `email_verified`, emails enrollment link, never prints token.

### operator
Operator = human email identity, distinct from agent wallet/SIWX. One browser login spans wallets that verified the email; `operator overview` returns cross-wallet union. Single-wallet org state: `run402 status`; operator login/approval state: `run402 operator status`.

**Wallet-less writes (operator approval, v1.85/v1.87):** wallet agents still use SIWX. Wallet-less human uses control-plane session (`operator login --loopback`); high-stakes `provision`, `deploy`, secret writes also need passkey-fresh approval for one `(action,target)` as `X-Run402-Write-Auth`. Missing approval -> `403 WRITE_AUTH_REQUIRED` / SDK `OperatorApprovalRequiredError` (`isOperatorApprovalRequired()`) with exact `operator approve ...` command. Approval is never ambient for MCP/CI/non-TTY; only interactive TTY may auto-open browser and retry.

- `run402 operator login [--no-open]` — read session via device auth (RFC 8628). Prints URL + user code to stderr, opens browser on TTY, approve by magic-link or passkey, caches `{base}/operator-session.json` (0600, base dir shared across wallets). Success `{ logged_in, email, wallets, wallet_count, expires_at, absolute_expires_at, expires_in_seconds }`.
- `run402 operator login --loopback [--no-open]` / `run402 operator login --step-up` — write-capable loopback-PKCE (RFC 8252) login. Starts `127.0.0.1`, browser passkey ceremony, mints passkey-fresh session (`provenance=loopback_pkce`) at `{base}/control-plane-session.json` (0600; token never printed). `--step-up` refreshes for `STEP_UP_REQUIRED`. `whoami` surfaces it; `logout` clears it. Stdout includes `memberships[]`, including invites auto-claimed by login when lookup succeeds. Hosted logins are SDK/console-side (`r.operator.session.*`), not CLI.
- `run402 operator overview` — organization view across ALL wallets controlling your email. Sends the cached operator-session bearer to `GET /agent/v1/operator/overview`. **Requires login** — returns `OPERATOR_LOGIN_REQUIRED` (no SIWX fallback) when there is no live session, and clears the cache + returns `OPERATOR_SESSION_INVALID` on a 401/403 (revoked or expired).
- `run402 operator whoami` — local, no network. Prints the cached session (`logged_in`, email, wallets, expiry) or `{ logged_in: false, reason: "no_session" | "expired" }` with a non-zero exit.
- `run402 operator logout` — revokes the session server-side (`POST /agent/v1/operator/session/revoke`) then clears the local cache. Idempotent; best-effort revoke (always clears locally). Stdout: `{ revoked, cleared }`.
- `run402 operator claim-wallet-org [--org <id>] [--name <label>]` — transfer wallet-agent-owned org into human console identity (v1.82). Wallet authenticator remains agent; agent downgraded owner->developer. Requires write-capable control-plane session + fresh active-wallet signature over server nonce. Success `{ claimed: true, org_id, display_name, role, already_owned }`; multiple owned orgs -> `{ claimed: false, selectable_orgs: [...] }`, retry with `--org`; stale session -> `STEP_UP_REQUIRED`; `--name` labels org.
- `run402 operator approve --action <cap> (--org <id> | --project <id>) [--no-open]` — mint passkey approval for one `(action,target)`. Actions: `org.project.create` + `--org`, `project.deploy` + `--project`, `project.secret.write` + `--project`. Requires `operator login --loopback`; loopback-PKCE + passkey confirm page; caches token bound to `(api_origin, control-plane-session, action, target)` at `{base}/write-auth-session.json` (0600; token never printed). Multiple approvals can coexist; cleared on login/step-up/logout. Hidden alias `operator write-auth`; `provision`/`deploy` surface or auto-run it on interactive TTY.
- `run402 operator status` — local, no network. Stdout JSON `{ operator_login: { active, provenance, amr, expires_at } | { active: false }, approvals: [{ action, org_id, project_id, expires_at }] }` — your control-plane login state + every live approval.

Session is email-scoped (~30m access TTL, ~12h absolute), cached once at base dir independent of `--wallet`. Login/overview/logout require gateway device-auth bridge; `whoami` local. No MCP tools by design: MCP authenticates as agent wallet; human session must not be handed to agent.

### service
Public service-level status. No allowance, no auth, no keystore required — works on a fresh install. Reports on the Run402 service (uptime, capabilities, operator); for your organization state use `run402 status`.
- `run402 service status` — public availability report (24h/7d/30d uptime per capability, operator, deployment, schema `run402-status-v1`)
- `run402 service health` — liveness check with per-dependency results (postgres, postgrest, s3, cloudfront) and service version

### cache
SSR origin-cache inspection + invalidation. Capability `ssr-isr-cache` (gateway v1.52+, paired with `@run402/astro` v1.0+). Cache is scoped per-project; cross-project hosts return `R402_CACHE_INVALIDATION_HOST_FORBIDDEN`.

- `run402 cache inspect <url> [--locale <code>] [--release-id <id>]` — read the cache row state for a URL. Stdout is JSON: `{ status: "HIT" | "MISS", host, path, locale, releaseId, cachedAt, expiresAt, writtenUnderGeneration, contentSha256, headers }`. `status` is NEVER `BYPASS` — inspect does not issue a request, so it cannot evaluate runtime bypass conditions. Defaults to active release + default locale; pass `--locale` / `--release-id` to inspect non-default rows. (The legacy `--json` flag is removed — JSON is the default.)
- `run402 cache invalidate <url>` — invalidate a single absolute URL. Stdout: `{ deleted, host, path, generation }`.
- `run402 cache invalidate --prefix <p> --host <h>` — invalidate all rows under a path prefix on a specific host.
- `run402 cache invalidate --all --host <h>` — entire-host purge (catastrophic content changes; nav restructure; layout-wide updates).

Every invalidate returns `{ deleted, generation, host, path? }`. `generation` is the post-increment per-(project, host) counter — it gates in-flight MISS renders from overwriting after invalidation completed.

### doctor
Health + config diagnostics. Agent-DX entrypoint — agents run this first to verify environment before attempting anything else.

- `run402 doctor [--verbose] [--no-scan] [--scan-dir <D>]` — checks: config dir presence, allowance + rail, keystore wallet count, API base reachability, active tier + lifecycle state, operator health snapshot (binding state + per-attempt verification failure detail since v2.4 / gateway v1.56), **source scan** (auth-aware-ssr). Exit 0 on all-pass, 1 on any failure. Stdout is JSON `{ ok: boolean, checks: [{ name, status, value?, hint?, message? }] }`. When operator email verification is `pending`, the doctor surfaces the per-reason hint from `email_verification.last_challenge.hint` along with `attempt_count` / `remaining_attempts` so the operator sees what to fix. The source scan walks `<cwd>/src` and flags hallucinated SDK auth names (`R402_AUTH_UNKNOWN_EXPORT`), state-changing GET handlers (`R402_AUTH_STATE_CHANGING_GET`), `auth.*` calls in `export const prerender = true` pages (`R402_AUTH_PRERENDERED`), and direct mutation of `internal.sessions.authz_version` (`R402_AUTH_AUTHZ_VERSION_PROHIBITED`). `--no-scan` skips the scan (config-only checks). `--scan-dir <D>` overrides the scan root. `run402 deploy apply` runs the scan as pre-flight and refuses to deploy on any `error`-severity finding (bypass with `RUN402_DEPLOY_SKIP_SCAN=1`). (The legacy `--json` flag is removed — JSON is the default.)

### dev
Astro dev wrapper. Loads `.env.local`, verifies `RUN402_PROJECT_ID` + `RUN402_SERVICE_KEY`, then spawns `astro dev` with the env inherited.

- `run402 dev [--port <n>] [--host <h>] [--project <id>]`

SDK calls (`db`, `auth.user`, `cache.invalidate`, `assets.put`) hit the LIVE Run402 project at `https://api.run402.com` — no local DB/S3/KMS setup required. This is shape-parity with production. Offline emulator mode is deferred to v1.5.

### init astro
Project scaffolder. Subroute of `init` (alongside `init` rail setup).

- `run402 init astro [<dir>] [--force]` — creates a deployable Astro project with `package.json` (dev/deploy scripts), `astro.config.mjs` (one-line `@run402/astro` preset), `src/pages/{index,[slug]}.astro` (the latter demonstrates the full DB-backed dynamic page pattern with cache directive), `src/layouts/Layout.astro` (title + og + canonical), `src/pages/api/save-page.ts` (admin save endpoint with `db().upsert() → cache.invalidate()`), `.env.example`, `.gitignore`. Refuses non-empty dirs without `--force`. Stdout is JSON `{ dir, files_created, created, next_steps }`; progress lines go to stderr. (The legacy `--json` flag is removed — JSON is the default.)

### logs
Fetch function logs by request id. Top-level shortcut — for fine-grained per-function control, `run402 functions logs <project> <name>` still works.

- `run402 logs --request-id <req_...> [--function <name>] [--project <id>] [--tail <n>]` — stdout is JSON `{ ok, request_id, project_id, scanned, entries, errors? }`. (The legacy `--json` flag is removed — JSON is the default.)

When an SSR response returns a 5xx, the response headers include `x-run402-error-code: R402_SSR_RUNTIME_ERROR` and `x-run402-request-id: req_...`. Copy the request id and run `run402 logs --request-id req_...` to fetch the full stack trace. Scans every function in the project in parallel and aggregates entries timestamp-ascending unless `--function` narrows the scope.

---
## R402_* SSR Runtime Error Codes (cache + Astro adapter, gateway v1.52+)

Stable error codes for the Astro SSR runtime. Each carries `code`, `message`, `suggestedFix`, `docs`, and (when statically determinable) `file`, `line`. Codes are protocol-stable and emitted as the exact uppercase string in JSON envelopes, response headers, logs, and CLI output.

**Build / deploy:**

- `R402_ASTRO_BUILD_FAILED` — Astro's own compiler threw an unrecovered error. Suggested fix: read the build log + address the underlying compiler error.
- `R402_ASTRO_UNSUPPORTED_OUTPUT` — `output: '...'` is not supported. Use `output: 'server'` (default) and opt-in per route via `export const prerender = true;`.
- `R402_ASTRO_MIDDLEWARE_UNSUPPORTED` — middleware ran but a specific pattern hit a snag. Move auth-gating to page frontmatter or API endpoints.
- `R402_ASTRO_SERVER_ISLAND_UNSUPPORTED` — `server:defer` / `server:only` detected. Use client islands (`client:load`, `client:idle`, `client:visible`) instead; server islands deferred to v1.5.
- `R402_ASTRO_SESSIONS_UNSUPPORTED` — `Astro.session.*` or `experimental.session` detected. Use signed cookies via `Astro.cookies` or DB-backed sessions.
- `R402_ASTRO_DYNAMIC_IMAGE_UNSUPPORTED` — `<Image src={expr}>` where `expr` is a runtime value (DB row, function call, env var). Use `<Run402Picture asset={page.hero_asset}>` for CMS images; static-import binding `<Image src={hero}>` is allowed.
- `R402_ASTRO_VERSION_UNSUPPORTED` — installed Astro outside the adapter's pinned peer range.
- `R402_BUNDLE_UNRESOLVED_IMPORT` — bundler couldn't resolve a function-file import. Check package presence in `dependencies`.
- `R402_BUNDLE_NATIVE_DEP_UNSUPPORTED` — bundle contains native binary deps (`sharp`, `better-sqlite3`, etc.). Replace with Run402 primitives (`r.assets.put` for image processing, `r.ai.*` for ML).

**Runtime / SnapStart:**

- `R402_SNAPSTART_INIT_IO` — module-scope IO detected during SnapStart snapshot capture. Move SDK calls inside the request handler.
- `R402_SDK_OUTSIDE_REQUEST_CONTEXT` — SDK function called outside an active request context (module scope or post-response timer). Move into handler scope.
- `R402_SSR_RUNTIME_ERROR` — uncaught exception during render. The public response carries `requestId` + `releaseId` (no stack trace); full stack via `run402 logs --request-id <req>`.

**Cache layer:**

- `R402_CACHE_UNSUPPORTED_VARY` — response `Vary` references something other than `Accept-Language`. Bypass header emitted; response delivered normally but not cached.
- `R402_CACHE_AUTH_TAINTED` — informational diagnostic (not an `ok: false` error). Emitted via `x-run402-cache-reason: auth` when render called `auth.user()` (or any other `auth.*` helper) or a payment primitive. This is the expected uncacheable-by-design behavior.

**Auth-aware SSR (auth-aware-ssr, v3.0):**

22 codes covering the browser-session / actor-context / hosted-UI / SDK surface. See run402.com/llms-full.txt for the full table with per-code fix-it hints. Highlights:

- `R402_AUTH_REQUIRED` — 401 (JSON) / 303 → `/auth/sign-in?returnTo=` (HTML). Auth helper called from an anonymous request.
- `R402_AUTH_INSUFFICIENT_ROLE` / `R402_AUTH_INSUFFICIENT_MEMBERSHIP` — 403. Authenticated user lacks the named grant; platform does NOT redirect to sign-in (the user IS signed in).
- `R402_AUTH_FRESHNESS_REQUIRED` — 401 / 303 → `/auth/re-auth`. Per-AMR step-up needed.
- `R402_AUTH_SESSION_EXPIRED` / `R402_AUTH_SESSION_INVALID` — cookie cleared on response; user re-signs-in.
- `R402_AUTH_CSRF_ORIGIN_MISMATCH` — 403. Cookie-authenticated unsafe-method request with mismatched / missing Origin and Referer.
- `R402_AUTH_CSRF_TOKEN_MISMATCH` — 403. Hosted-auth form missing or mismatching the platform CSRF token.
- `R402_AUTH_BEARER_COOKIE_MISMATCH` / `R402_AUTH_INVALID_BEARER` — 400 / 401. Cookie + Bearer disagree, or valid cookie + malformed Bearer.
- `R402_AUTH_UNKNOWN_EXPORT` — 500. Hallucinated SDK name (`getUser`, `getSession`, `auth.protect`, …). `details.canonical_name` carries the replacement.
- `R402_AUTH_PRERENDERED` — 500. `auth.*` called from a prerendered page. Convert to SSR or use a server island.
- `R402_AUTH_FETCH_ABSOLUTE_URL` — 500. `auth.fetch` rejected a cross-origin / embedded-creds / javascript:/data: / protocol-relative / subdomain-spoof / port-mismatch URL.
- `R402_AUTH_RETURN_TO_INVALID` — 400. Hosted-auth route got a `returnTo` that's not path-relative or same-origin absolute.
- `R402_AUTH_IDENTITY_LINK_CONFLICT` — 409. `(project_id, provider, subject)` already linked to another user.
- `R402_AUTH_SESSION_BRIDGE_UNVERIFIED` — 401. Custom identity proof failed verification, OR consumer accessed the internal-only session-creation primitive.
- `R402_AUTH_UNKNOWN_IDENTITY` — 401. `createResponseFromIdentity` couldn't resolve identity AND `createUser: true` not set.
- `R402_AUTH_DOMAIN_NOT_ALLOWED` — 403. Hosted Google sign-in rejected at token issuance: the verified email's domain isn't in the project's `allowed_email_domains` (or the email is unverified). Set/clear the allowlist with `run402 auth settings --allowed-email-domains <csv|none>`. Empty allowlist = unrestricted.
- `R402_AUTH_TENANT_SUFFIX_REQUIRED` — gateway refuses session cookies on `*.run402.com` for non-allowlisted projects. PSL-registered `*.run402.app` + verified custom domains are always allowed.
- `R402_AUTH_ACTOR_HEADER_SPOOF` — client-supplied reserved actor header was stripped at ingress; diagnostic only.
- `R402_AUTH_REDUNDANT_USER_FILTER` — deploy-fail (or runtime warn). `.eq("user_id", user.id)` against an RLS-bound table. Add `// run402-allow-user-filter: <reason>` if intentional.
- `R402_AUTH_AUTHZ_VERSION_PROHIBITED` — deploy-fail. Consumer migration mutates `internal.sessions.authz_version` directly.
- `R402_CACHE_INVALIDATION_HOST_REQUIRED` — `cache.invalidate('/path')` called outside a request context. Use absolute URL form OR move into a request handler.
- `R402_CACHE_INVALIDATION_HOST_FORBIDDEN` — cross-project host. Use a host attached to your project (`run402 domains list`).

**Deploy:**

- `R402_DEPLOY_STAGE_FAILED` — apply-v1 state machine failure at a specific stage (`validate` / `stage` / `migrate` / `schema_settling` / `activating` / `snapstart_validate`).

---
## REST API (for generated frontend code)

The CLI's `run402 projects rest` command is great for terminal use. But when generating HTML/JS that runs in the browser, use the REST API directly:

Base URL: `https://api.run402.com/rest/v1/{table}`

Auth header: `apikey: {key}` — the gateway auto-forwards as `Authorization: Bearer` to PostgREST. Any valid project JWT works:
- `anon_key` → read-only by default (SELECT). Safe to embed in frontend code. No expiry -- permanent project identifier. If you apply `public_read_write_UNRESTRICTED` RLS to a table, anon_key gains INSERT/UPDATE/DELETE on that table — use this for browser-side writes without login (only on intentionally public tables).
- `service_key` → full admin (bypasses RLS). Server-side only. No expiry -- lease enforcement server-side.
- `access_token` (from login) → user-scoped read/write (subject to RLS).

For explicit control, send both `apikey` (project key) and `Authorization: Bearer <access_token>`.

CORS: The API allows all origins (`Access-Control-Allow-Origin: *`). Browser `fetch()` calls work from any domain -- no proxy needed.

PostgREST query syntax: `?select=col1,col2`, `?column=eq.value`, `?order=col.desc`, `?limit=N`, `?offset=N`

`Prefer` header (controls write responses):
- `Prefer: return=representation` → return the inserted/updated row(s) as JSON. Use this to get server-generated fields (`id`, `created_at`) without a second query.
- `Prefer: return=minimal` → empty body (default). Faster when you don't need the result.

Frontend fetch examples:

```javascript
const API = 'https://api.run402.com';
const ANON_KEY = 'your_anon_key';  // from run402 projects list

// Read rows (public, uses anon_key)
const items = await fetch(API + '/rest/v1/items?select=id,title&done=eq.false&order=id.desc&limit=20', {
  headers: { apikey: ANON_KEY }
}).then(r => r.json());

// Insert a row and get it back (Prefer: return=representation returns the new row with id, created_at, etc.)
const [newItem] = await fetch(API + '/rest/v1/items', {
  method: 'POST',
  headers: { apikey: ANON_KEY, 'Content-Type': 'application/json', Prefer: 'return=representation' },
  body: JSON.stringify({ title: 'New item', done: false })
}).then(r => r.json());

// Bulk insert — pass an array body
const newItems = await fetch(API + '/rest/v1/items', {
  method: 'POST',
  headers: { apikey: ANON_KEY, 'Content-Type': 'application/json', Prefer: 'return=representation' },
  body: JSON.stringify([{ title: 'Item A', done: false }, { title: 'Item B', done: false }])
}).then(r => r.json());

// Update rows matching a filter
await fetch(API + '/rest/v1/items?id=eq.5', {
  method: 'PATCH',
  headers: { apikey: ANON_KEY, 'Content-Type': 'application/json', Prefer: 'return=representation' },
  body: JSON.stringify({ done: true })
}).then(r => r.json());

// Delete rows matching a filter
await fetch(API + '/rest/v1/items?id=eq.5', {
  method: 'DELETE',
  headers: { apikey: ANON_KEY }
});
```

### Complete HTML example

A working single-file app. Uses `public_read_write_UNRESTRICTED` RLS so the `anon_key` handles all reads and writes — no login required. (This template is intentionally open; only apply it to tables where anyone on the internet is allowed to write anything, like guestbooks.)

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Guestbook</title>
  <style>
    body { font-family: system-ui; max-width: 480px; margin: 2rem auto; padding: 0 1rem; }
    .entry { border-bottom: 1px solid #eee; padding: 0.5rem 0; }
    .entry .name { font-weight: bold; }
    .entry .time { color: #888; font-size: 0.85em; }
    form { display: flex; gap: 0.5rem; margin-bottom: 1.5rem; }
    input { flex: 1; padding: 0.4rem; }
    button { padding: 0.4rem 1rem; }
  </style>
</head>
<body>
  <h1>Guestbook</h1>
  <form id="form">
    <input name="name" placeholder="Your name" required>
    <input name="message" placeholder="Say something..." required>
    <button type="submit">Post</button>
  </form>
  <div id="entries"></div>

  <script>
    const API = 'https://api.run402.com';
    const ANON_KEY = 'YOUR_ANON_KEY';  // safe to embed — read-only by default, write-enabled here via public_read_write_UNRESTRICTED RLS

    async function loadEntries() {
      const rows = await fetch(API + '/rest/v1/guestbook?order=created_at.desc&limit=50', {
        headers: { apikey: ANON_KEY }
      }).then(r => r.json());
      document.getElementById('entries').innerHTML = rows.map(r =>
        `<div class="entry"><span class="name">${esc(r.name)}</span> <span class="time">${new Date(r.created_at).toLocaleString()}</span><p>${esc(r.message)}</p></div>`
      ).join('');
    }

    document.getElementById('form').onsubmit = async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      await fetch(API + '/rest/v1/guestbook', {
        method: 'POST',
        headers: { apikey: ANON_KEY, 'Content-Type': 'application/json', Prefer: 'return=representation' },
        body: JSON.stringify({ name: fd.get('name'), message: fd.get('message') })
      });
      e.target.reset();
      loadEntries();
    };

    function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

    loadEntries();
  </script>
</body>
</html>
```

Setup for this example (run once via CLI or service_key):
```bash
# Create table
run402 projects sql $PROJECT_ID "CREATE TABLE guestbook (id serial PRIMARY KEY, name text NOT NULL, message text NOT NULL, created_at timestamptz DEFAULT now())"

# Expose guestbook so anon_key can insert. Write manifest.json:
# {"version":"1",
#  "tables":[{"name":"guestbook","expose":true,"policy":"public_read_write_UNRESTRICTED","i_understand_this_is_unrestricted":true}],
#  "views":[],"rpcs":[]}
run402 projects apply-expose $PROJECT_ID --file manifest.json
```

---
## User Auth (for apps with login)

Two auth methods: password (email + password) and Google OAuth (social login). Both return the same `access_token` + `refresh_token`. Google OAuth is on for all projects automatically — zero config.

### Password auth

```javascript
const API = 'https://api.run402.com';
const ANON_KEY = 'your_anon_key';

// Sign up
await fetch(API + '/auth/v1/signup', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', apikey: ANON_KEY },
  body: JSON.stringify({ email: 'user@example.com', password: 'secret123' })
});

// Log in (returns access_token + refresh_token)
const session = await fetch(API + '/auth/v1/token?grant_type=password', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', apikey: ANON_KEY },
  body: JSON.stringify({ email: 'user@example.com', password: 'secret123' })
}).then(r => r.json());
// session = { access_token, refresh_token, user: { id, email, ... } }
```

Signup does not return an access token. Call `/auth/v1/token` to log in. Returns `access_token` (1h JWT) and `refresh_token` (30d, one-time use).

### Google OAuth (recommended for user-facing apps)

Google sign-in is on for all projects with zero config. When a user signs in with Google, Run402 creates a project-scoped user with their Google name, email, and avatar.

Allowed redirect origins: `http://localhost:*` (any port) + any claimed subdomain (`https://{name}.run402.com`). No manual config needed.

Flow: Frontend generates PKCE verifier + challenge → calls `/auth/v1/oauth/google/start` → navigates to Google → user picks account → Google redirects back to your app with `#code=xxx&state=yyy` → frontend exchanges code for tokens.

Full JavaScript example:

```javascript
const API = 'https://api.run402.com';
const ANON_KEY = 'your_anon_key';

// --- PKCE helpers ---
function generateVerifier() {
  const arr = new Uint8Array(32);
  crypto.getRandomValues(arr);
  return btoa(String.fromCharCode(...arr))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
async function generateChallenge(verifier) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// --- Step 1: Start login (call on button click) ---
async function signInWithGoogle() {
  const verifier = generateVerifier();
  const challenge = await generateChallenge(verifier);
  localStorage.setItem('pkce_verifier', verifier);

  const res = await fetch(API + '/auth/v1/oauth/google/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: ANON_KEY },
    body: JSON.stringify({
      redirect_url: window.location.origin + '/',
      mode: 'redirect',
      code_challenge: challenge,
      code_challenge_method: 'S256',
    }),
  });
  const { authorization_url } = await res.json();
  window.location.href = authorization_url;  // navigate to Google
}

// --- Step 2: Handle callback (call on page load) ---
async function handleOAuthCallback() {
  const params = new URLSearchParams(window.location.hash.substring(1));
  const code = params.get('code');
  if (!code) return false;

  window.history.replaceState(null, '', window.location.pathname);
  const verifier = localStorage.getItem('pkce_verifier');
  localStorage.removeItem('pkce_verifier');

  const res = await fetch(API + '/auth/v1/token?grant_type=authorization_code', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: ANON_KEY },
    body: JSON.stringify({ code, code_verifier: verifier }),
  });
  const session = await res.json();
  // session = { access_token, refresh_token, user: { id, email, display_name, avatar_url, ... } }
  return session;
}
```

### Using access_token with the REST API

Once a user is logged in, use their `access_token` as the apikey to make user-scoped requests subject to RLS:

```javascript
// User-scoped read/write (subject to RLS policies)
const todos = await fetch(API + '/rest/v1/todos?order=id.desc', {
  headers: { apikey: ANON_KEY, Authorization: 'Bearer ' + session.access_token }
}).then(r => r.json());
```

### Token refresh

```javascript
const refreshed = await fetch(API + '/auth/v1/token?grant_type=refresh_token', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', apikey: ANON_KEY },
  body: JSON.stringify({ refresh_token: session.refresh_token })
}).then(r => r.json());
```

### Account behavior

- New Google user → new project user created (null password, Google name + avatar stored)
- Returning Google user -> signed in to existing user
- Same email as existing password user → returns `account_exists_requires_link` error (no auto-merge for security)
- Social-only users cannot use password login (helpful error message returned)

### Useful endpoints

- `GET /auth/v1/providers` (with `apikey` header) — list available auth methods (password, google). Useful for dynamic login UIs.
- `GET /auth/v1/user` (with `Authorization: Bearer <access_token>`) — returns `display_name`, `avatar_url`, `email_verified_at`, and linked `identities[]`.

---
## Build Ideas

Complete webapp ideas (DB + auth + frontend + URL): shared todo (title/done/assignee), landing page + waitlist, expense splitter, scheduling poll, recipe book, apartment tracker, micro-blog, gift registry, workout log, flash cards.

Build pattern: provision first for `anon_key`; manifest includes `project_id`, idempotent `migrations` with seed data, site files, authorization manifest (`public_read_write_UNRESTRICTED` + acknowledgement for browser-writable public apps; `user_owns_rows` for user-scoped apps), and subdomain. Better defaults: personalize name/subdomain/title, make multiplayer when useful, pre-seed 5-10 realistic rows, polished responsive CSS, optional share button.

### After you build: send us feedback

```bash
run402 message send "My human said: 'The todo app was great!' Deploy was smooth."
```

---
## Pricing Summary

| What | Cost | Duration |
|---|---|---|
| Prototype tier | FREE (testnet USDC; verifies allowance, $0 real money) | 7 days |
| Hobby tier | $5.00 (real money) | 30 days |
| Team tier | $20.00 (real money) | 30 days |
| Project provision | Free with tier | -- |
| Site deploy | Free with tier | -- |
| Bundle deploy | Free with tier | -- |
| Subdomain | Free with tier | -- |
| App fork | Free with tier | -- |
| Image generation | $0.03 | Per image |
| KMS signer rental | $0.04/day ($1.20/month) | Per signer; $1.20 prepay required |
| Contract call (gas) | at-cost | Per call, 0% markup on chain gas. |
| Contract call (KMS sign fee) | $0.000005 | Per call; only run402 contract-call markup |
| Functions | Free with tier | -- |
| Secrets | Free with tier | -- |
| Storage | Free with tier | -- |
| Messages | Free with tier | -- |

Prototype uses free testnet USDC on Base Sepolia. Hobby/Team require real money: Stripe credits or real USDC on Base; CLI handles payment automatically.
