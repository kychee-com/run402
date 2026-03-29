## Why

`POST /deploy/v1` does not support deploying functions with cron schedules. Apps that use scheduled functions must do a two-phase deploy: bundle deploy first (code only), then individual `POST /projects/v1/admin/:id/functions` per function with the schedule field. This is fragile and means bundle deploy cannot fully express an app's desired state in one call.

## What Changes

- Add optional `schedule` field to the `BundleFunction` interface
- In `deployBundle`, after deploying each function, apply the schedule (validate cron, check tier limits, persist to DB, register cron timer) — same logic as the individual function deploy route
- Bundle validation rejects invalid cron expressions early (before any deploy step runs)

## Capabilities

### New Capabilities
- `bundle-function-schedule`: Support for `schedule` field in bundle deploy functions array. Covers validation, tier limit checks, DB persistence, and cron registration within the bundle deploy flow.

### Modified Capabilities

_(none)_

## Impact

- **Gateway code**: `packages/gateway/src/services/bundle.ts` — `BundleFunction` interface gains `schedule?`, `validateBundle` checks cron syntax, `deployBundle` persists schedule + registers cron after each function deploy.
- **API**: `POST /deploy/v1` body gains optional `schedule` field per function. Backwards-compatible — omitting it behaves the same as today.
- **Docs**: `site/llms.txt` bundle deploy section should mention the schedule field.
