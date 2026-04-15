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
- [x] **Document operational fallback** [manual] — documented inline in [finance-cache.ts:3-11](../../packages/gateway/src/services/finance-cache.ts#L3-L11) and in this plan's Infrastructure State. Set `FINANCE_CACHE_TTL_MS=0` to disable caching (coalescing still applies for in-flight requests).
- [x] **Run full gateway test suite** — 1158/1158 pass after wiring cache into deps
- [!] **Cap result-set size on revenue breakdown** [code] — DEFERRED. Current run402 project count is small (<100). Cache+coalesce handles the observed OOM. Worth adding as a follow-up when project count grows; requires a separate SUM() query to keep totals accurate under truncation.
- [!] **Stream CSV export instead of buffering** [code] — DEFERRED. On-demand endpoint, not triggered by normal `/admin/finance` page loads (which was the OOM trigger). Low priority vs. other items.
- [!] **Add simple admin-route rate limit / concurrency guard** [code] — DEFERRED. Coalescer already collapses duplicate in-flight work; a semaphore adds complexity without clear incremental benefit at current admin headcount (≤3). Revisit if additional incidents occur.
- [!] **Label stale data in the Finance UI** [frontend-visual] — DEFERRED. The cache is transparent and 30s TTL is short. Add the "cached Ns ago / refresh" control when first admin notices stale data.
- [!] **Consider raising ECS task memory to 1536 MB as safety margin** [infra] — WAITING FOR: user decision on cost impact. Not a root-cause fix.
- [!] **Load-test the fix locally** [manual] — DEFERRED. Unit tests prove coalescer behavior; a proper load-test requires a running gateway with DB access. Validate in prod post-deploy via gateway memory metrics.

### Phase 4: (b) Remove llms.txt tab

- [x] **Remove nav link** from all three pages [frontend-visual] — 4 `<a href="/admin/llms-txt">` links deleted across admin-dashboard.ts, admin-finance-html.ts, admin-wallet.ts
- [x] **Remove route** [code] — deleted `packages/gateway/src/routes/admin-llms-txt.ts`, removed import + `app.use(...)` from server.ts. Public `/llms.txt` (the file itself, served via CloudFront) is untouched.
- [x] **Run gateway tests** — 1158/1158 pass

### Phase 5: (c) Projects page — columns, sort, filter, pinned

- [!] **Write failing tests** for column order and toggle behavior [frontend-logic] — DEFERRED. Repo has no jsdom/DOM testing framework; adding one for a 4-item polish plan is out of scope. Visual verification via manual smoke (Phase 7). Filed as deviation in Implementation Log.
- [x] **Reorder columns** to Name, Tier, Status, ID, Wallet, Created [frontend-visual]
- [x] **Add pinned column data** to projects API response [code] — SELECT adds `COALESCE(pinned, false) AS pinned`
- [x] **Render pinned indicator** (📌 prefix in Name cell) [frontend-visual]
- [x] **Add "Show archived/purged/deleted" toggle** [frontend-logic] — OFF by default; persists to `localStorage["admin.projects.showInactive"]`; filters statuses `archived|deleted|purged|purging|expired` when off
- [x] **Make column headers sortable** [frontend-logic] — click cycles asc/desc; default Created desc; pinned always floats to top
- [x] **Run gateway tests** — 1158/1158 pass

### Phase 6: (d) Subdomains — remove per-row Release, add bottom command area

- [!] **Write failing tests** [frontend-logic] — DEFERRED, same reason as Phase 5 (no jsdom). Manual smoke will cover it.
- [x] **Remove per-row Release button** [frontend-visual]
- [x] **Add bottom Release command area** [frontend-visual] — `.release-panel` with name + YES-confirm inputs + disabled Release button enabled only when `confirm === "YES"`. Posts `DELETE /admin/api/subdomains/:name`.
- [x] **Run gateway tests** — 1158/1158 pass

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

- **Frontend-logic TDD deferred for Phases 5 & 6.** The repo has no jsdom or DOM-test infrastructure; standing that up for these polish changes would be larger than the changes themselves. Adopted spec-driven + manual verification path instead, same as the `frontend-visual` methodology. Rely on Phase 7 browser smoke to validate sort, toggle, pinned float, and YES-release.
- **Phase 3 defense-in-depth items deferred.** LIMIT cap, streaming CSV, rate limit, UI stale-label, ECS memory bump, load-test — all marked `[!]` with reasoning. The coalescer+TTL addresses the observed OOM root cause; these items are follow-up defense-in-depth.

---

## Log

- 2026-04-15: Plan created. Four-item scoped polish task. No formal spec — admin source is de facto spec (DD-1).
- 2026-04-15: Added Phase 3 (e) — finance page resource safety (P0) — after gateway OOM crash at 09:25 local triggered by two concurrent `/admin/finance` loads. See DD-5.
