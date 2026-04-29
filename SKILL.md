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
5. **`apply_expose`** with a manifest — declare which tables are reachable via PostgREST. Tables are dark by default.
6. **`deploy_site_dir`** with `dir` (or `deploy_site` with inline files) — incremental upload, only PUTs bytes the gateway doesn't already have. Returns a live URL plus auto-claimed subdomain on subsequent deploys.

Optional next: **`deploy_function`** for server logic, **`blob_put`** to host images/JS/CSS with paste-and-go URLs, **`create_mailbox` + `send_email`** for transactional mail.

## Error Envelopes and Safe Retry

Run402-originated JSON errors may include a canonical envelope. Branch on the stable `code`, not English `message` or legacy `error` text. `message` is for display; `error` is a legacy fallback.

Important fields:
- `code` — stable machine-readable reason, e.g. `PROJECT_FROZEN`, `PAYMENT_REQUIRED`, `MIGRATION_FAILED`, `MIGRATE_GATE_ACTIVE`
- `retryable` — the same request may succeed later
- `safe_to_retry` — repeating the same request should not duplicate or corrupt a mutation
- `mutation_state` — gateway-known mutation progress: `none`, `not_started`, `committed`, `rolled_back`, `partial`, or `unknown`
- `trace_id` — include this when reporting a Run402 issue
- `details` — structured route-specific context
- `next_actions` — advisory suggestions such as `authenticate`, `submit_payment`, `renew_tier`, `check_usage`, `retry`, `resume_deploy`, `edit_request`, or `edit_migration`; render or follow them only after validating the action is safe

Safe retry policy:
- If `retryable: true` and `safe_to_retry: true`, retry the same request, preferably with the same idempotency key for mutating operations.
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
  "next_actions": [{ "action": "renew_tier" }, { "action": "check_usage" }]
}
```

```json
{
  "message": "Payment required.",
  "code": "PAYMENT_REQUIRED",
  "category": "payment",
  "retryable": true,
  "safe_to_retry": true,
  "next_actions": [{ "action": "submit_payment" }]
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
  "next_actions": [{ "action": "edit_migration" }]
}
```

## Project credentials

After `provision_postgres_project`, two keys are saved automatically to `~/.config/run402/projects.json` and reused by every subsequent tool call:

- **`anon_key`** — read-only by default; safe in browser HTML. RLS still applies.
- **`service_key`** — server-side admin. **Never embed in browser code.** CORS is intentionally open for x402 clients, so a leaked service_key is exploitable from any origin. Use only inside functions or when calling tools as the agent.

Neither key expires. Lease enforcement happens server-side. To inspect, call **`project_keys`**; to switch the active project for sticky-default tools, call **`project_use`**.

## The patterns

### Paste-and-go assets — content-addressed URLs with SRI

When you upload a file with **`blob_put`**, the response is an `AssetRef`. The URL is content-addressed (`pr-<public_id>.run402.com/_blob/<key>-<8hex>.<ext>`), served through CloudFront, and never needs cache invalidation:

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

#### Preferred: ship `manifest.json` in your bundle

Authorization travels with your code. When you call **`bundle_deploy`**, include a file named `manifest.json` in `files[]` and the gateway reads it, validates it against the migration SQL, applies it, and **strips it from `files[]` before the site deploys** — so it's never publicly reachable on your subdomain. The deploy response includes `manifest_applied: true` on success.

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

#### Imperative: `apply_expose` and `get_expose`

For ad-hoc changes outside a deploy — same JSON shape, no bundle:

- **`apply_expose`** with `project_id` + `manifest` — applies the manifest. Convergent: applying the same manifest twice is a no-op; items removed between applies have their policies, grants, triggers, and views dropped.
- **`get_expose`** with `project_id` — returns the live state. `source: "applied"` means it came from a prior apply (or a bundled `manifest.json`); `source: "introspected"` means no manifest has ever been applied and the response was reconstructed from live DB state.

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

The response's `content` array includes a fenced `json` block of buffered progress events you can `JSON.parse`:

| phase | When fired | Extra |
|-------|------------|------|
| `plan`   | After the planning request | `manifest_size` |
| `upload` | After each missing file finishes PUTing | `file`, `sha256`, `done`, `total` |
| `commit` | Just before commit | — |
| `poll`   | Per server-side copy poll | `status`, `elapsed_ms` |

For one-call full-stack deploys (database + migrations + manifest + secrets + functions + site + subdomain), use **`bundle_deploy`** with a manifest. Include `manifest.json` in `files[]` for auth-as-SDLC.

### In-function helpers — `db(req)` vs `adminDb()`

Inside a deployed function, import from `@run402/functions`. Two distinct DB clients keep RLS clean:

```ts
import { db, adminDb, getUser, email, ai } from "@run402/functions";

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

