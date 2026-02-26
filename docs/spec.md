> **SUPERSEDED** — This DynamoDB-based design was replaced by the Postgres/PostgREST architecture. See `supa_spec.md` for the current spec and live implementation at `https://api.run402.com`.

Below is a concrete design for a “no-account” cloud NoSQL service backed by DynamoDB, using **x402** as the payment and (optionally) lightweight identity rail—so an agent can spin up a database after a human approves an estimated spend, without anyone opening an AWS account.

---

## What you’re building

A SaaS-style wrapper called **AgentDB** (the initial product from **Run402**) that exposes an HTTP API (and an agent-friendly client/tooling layer) with:

* **Control plane**: create/delete “tables”, set TTL/retention, set budgets, fetch usage & logs
* **Data plane**: put/get/delete/query items
* **Payments**: enforced via **x402 (HTTP 402 Payment Required)** so the client/agent can pay programmatically without accounts/sessions/API keys in the traditional sense. ([x402][1])
* **Underlying storage**: DynamoDB in *your* AWS account(s), but **you do not disclose DynamoDB** in the public API.

Key point: the user doesn’t need an AWS account. **You** are the AWS customer; the user is your customer.

---

## x402 mechanics you’ll use (V2)

x402 gives you a standardized way to say “pay before I serve this request,” entirely over HTTP:

* Server → Client: `402 Payment Required` + `PAYMENT-REQUIRED` header (Base64-encoded JSON describing price & accepted networks)
* Client → Server: retry same request with `PAYMENT-SIGNATURE` header (Base64-encoded signed payment payload)
* Server → Client: `200 OK` + `PAYMENT-RESPONSE` header (Base64-encoded settlement response) ([x402][2])

Use an x402 **facilitator** (recommended by the docs) so your service doesn’t have to run chain verification/settlement infra itself; you POST to `/verify` and `/settle`. ([x402][3])

Also, you should enable x402’s **payment-identifier** extension for idempotency so retries don’t double-charge or double-apply writes. ([x402][4])

---

## Public product surface (what you expose)

### Objects

* **Workspace**: implicitly tied to a wallet (payer) or to an issued capability; used for budgets, usage, logs.
* **Table**: `table_id`, schema (key definition), region/tier, TTL policy, budget policy.
* **Item**: JSON document with required key fields.

### API endpoints (minimal but useful)

**Control plane (low frequency)**

1. **Quote** (free or very cheap, see abuse controls)

* `POST /v1/tables:quote`

  * Input: expected usage (rough), retention, region/tier, schema
  * Output: price model + estimated cost range + recommended deposit + budget suggestions

2. **Create**

* `POST /v1/tables`

  * Returns 402 with payment requirements unless caller is already funded/authorized
  * On success returns `table_id`, endpoints, TTL, budget, etc.

3. **Describe / List**

* `GET /v1/tables/{table_id}`
* `GET /v1/tables`

4. **Budgets**

* `PUT /v1/tables/{table_id}/budget`
* `GET /v1/tables/{table_id}/budget`

5. **Usage / Costs**

* `GET /v1/usage?table_id=&from=&to=`
* `GET /v1/receipts?table_id=&from=&to=` (line-item receipts)

6. **Logs**

* `GET /v1/tables/{table_id}/logs?from=&to=&type=audit|ops|errors`

7. **Delete / Expire**

* `DELETE /v1/tables/{table_id}`

**Data plane (potentially high frequency)**

* `PUT /v1/tables/{table_id}/items/{pk}` (optional `sk`)
* `PATCH /v1/tables/{table_id}/items/{pk}` (partial update with update expressions)
* `GET /v1/tables/{table_id}/items/{pk}`
* `DELETE /v1/tables/{table_id}/items/{pk}`
* `POST /v1/tables/{table_id}:query` (key-based query, paginated)
* `POST /v1/tables/{table_id}:scan` (guarded; requires explicit opt-in + hard limits)
* `POST /v1/tables/{table_id}:batch-get` (batch get)
* `POST /v1/tables/{table_id}:batch-write` (batch put/delete)

---

## What it supports vs. does not support (explicit scope)

### Supported (v1)

* Create/delete tables
* Primary key:

  * Partition key required (string)
  * Optional sort key (string)
* CRUD:

  * Put/Get/Update/Delete
* Query:

  * Partition-key queries + sort-key range/prefix (if sort key enabled)
  * Pagination (`limit`, `next_token`)
* Scan (guarded):

  * Requires explicit opt-in + hard item/size limits
  * Paginated, rate-limited
* Batch operations:

  * Batch get (multi-item)
  * Batch write (put/delete)
* TTL / auto-expiration policy (table-level)
* Budget enforcement (table-level and workspace-level)
* Cost visibility:

  * Real-time “metered” usage + receipts
* Logs:

  * Audit + ops + errors (time-windowed)

### Not supported (v1)

* DynamoDB transactions (ACID multi-item)
* DynamoDB Streams / triggers / CDC
* Secondary indexes (GSI/LSI) (unless you add a constrained “1 index” tier later)
* PartiQL
* Fine-grained IAM-style permissions (you’re not exposing AWS auth)
* DAX, global table topology controls (you can offer “multi-region tier” as a product, but don’t expose DynamoDB knobs)

This keeps the surface area “agent-simple” and makes pricing and QoS easier to guarantee.

---

## Under the hood on AWS (implementation choices)

### Storage strategy — shared multi-tenant table

All customer data lives in a **single shared DynamoDB table** (`agentdb-data-001`) in on-demand mode, with logical table isolation enforced at the application layer. This avoids AWS table-count limits, eliminates 20–60 s `CreateTable` latency, and simplifies lifecycle management (TTL-based cleanup instead of `DeleteTable`).

#### Table schema

| Attribute | Type | Role |
|---|---|---|
| `PK` | String | `{tableId}#{userPK}` — globally unique because `tableId` is server-assigned 128-bit random |
| `SK` | String | `{userSK}` (or `#` sentinel if the logical table has no sort key) |
| `_wid` | String | Wallet / tenant ID (for access-control + attribution) |
| `_tid` | String | Logical table ID (for GSI queries) |
| `_ttl` | Number | DynamoDB TTL epoch (used for lease-based expiry) |
| `_sz` | Number | Item size in bytes (for storage metering) |

**GSI**: `_tid` (partition key) + `PK` (sort key) — used for Scan operations (listing/scanning items within a logical table).

#### How operations map to the shared table

| Operation | Implementation |
|---|---|
| Create table | Insert metadata record (sub-second, ~$0.02). No AWS `CreateTable`. |
| Delete table | Set metadata status to `DELETED` + set `_ttl` on all items for eventual cleanup. Instant. |
| Put / Get / Delete item | Standard DynamoDB ops with `PK = “{tableId}#{userPK}”` |
| Query (by partition key + sort key range) | DynamoDB Query with `PK = “{tableId}#{pk}”` and SK conditions |
| Scan (all items in logical table) | GSI Query where `_tid = “{tableId}”` (not a full-table DynamoDB Scan) |
| Lease expiry | State machine ending in TTL sweep (items auto-deleted by DynamoDB TTL) |

A separate **internal metadata table** stores table records, the ledger, and capability tokens (unchanged from original design).

### Capacity mode

Use **On-Demand** by default (agents don’t know future traffic), and price accordingly. AWS describes how on-demand charges per read/write request unit and storage. ([Amazon Web Services, Inc.][5])

### Optional durability/availability tiers

You can productize two tiers:

1. **Regional Tier**

* Single-region table
* Underlying DynamoDB Standard SLA: **99.99%** monthly uptime in-region ([Amazon Web Services, Inc.][6])

2. **Multi-Region Tier**

* DynamoDB **Global Tables**
* Underlying SLA: **99.999%** monthly uptime ([Amazon Web Services, Inc.][6])

(You still must engineer your own API layer to not become the bottleneck—see QoS below.)

---

## Paying over time: the core problem & the clean solution

### The problem

DynamoDB accrues costs even when idle (storage, backups if enabled). If the user never calls you again, you can’t “pull” funds from them unless you have an account/subscription/card on file—which you explicitly don’t want.

### The solution: **Lease + prepaid balance**, enforced by x402

Make every table a **lease-backed resource**:

* At create time, the user pays:

  * a **minimum deposit** (prepaid credit) that covers:

    * N days of baseline storage (and optionally backups)
    * plus a safety buffer
* You **meter** actual usage (writes/reads/storage) against that deposit
* When deposit runs low:

  * API starts returning `402 Payment Required` with a “top-up required” price
* If they do not top-up by lease expiry:

  * table transitions to `SUSPENDED` (read-only or inaccessible)
  * after a grace period, you `DELETE` (or export snapshot then delete)

This guarantees you’re never stuck paying AWS indefinitely for an abandoned resource.

### How x402 fits

x402 is the universal “pay now” mechanism when:

* creating a table
* topping up a lease
* increasing budgets/limits
* requesting exports / long-retention logs

x402 is explicitly designed for programmatic payments without accounts/sessions/credentials. ([x402][1])

### Two practical billing modes (offer both)

**Mode A — Simple, pure x402 per-operation (v0 / dev mode)**

* Every data-plane request is individually paywalled via x402.
* Pros: simplest conceptual model
* Cons: too many payments for chatty workloads (and awkward for time-based storage)

**Mode B — Recommended: x402 for top-ups, metered usage inside the lease**

* Most data-plane calls do **not** trigger a payment flow as long as balance is positive.
* Pros: efficient; supports storage charges; better UX for agents
* Cons: you need a lightweight way to authorize requests without paying each time (see next section)

---

## Auth without “accounts” (but still preventing data theft)

You must ensure a random payer cannot pay you and read someone else’s table.

You have two solid approaches that remain “no account”:

### Option 1: Wallet-as-identity (preferred if you can)

Treat the **payer wallet** as the workspace identity (x402 already assumes wallets are central; the wallet is how buyers sign payloads). ([x402][7])

* On table creation, bind `table_id → owner_wallet`
* On each request:

  * if it is a paid x402 request, you can recover payer identity during verification
  * if it is an unpaid request (because they have balance), you need an auth proof

For that “auth proof,” you can adopt x402’s **Sign-In-With-X (SIWX)** extension, which is designed to let clients prove wallet ownership for returning access. ([x402][8])
Even though SIWX is described as “access previously purchased content without repaying,” you can apply it to “access your already-funded table without re-running payment on every request.”

Practical note: SIWX support appears best in the TypeScript ecosystem; if you need Python-first, you may implement SIWX signing/verification yourself or provide a small local bridge (see agent tooling).

### Option 2: Capability tokens (simpler; very agent-friendly)

When a table is created, return an unguessable `table_secret` (capability) and require:

* `Authorization: Bearer table_secret` for table access

This is not an “account,” but it is a credential. It’s operationally simple, language-agnostic, and lets you keep data-plane calls fast while using x402 only for top-ups.

You can still *also* bind tables to wallets for billing/ownership, but the token is the practical access key.

---

## Cost transparency: quotes, live costs, receipts

You want an agent to tell a human “expected costs” and then proceed automatically.

### 1) Quote endpoint (pre-approval UX)

`POST /v1/tables:quote`

Inputs the agent can reasonably provide:

* retention (hours/days)
* expected max item size
* expected ops/day (rough)
* desired region / tier
* budget cap (hard)

Output:

* **unit pricing** (reads/writes/storage)
* estimated daily/monthly under the stated assumptions
* recommended minimum deposit to avoid suspension
* “worst-case spend” = your configured budget cap

Under the hood, your unit model should mirror DynamoDB on-demand economics:

* Writes billed in 1 KB chunks; reads billed in 4 KB chunks (strongly consistent) etc. ([Amazon Web Services, Inc.][5])
  You don’t have to expose the DynamoDB terms; present as “Write Units” and “Read Units.”

### 2) Real-time usage & costs (what the human cares about)

Expose:

* `GET /v1/usage` – aggregated usage + cost estimate by table and time bucket
* `GET /v1/receipts` – append-only ledger entries:

  * timestamp, operation type, units, $ cost, remaining balance, correlation id

Important implementation detail: **don’t rely on AWS Cost Explorer** for real-time. It’s not real-time and it’s per your AWS account. Instead:

* meter usage at your gateway
* compute cost in real time using your own pricing config
* reconcile periodically against AWS bill (FinOps back office)

### 3) Budgets and safety rails

Let the human approve a budget, not a guess.

Examples:

* max $ spend per day
* max $ spend lifetime per table
* hard max ops/sec
* auto-expire after N days unless renewed

When budget would be exceeded, return:

* `402 Payment Required` for a “budget increase / top-up” flow, or
* `429 / 403` depending on semantics (“rate limit” vs “denied by policy”)

---

## Logs & observability you can expose without AWS

You can provide logs without giving AWS access by treating logs as a first-class API product.

### Log types

1. **Audit log** (who did what)

* table created/deleted
* budget changes
* lease top-ups
* key administrative actions

2. **Ops log** (data-plane)

* request id, operation, key hash (not raw key unless user opts in), item size, latency, outcome, metered units, cost

3. **Error log**

* throttling, validation errors, internal errors

### How users retrieve logs

* `GET /v1/tables/{table_id}/logs?...`
* Provide:

  * JSONL stream
  * optional gzip
  * retention policy by tier (e.g., 7d default, 30d paid)

Also return correlation headers on every response:

* `X-Request-Id`
* `X-Table-Id`
* `X-Metered-Units`
* `X-Estimated-Cost-Usd`

---

## QoS “back-to-back” guarantee: what you can promise credibly

### Upstream guarantees you can lean on (DynamoDB)

AWS DynamoDB SLA (last updated May 14, 2025) commits to:

* **99.99%** monthly uptime for Standard (single-region)
* **99.999%** monthly uptime for Global Tables ([Amazon Web Services, Inc.][6])

So you can offer tiers whose *data-store component* is backed by those upstream commitments.

### Your gateway must not reduce that too much

If you front with AWS API Gateway, its SLA is **99.95%** per region. ([Amazon Web Services, Inc.][9])
So if you use it, your end-to-end SLA can’t honestly exceed that without multi-region active-active and careful composition.

A practical architecture for higher availability:

* **Multi-AZ stateless gateway** (containers) behind an ELB
* optional **multi-region** active-active for your “five nines” tier (with Global Tables underneath)

### What “back-to-back” should mean contractually

Offer a customer-facing SLA that:

1. Mirrors the tier:

   * Regional tier: e.g., 99.9–99.95%
   * Multi-region tier: higher, if your gateway is multi-region
2. Defines:

   * Availability measurement
   * Error definition
   * credit schedule
3. Includes a pass-through mechanism:

   * when AWS issues service credits for DynamoDB under its SLA, you use those to fund (part of) your own credits

AWS’s DynamoDB SLA explicitly defines credit tiers and process (service credits against future charges). ([Amazon Web Services, Inc.][6])

---

## Agent experience: how Claude Code (or any coding agent) uses it

### Recommended local component: “AgentDB Broker”

Run a local tool that:

* exposes an agent tool interface (MCP is a natural fit)
* holds wallet keys (or delegates to a wallet service)
* enforces human approval policies
* talks to your cloud API

x402 already documents an MCP server pattern that bridges Claude Desktop to x402-paid APIs. You can reuse that design: the MCP server wraps HTTP calls and handles the 402 → pay → retry flow. ([x402][10])

### Flow

1. Agent: “I need a DB for feature X.”
2. Broker calls `POST /v1/tables:quote`
3. Broker shows human something like:

   * “Max spend: $3.00”
   * “Typical expected: $0.20–$0.80”
   * “Auto-expires in 7 days unless renewed”
4. Human approves (one click / terminal prompt)
5. Broker calls `POST /v1/tables`

   * receives 402 with `PAYMENT-REQUIRED`
   * pays via x402
   * retries with `PAYMENT-SIGNATURE`
6. Broker returns `table_id` + “connection handle” to the agent
7. Agent uses CRUD/query calls
8. If balance depleted or lease expired:

   * server returns 402 with top-up requirements
   * broker prompts human if above an auto-approval threshold, otherwise auto-pays

### Human approval policies

Implement in the broker, not the cloud:

* auto-approve up to $X/day
* require approval for:

  * tier upgrades (regional → multi-region)
  * budget increases
  * retention extension beyond N days

---

## Concrete x402 “PAYMENT-REQUIRED” examples (how you’d structure it)

When payment is required (create table / top-up), your server responds:

* HTTP `402 Payment Required`
* `PAYMENT-REQUIRED: <base64(PaymentRequired JSON)>`

And that JSON includes an `accepts` list like:

* `scheme: "exact"`
* `price: "$0.25"`
* `network: "eip155:8453"` (example)
* `payTo: "0x..."`

This matches the patterns shown in x402 seller quickstart examples. ([x402][11])

For idempotency on create/put:

* declare the `payment-identifier` extension and require clients to include it. ([x402][4])

---

## How you (the operator) keep paying AWS over time

From your perspective:

* You receive USDC (or other supported assets) over x402
* AWS bills you monthly in fiat

Operationally you need:

1. **Treasury policy**: convert stablecoins to fiat periodically (daily/weekly) to cover AWS bill and maintain margin
2. **Reconciliation**:

   * meter-based “expected AWS cost” vs actual AWS invoice
   * alert on drift (e.g., if you enabled backups or global tables unexpectedly)
3. **Risk controls**:

   * per-table budget caps enforced at gateway
   * lease expiration so abandoned tables don’t accumulate cost indefinitely

---

## Cost model and pricing

This section defines the concrete cost model: how AWS DynamoDB costs map to AgentDB pricing, with margins, metering formulas, deposit calculations, and abuse prevention knobs.

All figures assume **us-east-1, DynamoDB Standard table class, on-demand capacity mode**.

### AWS cost basis (5 categories)

#### A. DynamoDB variable costs

1. **Write request units (WRU)**: $1.25 / 1M WRU → $0.00000125 per WRU
   * 1 WRU = writing up to 1 KB (rounded up in 1 KB chunks)
2. **Read request units (RRU)**: $0.25 / 1M RRU → $0.00000025 per RRU
   * 1 RRU = strongly consistent read up to 4 KB (rounded up in 4 KB chunks)
   * Eventually consistent reads = 0.5 RRU
3. **Storage**: $0.25 / GB-month
   * Do not pass through AWS free tier (25 GB); it is account-level and disappears at scale
   * Shared table has a GSI (`_tid` + `PK`) which roughly doubles storage for indexed attributes

#### B. Egress (data transfer out)

* First 100 GB/month free (account-level), then ~$0.09/GB
* Reads returning JSON over the internet dominate this cost category
* At scale, egress can exceed DynamoDB variable costs for read-heavy workloads with large items

#### C. Fixed infrastructure (baseline cost at zero traffic)

| Component | Estimated monthly cost |
|---|---:|
| ALB | ~$16 |
| ECS Fargate (2 tasks minimum) | ~$30 |
| CloudWatch (logs + metrics) | ~$5–10 |
| WAF | ~$5 |
| **Total baseline** | **~$50–100/mo** |

These costs exist regardless of customer traffic and must be covered by margin + table-day fees.

#### D. Payment facilitation

* Chain gas: <$0.01 per transaction on Base L2
* Stablecoin → fiat conversion: 0.5–1.5% (treasury policy dependent)
* These are small per-transaction but material at low volume

#### E. Internal metering overhead

* ~1–2 extra WRU per request for ledger balance updates (atomic conditional writes)
* This is an internal cost not directly billed to the customer but recovered in margin
* Bad-debt risk if concurrency races allow small negative balances

### Canonical metering units

Implement these exact unit calculations at the gateway for quotes, budget enforcement, and billing.

**Item size**: `itemBytes = byteLength(JSON_canonicalized)` (or stricter attribute-by-attribute estimator). Enforce `itemBytes <= MAX_ITEM_BYTES`.

**Write units**: For any put/update/delete:
* `wru = ceil(itemBytes / 1024)`
* For v1, charge updates as worst-case full item write (simpler and safer than delta estimation)

**Read units**: For Get/Query/Scan results:
* `rru_per_item_strong = ceil(itemBytes / 4096)`
* `rru_per_item_eventual = 0.5 * ceil(itemBytes / 4096)`
* For Query/Scan, bill based on **items evaluated**, not just returned (DynamoDB charges for what it reads)

**v1 recommendation**: Only allow Query patterns without server-side FilterExpressions (or cap them hard).

### `ReturnConsumedCapacity` mandate

ALL DynamoDB calls MUST include `ReturnConsumedCapacity: TOTAL`. This enables accurate billing:

1. **Pre-hold**: Use a pre-computed worst-case estimate (from item size / query limits) to place a hold on the customer's balance before the DynamoDB call
2. **Actual debit**: Use the `ConsumedCapacity` value from the DynamoDB response for the final debit
3. **Reconciliation**: If actual > hold, debit actual (customer slightly under-held). If actual < hold, release the excess hold back to available balance.

This two-phase approach ensures the gateway never under-charges while minimizing over-holds.

### Retail price sheet (v1 — Ephemeral / Dev tier, us-east-1)

Pricing principle: reduce fees previously justified by physical-table overhead (create, table-day), increase where markup is too thin to cover real costs (storage with GSI duplication, egress).

#### Data-plane usage

| Meter | AWS cost | AgentDB retail | Markup | Notes |
|---|---:|---:|---:|---|
| Writes (per 1M WRU) | $1.25 | **$7.50** | 6.0× | Unchanged |
| Reads (per 1M RRU) | $0.25 | **$1.50** | 6.0× | Unchanged |
| Storage (per GB-month) | $0.25 | **$1.50** | 6.0× | +50% from $1.00 — GSI duplication roughly doubles indexed-attribute storage |
| Egress (per GB) | ~$0.09 | **$0.30** | ~3.3× | +50% from $0.20 — must be profitable standalone; no free-tier pass-through |

