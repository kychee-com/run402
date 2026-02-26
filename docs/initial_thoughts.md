> **SUPERSEDED** — Early brainstorm for the DynamoDB approach. See `supa_spec.md` for the current Postgres/PostgREST spec.

Below is a concrete design for a “no-account” cloud NoSQL service backed by DynamoDB, using **x402** as the payment and (optionally) lightweight identity rail—so an agent can spin up a database after a human approves an estimated spend, without anyone opening an AWS account.

---

## What you’re building

A SaaS-style wrapper called **AgentDB** (the initial product from **Run402**) that exposes an HTTP API (and an agent-friendly client/tooling layer) with:

* **Control plane**: create/delete tables, set TTL/retention, set budgets, fetch usage & logs
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
* `POST /v1/tables/{table_id}:batch-get` (batch get items)
* `POST /v1/tables/{table_id}:batch-write` (batch put/delete items)

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

  * Batch get (multi-item, single table)
  * Batch write (put/delete, single table)
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

### Storage strategy

To give stronger QoS isolation (and simpler per-table billing), start with:

* **Shared multi-tenant DynamoDB table** (`agentdb-data-001`) in your AWS account, on-demand mode
* PK: `{tableId}#{userPK}`, SK: `{userSK}` — logical table isolation enforced at app layer
* GSI on `_tid` (logical table ID) for scan operations
* Separate internal metadata table for ledger, table records, capability tokens

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

If you want, I can also draft:

* a concrete OpenAPI spec for the endpoints above,
* the metering schema (how you compute units deterministically for each operation),
* and a reference “AgentDB Broker” MCP tool interface tailored to Claude Code’s workflow (quote → approval → create → use → top-up).

[1]: https://docs.x402.org/ "Welcome to x402 - x402"
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
