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
- `tier` (optional, default: `"prototype"`) — `"prototype"` (free/testnet, 7 days), `"hobby"` ($5, 30 days), or `"team"` ($20, 30 days)
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

### upload_file

Upload text content to project storage (S3-backed).

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

**Returns on success:**
```json
{
  "name": "stripe-webhook",
  "url": "https://api.run402.com/functions/v1/stripe-webhook",
  "status": "deployed",
  "runtime": "node22",
  "timeout": 10,
  "memory": 128
}
```

**Pre-bundled packages:** stripe, openai, @anthropic-ai/sdk, resend, zod, uuid, jsonwebtoken, bcryptjs, cheerio, csv-parse.

**DB access inside functions:**
```typescript
import { db } from '@run402/functions';
const users = await db.from('users').select('*');
const result = await db.sql('SELECT count(*) FROM orders');
```

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

**Returns:** Timestamped log entries from CloudWatch.

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

Three RLS templates are available via the API:
- **`user_owns_rows`** — Users can only access rows where `owner_column = auth.uid()`. Best for user-scoped data.
- **`public_read`** — Anyone can read. Only authenticated users can write.
- **`public_read_write`** — Anyone can read and write. Use for guestbooks, public logs.

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

**Lease lifecycle:**
- Active: full read/write access
- Expired (day 0): read-only for 7 days
- Grace period ends (day 7): archived, no access
- Permanent deletion at day 37 after expiry
- Renew anytime before deletion with `renew_project`

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
- **API health:** https://api.run402.com/health
- **MCP package:** https://www.npmjs.com/package/run402-mcp
- **Homepage:** https://run402.com