Rationale:
* Reads stay cheap (DynamoDB reads are cheap), but >$0 so scans deplete attacker balances quickly
* Writes are materially more expensive than reads in DynamoDB; pricing reflects that
* Storage increased to 6× to absorb GSI duplication overhead and be profitable after fixed-cost allocation
* Egress increased to $0.30/GB — reads returning large JSON payloads can make egress the dominant cost; must carry its own margin

#### Table lease fee (sprawl control + fixed overhead)

| Tier | Fee | Change |
|---|---:|---|
| Ephemeral (Dev) | **$0.005 / table-day** | -50% (no physical DynamoDB table to maintain) |
| Project | **$0.01 / table-day** | -67% (no physical DynamoDB table to maintain) |

Reduced because the shared multi-tenant table eliminates per-table AWS infrastructure cost. The fee still prevents “create 50K tables for free” abuse and pays for control-plane metadata + logs.

#### Control-plane operations

| Operation | Price | Change |
|---|---:|---|
| `create_table` | **$0.02** (or absorbed into minimum deposit) | -60% (metadata insert, not AWS `CreateTable`) |
| `delete_table` | free | — |
| `export` | price by bytes + compute (or require Project tier) | — |

Create fee reduced because table creation is now a sub-second metadata insert, not a 20–60 s AWS `CreateTable` call.

#### Egress billing formula

For every read response, egress is metered and billed separately from RRU:
* `egress_bytes = byteLength(HTTP response body)`
* `egress_cost = (egress_bytes / 1,073,741,824) * $0.30`
* Total read cost = RRU cost + egress cost
* New metering header: `X-Metered-Egress-Bytes`

#### Margin analysis (honest breakdown)

Replace the previous “Target: ~70–85% gross margin” with a scenario-based analysis:

| Scenario | Gross margin | Notes |
|---|---:|---|
| Write-heavy (small items) | ~83% | Best case — DynamoDB writes are well-marked-up |
| Read-heavy (small items) | ~83% | Similar to writes at 6× markup |
| Read-heavy (large items, egress-dominated) | ~65–70% | Egress at $0.30 vs ~$0.09 is thinner |
| **Break-even point** | — | ~$120/mo revenue covers ~$80/mo fixed costs at 33% net margin |

At low volume, AgentDB operates at a loss (expected during early growth). Fixed infrastructure costs (~$50–100/mo) dominate until revenue crosses the break-even threshold.

### Per-operation billing formulas

#### PutItem
* `wru = ceil(itemBytes / 1024)`
* charge: `wru * price_wru`

#### GetItem
* `rru = ceil(itemBytes / 4096)` (strong) or `0.5 * ceil(itemBytes / 4096)` (eventual)
* charge: `rru * price_rru`
* Item not found: still bill `rru = 1` (strong) or `0.5` (eventual) — DynamoDB charges a minimum read

#### DeleteItem
* Bill `wru = 1` (delete consumes write units even for small items)

#### UpdateItem (v1: replace semantics)
* Require client to send full item (replace semantics) in v1; bill as PutItem
* This avoids needing a size-delta estimator

#### Query
* Bill for **items evaluated** (close to returned if FilterExpression is disallowed)
* Disallow FilterExpression in v1; require KeyCondition-only
* Enforce `Limit <= MAX_QUERY_LIMIT`
* Bill: `sum(rru(item))` for returned items (or use DynamoDB `ConsumedCapacity`)

#### Scan (guarded)
* Explicit opt-in per table
* Hard caps: `MAX_SCAN_ITEMS`, `MAX_SCAN_MB`, `MAX_SCAN_SECONDS`
* Pre-check with worst-case RRUs based on caps
* Bill actual via `ConsumedCapacity`

#### BatchWrite / BatchGet
* BatchWrite: sum WRUs per item
* BatchGet: sum RRUs per item (not-found items still cost ~1 RRU minimum each; meter as 1 strong / 0.5 eventual)

### Deposit + lease model

Deposits must be large enough to: (1) cover baseline storage + table-day fee for the lease period, and (2) cover a burst buffer so hot loops can’t run up AWS cost before the 402 gate triggers.

#### Minimum deposit formula (per table)

```
min_deposit = D * (table_day_fee + storage_price_per_day(S_gb))
              + D * Ops_budget_day
              + Safety
```

Where:
* `D` = lease days (default 7)
* `table_day_fee` = $0.005 (Ephemeral) or $0.01 (Project)
* `S_gb` = expected storage GB (from quote inputs; if unknown assume 0.1 GB)
* `Ops_budget_day` = user-declared daily budget OR default ($1/day)
* `Safety = max($0.50, 2 * Ops_budget_day)` (reduced from $1.00 — lower table overhead)
* `storage_price_per_day(S_gb) = S_gb * ($1.50 / 30)`

Note: for read-heavy workloads with large items, egress can exceed RRU cost. The quote endpoint should factor expected response sizes into its deposit recommendation.

### Worst-case cost enforcement (pre-AWS rejection)

#### Two-balance system

* `ledger_balance`: credits − debits, append-only
* `available_balance = ledger_balance - holds`

#### Per-request hold flow

1. Compute **worst_case_cost** from request parameters + enforced caps (pre-computed estimate)
2. If `available_balance < worst_case_cost`: return **402 top-up required**
3. Place a **hold** for `worst_case_cost`
4. Execute DynamoDB call with `ReturnConsumedCapacity: TOTAL`
5. Compute **actual_cost** from `ConsumedCapacity` response + egress bytes:
   * `actual_rru_cost = ConsumedCapacity.CapacityUnits * price_rru` (for reads)
   * `actual_wru_cost = ConsumedCapacity.CapacityUnits * price_wru` (for writes)
   * `actual_egress_cost = byteLength(response_body) / 1GB * $0.30` (for reads)
   * `actual_cost = actual_rru_or_wru_cost + actual_egress_cost`
6. Release hold, debit `max(actual_cost, worst_case_cost)` — if actual exceeds estimate (rare), still debit actual to avoid operator loss

This prevents concurrent expensive calls from racing into negative balance.

#### Worst-case cost formulas

* **Put**: `worst_case_wru = ceil(itemBytes / 1024)` → `worst_case_cost = worst_case_wru * price_wru`
* **Get**: `worst_case_rru = ceil(MAX_ITEM_BYTES / 4096)` → `worst_case_cost = worst_case_rru * price_rru`
* **Query**: `worst_case_rru = Lmax * ceil(Imax / 4096)` (where `Lmax` = max query limit, `Imax` = max item bytes)
* **Scan**: `worst_case_rru = min(Nmax * ceil(Imax / 4096), (MBmax * 1024 * 1024) / 4096)` (bounded by whichever cap is tighter)

#### Budget enforcement at precheck

Before executing, check:
* `spent_today + worst_case_cost <= daily_cap`
* `spent_lifetime + worst_case_cost <= lifetime_cap`

### Abuse prevention controls

#### Table sprawl / control-plane abuse
* Max tables per wallet: 50 (shared across tiers, per D9/D13)
* Table creation fee ($0.02) + table-day fee ($0.005 Ephemeral / $0.01 Project)
* Require non-trivial minimum deposit per table
* With the shared multi-tenant table, table sprawl no longer risks hitting AWS table-count limits, but metadata/ledger overhead and storage costs still motivate the cap

#### Oversized items / attribute bombs
* `MAX_ITEM_BYTES`: 64 KB (dev), 256 KB (project) — well below DynamoDB’s 400 KB limit
* `MAX_ATTR_COUNT`, `MAX_NESTING_DEPTH`, `MAX_STRING_BYTES`
* Reject compressed/base64 blobs unless explicitly supported (they bypass naive size estimates)

#### Hot loops / request floods
* Hard **ops/sec** per table and per workspace
* Hard **concurrency** limits per table/workspace
* Idempotency keys for writes (prevent retry storms from double-charging)
* **429** for rate-limit, **402** for insufficient funds — both before AWS call

#### Scan / query amplification
* Scans off by default; opt-in + hard caps
* Queries: key-condition only (no filters) in v1, or meter by `ConsumedCapacity` with worst-case pre-hold
* Strict pagination; max page size; max total pages per minute

#### Free endpoint amplification
* Auth required for usage/logs endpoints
* Strict time-range caps and pagination
* Rate-limit `/quote` and/or charge $0.001, or require workspace deposit before heavy quoting

### Default limits (v1 — Ephemeral / Dev tier)

| Limit | Value |
|---|---:|
| Max item size | 64 KB |
| Max query limit | 100 items |
| Scan | disabled by default |
| Ops/sec per table | 10 (burst 20) |
| Concurrency per table | 5 |
| Max tables per wallet | 50 |
| Default lease | 7 days |
| Default ops budget/day | $1.00 |

### Reconciliation against AWS bill

Even with perfect metering, expect deltas from rounding, internal retries, background ops (health checks, TTL deletions), data transfer paths, and operational changes (e.g., accidentally enabling PITR).

Process:
1. **Gateway ledger is source of truth for customer billing**
2. Daily job: compare metered DynamoDB units vs CloudWatch DynamoDB metrics / AWS CUR
3. Alert on drift > X% per day per region/account
4. If drift is consistently positive (AWS > metered), increase multipliers or fix missing meters

Additional reconciliation items:
* **Egress**: compare metered `X-Metered-Egress-Bytes` totals against AWS data transfer line items in CUR
* **Internal metering overhead**: ledger writes (~1–2 WRU per customer request) are an internal cost; track separately and ensure margin covers them
* **GSI storage**: the `_tid + PK` GSI roughly doubles storage for indexed attributes; reconcile against DynamoDB storage metrics

---

## The “minimal v1” I’d ship first (fastest path)

If you want something that works well for coding agents quickly:

* Regional tier only (single region)
* On-demand capacity only
* Shared multi-tenant DynamoDB table (PK-prefixed logical isolation, GSI for scans)
* Supported ops: Create, Put/Get/Update/Delete, Query-by-key, Scan (guarded), Batch get/write, List tables, Delete
* Lease model:

  * default 7-day expiry
  * top-up to extend
* Cost transparency:

  * quote + live usage + receipts
* Logs:

  * ops+audit logs for 7 days
* x402:

  * enforce on create + top-up + exports
  * payment-identifier extension on all writes

Then iterate:

* multi-region tier (Global Tables)
* longer log retention
* optional backups
* optional single secondary index tier
* SIWX-based auth to eliminate capability tokens (if you want wallet-only UX) ([x402][8])

---

## Security threat model and hardening

This section covers attacks that can cause **data leakage** or **money loss** (operator or user), with mitigations and integration test specifications. This is a protocol/SaaS threat model, not a code review.

### Threat model: assets and trust boundaries

**Assets to protect**

1. **Customer data** in tables (confidentiality + integrity)
2. **Customer funds** (avoid double charges, unauthorized charges)
3. **Operator money** (AWS bill, fraud, abuse, cost spikes)
4. **Secrets**: capability tokens, wallet auth proofs, facilitator credentials, AWS credentials
5. **Receipts/logs** (contain sensitive metadata; can enable further attacks)

**Trust boundaries**

* Public internet → `app.run402.com` gateway (control + data plane)
* Gateway → x402 facilitator (`/verify`, `/settle`)
* Gateway → AWS DynamoDB (and any metering/ledger store)
* Wallet identity / SIWX (off-chain signatures) or capability tokens

---

### Data theft attacks

#### T1) “Pay-to-steal” (missing authorization binding)

**Attack:** If “payment == authorization,” any payer can access any table ID they can guess/obtain.

**Impact:** Direct cross-tenant reads/writes/deletes.

**Mitigations**

* Enforce **ownership** on every request, independent of payment:
  * **Wallet-as-identity**: table/workspace records must bind `table_id → owner_wallet` and require that the **verified payer** matches owner (or is delegated)
  * **Capability tokens**: require `Authorization: Bearer <table_secret>` and bind that secret to a single table/workspace + scopes
* If using both (recommended): require *either* wallet owner *or* a valid scoped capability; never “any payer”

**Integration tests**

* Create table as Wallet A; attempt `GET/PUT/DELETE` with Wallet B paying correctly → must be **403**
* Attempt access with no capability and no SIWX → **401/403** even if payment settles

#### T2) Payment replay / cross-request reuse

**Attack:** A `PAYMENT-SIGNATURE` (or facilitator verification artifact) is replayed for multiple writes, different endpoints, or different table IDs.

**Impact:** Free operations, unauthorized access.

**Mitigations**

* Use x402 **payment-identifier** idempotency extension *and* bind payment to request:
  * Include at minimum: `method`, `path`, canonical query, `content-digest`/body hash, timestamp, expiration, and an idempotency key
  * Server must reject if any mismatch
* Maintain a **spent/seen registry** of payment identifiers (durable store, not in-memory)
* Expire payment proofs quickly (clock-skew tolerant)

**Integration tests**

* Reuse identical `PAYMENT-SIGNATURE` for the same request twice → second must be **409** (“already used”) without performing the write
* Reuse the signature for same path but different body/pk → must be **400/403**
* Reuse for a different endpoint (quote → create) → must be rejected
* Concurrency: 20 parallel retries with same payment-id → only one succeeds

#### T3) Capability token leakage

**Attack:** If using `table_secret` capabilities, they leak via CLI debug logs, shell history, proxies/APM, browser referer headers, support tickets, and agent prompt injection (agent prints secrets to tool output).

**Impact:** Full table compromise until rotated.

**Mitigations**

* Only accept secrets in `Authorization` header; never in URL/query
* Store secrets **hashed** server-side; show only once on creation; allow rotation
* Scope tokens (read vs write vs admin; table-bound; TTL)
* Add “break-glass” revoke API and automatic rotation recommendations
* Redact `Authorization`, `PAYMENT-*`, SIWX payloads from logs by default

**Integration tests**

* Ensure API rejects `?table_secret=` or `X-Api-Key` if not intended
* Verify logs/audit events never include raw tokens (snapshot test on log output)
* Token rotation test: old token stops working immediately

#### T4) Table ID enumeration + insecure object references

**Attack:** If `table_id` is guessable (sequential, short, user-chosen), attackers enumerate and try stolen capabilities or replayed payments.

**Mitigations**

* Make `table_id` server-assigned, high-entropy (e.g., 128-bit)
* If allowing user labels, keep them separate from the routing identifier
* Return identical error shape for “not found” vs “not authorized” (avoid oracle)

**Integration tests**

* Attempt random table IDs → must not leak existence via timing/status differences
* Fuzz `table_id` with path traversal strings, unicode, very long input → must be rejected early

---

### Money loss attacks (runaway AWS cost)

#### T5) Cost blow-up via scans, hot loops, oversized items, table sprawl

**Attack:** Attackers create operations that are cheap for them but expensive for the operator: scans across large tables, huge items near DynamoDB limits, high RPS storms, creating many tables, long TTL / no expiry.

**Impact with shared multi-tenant table:** Table sprawl no longer risks hitting AWS table-count limits (since all data is in one shared table), but it still incurs metadata/ledger overhead and can amplify GSI storage costs. The primary cost risks shift to data-plane abuse (scans, large items, egress amplification).

**Mitigations**

* **Hard limits at gateway** (enforced before hitting DynamoDB):
  * max item size, max attributes, max query page size, max scan items/MB
  * max ops/sec per table and per payer
  * max concurrent requests per table
  * max tables per wallet: 50 (per D9/D13)
* “Scan” must be **explicit opt-in** + strict caps (implemented as GSI query on shared table, but still bounded)
* Consider DynamoDB **provisioned capacity with maximums** for tiers where cost predictability matters (on-demand can spike)
* Implement **real-time budget enforcement** on the request path (not async): reject before calling AWS if remaining budget < worst-case cost of request (including egress estimate for reads)
* Default TTL/lease expiry must be **hard** and non-extendable without top-up

**Integration tests**

* Scan without opt-in → rejected
* Scan with opt-in but exceeding caps → rejected and does not hit DynamoDB (assert via mock/CloudTrail)
* Oversized item (> limit) → rejected pre-AWS
* RPS test: exceed ops/sec → **429** and costs stay bounded
* Create 51 tables attempt → blocked by quota (50 max per wallet)

#### T6) Payment under-collection (price confusion / tampering)

**Attack:** Client manipulates headers, claims a cheaper price, reuses an old quote. Disagreement between “metered usage” and “settled payment” allows operations without adequate balance. Facilitator errors treated as success.

**Mitigations**

* Server is the source of truth for price: the `PAYMENT-REQUIRED` header must include a **server-generated quote id**; settlement must reference that id
* Treat facilitator calls as a strict gate:
  * fail closed if `/verify` is ambiguous
  * settle must be idempotent and recorded
* Maintain a **double-entry ledger**: (credits from settlement) vs (debits from metered usage)
* Reconcile and alert on negative balances; enforce “cannot go below zero” for non-free tiers (or allow small credit line only with risk scoring)

**Integration tests**

* Tamper `PAYMENT-REQUIRED` content client-side (lower amount) but keep signature valid for that content → server must reject because it doesn’t match server quote id
* Facilitator timeout: request must fail (no DynamoDB write)
* Simulate ledger drift: ensure enforcement stops operations at threshold

#### T7) Double-charge / duplicate writes (idempotency gaps)

**Attack:** Retries due to network issues cause user charged twice, or single payment but multiple writes.

**Mitigations**

* Payment idempotency key must tie together:
  * settlement idempotency
  * and operation idempotency (write is “exactly once” where promised)
* For writes, require an `Idempotency-Key` header (or x402 payment-identifier) and store outcome

**Integration tests**

* Force client retry after server processes but before response → ensure only one charge and one write
* Retry after payment settled but before DynamoDB call → ensure deterministic outcome

#### T8) Free endpoints abused for amplification

**Attack:** Quote, logs, usage, and receipts endpoints abused for high CPU (pricing calc, large time ranges), data exfil (logs leak request bodies/keys), and enumeration/correlation.

**Mitigations**

* Require auth (wallet/SIWX or capability) for any table-scoped metadata
* Put strict pagination + time range caps on logs/usage
* Consider making quote cheap-but-not-free, or rate limit heavily with PoW/captcha for anonymous

**Integration tests**

* `GET /logs?from=1970...` huge range → capped/paginated
* Unauth logs/usage access → 401/403
* Rate-limit tests for quote endpoint

---

### Protocol / platform attacks

#### T9) Facilitator compromise or malicious facilitator responses

**Attack:** If the facilitator lies (“verified” when not paid), or its endpoint is MITM’d, the service serves requests without being paid.

**Mitigations**

* Pin facilitator via TLS + robust DNS hygiene; consider allowing multiple facilitators and quorum/backup
* Validate facilitator responses strictly (signatures, chain finality rules)
* Keep an allowlist of accepted `chain_id`, token contract, and settlement destinations

**Integration tests**

* Fake facilitator returning “OK” without valid proof → server must reject
* Wrong chain/token/recipient → server must reject

#### T10) Header injection / oversized headers

**Attack:** Base64 JSON `PAYMENT-*` headers can become large; attackers send huge headers to trigger proxy failures, memory pressure, log injection, and parsing vulnerabilities.

**Mitigations**

* Enforce maximum header sizes at edge (CDN/WAF) and app
* Strict base64 decode limits and JSON schema validation
* Never log raw `PAYMENT-*` headers

**Integration tests**

* Send 1MB `PAYMENT-SIGNATURE` header → rejected at edge/app; no crash
* Malformed base64/JSON → 400, no stack trace leak

#### T11) Agentic prompt injection causing secret exfil

**Attack:** Attackers store malicious content in the DB that instructs the agent to exfiltrate capability tokens, wallet signing requests, or internal endpoints.

**Mitigations**

* Client/CLI defaults that:
  * never print capability secrets after creation
  * require explicit confirmation for payments above `--run402-max-pay-usd`
  * support allowlists for endpoints (prevent SSRF-like tool calls)
* Offer “safe mode” SDK wrappers: redact secrets, prevent tool output from containing tokens, tag untrusted data

**Integration tests**

* Store prompt-injection string in an item; ensure CLI/SDK does not echo secrets or auto-approve unexpected payments

---

### AWS / infrastructure hardening

#### T12) AWS credential leakage / over-privileged IAM

**Attack:** If the gateway is compromised and has broad DynamoDB permissions, attacker can dump or delete everything, or create expensive resources.

**Mitigations**

* Use IAM roles (not SSO profiles) in production with:
  * least privilege to only the table ARNs you manage
  * explicit denies for non-DynamoDB services
  * separation of duties: control plane role vs data plane role
* Consider **per-environment AWS accounts** (dev/stage/prod) and possibly per-tier accounts to contain blast radius
* Use KMS CMKs where appropriate; restrict key usage

**Integration tests**

* IAM policy tests (automated): attempt forbidden AWS actions from app role (e.g., create unrelated resources) must fail
* Attempt access to a table not owned/registered must fail even if name matches prefix

#### T13) Deletion, suspension, and retention failures

**Attack:** If “auto-expire” fails silently, abandoned tables accumulate storage forever (operator’s bill). If deletion is too aggressive, customers lose data unexpectedly.

**Mitigations (shared multi-tenant table)**

