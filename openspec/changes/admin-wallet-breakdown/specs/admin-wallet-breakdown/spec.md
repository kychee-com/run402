### Requirement: Finance tab exists as a sibling admin page

The `/admin` dashboard SHALL gain a new page at `/admin/finance` that is a sibling of `/admin/projects` and `/admin/subdomains`, gated by the existing Google OAuth session.

#### Scenario: Unauthenticated access redirects to login

- **WHEN** an unauthenticated client calls `GET /admin/finance`
- **THEN** the gateway SHALL respond with HTTP 302 and a `Location: /admin/login` header
- **AND** SHALL NOT expose any finance data in the response body

#### Scenario: Non-kychee email rejected

- **WHEN** an authenticated user whose Google email is not `@kychee.com` calls `GET /admin/finance`
- **THEN** the gateway SHALL reject the request with the same behavior as the existing admin pages (HTTP 403 or redirect to login with error)
- **AND** SHALL NOT expose any finance data

#### Scenario: Authenticated admin sees the page

- **WHEN** a `@kychee.com`-authenticated user calls `GET /admin/finance`
- **THEN** the gateway SHALL return HTTP 200 with an HTML page styled identically to existing admin pages (dark `#0A0A0F` background, `#12121A` cards, `#00FF9F` accent, system font stack)
- **AND** the page SHALL include the same top navigation as existing admin pages, with "Finance" as a highlighted nav item
- **AND** the navigation SHALL contain links to: Dashboard, Projects, Subdomains, Finance, llms.txt, user name, Logout (in that left-to-right order)

#### Scenario: Finance nav link present on all admin pages

- **WHEN** an authenticated admin visits any existing admin page (`/admin`, `/admin/projects`, `/admin/subdomains`, `/admin/llms-txt`, `/admin/project/:id`, `/admin/wallet/:address`)
- **THEN** the top navigation SHALL include a "Finance" link pointing to `/admin/finance`
- **AND** clicking the link SHALL navigate to the Finance tab

### Requirement: Time window selector

The Finance tab SHALL allow the operator to choose a reporting time window, and all sections below SHALL re-query on selection.

#### Scenario: Default window is 30 days

- **WHEN** an admin opens `/admin/finance` without a `window` query parameter
- **THEN** the page SHALL display data for the last 30 days (`NOW() - INTERVAL '30 days'` to `NOW()`)
- **AND** the 30d button SHALL be visually highlighted

#### Scenario: Switching time window

- **WHEN** the admin clicks one of `24h | 7d | 30d | 90d`
- **THEN** the page SHALL update the URL query parameter to `?window=<selected>`
- **AND** fetch `/admin/api/finance/summary?window=<selected>`, `/admin/api/finance/revenue?window=<selected>`, `/admin/api/finance/costs?window=<selected>` in parallel
- **AND** update the three sections (KPI cards, revenue breakdown table, cost breakdown table) without a full page reload
- **AND** the newly selected button SHALL become the highlighted one

#### Scenario: Invalid window parameter

- **WHEN** any `/admin/api/finance/*` endpoint receives a `window` parameter that is not `24h`, `7d`, `30d`, or `90d`
- **THEN** the endpoint SHALL return HTTP 400 with `{ "error": "invalid_window", "allowed": ["24h","7d","30d","90d"] }`

### Requirement: Platform KPI cards

The top of the Finance tab SHALL display three cards summarizing platform revenue, cost, and margin for the selected time window.

#### Scenario: KPI cards fetch and render

- **WHEN** the Finance tab loads or the time window changes
- **THEN** the frontend SHALL call `GET /admin/api/finance/summary?window=<window>`
- **AND** the endpoint SHALL return `{ window, revenue_usd_micros, cost_usd_micros, margin_usd_micros, cost_source: { directly_attributable_usd_micros, shared_infra_usd_micros, cache_age_seconds }, last_updated_at }`
- **AND** the frontend SHALL render three cards with USD values formatted with thousand separators and 2-decimal precision (e.g., `$12,345.67`)
- **AND** the margin card SHALL be styled with `#00FF9F` green color if `margin_usd_micros > 0`, or `#FF5050` red if `margin_usd_micros < 0`, or default gray if zero

