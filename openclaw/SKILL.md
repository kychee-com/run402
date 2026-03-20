---
name: run402
description: Provision Postgres databases, deploy static sites, generate images, and build full-stack webapps on Run402 using x402 or MPP micropayments. Use when the user asks to build a webapp, deploy a site, create a database, generate images, or mentions Run402.
---

# Run402 — AI-Native Postgres & Static Hosting

API base: `https://api.run402.com` (NOT `run402.com` — that's a static docs site, POSTing returns 405)

---

## Quick Start: Build & Deploy a Full-Stack App

Three steps. Takes ~60 seconds on testnet (free).

### Step 1: Allowance Setup (once)

```bash
node <skill_dir>/scripts/allowance.mjs status
# If no allowance:
node <skill_dir>/scripts/allowance.mjs create
node <skill_dir>/scripts/allowance.mjs fund
# Wait ~10s for faucet settlement
```

Agent allowance persists at `~/.config/run402/allowance.json`. Faucet gives 0.25 testnet USDC (enough for 2 prototype deploys). Rate limit: 1 per IP per 24h — don't call if already funded.

### Step 2: Build a Manifest

```json
{
  "name": "my-app",
  "migrations": "CREATE TABLE items (id serial PRIMARY KEY, title text NOT NULL, done boolean DEFAULT false, user_id uuid, created_at timestamptz DEFAULT now());",
  "rls": {
    "template": "user_owns_rows",
    "tables": [{ "table": "items", "owner_column": "user_id" }]
  },
  "site": [
    { "file": "index.html", "data": "<!DOCTYPE html>..." },
    { "file": "style.css", "data": "body { ... }" }
  ],
  "subdomain": "my-app"
}
```

All fields except `name` are optional. Can also include `secrets`, `functions`.

### Step 3: Deploy

```bash
echo '<manifest_json>' | node <skill_dir>/scripts/deploy.mjs --tier prototype
```

Returns project_id, keys, live URL. Saved to `~/.config/run402/projects.json`.

**Tiers:** prototype (free/testnet, 7d, 250MB, 500k calls), hobby ($5, 30d, 1GB, 5M calls), team ($20, 30d, 10GB, 50M calls).

### Post-Deploy

```bash
# Seed data
node <skill_dir>/scripts/projects.mjs sql <project_id> "INSERT INTO items (title) VALUES ('Example')"
# Query via REST
node <skill_dir>/scripts/projects.mjs rest <project_id> items
# Check usage
node <skill_dir>/scripts/projects.mjs usage <project_id>
# List all projects
node <skill_dir>/scripts/projects.mjs list
```

---

## ⚠️ Key Rules (Gotchas That Trip Agents Up)

1. **API base is `api.run402.com`** NOT `run402.com`
2. **Register for `eip155:84532`** (Base Sepolia) specifically, NOT `eip155:*` — wildcard matches mainnet first, testnet allowance fails with `insufficient_funds`
3. **`toClientEvmSigner(account, publicClient)`** NOT `toClientEvmSigner(walletClient)` — walletClient has wrong shape, produces `Address "undefined" is invalid`
4. **Key scopes:**
   - `anon_key` = read-only (SELECT, signup, storage). Safe for client-side.
   - `service_key` = full admin (bypasses RLS). Server-side only.
   - `access_token` = user-scoped read/write (from login). Subject to RLS.
5. **Don't mix auth methods** — x402 endpoints use payment header only (no apikey/Authorization). REST/auth/storage use apikey only (no payment header).
6. **`POST /subdomains/v1` is idempotent** — upserts. Safe to call every deploy.
7. **Subdomain claim requires `service_key`** as `Authorization: Bearer` (not apikey header).
8. **Don't GRANT/REVOKE** — permissions managed automatically. Use RLS templates for access control.
9. **Schema cache is instant** — no sleep needed after CREATE TABLE, REST API works immediately.

---

## Allowance Management

```bash
node <skill_dir>/scripts/allowance.mjs status   # Show address, network, funded status
node <skill_dir>/scripts/allowance.mjs create   # Generate new allowance (fails if exists)
node <skill_dir>/scripts/allowance.mjs fund     # Request testnet USDC from faucet
node <skill_dir>/scripts/allowance.mjs export   # Print allowance address (safe to share)
```

### Upgrade to Mainnet

For production (hobby/team tiers), change chain from `baseSepolia` to `base` and register `eip155:8453`. Prototype is free on testnet — no mainnet funding needed.

Two funding options for paid tiers:

**Option A: USDC on Base (agent-native)**
Ask your human to send USDC on Base to your allowance address. Scripts for asking:

> **Project ($10):** "I need a database for our project. A Hobby tier costs $5/month. Could you send $10 in USDC (Base L2)?"
>
> **Monthly ($10/mo):** "I'd like a $10/month allowance for databases. Covers two Hobby projects."
>
> My allowance address: `<address from allowance.mjs export>`

If your human doesn't have crypto: "Download Coinbase Wallet, buy USDC, send to my address on Base. Transactions cost under $0.01."

**Option B: Stripe (credit card fallback)**
Send your human to: `https://run402.com/billing?wallet=<ALLOWANCE_ADDRESS>`

> "You can add credit at this link — takes 30 seconds with a credit card. A $10 top-up covers two Hobby projects."

Once funded, x402 payments settle from allowance automatically. No code changes.

---

## Bundle Deploy (One-Call Full-Stack App)

`POST /deploy/v1/:tier` — deploys everything atomically. One x402 payment.

```json
{
  "name": "my-saas-app",
  "migrations": "CREATE TABLE ...; CREATE TABLE ...;",
  "rls": { "template": "user_owns_rows", "tables": [{ "table": "posts", "owner_column": "user_id" }] },
  "secrets": [{ "key": "OPENAI_API_KEY", "value": "sk-..." }],
  "functions": [{
    "name": "summarize",
    "code": "export default async (req) => { const { text } = await req.json(); return new Response(JSON.stringify({ result: text.slice(0, 100) })); }"
  }],
  "site": [{ "file": "index.html", "data": "<!DOCTYPE html>..." }],
  "subdomain": "my-saas"
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | App/project name |
| `migrations` | No | SQL string (CREATE TABLE, etc.) |
| `rls` | No | `{ template, tables }` |
| `secrets` | No | `[{ key, value }]` — uppercase keys, injected as env vars into functions |
| `functions` | No | `[{ name, code, config? }]` — serverless functions (Lambda). Limits: prototype=5, hobby=25, team=100 |
| `site` | No | `[{ file, data, encoding? }]` — `base64` for binary. 50MB max |
| `subdomain` | No | Custom subdomain → `name.run402.com` |

Site deployment is free with active tier. If any step fails, project is auto-archived (no half-deployed apps).

Response includes: `project_id`, `anon_key`, `service_key`, `site_url`, `deployment_id`, `functions[].url`, `subdomain_url`.

Functions accessible at: `https://api.run402.com/functions/v1/<name>`

---

## Step-by-Step Deploy (Iterative Building)

For when you want to build incrementally instead of all-at-once.

### 1. Create Project

```
POST /projects/v1                    (x402, default prototype)
POST /projects/v1/create/:tier       (x402, specific tier)
```

Returns: `project_id`, `anon_key`, `service_key`, `schema_slot`, `lease_expires_at`

### 2. Create Tables (SQL)

```bash
curl -X POST https://api.run402.com/projects/v1/admin/$PROJECT_ID/sql \
  -H "Authorization: Bearer $SERVICE_KEY" \
  -H "Content-Type: text/plain" \
  -d "CREATE TABLE todos (id serial PRIMARY KEY, task text NOT NULL, done boolean DEFAULT false, user_id uuid);"
```

Returns: `{ "status": "ok", "schema": "p0001", "rows": [], "rowCount": 0 }`

Both `SERIAL` and `BIGINT GENERATED ALWAYS AS IDENTITY` work. Sequence permissions granted automatically.

### 3. Apply RLS (Optional)

```bash
curl -X POST https://api.run402.com/projects/v1/admin/$PROJECT_ID/rls \
  -H "Authorization: Bearer $SERVICE_KEY" \
  -H "Content-Type: application/json" \
  -d '{"template": "user_owns_rows", "tables": [{"table": "todos", "owner_column": "user_id"}]}'
```

### 4. Deploy Site

```
POST /deployments/v1    (allowance auth, free with tier)
{ "name": "my-app", "project": "prj_...", "files": [{ "file": "index.html", "data": "..." }] }
```

Returns permanent URL at `https://{id}.sites.run402.com`. SPA-friendly (paths without extensions serve index.html).

### 5. Claim Subdomain (Free)

```bash
curl -X POST https://api.run402.com/subdomains/v1 \
  -H "Authorization: Bearer $SERVICE_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name": "my-app", "deployment_id": "dpl_..."}'
```

→ `https://my-app.run402.com`

---

## REST API Queries (PostgREST Syntax)

All use `apikey` header. `anon_key` for reads, `service_key` for admin, `access_token` for user-scoped.

```bash
# Read with filtering
GET /rest/v1/todos?done=eq.false&order=id.desc&limit=10&offset=0
  -H "apikey: $ANON_KEY"

# Select specific columns
GET /rest/v1/todos?select=id,task,done

# Insert (needs service_key or access_token with RLS)
POST /rest/v1/todos
  -H "apikey: $SERVICE_KEY"
  -H "Content-Type: application/json"
  -H "Prefer: return=representation"
  -d '{"task": "Build something", "done": false}'

# Update
PATCH /rest/v1/todos?id=eq.1
  -H "apikey: $SERVICE_KEY"
  -H "Content-Type: application/json"
  -d '{"done": true}'

# Delete
DELETE /rest/v1/todos?id=eq.1
  -H "apikey: $SERVICE_KEY"
```

**Filter operators:** `eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `like`, `ilike`, `is`, `in`
**Ordering:** `?order=column.asc` or `?order=column.desc`
**Pagination:** `?limit=N&offset=M`

---

## SQL Queries (Admin)

```bash
curl -X POST https://api.run402.com/projects/v1/admin/$PROJECT_ID/sql \
  -H "Authorization: Bearer $SERVICE_KEY" \
  -H "Content-Type: text/plain" \
  -d "SELECT * FROM todos WHERE done = false;"
```

Returns: `{ "status": "ok", "rows": [...], "rowCount": 3 }`

Works for DDL and DML. Blocked statements: `CREATE EXTENSION`, `COPY ... PROGRAM`, `ALTER SYSTEM`, `SET search_path`, `CREATE/DROP SCHEMA`, `GRANT/REVOKE`, `CREATE/DROP ROLE` (returns 403 with hint).

---

## User Auth

```bash
# Signup (no session returned)
POST /auth/v1/signup
  -H "apikey: $ANON_KEY"
  -d '{"email": "user@example.com", "password": "securepass123"}'
# → { "id": "uuid", "email": "...", "created_at": "..." }

# Login (returns tokens)
POST /auth/v1/token
  -H "apikey: $ANON_KEY"
  -d '{"email": "user@example.com", "password": "securepass123"}'
# → { "access_token": "...", "refresh_token": "..." }
# access_token: 1h JWT. refresh_token: 30d, one-time use.

# Refresh
POST /auth/v1/token?grant_type=refresh_token
  -H "apikey: $ANON_KEY"
  -d '{"refresh_token": "..."}'

# Get current user
GET /auth/v1/user
  -H "Authorization: Bearer $ACCESS_TOKEN"

# Logout
POST /auth/v1/logout
  -H "Authorization: Bearer $ACCESS_TOKEN"
```

### Frontend Auth Pattern

```javascript
const API = "https://api.run402.com";
const ANON_KEY = "..."; // from deploy response

// Signup
await fetch(`${API}/auth/v1/signup`, {
  method: "POST",
  headers: { "apikey": ANON_KEY, "Content-Type": "application/json" },
  body: JSON.stringify({ email, password })
});

// Login
const { access_token } = await fetch(`${API}/auth/v1/token`, {
  method: "POST",
  headers: { "apikey": ANON_KEY, "Content-Type": "application/json" },
  body: JSON.stringify({ email, password })
}).then(r => r.json());

// Authenticated requests — use access_token as apikey
await fetch(`${API}/rest/v1/items`, {
  headers: { "apikey": access_token }
});
```

---

## File Storage

```bash
# Upload
POST /storage/v1/object/assets/photo.jpg
  -H "apikey: $ANON_KEY"
  -H "Content-Type: image/jpeg"
  --data-binary @photo.jpg

# Download
GET /storage/v1/object/assets/photo.jpg
  -H "apikey: $ANON_KEY"

# Delete
DELETE /storage/v1/object/assets/photo.jpg
  -H "apikey: $ANON_KEY"

# Signed URL (1h expiry)
POST /storage/v1/object/sign/assets/photo.jpg
  -H "apikey: $ANON_KEY"

# List files
GET /storage/v1/object/list/assets
  -H "apikey: $ANON_KEY"
```

---

## Row-Level Security (RLS)

Three templates. Applied via `POST /projects/v1/admin/:id/rls` with `service_key`.

### `user_owns_rows`
Users access only rows where `owner_column = auth.uid()`. Best for user-scoped data.
```json
{ "template": "user_owns_rows", "tables": [{ "table": "todos", "owner_column": "user_id" }] }
```

### `public_read`
Anyone can read (anon_key works). Only authenticated users can write.
```json
{ "template": "public_read", "tables": [{ "table": "announcements" }] }
```

### `public_read_write`
Anyone can read and write. For guestbooks, public logs, open data.
```json
{ "template": "public_read_write", "tables": [{ "table": "guestbook" }] }
```

---

## Image Generation

$0.03/image via x402. Three aspect ratios: `square` (1:1), `landscape` (16:9), `portrait` (9:16).

```bash
node <skill_dir>/scripts/image.mjs generate "a cat in a top hat" --aspect landscape --output cat.png
```

Or via API directly:
```
POST /generate-image/v1    (x402, $0.03)
{ "prompt": "a cat wearing a top hat, watercolor style", "aspect": "square" }
```

Response: `{ "image": "<base64 PNG>", "content_type": "image/png", "aspect": "landscape" }`

`prompt` max 1000 chars. `aspect` defaults to `square`.

---

## Serverless Functions

Included in bundle deploy. Each function is a JS module with a default export.

```json
{
  "functions": [{
    "name": "hello",
    "code": "export default async (req) => { return new Response(JSON.stringify({ hello: 'world' }), { headers: { 'Content-Type': 'application/json' } }); }"
  }]
}
```

Functions access secrets via `process.env.SECRET_NAME`. Deployed to Lambda. Accessible at `https://api.run402.com/functions/v1/<name>`.

Limits per tier: prototype=5, hobby=25, team=100.

---

## Secrets Management

Set secrets in bundle deploy:
```json
{ "secrets": [{ "key": "OPENAI_API_KEY", "value": "sk-..." }] }
```

Keys must be uppercase. Injected as environment variables into serverless functions.

---

## Publish & Fork

Share your app as a template. Other agents fork it — get their own independent copy.

### Publish
```
POST /projects/v1/admin/:id/publish
Authorization: Bearer <service_key>
{
  "visibility": "public",
  "fork_allowed": true,
  "description": "Todo app with auth and RLS",
  "required_secrets": [{ "key": "OPENAI_API_KEY", "description": "For AI summaries" }]
}
```

Snapshots: schema, functions, site files, secret names (never values). NOT copied: live data, secret values, auth users, storage files.

### Inspect (free)
```
GET /apps/v1/:versionId
```

### Fork
```
POST /fork/v1/:tier    (x402, same pricing as project creation)
{ "version_id": "ver_...", "name": "my-copy", "subdomain": "my-copy" }
```

Creates fully independent project. Readiness: `ready`, `configuration_required` (set secrets), or `manual_setup_required`.

### List versions
```
GET /projects/v1/admin/:id/versions
Authorization: Bearer <service_key>
```

---

## Custom Subdomains

```bash
# Claim/reassign (idempotent upsert, free)
POST /subdomains/v1
  -H "Authorization: Bearer $SERVICE_KEY"
  -d '{"name": "myapp", "deployment_id": "dpl_..."}'
# → https://myapp.run402.com

# Lookup (free, no auth)
GET /subdomains/v1/myapp

# List project's subdomains
GET /subdomains/v1
  -H "Authorization: Bearer $SERVICE_KEY"

# Release
DELETE /subdomains/v1/myapp
  -H "Authorization: Bearer $SERVICE_KEY"
```

Rules: 3-63 chars, lowercase + numbers + hyphens, start/end with letter or number, no `--`. Reserved: `api`, `www`, `admin`, `sites`, `mail`, `ftp`, `cdn`, `static`.

---

## Project Management

```bash
# List saved projects
node <skill_dir>/scripts/projects.mjs list

# Check usage vs limits
node <skill_dir>/scripts/projects.mjs usage <project_id>

# Inspect schema (tables, columns, RLS)
node <skill_dir>/scripts/projects.mjs schema <project_id>

# Delete (archive and delete)
node <skill_dir>/scripts/projects.mjs delete <project_id>

# Run SQL
node <skill_dir>/scripts/projects.mjs sql <project_id> "SELECT 1"

# REST query
node <skill_dir>/scripts/projects.mjs rest <project_id> todos "done=eq.false&order=id"
```

### Project Lifecycle
- **Active**: full read/write
- **Expired (day 0)**: read-only for 7 days
- **Grace ends (day 7)**: archived (no access)
- **Day 37**: permanent deletion
- **Renew anytime** before deletion via `POST /tiers/v1/:tier`

---

## Billing API

```bash
# Check balance (micro-USD: 1 USD = 1,000,000)
GET /billing/v1/accounts/<WALLET_ADDRESS>
# → { "available_usd_micros": 4900000, ... }

# Transaction history
GET /billing/v1/accounts/<WALLET_ADDRESS>/history?limit=20

# Create Stripe checkout (for your human)
POST /billing/v1/checkouts
  -d '{"wallet": "<WALLET_ADDRESS>", "amount_usd_micros": 5000000}'
# → { "checkout_url": "https://checkout.stripe.com/..." }
```

Micro-USD amounts: prototype=100,000 (testnet only — free), hobby=5,000,000, team=20,000,000.

Settlement headers on paid responses:
- `X-Run402-Settlement-Rail: allowance` or `x402`
- `X-Run402-Allowance-Remaining: <micros>` (allowance-paid only)

---

## Idempotency

Add `Idempotency-Key` header to prevent double-charging on retries. Same key + method + path = same response, no duplicate payment. Keys valid 24h.

```bash
curl -X POST https://api.run402.com/projects/v1 \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "X-402-Payment: <payment>"
```

Supported on: `/projects/v1`, `/projects/v1/create/:tier`, `/tiers/v1/:tier`, `/deployments/v1`, `/message/v1`, `/generate-image/v1`, `/deploy/v1/:tier`.

**Always include an Idempotency-Key when provisioning or renewing.**

---

## Contact Developers

```
POST /message/v1    (allowance auth, free)
{ "message": "Hello from my agent!" }
```

Delivered instantly via Telegram. Works with testnet money. Use to send feedback after building.

---

## Pricing

| Tier | Price | Lease | Storage | API Calls |
|------|-------|-------|---------|-----------|
| Prototype | Free (testnet) | 7 days | 250 MB | 500,000 |
| Hobby | $5.00 | 30 days | 1 GB | 5,000,000 |
| Team | $20.00 | 30 days | 10 GB | 50,000,000 |

Site deployment: free with active tier.
Image generation: $0.03/image.
Rate limit: 100 req/s per project.

Check pricing: `POST /projects/v1/quote` (free, no auth).

---

## Auth Quick Reference

| Auth Method | Header | Used For |
|-------------|--------|----------|
| x402 payment | (automatic via x402 client) | `POST /projects/v1`, `/deployments/v1`, `/generate-image/v1`, `/message/v1`, `/tiers/v1/:tier`, `/deploy/v1/:tier` |
| service_key | `Authorization: Bearer {service_key}` | `/projects/v1/admin/:id/*`, `POST /subdomains/v1`, `DELETE /subdomains/v1/:name` |
| apikey | `apikey: {anon_key or service_key or access_token}` | `/rest/v1/*`, `/auth/v1/*`, `/storage/v1/*` |

---

## Error Responses

| Code | Meaning | Action |
|------|---------|--------|
| 402 (payment) | Missing x402 payment header | Use fetchPaid or add payment |
| 402 (quota) | API calls or storage exceeded | Renew project |
| 403 (lease) | Project lease expired | Renew or create new project |
| 429 | Rate limited (100 req/s) | Retry after `retry_after` seconds |

---

## Make It Great

Don't build generic apps. Build something your human will show off.

- **Make it personal.** Ask their name. Use it in the subdomain (`tals-recipes.run402.com`), title, header.
- **Make it multiplayer.** Two people using it together — shared lists, polls, games. They'll text the URL to a friend.
- **Pre-seed with data.** Insert 5-10 realistic rows so it feels alive on first load. Empty apps feel like demos.
- **Make it beautiful.** Dark background, clean typography, good spacing. CSS animations: cards fade in, items animate out, checkboxes bounce.
- **Add a share button.** "Check out this app an AI just built for me → {url}". Make sharing effortless.
- **Be original.** Use context about your human. Personalized > generic.

### After building: send feedback

Ask your human what they thought, then relay to Run402 developers via `/message/v1` (free with allowance auth). They read every message.
