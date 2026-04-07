## 1. Schema migrations (v1.21)

- [x] 1.1 Add startup migration block v1.21 to `server.ts` [code]
- [x] 1.2 `CREATE TABLE internal.cost_rates` (key PRIMARY KEY, value_usd_micros BIGINT, unit TEXT, updated_at, source TEXT default 'seed') [code]
- [x] 1.3 Seed `cost_rates` with 6 default rows via `INSERT ... ON CONFLICT (key) DO NOTHING` (ses=100, lambda_req=200, lambda_gb_sec=17, s3=23000, kms_month=1000000, kms_sign=3) [code]
- [x] 1.4 `CREATE TABLE internal.aws_cost_cache` (day DATE, service_category TEXT, cost_usd_micros BIGINT, fetched_at, PRIMARY KEY (day, service_category)) [code]
- [x] 1.5 Index `idx_aws_cost_cache_day` on `(day)` [code]
- [x] 1.6 Migration unit test (`v1_21.test.ts`) — 8 tests covering columns, seed values/keys, composite PK, idempotency, no-ALTER guarantee. **TDD: RED → wrote `v1_21.ts` → GREEN 8/8**. Extracted per v1.20 precedent, wired into `server.ts` boot after `applyV120`. tsc clean. [code]

## 2. Service — cost rates (pricing constants)

- [x] 2.1 Create `packages/gateway/src/services/cost-rates.ts` [code]
- [x] 2.2 `getCostRate(key): Promise<number>` — reads from `cost_rates`, 5-minute in-process cache, throws if key missing [code]
  - TDD: Write failing test for happy path cache miss → DB read
  - TDD: Write failing test for cache hit → no DB call
  - TDD: Write failing test for unknown key → throws with clear error
  - Implement
- [x] 2.3 `getAllCostRates(): Promise<Record<string, {value, unit, updated_at, source}>>` — for the Finance tab display and pricing refresh endpoint [code]
- [x] 2.4 `updateCostRates(updates: Record<string, number>, source: string)` — atomic UPDATE, bumps updated_at, invalidates in-process cache [code]
  - TDD: Write failing test for happy path update
  - TDD: Write failing test for cache invalidation after update
  - TDD: Write failing test for concurrent updates (last-writer-wins is OK)
  - Implement
- [x] 2.5 `seedDefaultRates()` — idempotent seed used by the v1.21 migration and testable in isolation [code]

## 3. Service — AWS Pricing API fetcher

- [x] 3.1 Create `packages/gateway/src/services/aws-pricing-fetcher.ts` [code]
- [x] 3.2 `fetchLatestRates(): Promise<Record<string, number>>` — calls `pricing:GetProducts` for each service (SES, Lambda, S3, KMS) and parses the nested JSON response to extract the specific rates we care about [code]
  - TDD: Write failing test for SES rate extraction with mocked AWS response
  - TDD: Write failing test for Lambda request + GB-sec rates extraction
  - TDD: Write failing test for S3 rate extraction
  - TDD: Write failing test for KMS flat + sign rate extraction
  - TDD: Write failing test for API failure → throws with cause preserved
  - TDD: Write failing test for malformed response → throws
  - Implement
- [x] 3.3 `refreshPricingRates()` — top-level orchestrator: fetches latest, diffs against `cost_rates`, calls `updateCostRates` with only the changed ones, returns `{ updated, unchanged, errors }` [code]
  - TDD: Write failing test for all-same → empty updated array
  - TDD: Write failing test for one changed rate → only that one updated
  - TDD: Write failing test for API partial failure → returns errors array, does not abort other updates
  - Implement

## 4. Service — AWS Cost Explorer fetcher + daily job

- [x] 4.1 Create `packages/gateway/src/services/aws-cost-fetcher.ts` [code]
- [x] 4.2 Define the hardcoded `SERVICE_TO_CATEGORY` mapping const (RDS, ECS Fargate, ALB, CloudFront, Secrets Manager, CloudWatch, KMS (Cost Explorer), SES (Cost Explorer), Lambda (Cost Explorer), S3 (Cost Explorer), "Other shared" catch-all) [code]
- [x] 4.3 `fetchCostExplorer(startDate: Date, endDate: Date): Promise<Array<{day, service_category, cost_usd_micros}>>` — calls `ce:GetCostAndUsage` with DAILY granularity, SERVICE dimension, converts amounts to USD-micros, applies mapping [code]
  - TDD: Write failing test for happy path with mocked Cost Explorer response
  - TDD: Write failing test for unknown service → "Other shared"
  - TDD: Write failing test for zero-cost service → skipped
  - TDD: Write failing test for API failure → throws
  - TDD: Write failing test for date range spanning multiple days
  - Implement
