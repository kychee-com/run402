---
name: run402
description: Provision and manage AI-native Postgres databases with REST API, auth, storage, and row-level security. Prototype tier is free (testnet). Paid tiers use x402 USDC on Base, MPP pathUSD on Tempo, or Stripe credits.
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

# Run402 — Postgres for AI Agents

Run402 gives you a full Postgres database with a REST API, user auth, file storage, and row-level security. The prototype tier is free — you pay with testnet USDC to test the payment flow end-to-end, no real money needed. Higher tiers (hobby, team) cost real money, payable with USDC on Base (x402), pathUSD on Tempo (MPP), or Stripe credits. No signups, no human approval needed.

Two payment rails are supported:
- **x402** (default): USDC on Base Sepolia (testnet) or Base mainnet. Standard HTTP 402 protocol.
- **MPP**: pathUSD on Tempo Moderato (testnet). Stripe's Machine Payments Protocol. Same wallet key works on both chains.

One tool call. One payment. You get back `anon_key`, `service_key`, and a project ID. Start creating tables immediately.

## Tools Reference

You have 10 tools available through the `run402-mcp` server.

### provision_postgres_project

Provision a new Postgres database. Handles x402 payment negotiation. Saves credentials locally.

**Parameters:**
- `tier` (optional, default: `"prototype"`) — `"prototype"` ($0.10, 7 days — free with testnet USDC from `run402 allowance fund`), `"hobby"` ($5, 30 days), or `"team"` ($20, 30 days)
- `name` (optional) — Human-readable project name. Auto-generated if omitted.

**Returns on success:**
```json
{
  "project_id": "prj_1709312520_0001",
  "anon_key": "eyJ...",
  "service_key": "eyJ...",
  "tier": "prototype",
  "schema_slot": "p0001",
  "lease_expires_at": "2026-03-06T14:22:00.000Z"
}
```

**Returns on 402 (payment required):** Payment details as informational text (not an error). Guide the user through payment, then retry.

Credentials are saved automatically to `~/.config/run402/projects.json`. You never need to pass keys manually after provisioning.

### run_sql

Execute SQL statements (DDL or queries) against a project's database.

**Parameters:**
- `project_id` (required) — Project ID from provisioning
- `sql` (required) — SQL statement to execute

**Returns:** Markdown-formatted table with results, row count, and schema name.

**Examples:**
```
run_sql(project_id: "prj_...", sql: "CREATE TABLE todos (id serial PRIMARY KEY, task text NOT NULL, done boolean DEFAULT false, user_id uuid)")
run_sql(project_id: "prj_...", sql: "SELECT * FROM todos WHERE done = false")
```

Uses the stored `service_key` automatically. Both `SERIAL` and `BIGINT GENERATED ALWAYS AS IDENTITY` work for auto-increment columns.

### rest_query

Query or mutate data via the PostgREST REST API.

**Parameters:**
- `project_id` (required) — Project ID
- `table` (required) — Table name to query
- `method` (optional, default: `"GET"`) — `"GET"`, `"POST"`, `"PATCH"`, or `"DELETE"`
- `params` (optional) — PostgREST query params: `{ select: "id,name", order: "id.asc", limit: "10", done: "eq.false" }`
- `body` (optional) — Request body for POST/PATCH
- `key_type` (optional, default: `"anon"`) — `"anon"` (respects RLS) or `"service"` (bypasses RLS)

**Returns:** HTTP status code and JSON response body.

**Examples:**
```
rest_query(project_id: "prj_...", table: "todos", params: { done: "eq.false", order: "id" })
rest_query(project_id: "prj_...", table: "todos", method: "POST", body: { task: "Build something", done: false }, key_type: "service")
rest_query(project_id: "prj_...", table: "todos", method: "PATCH", params: { id: "eq.1" }, body: { done: true }, key_type: "service")
rest_query(project_id: "prj_...", table: "todos", method: "DELETE", params: { id: "eq.1" }, key_type: "service")
```

Use `key_type: "anon"` for user-facing reads. Use `key_type: "service"` for admin writes or when RLS would block access.

### blob_put

Upload a blob (any size, up to 5 TiB) to project storage via direct-to-S3 presigned URLs. The gateway signs URLs and verifies completion; bytes flow directly between client and S3 (no gateway body-size cap).