Fluent surface on both `db(req).from(t)` and `adminDb().from(t)`:
- Reads: `.select()`, `.eq()`, `.neq()`, `.gt()`, `.lt()`, `.gte()`, `.lte()`, `.like()`, `.ilike()`, `.in()`, `.order()`, `.limit()`, `.offset()`
- Writes: `.insert()`, `.update()`, `.delete()` — return arrays of affected rows
- Column narrowing on writes: `.insert({…}).select("id, title")`

For TypeScript autocomplete, `npm install @run402/functions` in your editor's project. Same package also works at build time for static-site generation if you set `RUN402_SERVICE_KEY` + `RUN402_PROJECT_ID` in `.env`.

## Tools by category

### Database

- **`provision_postgres_project`** — provision a new database. Auto-handles x402 payment.
- **`run_sql`** — execute SQL (DDL or queries). Service-key-authenticated.
- **`rest_query`** — query/mutate via PostgREST. Pass `key_type: "anon"` (default) for RLS-applied access, `"service"` to bypass.
- **`apply_expose`** / **`get_expose`** — declarative authorization manifest (see "expose manifest" above).
- **`get_schema`** — introspect tables, columns, types, constraints, RLS policies.
- **`get_usage`** — per-project usage report (API calls, storage, lease expiry).
- **`promote_user`** / **`demote_user`** — manage `project_admin` role on a project user.
- **`delete_project`** — cascade purge. Irreversible.

### Blob storage (content-addressed CDN)

- **`blob_put`** — upload (any size, up to 5 TiB). Returns an `AssetRef` with `cdn_url`, `sri`, `etag`, `cache_kind`.
- **`blob_get`** — download to a local file (no context-window bloat).
- **`blob_ls`** — keyset-paginated list with prefix filter.
- **`blob_rm`** — delete.
- **`blob_sign`** — time-boxed presigned GET URL for a private blob.
- **`diagnose_public_url`** — live CDN state for a public URL — expected vs observed SHA, cache headers, invalidation status.
- **`wait_for_cdn_freshness`** — poll a mutable URL until it serves the expected SHA-256.

### Sites & subdomains

- **`deploy_site`** — deploy from inline file bytes.
- **`deploy_site_dir`** — deploy from a local directory. Plan/commit transport — only uploads bytes the gateway doesn't have.
- **`get_deployment`** — fetch deployment status and URL.
- **`claim_subdomain`** — claim `<name>.run402.com` (idempotent; auto-reassigns to latest deployment on subsequent deploys, no re-claim needed).
- **`list_subdomains`** / **`delete_subdomain`** — manage subdomains.
- **`add_custom_domain`** / **`list_custom_domains`** / **`check_domain_status`** / **`remove_custom_domain`** — point your own domain at a Run402 subdomain.
- **`bundle_deploy`** — one-call full-stack deploy with auth-as-SDLC manifest in `files[]`.

### Functions & secrets

- **`deploy_function`** — deploy a Node 22 serverless function. Cron-schedulable via `schedule`. Pass `deps` as npm specs (bare names → latest at deploy time, pinned `lodash@4.17.21` or ranges `date-fns@^3.0.0` honored verbatim, max 30 entries / 200 chars each, native binaries rejected). Response surfaces `runtime_version`, `deps_resolved`, `warnings`.
- **`invoke_function`** — invoke for testing.
- **`get_function_logs`** — recent logs (CloudWatch). Use `since` for incremental polling.
- **`update_function`** — change schedule / timeout / memory without redeploying code.
- **`list_functions`** / **`delete_function`** — list / remove.
- **`set_secret`** / **`list_secrets`** / **`delete_secret`** — `process.env` secrets injected into every function. `list_secrets` returns keys with a `value_hash` (8 hex chars of SHA-256) for verification.

Scheduled function limits per tier: prototype 1 / 15 min, hobby 3 / 5 min, team 10 / 1 min.

### Auth & email

- **`request_magic_link`** / **`verify_magic_link`** — passwordless login. Tokens single-use, 15-min TTL, 5/email/hour rate limit.
- **`set_user_password`** — change, reset, or set a user's password.
- **`auth_settings`** — toggle `allow_password_set` for passwordless users.
- **`create_mailbox`** / **`get_mailbox`** / **`delete_mailbox`** — per-project mailbox at `<slug>@mail.run402.com`.
- **`send_email`** — template (`project_invite`, `magic_link`, `notification`) or raw HTML. Single recipient.
- **`list_emails`** / **`get_email`** / **`get_email_raw`** — read messages. `get_email_raw` returns RFC-822 bytes for DKIM / zk-email verification.
- **`register_mailbox_webhook`** / **`list_mailbox_webhooks`** / **`get_mailbox_webhook`** / **`update_mailbox_webhook`** / **`delete_mailbox_webhook`** — email-event webhooks (delivery, bounced, complained, reply_received).
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

