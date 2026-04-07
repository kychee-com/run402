## Context

Run402's `/admin` dashboard has been stats-only since inception: project counts, API call totals, storage totals, faucet balance. No finance view exists — operators cannot see what run402 is earning, what it's spending on AWS, or what any given project's margin looks like. The data is there (scattered across `billing_topups`, `allowance_ledger`, `contract_calls`, `email_messages`, function invocation counters) but there is no rollup surface.

This feature is the last of the 6 kysigned-driven run402 platform enhancements (kysigned plan line 92). It does not block kysigned launch — it's reporting, not a runtime dependency. It lands after `email-billing-accounts` and `kms-wallet-contracts` have produced enough of the new ledger kinds (`kms_wallet_rental`, `kms_sign_fee`, `contract_call_gas`, `email_pack_purchase`) for the breakdown tables to have meaningful data.

Strict scope: **internal operator tooling only.** Lives behind the existing `@kychee.com` Google OAuth on `/admin`. No MCP, no CLI, no public API, no end-user visibility, no public docs. The feature augments the existing admin dashboard without removing anything on it.

## Goals

- Platform-level revenue + cost + margin visible on one page for any of 4 time windows
- Per-project revenue broken out by stream (tier fees, email packs, KMS rental, KMS sign fees, per-call SKUs)
- Per-project **direct** cost (KMS rental, KMS signs, chain gas, SES, Lambda, S3) — computed from usage counters × `cost_rates`
- Per-project **direct** margin, visible both on the Finance tab (one row per project) and on the existing `/admin/project/:id` page (augmentation)
- Real AWS bill (from Cost Explorer) alongside counter-derived costs, with drift detection
- Updatable pricing constants without a redeploy (DB table + "Update pricing" button)
- Full backward compatibility — no existing admin content, route, or behavior changes
- CSV export for off-dashboard analysis
- Documentation surfaces (AGENTS.md, CLAUDE.md) so future agents know the feature exists

## Non-Goals

- Public or end-user-facing analytics (no customer dashboards, no billing statements)
- MCP / CLI / OpenClaw exposure (internal only)
- Email or Slack reports / scheduled digests / alerting
- Historical backfill of pre-ship ledger data
- Forecasting, projections, runway calculations
- Multi-currency (USD-only)
- Budget alerts or threshold notifications
- Per-customer invoicing or accounting-package export (QuickBooks, Xero)
- Shared-infrastructure allocation to individual projects (RDS, Fargate, ALB stay at platform level)
- Retroactive re-attribution when pricing constants change (new rates apply going forward only)

## Decisions

### DD-1: Rollup queries live, only Cost Explorer cached

**Decision:** Revenue and cost rollups by project are computed **live** on every page load from the existing ledger/counter tables. No precomputation, no materialized views, no daily-rollup jobs. The only cached data is the AWS Cost Explorer response (in a new `internal.aws_cost_cache` table, refreshed daily).

**Alternatives considered:**
- *Daily rollup table (`internal.finance_daily_rollups`)*: Materialize one row per (day, project, category) from a nightly job. Faster page loads but adds a whole rollup pipeline, needs backfill logic, needs reconciliation when ledger entries are corrected. Overkill for a dashboard that ~5 people will use a few times a day.
- *In-process 5-minute cache on the Node server*: Simple but invalidation is annoying (a top-up happens mid-window and the cache shows stale data). Since the queries are indexed and sub-second, caching adds complexity for no real benefit.

**Rationale:** The ledger tables already have `(project_id)` and `(created_at)` indexes. A 30-day window rollup across all projects is one `GROUP BY project_id` query that returns in <200ms on the current dataset size (<1000 projects, <100k topups). Live queries keep the implementation trivial and the data always-fresh. If the dataset grows 100× we can add caching then.

**Risks:** At very large scale (millions of topups, thousands of projects) the queries could become slow. *Mitigation:* we monitor query time via the existing gateway metrics and add caching if p95 exceeds 1 second.

**Rollback:** N/A — live queries don't persist anything new.

### DD-2: Pricing constants in a DB table, not a TypeScript const

**Decision:** AWS pricing rates (SES, Lambda, S3, KMS flat, KMS sign) are stored in a new `internal.cost_rates` table. Seeded with hardcoded defaults on first boot. Updatable via a new endpoint (`POST /admin/api/finance/refresh-pricing`) backed by the AWS Pricing API. The UI exposes this as an "Update pricing" button on the Finance tab.