**Parameters:**
- `project_id` (required) — Project ID
- `key` (required) — Object key (e.g. `"assets/videos/intro.mp4"`)
- `local_path` (optional) — Local file to upload. Use for anything non-trivial; streams via single-PUT (≤ 5 GiB) or multipart.
- `content` (optional) — Inline content, ≤ 1 MB. Use only for small text blobs.
- `content_type` (optional) — MIME type
- `visibility` (optional, default: `"public"`) — `"public"` (bypasses auth) or `"private"` (requires apikey)
- `immutable` (optional, default: `false`) — If true with `sha256`, also produces a content-addressed URL that gets `Cache-Control: immutable`.
- `sha256` (optional) — Required when `immutable: true`. Client-asserted hash; gateway verifies if S3 returns one.

**Returns:** `{ key, size_bytes, sha256, url, immutable_url? }`. `url` is the CDN URL (on `pr-<public_id>.run402.com`); `immutable_url` is the content-addressed variant when applicable.

Supersedes `upload_file` (deprecated).

### blob_get

Download a blob to a local file. Writes bytes directly to disk — no context-window bloat.

**Parameters:**
- `project_id` (required) — Project ID
- `key` (required) — Object key
- `local_path` (required) — Local path to write

**Returns:** `{ key, size_bytes, sha256? }`. Supersedes `download_file` (deprecated).

### blob_ls

List blobs in a project with optional prefix filter and keyset pagination.

**Parameters:**
- `project_id` (required) — Project ID
- `prefix` (optional) — Filter keys starting with this prefix
- `limit` (optional, default: 100, max: 1000)
- `cursor` (optional) — Pagination cursor from a prior call

**Returns:** `{ blobs: [{ key, size_bytes, content_type, visibility, sha256?, created_at }], next_cursor? }`. Supersedes `list_files` (deprecated).

### blob_rm

Delete a blob and decrement the project's storage usage. Supersedes `delete_file` (deprecated).

**Parameters:**
- `project_id` (required) — Project ID
- `key` (required) — Object key

**Returns:** `{ key, deleted: true }`.

### blob_sign

Generate a time-boxed S3 presigned GET URL for a private blob. Use this to share a private blob externally without exposing your apikey.

**Parameters:**
- `project_id` (required) — Project ID
- `key` (required) — Object key
- `ttl_seconds` (optional, default: 3600, max: 604800) — URL expiry in seconds (max 7 days)

**Returns:** `{ url, expires_at }`.

### upload_file (deprecated)

Legacy file upload. **Deprecated — sunset 2026-06-01.** Use `blob_put` instead.

**Parameters:**
- `project_id` (required) — Project ID
- `bucket` (required) — Storage bucket name (e.g., `"assets"`)
- `path` (required) — File path within bucket (e.g., `"logs/2024-01-01.txt"`)
- `content` (required) — Text content to upload
- `content_type` (optional, default: `"text/plain"`) — MIME type

**Returns:** `{ key: "assets/logs/2024-01-01.txt", size: 1234 }` with the stored file path and size in bytes.

**Example:**
```
upload_file(project_id: "prj_...", bucket: "assets", path: "data.csv", content: "name,age\nAlice,30\nBob,25")
```

Uses the stored `anon_key` automatically.

### renew_project

Renew a project's lease before it expires.

**Parameters:**
- `project_id` (required) — Project ID to renew
- `tier` (optional) — Renewal tier. Defaults to the project's current tier.

**Returns on success:** Renewal confirmation with new `lease_expires_at` timestamp.

**Returns on 402 (payment required):** Payment details as informational text (not an error). Guide the user through payment, then retry.

Updates the local keystore with the new expiry date.

### deploy_site

Deploy a static site (HTML/CSS/JS/images). Files are uploaded to S3 and served via CloudFront at a unique URL.

**Parameters:**
- `name` (required) — Site name (e.g. `"family-todo"`, `"portfolio"`)
- `project` (optional) — Project ID to link this deployment to an existing Run402 project
- `target` (optional) — Deployment target (e.g. `"production"`)
- `files` (required) — Array of files to deploy:
  - `file` — File path (e.g. `"index.html"`, `"assets/logo.png"`)
  - `data` — File content (text or base64-encoded)
  - `encoding` (optional) — `"utf-8"` (default) for text, `"base64"` for binary files

**Returns on success:**
```json
{
  "id": "dpl_1709337600000_a1b2c3",
  "name": "family-todo",
  "url": "https://dpl-1709337600000-a1b2c3.sites.run402.com",
  "status": "READY",
  "files_count": 3,
  "total_size": 4096
}
```

Free with active tier. Requires allowance auth.