* Make lifecycle a state machine: `ACTIVE → SUSPENDED → DELETING → DELETED`, all transitions logged/auditable
* **Deletion is TTL-based**: when a table expires, set `_ttl` on all items belonging to that logical table. DynamoDB TTL automatically removes items (typically within 48 hours). Set metadata status to `DELETED`.
* Daily sweeper checks for tables in `DELETING` state where items with matching `_tid` still exist past TTL + 48h buffer → alert on stuck items
* No `DeleteTable` API call needed — the shared table persists; only the logical table’s items are cleaned up
* Consider PITR/backups for paid tiers; encryption and access controls apply to backups too

**Integration tests**

* Simulate expired lease → table becomes inaccessible; after grace, items receive `_ttl`
* Verify TTL-expired items are eventually removed (assert via GSI query on `_tid` returns zero items)
* Verify metadata record transitions to `DELETED` and is no longer listable

---

### Hardening checklist (launch blockers)

1. **Identity & access**: Wallet-bound workspace identity (SIWX) + optional scoped capabilities. Per-request authorization checks independent of payment.
2. **Payment correctness**: Bind payment proof to request; durable spent registry; strict facilitator validation. Durable ledger; never allow negative balance unless explicitly risk-scored.
3. **Abuse controls**: Edge rate limiting (per IP, per wallet, per table), quotas, concurrency limits. Guard scan + batch ops + big payloads.
4. **Data isolation**: Server-assigned random IDs; no user-controlled AWS resource names. Strong audit logs with redaction; minimize metadata leaks.
5. **Operational controls**: Reconciliation (expected usage vs AWS bill; anomaly detection). Kill switches (disable scan globally; freeze a workspace; emergency budget clamp).

### Integration test suite summary (security-focused)

**AuthZ / isolation**

* Cross-wallet access denied (read/write/delete)
* Capability scope tests (read-only token cannot write/delete)
* Token revocation/rotation effective immediately

**Payment / x402 correctness**

* Replay attack tests (same payment used twice)
* Cross-request binding tests (same payment used for different endpoint/body)
* Settlement idempotency under retries/concurrency
* Facilitator failure modes: timeout, 500, malformed response, wrong token/chain

**Budget / abuse / DoS safety**

* Budget exhaustion stops DynamoDB calls (verify via CloudTrail or mock)
* Scan limits: opt-in required, page limits enforced
* Payload limits: large headers/body rejected
* Rate limit: sustained RPS results in 429 and stable AWS consumption

**Logging / privacy**

* Ensure no secrets in logs (Authorization, payment payloads, SIWX)
* “Not found” vs “forbidden” indistinguishable to outsiders

**Lifecycle**

* Expiry → suspend → delete flow behaves and is auditable
* “Stuck deletion” detection triggers alerts

---

If you want, I can also draft:

* a concrete OpenAPI spec for the endpoints above,
* the metering schema (how you compute units deterministically for each operation),
* and a reference “AgentDB Broker” MCP tool interface tailored to Claude Code’s workflow (quote → approval → create → use → top-up).

[1]: https://docs.x402.org/ “Welcome to x402 - x402”
[2]: https://docs.x402.org/core-concepts/http-402 "HTTP 402 - x402"
[3]: https://docs.x402.org/core-concepts/facilitator "Facilitator - x402"
[4]: https://docs.x402.org/extensions/payment-identifier "Payment-Identifier (Idempotency) - x402"
[5]: https://aws.amazon.com/dynamodb/pricing/on-demand/ "Amazon DynamoDB pricing for on-demand capacity – Serverless Distributed NoSQL Database – AWS"
[6]: https://aws.amazon.com/dynamodb/sla/ "Amazon DynamoDB Service Level Agreement"
[7]: https://docs.x402.org/core-concepts/wallet "Wallet - x402"
[8]: https://docs.x402.org/extensions/sign-in-with-x "Sign-In-With-X (SIWX) - x402"
[9]: https://aws.amazon.com/api-gateway/sla/?utm_source=chatgpt.com "Amazon API Gateway Service Level Agreement"
[10]: https://docs.x402.org/guides/mcp-server-with-x402 "MCP Server with x402 - x402"
[11]: https://docs.x402.org/getting-started/quickstart-for-sellers "Quickstart for Sellers - x402"



Below is a **market research + competitive landscape** for **AgentDB** by **Run402**: an **agent-native cloud NoSQL database** that can be **provisioned and paid for via x402** (HTTP 402 + stablecoin settlement) so users don’t need cloud accounts (AWS/GCP/etc.), and agents can present **pre-approval cost estimates**, enforce **budgets**, and provide **cost/log visibility**.