**Alternatives considered:**
- *TypeScript `const` in `shared/cost-rates.ts`*: Simpler, but every AWS price change requires a PR + deploy. User explicitly rejected this in conversation ("I want an update pricing button").
- *Daily background pull from AWS Pricing API*: Automatic but the API is slow and the prices almost never change. Manual trigger is friendlier.
- *Config file in Secrets Manager*: Adds a secret-rotation concern for data that isn't secret.

**Rationale:** A DB table supports the "click a button to update" UX, preserves audit (each row has `updated_at` and `source`), and allows per-rate manual override if AWS Pricing API is wrong for some reason. Seeding on boot means fresh DBs work out of the box.

**Risks:** Operator forgets to click "Update pricing" for months; rates drift; counter-derived cost disagrees with AWS bill. *Mitigation:* DD-7 drift detection — a yellow warning banner appears when counter vs Cost Explorer drifts >5%.

**Rollback:** Drop the `cost_rates` table and revert to hardcoded const. Low-risk change.

### DD-3: Counter-derived cost AND Cost Explorer cost shown side by side

**Decision:** The cost breakdown table shows both categories side by side:
- **Counter-derived** rows (KMS wallet rental, KMS sign ops, chain gas, SES, Lambda, S3) are computed from usage counters × `cost_rates`. These are exact at the project level and support per-project margin.
- **Cost Explorer** rows (RDS, ECS Fargate, ALB, CloudFront, Secrets Manager, CloudWatch, plus "Cost Explorer"-suffixed variants of KMS/SES/Lambda/S3) are read from `aws_cost_cache`. These are the real AWS bill but only available at the platform level.

The "(Cost Explorer)" variants of categories we also compute from counters enable side-by-side comparison — a KMS row from counters vs a KMS row from AWS-billed, both in the same table. The reconciliation section at the bottom computes `drift_percentage` between the two.

**Alternatives considered:**
- *Cost Explorer only*: Loses per-project attribution. Can't compute project margin.
- *Counters only*: Misses shared infrastructure (RDS, Fargate, etc.). Can't show real AWS bill.
- *Blend into one column*: Hides the drift. Operators lose ability to spot stale pricing or miscounted usage.

**Rationale:** The two sources answer different questions. Counter-derived answers "what should this cost per project?" Cost Explorer answers "what does AWS actually bill us?" Seeing both makes drift obvious. This is a 10x better debugging tool than either alone.

**Risks:** Table is a bit denser because some categories appear twice. *Mitigation:* visual grouping (a thin separator row between "directly attributable" and "shared infrastructure") and clear `source` column.

**Rollback:** Drop one of the two sources from the endpoint response; UI hides the missing rows gracefully.

### DD-4: Shared infrastructure is NOT allocated per-project

**Decision:** RDS, ECS Fargate, ALB, CloudFront, Secrets Manager, CloudWatch — anything in the "shared infrastructure" bucket — is reported **only at the platform level**. It is NOT pro-rated or allocated to individual projects. Per-project cost = direct cost only (KMS, chain gas, SES, Lambda, S3). Per-project margin reflects this.

**Alternatives considered:**
- *Equal split (1/N across active projects)*: Unfair to small projects; a prototype project suddenly shows huge "RDS" cost that isn't meaningful.
- *Proportional to API call count*: Fairer but still arbitrary — the gateway's ALB cost doesn't actually vary with calls per project.
- *Proportional to revenue share*: Circular — you use cost to evaluate project profitability, but you're allocating cost based on revenue.

**Rationale:** Shared infrastructure is fixed cost. Per-project margin should reflect **variable** cost only — "what would run402 save if this project stopped existing?" That's the direct cost. Sum of all project direct margins + (sum of shared costs) = platform total, which is shown separately.

**Risks:** Operators misread project margin as "total margin if we cancel this project." It's not. *Mitigation:* explicit footer note on the per-project finance card: *"Direct costs only. Shared infrastructure overhead is not allocated to individual projects. See the Finance tab for platform totals."*

**Rollback:** Add an optional allocation toggle in a future version if operators actually want it. Spec allows this as a follow-up.

### DD-5: Existing `/admin/project/:id` page augmented with 3 prepended cards