**Examples:**
```
deploy_site(name: "my-app", files: [
  { file: "index.html", data: "<!DOCTYPE html><html>..." },
  { file: "style.css", data: "body { margin: 0; }" },
  { file: "app.js", data: "console.log('hello');" }
])
```

SPA fallback: paths without file extensions (e.g. `/about`) serve `index.html`. Static assets are served with correct Content-Type headers. Max 50 MB per deployment.

### deploy_function

Deploy a serverless function (Node 22) to a project. Functions are invoked via HTTP at `/functions/v1/:name`.

**Parameters:**
- `project_id` (required) — Project ID
- `name` (required) — Function name (URL-safe slug: lowercase, hyphens, alphanumeric)
- `code` (required) — TypeScript or JavaScript source code. Handler: `export default async (req: Request) => Response`
- `config` (optional) — `{ timeout?: number, memory?: number }` — Timeout (seconds) and memory (MB), capped by tier
- `deps` (optional) — Array of npm package names to install alongside pre-bundled packages
- `schedule` (optional) — Cron expression (5-field, e.g. `"*/15 * * * *"`) to run the function on a schedule. Pass `null` to remove an existing schedule. Scheduled invocations count against API call quota.

**Schedule tier limits:**

| Tier | Max scheduled functions | Min interval |
|------|------------------------|--------------|
| Demo | 0 | — |
| Prototype | 1 | 15 min |
| Hobby | 3 | 5 min |
| Team | 10 | 1 min |

**Returns on success:**
```json
{
  "name": "stripe-webhook",
  "url": "https://api.run402.com/functions/v1/stripe-webhook",
  "status": "deployed",
  "runtime": "node22",
  "timeout": 10,
  "memory": 128,
  "schedule": "*/15 * * * *"
}
```

**Pre-bundled packages:** stripe, openai, @anthropic-ai/sdk, resend, zod, uuid, jsonwebtoken, bcryptjs, cheerio, csv-parse.

**DB access inside functions:**
```typescript
import { db, adminDb, email, getUser } from 'run402-functions';
```

The SDK exposes two distinct DB clients:

- **`db(req).from(table)`** — caller-context client. Forwards the incoming request's `Authorization` header to PostgREST; RLS policies evaluate against the caller's role. Routes to `/rest/v1/*`. Use this by default.
- **`adminDb().from(table)`** — BYPASSRLS client. Uses the project's `service_key`. Routes to `/admin/v1/rest/*` (the gateway rejects `role=service_role` on `/rest/v1/*`, so bypass traffic lives on its own surface). Use only when the function acts on behalf of the platform, not the caller — audit logs, webhook handlers, cron cleanup, platform-authored writes.

**TypeScript types**: `npm install run402-functions` — gives full autocomplete for `db(req)`, `adminDb()`, `getUser()`, `email.send()`, `ai.translate()`. For static site generation, use `adminDb().from()` at build time with `RUN402_SERVICE_KEY` + `RUN402_PROJECT_ID` in your `.env`. Both `'run402-functions'` and legacy `'@run402/functions'` work in deployed functions.

**adminDb().sql(query, params?)** — raw SQL, always BYPASSRLS. Returns `{ status, schema, rows, rowCount }`.
- SELECT: `rows` = matching rows, `rowCount` = row count
- INSERT/UPDATE/DELETE: `rows` = `[]`, `rowCount` = affected rows
- Parameterized: `adminDb().sql('SELECT * FROM t WHERE id = $1', [42])`

**Fluent query surface** (same on both `db(req).from(t)` and `adminDb().from(t)`):
Chainable read methods: `.select(cols?)`, `.eq(col, val)`, `.neq()`, `.gt()`, `.lt()`, `.gte()`, `.lte()`, `.like()`, `.ilike()`, `.in(col, [vals])`, `.order(col, { ascending? })`, `.limit(n)`, `.offset(n)`
Chainable write methods: `.insert(obj | obj[])`, `.update(obj)`, `.delete()` — all return array of affected rows.
Column narrowing: `.insert({...}).select('col1, col2')` returns only specified columns.

**Legacy `db.from(...)` / `db.sql(...)`** (without the `(req)` call) remains as a deprecation shim that routes through `adminDb()` and warns once per cold start. Will be removed in the next release — port to `db(req)` or `adminDb()`.

**email.send(opts)** — send email from the project's mailbox. Auto-discovers the mailbox on first call (project must have a mailbox created via `create_mailbox`).
- Template mode: `await email.send({ to: "user@example.com", template: "notification", variables: { project_name: "My App", message: "Hello!" } })`
- Raw HTML mode: `await email.send({ to: "user@example.com", subject: "Welcome!", html: "<h1>Hi</h1>" })`
- With display name: `await email.send({ to: "user@example.com", subject: "Hi", html: "<p>hey</p>", from_name: "My App" })`