- **`set_tier`** — subscribe / renew / upgrade. Auto-detects action. x402 payment.
- **`tier_status`** — current tier + lease.
- **`get_quote`** — pricing (free, no auth).
- **`tier_checkout`** — Stripe checkout (alternative to x402).
- **`create_email_billing_account`** / **`link_wallet_to_account`** — email-based accounts; hybrid Stripe + x402.
- **`billing_history`** — ledger.
- **`buy_email_pack`** — $5 / 10,000 emails (never expire).
- **`set_auto_recharge`** — auto-buy email packs when credits run low.
- **`create_checkout`** — Stripe top-up to billing balance.

### KMS contract wallets (on-chain signing)

For agents that need to sign Ethereum transactions. Private keys never leave AWS KMS. **$0.04/day rental + $0.000005/call.** Wallet creation requires $1.20 cash credit (30 days prepaid). **Non-custodial.**

- **`provision_contract_wallet`** — `chain: "base-mainnet"` or `"base-sepolia"`. Optional `recovery_address`.
- **`get_contract_wallet`** / **`list_contract_wallets`** — metadata + live balance + USD value.
- **`set_recovery_address`** / **`set_low_balance_alert`** — optional safety nets.
- **`contract_call`** — submit a write call (chain gas at-cost + KMS sign fee). Idempotent on `idempotency_key`.
- **`contract_read`** — read-only call (free).
- **`get_contract_call_status`** — lifecycle, gas, receipt.
- **`drain_contract_wallet`** — drain native balance (works on suspended wallets — the safety valve).
- **`delete_contract_wallet`** — schedule KMS key deletion (refused if balance ≥ dust).

### Allowance & account

- **`init`** — one-shot setup: allowance + faucet + tier check + project list.
- **`status`** — full account snapshot.
- **`allowance_status`** / **`allowance_create`** / **`allowance_export`** — local allowance management.
- **`request_faucet`** — testnet USDC.
- **`check_balance`** — USDC for an allowance address.
- **`list_projects`** — active projects for a wallet.
- **`pin_project`** — pin a project (admin only — bypasses lifecycle state machine).
- **`project_info`** / **`project_keys`** / **`project_use`** — inspect / set the active project.
- **`send_message`** / **`set_agent_contact`** — send feedback to the Run402 team; register agent contact info.

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

After lease expires, projects go through a state machine. The live data plane keeps serving the whole time — only the owner's control plane gets gated:

| State | When | What happens |
|-------|------|--------------|
| `active` | — | Full read/write |
| `past_due` | day 0 | Site, REST, email keep serving. Owner gets first email. |
| `frozen` | +14d | Control plane (deploys, secrets, subdomain claims, function upload) returns 402 with `lifecycle_state` / `entered_state_at` / `next_transition_at`. Site still serves. Subdomain reserved so the brand can't be claimed by another wallet. |
| `dormant` | +44d | Scheduled functions pause. |
| `purged` | +104d | Cascade: schema dropped, Lambdas deleted, mailbox tombstoned. Subdomain becomes claimable 14 days later. |

Calling **`set_tier`** during grace reactivates the project and clears all timers in one transaction. Pinned projects bypass the state machine entirely.

## Standard Workflow

```
1. init                                                    → allowance + faucet
2. set_tier(tier: "prototype")                             → free on testnet
3. provision_postgres_project(name: "my-app")              → keys + project_id
4. run_sql(project_id, sql: "CREATE TABLE …")              → schema
5. apply_expose(project_id, manifest: {…})                 → declare reachability
6. deploy_site_dir(project, dir: "./dist")                 → live URL
7. claim_subdomain(project_id, name: "my-app")             → my-app.run402.com
   (optional) deploy_function(project_id, name, code, …)
   (optional) blob_put(project_id, key, content/local_path) for assets
```

Provision before authoring HTML — the `anon_key` is permanent and you embed it in your frontend.

## Payment Handling

Two payment rails work with the same wallet key:

- **x402** (default): USDC on Base. Prototype uses Base Sepolia testnet (free from faucet); hobby/team use Base mainnet.
- **MPP**: pathUSD on Tempo Moderato (testnet) / Tempo (mainnet). Same wallet key, different chain.

The MCP server handles all signing automatically. When a paid tool returns 402, the response includes payment details as **informational text** (not an error) — guide the user through funding, then retry the same tool call. **`provision_postgres_project`**, **`set_tier`**, **`bundle_deploy`**, and **`generate_image`** are the paid surfaces; everything else is free with an active tier.

