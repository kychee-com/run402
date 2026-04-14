## Why

Today an expired project is destroyed seven days after lease expiry with no warning email, no soft-delete window, and no restore path — the schema is dropped, subdomains released into a squat-able namespace, Lambdas deleted, and the `archived` row left as a tombstone. For a plain pay-per-use API this is annoying; for saas-factory products (where the subdomain *is* the brand and tenant end-user data lives in the project schema) it is a landmine: one missed renewal tick permanently destroys a live product and frees its name for anyone to claim. The contract-wallet system already does this correctly (90-day grace, three warning emails, recovery path); projects and wallets owned by the same user should not be on wildly different clocks.

## What Changes

- **BREAKING (behavior):** Replace the current 7-day silent-then-destroy path with a four-stage state machine: `active → past_due → frozen → dormant → purged`, spanning ~100 days from lease expiry to irreversible destruction.
- Add owner-facing email cadence at each transition (lease expiry, entry to `frozen`, 24h before `purged`), reusing the `sendPlatformEmail` + `lookupBillingEmail*` pattern already proven for KMS wallets.
- Introduce a **control-plane write gate**: when a project is not `active`, run402 admin/control-plane endpoints (deploys, subdomain claims, secret rotation, function upload, billing plumbing) return `402 Payment Required`. Read endpoints stay open so owners can see what's going on.
- **Data plane is untouched** until `purged`. Live sites continue serving, end users keep reading and writing the project schema, email send/receive continues. The owner feels pressure; end users do not.
- Pause **scheduled functions** on entry to `dormant` (not earlier) to cut ongoing compute cost while preserving the running site.
- **Subdomain reservation** starts at `frozen`: the name is held for the original owner and returns `409 reserved` to anyone else attempting to claim it. Reservation persists through `dormant` and for a short tail after `purged`.
- Any transition from a non-`active` state back to `active` (renewal, topup, tier upgrade) restores full control-plane access with no data migration needed.
- `pinned` remains the internal run402-admin escape hatch: pinned projects bypass this state machine entirely, as they do today.
- Per-end-user deletion on request (GDPR/CCPA) is explicitly **out of scope** — that belongs in tenant code against the project schema, not in platform lifecycle.

## Capabilities

### New Capabilities
- `project-lifecycle`: The four-stage soft-delete state machine — status transitions, timer fields on `internal.projects`, the scheduler tick that drives transitions, the email cadence, the control-plane write gate, scheduled-function pause at `dormant`, and subdomain reservation semantics during grace.

### Modified Capabilities
- `cascade-project-delete`: The existing cascade (Lambda deletion, S3 site teardown, schema drop, mailbox tombstone, SES identity cleanup, secrets/users/tokens delete) is no longer triggered at `lease_expires_at + 7d`. It now fires only on the terminal `purged` transition, after the full grace has elapsed. The cascade's internal behavior is unchanged; its trigger moves.

## Impact

- **Database:** `internal.projects` gains lifecycle timer columns (`past_due_since`, `frozen_at`, `dormant_at`, `scheduled_purge_at`) and its `status` CHECK constraint widens to include `past_due`, `frozen`, `dormant`. `internal.subdomains` gains a reservation marker (e.g., `reserved_for_project_id`, `reserved_until`).
- **Code:** `packages/gateway/src/services/leases.ts` rewritten to advance state rather than call `archiveProject` directly. New module `project-lifecycle.ts` owns transitions. New middleware on admin/control-plane routes. `archiveProject` in `services/projects.ts` renamed/split into `purgeProject` (terminal cascade) and `reactivateProject` (transition back to active from any grace state). Scheduled-function dispatcher gains a status check.
- **APIs:** Admin/control-plane mutating endpoints return 402 with a `lifecycle_state` payload when gated. A new operator endpoint `POST /admin/projects/:id/reactivate` handles the renewal-restores-access path if not already covered by existing topup flows. Read endpoints (`GET /projects/:id`, dashboards) return the new status values.
- **Emails:** Three new templates (past_due notice, frozen notice, 24h-until-purge final warning) added alongside existing KMS wallet warning emails.
- **Operations:** The scheduler tick that owns lifecycle transitions runs hourly (same cadence as today's `checkWalletLeases`). No new AWS resources required.
- **Docs:** `CLAUDE.md` gains a section describing the lifecycle so operators understand what each status means.
- **Risk:** Existing rows currently in `status = 'archived'` are already past the point of recovery (their schemas are dropped). They remain as-is; the new states apply only to projects whose leases expire after deployment.