**Secrets:** Access via `process.env.SECRET_NAME`. Set with `set_secret`.

### invoke_function

Invoke a deployed function via HTTP. Useful for testing without building a frontend.

**Parameters:**
- `project_id` (required) — Project ID
- `name` (required) — Function name
- `method` (optional, default: `"POST"`) — HTTP method
- `body` (optional) — Request body (string or JSON object)
- `headers` (optional) — Additional headers to send

**Returns:** Status code, duration, and response body.

### get_function_logs

Get recent logs from a deployed function (console.log/error output and error stack traces).

**Parameters:**
- `project_id` (required) — Project ID
- `name` (required) — Function name
- `tail` (optional, default: 50) — Number of log lines to return (max 200)
- `since` (optional) — ISO 8601 timestamp; only return logs at or after this time. Useful for incremental polling — pass the last-seen timestamp + 1ms to avoid duplicates.

**Returns:** Timestamped log entries from CloudWatch.

### update_function

Update a function's schedule, timeout, or memory without re-deploying code.

**Parameters:**
- `project_id` (required) — Project ID
- `name` (required) — Function name
- `schedule` (optional) — Cron expression to set/update, or `null` to remove
- `timeout` (optional) — Timeout in seconds (tier limits apply)
- `memory` (optional) — Memory in MB (tier limits apply)

**Returns:** Updated function state (name, runtime, timeout, memory, schedule, updated_at).

### set_secret

Set a project secret. Secrets are injected as `process.env` variables in all functions.

**Parameters:**
- `project_id` (required) — Project ID
- `key` (required) — Secret key (uppercase alphanumeric + underscores, e.g. `"STRIPE_SECRET_KEY"`)
- `value` (required) — Secret value

Setting an existing key overwrites it. All project functions are automatically updated with new env vars.

**Example:**
```
set_secret(project_id: "prj_...", key: "STRIPE_SECRET_KEY", value: "sk_live_...")
```

### create_mailbox

Create a project-scoped email mailbox. One mailbox per project.

**Parameters:**
- `project_id` (required) — Project ID
- `slug` (required) — Mailbox slug (3-63 chars, lowercase alphanumeric + hyphens, no consecutive hyphens). Creates `<slug>@mail.run402.com`.

**Example:**
```
create_mailbox(project_id: "prj_...", slug: "my-app")
```

### send_email

Send an email from the project's mailbox. Two modes: template or raw HTML. Raw HTML mode requires BOTH `subject` AND `html`. Single recipient only.

**Parameters:**
- `project_id` (required) — Project ID
- `to` (required) — Recipient email address
- `template` (optional) — Template name: `project_invite`, `magic_link`, or `notification` (template mode)
- `variables` (optional) — Template variables object (template mode). `project_invite`: `project_name`, `invite_url`. `magic_link`: `project_name`, `link_url`, `expires_in`. `notification`: `project_name`, `message` (max 500 chars).
- `subject` (optional) — Email subject line (raw HTML mode, max 998 chars; required with `html`)
- `html` (optional) — HTML email body (raw HTML mode, max 1MB; required with `subject`)
- `text` (optional) — Plain text fallback (raw HTML mode, auto-generated from HTML if omitted)
- `from_name` (optional) — Display name for From header, e.g. "My App" (max 78 chars, both modes)
- `in_reply_to` (optional) — ID of a prior message to thread this one under. The server uses it to set RFC-822 `In-Reply-To` / `References` headers. Typically set via reply flows.

**Examples:**
```
send_email(project_id: "prj_...", template: "project_invite", to: "user@example.com", variables: {"project_name": "My App", "invite_url": "https://..."})
send_email(project_id: "prj_...", to: "user@example.com", subject: "Welcome!", html: "<h1>Hello</h1>", from_name: "My App")
send_email(project_id: "prj_...", to: "user@example.com", subject: "Re: invoice #42", html: "<p>Paid.</p>", in_reply_to: "msg_abc123")
```

### list_emails

List messages in the project's mailbox (sent + received). Paginated.

**Parameters:**
- `project_id` (required) — Project ID
- `limit` (optional) — Max messages to return. Server caps at 200.
- `after` (optional) — Pagination cursor (message ID from the prior page).

