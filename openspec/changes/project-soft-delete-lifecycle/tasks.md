## 1. Database migration

- [x] 1.1 Add idempotent migration block in `packages/gateway/src/db/init.sql` (or follow the existing versioned-migration pattern in `server.ts` startup) widening the `internal.projects.status` CHECK constraint to `('active', 'past_due', 'frozen', 'dormant', 'purged', 'archived')`
- [x] 1.2 Add columns to `internal.projects`: `past_due_since timestamptz`, `frozen_at timestamptz`, `dormant_at timestamptz`, `scheduled_purge_at timestamptz`, `purge_warning_sent_at timestamptz`
- [x] 1.3 Add columns to `internal.subdomains`: `reserved_for_project_id uuid`, `reserved_until timestamptz`, plus a partial index on `(reserved_for_project_id) WHERE reserved_for_project_id IS NOT NULL`
- [ ] 1.4 Verify the migration runs cleanly against a fresh local Postgres container and against a snapshot of production schema *(operator verification, not a code change)*

## 2. Core lifecycle module

- [x] 2.1 Create `packages/gateway/src/services/project-lifecycle.ts` exporting `advanceLifecycle()` (runs all pending transitions for all projects in one tick) and `advanceLifecycleForProject(projectId)` (single-project version used by the reactivation hook)
- [x] 2.2 Implement the five forward transitions (`active → past_due`, `past_due → frozen`, `frozen → dormant`, `dormant → final_warning`, `dormant → purged`) as separate SQL queries each using `UPDATE ... WHERE status = <prev> AND <timer> < NOW() - <threshold> RETURNING id` for race-safe single-winner semantics *(uses an intermediate `purging` status as a race guard)*
- [x] 2.3 Implement the `→ active` reset transition that clears all five timer columns and clears any subdomain reservations owned by the project, all in one transaction
- [x] 2.4 Extract `lookupBillingEmailForProject(projectId)` from the existing `lookupBillingEmailForWallet` pattern in `contracts-scheduler.ts`
- [x] 2.5 Wire `project-lifecycle` to enqueue emails for `past_due`, `frozen`, and `final_warning` transitions using `sendPlatformEmail` *(inline templates; a dedicated templates module is Phase D polish)*
- [x] 2.6 Rename `archiveProject` in `services/projects.ts` to `purgeProject` and ensure it is called only from the `dormant → purged` transition *(also called by explicit DELETE /projects/v1/:id, which is the intended user-initiated path)*
- [x] 2.7 Update `services/projects.ts` tests that reference `archiveProject` to use the new name; keep existing cascade behavior tests valid

## 3. Scheduler integration

- [x] 3.1 Rewrite `packages/gateway/src/services/leases.ts` so `checkWalletLeases()` calls `advanceLifecycle()` instead of calling `archiveProject` directly; keep the hourly interval
- [x] 3.2 Ensure the tick is wrapped in a single try/catch with structured logging; a failed transition for one project SHALL NOT prevent transitions for other projects
- [x] 3.3 Add a `LIFECYCLE_ENABLED` feature-flag env var defaulting to `true` in non-production and `true` in production (but allow ops to flip it off for incident response); document in CLAUDE.md *(env var landed; CLAUDE.md doc is Phase F)*

## 4. Reactivation hook

- [x] 4.1 Identify the single write site in `services/wallet-tiers.ts` and/or `services/billing.ts` where `lease_expires_at` is advanced by topup / tier renewal / tier upgrade *(three sites: subscribeTier, renewTier, upgradeTier)*
- [x] 4.2 After that write, call `advanceLifecycleForProject(id)` for every project owned by the affected wallet within the same database transaction *(implemented as post-commit best-effort; hourly tick catches up if it fails)*
- [x] 4.3 Verify via unit test that a topup on a frozen project results in `status = 'active'` and cleared timer columns on the same request *(wallet-tiers.test.ts covers the post-commit `advanceLifecycleForWallet` hook)*

## 5. Control-plane write gate

