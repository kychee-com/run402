# AgentDB: Instant Backend for Agent-Built Apps

## What we're building

A **Supabase-compatible instant backend** that agents can provision via x402 to build mini apps, websites, and tools for their users. Postgres + auto-generated REST API + auth + object storage — paid with a lease, governed by hard budget caps, auto-expires when abandoned.

**Product statement:**
> "AgentDB is Postgres for agent-built apps: provision in seconds, ship via generated APIs, hard budget caps, auto-expire."

**Domain:** `<project>.run402.com`

---

## Why not DynamoDB / KV

Agents build CRUD apps (workout trackers, CRMs, inventory tools, waitlist forms). That's a **relational** problem:

- Agents are excellent at SQL + schema design
- Every web framework speaks Postgres (Prisma, Drizzle, SQLAlchemy, Rails, Django)
- Ad-hoc querying is inevitable ("show me workouts this week", "top customers by last contact")
- Transactions matter even in small apps (creating a workout + sets; decrementing inventory + logging)
- JSON is still available via `jsonb` when the schema is fluid

A KV store forces agents to precompute access patterns and denies them joins, constraints, and transactions — the opposite of what you want when iterating rapidly.

---

## Architecture: Pod/Cell Design

### What's a pod

A **pod** = shared Aurora cluster + shared PostgREST + shared auth + shared storage + shared metering. Projects are assigned to a pod. Scale by adding pods.

This keeps:
- Postgres catalogs from exploding
- PostgREST schema reload manageable
- Blast radius bounded

### AWS components per pod

| Component | AWS Service | Role |
|---|---|---|
| Database | **Aurora Serverless v2** (Postgres-compatible) | Multi-tenant via schema-per-project |
| REST API | **PostgREST** on **ECS Fargate** | Auto-generated CRUD + filters from Postgres schema |
| Auth | Custom thin service on **ECS Fargate** | JWT issuance, user management, stored in Postgres |
| Object storage | **S3** | One bucket, prefix-partitioned by project. Signed URLs |
| x402 gateway | **ECS Fargate** | Procurement, leasing, budget enforcement, metering, routing |
| Load balancer | **ALB** | Single entry point per pod |
| Connection pooling | **RDS Proxy** or **pgBouncer** | Prevent connection exhaustion |

### Baseline cost per pod

~$250–600/month (Aurora + ECS services + ALB + misc).

---

## Multi-Tenancy: Schema Slots

Each project gets an isolated Postgres schema within a shared Aurora cluster.

### How it works

1. **Pre-create** a fixed pool of schemas per pod: `p0001 … p2000`
2. **Configure PostgREST once** with `db-schemas = p0001,p0002,...`
3. **On provisioning**: allocate an unused schema slot, run migrations with `SET search_path TO <slot>`
4. **Gateway routing**: every request hits the x402 gateway, which injects:
   - `Accept-Profile: <slot>`
   - `Content-Profile: <slot>`
   - Strips any client-provided profile headers

This gives schema isolation **without** per-project PostgREST instances and **without** reconfiguring PostgREST on every new project.

### Security: defense in depth

Do not rely on "headers are correct" alone:

- All traffic is public only to the **gateway**; PostgREST is private (VPC-internal)
- Include `project_id` in JWT claims
- PostgREST `db-pre-request` hook asserts `jwt.project_id` matches `X-Project-Id` set by the gateway
- Migrations run as a **restricted per-project owner role** with privileges scoped to its schema slot only

---

## API Surface: Supabase-Shaped

Intentionally mimic Supabase's API contract so agents already know how to use it. This is the biggest distribution hack: **drop-in familiarity**.

### Endpoints

```
https://<project>.run402.com/rest/v1/*      → PostgREST (CRUD + filters + RPC)
https://<project>.run402.com/auth/v1/*      → Auth service (signup, signin, refresh, getUser)
https://<project>.run402.com/storage/v1/*   → Storage service (upload, download, signed URLs)
https://<project>.run402.com/admin/v1/*     → Migrations, introspection, metering (service key only)
```

### What agents get back on project creation

```json
{
  "project_id": "prj_...",
  "url": "https://prj-abc123.run402.com",
  "anon_key": "public_browser_key",
  "service_key": "server_admin_key",
  "sql_url": "postgres://...",
  "lease_expires_at": "2026-03-26T00:00:00Z",
  "hard_cap_usd": 5.00,
  "tier": "hobby"
}
```

### What agents actually use (from Supabase usage patterns)

1. **Database CRUD via PostgREST** — `from('table').select/insert/update/delete`, filters, ordering, pagination, occasional `rpc()` calls
2. **Auth** — email/password signup + signin, session persistence, `getUser()`
3. **Storage** (sometimes) — upload an image/file, get a public or signed URL