The product is **AgentDB** (Run402's initial product). Under the hood it runs DynamoDB, but the analysis assumes you **do not disclose that** publicly.

---

## Executive summary

* The closest “shape” of market today is **serverless databases + BaaS**, where developers expect *instant provisioning, scale-to-zero-ish economics, and predictable pricing controls*. Serverless computing is widely forecast as a large and growing market (estimates vary, but it’s clearly multi‑$B and growing). ([Grand View Research][1])
* The **NoSQL market** itself is also projected to grow strongly (again, third-party estimates vary, but it’s clearly large and expanding). ([Mordor Intelligence][2])
* The differentiator is **not “pay per request”** (many already do); it’s **“no signup + agent-native procurement + standardized paywall semantics via x402”**.
* x402 is positioned specifically as an **open payment protocol** that revives HTTP **402 Payment Required** so clients (including agents) can pay programmatically without accounts/sessions. Coinbase documents x402 as an open protocol it developed, and Cloudflare + Coinbase announced intent to create an **x402 Foundation** (a strong ecosystem signal). ([docs.cdp.coinbase.com][3])
* Your direct competitive set is led by **Upstash (serverless Redis)**, **Cloudflare KV/D1**, **Turso (distributed SQLite/libSQL)**, **Firebase/Firestore**, and **traditional DynamoDB/NoSQL** offerings, plus “serverless SQL” providers (Neon, CockroachDB, Xata, PlanetScale) that often get used as “the database” even for KV-ish workloads. ([Upstash: Serverless Data Platform][4])
* Most competitors optimize for **developer onboarding + billing via account**, not for **autonomous agents** that must spin infra up at runtime without humans creating vendor accounts.
* The biggest product risks are: (1) **x402 adoption timing**, (2) **payment/regulatory + fraud/abuse controls**, (3) **your gateway becoming the SLA bottleneck**, and (4) **“why not just use SQLite locally?”** substitutes.

---

## Market definition: what category are you actually in?

AgentDB sits at the intersection of three existing markets:

1. **Serverless databases / DBaaS / “instant DBs”**

   * Users want fast provisioning, elastic scaling, managed backups, and predictable billing.

2. **BaaS / “backend primitives”** (auth/storage/functions bundled)

   * Supabase and Firebase are reference points here; they sell a *platform*, not just a DB. ([Supabase][5])

3. **Agentic tooling and agent commerce payments**

   * x402 explicitly targets programmatic agent payments via HTTP 402. ([docs.cdp.coinbase.com][3])

A useful framing:
**AgentDB is “Stripe Checkout for cloud state”**—an agent can request a resource, receive a standardized 402 paywall with pricing, and proceed only after “funds available”.

---

## Key demand drivers

### 1) Developers already prefer serverless “pay for what you use”

Multiple popular database services emphasize usage-based pricing and cost controls:

* **Upstash Redis**: per-request pricing like **$0.20 per 100K requests**, plus storage and bandwidth line items. ([Upstash: Serverless Data Platform][4])
* **Neon** moved/marketed toward usage-based compute/storage with controls like autoscaling limits and scale-to-zero behavior. ([Neon][6])
* **Cloudflare KV** and **Firestore** are per-operation/per-storage models with free tiers and then usage-based billing. ([Cloudflare][7])

So the market is already trained to accept “metered database primitives”.

### 2) AI coding agents increase “infra spin-up events”

If coding agents are increasingly used to build/modify software, they will also increasingly be the ones to **instantiate dependencies** (DBs, queues, caches) during iteration cycles.

Even if you ignore “AI market size” forecasts (often noisy), the *qualitative* signal is strong: AI coding tools are mainstream enough to show up as a material business/industry storyline. ([Investors][8])

### 3) Standardization is the unlock: x402 + MCP

x402 is explicitly built around HTTP 402 and standard headers for payment negotiation (`PAYMENT-REQUIRED`, `PAYMENT-SIGNATURE`, etc.). ([docs.x402.org][9])
Cloudflare’s x402 announcement also explicitly mentions adding x402 support to agent tooling (Agents SDK & MCP servers), which matters a lot for distribution. ([The Cloudflare Blog][10])
And x402 provides a guide for an MCP server that bridges agents like Claude Desktop to paid x402 APIs. ([docs.x402.org][11])

This is relevant because your “customer” is often **a toolchain** (agent runtime / broker / IDE extension), not a human browsing a pricing page.

---

## Customer segments and best “wedge” use cases

### Segment A — Local coding agents (your example)

**Who:** Claude Code / Cursor / local dev agents, running on a laptop or dev workstation.
**Job-to-be-done:** “I need a DB now; tell me the max cost; spin it up and keep me safe.”

**What they value most:**

* 30-second provisioning
* explicit max spend + auto-expire
* receipts, logs, easy cleanup

**Why they won’t just use a competitor:** because the agent can’t reliably handle “sign up / verify email / add card / create project / copy API keys” flows.

### Segment B — Platform teams enabling internal agents

**Who:** companies building internal coding agents, IT automation, etc.
**Job:** “Let agents provision safe sandboxes without granting AWS accounts.”

**What they value most:**

* strong audit logs
* policy controls (budget caps, TTL, retention)
* SLA and clear support channel

### Segment C — Indie developers / hackathon builders

This segment is less strategic because onboarding friction is already low (they’ll just sign up for Upstash/Turso/Supabase). But it can be a high-velocity GTM channel if you’re in the agent ecosystem early.

---

## Competitive landscape

### 1) Direct substitutes: “serverless KV / NoSQL primitives”

**Upstash (Redis-compatible)**

* Strong “serverless KV” mindshare, simple onboarding, per-request pricing (**$0.20 per 100K requests**, plus storage/bandwidth). ([Upstash: Serverless Data Platform][4])
* Also markets production add-ons including uptime/SLA, monitoring, etc. ([Upstash: Serverless Data Platform][12])
* Weakness vs AgentDB: still **account + credential** based, not x402-native.

**Cloudflare KV**

* Clear usage pricing model (reads/writes/storage) and integrates naturally with Workers. ([Cloudflare][7])
* Weakness vs AgentDB: account required; KV semantics are not the same as a “table” store, and consistency tradeoffs may matter.

**Google Firestore**

* Very popular NoSQL doc store with clear free tier quotas (e.g., reads/writes/deletes per day and 1 GiB storage in free tier). ([Google Cloud][13])
* Weakness vs AgentDB: account + billing enablement required; pricing can surprise at scale; not agent-native procurement.

**AWS DynamoDB directly**

* Pay-per-request pricing and strong AWS ecosystem; official SLA is **99.99%** for standard tables and **99.999%** for Global Tables. ([Amazon Web Services, Inc.][14])
* Weakness vs AgentDB: requires AWS account, IAM, billing setup.

### 2) “Agent-adjacent” direct competitor: Turso (distributed SQLite/libSQL)

Turso explicitly positions itself as “scales to millions of agents,” which is unusually on-the-nose for your market. ([turso.tech][15])
It also has a clear pricing page with usage metrics like “monthly active databases” and read/write limits. ([turso.tech][16])

Turso is a serious competitor because:

* it already owns “agents + database” messaging
* it feels lightweight and developer-friendly
* it has a CLI workflow that can map well to agent operations

Weakness vs AgentDB:

* still fundamentally **account + billing**; not x402 procurement
* different data model (SQLite/libSQL) vs KV/NoSQL semantics (depending on your API design)

### 3) Indirect competitors: serverless SQL used as “the DB anyway”

Many teams will use Postgres/MySQL serverless offerings even for KV-like needs.

* **Neon**: usage-based pricing; emphasizes cost control via autoscaling limits and scale-to-zero. ([Neon][6])
* **Supabase**: “Postgres + platform” (auth, storage, realtime, edge functions). Pricing starts with paid tiers and includes compute credits. ([Supabase][5])
* **CockroachDB Serverless**: explicitly advertises a **99.99% uptime SLA** and user-set monthly resource limits to prevent surprise bills. ([cockroachlabs.com][17])
* **Xata**: Postgres-oriented platform with instance pricing and branching narratives. ([Xata][18])
* **PlanetScale**: MySQL/Vitess; pricing positioning has shifted toward higher-end plans (at least “starting at $50/month” on the main page at the time of this research). ([planetscale.com][19])

These are not “accountless,” but they set user expectations for:

* branching / preview DBs
* scale-to-zero
* guardrails (budget caps)

### 4) Platforms that reduce friction (but still require accounts): Vercel Marketplace Storage

Vercel explicitly positions its Marketplace Storage as a way to provision DBs from providers like **Neon, Upstash, and Supabase** via the Vercel dashboard, with credentials injected into env vars. ([Vercel][20])
Also noteworthy: **Vercel KV is no longer available**, and Vercel has pointed users toward Marketplace integrations / Upstash. ([Vercel][21])

This matters because Vercel is a distribution channel and “developer workflow owner.” AgentDB could try to become a Marketplace-style primitive for agents instead of for dashboards.

---

## Competitive comparison matrix

Here’s the crispest way to see the whitespace (✅ = strong fit, ⚠️ = partial, ❌ = not really):

| Provider               | “No account needed” |                     Agent-native procurement |                                    Usage-based billing |                                      Built-in spend caps / budgets |                                                  SLA story |
| ---------------------- | ------------------: | -------------------------------------------: | -----------------------------------------------------: | -----------------------------------------------------------------: | ---------------------------------------------------------: |
| **AgentDB (you)**      |            ✅ (x402) |                          ✅ (designed for it) |                                                      ✅ |                                                                  ✅ |                                        ✅ (you can tier it) |
| Upstash                |                   ❌ |                         ⚠️ (can be scripted) | ✅ ($/request) ([Upstash: Serverless Data Platform][4]) |  ⚠️ (some caps/controls) ([Upstash: Serverless Data Platform][22]) | ⚠️ (Prod add-on) ([Upstash: Serverless Data Platform][12]) |
| Cloudflare KV          |                   ❌ |                                           ⚠️ |                                    ✅ ([Cloudflare][7]) |                                                                 ⚠️ |                                        ⚠️ (platform-level) |
| Turso                  |                   ❌ | ✅ (agent messaging + CLI) ([turso.tech][15]) |               ✅ (usage + active DB) ([turso.tech][16]) |                                                                 ⚠️ |                                        ⚠️ (plan-dependent) |
| Firestore              |                   ❌ |                                           ⚠️ |                                 ✅ ([Google Cloud][13]) |                                       ⚠️ (budgets via GCP tooling) |      ✅ (Google Cloud SLAs vary by product; not shown here) |
| DynamoDB direct        |                   ❌ |                                            ❌ |                    ✅ ([Amazon Web Services, Inc.][23]) |                                              ⚠️ (AWS Budgets etc.) |           ✅ 99.99/99.999 ([Amazon Web Services, Inc.][14]) |
| CockroachDB Serverless |                   ❌ |                                           ⚠️ |                                                      ✅ | ✅ (“designate a monthly resource limit”) ([cockroachlabs.com][17]) |                          ✅ 99.99 ([cockroachlabs.com][17]) |
| Supabase               |                   ❌ |                                           ⚠️ |                      ⚠️ (tier + usage) ([Supabase][5]) |                                                                 ⚠️ |                                                  ⚠️ (tier) |
| Neon                   |                   ❌ |                                           ⚠️ |                                          ✅ ([Neon][6]) |                ✅ (autoscaling limits as cost ceiling) ([Neon][24]) |                                                         ⚠️ |

**The whitespace is real:** basically nobody offers **(no-account + agent-native + budgets + standardized payment negotiation)** out of the box.

---

## Your differentiated value proposition: what you can say that others can’t

### 1) “No signup. No keys. No cloud account. Pay with a wallet.”

Most DB vendors have streamlined onboarding, but it’s still onboarding.

x402 is literally designed to let services charge without accounts/sessions, using HTTP 402 to negotiate payment. ([docs.cdp.coinbase.com][3])

**Positioning line:**

> “AgentDB turns databases into a pay-per-use web primitive. If you can make an HTTP request, you can have a database.”

### 2) “Pre-approval cost estimates + hard caps baked in”

Competitors *can* do budgets, but often via separate cloud billing consoles.

If you make **Quote → Approve → Provision** a first-class flow, you can win the agent use case.

Anchor it to what users already understand:

* CockroachDB emphasizes user-defined monthly limits to avoid surprise bills. ([cockroachlabs.com][17])
* Neon emphasizes autoscaling limits and scale-to-zero as cost controls. ([Neon][24])

### 3) “Back-to-back QoS guarantee”

You can credibly offer a strong SLA **if** your gateway is engineered to not be the weak link.

AWS DynamoDB’s SLA is explicit about 99.99% (regional) and 99.999% (global tables). ([Amazon Web Services, Inc.][14])
You can productize your tiers similarly, but the guarantee must be end-to-end.

### 4) “Agent-native receipts & logs”

Some vendors are moving here; e.g., Fauna highlighted observability including cost per query and performance metrics. ([SiliconANGLE][25])

Your opportunity is to make this *not optional* and *not enterprise-only*.

---

## Pricing & packaging: where to land relative to the market

Your pricing must reconcile two facts:

* underlying cloud DB cost is ongoing (storage/retention)
* per-request micropayments aren’t great UX for chatty workloads unless you use deposits/balances

**Market anchors (examples):**

* Upstash Redis: $0.20 per 100K requests; $0.25/GB storage; bandwidth after free quota. ([Upstash: Serverless Data Platform][4])
* Cloudflare KV: pricing is expressed per million reads/writes + storage, with included quotas on paid plan. ([Cloudflare][7])
* Turso: monetizes via “monthly active databases” and row reads/writes limits/overages. ([turso.tech][16])
* DynamoDB on-demand: billed per request and storage; pricing varies by region/table class. ([Amazon Web Services, Inc.][23])

**What I’d recommend for AgentDB (packaging, not implementation):**

### Ephemeral (Dev)

* Default TTL: 7 days
* Logs: 7 days
* Best-effort support
* Designed for “agent tasks”

### Project

* TTL: configurable
* Logs: 30 days
* Higher SLA target
* Export tools

### Production *(planned for v2)*

* Multi-region option
* Longer log retention
* Priority support + credits SLA

**Billing model:**

* require a **prepaid balance / deposit** at create time (via x402)
* meter against it; on low balance return 402 “top-up required”
* auto-suspend + delete after expiry/grace period

This is both a **risk control** (no abandoned resources) and a **UX benefit** (agent can keep working until balance is depleted).

---

## Go-to-market: how you actually get adoption

### 1) Lead with an MCP integration + local “Agent Broker”

x402 explicitly supports an MCP server pattern bridging Claude Desktop to paid x402 APIs. ([docs.x402.org][11])
Cloudflare’s announcement suggests x402 support in agent tooling will be a distribution channel. ([The Cloudflare Blog][10])

**GTM artifact:** “Install one MCP server and your agent can spin up a DB with pre-approved budgets.”

### 2) Sell “procurement automation,” not “a database”

Most teams don’t wake up wanting a new DB vendor; they wake up wanting:

* fewer credentials
* fewer accounts
* fewer billing surprises
* safer automation

That’s your wedge.

### 3) Land via agent ecosystems, expand into platform teams

* Start developer-first
* Use that to win mindshare
* Then sell to orgs that are building internal agents and need controlled sandboxes

---

## Risks, objections, and how competitors will respond

### Risk 1 — “x402 adoption is early”

Mitigation:

* keep x402 as the **primary** rail, but be prepared to add optional rails later (Stripe, invoice) for enterprises that can’t use stablecoins.
* Use the credibility signal: Coinbase describes x402 as a protocol it developed, and Cloudflare + Coinbase announced an x402 Foundation. ([docs.cdp.coinbase.com][3])

### Risk 2 — “Why not just Upstash/Turso?”

This is your hardest objection because they already feel “lightweight” and have clear pricing. ([Upstash: Serverless Data Platform][4])

Your rebuttal must be product-native:

* “Those are great when a human is signing up. We’re built for agents operating at runtime.”

### Risk 3 — “SLA is hard; your gateway is the bottleneck”

If you want a serious SLA, your infra must be multi-region and your API layer must be engineered like a real cloud product. DynamoDB’s SLA is strong, but it won’t cover your gateway failures. ([Amazon Web Services, Inc.][14])

Mitigation:

* separate Regional tier vs Multi-region tier
* publish status page + incident transparency
* design for composite SLA

### Risk 4 — Abuse / cost blowups

Your competitors rely on account-level controls; you’ll rely on:

* deposits
* caps
* rate limiting
* auto-expiration

This becomes part of the value proposition.

---

## Market sizing (directional, not gospel)

These numbers vary by methodology; treat them as *context for investor decks*, not precise truth.

* **NoSQL market** estimates: e.g., Mordor Intelligence forecasts growth from **~$15B (2025) to ~$69B (2031)**. ([Mordor Intelligence][2])
* **Serverless computing market** estimates: e.g., Grand View Research estimates **~$24.5B (2024) → ~$52B (2030)**. ([Grand View Research][1])
* “Cloud database / DBaaS” market is commonly sized in the tens of billions; one industry summary cites ~**$24B in 2025** with ~20% CAGR to 2030 (directional). ([RT Insights][26])

Your **SAM** is meaningfully smaller:

* developers building cloud apps + agent workflows
* who want a managed database
* and are willing to pay for “accountless + automated procurement”

The **SOM** early on is basically: “agent toolchain early adopters” + “internal platform sandboxes”.

---

## Practical positioning statement and “why now”

**Positioning (what I’d put on the homepage):**

> **AgentDB is the database your agent can buy.**
> Get a production-grade cloud table in seconds with an explicit cost cap, receipts, and logs—no AWS account, no billing setup, no keys copied from dashboards. Pay programmatically via x402 (HTTP 402).

**Why now:** x402 + MCP + agentic workflows create a credible distribution + adoption path that didn’t exist when “micropayments for APIs” was just theory. ([The Cloudflare Blog][10])

---

## Recommended next research / validation steps

If you want to pressure-test this quickly:

1. **Interview 15–20 teams** building internal agents (platform/infra)

   * validate “no cloud accounts for agents” pain is real and budget owners will accept stablecoin rails

2. **Prototype the “Quote → Approve → Provision” UX** in an MCP tool

   * measure conversion vs a control flow that uses Upstash/Turso with accounts

3. **Competitive teardown** on the “cost guardrails” experience

   * CockroachDB’s “never overspend” messaging is strong; Neon’s autoscaling limits are strong; Upstash shows real-time cost and caps. ([cockroachlabs.com][17])
   * your product should beat them on *agent-native* cost disclosure.

---

* [Investors](https://www.investors.com/news/technology/ibm-stock-anthropic-cobol/?utm_source=chatgpt.com)
* [Business Insider](https://www.businessinsider.com/anthropic-claude-code-founder-ai-impacts-software-engineer-role-2026-2?utm_source=chatgpt.com)
* [WIRED](https://www.wired.com/story/vibe-coding-startup-code-metal-raises-series-b-fundraising?utm_source=chatgpt.com)
* [Reuters](https://www.reuters.com/business/finance/klarna-launch-dollar-backed-stablecoin-race-digital-payments-heats-up-2025-11-25/?utm_source=chatgpt.com)
* [Financial Times](https://www.ft.com/content/1e22422f-5859-42e0-85ff-7d6fd7869d5c?utm_source=chatgpt.com)
* [Financial Times](https://www.ft.com/content/37c91e08-d13a-45a7-a3a7-acb43fa5522e?utm_source=chatgpt.com)

[1]: https://www.grandviewresearch.com/industry-analysis/serverless-computing-market-report?utm_source=chatgpt.com "Serverless Computing Market Size | Industry Report, 2030"
[2]: https://www.mordorintelligence.com/industry-reports/nosql-market?utm_source=chatgpt.com "NoSQL Market Size, Trends, Share & Industry Forecast 2026"
[3]: https://docs.cdp.coinbase.com/x402/welcome?utm_source=chatgpt.com "Welcome to x402 - Coinbase Developer Documentation"
[4]: https://upstash.com/docs/redis/overall/pricing?utm_source=chatgpt.com "Pricing & Limits - Upstash Documentation"
[5]: https://supabase.com/pricing?utm_source=chatgpt.com "Pricing & Fees"
[6]: https://neon.com/blog/new-usage-based-pricing?utm_source=chatgpt.com "Neon's New Pricing, Explained: Usage-Based With a $5 ..."
[7]: https://www.cloudflare.com/plans/developer-platform-pricing/?utm_source=chatgpt.com "Workers & Pages Pricing"
[8]: https://www.investors.com/news/technology/ibm-stock-anthropic-cobol/?utm_source=chatgpt.com "IBM Stock Stung By Anthropic Fears. Analyst Says AI 'Can't Replace' The Mainframe."
[9]: https://docs.x402.org/core-concepts/http-402?utm_source=chatgpt.com "HTTP 402"
[10]: https://blog.cloudflare.com/x402/?utm_source=chatgpt.com "Launching the x402 Foundation with Coinbase, and ..."
[11]: https://docs.x402.org/guides/mcp-server-with-x402?utm_source=chatgpt.com "MCP Server with x402"
[12]: https://upstash.com/blog/redis-new-pricing?utm_source=chatgpt.com "New Pricing and Increased Limits for Upstash Redis"
[13]: https://cloud.google.com/firestore/pricing?utm_source=chatgpt.com "Firestore pricing"
[14]: https://aws.amazon.com/dynamodb/sla/?utm_source=chatgpt.com "Amazon DynamoDB Service Level Agreement"
[15]: https://turso.tech/?utm_source=chatgpt.com "Turso - Databases Everywhere"
[16]: https://turso.tech/pricing?utm_source=chatgpt.com "Turso Database Pricing"
[17]: https://www.cockroachlabs.com/blog/serverless-free/?utm_source=chatgpt.com "CockroachDB Serverless: Free. Seriously."
[18]: https://xata.io/pricing?utm_source=chatgpt.com "Xata Pricing | Postgres at scale"
[19]: https://planetscale.com/pricing?utm_source=chatgpt.com "Pricing and plans"
[20]: https://vercel.com/docs/storage?utm_source=chatgpt.com "Vercel Storage"
[21]: https://vercel.com/docs/redis?utm_source=chatgpt.com "Redis on Vercel"
[22]: https://upstash.com/?utm_source=chatgpt.com "Upstash: Serverless Data Platform"
[23]: https://aws.amazon.com/dynamodb/pricing/?utm_source=chatgpt.com "Amazon DynamoDB Pricing | NoSQL Key-Value Database"
[24]: https://neon.com/pricing?utm_source=chatgpt.com "Neon pricing"
[25]: https://siliconangle.com/2023/02/15/fauna-adds-observability-features-serverless-cloud-database/?utm_source=chatgpt.com "Fauna adds observability features to its serverless cloud ..."
[26]: https://www.rtinsights.com/2025-cloud-database-market-the-year-in-review/?utm_source=chatgpt.com "2025 Cloud Database Market: The Year in Review"


Below is a **complete website blueprint** for an x402-powered “accountless cloud NoSQL” product (the product is **AgentDB** by **Run402**). It includes:

* **Human-facing** marketing + console (costs, budgets, logs, approvals)
* **Agent-facing** machine-discoverable endpoints + agent-readable docs + MCP surface
* **Clear separation** between what’s *standard x402* vs *helpful conventions*

I’m assuming:

* You **do not reveal** DynamoDB (or AWS) anywhere in the public UI.
* You sell **QoS-backed tiers**, with an SLA and transparent status.
* You enforce “pay over time” via **lease + top-ups** (and/or prepaid balance), using x402’s 402 flow. x402 v2 defines the standard payment headers (`PAYMENT-REQUIRED`, `PAYMENT-SIGNATURE`, `PAYMENT-RESPONSE`). ([docs.x402.org][1])

---

## 1) Domain layout and “surfaces”

Use separate surfaces so agents never have to crawl marketing pages.

### Recommended hostnames

* `run402.com` → marketing + docs (human-first)
* `app.run402.com` → wallet-based console (human ops)
* `app.run402.com` → paid API (agent + human SDKs)
* `status.run402.com` → status page (public)

If you want one domain only, keep the same paths, but the separation helps caching, security policy, and “agent readability.”

---

## 2) Global navigation

### Top nav (marketing/docs)

* Product
* Pricing
* Docs
* Security
* SLA
* Status
* Console (CTA)
* Install for Agents (CTA)

### Console nav

* Overview
* Tables
* Approvals
* Usage & Receipts
* Logs
* Budgets & Limits
* Settings

---

## 3) Sitemap

### Marketing (human-facing)

* `/` Home
* `/product`

  * `/product/agentdb`
  * `/product/agents`
  * `/product/billing`
  * `/product/observability`
  * `/product/qos`
* `/pricing`
* `/docs`

  * `/docs/quickstart/agents`
  * `/docs/quickstart/humans`
  * `/docs/api`
  * `/docs/mcp`
  * `/docs/x402`
  * `/docs/security`
  * `/docs/limits`
* `/security`
* `/sla`
* `/status` (links to status site)
* `/legal`

  * `/legal/terms`
  * `/legal/privacy`
  * `/legal/aup`
  * `/legal/dpa` (optional)
* `/support` (contact, community, etc.)

### Console (human-facing ops)

* `/` (connect wallet / resume session)
* `/overview`
* `/tables`
* `/tables/{table_id}`
* `/approvals` *(v1.1)*
* `/approvals/{approval_id}` *(v1.1)*
* `/usage`
* `/receipts`
* `/logs`
* `/budgets`
* `/settings`

### Public approval flow (human approval initiated by agent) *(v1.1)*

* `app.run402.com/approve/{approval_id}`

### Agent-facing (machine + protocol)

* `app.run402.com/.well-known/x402` (x402 discovery manifest — convention; aligns with emerging discovery patterns) ([datatracker.ietf.org][2])
* `app.run402.com/.well-known/mcp.json` (MCP “server card” pattern)
* `app.run402.com/x402/discovery` (tool + pricing catalog; convenience convention used in the ecosystem) ([agent402.dev][3])
* `app.run402.com/mcp` (MCP transport endpoint; optional) ([agent402.dev][3])
* `app.run402.com/openapi.json`
* `app.run402.com/llms.txt` (agent/doc indexing outline; highly recommended)
* `app.run402.com/meta.json` (machine-friendly endpoint map; convenience convention)

---

## 4) Home page design

### Page goal

In <20 seconds, a human should understand:

* “This is a cloud DB for agents”
* “No AWS accounts”
* “Costs are pre-approved and capped”
* “SLA + logs + receipts exist”

### Hero (above the fold)

**Headline:**
**A cloud database your agent can buy.**

**Subhead:**
Provision a production-grade table in seconds—no cloud accounts, no API keys, no billing setup.
Agents get quotes, humans approve a cap, and x402 handles payment over HTTP.

**Primary CTA:** `Install for Agents`
**Secondary CTA:** `Open Console`
**Tertiary CTA:** `Read Docs`

**Right-side hero element:** “Approval + provisioning” mini-flow animation:

1. Quote shown
2. Human approves budget
3. Table created
4. Receipts & logs visible

### Section: “How it works”

Four cards:

1. **Quote**: “Estimate cost and set a hard cap”
2. **Approve**: “One click approval, wallet payment”
3. **Use**: “Key-value + query API, agent-native”
4. **Expire**: “Auto-expire so you never pay forever”

### Section: “Built for agent workflows”

* “Works from coding agents (Claude Code, Cursor, CI bots)”
* “Machine-discoverable endpoints”
* “MCP integration available”

### Section: “Cost controls you can trust”

* Budgets & limits
* Receipts / line items
* Top-up rules
* Auto-suspend + auto-expire (prevents abandoned cost)

### Section: “QoS you can contract”

* Regional tier SLA
* Multi-region tier SLA
* Public status page
* Incident transparency

### Footer (trust anchors)

* Security summary: encryption at rest, TLS, data isolation model (without naming DynamoDB)
* Links to: Security, SLA, Status, Legal, Docs

---

## 5) Product pages

### `/product` (overview)

Split into five feature pillars, each linking deeper:

1. **Tables**

* “Create tables with a primary key (and optional sort key)”
* “TTL and retention”
* “Fast CRUD”

2. **Agents**

* “No accounts / no keys”
* “x402 payment negotiation via HTTP 402”
* “MCP-compatible tools”
* “Discovery endpoints”

3. **Billing**

* “Lease + prepaid balance”
* “Hard caps and top-ups”
* “Receipts with correlation IDs”
* “Exportable billing CSV”

4. **Observability**

* “Audit log”
* “Ops log (latency, units, errors)”
* “Request IDs”
* “User-accessible log retention tiers”

5. **QoS**

* “Tiered availability targets”
* “Backpressure and rate limiting”
* “Dedicated capacity options (later)”

---

## 6) Pricing page

### Page goal

Pricing must support *human approval* and *agent automation*.

#### Layout

1. **Simple plan cards** (what humans buy)
2. **Unit pricing** (what agents reason about)
3. **Calculator** (quote UX)
4. **Examples** (common workloads)

### Plan cards (example)

* **Dev / Ephemeral**

  * Default TTL: 7 days
  * Logs: 7 days
  * SLA: best-effort / basic
  * Designed for “agent tasks”

* **Project**

  * Longer TTL
  * Logs: 30 days
  * SLA: higher
  * Export tools

* **Production** *(planned for v2)*

  * Multi-region option
  * Higher SLA
  * Longer log retention
  * Priority support

### Unit pricing section

Present these as *AgentDB units*, not cloud-vendor units:

* Read Units
* Write Units
* Storage GB-day
* Log GB-ingested (optional)
* Export jobs

### Payment model section (critical)

Explain the **lease** model clearly:

* “Tables are leased resources. You pre-fund a balance. Usage and storage draw down that balance. When it’s low, the API returns HTTP 402 with a top-up requirement.”

Tie it to x402 mechanics:

* x402 uses HTTP 402 plus standardized payment headers to negotiate payment (`PAYMENT-REQUIRED`, `PAYMENT-SIGNATURE`, `PAYMENT-RESPONSE`). ([docs.x402.org][1])

### “Cost visibility” promises

* Real-time usage estimates
* Receipts ledger
* Alerts: low balance, approaching cap

---

## 7) Docs design

### Docs IA (left-nav)

* **Quickstarts**

  * Agents (MCP)
  * Agents (REST/OpenAPI)
  * Humans (Console approvals + monitoring)
* **Core concepts**

  * Tables, keys, TTL
  * Budgets, caps, leases
  * Logs, receipts, request IDs
  * QoS tiers and SLAs
* **x402**

  * Payment flow (402 → pay → retry)
  * Idempotency (payment-identifier)
  * SIWX sign-in (wallet-based session)
  * Discovery (Bazaar metadata)
* **API reference**

  * OpenAPI docs
  * Examples (curl / TS / Python)
* **Limits & anti-abuse**
* **Security**
* **FAQ**

### Quickstart: Agents (MCP)

Show the exact three-step canonical discovery order (agent-readable, concise), modeled on what’s working in the ecosystem: `/.well-known/mcp.json` → `/x402/discovery` → `/mcp`. ([agent402.dev][3])

### Quickstart: Agents (REST)

* Hit `POST /v1/tables:quote`
* Create table (pay 402)
* CRUD/query
* Handle 402 top-ups
* *(v1.1: approval request + poll)*

### Quickstart: Humans

* Review quote + approve spend (via console or approval link *(v1.1)*)
* Review quote & cap
* Pay deposit/top-up
* View table in console
* Watch logs and receipts
* Delete/expire

---

## 8) Console design (human-facing ops without “accounts”)

### Authentication (no accounts)

Two modes:

1. **Wallet sign-in (recommended)**
   Use x402 SIWX to prove wallet ownership and issue a session token for the console. SIWX is explicitly designed for repeat access without repaying, by proving wallet control via a signed message. ([docs.x402.org][4])

2. **Capability link (fallback)**
   If a user doesn’t want wallet sign-in, allow “paste a Workspace Key” (capability token).
   (This is UX-friendly for devs; you can discourage it for production.)

### Console: Overview screen

Top KPIs:

* Current balance
* Spend today / week
* Tables count
* Active approvals
* Recent errors (last 24h)

Widgets:

* Usage chart (by day)
* “Top tables by cost”
* “Low balance warnings”
* “Recently created tables (auto-expiring)”

### Console: Tables list

Table-like list with:

* Table name
* TTL/expiry date
* Budget cap
* Current balance allocated
* Last activity
* Health indicator

Bulk actions:

* Extend TTL (requires top-up)
* Delete
* Export receipts

### Console: Table detail

Tabs:

**A) Overview**

* endpoints
* region/tier (but described as “Regional / Multi-region”, not vendor region names)
* TTL and expiry
* current budget settings
* last 1h/24h ops + errors

**B) Access**

* table secret / capability token management (rotate)
* optional IP allowlist (if you add)
* “Generate agent snippet” (copy/paste)

**C) Usage**

* usage buckets
* cost estimate by unit type
* “what changed” highlights (“writes spiked at 14:32”)

**D) Receipts**

* append-only ledger
* downloadable CSV/JSON
* correlation IDs

**E) Logs**

* Audit
* Ops
* Errors
  Filters: time range, request id, operation type, status

**F) Settings**

* budgets & caps
* rate limits
* retention
* delete table

### Console: Approvals *(v1.1)*

Two subviews:

1. **Incoming approvals**

* created by an agent (local broker)
* show: requested TTL, expected ops, max spend, duration, policy reasons

2. **Approval history**

* approved/denied
* receipts attached

---

## 9) The “agent asks, human approves” UX *(v1.1 — designed, deferred from MVP)*

> **Note:** The approval flow below is designed and specified but deferred to v1.1. The MVP ships with direct x402 pay-and-go: the agent calls `POST /v1/tables:quote` (free), then `POST /v1/tables` which returns 402, the agent pays and retries, and the table is created. See D12 in the Decisions Log.

This is the UX that makes your product feel inevitable.

### Step-by-step

1. Agent creates approval request:

* `POST /v1/approvals` with quote + proposed cap + TTL + justification string
* Server returns:

  * `approval_id`
  * `approval_url` (human)
  * `agent_poll_url`

2. Human opens approval URL:

* sees quote breakdown
* sees “max spend” prominently
* sees TTL/auto-expire
* clicks **Approve & Fund**

3. Payment happens via x402:

* if funding required, server returns `402 Payment Required` with `PAYMENT-REQUIRED` header, per x402 v2. ([docs.x402.org][1])
* browser wallet (or broker) signs payment and retries with `PAYMENT-SIGNATURE`
* server responds success with `PAYMENT-RESPONSE` ([docs.x402.org][1])

4. Agent polls until approval is `APPROVED`, then provisions table automatically.

### Approval page UI (what to show)

* **Summary**

  * Purpose: “Requested by local coding agent”
  * Requested cap: **$X maximum**
  * Expected range: $a–$b
  * Auto-expire: date/time
* **Breakdown**

  * Read/Write units estimate
  * Storage estimate
  * Log retention (if enabled)
* **Controls**

  * Approve
  * Deny
  * Edit cap (increase/decrease)
  * Shorten TTL (recommended safe default)
* **Safety text**

  * “If usage hits the cap, requests will pause until you top up.”

---

## 10) Agent-facing “website”: stable machine endpoints

This is the part most teams miss. Make it boring, stable, cacheable.

### A) `/.well-known/x402` (x402 discovery manifest)

There’s an emerging discovery pattern using a manifest at `/.well-known/x402` and even DNS TXT discovery records pointing to it. ([datatracker.ietf.org][2])
You don’t need the DNS record day 1, but you should structure the manifest so crawlers and agents can find payable resources.

**Recommended contents** (practical superset):

* api base url
* OpenAPI url
* MCP endpoints (if present)
* supported x402 schemes/networks
* list of “resources” with price models and schemas

### B) Bazaar metadata (x402-native discovery)

x402 v2 codifies “Bazaar” as an extension where you declare discoverability metadata (schemas/tags/category) in route config so facilitators can index your endpoints and clients can query `/discovery/resources`. ([docs.cdp.coinbase.com][5])

Action for your site/docs:

* Add a docs page: “Discover AgentDB via Bazaar”
* Make sure your routes include `extensions.bazaar.discoverable: true`

### C) `/.well-known/mcp.json` + `/mcp` (agent tool surface)

In the agent ecosystem, a stable MCP card at `/.well-known/mcp.json` plus a discovery endpoint is proving useful and agent-friendly. ([agent402.dev][3])

If you ship an MCP server:

* `GET /.well-known/mcp.json` → machine metadata
* `GET /x402/discovery` → tools + schema + prices
* `POST /mcp` → MCP transport

### D) `llms.txt`

Publish a concise, structured outline of your docs at `/llms.txt` so agents can ingest without crawling everything.

---

## 11) Agent-facing content pages (human-readable, agent-readable)

### `/agents` page (write it like a protocol doc, not marketing)

Structure:

* “Core endpoints” (3–5)
* “Discovery order”
* “402 retry rule”
* “Idempotency rule”
* “Cost safety rule”
* “Examples”

Example content (what the page should say, roughly):

* **Discovery order:** `/.well-known/mcp.json` → `/x402/discovery` → `/mcp`
* **If HTTP 402 returned:** read `PAYMENT-REQUIRED`, pay, retry same call with `PAYMENT-SIGNATURE` (do not mutate args)
* **Idempotency:** include payment-identifier for write-like operations
* **Budget safety:** set `max_spend_usd` on approval / table creation

(That aligns with x402’s standard header flow. ([docs.x402.org][1]))

---

## 12) Security, SLA, and Status pages

### `/security`

Content blocks:

* encryption at rest + in transit
* key management posture (don’t mention AWS)
* isolation model: “table-level isolation”
* data retention & deletion guarantees
* incident response: “how we handle”
* vulnerability disclosure email

### `/sla`

Define tiers:

* Regional
* Multi-region

Explain:

* what counts as downtime
* how credits work (your policy)
* support response time by tier

### Status site

* current status banner
* incident history
* uptime chart
* API latency chart (p50/p95)
* subscribe to updates (RSS/email/webhook)

---

## 13) Legal pages

Minimal set:

* Terms
* Privacy
* Acceptable Use Policy (AUP)

Optional (if you sell to companies):

* Data Processing Addendum (DPA)

Add an explicit clause about:

* payment finality (stablecoin settlement)
* dispute resolution for service credits

---

## 14) Concrete “agent-facing endpoints” spec you can hand to engineers

Here’s a minimal set you can implement that makes agents happy immediately (paths only; domains are placeholders):

```txt
# Agent discovery
GET  https://app.run402.com/.well-known/x402
GET  https://app.run402.com/openapi.json
GET  https://app.run402.com/llms.txt
GET  https://app.run402.com/meta.json

# Optional MCP surface
GET  https://app.run402.com/.well-known/mcp.json
GET  https://app.run402.com/x402/discovery
POST https://app.run402.com/mcp

# Core API (REST)
POST /v1/tables:quote
POST /v1/approvals                        # v1.1
GET  /v1/approvals/{approval_id}           # v1.1
POST /v1/tables
GET  /v1/tables
GET  /v1/tables/{table_id}
PUT   /v1/tables/{table_id}/items/{pk}
PATCH /v1/tables/{table_id}/items/{pk}
GET   /v1/tables/{table_id}/items/{pk}
DELETE /v1/tables/{table_id}/items/{pk}
POST  /v1/tables/{table_id}:query
POST  /v1/tables/{table_id}:scan
POST  /v1/tables/{table_id}:batch-get
POST  /v1/tables/{table_id}:batch-write
GET   /v1/usage
GET   /v1/receipts
GET   /v1/tables/{table_id}/logs
DELETE /v1/tables/{table_id}
```

And **payment behavior** for any route that can require funding:

* return `402` with `PAYMENT-REQUIRED`
* accept retry with `PAYMENT-SIGNATURE`
* return `PAYMENT-RESPONSE` on success ([docs.x402.org][1])

---

## 15) Copy you can reuse verbatim

### Header CTA

**Install for Agents**
**Open Console**

### Home hero

**A cloud database your agent can buy.**
No cloud accounts. No API keys. Hard cost caps, receipts, and logs built in.

### Pricing model explainer

**Lease-based billing:** Tables are pre-funded resources. Usage and storage draw down your balance. When balance is low, requests pause with a standardized HTTP 402 paywall until you top up.

### Trust line

**Transparent costs, predictable behavior:** Every request carries a request ID, metering headers, and is reflected in an exportable receipts ledger.

---

## 16) Implementation notes (what to build first)

If you want the website to be “complete” *and* shippable fast, prioritize:

1. Marketing home + pricing + docs skeleton
2. Agent quickstart page (`/agents`)
3. `api` discovery endpoints: `/.well-known/x402`, `openapi.json`, `llms.txt`
4. Console MVP: Overview, Tables, Receipts, Logs
5. Status page

*Post-MVP (v1.1):* Console Approvals page, public approval link flow.

Everything else (SEO polish, case studies, enterprise pages) can come later without breaking the core.

---

If you want, I can produce the **actual first-pass content** for every page (final copy + headings + example screenshots/wireframes in text), and the **exact JSON schemas** for:

* `/.well-known/x402`
* `/.well-known/mcp.json`
* `/x402/discovery`
* `/meta.json`
* `/llms.txt`

…so your engineers can implement it directly.

[1]: https://docs.x402.org/core-concepts/http-402 "HTTP 402 - x402"
[2]: https://datatracker.ietf.org/doc/draft-jeftovic-x402-dns-discovery/ "
            
    
        draft-jeftovic-x402-dns-discovery-00 - Discovering x402 Resources via DNS TXT Records
    

        "
[3]: https://agent402.dev/ "agent402.dev | MCP Gateway Documentation"
[4]: https://docs.x402.org/extensions/sign-in-with-x?utm_source=chatgpt.com "Sign-In-With-X (SIWX)"
[5]: https://docs.cdp.coinbase.com/x402/bazaar "x402 Bazaar (Discovery Layer) - Coinbase Developer Documentation"



Below is a **copy‑pasteable “website content pack”** for AgentDB (Run402's initial product) with:

* Human-facing marketing + console UX copy (wallet sign-in, approvals, budgets, receipts, logs)
* Agent-facing docs (MCP + REST) written in “agent‑readable” style
* A **Learning** section explaining **x402** (what it is, how it works, why it matters, vision)
* A **Comparison** page vs common alternatives
* **Exact JSON Schemas + example instances** for:

  * `/.well-known/mcp.json`
  * `/x402/discovery`
  * `/meta.json`
  * `/llms.txt` (template)
  * `/.well-known/x402` (manifest used for discovery; aligns with the DNS discovery draft’s well-known path convention) ([IETF Datatracker][1])

Factual grounding for x402 details:

* x402 uses **HTTP 402 Payment Required** and includes payment requirements in a `PAYMENT-REQUIRED` header; clients retry with `PAYMENT-SIGNATURE`. ([Coinbase Developer Docs][2])
* x402 supports using a **facilitator** to verify/settle payments via `/verify` and `/settle`. ([x402][3])
* x402 V2 adds wallet-based identity and discovery improvements. ([x402][4])
* SIWX is CAIP-122 wallet auth to access previously purchased resources without repaying. ([x402][5])
* Payment-Identifier provides idempotency for safe retries. ([x402][6])
* Bazaar is a machine-readable discovery layer for payable APIs. ([Coinbase Developer Docs][7])

Competitive comparisons grounded by vendor docs:

* Upstash pricing examples ($0.20 / 100K commands; storage/bandwidth). ([Upstash: Serverless Data Platform][8])
* Upstash uses endpoint + token for REST and API keys for their developer API. ([Upstash: Serverless Data Platform][9])
* Turso pricing uses “monthly active databases”, storage/rows read/written line items. ([turso.tech][10])
* Turso authenticates via API tokens (CLI/API). ([docs.turso.tech][11])
* Cloudflare KV pricing appears in platform pricing; KV billing is op-based and typically managed via Cloudflare tokens. ([cloudflare.com][12])
* Firestore has free quota but requires enabling billing to exceed it. ([Google Cloud][13])

---

# 0) Brand + site-wide UX rules

## Brand

* Company: **Run402**
* Product: **AgentDB** (Run402's initial product — the DynamoDB equivalent)
* Tagline: **“A cloud database your agent can buy.”**
* Primary CTA: **Install for Agents**
* Secondary CTA: **Open Console**
* Tone: technical, compact, no fluff; default to concrete behaviors (caps, TTLs, receipts).

## Site-wide UX rules

* Always show a **Max Spend** number wherever money appears.
* Always show **Expiry / TTL** wherever a table is shown.
* Every cost number has a companion link: “How this is calculated”.
* Every operational surface shows:

  * `Request ID`
  * `Table ID`
  * `Metered Units`
  * `Estimated Cost`
* Every destructive action has a “Type the table name to confirm” pattern.

---

# 1) File tree / route map

Use this as a Next.js / Remix / SSG content layout.

```
/marketing
  /index
  /product
  /product/agentdb
  /product/agents
  /product/billing
  /product/observability
  /product/qos
  /pricing
  /docs
  /security
  /sla
  /status (redirect)
  /compare
  /support
  /legal/terms
  /legal/privacy
  /legal/aup

/learn
  /index
  /what-is-x402
  /how-x402-works
  /x402-for-agents
  /vision
  /safety-and-trust
  /glossary
  /faq

/console
  /index (connect wallet / resume)
  /overview
  /tables
  /tables/[table_id]
  /approvals
  /usage
  /receipts
  /logs
  /budgets
  /settings

/api (machine-facing)
  /.well-known/mcp.json
  /.well-known/x402
  /x402/discovery
  /meta.json
  /llms.txt
  /openapi.json
```

---

# 2) Marketing pages (final first-pass copy + wireframes)

## 2.1 `/` Home

**Meta title:** AgentDB — A cloud database your agent can buy
**Meta description:** Provision a production-grade table in seconds with explicit cost caps, receipts, and logs. No cloud accounts. x402 payments over HTTP.

### Above the fold (Hero)

**H1:** A cloud database your agent can buy.
**Subhead:** Spin up durable cloud state in seconds—without creating a cloud account, copying API keys, or setting up billing. Agents request a quote. Humans approve a cap. AgentDB provisions automatically.

**Primary CTA button:** Install for Agents
**Secondary CTA button:** Open Console
**Tertiary link:** Read the Agent Quickstart

**Hero callouts (3 bullets):**

* **Hard caps**: “Never spend more than $X unless you approve it.”
* **Receipts + logs**: “Every operation has a request ID and a line item.”
* **Auto-expire**: “No abandoned resources billing you forever.”

### Section: How it works (4-step)

**Title:** Built for “agent asks → human approves → done”
**Cards:**

1. **Quote**
   “AgentDB returns an estimate range + a maximum spend cap proposal.”
2. **Approve**
   “One click approval. Optional wallet sign-in. Fund a lease.”
3. **Provision**
   “Table is created and ready. No vendor console needed.”
4. **Use + Monitor**
   “CRUD + query, with receipts and logs you can export.”

### Section: What you get

**Title:** Production behaviors, agent-native interface
**Grid (6 items):**

* Tables with keys + TTL
* Query by key/range
* Budget caps + rate limits
* Usage dashboard + receipts
* Audit + ops logs
* SLA tiers + status page

### Section: “Works where your agents run”

**Title:** Use from local coding agents, CI bots, or agent runtimes
**Copy:** Use AgentDB via REST, OpenAPI, or MCP. For local agents, install the AgentDB Broker so the agent can request approval and proceed safely.

### Section: Trust

**Title:** Safe by default
**Bullets:**

* Default TTL on every table
* Default max spend cap
* Read-only suspension on low balance (configurable)
* Explicit top-ups, never silent overages

### Footer

Links: Product, Pricing, Docs, Learn x402, Compare, Security, SLA, Status, Legal.

#### Wireframe (ASCII)

```
┌────────────────────────────────────────────────────────────┐
│ AgentDB  Product  Pricing  Docs  Learn  Compare  Console    │
├────────────────────────────────────────────────────────────┤
│ H1: A cloud database your agent can buy.                    │
│ Subhead: ...                                                │
│ [Install for Agents] [Open Console] [Agent Quickstart]      │
│  • Hard caps  • Receipts+logs  • Auto-expire                │
├────────────────────────────────────────────────────────────┤
│  Quote → Approve → Provision → Use + Monitor                │
├────────────────────────────────────────────────────────────┤
│ Feature grid (Tables, TTL, Budgets, Receipts, Logs, SLA...) │
├────────────────────────────────────────────────────────────┤
│ Trust + Footer links                                        │
└────────────────────────────────────────────────────────────┘
```

---

## 2.2 `/product` Product overview

**H1:** AgentDB is cloud state you can procure at runtime.
**Intro:** Most managed databases assume a human will sign up, create projects, and manage credentials. AgentDB assumes an agent needs a database *now*—and a human wants explicit cost control.

### Sections

1. **Tables**
   “Create tables with a primary key (optional sort key), TTL, and predictable query patterns.”
   CTA: Explore Tables

2. **Agents**
   “MCP + REST. Discovery endpoints. Standardized payment negotiation via x402.”
   CTA: Explore Agents

3. **Billing**
   “Lease-based resources with top-ups and hard caps.”
   CTA: Explore Billing

4. **Observability**
   “Receipts ledger, audit log, ops logs, export.”
   CTA: Explore Observability

5. **Quality of Service**
   “Tiered SLA, status transparency, predictable throttling behavior.”
   CTA: Explore QoS

---

## 2.3 `/product/agentdb`

**H1:** Tables: simple, durable, key-based state
**Subhead:** Enough database to build real software. Small enough for agents to use correctly.

### What tables support (v1)

* Create/delete tables
* Primary key (string), optional sort key (string)
* Put/get/update/delete items
* Query by partition key; optional sort key range/prefix
* Scan (guarded, with explicit opt-in + hard limits)
* Batch get/write operations
* TTL at table level
* Pagination

### What tables don’t support (v1)

* Multi-item transactions
* Secondary indexes (GSI/LSI)
* Change streams / triggers

### “Design for agent predictability”

**Copy:** Every request returns:

* Request ID
* Metered units
* Estimated cost
* Remaining balance (if applicable)

CTA: “See API reference”

---

## 2.4 `/product/agents`

**H1:** Designed for coding agents and tool brokers
**Subhead:** Agents discover capabilities and prices, request approval, and proceed without manual setup.

### Integration options

1. **MCP (recommended for agent tooling)**

* Stable discovery endpoints
* `tools/list` + `tools/call`
* 402-aware retries

2. **REST / OpenAPI**

* `POST /tables:quote`
* `POST /approvals` *(v1.1)*
* `POST /tables`
* data-plane CRUD/query

### The approval primitive *(v1.1)*

**Copy:** Agents should never spend money without an explicit policy. AgentDB supports an “approval request” object so your local broker can ask the human once, then execute safely.

CTA: “Agent Quickstart (MCP)” and “Agent Quickstart (REST)”

---

## 2.5 `/product/billing`

**H1:** Pay over time without subscriptions or accounts
**Subhead:** Tables are leased resources. You pre-fund, spend down, and renew when needed.

### Billing behaviors

* **Deposit / top-up**: Fund a table or workspace balance.
* **Spend caps**: Hard daily and lifetime caps (configurable).
* **Low-balance handling**: Return 402 for top-up; optionally suspend writes first.
* **Expiry**: Default TTL; explicit extension requires approval.

### Why leases

**Copy:** Storage costs exist even when you aren’t sending requests. The lease model ensures you never keep paying for resources you forgot.

CTA: “See receipts & usage demo”

---

## 2.6 `/product/observability`

**H1:** Cost visibility and logs are first-class
**Subhead:** If an agent can create infrastructure, you need receipts and logs you can trust.

### Observability surfaces

* **Usage**: time-bucketed units + estimated cost
* **Receipts**: append-only ledger entries, exportable
* **Audit log**: creation, deletion, approvals, budget changes
* **Ops log**: request IDs, latency, errors, units

### Export options

* CSV export for receipts
* JSONL export for logs
* Webhook (optional / roadmap)

CTA: “Open Console → Logs”

---

## 2.7 `/product/qos`

**H1:** Quality of service you can contract
**Subhead:** Tiered availability targets, predictable behavior under load, and transparent status.

### QoS guarantees (what you can safely claim in copy)

* Availability targets by tier (Regional / Multi-region)
* Rate limiting behavior documented
* Error taxonomy documented
* Incident transparency + postmortems

CTA: “Read SLA”

---

## 2.8 `/pricing`

**Meta title:** Pricing — AgentDB
**H1:** Usage-based pricing with hard caps

### Pricing philosophy

**Copy:** Pricing must be machine-readable and human-approvable. Agents get quotes. Humans approve max spend. Usage draws down funded balance.

### Plan cards (example)

**Ephemeral (Dev)**

* Default TTL: 7 days
* Logs: 7 days
* Best-effort support

**Project**

* TTL: configurable
* Logs: 30 days
* Higher SLA target

**Production** *(planned for v2)*

* Multi-region option
* Longer log retention
* Priority support + credits SLA

### Unit pricing table (template)

* Read Units: $X / million
* Write Units: $Y / million
* Storage: $Z / GB-day
* Logs ingest: $A / GB
* Export jobs: $B / job

> You can swap these numbers to match your margin and upstream costs.

### Calculator (UI spec)

Inputs:

* items avg size (KB)
* writes/day
* reads/day
* retention days
* max spend cap

Outputs:

* estimated daily / monthly
* recommended deposit for N days
* “worst-case” bound = cap

CTA: “Try Quote API”

---

## 2.9 `/docs` (Docs landing)

**H1:** Documentation
**Tiles:**

* Agent Quickstart (MCP)
* Agent Quickstart (REST)
* Human Quickstart (Approvals + Console)
* Core Concepts (Tables, Budgets, Leases, Logs)
* API Reference (OpenAPI)
* Security + Limits

---

## 2.10 `/security`

**H1:** Security
**Sections (copy placeholders—do not claim certifications you don’t have):**

* Data encryption (in transit / at rest)
* Table isolation model
* Access model (capability tokens + wallet sign-in)
* Logging and audit
* Responsible disclosure (security@…)
* Data deletion and retention

---

## 2.11 `/sla`

**H1:** Service Level Agreement (SLA)
**Sections:**

* Definitions (availability, downtime)
* Measurement window
* Tier targets
* Credits schedule
* Exclusions
* How to claim credits
* Status page as the source of truth

---

## 2.12 `/status`

Redirect to `status.run402.com`

**Copy:** “Live status and incident history.”

---

## 2.13 `/support`

**H1:** Support

* Email support
* Community link (Discord/Slack)
* “Report an incident”
* “Request quota increase”
* “Enterprise contact”

---

## 2.14 Legal stubs

* `/legal/terms` (Terms of service)
* `/legal/privacy`
* `/legal/aup` (Acceptable use)

---

# 3) Learning section (humans): x402, what it enables, vision

This Learning section is grounded in x402’s public docs and ecosystem material, including: “x402 is an open payment standard built around HTTP 402,” the 402/headers handshake, facilitator verify/settle, SIWX, and discovery/Bazaar. ([x402][3])

## 3.1 `/learn` (landing)

**H1:** Learn: x402 and agent-native procurement
**Subhead:** A practical guide for humans: what x402 is, how it works, and what it unlocks.

**Cards:**

* What is x402?
* How x402 works (402 → pay → retry)
* x402 for agents
* Vision: payments as a native web primitive
* Safety & trust (caps, receipts, fraud)
* Glossary + FAQ

---

## 3.2 `/learn/what-is-x402`

**H1:** What is x402?
**Lead:** x402 is a payment standard that revives HTTP 402 (“Payment Required”) so services can charge for resources over plain HTTP.

### The core idea

* Client requests a resource
* Server replies “Payment Required” with machine-readable payment instructions
* Client pays programmatically and retries with proof

### What this replaces

* API key onboarding
* account creation
* credit card forms
* monthly subscriptions for small, metered usage

### Why stablecoins / fast settlement matters (human-friendly)

* Small payments without card fees
* Programmatic spend by software
* Global compatibility (wallet-based)

> In AgentDB, x402 is the “checkout” step that an agent can complete safely after you approve a cap.

---

## 3.3 `/learn/how-x402-works`

**H1:** How x402 works (the handshake)
**Subhead:** If you understand HTTP, you understand x402.

### Step-by-step

1. **Attempt**
   Client sends a normal HTTP request.

2. **402 Challenge**
   Server responds with `402 Payment Required` and includes payment requirements in a `PAYMENT-REQUIRED` header.

3. **Payment payload**
   Client chooses a supported scheme/network and creates a payment payload.

4. **Retry with proof**
   Client retries the *same request* with `PAYMENT-SIGNATURE`.

5. **Verification/settlement**
   Server verifies and settles directly or via a facilitator (`/verify` and `/settle`).

6. **Response**
   Server returns the requested resource, often with a payment receipt header.

### Reliability primitives for real systems

* **Idempotency**: use Payment-Identifier so retries don’t double charge.
* **Wallet identity**: SIWX allows repeat access without repaying for the same entitlement.

---

## 3.4 `/learn/x402-for-agents`

**H1:** x402 for agents: why this is different from “normal billing”
**Subhead:** x402 separates payment from identity.

### The agent problem

Agents are great at calling APIs, but terrible at:

* Creating accounts
* Managing credentials securely
* Navigating billing portals
* Predicting and controlling spend

### What x402 enables

* Agents can **discover payable services**
* Agents can **present explicit prices**
* Humans can **approve caps**
* Agents can **pay and proceed** without additional onboarding steps

### Discovery: Bazaar + manifests

* Bazaar is a discovery layer for payable services.
* Well-known endpoints and metadata make services machine-discoverable.

---

## 3.5 `/learn/vision`

**H1:** Vision: “Payment Required” as a first-class web primitive
**Subhead:** The web made information frictionless; payments remained a bolt-on. x402 aims to make payments as native as HTTP.

### What changes if this works

* Any service can be “paywallable” at the protocol layer
* Agents can autonomously buy compute/data/tools under policy
* “Procurement” becomes an API call, not a contract negotiation

### What AgentDB adds on top

x402 is the payment primitive. AgentDB adds:

* budgets/caps
* receipts
* logs
* leases for time-based costs
* SLAs for QoS

---

## 3.6 `/learn/safety-and-trust`

**H1:** Safety & trust: how to avoid “agents spending money” problems
**Sections:**

* Default caps + TTL everywhere
* Pre-approval flow (human in the loop)
* Receipts ledger and export
* Rate limits and anomaly detection
* Recovery playbooks (suspend, freeze, export, delete)

---

## 3.7 `/learn/glossary`

Terms:

* Table
* Lease
* Cap / Budget
* Receipt
* Audit log
* Ops log
* x402
* Facilitator
* SIWX
* Payment-Identifier
* Discovery / manifest

---

## 3.8 `/learn/faq`

Examples:

* “Do I need an account?” (No; wallet/capabilities)
* “Can I cap spend?” (Yes; hard caps)
* “What happens if I stop paying?” (Suspend → expire → delete)
* “Can agents create infinite tables?” (No; policy + caps + TTL)

---

# 4) Comparison page vs competition

This page is grounded in vendor pricing/auth docs to keep it factual, not vibes. ([Upstash: Serverless Data Platform][8])

## 4.1 `/compare` (single-page comparison)

**H1:** AgentDB vs common alternatives
**Lead:** Many products are excellent databases. This comparison focuses on one specific workflow: **an agent provisioning state safely without a human creating vendor accounts**.

### Quick matrix (copy)

| Capability                               | AgentDB | Upstash                                | Turso | Cloudflare KV | Firestore |
| ---------------------------------------- | ------- | -------------------------------------- | ----- | ------------- | --------- |
| No signup / no vendor billing setup      | ✅       | ❌                                      | ❌     | ❌             | ❌         |
| Standardized paywall protocol (HTTP 402) | ✅       | ❌                                      | ❌     | ❌             | ❌         |
| Human approval + hard spend cap          | ✅       | ⚠️ (budgeting exists, not agent-first) | ⚠️    | ⚠️            | ⚠️        |
| Receipts ledger (per-request line items) | ✅       | ⚠️                                     | ⚠️    | ⚠️            | ⚠️        |
| Agent-discoverable pricing endpoint      | ✅       | ❌                                      | ❌     | ❌             | ❌         |
| Default TTL / auto-expire for safety     | ✅       | ⚠️                                     | ⚠️    | ⚠️            | ⚠️        |

### “What others do well”

**Upstash**

* Very clear pay‑as‑you‑go model (e.g., $0.20 / 100K commands; bandwidth/storage line items). ([Upstash: Serverless Data Platform][8])
* Access patterns commonly use tokens/endpoints. ([Upstash: Serverless Data Platform][9])

**Turso**

* Pricing aligned to “monthly active databases” and read/write/storage line items. ([turso.tech][10])
* Platform API and auth tokens for programmatic management. ([docs.turso.tech][11])

**Cloudflare KV**

* Strong edge ecosystem; usage-based KV pricing and platform integration. ([cloudflare.com][12])
* Token-managed operational model. ([Cloudflare Docs][14])

**Firestore**

* Large ecosystem; free tier quotas, but billing must be enabled for more. ([Google Cloud][13])

### “What AgentDB is optimized for”

* **Agent procurement** as a primitive: Quote → Approve → Provision
* **Caps + TTL by default**
* **Protocol-level payment negotiation** (x402 / HTTP 402)
* **No keys copied from dashboards**
* **Receipts and logs first-class**

### CTA section

* “Install for Agents”
* “Read the approval flow”
* “Try quote API”

---

# 5) Console (human-facing) page copy + wireframes

## 5.1 `/console` Connect / Resume

**H1:** Open Console
**Subhead:** View tables, approvals, spend caps, receipts, and logs.

Buttons:

* **Connect Wallet**
* **Paste Workspace Key** (advanced)
* “What is x402?” link → `/learn/what-is-x402`

**Callout:** “Console access does not grant agents spending authority. Spending requires explicit approval caps.”

Wireframe:

```
┌─────────────── Run402 Console ────────────────┐
│ [Connect Wallet]                               │
│ [Paste Workspace Key]                          │
│                                                │
│ Learn: What is x402?  How approvals work       │
└────────────────────────────────────────────────┘
```

---

## 5.2 `/console/overview`

Widgets:

* Balance (workspace)
* Spend today / last 7 days
* Active tables count
* Approvals pending
* Errors last 24h

Lists:

* “Top tables by cost (7d)”
* “Recently created tables”
* “Low balance warnings”

---

## 5.3 `/console/tables` Tables list

Table columns:

* Table Name
* Table ID
* Tier (Regional / Multi-region)
* Expiry
* Cap (daily / lifetime)
* Last activity
* Health

Actions:

* Extend TTL (requires approval/top-up)
* Delete
* Export receipts (CSV)

---

## 5.4 `/console/tables/{table_id}` Table details (tabs)

**Tab: Overview**

* Table endpoint
* Current balance allocated
* TTL and expiry
* Caps and limits
* p50/p95 latency (last 1h)
* Errors (last 1h/24h)

**Tab: Usage**

* Chart: units over time
* “Cost drivers” breakdown
* “Set alert thresholds”

**Tab: Receipts**

* Ledger list:

  * timestamp
  * op type
  * metered units
  * estimated cost
  * request ID

**Tab: Logs**

* Audit / Ops / Errors
* Filter by request ID

**Tab: Access**

* Rotate table secret (capability token)
* Allowed origins / IP allowlist (optional)

**Tab: Settings**

* Update TTL
* Update caps
* Delete table

---

## 5.5 `/console/approvals` *(v1.1)*

Two panes:

* Pending approvals (needs action)
* History

Approval card contents:

* Requested by: “Local Agent Broker”
* Purpose string
* Proposed cap + TTL
* Estimated range
* Buttons: Approve & Fund / Deny / Edit cap / Shorten TTL

---

## 5.6 `/console/receipts`

Global receipts ledger:

* filters: table, date range, op type
* export CSV/JSON

---

## 5.7 `/console/logs`

Global logs explorer:

* filters: table, time range, severity, request ID

---

## 5.8 `/console/budgets`

Workspace-level policies:

* Default TTL for new tables
* Default max spend
* Auto-approve thresholds (for the broker)
* Rate limit defaults

---

# 6) Agent-facing docs (human-readable, agent-readable)

## 6.1 `/docs/quickstart/agents` (landing)

**H1:** Agent Quickstart
Choose:

* MCP (recommended)
* REST/OpenAPI

---

## 6.2 `/docs/quickstart/agents-mcp`

**Title:** Agent Quickstart (MCP)
**This page is intentionally agent-readable.**

### Canonical discovery order

1. `GET https://app.run402.com/.well-known/mcp.json`
2. `GET https://app.run402.com/x402/discovery`
3. Connect MCP transport at `https://app.run402.com/mcp`

### 402 retry rule

* If a call returns `402 Payment Required`, complete payment and retry **without changing arguments**.

### Tools you’ll use (example)

* `agentdb.quote_table`
* `agentdb.request_approval` *(v1.1)*
* `agentdb.create_table`
* `agentdb.put`
* `agentdb.get`
* `agentdb.query`
* `agentdb.logs`
* `agentdb.receipts`

---

## 6.3 `/docs/quickstart/agents-rest`

**Title:** Agent Quickstart (REST)

### Flow

1. Quote:

```bash
curl -sS https://app.run402.com/v1/tables:quote \
  -H 'content-type: application/json' \
  -d '{"ttl_days":7,"expected_ops_per_day":{"read":2000,"write":200},"max_spend_usd":3.00}'
```

2. Create table (will return 402; pay and retry):

```bash
curl -sS https://app.run402.com/v1/tables \
  -H 'content-type: application/json' \
  -d '{"table_name":"my-table","key_schema":[{"attribute_name":"id","key_type":"HASH"}],"ttl_days":7,"max_spend_usd":3.00}'
```

> *v1.1 will add an approval step here: `POST /v1/approvals` → human approves via URL → agent polls and then provisions.*

4. Create table (may return 402 if funding required)

* On 402: pay and retry with `PAYMENT-SIGNATURE` (x402)

---

## 6.4 `/docs/x402` (how AgentDB uses x402)

Sections:

* When AgentDB returns 402
* How to top up
* Idempotency requirements for writes
* SIWX vs capability tokens

---

# 7) Machine-facing endpoints: JSON Schemas + example instances

The shapes below intentionally mirror the **de facto** “agent gateway” patterns used in the ecosystem (e.g., `/.well-known/mcp.json`, `/x402/discovery`, `/meta.json`, `/llms.txt`). ([agent402][15])

## 7.1 `/.well-known/mcp.json`

### JSON Schema: `McpServerCard.schema.json`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://app.run402.com/schemas/McpServerCard.schema.json",
  "title": "MCP Server Card",
  "type": "object",
  "additionalProperties": false,
  "required": ["name", "description", "url", "transport", "version", "tools", "payment"],
  "properties": {
    "name": { "type": "string", "minLength": 1 },
    "description": { "type": "string", "minLength": 1 },
    "url": { "type": "string", "format": "uri" },
    "transport": {
      "type": "string",
      "enum": ["streamable-http", "stdio", "sse", "websocket"]
    },
    "version": { "type": "string", "minLength": 1 },
    "tools": {
      "type": "array",
      "minItems": 0,
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["name", "description"],
        "properties": {
          "name": { "type": "string", "pattern": "^[a-zA-Z0-9._-]+$" },
          "description": { "type": "string" },
          "tags": {
            "type": "array",
            "items": { "type": "string" }
          }
        }
      }
    },
    "payment": {
      "type": "object",
      "additionalProperties": false,
      "required": ["protocol", "network", "asset", "payTo"],
      "properties": {
        "protocol": { "type": "string", "const": "x402" },
        "network": { "type": "string", "minLength": 1 },
        "asset": { "type": "string", "minLength": 1 },
        "payTo": { "type": "string", "minLength": 1 },
        "schemes": {
          "type": "array",
          "items": { "type": "string" },
          "description": "Optional list of supported x402 payment schemes (e.g., exact, credit)."
        }
      }
    }
  }
}
```

### Example instance: `/.well-known/mcp.json`

```json
{
  "name": "agentdb-mcp",
  "description": "AgentDB MCP: create and use durable tables with x402 billing and human approvals.",
  "url": "https://app.run402.com/mcp",
  "transport": "streamable-http",
  "version": "0.2.0",
  "tools": [
    { "name": "agentdb.quote_table", "description": "Estimate cost range and propose a max spend cap." },
    { "name": "agentdb.request_approval", "description": "Create a human approval request for a table." },
    { "name": "agentdb.create_table", "description": "Provision a table after approval/funding." },
    { "name": "agentdb.put", "description": "Put an item by key." },
    { "name": "agentdb.get", "description": "Get an item by key." },
    { "name": "agentdb.query", "description": "Query items by partition key (and sort key conditions, if enabled)." },
    { "name": "agentdb.receipts", "description": "Fetch receipts (line items) for cost visibility." },
    { "name": "agentdb.logs", "description": "Fetch audit/ops/error logs for debugging and governance." }
  ],
  "payment": {
    "protocol": "x402",
    "network": "eip155:8453",
    "asset": "USDC",
    "payTo": "0x0000000000000000000000000000000000000000",
    "schemes": ["exact", "credit"]
  }
}
```

---

## 7.2 `/x402/discovery`

### JSON Schema: `X402Discovery.schema.json`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://app.run402.com/schemas/X402Discovery.schema.json",
  "title": "x402 Discovery (Tool Catalog)",
  "type": "object",
  "additionalProperties": false,
  "required": ["version", "server", "policy", "tools"],
  "properties": {
    "version": { "type": "string", "minLength": 1 },
    "server": {
      "type": "object",
      "additionalProperties": false,
      "required": ["name", "description", "url"],
      "properties": {
        "name": { "type": "string" },
        "description": { "type": "string" },
        "url": { "type": "string", "format": "uri" }
      }
    },
    "policy": {
      "type": "object",
      "additionalProperties": true,
      "properties": {
        "billingMode": { "type": "string" },
        "byokSupported": { "type": "boolean" },
        "networkPolicy": { "type": "object", "additionalProperties": true }
      }
    },
    "tools": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["name", "description", "network", "payTo", "inputSchema", "outputSchema"],
        "properties": {
          "name": { "type": "string", "pattern": "^[a-zA-Z0-9._-]+$" },
          "description": { "type": "string" },

          "price": {
            "type": "string",
            "description": "Human-readable starting price (e.g., '$0.002') or 'dynamic'."
          },
          "priceModel": {
            "type": "object",
            "description": "Optional structured price model for non-flat pricing.",
            "additionalProperties": true
          },

          "network": { "type": "string" },
          "payTo": { "type": "string" },

          "billingMode": { "type": "string" },
          "byokRequired": { "type": "boolean" },
          "testnetAccess": { "type": "string" },

          "inputSchema": {
            "type": "object",
            "description": "JSON Schema for tool input.",
            "additionalProperties": true
          },
          "outputSchema": {
            "type": "object",
            "description": "JSON Schema for tool output.",
            "additionalProperties": true
          }
        }
      }
    }
  }
}
```

### Example instance: `/x402/discovery`

```json
{
  "version": "2",
  "server": {
    "name": "agentdb-mcp",
    "description": "Pay-per-use durable tables for agents with approvals, caps, receipts, and logs.",
    "url": "https://app.run402.com/mcp"
  },
  "policy": {
    "billingMode": "lease_and_usage",
    "byokSupported": false,
    "networkPolicy": { "default": "mainnet_only" }
  },
  "tools": [
    {
      "name": "agentdb.quote_table",
      "description": "Estimate cost range and propose a max spend cap.",
      "price": "free",
      "network": "eip155:8453",
      "payTo": "0x0000000000000000000000000000000000000000",
      "billingMode": "n/a",
      "byokRequired": false,
      "testnetAccess": "open",
      "inputSchema": {
        "type": "object",
        "properties": {
          "ttl_days": { "type": "integer", "minimum": 1, "maximum": 365 },
          "expected_ops_per_day": {
            "type": "object",
            "properties": {
              "read": { "type": "integer", "minimum": 0 },
              "write": { "type": "integer", "minimum": 0 }
            },
            "required": ["read", "write"]
          },
          "max_spend_usd": { "type": "number", "minimum": 0 }
        },
        "required": ["ttl_days", "expected_ops_per_day", "max_spend_usd"]
      },
      "outputSchema": {
        "type": "object",
        "properties": {
          "quote_id": { "type": "string" },
          "estimated_cost_range_usd": {
            "type": "object",
            "properties": {
              "low": { "type": "number" },
              "high": { "type": "number" }
            },
            "required": ["low", "high"]
          },
          "recommended_deposit_usd": { "type": "number" }
        },
        "required": ["quote_id", "estimated_cost_range_usd", "recommended_deposit_usd"]
      }
    },
    {
      "name": "agentdb.create_table",
      "description": "Provision a table after approval/funding.",
      "price": "dynamic",
      "priceModel": {
        "type": "lease_deposit_plus_usage",
        "depositMinimumUsd": 1.0,
        "usage": {
          "readUnitUsd": 0.0000005,
          "writeUnitUsd": 0.000002,
          "storageGbDayUsd": 0.02
        }
      },
      "network": "eip155:8453",
      "payTo": "0x0000000000000000000000000000000000000000",
      "billingMode": "lease_and_usage",
      "byokRequired": false,
      "testnetAccess": "allowlisted_project_wallets_only",
      "inputSchema": {
        "type": "object",
        "properties": {
          "approval_id": { "type": "string" },
          "table_name": { "type": "string", "minLength": 1 },
          "key_schema": {
            "type": "object",
            "properties": {
              "partitionKey": { "type": "string", "minLength": 1 },
              "sortKey": { "type": "string", "minLength": 1 }
            },
            "required": ["partitionKey"]
          }
        },
        "required": ["approval_id", "table_name", "key_schema"]
      },
      "outputSchema": {
        "type": "object",
        "properties": {
          "table_id": { "type": "string" },
          "endpoint": { "type": "string", "format": "uri" },
          "expires_at": { "type": "string" }
        },
        "required": ["table_id", "endpoint", "expires_at"]
      }
    }
  ]
}
```

---

## 7.3 `/meta.json`

### JSON Schema: `Meta.schema.json`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://app.run402.com/schemas/Meta.schema.json",
  "title": "Machine-friendly Site Metadata",
  "type": "object",
  "additionalProperties": false,
  "required": ["name", "description", "endpoints", "endpointDetails", "tools", "robots"],
  "properties": {
    "name": { "type": "string" },
    "description": { "type": "string" },
    "endpoints": {
      "type": "object",
      "additionalProperties": { "type": "string", "format": "uri" }
    },
    "endpointDetails": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["path", "methods", "url", "role"],
        "properties": {
          "path": { "type": "string" },
          "methods": { "type": "string" },
          "url": { "type": "string", "format": "uri" },
          "role": { "type": "string" }
        }
      }
    },
    "tools": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["name", "description"],
        "properties": {
          "name": { "type": "string" },
          "description": { "type": "string" },
          "price": { "type": "string" }
        }
      }
    },
    "robots": {
      "type": "object",
      "additionalProperties": false,
      "required": ["llms", "robotsTxt"],
      "properties": {
        "llms": { "type": "string", "format": "uri" },
        "robotsTxt": { "type": "string", "format": "uri" }
      }
    }
  }
}
```

### Example instance: `/meta.json`

```json
{
  "name": "agentdb-mcp",
  "description": "AgentDB: durable tables for agents with x402 billing, approvals, caps, receipts, and logs.",
  "endpoints": {
    "homepage": "https://run402.com/",
    "console": "https://app.run402.com/",
    "mcp": "https://app.run402.com/mcp",
    "mcpCard": "https://app.run402.com/.well-known/mcp.json",
    "x402Discovery": "https://app.run402.com/x402/discovery",
    "x402Manifest": "https://app.run402.com/.well-known/x402",
    "openapi": "https://app.run402.com/openapi.json",
    "meta": "https://app.run402.com/meta.json",
    "llms": "https://app.run402.com/llms.txt",
    "robotsTxt": "https://app.run402.com/robots.txt",
    "sitemap": "https://run402.com/sitemap.xml",
    "health": "https://app.run402.com/health"
  },
  "endpointDetails": [
    {
      "path": "/mcp",
      "methods": "POST, GET, DELETE",
      "url": "https://app.run402.com/mcp",
      "role": "Primary Streamable HTTP MCP transport."
    },
    {
      "path": "/.well-known/mcp.json",
      "methods": "GET",
      "url": "https://app.run402.com/.well-known/mcp.json",
      "role": "Canonical MCP server card for discovery."
    },
    {
      "path": "/x402/discovery",
      "methods": "GET",
      "url": "https://app.run402.com/x402/discovery",
      "role": "Tool list, schemas, and pricing."
    },
    {
      "path": "/.well-known/x402",
      "methods": "GET",
      "url": "https://app.run402.com/.well-known/x402",
      "role": "x402 manifest for discovery tooling and DNS-based discovery."
    }
  ],
  "tools": [
    { "name": "agentdb.quote_table", "description": "Estimate costs and propose caps.", "price": "free" },
    { "name": "agentdb.create_table", "description": "Provision a table after approval.", "price": "dynamic" }
  ],
  "robots": {
    "llms": "https://app.run402.com/llms.txt",
    "robotsTxt": "https://app.run402.com/robots.txt"
  }
}
```

---

## 7.4 `/llms.txt` template

This is not standardized, but the ecosystem pattern is: a concise outline of canonical discovery endpoints + docs entry points (see agent402). ([agent402][16])

**Example `llms.txt`:**

```txt
# AgentDB — accountless cloud tables for AI agents with x402 billing.