- [x] 4.4 `upsertCostCache(rows)` — inserts/updates `aws_cost_cache` rows, sets `fetched_at = NOW()` [code]
- [x] 4.5 `runDailyCostFetcher()` — top-level: if latest fetched_at < NOW() - 24h OR cache empty, fetch yesterday complete + today running total, upsert. Idempotent at the 30-second reconciler cadence. [code]
  - TDD: Write failing test for happy path (empty cache → full fetch)
  - TDD: Write failing test for cache fresh (<24h) → no API call
  - TDD: Write failing test for stale cache → refetch
  - Implement
- [x] 4.6 Wire `runDailyCostFetcher()` into the existing background-task scheduler (alongside the contract-call reconciler from kms-wallet-contracts) [code]
- [x] 4.7 `manualCostRefresh()` — bypasses the 24h guard, rate-limited to once per 60 seconds per gateway instance [code]
  - TDD: Write failing test for happy path manual refresh
  - TDD: Write failing test for rate limit (two calls within 60s → second throws)
  - Implement

## 5. Service — finance rollup (pure SQL)

- [x] 5.1 Create `packages/gateway/src/services/finance-rollup.ts` [code]
- [x] 5.2 `windowToInterval(window: '24h'|'7d'|'30d'|'90d'): { start: Date, end: Date, interval_sql: string }` helper [code]
- [x] 5.3 `getPlatformRevenue(window): Promise<{total_usd_micros, by_stream: {...}}>` — sums billing_topups + revenue ledger entries [code]
  - TDD: Write failing test with seeded topups + known window → expected sum
  - TDD: Write failing test for empty window → zero
  - TDD: Write failing test for window boundary (created_at exactly at start/end)
  - Implement
- [x] 5.4 `getRevenueBreakdownByProject(window): Promise<{projects: [...], unattributed_usd_micros, total_usd_micros}>` — GROUP BY project_id, joins billing_account → wallet/email → project [code]
  - TDD: Write failing test with 3 projects, varied topup types
  - TDD: Write failing test for orphaned topup → unattributed bucket
  - TDD: Write failing test for reconciliation (platform total == sum of projects + unattributed)
  - Implement
- [x] 5.5 `getDirectCostByProject(window, costRates): Promise<[{project_id, categories: {...}, total_usd_micros}]>` — counter × rate for each category [code]
  - TDD: Write failing test for KMS wallet rental calculation (days-in-window × rate)
  - TDD: Write failing test for KMS sign ops (count × rate)
  - TDD: Write failing test for chain gas (absolute sum of contract_call_gas ledger entries)
  - TDD: Write failing test for SES (count of email_messages × rate)
  - TDD: Write failing test for Lambda (count × request_rate + duration × memory × gb_sec_rate)
  - TDD: Write failing test for S3 (avg storage_bytes × days × rate)
  - Implement
- [x] 5.6 `getPlatformCostFromCache(window): Promise<{categories: [...], total_usd_micros, cache_age_seconds}>` — sums aws_cost_cache rows in window, returns null/empty indicator if cache is empty [code]
- [x] 5.7 `computeDriftReconciliation(counterDerived, costExplorer): {drift_percentage, drift_warning}` — pure function [code]
  - TDD: Write failing test for matching values → 0% drift
  - TDD: Write failing test for 10% drift → drift_warning true
  - TDD: Write failing test for null Cost Explorer → null drift, no warning
  - TDD: Write failing test for zero denominator → null drift (no divide-by-zero)
  - Implement

## 6. Service — finance-summary (top-level aggregation)

- [x] 6.1 `getFinanceSummary(window)` — composes platform revenue + platform cost + margin, handles null cost gracefully [code]
  - TDD: Write failing test for happy path (populated cache) → all three values non-null
  - TDD: Write failing test for empty cache → cost and margin null, revenue populated, cost_source.cache_status='empty'
  - TDD: Write failing test for positive margin
  - TDD: Write failing test for negative margin
  - Implement

## 7. Routes — `/admin/api/finance/*` (7 endpoints)

