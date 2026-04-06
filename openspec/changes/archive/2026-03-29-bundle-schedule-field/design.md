## Context

The individual function deploy route (`POST /projects/v1/admin/:id/functions` in `routes/functions.ts`) handles schedule as a three-step process after `deployFunction()` returns:
1. Validate cron expression (`isValidCron`)
2. Check tier limits (min interval, max scheduled count)
3. Persist to DB + register/cancel cron timer

The bundle deploy (`services/bundle.ts`) calls `deployFunction()` with `undefined` for the schedule parameter. The schedule logic from the route handler needs to be extracted and shared.

## Goals / Non-Goals

**Goals:**
- `BundleFunction` gains `schedule?: string | null`
- Bundle deploy validates, enforces tier limits, persists, and registers schedules
- Same tier limit enforcement as individual deploy (max count, min interval)

**Non-Goals:**
- Refactoring schedule logic into a shared helper (the logic is ~20 lines, inline is fine for now)
- Adding `schedule` to the bundle deploy response (the functions array already returns `{ name, url }` — adding schedule metadata is a separate concern)

## Decisions

### Inline the schedule logic in deployBundle

Rather than extracting a shared helper, duplicate the ~20 lines of schedule logic (validate, tier check, DB persist, register cron) in `deployBundle` after each `deployFunction` call. This matches the existing pattern — the route handler also inlines it.

**Why:** The schedule logic depends on request-level context (tier config, project ID, pool queries). Extracting a helper would require passing 5+ parameters for 20 lines of code. Not worth the abstraction yet.

### Validate all schedules upfront in validateBundle

Check cron syntax in `validateBundle` before any deploy step runs. This fails fast on invalid expressions without partially deploying functions.

Tier limits (max count, min interval) are checked per-function during deploy, not upfront — because the count depends on what's already deployed in the DB.

## Risks / Trade-offs

**[Risk] Schedule count check is per-function, not batched** → If a bundle deploys 3 functions with schedules and the tier limit is 1, the first succeeds and the second fails. This leaves a partially-deployed bundle. Mitigation: this is the same behavior as deploying functions individually, and the error message is actionable ("limit reached, remove a schedule or upgrade").