## Canonical Discovery
- MCP card: https://app.run402.com/.well-known/mcp.json
- MCP transport: https://app.run402.com/mcp
- x402 discovery: https://app.run402.com/x402/discovery
- x402 manifest: https://app.run402.com/.well-known/x402
- OpenAPI: https://app.run402.com/openapi.json
- Meta: https://app.run402.com/meta.json

## Agent Quickstarts
- MCP quickstart: https://run402.com/docs/quickstart/agents-mcp
- REST quickstart: https://run402.com/docs/quickstart/agents-rest

## Human Docs
- Overview: https://run402.com/product
- Pricing: https://run402.com/pricing
- Learn x402: https://run402.com/learn/what-is-x402
- Compare: https://run402.com/compare

## Console
- Console: https://app.run402.com/

## Health
- API health: https://app.run402.com/health
- Status: https://status.run402.com/
```

---

## 7.5 `/.well-known/x402` manifest (discovery manifest)

This is the manifest URL pattern referenced by the DNS discovery draft (operators may host at `/.well-known/x402`), with JSON format required for manifests. ([IETF Datatracker][1])
The draft doesn’t prescribe a concrete field schema; so you should publish a **stable, versioned manifest**.

### JSON Schema: `X402Manifest.schema.json`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://app.run402.com/schemas/X402Manifest.schema.json",
  "title": "x402 Discovery Manifest",
  "type": "object",
  "additionalProperties": false,
  "required": ["version", "service", "x402", "resources", "links"],
  "properties": {
    "version": {
      "type": "string",
      "description": "Manifest schema version.",
      "pattern": "^x402-manifest\\/\\d+$"
    },
    "service": {
      "type": "object",
      "additionalProperties": false,
      "required": ["name", "description"],
      "properties": {
        "name": { "type": "string" },
        "description": { "type": "string" }
      }
    },
    "x402": {
      "type": "object",
      "additionalProperties": false,
      "required": ["protocolVersion", "schemes", "networks", "assets"],
      "properties": {
        "protocolVersion": { "type": "string", "description": "e.g., '2'" },
        "schemes": { "type": "array", "items": { "type": "string" } },
        "networks": { "type": "array", "items": { "type": "string" } },
        "assets": { "type": "array", "items": { "type": "string" } },
        "facilitator": {
          "type": "object",
          "additionalProperties": false,
          "required": ["verifyUrl", "settleUrl"],
          "properties": {
            "verifyUrl": { "type": "string", "format": "uri" },
            "settleUrl": { "type": "string", "format": "uri" }
          }
        }
      }
    },
    "resources": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["path", "methods", "description", "payment"],
        "properties": {
          "path": { "type": "string" },
          "methods": {
            "type": "array",
            "items": { "type": "string", "enum": ["GET", "POST", "PUT", "PATCH", "DELETE"] }
          },
          "description": { "type": "string" },
          "payment": {
            "type": "object",
            "additionalProperties": false,
            "required": ["mode"],
            "properties": {
              "mode": {
                "type": "string",
                "enum": ["none", "exact", "dynamic", "quote_then_pay", "lease_and_usage"]
              },
              "priceHint": { "type": "string" },
              "currency": { "type": "string", "default": "USD" }
            }
          }
        }
      }
    },
    "links": {
      "type": "object",
      "additionalProperties": false,
      "required": ["x402Discovery", "mcpCard", "mcp", "openapi", "meta", "llms"],
      "properties": {
        "x402Discovery": { "type": "string", "format": "uri" },
        "mcpCard": { "type": "string", "format": "uri" },
        "mcp": { "type": "string", "format": "uri" },
        "openapi": { "type": "string", "format": "uri" },
        "meta": { "type": "string", "format": "uri" },
        "llms": { "type": "string", "format": "uri" }
      }
    }
  }
}
```