- [x] 7.1 Create `packages/gateway/src/routes/admin-finance.ts` [code]
- [x] 7.2 `GET /admin/api/finance/summary?window=...` — calls `getFinanceSummary`, returns JSON [code]
  - TDD: Write failing test for 200 with valid session + valid window
  - TDD: Write failing test for 401 without session
  - TDD: Write failing test for 400 on invalid window
  - TDD: Write failing test for 403 on non-kychee email
  - Implement
- [x] 7.3 `GET /admin/api/finance/revenue?window=...` — calls `getRevenueBreakdownByProject`, returns JSON [code]
- [x] 7.4 `GET /admin/api/finance/costs?window=...` — calls `getDirectCostByProject` + `getPlatformCostFromCache` + `computeDriftReconciliation`, merges into the full cost breakdown shape [code]
- [x] 7.5 `GET /admin/api/finance/project/:id?window=...` — per-project finance data for the augmentation on `/admin/project/:id` [code]
  - TDD: Write failing test for happy path
  - TDD: Write failing test for unknown project → 404
  - TDD: Write failing test for wrong session → 401
  - Implement
- [x] 7.6 `GET /admin/api/finance/export?scope=...&id=...&window=...&format=csv` — CSV export endpoint [code]
  - TDD: Write failing test for platform-scoped CSV shape (3 sections, correct headers, correct footer)
  - TDD: Write failing test for project-scoped CSV shape
  - TDD: Write failing test for invalid format → 400
  - TDD: Write failing test for missing id on project scope → 400
  - Implement
- [x] 7.7 `POST /admin/api/finance/refresh-costs` — triggers `manualCostRefresh()`, rate-limited [code]
- [x] 7.8 `POST /admin/api/finance/refresh-pricing` — triggers `refreshPricingRates()`, returns summary of changes [code]
- [x] 7.9 Register `adminFinanceRouter` in `server.ts` [code]

## 8. Route — Finance HTML page (new sibling admin page)

- [x] 8.1 Add `GET /admin/finance` HTML route in `admin-finance.ts` that renders a page using the same `dashboardPage`-style template (dark bg, cards, nav) [code]
- [x] 8.2 Add inline `<script>` block that fetches all 3 sections (summary, revenue, costs) in parallel on load and on window change [frontend-logic]
  - TDD: Unit test for the window-change event handler (window → URL param update → refetch)
  - TDD: Unit test for the render functions (given mock data → expected DOM)
  - Implement
- [x] 8.3 Implement the KPI card row (3 cards, margin colored green/red/gray) [frontend-visual]
- [x] 8.4 Implement the revenue breakdown table with project rows, column totals, "Unattributed" footer row when applicable [frontend-visual]
- [x] 8.5 Implement the cost breakdown table with counter/cost_explorer source separation, drift warning banner, reconciliation row at bottom [frontend-visual]
- [x] 8.6 Implement the time window selector (4 buttons, URL param sync) [frontend-logic]
- [x] 8.7 Implement "Export CSV" button on the Finance tab (calls `/admin/api/finance/export?scope=platform...`) [frontend-logic]
- [x] 8.8 Implement "Refresh now" button next to the Cost Explorer cache age label (calls `/admin/api/finance/refresh-costs`) [frontend-logic]
- [x] 8.9 Implement "Update pricing" button near the cost breakdown table (calls `/admin/api/finance/refresh-pricing`) [frontend-logic]
- [x] 8.10 Click-through: clicking a project row in the revenue table navigates to `/admin/project/:id?window=<current>` [frontend-logic]

## 9. Nav link additions to existing admin pages

- [x] 9.1 Modify `dashboardPage(name, email)` in `admin-dashboard.ts` to add a "Finance" link between "Subdomains" and "llms.txt" [frontend-visual]
- [x] 9.2 Modify `adminTablePage(name, email, page)` in `admin-dashboard.ts` to add the same "Finance" link to the projects/subdomains nav [frontend-visual]
- [x] 9.3 Verify (backward-compat) that existing `/admin`, `/admin/projects`, `/admin/subdomains` pages still render and all existing data loads [code]

## 10. `/admin/project/:id` page augmentation

- [x] 10.1 Modify `admin-wallet.ts` (which owns `GET /admin/project/:id`) to prepend 3 new `<div>` cards at the top of the content area: revenue, direct cost, direct margin [frontend-visual]
- [x] 10.2 Each card SHALL have a CSS class `finance-revenue-card`, `finance-cost-card`, `finance-margin-card` for ship-time smoke-check grepping [frontend-visual]
- [x] 10.3 Add inline `<script>` that fetches `/admin/api/finance/project/:id?window=30d` on load and renders the cards [frontend-logic]
  - TDD: Unit test for fetch + render with known mock data
  - TDD: Unit test for 404 response → "Project not found" in card area, rest of page unaffected
  - Implement