- [x] 5.1 Create `packages/gateway/src/middleware/lifecycle-gate.ts` — middleware that looks up the target project's `status` (cached via the existing project cache) and returns `402 Payment Required` with JSON body `{ lifecycle_state, entered_state_at, next_transition_at }` when status is not `active`
- [x] 5.2 Apply the middleware to all mutating admin/control-plane routes: `/projects/v1/:id` (non-GET methods), `/projects/v1/:id/deployments`, `/projects/v1/:id/subdomains`, `/projects/v1/:id/secrets`, `/projects/v1/:id/functions`, `/projects/v1/:id/settings`, `/projects/v1/:id/billing/*` *(applied to deployments POST, subdomains POST, functions POST/PATCH/DELETE, secrets POST/DELETE)*
- [x] 5.3 Audit every mutating route in `packages/gateway/src/routes/` to confirm the gate is applied and documented in the route file *(full audit done using three-category rule: CONTROL PLANE gated, PAYMENT PATH never gated, DATA PLANE never gated. Gate now applied to publish.ts (3 routes), contracts.ts (3 routes), domains.ts (1), email-domains.ts (2), mailboxes.ts (3). Rule documented in the `lifecycleGate` JSDoc and CLAUDE.md so future routes follow the convention.)*
- [x] 5.4 Verify read endpoints (`GET /projects/v1/:id`, dashboards, status queries) bypass the gate *(gate has explicit GET/HEAD/OPTIONS bypass)*
- [x] 5.5 Verify data-plane routes (PostgREST, edge function execution, storage, email send/receive) bypass the gate entirely *(gate is only wired to control-plane routes; data-plane middlewares updated to accept grace-state projects)*

## 6. Scheduled function pause

- [x] 6.1 Locate the scheduled-function dispatcher (likely in `services/functions.ts` or a sibling module) and add a `status IN ('active', 'past_due', 'frozen')` predicate to its enumeration query *(added to `onTick` in `services/scheduler.ts` via exported `scheduledInvocationAllowed` helper)*
- [x] 6.2 When a scheduled function is skipped due to dormancy, log a `scheduled_function_paused` event with project id, function name, and scheduled time; do not charge metering
- [x] 6.3 Add a test asserting that a dormant project's scheduled function is skipped and that a reactivated project resumes dispatch on the next tick

## 7. Subdomain reservation