For real-money tiers, two paths to fund:

- **Path A — fund the agent allowance**: human sends USDC on Base mainnet to the address from **`allowance_export`**. Agent pays autonomously via x402.
- **Path B — Stripe credits**: **`create_email_billing_account`** with the human's email, then **`tier_checkout`** returns a Stripe URL the human pays once.

Suggest $10 to your human for two Hobby projects, or $20 for one Team plus renewal buffer.

## Tips & Guardrails

- **Provision before authoring HTML.** The `anon_key` is permanent; write your frontend HTML *after* `provision_postgres_project` returns it.
- **Use the manifest for access control**, never raw `GRANT`/`REVOKE` (the SQL endpoint blocks those).
- **`user_owns_rows` is the default for user-scoped data.** Reach for `public_read_write_UNRESTRICTED` only on intentionally-public tables (and pass `i_understand_this_is_unrestricted: true`).
- **Make migrations idempotent** with `CREATE TABLE IF NOT EXISTS` and `DO`-block `ALTER TABLE`.
- **Use the immutable `cdn_url` from `blob_put` directly.** It's correct from the moment of upload — no `wait_for_cdn_freshness` needed for fresh uploads.
- **Don't bake unconditional `request_faucet` calls into deploy scripts** — the faucet rate-limits and breaks already-funded flows.
- **Per-project rate limit is 100 req/sec.** On 429, back off using `retry_after`.
- **`service_status` works without auth.** Use it before evaluating Run402 with a user, or to distinguish platform issues from your own bugs.

## Agent Allowance Setup

The MCP server manages a local agent allowance — a wallet key dedicated to paying Run402, stored at `~/.config/run402/allowance.json` (mode `0600`). You never touch the private key directly.

- **`init`** — composes `allowance_create` + `request_faucet` + `tier_status` + `list_projects`. Use this on a fresh install.
- **`allowance_create`** / **`allowance_status`** / **`allowance_export`** — granular allowance ops.
- **`request_faucet`** — Base Sepolia testnet USDC.
- **`check_balance`** — mainnet + testnet + billing balance for an address.

Other allowance options:
- **Coinbase AgentKit** — MPC wallet on Base with built-in x402.
- **AgentPayy** — auto-bootstraps an MPC wallet on Base via Coinbase CDP.

## Troubleshooting

| You see | Likely cause / fix |
|---|---|
| `402 payment_required` on `set_tier` | Allowance is empty. Call `request_faucet` (testnet) or fund with real USDC. |
| `402` with `lifecycle_state: frozen` | Project past lease + 14 days. `set_tier` reactivates instantly. |
| `403 admin_required` | Tool is admin-only (e.g., `pin_project`). Project owners can't pin their own projects. |
| Empty `[]` from `rest_query` for anon | Table not in manifest with `expose: true`. Call `apply_expose`. |
| `403 forbidden_function` calling an RPC | Function not in the manifest's `rpcs[]`. Add `{ name, signature, grant_to: ["authenticated"] }` and re-apply. |
| `409 reserved` from `claim_subdomain` | Original owner's grace period — subdomain held until +118 days from lease expiry. |
| `429 rate_limited` | 100 req/sec project cap. Back off using `retry_after`. |
| CDN serves old bytes | Use the immutable `cdn_url` from `blob_put`, or call `wait_for_cdn_freshness` on a mutable URL. |
| `422 relation already exists` on redeploy | Wrap migrations in `CREATE TABLE IF NOT EXISTS` + `DO`-block `ALTER TABLE`. |
| `insufficient_funds` right after faucet | Wait for the faucet tx to confirm (~5s on Base Sepolia) before subscribing. |

## Tools Reference

This skill is `run402-mcp` — every action above is an MCP tool. Full parameter schemas live in each tool's MCP description; the skill body teaches you when to reach for which.

For the corresponding HTTP API reference, see <https://run402.com/llms.txt>. For the CLI shape (terminal / shell / CI use cases), see <https://run402.com/llms-cli.txt>.

## Links

- HTTP API reference: <https://run402.com/llms.txt>
- CLI reference: <https://run402.com/llms-cli.txt>
- Status: <https://api.run402.com/status>
- Health: <https://api.run402.com/health>
- npm: [`run402-mcp`](https://www.npmjs.com/package/run402-mcp) · [`run402`](https://www.npmjs.com/package/run402) · [`@run402/sdk`](https://www.npmjs.com/package/@run402/sdk) · [`@run402/functions`](https://www.npmjs.com/package/@run402/functions)
- Homepage: <https://run402.com>
