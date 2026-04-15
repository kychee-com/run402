# Tasks: mailbox-webhook-crud

## 1. Gateway routes

- [x] 1.1 Add `GET /mailboxes/v1/:id/webhooks` — list all webhooks for a mailbox. Query: `SELECT id, url, events, created_at FROM internal.email_webhooks WHERE mailbox_id = $1`. Return `{ webhooks: [...] }` with `webhook_id` alias for `id`. Auth: `serviceKeyAuth`, `lifecycleGate`, ownership check. [code]
- [x] 1.2 Add `GET /mailboxes/v1/:id/webhooks/:webhook_id` — get single webhook. Return 404 if webhook doesn't exist. [code]
- [x] 1.3 Add `DELETE /mailboxes/v1/:id/webhooks/:webhook_id` — delete webhook. Idempotent: return 204 whether row existed or not. [code]
- [x] 1.4 Add `PATCH /mailboxes/v1/:id/webhooks/:webhook_id` — update `url` and/or `events`. Validate at least one field provided. Reuse `validateURL` and `validEvents` check from POST. Return updated webhook. 404 if webhook not found. [code]

## 2. Gateway unit tests

- [x] 2.1 Add tests for GET list: returns empty array for mailbox with no webhooks, returns webhooks after POST. [code]
- [x] 2.2 Add tests for GET single: 200 on valid, 404 on missing webhook, 404 on missing mailbox, 403 on wrong project. [code]
- [x] 2.3 Add tests for DELETE: 204 on existing, 204 on already-deleted (idempotent), 404 on missing mailbox, 403 on wrong project. [code]
- [x] 2.4 Add tests for PATCH: 200 with url-only update, 200 with events-only update, 200 with both, 400 on no fields, 400 on invalid event, 404 on missing webhook, 403 on wrong project. [code]

## 3. Lint & type check

- [x] 3.1 `npm run lint` clean on `packages/gateway`. [code]
- [x] 3.2 `npx tsc --noEmit -p packages/gateway` clean (13 pre-existing errors, none from this change). [code]

## 4. API docs

- [x] 4.1 Add 4 rows to `site/llms.txt` mailboxes table (after the existing POST webhooks row at ~line 1130). Match format: path, method, auth, pricing, description. [code]
- [x] 4.2 Update `site/openapi.json` with Webhook schema + 4 new operations. Run `npm run test:docs` — 6/6 pass. [code]

## 5. CLI (run402-mcp)

- [x] 5.1 Extract `cli/lib/webhooks.mjs` with `list`, `get`, `delete`, `update`, `register` commands. Dispatched from `email.mjs` via `case "webhooks"`. [code]
- [x] 5.2 Update `--help` text for the email command to include webhook subcommands. [code]
- [x] 5.3 Add `openclaw/scripts/webhooks.mjs` re-export for OpenClaw parity. [code]

## 6. MCP tools (run402-mcp)

- [x] 6.1 Add `list_mailbox_webhooks`, `get_mailbox_webhook`, `delete_mailbox_webhook`, `update_mailbox_webhook`, `register_mailbox_webhook` tool definitions in `run402-mcp/src/tools/`. [code]
- [x] 6.2 Register all 5 tools in `src/index.ts` under the Email tools section. [code]
- [x] 6.3 Add MCP tool unit tests in `src/tools/mailbox-webhooks.test.ts` — 11 tests, all passing. [code]

## 7. Sync test

- [x] 7.1 Add 5 sync entries (register, list, get, delete, update) to `run402-mcp/sync.test.ts` using `webhooks:*` namespace. [code]
- [x] 7.2 Remove `POST /mailboxes/v1/:id/webhooks` from the "not yet exposed" exemption list. [code]
- [x] 7.3 Run sync.test.ts — 13/13 pass (including 0 skipped for llms.txt path). [code]

## 8. Archive

- [ ] 8.1 Move `openspec/changes/mailbox-webhook-crud/` to `openspec/changes/archive/2026-04-15-mailbox-webhook-crud/` after deploy + publish. [manual]