### Example instance: `/.well-known/x402`

```json
{
  "version": "x402-manifest/1",
  "service": {
    "name": "AgentDB API",
    "description": "Accountless durable tables for agents with x402 billing and human approvals."
  },
  "x402": {
    "protocolVersion": "2",
    "schemes": ["exact", "credit"],
    "networks": ["eip155:8453"],
    "assets": ["USDC"],
    "facilitator": {
      "verifyUrl": "https://facilitator.example/verify",
      "settleUrl": "https://facilitator.example/settle"
    }
  },
  "resources": [
    {
      "path": "/v1/tables:quote",
      "methods": ["POST"],
      "description": "Return cost estimate range and recommended deposit.",
      "payment": { "mode": "none" }
    },
    {
      "path": "/v1/approvals",
      "methods": ["POST"],
      "description": "Create human approval request (may require payment depending on policy).",
      "payment": { "mode": "dynamic", "priceHint": "Typically free" }
    },
    {
      "path": "/v1/tables",
      "methods": ["POST"],
      "description": "Create table after approval; funds lease and provisions table.",
      "payment": { "mode": "lease_and_usage", "priceHint": "Deposit + usage", "currency": "USD" }
    }
  ],
  "links": {
    "x402Discovery": "https://app.run402.com/x402/discovery",
    "mcpCard": "https://app.run402.com/.well-known/mcp.json",
    "mcp": "https://app.run402.com/mcp",
    "openapi": "https://app.run402.com/openapi.json",
    "meta": "https://app.run402.com/meta.json",
    "llms": "https://app.run402.com/llms.txt"
  }
}
```