Agents rarely need: realtime subscriptions, edge functions, studio/dashboard, custom domains, complex networking.

---

## Provisioning Flow (x402)

### Step 1: Quote + approval

```
POST /v1/projects/quote
{
  "name": "workout-tracker",
  "tier": "hobby",
  "lease_days": 30,
  "budget_cap_usd": 5,
  "region": "us-east"
}
```

Server responds `402 Payment Required` with price, what's included, expiration date, payTo address.

Human approves. Agent signs payment with wallet. Agent retries with `PAYMENT-SIGNATURE`.

### Step 2: Create project

```
POST /v1/projects
```

Returns: `url`, `anon_key`, `service_key`, `sql_url`, `lease_expires_at`, `hard_cap_usd`.

Agent receives **capability tokens** valid for the lease duration.

### Step 3: Apply schema

```
POST /admin/v1/projects/{id}/sql
Content-Type: text/plain
Authorization: Bearer <service_key>

CREATE TABLE profiles (
  id uuid primary key default gen_random_uuid(),
  email text unique,
  created_at timestamptz default now()
);

CREATE TABLE workouts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references profiles(id),
  performed_at date not null,
  notes text
);
```

Executes in a transaction with `search_path=<slot>`. Blocks dangerous statements (`CREATE EXTENSION`, `COPY ... PROGRAM`, etc.). After apply: `NOTIFY pgrst, 'reload schema'`.

### Step 4: Enable auth + RLS

```
POST /auth/v1/enable
{ "providers": ["email"] }

POST /admin/v1/projects/{id}/rls
{ "template": "user_owns_rows" }
```

Generates standard RLS policies:
- `workouts.user_id = auth.uid()`
- `sets.workout_id IN (SELECT id FROM workouts WHERE user_id = auth.uid())`

### Step 5: Agent builds frontend — no backend code needed

Frontend uses the `anon_key` and REST API directly:

```
GET  /rest/v1/workouts?performed_at=gte.2026-01-01&order=performed_at.desc
POST /rest/v1/workouts
POST /rest/v1/sets
```

### Step 6: Monitor costs

```
GET /admin/v1/projects/{id}/usage
```

Returns: spend so far, remaining cap, forecast at current rate, top endpoints by cost.

If near cap, agent asks user to top up → triggers `402 Top-up Required`.

### Step 7: Abandonment is safe by default

Lease ends → API disabled, data archived. User can renew lease (pay again) to reactivate.

---

## Pricing: Lease Tiers + Hard Cap

### Tiers

| Tier | Lease | Price | Includes | Max item |
|---|---|---|---|---|
| **Prototype** | 7 days | $1.00 | 250MB storage + 500k API calls | — |
| **Hobby** | 30 days | $5.00 | 1GB storage + 5M API calls | — |
| **Team** | 30 days | $20.00 | 10GB storage + 50M API calls | — |

### Overage (only if user sets a higher cap)

- $1 per additional 1GB-month storage (pro-rated)
- $1 per additional 5M API calls
- Egress pass-through + markup

### Key rule: **the quote is the cap**

Budget enforcement is hard. When the cap is hit:
- Configurable: read-only mode, or 402-to-top-up, or fully disabled
- Gateway returns `402 Renew Lease` with top-up pricing

### Auto-archive

When lease ends without renewal:
- Data kept cheaply (storage-only cost)
- API disabled until renewed
- After extended grace period: data deleted

---

## Auth (v1 — minimal)

Implement the subset of Supabase auth that agents actually use:

| Endpoint | Purpose |
|---|---|
| `POST /auth/v1/signup` | Email + password registration |
| `POST /auth/v1/token?grant_type=password` | Email + password login → JWT |
| `POST /auth/v1/token?grant_type=refresh_token` | Refresh expired JWT |
| `GET /auth/v1/user` | Get current user from JWT |
| `POST /auth/v1/logout` | Invalidate refresh token |

JWT claims include:
- `sub` — user ID
- `role` — `authenticated` or `anon`
- `project_id` — for gateway + RLS validation

### RLS integration

JWT is passed to PostgREST. Postgres functions `auth.uid()` and `auth.role()` extract claims. RLS policies reference these functions.

---

## Storage (v1 — minimal)

S3-backed object storage with signed URLs:

| Endpoint | Purpose |
|---|---|
| `POST /storage/v1/object/{bucket}/{path}` | Upload file (multipart) |
| `GET /storage/v1/object/{bucket}/{path}` | Download file |
| `POST /storage/v1/object/sign/{bucket}/{path}` | Generate signed URL |
| `DELETE /storage/v1/object/{bucket}/{path}` | Delete file |
| `GET /storage/v1/object/list/{bucket}` | List objects |

All objects stored in a shared S3 bucket with prefix `{project_id}/{bucket}/{path}`.