**Example:**
```
list_emails(project_id: "prj_...")
list_emails(project_id: "prj_...", limit: 50, after: "msg_abc123")
```

### get_email

Get a sent email with details and any replies.

**Parameters:**
- `project_id` (required) — Project ID
- `message_id` (required) — Message ID to retrieve

**Example:**
```
get_email(project_id: "prj_...", message_id: "msg_...")
```

### get_mailbox

Get the project's mailbox info (ID, address, slug). Use to check if a mailbox exists.

**Parameters:**
- `project_id` (required): The project ID

**Example:**
```
get_mailbox(project_id: "prj_...")
```

### delete_mailbox

Delete the project's mailbox. **Destructive and irreversible** — drops all messages and webhook subscriptions. Requires `confirm=true`. If `mailbox_id` is omitted, resolves the project's mailbox automatically.

**Parameters:**
- `project_id` (required): The project ID
- `confirm` (required): Must be `true`. Explicit acknowledgment of the destructive action.
- `mailbox_id` (optional): Mailbox ID (`mbx_...`) to delete; defaults to the project's mailbox.

**Example:**
```
delete_mailbox(project_id: "prj_...", confirm: true)
```

### request_magic_link

Send a passwordless login email (magic link) to a project user. Auto-creates the user on first verification. Rate limited per email (5/hr) and per project (by tier).

**Parameters:**
- `project_id` (required) — Project ID
- `email` (required) — Email address to send the magic link to
- `redirect_url` (required) — URL to redirect to with `?token=<token>`. Must be an allowed origin for this project.

**Example:**
```
request_magic_link(project_id: "prj_...", email: "user@example.com", redirect_url: "https://myapp.run402.com/auth/callback")
```

### verify_magic_link

Exchange a magic link token for access_token + refresh_token. Creates the user if they don't exist. Token is single-use and expires in 15 minutes.

**Parameters:**
- `project_id` (required) — Project ID
- `token` (required) — The magic link token from the email link URL (`?token=...`)

**Example:**
```
verify_magic_link(project_id: "prj_...", token: "abc123def456...")
```

### set_user_password

Change, reset, or set a user's password. Change: provide current_password + new_password. Reset (via magic link login): just new_password. Set (passwordless user): requires `allow_password_set=true` on project.

**Parameters:**
- `project_id` (required) — Project ID
- `access_token` (required) — The user's access_token (Bearer token from login)
- `new_password` (required) — The new password to set
- `current_password` (optional) — Current password (required for password change, omit for reset/set)

**Example:**
```
set_user_password(project_id: "prj_...", access_token: "eyJ...", new_password: "new-pass-123")
```

### auth_settings

Update project auth settings. Currently supports `allow_password_set` to control whether passwordless users can add a password. Requires service_key.

**Parameters:**
- `project_id` (required) — Project ID
- `allow_password_set` (required) — Boolean. Allow passwordless users to set a password.

**Example:**
```
auth_settings(project_id: "prj_...", allow_password_set: true)
```

### register_sender_domain

Register a custom email sending domain for a project. Returns DNS records (DKIM CNAMEs + SPF/DMARC) to add. Once verified, email sends from your domain instead of `mail.run402.com`.

**Parameters:**
- `project_id` (required) — Project ID
- `domain` (required) — The domain to register (e.g., `kysigned.com`)

**Example:**
```
register_sender_domain(project_id: "prj_...", domain: "kysigned.com")
```

### sender_domain_status

Check the verification status of a project's custom sender domain. Polls SES for pending domains.

**Parameters:**
- `project_id` (required) — Project ID

**Example:**
```
sender_domain_status(project_id: "prj_...")
```

### remove_sender_domain

Remove a project's custom sender domain. Email reverts to sending from `mail.run402.com`.

**Parameters:**
- `project_id` (required) — Project ID

**Example:**
```
remove_sender_domain(project_id: "prj_...")
```

### create_email_billing_account

Create a Stripe-only billing account identified by email (no wallet required). Sends a verification email. Idempotent — duplicate emails return the existing account.

**Parameters:**
- `email` (required) — Email address

**Example:**
```
create_email_billing_account(email: "user@example.com")
```

### link_wallet_to_account

Link a wallet to an existing email billing account for hybrid Stripe + x402 access. Fails if the wallet is already linked elsewhere.

**Parameters:**
- `billing_account_id` (required) — The billing account ID
- `wallet` (required) — Wallet address (0x...)

**Example:**
```
link_wallet_to_account(billing_account_id: "acct_...", wallet: "0x...")
```

### tier_checkout