#### Scenario: Revenue is the sum of all project revenue for the window

- **WHEN** the summary endpoint computes platform revenue
- **THEN** it SHALL sum all `billing_topups` rows where `created_at` is within the window, grouped by nothing (all topups)
- **AND** include all topup types (`cash`, `tier`, `email_pack`)
- **AND** include all ledger entries with positive `amount_usd_micros` where `created_at` is within the window (covers any revenue-equivalent events not captured as topups)

#### Scenario: Cost is the AWS Cost Explorer total for the window

- **WHEN** the summary endpoint computes platform cost
- **THEN** it SHALL query `internal.aws_cost_cache` for all rows where `day` is within the window
- **AND** sum `cost_usd_micros` across all services
- **AND** include a `cache_age_seconds` field indicating how stale the Cost Explorer data is (NOW() − latest `fetched_at`)

#### Scenario: Cost Explorer cache is empty or stale

- **WHEN** the summary endpoint is called and `internal.aws_cost_cache` has no rows for the requested window
- **THEN** the endpoint SHALL return `cost_usd_micros: null` and `cost_source: { shared_infra_usd_micros: null, cache_age_seconds: null, cache_status: "empty" }`
- **AND** the margin SHALL be reported as `null`
- **AND** the frontend SHALL display "—" in the cost and margin cards with a small "Cost Explorer cache empty — refresh below" hint
- **AND** SHALL NOT fall back to estimating cost from direct-attribution counters alone (that would overstate margin)

### Requirement: Revenue breakdown table (per project × stream)

The Finance tab SHALL display a table showing revenue per project, broken out by revenue stream.

#### Scenario: Revenue breakdown endpoint shape

- **WHEN** the frontend calls `GET /admin/api/finance/revenue?window=<window>`
- **THEN** the endpoint SHALL return `{ window, projects: [{ project_id, project_name, tier_fees_usd_micros, email_packs_usd_micros, kms_rental_usd_micros, kms_sign_fees_usd_micros, per_call_sku_usd_micros, total_usd_micros }], unattributed_usd_micros, total_usd_micros }`
- **AND** the `projects` array SHALL be sorted by `total_usd_micros` descending
- **AND** the top-level `total_usd_micros` SHALL equal the sum of all project rows plus `unattributed_usd_micros`
- **AND** the top-level `total_usd_micros` SHALL equal the `revenue_usd_micros` from the summary endpoint for the same window (exact reconciliation)

#### Scenario: Revenue stream columns are derived from existing data

- **WHEN** computing a project's revenue breakdown
- **THEN** `tier_fees_usd_micros` SHALL sum `billing_topups` rows for the project where `topup_type = 'tier'` and `created_at` is within the window
- **AND** `email_packs_usd_micros` SHALL sum `billing_topups` rows for the project where `topup_type = 'email_pack'`
- **AND** `kms_rental_usd_micros` SHALL sum `allowance_ledger` rows for the project where `kind = 'kms_wallet_rental'` (negating the sign — rental is negative in the ledger, revenue here is the absolute value)
- **AND** `kms_sign_fees_usd_micros` SHALL sum `allowance_ledger` rows where `kind = 'kms_sign_fee'` (same sign-flip)
- **AND** `per_call_sku_usd_micros` SHALL sum `allowance_ledger` rows where `kind IN ('image', ...)` (any per-SKU paid endpoints defined in `shared/tiers.ts SKU_PRICES`)

#### Scenario: Unattributed revenue bucket

- **WHEN** a topup exists whose `billing_account_id` does not resolve to any `projects` row (orphaned or pre-project topups)
- **THEN** its amount SHALL be added to the top-level `unattributed_usd_micros` field, not to any project row
- **AND** the frontend SHALL render a final row labelled "Unattributed" below the per-project rows if `unattributed_usd_micros > 0`

#### Scenario: Frontend renders table