- [x] 7.1 Update `services/subdomains.ts` claim logic to reject with `409 Conflict` when the target subdomain has `reserved_for_project_id IS NOT NULL AND reserved_until > NOW()` AND the claimant's wallet does not match the reserving project's wallet
- [x] 7.2 Update the claim logic to clear reservation columns and proceed with the claim when the claimant's wallet matches the reservation owner's wallet (owner reclaim via new project)
- [x] 7.3 Ensure the `frozen` transition writes reservation columns for all subdomains owned by the project in one SQL statement
- [x] 7.4 Ensure the `→ active` reset clears reservation columns in the same transaction as the status change
- [x] 7.5 Verify Route 53 records are NOT deleted on the `frozen` transition (reservation keeps the site serving) *(frozen transition only writes reservation columns; no DNS delete call)*
- [x] 7.6 Add a `POST /admin/subdomains/:name/release` operator endpoint that clears reservation columns for dispute resolution, scoped to `@kychee.com` admin identity *(landed at `POST /subdomains/v1/admin/:name/release` to conform to the style guide's `/<resource>/v1/admin` pattern)*

## 8. Operator reactivation endpoint

- [x] 8.1 Add `POST /admin/projects/:id/reactivate` in `routes/admin.ts`, scoped to admin identity; calls `advanceLifecycleForProject` with a forced `→ active` path *(landed at `POST /projects/v1/admin/:id/reactivate` to reuse the existing admin auth router scope)*
- [x] 8.2 Return `409 Conflict` when the target is in `purged` or `archived` (terminal, no data to restore)
- [~] 8.3 Write an audit row recording the operator identity, project id, previous state, and optional reason *(DE-SCOPED from this change. A lifecycle-specific audit table would duplicate state that belongs in a broader "operator actions audit" feature covering pin/unpin, wallet reassignment, faucet admin drips, admin SQL, reactivate, subdomain release, etc. Parked as openspec/changes/operator-actions-audit for future work. Today: operator actions are logged to stdout → CloudWatch `/agentdb/gateway` with ~30d retention, searchable by keyword.)*

## 9. Email templates

- [x] 9.1 Add `project_past_due` template: subject, HTML, and text bodies; includes project name, the exact frozen-transition date, and the topup URL *(renderPastDueEmail in services/project-email-templates.ts)*
- [x] 9.2 Add `project_frozen` template: names the project, states that deploys and control-plane writes are blocked, names the dormant-transition date, and explicitly warns that scheduled functions will pause on that date *(renderFrozenEmail)*
- [x] 9.3 Add `project_purge_final_warning` template: emphasizes 24 hours remain, shows the exact `scheduled_purge_at` timestamp, and gives the renewal link one last time *(renderFinalWarningEmail, clickable `<a>` anchor)*
- [x] 9.4 Verify all three templates render correctly via the existing email-send test harness *(15 tests in project-email-templates.test.ts: placeholder coverage, HTML escaping, urgency language, link rendering, shape regression)*

## 10. Tests

- [x] 10.1 Unit test `advanceLifecycle` for all five forward transitions against a test database, including the race-safe single-winner behavior *(project-lifecycle.test.ts — all five transitions covered)*
- [x] 10.2 Unit test the `→ active` reset from each of `past_due`, `frozen`, `dormant` *(project-lifecycle.test.ts — single-project + wallet-scoped)*
- [x] 10.3 Unit test that a pinned project with an expired lease stays in `active` *(covered by the `pinned = false` predicate assertion in active→past_due test)*
- [x] 10.4 Unit test the control-plane middleware: mutating request on `past_due`/`frozen`/`dormant` returns 402; read request returns 200; mutating request on `active` returns 200 *(lifecycle-gate.test.ts — 9 cases)*
- [x] 10.5 Unit test subdomain reservation: different wallet rejected, same wallet accepted, Route 53 record untouched on `frozen` transition *(subdomains.test.ts — 4 reservation cases; Route 53 untouched because frozen transition only writes DB columns)*
- [x] 10.6 Unit test scheduled-function dispatcher skip-on-dormant behavior *(scheduler.test.ts — scheduledInvocationAllowed pure-function coverage)*
- [ ] 10.7 E2E test (extension of `test:e2e` or new `test:lifecycle`): create project → expire lease → tick scheduler repeatedly → assert transitions → topup before purge → assert restoration → verify site serves throughout *(deferred — requires real infra and time simulation)*
- [ ] 10.8 E2E test: full purge path (lease expire → 100 simulated days → cascade runs → schema dropped → subdomain becomes claimable after 14-day tail) *(deferred — same reason)*

## 11. Documentation

- [x] 11.1 Add a "Project lifecycle" section to `CLAUDE.md` describing each state, timer, and the email cadence
- [x] 11.2 Document the `LIFECYCLE_ENABLED` feature flag in CLAUDE.md environment variables section *(documented inside the lifecycle section rather than a separate env-vars section, since CLAUDE.md doesn't have one)*
- [x] 11.3 Document the `POST /admin/projects/:id/reactivate` and `POST /admin/subdomains/:name/release` operator endpoints in the admin section of CLAUDE.md
- [x] 11.4 Add a note in `CLAUDE.md` explaining that legacy `status = 'archived'` rows are equivalent to `purged` but predate the grace window and have no recovery path

## 12. Deploy and verify

- [ ] 12.1 Stage the DB migration and a `LIFECYCLE_ENABLED=false` deploy first; confirm no behavior change and that old `checkWalletLeases` still operates on legacy `status = 'active'` rows as before
- [ ] 12.2 Flip `LIFECYCLE_ENABLED=true` in a follow-up deploy once the migration is observed stable for at least one business day
- [ ] 12.3 Monitor Bugsnag and the hourly tick logs for the first week post-flip; confirm that existing-past-lease projects transition to `past_due` cleanly on first tick
- [ ] 12.4 Confirm via production spot-check that a renewed project successfully transitions back to `active` with timer columns cleared