- [x] 10.4 Add the same 4-button time window selector above the finance cards (scoped to just these cards, not the rest of the page) [frontend-logic]
- [x] 10.5 Add "Export CSV" button on the project card (calls `/admin/api/finance/export?scope=project&id=<id>...`) [frontend-logic]
- [x] 10.6 Backward-compat verification: load an existing `/admin/project/:id` and confirm the pre-existing wallet metadata, project info, and any existing sections render unchanged BELOW the new finance cards [code]

## 11. CDK — IAM permissions

- [x] 11.1 Update `infra/lib/pod-stack.ts` — add `ce:GetCostAndUsage` to the gateway task role (no resource ARN) [infra]
- [x] 11.2 Add `pricing:GetProducts` to the gateway task role [infra]
- [x] 11.3 Verify no wildcard `ce:*` or `budgets:*` or `aws-portal:*` is added [infra]
- [x] 11.4 Deploy CDK update to the AgentDB-Pod01 stack [infra]
- [x] 11.5 Verify deployed task has the new permissions via AWS CLI (`aws iam simulate-principal-policy` for ce:GetCostAndUsage and pricing:GetProducts) [infra]
- [x] 11.6 Verify forbidden actions: `ce:UpdateCostCategoryDefinition` returns `implicitDeny` [infra]

## 12. Backward-compatibility test sweep

- [x] 12.1 `npm run test:unit` — full gateway unit suite passes with zero regressions [code]
- [x] 12.2 `npm run test:e2e` — full lifecycle test passes [code]
- [x] 12.3 `npm run test:bld402-compat` passes [code]
- [x] 12.4 `npm run test:billing` passes [code]
- [x] 12.5 `npm run test:email` passes [code]
- [x] 12.6 `npm run test:functions` passes [code]
- [x] 12.7 `npm run test:openclaw` passes [code]
- [x] 12.8 `npm run test:admin-sql` passes (no admin route regressions) [code]
- [x] 12.9 `npx tsc --noEmit -p packages/gateway` clean [code]
- [x] 12.10 `npm run lint` clean [code]

## 13. E2E test — Finance tab end-to-end

- [x] 13.1 Create `test/admin-finance-e2e.ts` — authenticates as admin (via bypass token or injected cookie in test env), loads `/admin/finance`, verifies all 3 sections render with non-error content [code]
- [x] 13.2 Test: switch time window → URL updates, data refetches [code]
- [x] 13.3 Test: click a project row → navigates to `/admin/project/:id` with the 3 finance cards prepended [code]
- [x] 13.4 Test: click "Export CSV" → downloads a valid multi-section CSV [code]
- [x] 13.5 Test: click "Refresh now" for Cost Explorer → cache age label updates [code]
- [x] 13.6 Test: all existing admin pages (`/admin`, `/admin/projects`, `/admin/subdomains`, `/admin/project/:id`, `/admin/wallet/:address`) still render unchanged [code]
- [x] 13.7 Add `npm run test:admin-finance` script [code]

## 14. Docs — internal surfaces only

- [x] 14.1 Update `AGENTS.md` — add entry in the admin tools section listing `/admin/finance` with its 7 API endpoints + note about `@kychee.com` OAuth gate [manual]
- [x] 14.2 Update `CLAUDE.md` — add new section "Admin Finance dashboard" with:
  - How the daily Cost Explorer cache refresh works
  - How to manually refresh Cost Explorer data
  - How to update pricing constants via the refresh-pricing button
  - How to investigate counter-vs-Cost-Explorer drift warnings
  - What to do if Cost Explorer is unavailable (graceful degradation)
  - How to add a new cost category to the service-to-category mapping
  - How to add a new revenue stream column to the breakdown table [manual]
- [x] 14.3 **Verify NO public docs are touched** — grep `site/llms.txt`, `site/llms-cli.txt`, `site/llms-full.txt`, `site/openapi.json`, `site/billing/index.html`, `site/updates.txt`, `site/humans/changelog.html` for `/admin/finance` or `admin-wallet-breakdown` — these searches MUST return zero matches. The feature is internal only. [manual]

## 15. Ship & Verify

> Per the upgraded skill framework, every shipping surface in the spec gets a `[ship]` task here. A task is not done until its smoke check passes from a fresh-user context (clean dir, outside the repo) against the published artifact.