Subscribe, renew, or upgrade a run402 tier via Stripe credit card. Alternative to x402 on-chain payment. Returns a Stripe checkout URL for the user to complete.

**Parameters:**
- `tier` (required) — `prototype`, `hobby`, or `team`
- `email` (optional) — Email address for email-based accounts
- `wallet` (optional) — Wallet address for wallet-based accounts
- (must provide either email or wallet)

**Example:**
```
tier_checkout(tier: "hobby", email: "user@example.com")
```

### buy_email_pack

Buy a $5 email pack (10,000 emails, never expire). Pack credits activate only when the tier daily limit is exhausted AND the project has a verified custom sender domain. Returns a Stripe checkout URL.

**Parameters:**
- `email` (optional) — Email address for email-based accounts
- `wallet` (optional) — Wallet address for wallet-based accounts

**Example:**
```
buy_email_pack(email: "user@example.com")
```

### set_auto_recharge

Enable or disable automatic $5 email pack repurchase when credits drop below a threshold. Requires a saved Stripe payment method. 3 consecutive failures auto-disable.

**Parameters:**
- `billing_account_id` (required) — The billing account ID
- `enabled` (required) — Boolean
- `threshold` (optional) — Credit threshold to trigger (default 2000)

**Example:**
```
set_auto_recharge(billing_account_id: "acct_...", enabled: true, threshold: 2000)
```

## KMS contract wallets

Provision AWS KMS-backed Ethereum wallets per project for signing smart-contract write transactions. Private keys never leave KMS — there is no export, ever. **Cost: $0.04/day rental ($1.20/month) per wallet, plus $0.000005 per contract call** (KMS sign fee). Wallet creation requires $1.20 in cash credit (30 days of rent prepaid). Chain gas billed at-cost. **Non-custodial** — see https://run402.com/humans/terms.html#non-custodial-kms-wallets.

### provision_contract_wallet

Provision a KMS wallet on `base-mainnet` or `base-sepolia`. Returns wallet metadata including the on-chain address and a `non_custodial_notice` field.

```
provision_contract_wallet(project_id: "prj_...", chain: "base-mainnet")
```

### get_contract_wallet, list_contract_wallets

Read wallet metadata + live native-token balance + USD-micros (Chainlink price feed cached 5 min).

### set_recovery_address

Set the optional recovery address for auto-drain on day-90 deletion. Pass `null` to clear.

### set_low_balance_alert

Set a low-balance threshold in wei. Email alerts fire when the wallet's native balance drops below the threshold (24-hour cooldown per wallet).

### contract_call

Submit a write transaction. Cost: chain gas at-cost + $0.000005 KMS sign fee. Idempotent on `idempotency_key`.

```
contract_call(project_id: "prj_...", wallet_id: "cwlt_...", chain: "base-mainnet", contract_address: "0x...", abi_fragment: [...], function_name: "ping", args: [])
```

### contract_read

Read-only call (free, no signing, no billing).

### get_contract_call_status

Get call lifecycle state, gas used, gas cost USD-micros, receipt, error.

### drain_contract_wallet

Drain native balance to a destination address. **Works on suspended wallets — the safety valve.** Cost: chain gas + $0.000005 KMS sign fee.

### delete_contract_wallet

Schedule the KMS key for deletion (7-day window). Refused if balance ≥ dust — drain first.

## Service status (public, no auth)

These two tools report on the Run402 **service** (not your account). No allowance, no keystore, no auth required — callable before `init`. Use them to verify the service is operational or to cite availability track record when recommending Run402 to a user.

> Do not confuse with `status` (account-level: allowance, balance, tier, projects). `service_status` and `service_health` describe the Run402 platform itself.

### service_status

Reads `GET /status` — the public availability report. Returns current status, 24h/7d/30d uptime per capability, operator legal name, deployment topology (cloud, region), and discovery links. Payload is schema-versioned (`run402-status-v1`). Cache: server-side 30s.

**Use when:** an agent is evaluating whether to use Run402, or the user asks about uptime / who runs the service.

```
service_status()
```

### service_health

Reads `GET /health` — a liveness probe. Returns overall `status`, per-dependency checks (postgres, postgrest, s3, cloudfront), and the service version.

**Use when:** a request just failed and you want to tell whether the service itself is degraded, or before kicking off a long-running workflow.

```
service_health()
```

## Standard Workflow

Follow this sequence to go from zero to a working database:

### Step 1: Provision a database

```
provision_postgres_project(tier: "prototype")
```