**Decision:** The existing per-project admin page gains 3 new finance cards (revenue / direct cost / direct margin) **at the top**, above all existing content. No existing section is removed, moved, or re-styled. The cards fetch from a new `/admin/api/finance/project/:id` endpoint and respect the same time window selector as the Finance tab.

**Alternatives considered:**
- *New separate page `/admin/project/:id/finance`*: Extra nav click, duplicates the per-project context. Finance is most useful alongside project metadata.
- *Modal / drawer on project click*: Harder to link to, harder to screenshot, harder to bookmark.
- *Sidebar on the per-project page*: Existing page layout doesn't have a sidebar; would require restructuring.

**Rationale:** The kysigned plan line explicitly called out per-project visibility. Augmenting the existing page is the least-disruptive path and keeps finance data one click away from the project itself. The `finance-revenue-card` class marker makes ship-time smoke testing possible (grep the HTML for the class to prove the augmentation is live).

**Risks:** The admin-wallet.ts file renders the existing page and is ~500 lines. A careless edit could break the existing content. *Mitigation:* the edit is purely additive (insert 3 new `<div>` tags + a fetch script block) and the backward-compat test suite confirms existing content still renders.

**Rollback:** Remove the 3 `<div>` tags and the fetch script. Existing page is untouched.

### DD-6: CSV export with multi-section body

**Decision:** The CSV export endpoint (`GET /admin/api/finance/export`) returns a single file with multiple logical sections separated by blank lines — platform summary, then revenue breakdown, then cost breakdown. Each section has its own header row. This is technically "not a clean CSV" by strict RFC 4180 — it's more like "multiple CSVs in one file."

**Alternatives considered:**
- *Multiple files in a ZIP*: User has to unzip. Extra dependency (`yazl` or similar).
- *One flat CSV with mixed columns*: Would need dummy cells for section markers. Ugly.
- *JSON export instead*: User said CSV only. JSON is already available via the API endpoints.
- *Excel-compatible .xlsx*: Requires a library (`exceljs`). Overkill for a dashboard that exports to `less`-friendly format.

**Rationale:** Spreadsheet apps (Excel, Google Sheets, Numbers) all parse multi-section CSV files acceptably — each section becomes a visually separated block when imported. For CLI tools (`awk`, `miller`) it's also trivial to split on blank lines. This is the pragmatic middle ground.

**Risks:** Strict CSV parsers choke. *Mitigation:* `Content-Type: text/csv` is still correct; a separate "strict CSV per section" alternative is a 1-day add later if anyone asks.

**Rollback:** Replace the multi-section format with 3 separate downloads or a ZIP. Endpoint contract stays.

### DD-7: Drift detection at 5% threshold, warning only

**Decision:** The cost breakdown endpoint computes `drift_percentage = abs(counter_derived - cost_explorer) / cost_explorer × 100` for the categories that appear in both sources (KMS, SES, Lambda, S3). If `> 5%`, the response sets `drift_warning: true` and the UI displays a yellow warning banner. We **do not** auto-correct, auto-update pricing, or auto-rollup.

**Alternatives considered:**
- *Auto-refresh pricing on drift detection*: Premature — drift could be due to counter bugs, not stale pricing.
- *Block the page on drift*: Too aggressive; operators still need to see whatever data is there.
- *Lower threshold (1%)*: Too noisy — AWS pricing precision and timing differences legitimately produce small drift.
- *Higher threshold (20%)*: Misses real problems.

