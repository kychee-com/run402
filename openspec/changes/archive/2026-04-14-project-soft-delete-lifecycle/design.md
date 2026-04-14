## Context

Today's project end-of-life path is implemented in two files: `packages/gateway/src/services/leases.ts` runs hourly and, for any wallet whose `lease_expires_at < NOW() - 7 days`, calls `archiveProject(id)` in `packages/gateway/src/services/projects.ts` for each of that wallet's non-pinned active projects. `archiveProject` is an atomic destructive operation: it deletes Lambdas, releases subdomains (removing Route 53 records and freeing the name for anyone to claim), deletes S3 site files, tombstones the mailbox, removes the SES identity, drops the tenant's `p000X` schema via `resetSchemaSlot`, deletes users and refresh tokens, and sets `status = 'archived'`. There is no warning email, no grace window beyond the implicit 7 days, no subdomain reservation, and no restore.

By contrast, `packages/gateway/src/services/contracts-scheduler.ts` demonstrates a mature soft-delete pattern for KMS contract wallets: 90-day suspension with warning emails at days 60, 75, and 88, an auto-drain path to a recovery address, and an explicit "funds lost" notice. Projects and contract wallets are often owned by the same user; the lifecycle mismatch is a sharp asymmetry.

The saas-factory product pattern (see v1.18/v1.19 spec work in `saas-factory`) raises the stakes further: a product's brand *is* its subdomain, and tenant end-user data lives in the project schema. A missed renewal silently destroys both.