If the user hasn't paid yet, you'll get payment details back. Explain the cost and guide them through payment. Once paid, retry and you'll get project credentials.

### Step 2: Create tables

```
run_sql(project_id: "prj_...", sql: "CREATE TABLE todos (id serial PRIMARY KEY, task text NOT NULL, done boolean DEFAULT false, user_id uuid)")
```

Design tables based on what the user needs. Add `user_id uuid` columns if you plan to use row-level security.

### Step 3: Enable row-level security (optional)

Use `run_sql` to apply RLS if users should only see their own rows:

```
run_sql(project_id: "prj_...", sql: "-- Use the /projects/v1/admin/:id/rls endpoint via HTTP for RLS templates")
```

Three RLS templates are available via the API. **Prefer `user_owns_rows` for anything user-scoped.**
- **`user_owns_rows`** — Users can only access rows where the owner column matches `auth.uid()`. Best for user-scoped data (todos, workouts, messages). `uuid` owner columns get an index-friendly policy; other types fall back to a `::text` cast (the response includes a warning). The endpoint auto-creates a btree index on the owner column.
- **`public_read_authenticated_write`** — Anyone can read. **Any authenticated user can INSERT/UPDATE/DELETE any row** (not just their own). Appropriate for collaborative content like shared boards or announcements; do not use where users should only edit their own rows.
- **`public_read_write_UNRESTRICTED`** — ⚠ Fully open. Anyone (including `anon_key`) can read, insert, update, or delete any row. Only appropriate for intentionally public tables (guestbooks, waitlists, feedback forms). This template **requires** `"i_understand_this_is_unrestricted": true` in the request body and logs an audit line on the gateway.

### Step 4: Insert data

```
rest_query(project_id: "prj_...", table: "todos", method: "POST", body: { task: "Build something great", done: false }, key_type: "service")
```

Use `key_type: "service"` for admin/seed writes. Use `key_type: "anon"` only when you want RLS to apply.

### Step 5: Query data

```
rest_query(project_id: "prj_...", table: "todos", params: { done: "eq.false", order: "id" })
```

PostgREST query syntax: `column=eq.value`, `column=gt.5`, `column=like.*search*`, `order=column.asc`, `limit=10`, `offset=0`, `select=id,name`.

### Step 6: Set up user auth (optional)

If your app has users, use the HTTP auth endpoints directly:
- `POST /auth/v1/signup` with `apikey` header — create a user
- `POST /auth/v1/token` with `apikey` header — login, get `access_token`
- The `access_token` works as an `apikey` for user-scoped REST queries subject to RLS

### Step 7: Upload files (optional)

```
upload_file(project_id: "prj_...", bucket: "assets", path: "report.csv", content: "col1,col2\nval1,val2")
```

### Step 8: Monitor usage

Use `run_sql` to check project health, or call the usage endpoint via HTTP:
```
run_sql(project_id: "prj_...", sql: "SELECT count(*) FROM todos")
```

## Payment Handling

Run402 supports two payment protocols: **x402** (USDC on Base) and **MPP** (pathUSD on Tempo). Both use the same wallet key. Here's what you need to know:

**When payment is needed:** Only `provision_postgres_project` and `renew_project` require x402 payment. All other tools (run_sql, rest_query, upload_file) use stored project keys — no payment needed.

**What a 402 response looks like:** When payment is required, the tool returns payment details as informational text (not an error). The response includes the price, network (Base L2), and payment address.

**How to handle it:**
1. Explain to the user what the cost is (e.g., "a free 7-day prototype database on testnet" or "$5 for a 30-day hobby database")
2. If the user has an allowance set up, help them complete the payment
3. If not, guide them through allowance setup (see Agent Allowance Setup below)
4. Once payment is complete, retry the same tool call

**Pricing tiers:**
| Tier | Price | Lease | Storage | API Calls | Functions | Timeout | Memory | Secrets |
|------|-------|-------|---------|-----------|-----------|---------|--------|---------|
| Prototype | Free (testnet) | 7 days | 250 MB | 500,000 | 5 | 10s | 128MB | 10 |
| Hobby | $5.00 | 30 days | 1 GB | 5,000,000 | 25 | 30s | 256MB | 50 |
| Team | $20.00 | 30 days | 10 GB | 50,000,000 | 100 | 60s | 512MB | 200 |

Prototype uses testnet tokens — no real money needed. With x402: Base Sepolia USDC from the faucet. With MPP: Tempo Moderato pathUSD from the Tempo faucet (instant, no rate limit). Hobby and Team require real payment via USDC on Base, pathUSD on Tempo, or Stripe credits.