Storage bytes counted against the project's lease quota.

---

## Migrations API

One endpoint for schema management:

```
POST /admin/v1/projects/{id}/sql
```

- Executes SQL in a transaction with `search_path=<slot>`
- Blocks dangerous statements
- After apply: `NOTIFY pgrst, 'reload schema'`
- Returns success/error + affected tables

```
GET /admin/v1/projects/{id}/schema
```

- Returns machine-readable schema introspection (tables, columns, types, constraints, RLS policies)
- Agents use this to understand what they've built and iterate

---

## Budget Enforcement (Hard Caps)

Enforced at the gateway (authoritative):

| Meter | How |
|---|---|
| API call count | Exact counter per request |
| Bandwidth | Exact-ish per response |
| Storage bytes | Counted on upload; periodic DB size measurement |
| DB size | Periodic `pg_total_relation_size()` per schema |

When cap exceeded:
1. Gateway returns `402 Renew Lease` with top-up pricing
2. Optionally flip project to read-only (revoke write privileges on the schema role)

---

## Unit Economics

| Scale | Pods | Infra baseline | Per project | Gross margin on $5 Hobby |
|---:|---:|---:|---:|---:|
| 10 | 1 | ~$250–600/mo | $25–60 | **negative** (expected early) |
| 100 | 1 | ~$250–600/mo | $2.5–6 | **strong** |
| 1,000 | 1–2 | ~$500–1,200 | $0.5–1.2 | **very strong** |
| 10,000 | 10–20 | ~$2,500–12,000 | $0.25–1.2 | **excellent** |

Marginal cost per project is dominated by DB storage + S3 storage (~$0.03–0.15/mo for a typical small app). Economics improve dramatically with density.

---

## What breaks at 3am (operational risks)

| Risk | Mitigation |
|---|---|
| Aurora connection exhaustion | RDS Proxy / pgBouncer, sane pool sizes per pod |
| PostgREST schema cache reload | Pod sizing, controlled migrations, `NOTIFY pgrst` |
| Noisy neighbor projects | Per-project query timeouts, quotas, move heavy projects to dedicated pods |
| Budget enforcement bugs | Strong invariants in gateway, defense-in-depth with DB-level checks |
| Cross-tenant data access | Gateway header injection + JWT `project_id` + `db-pre-request` hook + per-schema roles |

---

## Moat / Defensibility

The moat is **not Postgres**. It's:

- **x402 procurement flow** — human-in-the-loop spend approval, no accounts
- **Lease + budget caps + kill switch** — hard governance that agents and humans trust
- **Agent-native provisioning API** — templates, one-shot backend from spec
- **Operational tricks** — multi-tenant pod architecture that makes instant backends cheap enough to sell at $1–$20
- **Distribution** — MCP integration, IDE plugins, the agent already knows the API

---

## v1 Build Plan

| Week | Deliverable |
|---|---|
| **1** | Pod infra + provisioning + gateway routing to PostgREST (CRUD working end-to-end) |
| **2** | Migrations API + schema reload + basic metering + x402 lease flow |
| **3** | Auth v1 (email/password + JWT + refresh) + RLS helpers |
| **4** | Storage v1 (signed upload/download) + quota enforcement + docs/examples |

### Not in v1

- Realtime subscriptions
- Edge functions / compute
- GraphQL
- Studio / dashboard
- Custom domains
- Complex networking / VPC
- Database branching (v2)

---

## Example: Agent builds a workout tracker

1. User: "Build me a workout tracker"
2. Agent designs data model (profiles, workouts, exercises, sets)
3. Agent calls `POST /v1/projects/quote` — gets $5/month Hobby tier quote
4. Human approves spend
5. Agent pays via x402, receives project URL + keys
6. Agent sends SQL migration (CREATE TABLE...)
7. Agent enables auth + applies `user_owns_rows` RLS template
8. Agent writes React/Vue/HTML frontend using the REST API directly
9. App is live. User tracks workouts.
10. 30 days later: lease renews ($5) or expires (data archived, API disabled)

---

## Lessons Learned (from end-to-end test, Feb 2026)

Validated the full flow in `test-supa/` — x402 payment on Base Sepolia, Postgres 16 + PostgREST v12, schema-per-project, auth, RLS, storage, cleanup. All 11 steps passed. Real USDC transferred on-chain. Here's what we learned building it.

### 1. Schema permissions: PostgREST needs USAGE on `internal` and `auth` schemas

PostgREST calls `internal.pre_request()` and RLS policies call `auth.uid()`. Even though `pre_request()` is `SECURITY DEFINER`, PostgreSQL requires the **calling role** to have `USAGE` on the schema where the function lives before it can even find the function. Without this, PostgREST returns `permission denied for schema internal` on the first authenticated request.