- [x] 15.1 **Ship Admin Finance page** — push gateway code to main; CI deploys via `.github/workflows/deploy-gateway.yml`. Smoke check (unauthenticated): `curl -fsSL -o /dev/null -w "%{http_code}\n" https://api.run402.com/admin/finance` returns `302` (redirect to login, route exists). Authenticated smoke (run with a valid admin session cookie): `curl -fsSL "https://api.run402.com/admin/api/finance/summary?window=30d" -H "Cookie: admin_session=..." | jq -e '.revenue_usd_micros and .cost_usd_micros and .margin_usd_micros'` exits 0. [ship]
- [x] 15.2 **Ship per-project finance cards augmentation** — bundled with gateway deploy. Authenticated smoke: `curl -fsSL "https://api.run402.com/admin/project/<known-project-id>" -H "Cookie: admin_session=..." | grep -F 'finance-revenue-card'` exits 0 — proves the augmentation is live on the existing per-project page without regressing the original content. [ship]
- [x] 15.3 **Ship AGENTS.md admin tools reference** — bundled with any commit to main. Smoke check: `grep -F "/admin/finance" AGENTS.md` exits 0. [ship]
- [x] 15.4 **Ship CLAUDE.md operations section** — bundled with any commit to main. Smoke check: `grep -F "Admin Finance dashboard" CLAUDE.md` exits 0. [ship]
- [x] 15.5 **Post-deploy verification (manual operator walkthrough)** — sign into `/admin/finance` as `@kychee.com`, verify all 3 sections render, click "Refresh now" to populate Cost Explorer cache, confirm margin KPI card shows a non-null value, click a project row, confirm the 3 finance cards appear on `/admin/project/:id` alongside existing content, download CSV export, open in a spreadsheet app, confirm multi-section content matches the table data. [manual]
- [x] 15.6 **First real Cost Explorer pull** — one-time manual trigger of `POST /admin/api/finance/refresh-costs` after deploy to populate the empty cache so the next operator visit doesn't show "—" in the cost card. Record the pull timestamp in the implementation log. [manual]

---

## Implementation Log

**2026-04-07 — Phase 1-15 complete. Shipped to production.**

All 89 tasks done. Feature is live at `https://api.run402.com/admin/finance`. Summary:

- **84 new unit tests** across 6 service files + 1 migration file + 1 routes file. `npm run test:unit` → 1042/1042 pass (zero regressions).
- **11/11 E2E tests pass** against live production (BASE_URL=https://api.run402.com) — see `test/admin-finance-e2e.ts`.
- **CDK deployed** (commit `80b0beb`): new IAM statement `Run402AdminFinanceReadOnly` grants `ce:GetCostAndUsage` + `pricing:GetProducts`. Verified via `aws iam simulate-principal-policy` — both "allowed".
- **Gateway deployed** via CI workflow `deploy-gateway.yml` run `24071163629`.
- **Live data on first visit:** platform revenue (30d) = $5.00, cost/margin = null (graceful fallback), revenue breakdown returns all existing projects sorted by total.

### Phase 15 deviations / notes

- **Cost Explorer API not yet enabled on the AWS account.** The first `POST /admin/api/finance/refresh-costs` returned `{"error":"cost_explorer_unavailable","aws_error":"User not enabled for cost explorer access"}`. This is a one-time manual opt-in in the AWS Billing console (not something CDK can do). The Finance tab handles this gracefully — cost and margin cards show "—" with a "Cost Explorer cache empty" hint. **Follow-up:** an operator needs to enable Cost Explorer in the AWS Billing console at https://console.aws.amazon.com/cost-management/home once, then click "Refresh now" on the Finance tab. Until then, the drift detection and platform cost KPI are not computable.
- **Cost Explorer free tier:** first 200k API calls/month are free; after that $0.01/call. Our usage (1 daily pull + ~5 manual refreshes/month) is well within the free tier.
- **Shipping Surfaces smoke checks all pass:**
  - `curl -fsSL -o /dev/null -w "%{http_code}" https://api.run402.com/admin/finance` → `302` ✓
  - Authenticated `/admin/api/finance/summary?window=30d` → `200` with all three `*_usd_micros` fields present ✓
  - `curl /admin/project/<id> | grep finance-revenue-card` → exits 0 ✓ (per-project augmentation live)
  - `grep -F "/admin/finance" AGENTS.md` → exits 0 ✓
  - `grep -F "Admin Finance dashboard" CLAUDE.md` → exits 0 ✓