- **WHEN** the frontend receives the revenue breakdown response
- **THEN** it SHALL render a table with columns: `Project | Tier Fees | Email Packs | KMS Rental | KMS Signs | Per-Call | Total`
- **AND** each cell SHALL display USD with thousand separators and 2-decimal precision, using tabular-num font variant
- **AND** the project column SHALL show project name + a shortened project ID (first 8 characters with ellipsis), each row clickable and linking to `/admin/project/:id`
- **AND** a footer row SHALL show the column totals matching the top-level total fields

### Requirement: Cost breakdown table (by AWS category)

The Finance tab SHALL display a table showing platform cost broken down by AWS service category.

#### Scenario: Cost breakdown endpoint shape

- **WHEN** the frontend calls `GET /admin/api/finance/costs?window=<window>`
- **THEN** the endpoint SHALL return `{ window, categories: [{ category, source, cost_usd_micros, percentage_of_total }], directly_attributable_total, shared_infra_total, total_usd_micros, reconciliation: { counter_derived_usd_micros, cost_explorer_usd_micros, drift_percentage, drift_warning } }`
- **AND** `categories` SHALL be sorted by `cost_usd_micros` descending
- **AND** each row's `source` field SHALL be either `"counter"` (directly attributable, computed from usage counters × cost_rates) or `"cost_explorer"` (shared infrastructure, read from aws_cost_cache)

#### Scenario: Directly attributable categories computed from counters

- **WHEN** computing the `"counter"`-sourced cost rows
- **THEN** the endpoint SHALL include categories: `"KMS wallet rental"`, `"KMS sign ops"`, `"Chain gas passthrough"`, `"SES email send"`, `"Lambda invocations"`, `"S3 storage"`
- **AND** `"KMS wallet rental"` SHALL be the sum of all `kms_wallet_rental` debits (at-cost, which is $1/key/month — stored as the `cost_rates.kms_key_monthly_usd_micros` value, pro-rated by days active in the window)
- **AND** `"KMS sign ops"` SHALL be `count(contract_calls where status IN ('confirmed','failed') and created_at in window) × cost_rates.kms_sign_usd_micros`
- **AND** `"Chain gas passthrough"` SHALL be the sum of all `contract_call_gas` ledger entries' absolute values within the window
- **AND** `"SES email send"` SHALL be `count(email_messages where sent_at in window) × cost_rates.ses_per_email_usd_micros`
- **AND** `"Lambda invocations"` SHALL be `count(function invocations in window) × cost_rates.lambda_request_usd_micros + avg_duration × avg_memory × cost_rates.lambda_gb_second_usd_micros` (approximation — exact breakdown only if we have those counters)
- **AND** `"S3 storage"` SHALL be `avg(storage_bytes across projects in window) × window_days × cost_rates.s3_gb_month_usd_micros / 30`

#### Scenario: Shared infrastructure categories from Cost Explorer cache

- **WHEN** computing the `"cost_explorer"`-sourced cost rows
- **THEN** the endpoint SHALL read from `internal.aws_cost_cache` for days in the window
- **AND** the categories SHALL include at minimum: `"RDS"`, `"ECS Fargate"`, `"ALB"`, `"CloudFront"`, `"Secrets Manager"`, `"CloudWatch"`, `"Other shared"` (catch-all)
- **AND** the categories SHALL be derived from the AWS Cost Explorer `SERVICE` dimension with run402's service-to-category mapping applied

#### Scenario: Reconciliation and drift detection