---

# 8) Optional: DNS discovery note (for your Learning + Docs)

If you want to support DNS-based discovery, add a “For operators” note in docs and publish:

```
_x402.app.run402.com TXT "v=x4021;descriptor=api;url=https://app.run402.com/.well-known/x402"
```

The DNS discovery draft describes `_x402` TXT records pointing to an HTTPS manifest URL (often `/.well-known/x402`) and emphasizes TLS validation requirements. ([IETF Datatracker][1])

---

# 9) What I would implement first (so the website matches reality)

To avoid a “pretty website / missing product” mismatch, the minimum implementation that makes every page honest:

1. `/v1/tables:quote` returns real estimates
2. `/v1/approvals` + approval URL page
3. `/v1/tables` create + TTL + caps
4. Receipts ledger endpoint
5. Logs endpoint (audit + ops at least)
6. `/.well-known/mcp.json`, `/x402/discovery`, `/meta.json`, `/llms.txt`
7. Console pages: Tables, Approvals, Receipts, Logs

---

If you want, I can also generate:

* a **full OpenAPI 3.1 spec** for the REST surface (quote/approval/table CRUD/receipts/logs),
* a matching **MCP tool schema** set (tools/list + tools/call payloads),
* and a **pixel-level component spec** (design tokens, layout, and concrete UI states for approval flows and low-balance top-ups).

[1]: https://datatracker.ietf.org/doc/draft-jeftovic-x402-dns-discovery/ "
            
    
        draft-jeftovic-x402-dns-discovery-00 - Discovering x402 Resources via DNS TXT Records
    

        "
[2]: https://docs.cdp.coinbase.com/x402/core-concepts/how-it-works?utm_source=chatgpt.com "How x402 Works - Coinbase Developer Documentation"
[3]: https://docs.x402.org/?utm_source=chatgpt.com "Welcome to x402 - x402"
[4]: https://www.x402.org/writing/x402-v2-launch?utm_source=chatgpt.com "Introducing x402 V2: Evolving the Standard for Internet- ..."
[5]: https://docs.x402.org/extensions/sign-in-with-x?utm_source=chatgpt.com "Sign-In-With-X (SIWX)"
[6]: https://docs.x402.org/extensions/payment-identifier?utm_source=chatgpt.com "Payment-Identifier (Idempotency)"
[7]: https://docs.cdp.coinbase.com/x402/bazaar?utm_source=chatgpt.com "x402 Bazaar (Discovery Layer)"
[8]: https://upstash.com/docs/redis/overall/pricing?utm_source=chatgpt.com "Pricing & Limits - Upstash Documentation"
[9]: https://upstash.com/docs/redis/features/restapi?utm_source=chatgpt.com "REST API - Upstash Documentation"
[10]: https://turso.tech/pricing?utm_source=chatgpt.com "Turso Database Pricing"
[11]: https://docs.turso.tech/api-reference/authentication?utm_source=chatgpt.com "Authentication"
[12]: https://www.cloudflare.com/plans/developer-platform-pricing/?utm_source=chatgpt.com "Workers & Pages Pricing"
[13]: https://cloud.google.com/firestore/pricing?utm_source=chatgpt.com "Firestore pricing"
[14]: https://developers.cloudflare.com/fundamentals/api/get-started/account-owned-tokens/?utm_source=chatgpt.com "Account API tokens · Cloudflare Fundamentals docs"
[15]: https://agent402.dev/.well-known/mcp.json "agent402.dev"
[16]: https://agent402.dev/llms.txt "agent402.dev"


elevator pitch: AgentDB (by Run402) turns cloud infrastructure into something an AI agent can safely buy.

Today, when a coding agent needs a database, it hits a wall: someone has to create a cloud account, set up billing, click through consoles, manage keys, and then you still risk surprise spend. That friction kills autonomous workflows and makes platform teams say “no” to agents provisioning anything real.

Run402 built AgentDB: a production-grade cloud database that can be provisioned in seconds with **no AWS account, no signup, and no API keys**. It uses the **x402 standard**—HTTP 402 “Payment Required”—so an agent can request a quote, present a maximum spend to a human, get one-click approval, and then automatically provision and operate the database. Every request produces receipts and logs, budgets are hard-enforced, and resources auto-expire so you never pay forever. We offer QoS-backed tiers with an SLA and transparent status.

The wedge is simple: **agent-native procurement** for state. Once you can buy a database over HTTP, you can buy anything—queues, storage, model calls, test environments—under policy. We’re building the default payments-and-governance layer for agentic infrastructure.


Below is a **DynamoDB‑CLI‑compatible** design for the `run402 db` command that preserves AWS muscle memory as much as possible.

The goal is that for the common CRUD + table lifecycle operations, you can **almost always** do:

* Replace `aws dynamodb` with `run402 db` (or `run402 dynamodb`)
* Keep the rest of the command line the same

Example (yours):

```bash
aws dynamodb get-item --table-name MyTable --key '{"id":{"S":"123"}}'
run402 db get-item  --table-name MyTable --key '{"id":{"S":"123"}}'
```

---

## 1) CLI identity and compatibility contract

### Command shape (AWS-style)

`run402 [global options] <service> <operation> [parameters]`

### Service aliases

* `run402 db ...`  ✅ (short)
* `run402 dynamodb ...` ✅ (drop-in mental model)

### Compatibility contract

**For supported operations**, `run402 db` will:

* Accept the **same parameters** as the AWS CLI DynamoDB command references (AWS CLI v2 style) for the subset we implement (see scope below). ([AWS Documentation][1])
* Accept DynamoDB **AttributeValue JSON** (`{"S":...,"N":...,"M":...,"L":...}` etc.) exactly as AWS CLI examples and docs describe. ([AWS Documentation][2])
* Return response JSON shaped like AWS CLI outputs (e.g., `{"Item": ...}`, `{"TableDescription": ...}`), plus optional run402 extensions under a dedicated field (off by default).

---

## 2) Supported scope (v1)

You asked for “as close as possible” but not 100%. Here’s the intentional scope.

### ✅ Supported control-plane commands (table lifecycle)

| Command                                       | Status      | Notes                                                                                                                                                                                                                       |
| --------------------------------------------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list-tables`                                 | ✅           | Supports AWS pagination flags `--starting-token`, `--page-size`, `--max-items`. ([AWS Documentation][3])                                                                                                                    |
| `describe-table`                              | ✅           | `--table-name` only. ([AWS Documentation][4])                                                                                                                                                                               |
| `create-table`                                | ✅ (limited) | Supports `--table-name`, `--attribute-definitions`, `--key-schema`, `--billing-mode`. **No GSIs/LSIs/streams** in v1. AWS has many more options; we will error if you try to use unsupported ones. ([AWS Documentation][5]) |
| `delete-table`                                | ✅           | `--table-name` only. ([AWS Documentation][6])                                                                                                                                                                               |
| `update-time-to-live`                         | ✅           | Supports `--time-to-live-specification Enabled=...,AttributeName=...` ([AWS Documentation][7])                                                                                                                              |
| `describe-time-to-live`                       | ✅           | `--table-name` only. ([AWS Documentation][8])                                                                                                                                                                               |
| `wait table-exists` / `wait table-not-exists` | ✅           | Parity with AWS waiters (behavioral equivalent).                                                                                                                                                                            |

### ✅ Supported data-plane commands (CRUD/query)

| Command            | Status            | Notes                                                                                                                                                         |
| ------------------ | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `get-item`         | ✅                 | Supports `--key`, `--consistent-read`, `--projection-expression`, `--expression-attribute-names`, `--return-consumed-capacity`. ([AWS Documentation][1])      |
| `put-item`         | ✅                 | Supports conditional puts and expressions, `--return-values`, `--return-consumed-capacity`. ([AWS Documentation][2])                                          |
| `update-item`      | ✅                 | Supports `--update-expression`, `--condition-expression`, `--expression-attribute-*`, `--return-values`. ([AWS Documentation][9])                             |
| `delete-item`      | ✅                 | Supports condition/expression flags and `--return-values`. ([AWS Documentation][10])                                                                          |
| `query`            | ✅ (no indexes v1) | Supports `--key-condition-expression`, `--filter-expression`, `--projection-expression`, pagination. `--index-name` errors for now. ([AWS Documentation][11]) |
| `scan`             | ⚠️ guarded        | Supported **only with an explicit run402 override** (see below), because scans are easy to abuse/costly. AWS supports scan broadly. ([AWS Documentation][12])  |
| `batch-get-item`   | ✅                 | Supports `--request-items`. ([AWS Documentation][13])                                                                                                         |
| `batch-write-item` | ✅                 | Supports `--request-items` (PutRequest/DeleteRequest). ([AWS Documentation][14])                                                                              |

### ❌ Not supported in v1 (explicit)

* Transactions: `transact-write-items`, `transact-get-items`
* Secondary indexes (LSI/GSI) creation/query
* Streams
* PartiQL (`execute-statement`, `batch-execute-statement`)
* Import/export, PITR backups, global tables (unless you choose to add a “multi-region tier” later)

If you call an unsupported operation or pass unsupported flags, you get a **hard error** (never silently ignored).

---

## 3) Global options (AWS-like) + run402 extensions

### AWS-like global options (supported)

* `--endpoint-url` (points to run402 API gateway; default configured)
* `--region` (maps to run402 “service region”)
* `--profile` (selects a run402 profile)
* `--output`, `--query`, `--no-cli-pager`
* `--cli-read-timeout`, `--cli-connect-timeout`
* `--cli-binary-format` (for Binary attributes parity)
* `--cli-input-json | --cli-input-yaml`, `--generate-cli-skeleton` (optional but recommended for parity)

These appear in AWS CLI DynamoDB command synopses and are worth matching to make scripts portable. ([AWS Documentation][1])

### run402-specific global extensions (namespaced to avoid collisions)

All run402-only flags start with `--run402-` so you can copy/paste AWS CLI commands unchanged and only add run402 controls when needed.

**Payment + approvals**

* `--run402-pay ask|auto|never` (default: `ask`)
* `--run402-max-pay-usd <float>` (cap for auto-pay)
* `--run402-approval ask|auto|never` (default: `ask`) *(v1.1)*
* `--run402-approval-url` (print-only; outputs a URL if approval is required) *(v1.1)*
* `--run402-noninteractive` (never prompt; return machine-readable “payment/approval required” JSON + exit code)

**Resource safety defaults**

* `--run402-ttl <duration>` (e.g., `7d`, `24h`) for `create-table` if you want explicit per-call TTL
* `--run402-max-spend-usd <float>` (hard lifetime cap for the table lease)
* `--run402-daily-cap-usd <float>` (optional)
* `--run402-include-billing` (adds a `Run402Billing` object to outputs; off by default)

**Scan guardrails**

* `--run402-allow-scan` (required to run `scan`)
* `--run402-scan-max-items <int>` (hard cap)
* `--run402-scan-max-mb <int>` (hard cap)

---

## 4) Config that feels like `aws configure`

### `run402 configure`

Interactive prompt modeled after AWS CLI, but instead of AWS access keys you set payment/policy defaults.

Prompts:

* Default endpoint URL
* Default region
* Default output format
* Default table TTL (e.g., 7d)
* Default max spend USD (e.g., 3.00)
* Payment mode (`ask`/`auto`/`never`)
* Max auto-pay USD
* Approval policy threshold (optional)

### File format (INI, AWS-like)

Path: `~/.run402/config`

Example:

```ini
[default]
region = us-east-1
output = json
endpoint_url = https://app.run402.com
run402_default_ttl = 7d
run402_default_max_spend_usd = 3.00
run402_pay = ask
run402_max_auto_pay_usd = 0.50

[profile work]
region = eu-west-1
run402_default_max_spend_usd = 25.00
run402_pay = auto
run402_max_auto_pay_usd = 1.00
```

This preserves the familiar `--profile` workflow from AWS CLI.

---

## 5) DynamoDB JSON compatibility (AttributeValue)

To match AWS CLI, keys and items use DynamoDB AttributeValue objects:

* String: `{"S":"hello"}`
* Number: `{"N":"123.45"}`
* Binary (base64): `{"B":"..."}`
* Map: `{"M": { "a": {"S":"x"} }}`
* List: `{"L": [ {"S":"x"}, {"N":"1"} ]}`
* Sets: `{"SS":[...], "NS":[...], "BS":[...]}`

This is exactly the format described in the AWS CLI references for item and expression values. ([AWS Documentation][2])

---

## 6) Payment + approval behavior (the big difference vs AWS)

AWS DynamoDB calls don’t have a payment step. Your wrapper does.

### When run402 will require payment

* `create-table` (fund the table lease / minimum deposit)
* Any operation when balance is low or cap would be exceeded
* Optional: log retention upgrades, TTL extension

### Interactive default (`--run402-pay ask`)

If the server replies with **HTTP 402 Payment Required** (x402 style), the CLI prints a prompt:

```txt
Payment required to continue (x402):
  Operation: db create-table
  Table: MyTable
  Required deposit: $1.50
  Cap (lifetime): $3.00
Approve & pay now? [y/N]
```

*(v1.1)* If approval is required (policy threshold exceeded), CLI prints:

```txt
Approval required:
  Estimated range: $0.35–$1.10
  Cap requested: $3.00
Open approval link:
  https://app.run402.com/approve/ap_...
```

### Non-interactive mode (`--run402-noninteractive`)

The CLI exits with:

* exit code `3` = payment required (not paid)
* exit code `4` = approval required (not granted) *(v1.1)*

And prints JSON such as:

```json
{
  "error": "ApprovalRequired",
  "approval_url": "https://app.run402.com/approve/ap_01J...",
  "requested_cap_usd": 3.0,
  "estimated_cost_range_usd": {"low": 0.35, "high": 1.10}
}
```

This is what you want for **agents**: they can display the quote and route the human to approve.

---

## 7) Command examples (AWS → run402)

### 7.1 `get-item` (exact drop-in)

AWS CLI flags here include `--table-name`, `--key`, optional `--consistent-read`, `--projection-expression`, etc. ([AWS Documentation][1])

```bash
run402 db get-item \
  --table-name MyTable \
  --key '{"id":{"S":"123"}}'
```

### 7.2 `put-item`

AWS CLI synopsis shows `--item`, expression flags, and `--return-values`, etc. ([AWS Documentation][2])

```bash
run402 db put-item \
  --table-name MyTable \
  --item '{"id":{"S":"123"},"email":{"S":"a@b.com"}}' \
  --return-consumed-capacity TOTAL
```

### 7.3 `query`

AWS CLI synopsis includes `--key-condition-expression`, `--expression-attribute-values`, `--filter-expression`, pagination flags. ([AWS Documentation][11])

```bash
run402 db query \
  --table-name MyTable \
  --key-condition-expression "id = :v" \
  --expression-attribute-values '{":v":{"S":"123"}}' \
  --limit 20
```

### 7.4 `create-table` (AWS-like args, run402 safety extensions)

AWS CLI `create-table` supports many options. We support the core ones and will reject unsupported ones in v1. ([AWS Documentation][5])

```bash
run402 db create-table \
  --table-name MyTable \
  --attribute-definitions AttributeName=id,AttributeType=S \
  --key-schema AttributeName=id,KeyType=HASH \
  --billing-mode PAY_PER_REQUEST \
  --run402-ttl 7d \
  --run402-max-spend-usd 3.00
```

### 7.5 TTL parity (`update-time-to-live` / `describe-time-to-live`)

AWS CLI TTL commands and shorthand syntax are well-defined. ([AWS Documentation][7])

```bash
run402 db update-time-to-live \
  --table-name MyTable \
  --time-to-live-specification Enabled=true,AttributeName=ttl
```

```bash
run402 db describe-time-to-live --table-name MyTable
```

### 7.6 `scan` (guarded)

AWS supports scan broadly; it’s paginated and has many flags. ([AWS Documentation][12])
run402 requires explicit opt-in:

```bash
run402 db scan \
  --table-name MyTable \
  --run402-allow-scan \
  --run402-scan-max-items 1000
