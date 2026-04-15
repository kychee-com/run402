# Plan: mailbox-webhook-crud

**Owner:** Barry Volinskey
**Created:** 2026-04-15
**Status:** Complete
**Spec:** `openspec/changes/mailbox-webhook-crud/proposal.md` + `openspec/changes/mailbox-webhook-crud/design.md`
**Spec-Version:** unversioned
**Source:** spec
**Worktree:** none

## Legend
- `[ ]` Todo | `[~]` In Progress | `[x]` Done

---

## Design Decisions

Design decisions are documented in `openspec/changes/mailbox-webhook-crud/design.md`. Summary:

### DD-1: Inline ownership check (no middleware extraction)
- **Alternatives:** Extract shared middleware for mailbox-fetch + project-ownership
- **Chosen because:** 5 routes doesn't justify abstraction; 5 lines duplicated is clearer than indirection
- **Trade-offs:** Slight duplication across 5 handlers
- **Rollback:** Extract later if a 6th+ route appears

### DD-2: PATCH with full-replace semantics on events array
- **Alternatives:** Merge/append semantics, PUT requiring all fields
- **Chosen because:** Callers typically update one field; merge creates ambiguity around event removal
- **Trade-offs:** Caller must send full events array to change one event
- **Rollback:** N/A — additive change

### DD-3: Idempotent DELETE (204 always)
- **Alternatives:** 404 on missing webhook
- **Chosen because:** Simplifies retry logic and deploy scripts; caller intent is "should not exist"
- **Trade-offs:** Caller can't distinguish "deleted" from "never existed" — acceptable for this resource
- **Rollback:** N/A

### DD-4: Promote webhooks to sync.test.ts (out of exemption list)
- **Alternatives:** Keep in exemption list, add only new 4 routes
- **Chosen because:** Whole point is making webhooks first-class; exempting contradicts that
- **Trade-offs:** Requires CLI + MCP tools for existing POST too (task 5.4)
- **Rollback:** Move back to exemption list

---

## Tasks

### Phase 1: Gateway routes (`packages/gateway/src/routes/mailboxes.ts`)

- [x] 1.1 Add `GET /mailboxes/v1/:id/webhooks` — list webhooks. Query `SELECT id, url, events, created_at FROM internal.email_webhooks WHERE mailbox_id = $1`. Return `{ webhooks: [{ webhook_id, url, events, created_at }] }`. Auth: `serviceKeyAuth`, `lifecycleGate`, ownership check (same pattern as POST at line 260). [code]
- [x] 1.2 Add `GET /mailboxes/v1/:id/webhooks/:webhook_id` — get single webhook. Join on `mailbox_id` to verify ownership. 404 if webhook or mailbox not found, 403 if wrong project. [code]
- [x] 1.3 Add `DELETE /mailboxes/v1/:id/webhooks/:webhook_id` — delete webhook. `DELETE FROM internal.email_webhooks WHERE id = $1 AND mailbox_id = $2`. Return 204 regardless of rowCount (idempotent). [code]
- [x] 1.4 Add `PATCH /mailboxes/v1/:id/webhooks/:webhook_id` — update url and/or events. Require at least one field. Reuse `validateURL` and `validEvents` array from existing POST. Build dynamic `SET` clause. 404 if webhook not found (check rowCount). Return updated row. [code]

### Phase 2: Gateway unit tests

Tests go in `packages/gateway/src/routes/mailboxes-raw.test.ts` or a new sibling file. Use the same mock pattern as `packages/gateway/src/services/mailbox.test.ts`.

- [x] 2.1 Tests for GET list: empty array when no webhooks, populated array after insert, 404 on missing mailbox, 403 on wrong project. [code]
- [x] 2.2 Tests for GET single: 200 with correct shape, 404 on missing webhook, 404 on missing mailbox, 403 on wrong project. [code]
- [x] 2.3 Tests for DELETE: 204 on existing webhook, 204 on already-deleted (idempotent), 404 on missing mailbox, 403 on wrong project. [code]
- [x] 2.4 Tests for PATCH: 200 with url-only, 200 with events-only, 200 with both, 400 on empty body, 400 on invalid event name, 400 on invalid URL, 404 on missing webhook, 403 on wrong project. [code]

### Phase 3: Lint & type check

- [x] 3.1 `npm run lint` clean on `packages/gateway`. [code]
- [x] 3.2 `npx tsc --noEmit -p packages/gateway` (13 pre-existing errors in lifecycle-gate/admin/projects — none from webhook CRUD) clean. [code]

### Phase 4: API docs

- [x] 4.1 Add 4 rows to `site/llms.txt` mailboxes table after the existing `POST /mailboxes/v1/:id/webhooks` row (~line 1130). Format: `| /mailboxes/v1/:id/webhooks | GET | service_key | Free | List webhooks for a mailbox |` etc. [code]
- [x] 4.2 Run `npm run test:docs` (`test/api-docs-alignment.test.ts`). The 4 new routes will be auto-discovered from the route files. If they're not in llms.txt the test fails — task 4.1 fixes that. If the test expects them in the exemption list, do NOT add them there (they belong in docs now). [code]

