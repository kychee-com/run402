## 1. PATCH route

- [x] 1.1 Add `PATCH /projects/v1/admin/:id/functions/:name` route in `packages/gateway/src/routes/functions.ts` with service_key auth
- [x] 1.2 Parse body: optional `schedule` (string | null), optional `config` ({ timeout?, memory? })
- [x] 1.3 Look up existing function row — return 404 if not found
- [x] 1.4 Schedule logic: validate cron, check tier limits (max count, min interval), persist to DB, register/cancel cron timer
- [x] 1.5 Config logic: validate against tier limits (timeout, memory), update DB row, call `UpdateFunctionConfigurationCommand` on Lambda (skip in local mode)
- [x] 1.6 Return 200 with updated function metadata

## 2. Docs and close

- [x] 2.1 Add PATCH row to admin endpoints table in `site/llms.txt`
- [x] 2.2 Add PATCH to `site/openapi.json`
- [x] 2.3 Type-check + lint + docs alignment
- [x] 2.4 Close GitHub issue #4
