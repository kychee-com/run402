## Why

Updating a function's schedule, timeout, or memory requires re-deploying the entire function via `POST /projects/v1/admin/:id/functions` — re-sending the source code, re-transpiling, re-packaging a Lambda zip, and calling CreateFunction/UpdateFunctionCode. This takes 2-5 seconds for what is fundamentally a DB column update + cron timer swap (~5ms). It also means the caller must have the source code on hand, which bundle-deployed apps don't retain.

## What Changes

- Add `PATCH /projects/v1/admin/:id/functions/:name` endpoint for metadata-only updates
- Supports updating `schedule` (cron expression or null), `config.timeout`, and `config.memory`
- Schedule changes: validate cron, check tier limits, persist to DB, register/cancel cron timer — no Lambda redeploy
- Config changes (timeout/memory): update DB + call `UpdateFunctionConfiguration` on Lambda — no code re-upload
- All fields are optional — send only what you want to change

## Capabilities

### New Capabilities
- `patch-function-metadata`: PATCH endpoint for updating function metadata without code redeploy. Covers schedule updates (set/remove/change), config updates (timeout/memory), tier limit enforcement, and Lambda configuration updates.

### Modified Capabilities

_(none)_

## Impact

- **Gateway code**: New route in `packages/gateway/src/routes/functions.ts`. Reuses existing scheduler and Lambda infrastructure.
- **API surface**: New endpoint `PATCH /projects/v1/admin/:id/functions/:name`. Additive, not breaking.
- **Docs**: `site/llms.txt` admin endpoints table needs the new PATCH row. `site/openapi.json` needs the endpoint.
