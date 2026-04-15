## Why

Run402's `/admin` dashboard today shows operational metrics — project counts, API calls, storage, subdomain counts, faucet balance — but has **zero financial visibility**. An operator cannot answer questions like:

- "How much revenue did run402 generate in the last 30 days, broken down by product?"
- "What's kysigned's project margin this month — is it profitable for us to host?"
- "Which projects are the biggest cost centers vs the biggest revenue sources?"
- "What's our actual AWS bill this month vs the sum of all our cost counters?"

The data to answer these exists today (scattered across `billing_topups`, `allowance_ledger`, `contract_calls`, `email_messages`, function invocation counters, etc.) but there is no view that rolls it up. And the AWS-side cost — the real bill — is only visible in the AWS Console, not alongside our revenue data.

This is the last of the 6 kysigned-driven run402 platform features (kysigned plan line 92): *"Admin dashboard (/admin) — wallet activity breakdown by product (inflows: USDC revenue labelled 'kysigned' / 'run402 infra' / etc., derived from which API endpoint accepted payment; outflows: ETH gas labelled by which contract was called) + Stripe revenue tracking per product via Stripe metadata"*. It does not block kysigned launch — it's reporting, not a runtime dependency — but it's the finance-visibility layer we turn on once revenue-generating features are live.

**Scope is strictly internal operator tooling.** This feature is gated behind the existing `/admin` Google OAuth (`@kychee.com` only), has no public surface, no end-user visibility, no MCP/CLI exposure, and no external API. It augments the existing admin dashboard; it does not replace anything on it.

## What Changes

- **New admin tab `/admin/finance`**: A sibling of the existing `/admin/projects` and `/admin/subdomains` pages, styled identically (dark `#0A0A0F` background, `#12121A` cards, neon green `#00FF9F` accent, existing chart-wrap and table components). Added to the top nav as "Finance".
- **Time window selector**: Buttons `24h | 7d | 30d (default) | 90d` at the top of the page. All sections below re-query on selection.
- **Top KPI cards (3-card row)**: Platform revenue, platform cost, platform margin (green if positive, red if negative) for the selected window.
- **Revenue breakdown table — by project × stream**: Rows = projects (name + ID), sorted by total descending. Columns = `Tier fees | Email packs | KMS rental | KMS sign fees | Per-call SKU | Total`. All values in USD with tabular-num font.
- **Cost breakdown table — by AWS category**: Rows = categories (KMS rental, KMS sign ops, SES, Lambda, S3, RDS, CloudFront+ALB, ECS Fargate, chain gas pass-through). Columns = `Category | Window cost | % of total`. Categorized into "directly attributable" (computed from usage counters × pricing constants) vs "shared infrastructure" (pulled from AWS Cost Explorer).
- **Per-project drill-down**: Clicking a project row in the revenue breakdown table navigates to the existing `/admin/project/:id` page, which is **augmented** (not replaced) with three new finance cards at the top: project revenue, project direct cost, project direct margin. All existing per-project content stays where it is.
- **`internal.cost_rates` table**: New DB table storing AWS rate constants (SES $/1k emails, Lambda $/M requests, S3 $/GB-month, KMS $/month per key, KMS $/10k signs). Seeded from hardcoded defaults on first boot; updatable via a new endpoint backed by the AWS Pricing API.
- **`internal.aws_cost_cache` table**: New DB table storing daily AWS Cost Explorer pulls (one row per day per service category). Refreshed by a background job once per 24 hours; also manually refreshable from a button on the Finance tab.
- **New admin-only API endpoints** (all under existing OAuth gate):
  - `GET /admin/api/finance/summary?window=24h|7d|30d|90d` — top KPI cards + platform totals
  - `GET /admin/api/finance/revenue?window=...` — revenue breakdown table data
  - `GET /admin/api/finance/costs?window=...` — cost breakdown table data
  - `GET /admin/api/finance/project/:id?window=...` — per-project finance card data (for the existing `/admin/project/:id` page augmentation)
  - `GET /admin/api/finance/export?scope=platform|project&id=...&window=...&format=csv` — CSV export
  - `POST /admin/api/finance/refresh-costs` — triggers AWS Cost Explorer pull on demand
  - `POST /admin/api/finance/refresh-pricing` — triggers AWS Pricing API pull to update `cost_rates` table
