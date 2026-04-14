## Why

Operators (platform admins with `@kychee.com` identity, or holders of `ADMIN_KEY`) can perform privileged actions on any project or wallet — pin/unpin, reassign wallet address, drip from the faucet, run admin SQL, reactivate grace-state projects, release subdomain reservations, credit/debit billing accounts. Each action currently emits a `console.log` line that flows to CloudWatch (`/agentdb/gateway`) with ~30-day retention. That's fine for "what happened last Tuesday" but falls apart for questions like: "who reactivated customer X's dormant project on day 89?", "which admin ran the SQL that dropped this column?", "show me every privileged action on wallet Y over the past six months".

The existing lifecycle change (`project-soft-delete-lifecycle`, already shipped) explicitly de-scoped a lifecycle-specific audit table (task 8.3) to avoid duplicating state that belongs in a centralized feature. This change picks that up and models a single operator-actions audit covering every privileged write across the platform.

## What Changes

- New table `internal.operator_actions` persisting one row per privileged admin action: event type, operator identity, affected project / wallet / subdomain, previous and new state (if applicable), optional free-text reason, timestamp.
- A small helper in `services/operator-audit.ts` that all admin handlers call after their action commits, centralizing the identity resolution (`getAdminSession(req)?.email` vs `ADMIN_KEY` vs `SIWX admin wallet`) and the INSERT.
- Instrument every admin-authed mutating endpoint to call the helper. In scope at minimum:
  - `POST /projects/v1/admin/:id/pin` / `unpin`
  - `POST /projects/v1/admin/:id/reactivate` (lifecycle)
  - `POST /projects/v1/admin/:id/wallet` (wallet reassignment)
  - `POST /projects/v1/admin/:id/sql` (admin SQL)
  - `POST /projects/v1/admin/:id/rls` (RLS template apply)
  - `POST /subdomains/v1/admin/:name/release` (lifecycle)
  - `POST /billing/v1/admin/accounts/:wallet/credit` / `debit`
  - `POST /faucet/v1/admin` (manual drip)
  - `DELETE /apps/v1/admin/:version_id` (admin version delete)
- Optional follow-on (out of scope for this change): an admin dashboard page surfacing the audit log filterable by project / wallet / operator / time window.
- Optional follow-on: retention policy (e.g. partition by month, archive old rows to S3) — start with unbounded retention and add if the table grows enough to matter.

## Capabilities

### New Capabilities
- `operator-actions-audit`: Persistent, queryable record of every privileged admin action against the platform. One table, one write helper, one convention applied across every admin-authed mutating endpoint.

### Modified Capabilities
- `admin-operations`: Every admin-mutating endpoint gains a post-commit call to the audit helper. No change to request/response shape; purely additive persistence.

## Impact

- **Database:** new `internal.operator_actions` table. Expect low write rate (admin actions are rare) and small row size (~200 bytes). No indexes beyond `(created_at DESC)` and a partial on `(project_id)` / `(wallet_address)` for lookup.
- **Code:** new `services/operator-audit.ts` (~50 lines), plus a one-line call site added to every admin handler.
- **Risk:** if the audit INSERT fails we must NOT roll back the admin action (action already succeeded on-chain / in DB). Helper catches and logs — the action completes, audit is best-effort-but-logged.
- **No user-facing API change.** All reads of the audit log are admin-dashboard / ad-hoc SQL for now.
- **Succeeds task 8.3** in the `project-soft-delete-lifecycle` change, which was de-scoped pending this centralized feature.