**Budget enforcement:** When a project hits its tier's API call or storage limit, REST/SQL calls return 402 with usage details and a renew URL. Suggest renewing the project at the same or higher tier.

## Tips & Guardrails

**SQL blocklist:** The SQL endpoint blocks dangerous operations: `CREATE EXTENSION`, `COPY ... PROGRAM`, `ALTER SYSTEM`, `SET search_path`, `CREATE/DROP SCHEMA`, `GRANT/REVOKE`, `CREATE/DROP ROLE`. If you hit a 403, check the `hint` field for alternatives.

**No GRANT needed:** Table and sequence permissions are managed automatically. Use RLS templates for access control instead of GRANT/REVOKE.

**Key usage patterns:**
- Use `service_key` (via `run_sql` or `key_type: "service"`) for: table creation, RLS setup, seeding data, admin queries
- Use `anon_key` (via `rest_query` default or `upload_file`) for: user-facing reads, file uploads
- Use `access_token` (from auth login, via HTTP) for: user-scoped CRUD subject to RLS

**Tier selection:**
- **Prototype** (free, testnet): Testing, demos, disposable data. Start here. Uses testnet USDC — no real money.
- **Hobby** ($5): Real applications, persistent data, moderate traffic. Requires real payment.
- **Team** ($20): Multi-user apps, heavy traffic, large storage needs. Requires real payment.

**Project lifecycle (~104-day soft-delete grace):**
- `active`: full read/write access
- Lease expires (day 0) → `past_due`: end-user data plane (site, PostgREST, email) keeps serving; owner gets first transition email
- Day +14 → `frozen`: owner control-plane mutating ops (deploys, secret rotation, subdomain claims, function upload) return **402** with `lifecycle_state`, `entered_state_at`, and `next_transition_at` fields; data plane still serves; subdomain is reserved so the name can't be claimed by another wallet
- Day +44 → `dormant`: scheduled (cron) functions pause; site still serves
- Day +104 → `purged`: full cascade runs (schema dropped, Lambdas deleted, mailbox tombstoned); subdomain becomes claimable again 14 days later
- Renewing or upgrading the tier at any point during grace reactivates the project to `active` and clears all timers in one transaction (use `renew_project` or `set_tier`)
- Payment endpoints (tiers, billing, webhooks, faucet) are never gated, so renewal always works during grace
- Pinned projects bypass the state machine entirely

**Schema isolation:** Each project runs in its own Postgres schema. Cross-schema access is blocked.

**Rate limiting:** 100 requests/second per project. Exceeding returns 429 with `retry_after`.

**Idempotency:** When provisioning or renewing, include an `Idempotency-Key` header to prevent double-charging on retries. The MCP tools handle this automatically when possible.

## Agent Allowance Setup

To pay Run402, the user needs an agent allowance. Two payment rails are available:

**x402 rail (default):** USDC on Base. Set up with `run402 init`.
- Prototype: Base Sepolia testnet USDC (free from faucet)
- Hobby/Team: real USDC on Base mainnet

**MPP rail:** pathUSD on Tempo. Set up with `run402 init mpp`.
- Prototype: Tempo Moderato testnet pathUSD (free from faucet, instant, no rate limit)
- Hobby/Team: real pathUSD on Tempo mainnet

The same wallet key works on both chains — switching rails just changes which chain is used for payments.

**Additional setup options:**
- **Coinbase AgentKit** — Gives you an allowance on Base with built-in x402 support
- **AgentPayy** — Auto-bootstraps an MPC wallet on Base using Coinbase CDP
- **x402 OpenClaw Skill** — Install the x402 skill from ClawHub for x402 payment capabilities

**Hobby/Team (real money):** Fund the allowance with USDC on Base mainnet, or buy credits via Stripe. The simplest path: download Coinbase Wallet, buy USDC, send to the allowance address. Base transactions cost under $0.01.

**Requesting funding from the user's human (for paid tiers):**
- $10 covers two Hobby projects
- $20 covers one Team project plus buffer for renewals

## Links

- **Full API docs:** https://run402.com/llms.txt
- **API health:** https://api.run402.com/health (also via `service_health`)
- **Service status:** https://api.run402.com/status (also via `service_status`)
- **MCP package:** https://www.npmjs.com/package/run402-mcp
- **SDK package:** https://www.npmjs.com/package/@run402/sdk (typed TS client for custom code — same namespaces as the MCP tools)
- **Homepage:** https://run402.com