**Rationale:** 5% is the "something is wrong, investigate" threshold. Below it, natural drift from timing (day boundaries, rounding, Cost Explorer's own 24-hour lag) is absorbed. Above it, operator attention is warranted. The action button in the warning links to the refresh-pricing endpoint so the fix is one click.

**Rollback:** Remove the warning banner; drift is still computed and visible in the response.

### DD-8: Unattributed revenue bucket for orphaned topups

**Decision:** The revenue breakdown groups topups by their `billing_account_id → wallet/email → project` chain. If a topup's billing account has no associated project (orphaned or pre-project legacy data), the amount is added to a top-level `unattributed_usd_micros` field and rendered as an "Unattributed" row at the bottom of the table.

**Alternatives considered:**
- *Drop orphaned topups*: Platform total no longer reconciles — the KPI card disagrees with the table sum.
- *Assign to a synthetic "orphan" project*: Same effect but clutters the project list.
- *Backfill project associations*: Out of scope per Non-goals.

**Rationale:** Reconciliation between the KPI card and the table must always hold. An "unattributed" bucket preserves this. For the clean post-ship dataset, this row should be $0 most of the time — visible only if we introduce a bug that breaks the project link.

**Rollback:** Drop the unattributed bucket; add a migration to fix orphaned topups retroactively if we decide to clean them up.

### DD-9: No retroactive re-attribution on pricing updates

**Decision:** When an operator clicks "Update pricing" and the AWS rates change, the new rates apply **only to future computations**. Historical ledger entries in `allowance_ledger` are immutable. `aws_cost_cache` rows are also not recomputed. Running `/admin/api/finance/costs?window=30d` the next day will use the new rates for the whole 30-day window (because rollups are live per DD-1) — so the displayed cost "as of today" reflects current rates, even for historical data.

**Alternatives considered:**
- *Rate snapshots per ledger entry*: Record the rate at time of entry creation. Perfectly historically accurate but adds complexity to every write site. Only matters if rates change frequently, which they don't.
- *Retroactive migration on update*: Rewrite historical ledger rows when pricing changes. Destroys the audit trail.

**Rationale:** The dashboard answers "what would this cost AT CURRENT RATES?" not "what were we charged in the past?" For operator decision-making (is this project profitable?) the current-rates view is more useful. The drift warning catches the case where rates have drifted from reality.

**Risks:** Confusing if an operator compares two screenshots taken before and after a pricing update. *Mitigation:* the "last updated" label on the pricing section shows when rates were last refreshed; the CSV export includes rate version metadata.

**Rollback:** Add a per-entry rate snapshot column in a future migration if ever needed.

### DD-10: Vanilla JS frontend matching existing admin pages

**Decision:** The Finance tab's frontend is written as a single `<script>` block embedded in the HTML template, using vanilla fetch + DOM manipulation — same pattern as the existing `/admin/projects` and `/admin/subdomains` pages (`adminTablePage` in `admin-dashboard.ts`). No React, no Vue, no build step, no new frontend dependencies.

**Alternatives considered:**
- *Extract admin frontend to a SPA*: A bigger refactor that applies to the whole admin dashboard, not this feature. Out of scope.
- *Use htmx*: Cleaner for dynamic content but introduces a new dependency pattern inconsistent with the rest of `/admin`.

**Rationale:** Consistency with existing admin code. Onboarding for future agents is "read `admin-dashboard.ts` to see the pattern, copy it." No new tooling. The Finance tab is small enough (3 tables, 3 cards, a window selector) that vanilla JS is plenty.

**Rollback:** N/A — there's no framework to roll back from.

### DD-11: Cost Explorer cached in UTC days, service-to-category mapping hardcoded

**Decision:** The `aws_cost_cache` table uses `DATE` (UTC-based) for the day key and a string `service_category` that is run402's internal category name (not the raw AWS service name). The mapping from AWS `SERVICE` dimension → run402 category is a hardcoded TypeScript const in `services/aws-cost-fetcher.ts`. Any AWS service not in the map goes into `"Other shared"`.

**Alternatives considered:**
- *DB-backed mapping table*: Overkill — the mapping changes very rarely, once per year at most.
- *Store raw AWS service names, map at query time*: Cleaner DB but requires the mapping on every read.
- *Per-project Cost Explorer queries with cost allocation tags*: Needs tagged AWS resources (RDS schema tags don't exist in run402's current architecture), multi-day Cost Explorer delays, and more API calls ($0.01 each).

**Rationale:** Daily platform-level cost is exactly what the Finance tab needs. The mapping is small (~10 services), stable, and checking it into code makes review visible. Unknown services bucket into "Other shared" so nothing is ever lost.

**Risks:** A new AWS service we start using shows up as "Other shared" instead of getting its own category. *Mitigation:* CLAUDE.md has a section "How to add a new cost category to the service-to-category mapping" so future agents know to update it.

**Rollback:** Move mapping to a DB table in a follow-up if AWS services churn faster than expected.

## Risks / Trade-offs

**Live-query performance at scale:** All rollups run as SQL queries on page load. At current scale (<1k projects, <100k topups) this is sub-200ms. At 10× scale it could approach 1-2 seconds. *Mitigation:* add caching (DD-1) if query p95 exceeds 1s. Metrics already tracked.

**Cost Explorer API cost:** $0.01 per request. Daily fetcher + occasional manual refresh ≈ 40 requests/month = $0.40/month. Trivial but worth noting.

**Cost Explorer latency:** AWS Cost Explorer has a 24-hour delay for finalized data. The daily fetcher pulls "yesterday complete + today running total", so today's platform cost KPI is always an undercount. *Mitigation:* display `cache_age_seconds` label; operators can mentally adjust.

**Drift warning false positives:** Small natural drift (rounding, day boundaries, Cost Explorer's own timing) can push the percentage over 5% on low-volume categories. *Mitigation:* the warning only fires when BOTH values are non-zero — avoids divide-by-zero and low-denominator noise.

**Admin OAuth scope:** All finance data is behind a single Google OAuth gate. A compromised Google account with `@kychee.com` sees everything. *Mitigation:* matches the existing admin dashboard's threat model — this feature doesn't change the security boundary. If we add 2FA or per-user permissions later, it applies to the whole admin dashboard uniformly.

**Backward-compat risk on `/admin/project/:id` page augmentation:** The existing admin-wallet.ts renders this page. Inserting new content at the top could break the existing layout. *Mitigation:* explicit backward-compat scenario in the spec; regression test verifies the pre-existing sections still render.

**Pricing drift without operator intervention:** An operator never clicks "Update pricing" for months; AWS actually raises a rate; counter-derived cost lies. *Mitigation:* the drift warning is specifically designed to catch this. It's visible on every page load once drift exceeds 5%.

**Service-to-category mapping staleness:** When run402 adopts a new AWS service, it shows up as "Other shared" until we update the const. *Mitigation:* CLAUDE.md onboarding section; also visible because "Other shared" growing over time would be suspicious on its own.

**Reconciliation edge case — topup without project:** A pre-ship topup or a billing_account_wallets row pointing to a deleted project. *Mitigation:* DD-8 "unattributed" bucket absorbs these; the top-level total always reconciles.

## Migration Plan

Additive change. No data transformation required.

1. **Database migration (server.ts startup, v1.21):**
   - `CREATE TABLE IF NOT EXISTS internal.cost_rates (key TEXT PRIMARY KEY, value_usd_micros BIGINT NOT NULL, unit TEXT NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), source TEXT NOT NULL DEFAULT 'seed')`
   - Seed `cost_rates` via `INSERT ... ON CONFLICT DO NOTHING` with the 6 default rates (SES, Lambda request, Lambda GB-sec, S3, KMS monthly, KMS sign).
   - `CREATE TABLE IF NOT EXISTS internal.aws_cost_cache (day DATE NOT NULL, service_category TEXT NOT NULL, cost_usd_micros BIGINT NOT NULL, fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY (day, service_category))`
   - Index `idx_aws_cost_cache_day` on `(day)` for window range queries.

2. **CDK update (`infra/lib/pod-stack.ts`):**
   - Add `ce:GetCostAndUsage` to the gateway task role (no resource ARN — Cost Explorer is billing-account-scoped).
   - Add `pricing:GetProducts` to the gateway task role.
   - No new secrets, no new env vars.
   - Deploy via `./scripts/cdk-deploy.sh` or `cdk deploy AgentDB-Pod01`.

3. **Deploy gateway:** all new routes are additive; existing routes unchanged. Backward-compat sweep runs as part of CI.

4. **First boot behavior:**
   - v1.21 migration creates both tables and seeds `cost_rates`.
   - `aws_cost_cache` is empty — the Finance tab's cost/margin cards will show "—" with a "Cost Explorer cache empty — refresh below" hint.
   - First operator visit triggers either the daily fetcher on the next scheduler tick, or they click "Refresh now" to populate immediately.

5. **Cross-document update:** None. This feature deliberately does not touch public docs (see spec Requirement: Documentation surfaces).

6. **Validate in production:**
   - After deploy, an admin visits `/admin/finance`, confirms the page renders with placeholder data.
   - Admin clicks "Refresh now" — `aws_cost_cache` populates with the last 90 days of Cost Explorer data (one round of API calls).
   - Admin switches time windows — all 3 sections re-render from the cache.
   - Admin clicks a project row — `/admin/project/:id` opens with 3 new finance cards prepended.
   - Admin clicks "Export CSV" — downloads the multi-section file.

7. **No rollback script needed:** if we need to disable the feature, remove the `/admin/finance` route from the admin router. The tables persist harmlessly. The pricing constants seeded into `cost_rates` don't conflict with anything.