This design replaces the silent guillotine with a four-stage state machine that separates **control plane** (the owner's cockpit — deploys, secret rotation, subdomain claims) from **data plane** (the running site, tenant DB reads/writes, end-user traffic). Payment pressure is applied to the control plane; the data plane is preserved until the terminal purge.

## Goals / Non-Goals

**Goals:**
- End-users of saas-factory products experience zero disruption from their product owner's payment state until the very end of the grace window.
- Owners receive unambiguous, escalating signal (three emails across ~100 days) before any data is lost.
- A project's subdomain is reserved — not released — throughout grace, so a missed renewal cannot lose the brand name to a squatter.
- Renewal from any non-`active` state restores full control-plane access with zero data migration.
- Pinned projects continue to bypass lifecycle entirely.
- The KMS contract wallet and the project it belongs to follow comparable ~90-day clocks, not a 7-day vs 90-day mismatch.

**Non-Goals:**
- Per-end-user deletion on request (GDPR/CCPA). That is tenant code calling the project schema; run402 does not need to model it.
- Cold-storage backup of purged schemas. Out of scope for this change; a future `schema-cold-archive` capability could add it if operator demand arises.
- End-user-visible pressure (site banners, fork-badge injection, rate limiting tenant traffic). We explicitly chose not to punish end users for the owner's payment state.
- Billing or pricing changes. The rental rates, tier leases, and topup flows in `services/billing.ts` and `services/wallet-tiers.ts` are untouched.
- Reworking the existing cascade mechanics. The per-resource cleanup in `archiveProject` is already correct; we only change when it fires.

## Decisions

### Four states, not three

```
 active ──lease_exp──▶ past_due ──+14d──▶ frozen ──+30d──▶ dormant ──+60d──▶ purged
   ▲                       │                  │                │
   └────────renewal / topup / tier upgrade────┴────────────────┘
```

| State | Duration | Control plane | Data plane | Scheduled fns | Subdomain |
|---|---|---|---|---|---|
| `active` | ongoing | read+write | read+write | running | claimed by project |
| `past_due` | 14 days | read+write | read+write | running | claimed by project |
| `frozen` | 30 days | **read-only** | read+write | running | **reserved** |
| `dormant` | 60 days | **read-only** | read+write | **paused** | reserved |
| `purged` | terminal | n/a | n/a | n/a | free after short tail |

**Why four, not three or two:** a single "grace" state cannot express "cockpit locked but crons still run" distinctly from "cockpit locked and crons paused." The cron pause is a real cost lever for run402 and a real degradation signal for the owner, and deserves its own boundary.

**Alternative considered: two states (`active`, `grace`) with a single timer.** Rejected because it conflates the "cockpit locked" signal (experienced by owner) with the "product starts to degrade" signal (experienced indirectly through the product) — the owner should feel the first before the second.

### Owner vs end-user: enforced at the HTTP boundary

The control-plane write gate is a single middleware on admin/mutating routes. It reads `internal.projects.status` (cached) and returns `402 Payment Required` with a structured body (`{ lifecycle_state, entered_state_at, next_transition_at }`) when status is not `active`. Read endpoints (`GET /projects/:id`, dashboards, status queries) skip the gate so the owner can still see their project.

Data-plane routes (PostgREST, edge functions, email send/receive, storage) skip the gate entirely. They continue to consult `project.status` only for the `purged` terminal state (schema is gone, so routing fails naturally).

**Alternative considered: DB-level read-only role swap at `frozen`.** Rejected — this punishes end users for owner behavior, which violates the zero-disruption goal. The user explicitly called this out in design discussion.

**Alternative considered: gate per-endpoint rather than middleware.** Rejected — easy to miss a mutating route and silently allow writes. Middleware default-denies on `status != 'active'` and individual routes opt out only for reads.

### Cron pause at `dormant`, not earlier

Scheduled functions pause when a project enters `dormant`. The scheduled-function dispatcher gains a `status IN ('active', 'past_due', 'frozen')` predicate; anything else is skipped with a log entry.

**Why dormant and not frozen:** frozen is meant to lock the cockpit without degrading the product. Pausing crons at frozen would mean an owner who pays the morning after getting the frozen email finds their nightly digest already missed, which reads as "run402 is flaky" rather than "I forgot to pay." Dormant is 44 days past lease expiry — by then the signal is unmistakable.

### Subdomain reservation through `internal.subdomains` columns

Add two columns to `internal.subdomains`:
- `reserved_for_project_id uuid` — set when the owning project enters `frozen`.
- `reserved_until timestamp` — set to `project.scheduled_purge_at + 14 days` (a short tail past the purge itself, to cover DNS TTL and give last-minute renewers a window).

The subdomain claim endpoint rejects claims where `reserved_for_project_id IS NOT NULL AND reserved_until > NOW()` unless the claiming project's wallet matches the original owner's wallet (which covers "owner spun up a fresh project and wants the name back"). When a subdomain transitions into reservation, its Route 53 record stays intact; the edge routing keeps serving the site.

**Alternative considered: new `internal.subdomain_reservations` table.** Rejected as overkill — each subdomain has at most one reservation at a time, and the columns are always populated from the owning project, so a separate table adds a join without gaining anything.

### Database: widen the `status` CHECK, add timer columns, keep `archived` for legacy

```sql
ALTER TABLE internal.projects
  DROP CONSTRAINT projects_status_check,
  ADD CONSTRAINT projects_status_check
    CHECK (status IN ('active', 'past_due', 'frozen', 'dormant', 'purged', 'archived'));

ALTER TABLE internal.projects
  ADD COLUMN past_due_since      timestamptz,
  ADD COLUMN frozen_at           timestamptz,
  ADD COLUMN dormant_at          timestamptz,
  ADD COLUMN scheduled_purge_at  timestamptz;

ALTER TABLE internal.subdomains
  ADD COLUMN reserved_for_project_id uuid,
  ADD COLUMN reserved_until          timestamptz;
```

The legacy `archived` value is kept so existing archived rows remain readable. New terminal-state rows use `purged`. `archived` is documented as "pre-lifecycle tombstone; equivalent to purged" in CLAUDE.md.

**Alternative considered: rename `archived` → `purged` with a data migration.** Rejected — the existing archived rows have no schema to restore, so the label distinction is useful as a marker of "this project died under the old regime, we have no grace record for it."

### Transitions driven by the existing hourly scheduler

`leases.ts` is rewritten. Instead of calling `archiveProject` directly, it calls a new `advanceLifecycle()` that, for each project:
1. If wallet lease is expired and status is `active` → set status `past_due`, stamp `past_due_since`, enqueue `past_due` email.
2. If status is `past_due` and `past_due_since < NOW() - 14d` → set status `frozen`, stamp `frozen_at`, write subdomain reservation rows, enqueue `frozen` email.
3. If status is `frozen` and `frozen_at < NOW() - 30d` → set status `dormant`, stamp `dormant_at`, compute `scheduled_purge_at = NOW() + 60d`.
4. If status is `dormant` and `NOW() > scheduled_purge_at - 24h` and no `purge_warning_sent_at` → enqueue 24h-warning email, stamp marker.
5. If status is `dormant` and `NOW() >= scheduled_purge_at` → call `purgeProject(id)` (the renamed current `archiveProject` body, which runs the full cascade).

If a wallet's lease is renewed or a topup moves `lease_expires_at` forward, `advanceLifecycle()` resets status to `active` and clears the four timer columns. Subdomain reservations revert to normal claimed state on the same transaction.

**Why in-place in the existing scheduler:** `checkWalletLeases` already runs hourly and already has the wallet → projects join. Reusing the same tick keeps operational surface area at one cron, same as today.

### Email cadence: three emails, reusing the wallet warning infra

| Trigger | Subject (approximate) | Template name |
|---|---|---|
| Enter `past_due` | "Your run402 project is behind on payment" | `project_past_due` |
| Enter `frozen` | "Your run402 project is frozen — deploys disabled" | `project_frozen` |
| 24h before purge | "Final notice: your run402 project will be permanently deleted tomorrow" | `project_purge_final_warning` |

The wallet scheduler's `lookupBillingEmailForWallet` in `services/contracts-scheduler.ts` generalizes cleanly — we extract a `lookupBillingEmailForProject(projectId)` helper and reuse `sendPlatformEmail` as-is. No new SES identities, no new send path.

**Alternative considered: four emails (add a halfway-through-frozen reminder).** Rejected for initial implementation; three is enough to avoid the "silent death" complaint, and we can add a fourth later if bounce analytics show owners still missing the window.

### Reactivation: no explicit endpoint needed; piggyback on topup

The existing topup/tier-renewal flows in `services/wallet-tiers.ts` and `services/billing.ts` update `lease_expires_at` on the billing account. We add a post-update hook that calls `advanceLifecycle()` for every project under that wallet, which handles the `→ active` transition centrally. No new public endpoint is required.

An internal-only `POST /admin/projects/:id/reactivate` is added for operator rescue scenarios (e.g., billing edge case the topup hook missed). This is admin-authed, not user-facing.

## Risks / Trade-offs

- **Risk: subdomain reservation columns block reclaim if the original wallet is lost.** → Mitigation: the operator endpoint `POST /admin/subdomains/:name/release` clears `reserved_for_*` columns for operator-mediated disputes. Same pattern as existing admin operations.

- **Risk: a purge race where two hourly ticks both see `NOW() >= scheduled_purge_at` and both call `purgeProject`.** → Mitigation: the transition query is `UPDATE ... WHERE status = 'dormant' AND scheduled_purge_at <= NOW() RETURNING id` — only the first tick captures the id; the second sees zero rows. The existing `archiveProject` body already handles "schema already dropped" defensively via `DROP SCHEMA IF EXISTS`.

- **Risk: scheduled-function pause at `dormant` surprises owners whose crons silently stop.** → Mitigation: the `frozen` email explicitly names the upcoming cron pause date ("your scheduled functions will pause on YYYY-MM-DD if the project stays frozen"), and the `dormant` email confirms it happened.

- **Risk: database churn from writing timer columns on every hourly tick.** → Mitigation: the transition queries are `UPDATE ... WHERE status = <prev> AND <timer> < NOW() - <threshold>` — rows in steady state do not match and are not rewritten. Only transitioning rows incur writes.

- **Trade-off: ~100 days from expiry to purge is long.** Storage cost is real — an inactive `p000X` schema plus S3 site files can be megabytes to gigabytes. Acceptable because the alternative (today's 7-day silent destruction) is the problem being fixed. If cost becomes material, a future change can pause storage metering for dormant projects while keeping the data on disk.

- **Trade-off: reserving subdomains blocks new users from claiming dead-looking names.** Someone browsing available names will see a "reserved" error for up to ~114 days after an owner disappears. Acceptable — the alternative is the brand-squat hole. The error message explicitly surfaces "reserved, becomes available on YYYY-MM-DD" so curious claimants understand.

- **Trade-off: no cold-storage archive.** Purged data is still gone forever at day ~100. A spiteful or distracted owner who ignores three emails across three months cannot recover. We accept this rather than bloat scope; the email cadence is the safety net.

## Migration Plan

1. **Database migration:** add new columns, widen CHECK constraint. Existing rows default to NULL timers; only rows transitioning into `past_due` onward will populate them.
2. **Deploy ordering:** the new middleware and lifecycle scheduler must deploy together — an old gateway hitting new DB columns is fine, but a new gateway expecting transitions on an old DB without the columns crashes. Deploy is a single gateway image push, so this is not a split deploy.
3. **Backfill:** no backfill. Rows currently in `status = 'archived'` stay as-is. Rows currently in `status = 'active'` with already-expired leases (> 7 days past expiry) enter `past_due` on the first post-deploy tick, which is the desired graceful transition — they get the past_due email as if they had just expired.
4. **Rollback:** if the lifecycle scheduler misbehaves, revert to the previous gateway image. The DB columns are additive; old code ignores them. Rows mid-lifecycle at rollback time stay mid-lifecycle — old code won't advance them, but also won't destroy them (old `checkWalletLeases` filters to `lease_expires_at < NOW() - 7d` AND `status = 'active'`, and mid-lifecycle rows have `status IN ('past_due', 'frozen', 'dormant')`, so they are safe from the old destructive path too).
5. **Email templates:** ship alongside the code change. Templates live in the gateway image, not in SES.
6. **Feature flag (optional):** a `LIFECYCLE_ENABLED=true` env var gates the new scheduler logic for the first deploy. Default false for one deploy cycle so the DB migration lands first; flip to true on the next deploy once observed stable.