- **CSV export**: Both the Finance tab (exports full breakdown for selected window) and the per-project card (exports that project's breakdown) get "Export CSV" buttons. JSON skipped — the JSON API endpoints are already there for anyone who wants machine-readable output.
- **Daily background job**: New `awsCostFetcher` job, runs once per 24 hours as part of the existing background-task scheduler (alongside the contract-call reconciler). Pulls from `ce:GetCostAndUsage` for the previous complete day + current running total, stores in `aws_cost_cache`.
- **Gateway IAM additions**: `ce:GetCostAndUsage` (Cost Explorer read) and `pricing:GetProducts` (AWS Pricing API read). No write permissions, no per-resource risk — these are purely read-only billing-data APIs.
- **Docs**: `AGENTS.md` gains a `/admin/finance` entry in the admin tools table. `CLAUDE.md` gains a new "Admin Finance dashboard" operational notes section (how the Cost Explorer cache refreshes, how to rotate pricing constants, how to investigate counter-vs-Cost-Explorer drift).
- **BREAKING**: None. No existing routes, tables, or behavior change. The existing `/admin`, `/admin/projects`, `/admin/subdomains`, `/admin/project/:id`, and `/admin/wallet/:address` pages continue to behave exactly as before.

## Non-goals

- **Public or end-user-facing analytics**: This is purely internal. No customer-facing billing statements, no "your usage this month" emails, no end-user dashboards.
- **MCP / CLI / OpenClaw exposure**: Unlike every other run402 feature, finance data is NOT exposed via MCP tools or CLI commands. It lives only behind the admin OAuth. Adding machine access later is a small addition; we keep the MVP surface tight.
- **Email / Slack reports**: Operators visit the page manually. No scheduled digests, no alerting, no "margin dropped below X" notifications. Adding notifications later is a follow-up.
- **Historical backfill**: The feature reports on data that already exists in the ledger tables at ship time. Data older than the ledger (e.g., pre-Feature-#3 topups with no `topup_type`) may be labelled "unknown" or grouped into a catch-all bucket. We do not backfill or reprocess historical data.
- **Forecasting / projections / cash runway**: The dashboard reports on the past and present. It does not project forward, estimate future revenue, or compute how long the treasury lasts at current burn. Those are separate features if we want them.
- **Multi-currency**: Everything is USD (via USD-micros internally). No EUR, no BTC-denominated reporting, no multi-currency conversion.
- **Budget alerts / threshold notifications**: No "alert me if cost exceeds $X". Out of scope.
- **Per-customer invoicing / billing statements**: run402 customers don't receive invoices — they pay via wallet (x402) or Stripe and get a receipt from the payment processor. This feature does not generate invoices or statements.
- **Tax reporting / accounting export**: No QuickBooks, Xero, or accounting-package integration. CSV export is raw, not formatted for any specific accounting tool.
- **Cost allocation of shared infrastructure to individual projects**: RDS, ECS Fargate, ALB, CloudFront, Secrets Manager, and CloudWatch are shared infrastructure. They stay aggregated at the platform level and are NOT pro-rated to individual projects. Per-project cost is "direct cost" only (KMS, chain gas, SES, Lambda, S3). The difference between `sum(project direct costs)` and `Cost Explorer total` is the shared-infrastructure bucket, shown once at the platform level.
- **Retroactive re-attribution when pricing constants change**: When an operator clicks "Update pricing" and AWS rates change, the new rates apply going forward only. Historical ledger entries are immutable — we do not recompute old cost rows with new rates.

## Capabilities

### New Capabilities

- **`finance-summary`**: Platform-level KPI computation — total revenue, total cost (from Cost Explorer), total margin, for a given time window (24h/7d/30d/90d).
- **`finance-revenue-breakdown`**: Per-project revenue table — one row per project, columns per revenue stream (tier fees, email packs, KMS rental, KMS sign fees, per-call SKUs). Sums are exact, sourced from the existing `billing_topups` and `allowance_ledger` tables.
- **`finance-cost-breakdown`**: Per-category cost table — rows per cost category, with each categorized as "directly attributable" (computed from our usage counters × `cost_rates`) or "shared infrastructure" (read from `aws_cost_cache` populated by Cost Explorer).
- **`finance-project-scoped`**: Per-project finance view — same KPI cards (revenue, direct cost, direct margin) scoped to a single project, rendered as an augmentation to the existing `/admin/project/:id` page without displacing any current content.
- **`finance-csv-export`**: Raw CSV export of any table shown in the UI, for both platform-scoped and project-scoped views, parameterized by time window.
- **`aws-cost-cache`**: Daily-refreshed local cache of AWS Cost Explorer responses, with a manual on-demand refresh button and an age indicator (`last refreshed: N hours ago`).
- **`cost-rates-table`**: DB-backed pricing constants (SES, Lambda, S3, KMS flat, KMS sign) updatable via an "Update pricing" button that pulls fresh values from the AWS Pricing API. Historical ledger entries are not re-rated when the table updates.

### Modified Capabilities

- **`admin-dashboard-nav`**: Top navigation gains a "Finance" link, positioned between "Subdomains" and "llms.txt" on every admin page. No other nav item changes.
- **`admin-project-detail`**: The existing `/admin/project/:id` page gains three new finance cards at the top (revenue, direct cost, direct margin for the currently selected time window). No existing sections are removed, reordered, or restyled.

## Shipping Surfaces

| Name | Type | Reach | Smoke check |
|------|------|-------|-------------|
| **Admin Finance page** | service | `https://api.run402.com/admin/finance` (auth-gated) | `curl -fsSL -o /dev/null -w "%{http_code}\n" https://api.run402.com/admin/finance` returns `302` (redirect to `/admin/login` — route exists, auth required) — and with a valid admin cookie, `curl -fsSL https://api.run402.com/admin/api/finance/summary?window=30d -H "Cookie: admin_session=..." \| jq -e '.revenue_usd_micros, .cost_usd_micros, .margin_usd_micros'` exits 0 (all three fields present) |
| **Per-project finance cards (augmenting existing page)** | service | `https://api.run402.com/admin/project/:id` (auth-gated, existing page) | With a valid admin cookie, `curl -fsSL https://api.run402.com/admin/project/<known-project-id> -H "Cookie: admin_session=..." \| grep -F 'finance-revenue-card'` exits 0 — proves the augmentation is live on the existing per-project page and did not regress the original content |
| **AGENTS.md admin tools reference** | other | `AGENTS.md` in the run402 repo | `grep -F "/admin/finance" AGENTS.md` exits 0 — proves the new admin page is documented for future agents who read AGENTS.md |
| **CLAUDE.md operations section** | other | `CLAUDE.md` in the run402 repo | `grep -F "Admin Finance dashboard" CLAUDE.md` exits 0 — proves the operational notes exist (Cost Explorer cache refresh, pricing rotation, drift investigation) |

All 4 surfaces are internal — there is no public marketing, docs, or end-user surface. No `llms.txt`/`llms-cli.txt`/`billing page`/`updates.txt`/`changelog` entries because the feature is invisible to end users and adding it to public surfaces would confuse external readers with internal-only capabilities. This is an intentional departure from the "if a price is mentioned, all prices are mentioned" rule that applied to `kms-wallet-contracts` — because no *price* changes here, only reporting over existing prices.

## Impact

- **Gateway** (`packages/gateway/src/`):
  - New `services/finance-rollup.ts` — pure rollup SQL for revenue + direct cost by project and platform, parameterized by time window. No writes.
  - New `services/aws-cost-fetcher.ts` — daily Cost Explorer pull + cache update, plus on-demand refresh.
  - New `services/aws-pricing-fetcher.ts` — `cost_rates` table refresh from AWS Pricing API.
  - New `services/cost-rates.ts` — read + seed helpers for the `cost_rates` table.
  - New `routes/admin-finance.ts` — 7 new endpoints under `/admin/api/finance/*`, plus 2 HTML routes (`GET /admin/finance` and augmentation of `GET /admin/project/:id`).
  - Modified `routes/admin-dashboard.ts` — add "Finance" nav link to the 2 existing `adminTablePage` and `dashboardPage` HTML templates. Single-line addition.
  - Modified `routes/admin-wallet.ts` (which owns `/admin/project/:id`) — render the 3 new finance cards at the top of the existing per-project HTML. Augmentation only, no removal.
- **Database** (migration `v1.21` in `server.ts`):
  - `CREATE TABLE internal.cost_rates (key TEXT PRIMARY KEY, value_usd_micros BIGINT NOT NULL, unit TEXT NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), source TEXT NOT NULL DEFAULT 'seed')` — seeded on first boot with SES, Lambda, S3, KMS flat, KMS sign, RDS (approximate), ALB/CloudFront (approximate).
  - `CREATE TABLE internal.aws_cost_cache (day DATE NOT NULL, service_category TEXT NOT NULL, cost_usd_micros BIGINT NOT NULL, fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY (day, service_category))` — one row per (day, category).
- **AWS / IAM** (CDK `infra/lib/pod-stack.ts`):
  - Gateway task role gains `ce:GetCostAndUsage` (Cost Explorer read) — no per-resource ARN, this is an account-level billing API.
  - Gateway task role gains `pricing:GetProducts` — pricing API is public-data but still requires the action.
  - No new secrets, no new env vars.
- **Background jobs**:
  - Daily `awsCostFetcher` — runs once per 24 hours via the existing reconciler tick (idempotent guard: `last_fetched_on`). Same pattern as the daily rent debit job from `kms-wallet-contracts`.
- **Tests**:
  - Unit tests for rollup SQL with seeded ledger/call data (mock `billing_topups`, `contract_calls`, etc., run the rollup, assert the totals).
  - Unit tests for `aws-cost-fetcher.ts` with mocked AWS SDK client.
  - Unit tests for `cost-rates.ts` seed/update flow.
  - Unit tests for the 7 new admin routes with mocked services + mocked OAuth session.
  - Unit tests for CSV serialization (correct headers, correct row shape, correct totals).
  - E2E test: authenticate as admin, open `/admin/finance`, verify all 5 sections render, click a project, verify per-project card shows up.
  - Backward-compat gate: the existing `/admin`, `/admin/projects`, `/admin/subdomains`, `/admin/project/:id`, `/admin/wallet/:address` pages continue to render identically.
- **Docs**:
  - `AGENTS.md` — new entry in the admin tools section listing `/admin/finance` and its 7 API endpoints.
  - `CLAUDE.md` — new section "Admin Finance dashboard" with: how the Cost Explorer cache refreshes, how to manually refresh, how to update pricing constants, how to investigate counter-vs-Cost-Explorer drift, what to do if Cost Explorer is unavailable.
- **Cost of this feature to run402 itself**:
  - AWS Cost Explorer API: **$0.01 per request**. Daily background pull + occasional manual refresh ≈ 40 requests/month = **$0.40/month**.
  - AWS Pricing API: free.
  - Negligible compute — the rollup queries are over indexed columns on existing tables.
- **Margin visibility this unlocks**:
  - Platform total revenue vs platform total AWS bill — the real margin number, on one page, for the first time.
  - Per-project direct margin — is kysigned profitable? Is any specific project a cost sink? Visible in one click.
  - Pricing rate drift detection — if AWS raises a rate and we don't update `cost_rates`, the counter-derived direct cost diverges from Cost Explorer, and the platform reconciliation line flags it.