```

---

## 8) Output compatibility (AWS-like), with optional run402 extensions

### Default output (AWS-shaped)

Example `get-item` output (AWS-like):

```json
{
  "Item": {
    "id": {"S":"123"},
    "email": {"S":"a@b.com"}
  },
  "ConsumedCapacity": {
    "TableName": "MyTable",
    "CapacityUnits": 0.5
  }
}
```

### Optional run402 fields (only with `--run402-include-billing`)

```json
{
  "Item": { "...": "..." },
  "ConsumedCapacity": { "...": "..." },
  "Run402Billing": {
    "estimated_cost_usd": 0.0000008,
    "balance_remaining_usd": 2.41,
    "cap_remaining_usd": 2.41,
    "request_id": "req_01J..."
  }
}
```

This keeps compatibility clean by default, while still enabling cost transparency when you want it.

---

## 9) What makes this “AWS-like” in practice

1. **Same command names**: `get-item`, `put-item`, `query`, etc. ([AWS Documentation][1])
2. **Same parameter names**: `--table-name`, `--key`, `--item`, expression parameters. ([AWS Documentation][1])
3. **Same DynamoDB JSON shapes** for item/keys/expression values. ([AWS Documentation][2])
4. **Same pagination ergonomics**: `--starting-token`, `--page-size`, `--max-items`. ([AWS Documentation][3])
5. **Strict errors** when you use features we haven’t implemented (indexes, transactions) so users don’t think they’re protected when they aren’t.

---

## 10) Next step: do you want *AWS CLI argument parsing exactness*?

If you want *maximum* drop-in compatibility (including odd edge behaviors like shorthand parsing quirks and skeleton generation), the most robust approach is:

* Implement `run402 db` using the **same parameter models** as the AWS CLI docs for each supported command (synopsis/options).
* Enforce a **compatibility test suite**:

  * take real AWS CLI DynamoDB examples
  * run them through `run402 db ...`
  * compare request objects and response shapes

If you want, I can produce:

* a **complete command-by-command “supported flags” matrix** (down to every option in each synopsis we support),
* and a **golden test corpus** built from AWS CLI docs for `get-item`, `put-item`, `query`, `update-item`, `batch-*`, `create-table`, TTL, scan. ([AWS Documentation][1])

[1]: https://docs.aws.amazon.com/cli/latest/reference/dynamodb/get-item.html "get-item — AWS CLI 2.33.8 Command Reference"
[2]: https://docs.aws.amazon.com/cli/latest/reference/dynamodb/put-item.html "put-item — AWS CLI 2.33.22 Command Reference"
[3]: https://docs.aws.amazon.com/cli/latest/reference/dynamodb/list-tables.html "list-tables — AWS CLI 2.33.28 Command Reference"
[4]: https://docs.aws.amazon.com/cli/latest/reference/dynamodb/describe-table.html "describe-table — AWS CLI 2.33.22 Command Reference"
[5]: https://docs.aws.amazon.com/cli/latest/reference/dynamodb/create-table.html "create-table — AWS CLI 2.33.19 Command Reference"
[6]: https://docs.aws.amazon.com/cli/latest/reference/dynamodb/delete-table.html "delete-table — AWS CLI 2.33.21 Command Reference"
[7]: https://docs.aws.amazon.com/cli/latest/reference/dynamodb/update-time-to-live.html "update-time-to-live — AWS CLI 2.33.20 Command Reference"
[8]: https://docs.aws.amazon.com/cli/latest/reference/dynamodb/describe-time-to-live.html "describe-time-to-live — AWS CLI 2.33.28 Command Reference"
[9]: https://docs.aws.amazon.com/cli/latest/reference/dynamodb/update-item.html "update-item — AWS CLI 2.33.18 Command Reference"
[10]: https://docs.aws.amazon.com/cli/latest/reference/dynamodb/delete-item.html "delete-item — AWS CLI 2.33.21 Command Reference"
[11]: https://docs.aws.amazon.com/cli/latest/reference/dynamodb/query.html "query — AWS CLI 2.33.20 Command Reference"
[12]: https://docs.aws.amazon.com/cli/latest/reference/dynamodb/scan.html "scan — AWS CLI 2.33.19 Command Reference"
[13]: https://docs.aws.amazon.com/cli/latest/reference/dynamodb/batch-get-item.html "batch-get-item — AWS CLI 2.33.22 Command Reference"
[14]: https://docs.aws.amazon.com/cli/latest/reference/dynamodb/batch-write-item.html "batch-write-item — AWS CLI 2.33.19 Command Reference"

---

# Founder Interview — Decisions Log (2025-02-25)

The following decisions were made through a structured interview to resolve all open questions in the spec. Every decision here is **binding for the MVP** unless explicitly marked as deferred.

---

## D1. Brand & Identity

| Decision | Value |
|---|---|
| **Company name** | **Run402** |
| **Initial product name** | **AgentDB** (the DynamoDB equivalent — Run402's first cloud primitive for agents) |
| **Domain** | run402.com |
| **CLI command** | `run402` (platform CLI; `run402 db` for the AgentDB service) |
| **Subdomains** | `run402.com` (marketing + docs), `app.run402.com` (API + console) |
| **Tagline** | **Deferred** — to be brainstormed. Vision is bigger than databases: "databases are just the first in this cloud-for-agents space." The spec placeholder "A cloud database your agent can buy" works for now but should evolve to reflect the full platform. |
| **Naming convention** | **Run402** = company/platform. **AgentDB** = the database product. All references to "ws402" → **run402**. |

### Global rename map (apply throughout all spec sections)

* `ws402` → `run402` (applied)
* `agentdb.com` → `run402.com` (applied — company domain; AgentDB is a product under Run402)
* `console.agentdb.com` → `app.run402.com` (applied)
* `api.agentdb.com` → `app.run402.com` (applied — single app subdomain)
* `status.agentdb.com` → `status.run402.com` (applied)
* `approve.agentdb.com` → `app.run402.com/approve` (applied)
* "Store" (as resource noun) → **"Table"** throughout API, CLI, docs, and marketing
* `/v1/tables` → `/v1/tables`
* `/v1/tables/{table_id}` → `/v1/tables/{table_id}`
* `/v1/tables/{table_id}/items/{pk}` → `/v1/tables/{table_id}/items/{pk}`
* `/v1/tables/{table_id}:query` → `/v1/tables/{table_id}:query`
* `/v1/tables/{table_id}/logs` → `/v1/tables/{table_id}/logs`
* `/v1/tables/{table_id}/budget` → `/v1/tables/{table_id}/budget`
* `/v1/tables:quote` → `/v1/tables:quote`
* `table_id` → `table_id`
* `table_name` → `table_name`
* `table_secret` → `table_secret`
* MCP tool names: keep as `agentdb.*` (product-specific tool namespace)
* MCP tool: `agentdb.quote_table` → `agentdb.quote_table`
* MCP tool: `agentdb.create_table` → `agentdb.create_table`
* MCP server name: `agentdb-mcp` (product-specific)

---

## D2. Platform Vision

**AgentDB (databases) is product #1, not the whole product.**

Run402 is building toward **full cloud primitives for agents** — a platform where any cloud resource (databases, queues, object storage, compute, caching, DNS) can be provisioned and paid for by agents via x402, without cloud accounts.

**Roadmap vision (order TBD):**

1. **AgentDB** — Tables (DynamoDB-backed KV/NoSQL) — **this MVP**
2. Queues (SQS-like message queues)
3. Object storage (S3-like blob storage)
4. Functions / compute (serverless invocations)
5. Caching (Redis-like)
6. DNS / domain management

This means the API namespace `/v1/tables/...` is intentionally scoped. Future services will live at `/v1/queues/...`, `/v1/blobs/...`, etc. The x402 payment and metering layer should be designed as a shared platform concern, not table-specific.

---

## D3. Team & Timeline

| Decision | Value |
|---|---|
| **Team size** | Small (2–5 people) |
| **Composition** | 2–3 fullstack engineers + 1 infra/devops |
| **Timeline** | **2–6 weeks** to a working MVP |
| **Priority order** | 1) REST API → 2) CLI (`run402 db`) → 3) MCP server |
| **Website scope** | Full website from spec (marketing + console + learn section) |

---

## D4. Technical Stack

| Component | Technology | Rationale |
|---|---|---|
| **Backend API** | **TypeScript** (Hono or Fastify) | x402 reference implementations are TS-first; MCP SDK is TS-first; shared types across entire stack |
| **CLI** | **TypeScript** (oclif) | Shared types with API; open-source |
| **MCP server** | **TypeScript** | Native MCP SDK compatibility |
| **Client SDK (TS)** | **TypeScript** | Same language as backend; open-source |
| **Client SDK (Python)** | **Python** | Cover the two most common agent/dev languages |
| **Frontend (marketing + console)** | **Next.js** (React) | SSR/SSG, large ecosystem |
| **Repository** | **Monorepo** (Turborepo or Nx) | Shared types, coordinated deploys |

### Monorepo structure (recommended)

```
run402/
├── apps/
│   ├── api/          # Hono/Fastify API server
│   ├── web/          # Next.js marketing + console
│   └── mcp/          # MCP server
├── packages/
│   ├── core/         # Shared types, schemas, DynamoDB format utils
│   ├── x402/         # x402 header parsing, facilitator client
│   ├── metering/     # Metering/ledger logic
│   ├── cli/          # oclif CLI (run402 db)
│   ├── sdk-ts/       # TypeScript client SDK (open-source)
│   └── sdk-py/       # Python client SDK (open-source, separate build)
├── infra/            # AWS CDK / Terraform / CloudFormation
├── docs/             # This spec + internal docs
├── turbo.json
└── package.json
```

---

## D5. Infrastructure Architecture

| Component | Technology | Detail |
|---|---|---|
| **Compute** | AWS ECS/Fargate | Containerized API server, auto-scaling |
| **Load balancer** | AWS ALB | Regional, health checks, target groups |
| **CDN/Edge** | AWS CloudFront | Cache discovery endpoints, DDoS protection, global TLS termination |
| **Database (customer data)** | AWS DynamoDB (on-demand) | Single shared multi-tenant table (`agentdb-data-001`). PK-prefixed with `{tableId}#`. GSI on `_tid` for scans. |
| **Database (internal state)** | AWS DynamoDB | Ledger, metering, table metadata, capability tokens |
| **Region** | **us-east-1** (N. Virginia) | Cheapest, most services, default |
| **CI/CD** | GitHub Actions | Build, test, deploy to ECS |
| **Monitoring** | AWS CloudWatch + SNS | Metrics, logs, alarms |
| **Status page** | Self-hosted (Upptime or Cachet) | status.run402.com |

### Architecture diagram (text)

```
                    ┌─────────────────┐
                    │   CloudFront    │
                    │  (edge cache +  │
                    │   TLS + DDoS)   │
                    └────────┬────────┘
                             │
                    ┌────────▼────────┐
                    │      ALB        │
                    │  (us-east-1)    │
                    └────────┬────────┘
                             │
              ┌──────────────┼──────────────┐
              │              │              │
     ┌────────▼───┐  ┌──────▼─────┐  ┌─────▼──────┐
     │  Fargate   │  │  Fargate   │  │  Fargate   │
     │  Task #1   │  │  Task #2   │  │  Task #N   │
     │  (API)     │  │  (API)     │  │  (API)     │
     └────────┬───┘  └──────┬─────┘  └─────┬──────┘
              │              │              │
              └──────────────┼──────────────┘
                             │
                    ┌────────┼────────┐
                    │                 │
           ┌───────▼───────┐  ┌──────▼──────┐
           │   DynamoDB    │  │  DynamoDB   │
           │ (shared       │  │ (internal:  │
           │  customer     │  │  ledger,    │
           │  data table)  │  │  metadata)  │
           │ agentdb-      │  └─────────────┘
           │  data-001     │
           └───────────────┘
```

---

## D6. Auth Model

**Both wallet-as-identity AND capability tokens from day 1.**

| Auth method | Used for | How it works |
|---|---|---|
| **Capability token** (Bearer) | Data-plane access (CRUD/query) | Table creation returns `table_secret`. Client sends `Authorization: Bearer <table_secret>`. Fast, language-agnostic. |
| **Wallet identity** (SIWX) | Console sign-in, control-plane ops (list tables, view receipts, manage budgets) | Client proves wallet ownership via SIWX signed message. Server issues a session token. |
| **x402 payment header** | Creating tables, top-ups | x402 `PAYMENT-SIGNATURE` header inherently proves payer identity during payment flows. |

### Access matrix

| Operation | Capability token | Wallet (SIWX) | x402 payment |
|---|---|---|---|
| `PUT /items/{pk}` | Required | — | If balance low |
| `GET /items/{pk}` | Required | — | If balance low |
| `POST :query` | Required | — | If balance low |
| `GET /v1/tables` | — | Required | — |
| `POST /v1/tables` | — | Required | Required (deposit) |
| `DELETE /v1/tables/{id}` | — | Required | — |
| `GET /v1/usage` | — | Required | — |
| `GET /v1/receipts` | — | Required | — |
| Console access | — | Required | — |

---

## D7. Blockchain & Payments

| Decision | Value |
|---|---|
| **Network** | Base only (eip155:8453) at launch |
| **Asset** | USDC |
| **Facilitator** | Coinbase x402 facilitator (hosted). Plan to self-host later for independence. |
| **Treasury / receiving wallet** | Coinbase Commerce / custody. Secure, managed, reduces hot wallet risk. |
| **Console wallet provider** | Coinbase Wallet (primary). Featured in connect flow. |
| **Testnet** | Base Sepolia (testnet mode with fake USDC). Full API works, no real money. |

---

## D8. Product: AgentDB (Tables)

| Decision | Value |
|---|---|
| **Resource name** | "Table" everywhere (API, CLI, docs, marketing) |
| **API paths** | `/v1/tables/{table_id}`, `/v1/tables/{table_id}/items/{pk}`, etc. |
| **API response format** | DynamoDB AttributeValue JSON (`{"Item":{"id":{"S":"123"}}}`) |
| **Error format** | DynamoDB error codes (`ConditionalCheckFailedException`, `ValidationException`, etc.) |
| **Expression support** | Full DynamoDB expressions: `update-expression`, `condition-expression`, `filter-expression`, `projection-expression` |
| **Item size limit** | 400KB (same as DynamoDB) |
| **Primary key** | Partition key (string, required) + optional sort key (string) |
| **Capacity mode** | On-demand only |

---

## D9. Product: Tiers

**Two tiers for MVP.**

| | **Ephemeral** | **Project** |
|---|---|---|
| Default TTL | 7 days | Configurable (default 90 days) |
| Log retention | 7 days | 30 days |
| SLA target | Best-effort | Higher (specific target TBD) |
| Max storage | 10 GB | 10 GB |
| Max ops/sec | 1,000 req/s | 1,000 req/s |
| Max tables per wallet | 50 (shared across tiers) | 50 (shared across tiers) |
| Backups | No | Optional (roadmap) |
| Multi-region | No | No (v2) |

---

## D10. Product: Metering & Billing

| Decision | Value |
|---|---|
| **Metering approach** | **Synchronous in-request**. Each API request computes cost inline, deducts from balance in a DynamoDB ledger table, rejects if insufficient. |
| **Pricing** | **Deferred** — needs cost modeling. Must cover DynamoDB on-demand costs (~$1.25/M writes, ~$0.25/M reads, ~$0.25/GB-month storage) plus margin. |
| **Billing model** | Lease + prepaid balance. Deposit at creation, usage draws down balance, 402 on low balance. |
| **Free tier** | Testnet mode only (Base Sepolia, fake USDC). No free mainnet tier. |

### Metering flow (per request)

```
1. Request arrives with Bearer table_secret
2. Validate token → resolve table_id (logical table in shared data table)
3. Compute worst-case hold:
   - Write: ceil(item_size / 1KB) * write_unit_price
   - Read: ceil(MAX_ITEM_BYTES / 4KB) * read_unit_price + egress estimate
4. Atomic DynamoDB update on ledger (internal metadata table):
   - ConditionExpression: balance >= worst_case_hold
   - UpdateExpression: SET balance = balance - worst_case_hold
5. If condition fails → return 402 (top-up required)
6. Execute DynamoDB operation on shared data table with prefixed keys:
   - PK = "{tableId}#{userPK}", SK = "{userSK}"
   - Include ReturnConsumedCapacity: TOTAL
7. Compute actual cost from ConsumedCapacity + response egress bytes
8. Reconcile: release hold, debit actual cost (or worst-case if actual is lower)
9. Return response with metering headers:
   - X-Request-Id
   - X-Table-Id
   - X-Metered-Units
   - X-Metered-Egress-Bytes
   - X-Estimated-Cost-Usd
   - X-Balance-Remaining-Usd
```

---

## D11. Product: Lease Expiration

| Phase | Duration | Behavior |
|---|---|---|
| **Active** | While balance > 0 | Full read/write access |
| **Low balance** | Balance < threshold | 402 returned on writes; reads still work; top-up required header included |
| **Grace period** | **30 days** after balance hits 0 | **Read-only access**. No writes. Top-up required to restore writes. |
| **Expired** | After grace period ends | **Permanent deletion**. Data is gone. No recovery. |

Notifications at each transition:
- Balance < 20% → metering header warning
- Balance = 0 → 402 on all writes, grace period starts
- Grace period 7 days remaining → (if webhook/email configured)
- Deletion → final

---

## D12. Product: Approval Flow

**Status: Nice to have (v1.1, not MVP).**

The MVP ships with **direct x402 pay-and-go**:
- Agent calls `POST /v1/tables:quote` (free)
- Agent calls `POST /v1/tables` → gets 402 → pays → retries with payment → table created

The approval flow (agent creates approval request → human approves via URL → agent polls) is deferred to v1.1. The quote endpoint still exists for agents to present cost estimates before proceeding.

---

## D13. Safety Limits (Moderate)

| Limit | Value | Enforcement |
|---|---|---|
| Max tables per wallet | 50 | Hard reject on create |
| Max requests/second per table | 1,000 | Rate limiter (429) |
| Max storage per table | 10 GB | Reject writes when exceeded |
| Max item size | 400 KB | Reject on put |
| Max query result size | 1 MB per page | Pagination required |
| Scan | Requires explicit `--run402-allow-scan` flag in CLI, rate-limited in API | Hard reject without flag |
| Max batch size | 25 items (DynamoDB parity) | Reject if exceeded |

---

## D14. Open Source Strategy

| Component | License | Rationale |
|---|---|---|
| CLI (`run402`) | Open source (MIT or Apache 2.0) | GTM: developers can inspect, trust, contribute |
| TypeScript SDK | Open source | Adoption: lower barrier to integration |
| Python SDK | Open source | Adoption: cover both major agent languages |
| API server | **Closed / proprietary** | Core business value |
| Infrastructure (CDK/TF) | **Closed / proprietary** | Operational advantage |
| Website | **Closed / proprietary** | Brand asset |

---

## D15. Community & Support

| Channel | Purpose |
|---|---|
| **GitHub Discussions** | Primary community channel, tied to open-source repos. Async, searchable. |
| **Email** (support@run402.com) | Direct support, enterprise inquiries, security disclosures. |

No Discord or Slack for v1. Keep it simple.

---

## D16. Legal

| Decision | Value |
|---|---|
| Entity type | US LLC or Corp |
| Terms structure | Standard SaaS terms |
| Payment classification | Payment for services (stablecoin as payment method) |
| Data handling | Standard DPA available for enterprise customers (roadmap) |

---

## D17. API Endpoints (Final, Post-Rename)

### Control plane

```
POST   /v1/tables:quote                    # Estimate costs (free)
POST   /v1/tables                           # Create table (x402 payment)
GET    /v1/tables                           # List tables (SIWX auth)
GET    /v1/tables/{table_id}                # Describe table
DELETE /v1/tables/{table_id}                # Delete table (SIWX auth)
PUT    /v1/tables/{table_id}/budget         # Update budget
GET    /v1/tables/{table_id}/budget         # Get budget
GET    /v1/usage                            # Usage summary
GET    /v1/receipts                         # Receipts ledger
GET    /v1/tables/{table_id}/logs           # Logs (audit/ops/errors)
```

### Data plane

```
PUT    /v1/tables/{table_id}/items/{pk}     # Put item
GET    /v1/tables/{table_id}/items/{pk}     # Get item
DELETE /v1/tables/{table_id}/items/{pk}     # Delete item
PATCH  /v1/tables/{table_id}/items/{pk}     # Update item (update-expression)
POST   /v1/tables/{table_id}:query          # Query by key
POST   /v1/tables/{table_id}:scan           # Scan (guarded)
POST   /v1/tables/{table_id}:batch-get      # Batch get
POST   /v1/tables/{table_id}:batch-write    # Batch write
```

### Discovery (machine-facing)

```
GET    /.well-known/x402                    # x402 discovery manifest
GET    /.well-known/mcp.json                # MCP server card
GET    /x402/discovery                      # Tool catalog + pricing
POST   /mcp                                 # MCP transport
GET    /openapi.json                        # OpenAPI spec
GET    /llms.txt                            # Agent-readable doc outline
GET    /meta.json                           # Machine-friendly endpoint map
GET    /health                              # Health check
```

All hosted at `app.run402.com`.

---

## D18. CLI (Final, Post-Rename)

The CLI command is `run402`. Service alias is `run402 db`.

### Examples (updated)

```bash
# Get item (DynamoDB drop-in)
run402 db get-item --table-name MyTable --key '{"id":{"S":"123"}}'

# Put item
run402 db put-item --table-name MyTable --item '{"id":{"S":"123"},"email":{"S":"a@b.com"}}'

# Query
run402 db query --table-name MyTable \
  --key-condition-expression "id = :v" \
  --expression-attribute-values '{":v":{"S":"123"}}'

# Create table with safety defaults
run402 db create-table \
  --table-name MyTable \
  --attribute-definitions AttributeName=id,AttributeType=S \
  --key-schema AttributeName=id,KeyType=HASH \
  --billing-mode PAY_PER_REQUEST \
  --run402-ttl 7d \
  --run402-max-spend-usd 3.00

# Configure
run402 configure
```

All platform-specific flags use the `--run402-*` prefix.

### Config file path

`~/.run402/config`

---

## D19. MCP Tools (Final)

```
agentdb.quote_table      # Estimate costs and propose caps
agentdb.create_table     # Provision a table after funding
agentdb.put              # Put an item
agentdb.get              # Get an item
agentdb.query            # Query by key
agentdb.delete           # Delete an item
agentdb.receipts         # Fetch receipts
agentdb.logs             # Fetch logs
```

---

## D20. Website Structure (Final)

### run402.com (marketing + docs)

```
/                           # Home (hero + how it works + features)
/product                    # Product overview (5 pillars)
/product/agentdb            # AgentDB (tables) feature page
/product/agents             # Agent integration page
/product/billing            # Lease + billing model page
/product/observability      # Receipts, logs, metering headers
/product/qos                # SLA tiers, status, rate limiting
/pricing                    # Tiers + unit pricing + calculator
/docs                       # Docs landing
/docs/quickstart/agents-mcp # Agent quickstart (MCP)
/docs/quickstart/agents-rest# Agent quickstart (REST)
/docs/quickstart/humans     # Human quickstart (console)
/docs/api                   # API reference (OpenAPI)
/docs/x402                  # How Run402 / AgentDB uses x402
/docs/security              # Security model
/docs/limits                # Limits & anti-abuse
/learn                      # x402 education section
/learn/what-is-x402
/learn/how-x402-works
/learn/x402-for-agents
/learn/vision
/learn/safety-and-trust
/learn/glossary
/learn/faq
/compare                    # Comparison vs Upstash, Turso, etc.
/security                   # Security page
/sla                        # SLA page
/support                    # Support contacts
/legal/terms
/legal/privacy
/legal/aup
```

### app.run402.com (API + console)

```
# Console (Next.js)
/                           # Connect wallet / resume session
/overview                   # Dashboard
/tables                     # Tables list
/tables/{table_id}          # Table detail (tabs: overview, usage, receipts, logs, access, settings)
/usage                      # Global usage
/receipts                   # Global receipts
/logs                       # Global logs
/budgets                    # Budget policies
/settings                   # Account settings

# API (same subdomain)
/v1/tables/...              # REST API
/.well-known/...            # Discovery endpoints
/mcp                        # MCP transport
/openapi.json               # OpenAPI spec
/llms.txt                   # Agent-readable outline
/meta.json                  # Machine metadata
/health                     # Health check
```

---

## D21. Summary of Deferred Decisions

| Topic | Status | When to revisit |
|---|---|---|
| **Tagline / positioning** | Brainstorm needed | Before website launch |
| **Unit pricing (actual numbers)** | Cost modeling needed | Before mainnet launch |
| **Approval flow** | Designed in spec, deferred to v1.1 | After MVP validates core flow |
| **Multi-region tier** | v2 | After single-region is stable |
| **Secondary indexes** | v2 | After core query patterns validated |
| **SLA specific targets** | TBD per tier | Before enterprise sales |
| **Self-hosted facilitator** | Planned | When Coinbase dependency becomes a concern |
| **Workspaces** | Not in v1 | When multi-table management becomes painful |
| **Webhook notifications** | Roadmap | When users request it |
| **Additional blockchain networks** | Roadmap | Based on user demand |