- **WHEN** computing the reconciliation section of the cost breakdown
- **THEN** `counter_derived_usd_micros` SHALL equal the sum of all `"counter"`-source categories (what our counters × pricing say the directly-attributable cost is)
- **AND** `cost_explorer_usd_micros` SHALL equal the KMS + chain-gas + SES + Lambda + S3 slice of `aws_cost_cache` (what AWS actually billed us for those same categories)
- **AND** `drift_percentage` SHALL be `abs(counter_derived - cost_explorer) / cost_explorer × 100`, computed only if both values are non-null
- **AND** `drift_warning` SHALL be `true` if `drift_percentage > 5` (counter values drifted more than 5% from AWS's actual bill — suggests stale pricing constants or miscounted usage)

#### Scenario: Drift warning displayed on the Finance tab

- **WHEN** the cost breakdown response has `drift_warning: true`
- **THEN** the frontend SHALL display a yellow warning banner above the cost table: "Counter-derived cost differs from AWS Cost Explorer by N% — pricing constants may be stale. Click 'Update pricing' below to refresh."
- **AND** the banner SHALL include a link to the `POST /admin/api/finance/refresh-pricing` action button

### Requirement: Per-project finance cards (augmenting existing project detail page)

The existing `/admin/project/:id` page SHALL be augmented with three new cards at the top showing per-project finance data, without removing or reordering any existing content.

#### Scenario: Per-project finance cards present on existing page

- **WHEN** an authenticated admin visits `/admin/project/:id` for any project
- **THEN** the existing page content (wallet info, project metadata, existing sections) SHALL remain unchanged and in its original order
- **AND** three new cards SHALL render at the top of the content area, above all existing sections
- **AND** the three cards SHALL be labelled `Project Revenue`, `Project Direct Cost`, `Project Direct Margin`
- **AND** each card SHALL bear the class `finance-revenue-card`, `finance-cost-card`, or `finance-margin-card` respectively (for ship-time smoke-check grepping)

#### Scenario: Per-project endpoint shape

- **WHEN** the frontend calls `GET /admin/api/finance/project/:id?window=<window>`
- **THEN** the endpoint SHALL return `{ project_id, project_name, window, revenue_usd_micros, direct_cost_usd_micros, direct_margin_usd_micros, revenue_breakdown: {...same columns as the platform table...}, direct_cost_breakdown: [{ category, cost_usd_micros }], notes }`
- **AND** `notes` SHALL be a string: "Direct costs only. Shared infrastructure overhead is not allocated to individual projects. See the Finance tab for platform totals."

#### Scenario: Per-project cards use the same time window as the Finance tab

- **WHEN** the `/admin/project/:id` page renders the finance cards
- **THEN** the cards SHALL default to the 30-day window
- **AND** SHALL expose the same `24h | 7d | 30d | 90d` buttons as the Finance tab, scoped to just these cards
- **AND** changing the window SHALL re-fetch only the per-project finance cards, not the rest of the page

#### Scenario: Wrong project ID

- **WHEN** `GET /admin/api/finance/project/:id` is called with an ID that does not exist in `internal.projects`
- **THEN** the endpoint SHALL return HTTP 404 with `{ "error": "project_not_found" }`
- **AND** the frontend SHALL render "Project not found" in the finance card area but still render the rest of the existing per-project page (graceful degradation)

### Requirement: CSV export

The Finance tab and per-project finance section SHALL support CSV export of the displayed data.

#### Scenario: Platform-scoped CSV export

- **WHEN** an admin clicks the "Export CSV" button on the Finance tab
- **THEN** the frontend SHALL call `GET /admin/api/finance/export?scope=platform&window=<window>&format=csv`
- **AND** the endpoint SHALL respond with `Content-Type: text/csv; charset=utf-8`
- **AND** `Content-Disposition: attachment; filename="run402-finance-platform-<window>-<timestamp>.csv"`
- **AND** the body SHALL contain three CSV sections separated by blank lines:
  - Section 1 — `Platform Summary`: headers `window,revenue_usd,cost_usd,margin_usd,cost_source,cache_age_hours` + one data row
  - Section 2 — `Revenue Breakdown by Project`: headers `project_id,project_name,tier_fees_usd,email_packs_usd,kms_rental_usd,kms_sign_fees_usd,per_call_sku_usd,total_usd` + one row per project + a `TOTAL` footer row
  - Section 3 — `Cost Breakdown by Category`: headers `category,source,cost_usd,percentage_of_total` + one row per category

#### Scenario: Project-scoped CSV export

- **WHEN** an admin clicks the "Export CSV" button on a per-project finance card
- **THEN** the frontend SHALL call `GET /admin/api/finance/export?scope=project&id=<project_id>&window=<window>&format=csv`
- **AND** the endpoint SHALL respond with `Content-Type: text/csv`
- **AND** filename SHALL be `run402-finance-project-<project_id>-<window>-<timestamp>.csv`
- **AND** the body SHALL contain two CSV sections:
  - Section 1 — `Project Summary`: `project_id,project_name,window,revenue_usd,direct_cost_usd,direct_margin_usd`
  - Section 2 — `Revenue Breakdown`: same columns as the platform version, one row
  - Section 3 — `Direct Cost Breakdown`: `category,cost_usd`

#### Scenario: CSV export with unsupported format

- **WHEN** `/admin/api/finance/export` is called with `format` other than `csv`
- **THEN** the endpoint SHALL return HTTP 400 with `{ "error": "unsupported_format", "supported": ["csv"] }`

### Requirement: Cost rates table (pricing constants)

The gateway SHALL maintain pricing constants in a DB table, seeded on first boot with hardcoded defaults, and updatable via an on-demand AWS Pricing API pull.

#### Scenario: Table created and seeded on first boot

- **WHEN** the gateway starts for the first time after this change is deployed
- **THEN** the v1.21 migration SHALL `CREATE TABLE IF NOT EXISTS internal.cost_rates`
- **AND** SHALL seed the table with the following keys if not already present (INSERT ... ON CONFLICT DO NOTHING):
  - `ses_per_email_usd_micros` = 100 (= $0.0001, from the run402 $0.10/1k rate)
  - `lambda_request_usd_micros` = 200 (= $0.0002, from $0.20/M)
  - `lambda_gb_second_usd_micros` = 17 (= $0.0000166667 rounded)
  - `s3_gb_month_usd_micros` = 23000 (= $0.023)
  - `kms_key_monthly_usd_micros` = 1000000 (= $1.00)
  - `kms_sign_per_op_usd_micros` = 3 (= $0.000003, from $0.03/10k)
- **AND** each seeded row SHALL have `source = 'seed'` and `updated_at = NOW()`

#### Scenario: Reading rates

- **WHEN** any finance computation needs a rate
- **THEN** it SHALL read from `internal.cost_rates` via a cached helper (`getCostRate(key)`) with a 5-minute in-process cache
- **AND** SHALL never hard-code rates in computation code

#### Scenario: Refresh pricing endpoint

- **WHEN** an admin clicks "Update pricing" on the Finance tab
- **THEN** the frontend SHALL call `POST /admin/api/finance/refresh-pricing`
- **AND** the endpoint SHALL call the AWS Pricing API for each service (SES, Lambda, S3, KMS) and update the corresponding `cost_rates` rows where the new value differs from the stored value
- **AND** SHALL set `source = 'aws-pricing-api'` and `updated_at = NOW()` on updated rows
- **AND** SHALL return `{ updated: [ { key, old_value, new_value } ], unchanged: [ keys ], errors: [] }`
- **AND** the in-process cache SHALL be invalidated

#### Scenario: Retroactive re-attribution is NOT performed

- **WHEN** an operator updates pricing via the refresh endpoint
- **THEN** historical ledger entries SHALL NOT be recomputed
- **AND** historical cost rows in `aws_cost_cache` SHALL NOT be touched
- **AND** the new rates SHALL apply ONLY to cost breakdown computations run after the update (the next time `/admin/api/finance/costs` is called)
- **NOTE:** This is why the reconciliation section exists — historical drift between counter-derived and Cost Explorer is visible, but we don't retroactively "fix" it.

### Requirement: AWS Cost Explorer cache and daily background fetcher

The gateway SHALL maintain a local cache of AWS Cost Explorer responses, refreshed daily by a background job and on demand via an admin action.

#### Scenario: Cache table schema

- **WHEN** the v1.21 migration runs
- **THEN** `CREATE TABLE IF NOT EXISTS internal.aws_cost_cache (day DATE NOT NULL, service_category TEXT NOT NULL, cost_usd_micros BIGINT NOT NULL, fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY (day, service_category))` SHALL execute

#### Scenario: Daily background fetch

- **WHEN** the background-task scheduler runs its tick
- **AND** the latest `fetched_at` in `internal.aws_cost_cache` is older than 24 hours (or the table is empty)
- **THEN** the gateway SHALL call `ce:GetCostAndUsage` for the previous complete UTC day and for the current partial day, grouped by the `SERVICE` dimension
- **AND** upsert one row per (day, service_category) using the run402 service-to-category mapping
- **AND** set `fetched_at = NOW()` on all upserted rows

#### Scenario: Manual refresh endpoint

- **WHEN** an admin clicks "Refresh now" next to the Cost Explorer cache age label
- **THEN** the frontend SHALL call `POST /admin/api/finance/refresh-costs`
- **AND** the endpoint SHALL invoke the same Cost Explorer fetch logic immediately (bypassing the 24-hour guard)
- **AND** SHALL return `{ refreshed_at, rows_upserted, cost_explorer_call_count }`
- **AND** SHALL NOT run more than once per minute (rate-limited — return HTTP 429 if called twice within 60 seconds)

#### Scenario: Cost Explorer API failure

- **WHEN** the daily fetcher or manual refresh fails (e.g., AWS returns 5xx, rate-limit, access denied)
- **THEN** the gateway SHALL log the error with full AWS response
- **AND** SHALL NOT delete or modify any existing `aws_cost_cache` rows
- **AND** the manual refresh endpoint SHALL return HTTP 502 with `{ "error": "cost_explorer_unavailable", "aws_error": <message> }`
- **AND** the Finance tab SHALL continue to display stale data with the correct `cache_age_seconds`

#### Scenario: Service-to-category mapping

- **WHEN** the Cost Explorer fetcher maps AWS service names to run402 categories
- **THEN** it SHALL apply the following mapping (hardcoded initially, with a catch-all):
  - `Amazon Relational Database Service` → `"RDS"`
  - `Amazon Elastic Container Service` → `"ECS Fargate"`
  - `Amazon Elastic Load Balancing` → `"ALB"`
  - `Amazon CloudFront` → `"CloudFront"`
  - `AWS Secrets Manager` → `"Secrets Manager"`
  - `AmazonCloudWatch` → `"CloudWatch"`
  - `AWS Key Management Service` → `"KMS (Cost Explorer)"` (distinct from the counter-derived KMS wallet rental)
  - `Amazon Simple Email Service` → `"SES (Cost Explorer)"` (distinct from counter-derived SES)
  - `AWS Lambda` → `"Lambda (Cost Explorer)"`
  - `Amazon Simple Storage Service` → `"S3 (Cost Explorer)"`
  - Any service not in this list → `"Other shared"`
- **NOTE:** The (Cost Explorer) variants exist alongside the counter-derived categories — they're both shown in the cost breakdown table, so operators can see counter-derived KMS vs AWS-billed KMS side by side and spot drift.

### Requirement: IAM permissions

The gateway task role SHALL gain read-only access to AWS Cost Explorer and AWS Pricing APIs.

#### Scenario: CDK adds Cost Explorer permission

- **WHEN** the CDK `infra/lib/pod-stack.ts` is deployed after this change
- **THEN** the gateway task role SHALL have an allow statement for `ce:GetCostAndUsage` (account-level, no resource ARN, since Cost Explorer is billing-account-scoped)

#### Scenario: CDK adds Pricing API permission

- **WHEN** the CDK is deployed
- **THEN** the gateway task role SHALL have an allow statement for `pricing:GetProducts` (account-level, no resource ARN)

#### Scenario: No write or delete permissions granted

- **WHEN** verifying the deployed task role
- **THEN** it SHALL NOT have `ce:*` wildcard permissions (only `ce:GetCostAndUsage`)
- **AND** SHALL NOT have any `budgets:*`, `aws-portal:*`, or billing-write permissions
- **AND** a principal-policy simulation for `ce:UpdateCostCategoryDefinition` against the task role SHALL return `implicitDeny`

### Requirement: Existing admin pages unchanged

This change SHALL NOT modify or remove any existing content on the `/admin`, `/admin/projects`, `/admin/subdomains`, `/admin/wallet/:address`, or `/admin/llms-txt` pages beyond adding a single "Finance" link to the top navigation.

#### Scenario: Dashboard content unchanged

- **WHEN** an admin visits `/admin` after this change is deployed
- **THEN** the existing Projects, Usage, Infrastructure, Billing, and Faucet sections SHALL render identically to before
- **AND** the only visible change SHALL be the addition of "Finance" to the top navigation

#### Scenario: Projects and Subdomains tables unchanged

- **WHEN** an admin visits `/admin/projects` or `/admin/subdomains`
- **THEN** the table columns, sort order, row count indicator, and delete actions SHALL be unchanged
- **AND** the only visible change SHALL be the "Finance" nav link

#### Scenario: Per-project page augmentation is additive only

- **WHEN** an admin visits `/admin/project/:id`
- **THEN** all existing content (wallet metadata, project info, etc.) SHALL remain in its original position
- **AND** the 3 finance cards SHALL be inserted at the top, above everything else
- **AND** no existing section SHALL be removed, reordered, or re-styled

### Requirement: Documentation surfaces (internal only)

This change's documentation SHALL appear in run402's internal operator surfaces (AGENTS.md, CLAUDE.md) but NOT in public-facing docs (llms.txt, billing page, site).

#### Scenario: AGENTS.md updated

- **WHEN** a future agent reads `AGENTS.md` in the run402 repo
- **THEN** the admin tools section SHALL list `/admin/finance` with a one-line description and the 7 new API endpoints
- **AND** the entry SHALL note that the page is gated by `@kychee.com` Google OAuth

#### Scenario: CLAUDE.md updated

- **WHEN** a future agent reads `CLAUDE.md` in the run402 repo
- **THEN** a new section titled "Admin Finance dashboard" SHALL exist with operational notes covering:
  - How the daily Cost Explorer cache refresh works and how to manually refresh
  - How to update pricing constants via the refresh-pricing action
  - How to investigate counter-vs-Cost-Explorer drift warnings
  - What to do if Cost Explorer is unavailable (the page gracefully degrades, cost card shows "—")
  - How to add a new cost category to the service-to-category mapping
  - How to add a new revenue stream column to the breakdown table

#### Scenario: Public docs NOT updated

- **WHEN** the implementer searches `site/llms.txt`, `site/llms-cli.txt`, `site/llms-full.txt`, `site/openapi.json`, `site/billing/index.html`, `site/updates.txt`, and `site/humans/changelog.html`
- **THEN** NONE of these files SHALL be modified by this change
- **AND** NO reference to `/admin/finance` or the new admin API endpoints SHALL exist in any public-facing document
- **RATIONALE:** This is internal operator tooling. Exposing it in public docs would confuse external readers with capabilities they cannot use. Unlike `kms-wallet-contracts`, no user-facing pricing changes, so the "if a price is mentioned, all prices are mentioned" rule does not apply.

### Requirement: Backward compatibility

This change SHALL NOT modify or break any existing run402 behavior.

#### Scenario: All existing admin routes unchanged

- **WHEN** the change is deployed
- **THEN** `GET /admin`, `GET /admin/projects`, `GET /admin/subdomains`, `GET /admin/login`, `GET /admin/oauth/google`, `GET /admin/oauth/google/callback`, `GET /admin/logout`, `GET /admin/api/stats`, `GET /admin/api/admin-wallets`, `POST /admin/api/admin-wallets`, `DELETE /admin/api/admin-wallets/:address`, `GET /admin/api/wallet/:address`, `GET /admin/project/:id`, `GET /admin/wallet/:address`, `GET /admin/llms-txt` SHALL continue to behave identically to their pre-change behavior

#### Scenario: All existing test suites pass unchanged

- **WHEN** the implementer runs `npm run test:unit`, `npm run test:e2e`, `npm run test:bld402-compat`, `npm run test:billing`, `npm run test:email`, `npm run test:functions`, `npm run test:openclaw`, `npm run test:admin-sql`, `npm run test:contact`
- **THEN** every test suite SHALL pass without modification to test code

#### Scenario: No schema changes to existing tables

- **WHEN** verifying the v1.21 migration
- **THEN** the migration SHALL ONLY create new tables (`cost_rates`, `aws_cost_cache`)
- **AND** SHALL NOT `ALTER TABLE` any existing table
- **AND** SHALL NOT add, modify, or remove any index on existing tables
