## Plan: run402-admin-polish

**Owner:** volinskey
**Created:** 2026-04-15
**Status:** Ready for Implementation
**Spec:** none (scoped UI polish + bug fixes against existing admin — no dedicated admin spec exists)
**Spec-Version:** unversioned
**Source:** user-request
**Code:** `c:\Workspace-Kychee\run402\packages\gateway\src\routes\admin-*.ts` and `packages\gateway\src\services\finance-rollup.ts`
**Worktree:** none

## Legend
- `[ ]` Todo | `[~]` In Progress | `[x]` Done

---

## Scope Summary

Five discrete admin-site changes at run402.com/admin:
- **(a) Finance:** unnamed + zero-revenue rows still appear despite existing filter in [finance-rollup.ts:213-218](../../packages/gateway/src/services/finance-rollup.ts#L213-L218). Need to find why and extend filter.
- **(b) llms.txt tab:** remove the nav link (and route) across all three admin HTML pages.
- **(c) Projects page:** default-hide `archived` / `deleted` / `purged`; add "Show archived/purged" toggle; expose `pinned` indicator with sort; make all column headers sortable (default Created desc); reorder columns to Name → Tier → Status → ID → Wallet → Created.
- **(d) Subdomains page:** remove per-row "Release" button; add bottom "Release subdomain" command area (single input + "type YES to confirm") modeled on the dashboard's Add Admin Wallet pattern.
- **(e) Finance page resource safety (P0):** On 2026-04-15 09:25 local the gateway ECS task was OOM-killed (exit 137, 1024 MB limit) when two admins opened `/admin/finance` within 4s of each other. The Finance tab fires `/summary`, `/revenue`, `/costs` in parallel; each runs ~8 live Postgres queries → ~48 overlapping queries, ~600 MB heap in 45s. 1-minute 503 blip across the entire gateway (/admin, /health, API). No alarms fired — Bugsnag doesn't catch OOM kills. Need to stop the finance page from being able to crash the gateway, regardless of concurrent-admin load.

---

## Design Decisions

### DD-1: No formal spec — small-change exception
- **Alternatives:** Author a full admin spec first; skip planning entirely
- **Chosen because:** Four scoped, well-defined changes on existing UI. Admin source code + this plan serve as de facto spec.
- **Trade-offs:** No automated regression spec for future changes. Acceptable — admin is operator-only.
- **Rollback:** N/A

### DD-2: Client-side sorting for Projects page
- **Alternatives:** Server-side sort with query params
- **Chosen because:** Project count is small (admin-only, <1000 rows), table is already rendered in a single JSON fetch. Client-side sort keeps server untouched and gives instant UX.
- **Trade-offs:** Won't scale past ~10k projects. Fine.
- **Rollback:** Swap to server-side by adding `?sort=&dir=` to `/admin/api/projects`.

### DD-3: Status defaults — hide archived, deleted, purged
- **Alternatives:** Hide only deleted; hide only archived+deleted; status multi-select
- **Chosen because:** User explicitly said archived/purged default off. `deleted` is end-of-life — clearly also hide. A single "Show archived/purged/deleted" toggle is the simplest UI.
- **Trade-offs:** No granular filter (e.g., archived-only). Can add multi-select later if needed.
- **Rollback:** Remove toggle, show all.

### DD-4: Pinned — indicator column + float-to-top
- **Alternatives:** Separate "Pinned" tab/filter; sort-by-pin only
- **Chosen because:** User asked "how do I see pinned projects?" — wants them visible. A 📌 indicator in the Name column + always-float-pinned-to-top under the default Created sort answers that without adding UI weight. A dedicated "pinned only" filter chip is a small add-on.
- **Trade-offs:** Slight sort complexity (pinned-first within any active sort).
- **Rollback:** Drop the float-to-top; keep indicator only.

### DD-5: Finance resource safety — cache + coalesce, not memory bump
- **Alternatives:** (1) Just raise ECS task memory to 2048 MB. (2) Per-session rate limit. (3) Pre-compute finance in a background job.
- **Chosen because:** The root cause is duplicate in-flight work and unbounded result-set buffering, not a too-small task. Raising memory only buys time before the next spike. A short in-memory TTL cache (e.g., 30s) on the three finance endpoints + request coalescing (if a fetch is in flight, subscribers await the same promise) collapses N concurrent opens into one DB round-trip set. Caching is acceptable for finance — the data is already eventually-consistent and the window param quantizes naturally (24h/7d/30d/90d). Also add server-side LIMITs and streamed CSV writes to cap per-request heap. Background pre-compute is future work if traffic grows.
- **Trade-offs:** Up to 30s stale data on finance cards — acceptable and we'll label it. Explicit "Refresh" button bypasses cache.
- **Rollback:** Disable cache via env flag `FINANCE_CACHE_TTL_MS=0`; keep coalescer on.

### DD-6: Release flow — bottom command area, YES confirmation
- **Alternatives:** Keep per-row button with YES modal; small modal form; CLI-only
- **Chosen because:** User explicitly asked for the Add-Admin-Wallet dashboard pattern. Removes accidental-click risk of per-row destructive button. Typing the domain name is a stronger confirmation than a modal click.
- **Trade-offs:** One more step for operators who release frequently (shouldn't be frequent).
- **Rollback:** Restore per-row button.

---

## Tasks

### Phase 1: Investigate (a) — why unnamed/0 rows still show

- [x] **Reproduce and diagnose** [code] — see Implementation Log > Gotchas > (a) root cause analysis

### Phase 2: Fix (a) — extend filter

- [x] **Write failing test for broadened unnamed filter** [code]
- [x] **Broaden the filter** in [finance-rollup.ts:215-221](../../packages/gateway/src/services/finance-rollup.ts#L215-L221) [code] — case-insensitive, trimmed match on `""`, `"unnamed"`, `"(unnamed)"`
- [x] **Run full gateway test suite** [code] — 1151/1151 pass

### Phase 3: (e) Finance page resource safety — prevent OOM from concurrent admin loads [P0]

- [x] **Capture baseline** [code]
  - `/admin/api/finance/summary` → ~3 queries (`getPlatformRevenue`, `getPlatformCostFromCache`, `getDirectCostByProject` + rates)
  - `/admin/api/finance/revenue` → 2 queries (per-project CTE + unattributed)
  - `/admin/api/finance/costs` → ~7 queries (6 for `getDirectCostByProject` + cache)
  - Total ~12 queries per admin load, all parallel. Two concurrent admins ≈ 24 queries overlapping + heap buffering of unbounded result sets.
  - ECS task memory: 1024 MB (per incident report)
  - No existing cache or rate-limit on admin finance routes (source grep = no matches).
- [x] **Write failing test: request coalescing** [code] — 10 concurrent callers → 1 fetch (finance-cache.test.ts)
- [x] **Write failing test: TTL cache** [code] — within TTL no refetch; after TTL refetch; ttlMs=0 disables
- [x] **Write failing test: explicit refresh bypass** [code] — `refresh:true` re-fetches and replaces cached value
- [x] **Implement cache + coalescer module** [code] — [finance-cache.ts](../../packages/gateway/src/services/finance-cache.ts) — `createFinanceCache({ttlMs, now})` with `Map` + in-flight promise map
- [x] **Wire cache into finance routes** [code] — wrapped getSummary/getRevenueBreakdown/getCostBreakdown; `?refresh=1` passes through to cache
- [ ] **Cap result-set size on revenue breakdown** [code]
  - In `getRevenueBreakdownByProject` [finance-rollup.ts](../../packages/gateway/src/services/finance-rollup.ts) — ensure `LIMIT` on the per-project SELECT (e.g., top 500 by revenue), with an overflow flag
  - Write test: given 1000 seeded projects, returned rows ≤ limit + `truncated: true`
- [ ] **Stream CSV export instead of buffering** [code]
  - [admin-finance.ts:284-346 buildPlatformCsv](../../packages/gateway/src/routes/admin-finance.ts#L284-L346) currently concats all lines in memory
  - Convert to streamed response (write row-by-row to `res`) to bound heap during large exports
  - Test: large project count doesn't spike RSS beyond threshold
- [ ] **Add simple admin-route rate limit / concurrency guard** [code]
  - Per-session cap: max 1 in-flight `/admin/api/finance/*` request per session (queue or 429)
  - Cross-session global cap: max 4 concurrent finance queries across all admins (semaphore)
  - Test: 10 concurrent calls serialize correctly, never more than N in flight
- [ ] **Label stale data in the Finance UI** [frontend-visual]
  - Small "cached — Ns ago" indicator + "Refresh" button that sends `?refresh=1`
  - In [admin-finance-html.ts](../../packages/gateway/src/routes/admin-finance-html.ts)
- [ ] **Document operational fallback** [manual]
  - In plan's Infrastructure State + in a short comment in finance-cache.ts: "To disable caching set `FINANCE_CACHE_TTL_MS=0`"
- [ ] **Consider raising ECS task memory to 1536 MB as safety margin** [infra]
  - Not a root-cause fix, but cheap defense-in-depth
  - Check `packages/gateway/infra/*` or deploy config for the task definition
  - HUMAN checkpoint: confirm cost impact before applying
- [ ] **Run full gateway test suite**
- [ ] **Load-test the fix locally** [manual]
  - Use `curl` / `ab` / `autocannon` to fire 10 parallel `/admin/api/finance/summary?window=30d` with a valid session cookie
  - Observe: only 1 DB burst, subsequent requests served from cache, memory stays flat

### Phase 4: (b) Remove llms.txt tab

- [ ] **Remove nav link** from all three pages [frontend-visual]
  - [admin-dashboard.ts:523-524](../../packages/gateway/src/routes/admin-dashboard.ts#L523-L524) and :581-584
  - [admin-finance-html.ts:91](../../packages/gateway/src/routes/admin-finance-html.ts#L91)
  - [admin-wallet.ts:560-561](../../packages/gateway/src/routes/admin-wallet.ts#L560-L561)
- [ ] **Decide on route** [code]
  - Find `/admin/llms-txt` route handler. If it's purely a generated file viewer with no operator workflow using it, remove the route too. If unsure, leave the route (no harm) — user just loses the nav entry. Default: remove the route.
- [ ] **Run gateway tests**

### Phase 5: (c) Projects page — columns, sort, filter, pinned

- [ ] **Write failing tests** for column order and toggle behavior [frontend-logic]
  - DOM-level test: headers render in order Name, Tier, Status, ID, Wallet, Created
  - DOM test: with toggle OFF, archived/deleted/purged rows are hidden
  - DOM test: clicking a header cycles sort asc/desc and data re-renders
  - DOM test: pinned rows float to top regardless of active sort
- [ ] **Reorder columns** to Name, Tier, Status, ID, Wallet, Created in [admin-dashboard.ts:608-612](../../packages/gateway/src/routes/admin-dashboard.ts#L608-L612) [frontend-visual]
- [ ] **Add pinned column data** to projects API response (include `pinned` bool from `internal.projects`) [code]
  - Update [admin-dashboard.ts:337-355](../../packages/gateway/src/routes/admin-dashboard.ts#L337-L355) to SELECT `pinned`
- [ ] **Render pinned indicator** (📌 prefix in Name cell) [frontend-visual]
- [ ] **Add "Show archived/purged/deleted" toggle** above the table, OFF by default [frontend-logic]
  - Filters client-side array before render
  - Persist choice in `localStorage` (`admin.projects.showInactive`)
- [ ] **Make column headers sortable** [frontend-logic]
  - Click to cycle asc → desc → asc
  - Visual indicator (▲/▼) on active column
  - Default: sort by Created desc
  - Pinned rows always float to top (stable within pinned group using active sort)
- [ ] **Run gateway tests**

### Phase 6: (d) Subdomains — remove per-row Release, add bottom command area

- [ ] **Write failing test** — clicking Release with wrong confirm text (not literal `YES`) must not call DELETE [frontend-logic]
- [ ] **Write failing test** — clicking Release with correct `YES` confirm calls `DELETE /admin/api/subdomains/:name` [frontend-logic]
- [ ] **Remove per-row Release button** from [admin-dashboard.ts:627](../../packages/gateway/src/routes/admin-dashboard.ts#L627) [frontend-visual]
- [ ] **Add bottom Release command area** below the subdomains table [frontend-visual]
  - Structure mirrors Add Admin Wallet ([admin-dashboard.js:83-89](../../packages/gateway/public/admin-dashboard.js#L83-L89))
  - Fields: `<input placeholder="subdomain-name">`, `<input placeholder='type YES to confirm'>`, `<button>Release</button>`
  - Button disabled unless second input strictly equals `YES`
  - On success, toast + refresh table
- [ ] **Run gateway tests**

### Phase 7: Regression + Ship

- [ ] **Run FULL repo test suite** [code]
  - `npm test` in `packages/gateway` and any root-level suite
  - Zero regressions
- [ ] **Manual smoke in local dev** [manual]
  - Visit `/admin`, `/admin/projects`, `/admin/subdomains`, `/admin/finance`
  - Verify: no llms.txt tab anywhere; Projects page defaults + sort + pinned; Subdomains release flow; Finance has no unnamed/0 rows
- [ ] **Ship to prod** [ship]
  - Deploy gateway and verify `/admin` loads with changes
  - Smoke: open the Projects page in prod, confirm the toggle defaults off and column order is correct

---

## Infrastructure State

- **Service:** run402 gateway, repo `c:\Workspace-Kychee\run402`
- **Admin routes:** `packages/gateway/src/routes/admin-*.ts`
- **Admin static JS:** `packages/gateway/public/admin-dashboard.js`
- **Finance service:** `packages/gateway/src/services/finance-rollup.ts`
- **Auth:** Google OAuth, @kychee.com domain-gated (per admin-finance.ts:2-4)
- **DB table:** `internal.projects` (has `pinned` boolean per exploration)
- **Test command:** `npm run test:unit -w packages/gateway` — node test runner with `--experimental-test-module-mocks`, covers `src/**/*.test.ts`. Also: `npm run test:docs` (API docs alignment), `npm run test:sql`, `npm run test:subdomains`, etc. Full regression = run all `test:*` scripts from root `package.json`.
- **Test baseline:** (capture before starting work)

---

## Implementation Log

_Populated during implementation by /implement_

### Gotchas

- **(a) root cause analysis** — Filter at [finance-rollup.ts:215-218](../../packages/gateway/src/services/finance-rollup.ts#L215-L218) matches `null`, `""`, `"(unnamed)"` and drops unnamed+zero. SQL at [finance-rollup.ts:170](../../packages/gateway/src/services/finance-rollup.ts#L170) does `COALESCE(t.project_name, '(unnamed)')` so nulls normalize to `'(unnamed)'` in the query result — filter should match. The most likely reasons user still sees them in prod:
  1. **Stale deploy** — filter committed but the running ECS task predates it. Check git log vs. deploy timestamp first.
  2. **Name variants** — a project named `"Unnamed"`, `"unnamed"`, `"Unnamed Project"`, whitespace-only, or a dash. The filter is case-exact and only covers 3 spellings.
  3. **Front-end/browser cache** — hard refresh.
  Fix in Phase 2: broaden filter to trim + case-insensitive match on `unnamed|\(unnamed\)|^$|^\s*$`, and verify deploy.
- **FULL OUTER JOIN edge** — A project appearing only in `ledger_totals` has `t.project_name = NULL` → COALESCE gives `'(unnamed)'` even if `projects.name` exists. Minor secondary bug: if such a project has non-zero ledger revenue it'd display as `(unnamed)` even though it's named. Low priority — add to follow-up.

### Deviations

- TBD

---

## Log

- 2026-04-15: Plan created. Four-item scoped polish task. No formal spec — admin source is de facto spec (DD-1).
- 2026-04-15: Added Phase 3 (e) — finance page resource safety (P0) — after gateway OOM crash at 09:25 local triggered by two concurrent `/admin/finance` loads. See DD-5.