### Phase 5: CLI (`run402-mcp/cli/lib/email.mjs`)

- [x] 5.1 Add a `webhooks` subcommand group to the `run()` export. Dispatch: `run402 email webhooks list`, `run402 email webhooks get <id>`, `run402 email webhooks delete <id>`, `run402 email webhooks update <id> [--url <url>] [--events <e1,e2>]`. Extracted to `cli/lib/webhooks.mjs` to keep scanner clean. [code]
- [x] 5.2 Implement `webhooksList()` — resolve mailbox_id from project, `GET /mailboxes/v1/:id/webhooks`, print table. [code]
- [x] 5.3 Implement `webhooksGet(id)`, `webhooksDelete(id)`, `webhooksUpdate(id, opts)` — same auth pattern. [code]
- [x] 5.4 Add `webhooksRegister()` for existing POST — `run402 email webhooks register --url <url> --events <e1,e2>`. This promotes POST to a CLI command (required by DD-4). [code]
- [x] 5.5 Update `HELP` string to include webhooks subcommands. [code]

### Phase 6: MCP tools (`run402-mcp/src/tools/`)

- [x] 6.1 Create `list-mailbox-webhooks.ts` — schema: `{ project_id }`, handler: resolve mailbox_id → `GET /mailboxes/v1/:id/webhooks`. Follow `get-mailbox.ts` pattern. [code]
- [x] 6.2 Create `get-mailbox-webhook.ts` — schema: `{ project_id, webhook_id }`. [code]
- [x] 6.3 Create `delete-mailbox-webhook.ts` — schema: `{ project_id, webhook_id }`. [code]
- [x] 6.4 Create `update-mailbox-webhook.ts` — schema: `{ project_id, webhook_id, url?, events? }`. [code]
- [x] 6.5 Create `register-mailbox-webhook.ts` — schema: `{ project_id, url, events }`. Wraps existing POST. Required by DD-4 to promote POST out of exemption list. [code]
- [x] 6.6 Register all 5 tools in `src/index.ts` under the `// ─── Email tools` section. Import schemas + handlers. [code]
- [x] 6.7 Add MCP tool unit tests (`.test.ts` files) following the pattern of `get-mailbox.test.ts`. [code]

### Phase 7: Sync test (`run402-mcp/sync.test.ts`)

- [x] 7.1 Add 5 sync entries after the email section (~line 214). One for each: register (existing POST, promoted), list, get, delete, update. Format: `{ id, endpoint, mcp, cli, openclaw }`. [code]
- [x] 7.2 Remove `"POST /mailboxes/v1/:id/webhooks"` from the exemption list (~line 508). [code]
- [x] 7.3 Run `sync.test.ts` and verify all entries pass. [code]

### Phase 8: run402-mcp update & publish

- [x] 8.1 Run `/update` skill in `run402-mcp` to sync docs, tables, and prepare for publish. (No /update skill exists — handled manually.) [ship]
- [x] 8.2 Run `/publish` skill in `run402-mcp` — v1.33.0 published to npm, tagged, GH release created, llms-cli.txt updated. [ship]

### Phase 9: OpenSpec update

- [x] 9.1 Update `openspec/changes/mailbox-webhook-crud/tasks.md` — mark all tasks `[x]` to match completed work. [code]

---

## Implementation Log

_Populated during implementation by `/implement`. Captures discoveries, gotchas, deviations, and emergent decisions found while coding._

### Gotchas

- sync.test.ts scanner uses a flat `case "word":` regex across entire files. Inline webhook functions in email.mjs caused the scanner to find `email:delete`, `email:register`, `email:update` as phantom commands alongside the real `email:webhooks` dispatch.

### Deviations

- **CLI structure:** Extracted webhook commands to `cli/lib/webhooks.mjs` (separate module) instead of inlining in `email.mjs`. This keeps the sync test scanner clean. `email.mjs` dispatches `webhooks` via dynamic import. Sync table uses `webhooks:*` namespace instead of `email:webhooks *`.
- **CLI_DISPATCH_COMMANDS:** Added an exclusion list to sync.test.ts for routing-prefix commands (`email:webhooks`) that the scanner finds but aren't leaf commands.
- **openapi.json:** Added Webhook schema + 4 new operations. Used inline error responses since `BadRequest`/`NotFound` shared refs didn't exist.

---

## Log

- 2026-04-15: Plan created from approved spec.
- 2026-04-15: Phases 1-7 complete. 4 gateway routes + 20 unit tests, llms.txt + openapi.json updated, CLI webhooks.mjs + 5 MCP tools + 11 MCP tests, sync.test.ts all green (13/13). Full test command: `node --experimental-test-module-mocks --test --import tsx packages/gateway/src/routes/mailboxes-webhooks.test.ts` (gateway), `npx tsx --test sync.test.ts` (mcp), `npm run test:docs` (docs).