**Required grants in init-db.sql:**
```sql
GRANT USAGE ON SCHEMA internal TO authenticator, anon, authenticated, service_role;
GRANT USAGE ON SCHEMA auth TO authenticator, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION internal.pre_request() TO authenticator, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION auth.role() TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION auth.project_id() TO anon, authenticated, service_role;
```

This is separate from `ALTER DEFAULT PRIVILEGES` on schema slots. The `internal` and `auth` schemas need explicit one-time grants.

### 2. `ALTER DEFAULT PRIVILEGES` must match the migration-executing role

`ALTER DEFAULT PRIVILEGES IN SCHEMA p0001 GRANT SELECT ON TABLES TO anon` only applies to tables created by the role that ran the `ALTER DEFAULT PRIVILEGES` statement. In our case, `postgres` runs both init-db.sql and migrations (via the gateway's pool), so it works. If migrations ran as a different role, tables would be created without the expected grants and PostgREST would return empty results or permission errors.

**Rule:** The role that runs `ALTER DEFAULT PRIVILEGES` must be the same role that later creates tables in that schema.

### 3. PostgREST schema cache reload takes 100-500ms

After a DDL migration (`CREATE TABLE`, `ALTER TABLE`, etc.), PostgREST needs to reload its schema cache before the new tables/columns appear in the REST API. The `NOTIFY pgrst, 'reload schema'` fires immediately, but PostgREST processes it asynchronously.

**In the test:** A 500ms `sleep` after the migration endpoint is sufficient. In production, the gateway should either poll PostgREST's schema version endpoint or use a longer grace period before confirming the migration is "ready."

### 4. PostgREST resource embedding requires explicit foreign keys

PostgREST's `?select=*,sets(*,exercises(*))` join syntax only works when the migration SQL includes `REFERENCES` clauses on foreign key columns. Without `REFERENCES`, PostgREST returns the nested fields as empty arrays rather than erroring — a subtle bug.

**Rule:** Every `_id` column that should support embedded queries must declare `REFERENCES parent_table(id)` in the migration.

### 5. PostgREST bulk insert: use JSON arrays + `Prefer: return=representation`

PostgREST accepts JSON arrays for multi-row inserts (`POST /rest/v1/exercises` with `[{...}, {...}]`). The client must set `Prefer: return=representation` to get the inserted rows (with server-generated UUIDs) back in the response. Without this header, PostgREST returns an empty body on insert.

### 6. Gateway must sync schema slot state on restart

The gateway allocates schema slots (`p0001`, `p0002`, ...) with an in-memory counter. If the gateway restarts, it must query `internal.projects` to discover which slots are already allocated — otherwise it re-issues slot `p0001` and hits a unique constraint violation.

**Rule:** On startup, read `MAX(schema_slot)` from `internal.projects` and set the counter to `max + 1`.

### 7. The `db-pre-request` hook doesn't receive the current schema as a GUC

The spec assumed PostgREST would set something like `pgrst.db_pre_request.current_schema` to the schema being accessed. It doesn't. In the test, the pre_request function falls through (returns early on null schema) and the x402 gateway's header injection (`Accept-Profile` / `Content-Profile`) handles routing. This is fine for now — the real security boundary is the gateway, not the hook.

**For production:** The pre_request hook should validate `jwt.project_id` against the schema by using `current_setting('request.header.accept-profile', true)` (which PostgREST does expose) rather than a nonexistent GUC.

### 8. RLS `user_owns_rows` template needs a `user_id` column on every table

The RLS template applies `owner_column = auth.uid()` policies. For the `profiles` table itself, the owner column is `id` (the profile *is* the user). For all other tables, a `user_id` column with a foreign key to `profiles(id)` is needed. The agent must include `user_id` in every insert — PostgREST won't auto-populate it.

**Implication for production:** Consider a PostgREST pre_request hook or Postgres trigger that auto-sets `user_id = auth.uid()` on insert, so agents don't have to pass it explicitly.

### 9. Express body parsing: route-specific content type handling

The gateway uses Express with JSON parsing by default, but the SQL migration endpoint needs `text/plain` and the storage upload endpoint needs raw body. A single global `express.json()` middleware breaks these routes.

**Solution:** Route-specific body parsing — check `req.path` and apply `express.text()` for `/sql` and `/storage/` paths, `express.json()` for everything else.

### 10. The full flow works end-to-end with a single x402 payment

The most important validation: one $0.10 x402 payment on Base Sepolia provisions a full Postgres project — schema, tables, auth, RLS, CRUD, joins, storage, metering, cleanup. The payment settles on-chain in ~2 seconds. Everything after the lease payment is free API calls against the project's quota.

This confirms the lease model works: **one payment, full backend, hard cap, auto-expire.**
