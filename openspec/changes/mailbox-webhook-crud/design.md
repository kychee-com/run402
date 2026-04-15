## Context

The mailbox webhook API has a single POST for registration (`packages/gateway/src/routes/mailboxes.ts:260`). The `internal.email_webhooks` table already stores `id`, `mailbox_id`, `url`, `events`, `created_at`. No schema migration is needed — the 4 new routes are pure reads, deletes, and updates against this existing table.

All 4 routes follow the exact same auth/ownership pattern as the existing POST: `serviceKeyAuth` → `lifecycleGate` → verify `mailbox.project_id === req.project.id`.

## Goals / Non-Goals

**Goals:**
- Full CRUD on mailbox webhooks (list, get, update, delete) at parity with the existing POST
- CLI subcommands for webhook management (`run402 email webhooks {list,get,delete,update}`)
- MCP tools for all 4 operations
- API docs alignment (llms.txt, api-docs-alignment test, sync.test.ts)
- TDD with unit tests covering not-found, wrong-project 403, invalid events in PATCH, idempotent DELETE

**Non-Goals:**
- HMAC signing / webhook auth
- Bulk operations (delete all webhooks for a mailbox)
- Webhook delivery logs / retry status

## Decisions

### 1. Reuse the shared ownership-check pattern inline

The mailbox-fetch + project-ownership check is 5 lines and appears in the existing POST. Rather than extracting a middleware (premature abstraction for 5 routes), duplicate the pattern in each new handler.

**Why:** Three similar lines > premature abstraction. If a 6th webhook route appears, extraction becomes worthwhile.

### 2. PATCH for partial updates, not PUT

PATCH `/mailboxes/v1/:id/webhooks/:webhook_id` accepts `{ url?, events? }`. At least one field must be provided.

**Why:** Callers typically want to update the URL (e.g., new ngrok tunnel) without re-specifying events, or add an event type without changing the URL. PUT would require sending both fields every time.

### 3. DELETE returns 204 (idempotent)

DELETE a non-existent webhook_id returns 204, not 404. Deleting an already-deleted webhook is a no-op.

**Why:** Idempotent deletes simplify retry logic and deploy scripts. The caller's intent ("this webhook should not exist") is satisfied regardless of prior state.

### 4. List returns all webhooks, no pagination

`GET /mailboxes/v1/:id/webhooks` returns the full array. No cursor, no limit param.

**Why:** A mailbox will realistically have 1–3 webhooks. Pagination adds complexity for a list that will never exceed single digits.

### 5. Promote webhook routes to sync.test.ts entries

Currently `POST /mailboxes/v1/:id/webhooks` is in the "not yet exposed as tools" exemption list in `sync.test.ts`. All 5 webhook routes (existing POST + 4 new) should be promoted to full sync entries with MCP tool + CLI command mappings.

**Why:** The whole point of this change is to make webhooks a first-class managed resource. Leaving them in the exemption list contradicts that.

## Route specs

### GET /mailboxes/v1/:id/webhooks

```
Auth: serviceKeyAuth + lifecycleGate
Response 200: { webhooks: [{ webhook_id, url, events, created_at }] }
Response 404: Mailbox not found
Response 403: Mailbox owned by different project
```

### GET /mailboxes/v1/:id/webhooks/:webhook_id

```
Auth: serviceKeyAuth + lifecycleGate
Response 200: { webhook_id, url, events, created_at }
Response 404: Mailbox not found / Webhook not found
Response 403: Mailbox owned by different project
```

### DELETE /mailboxes/v1/:id/webhooks/:webhook_id

```
Auth: serviceKeyAuth + lifecycleGate
Response 204: Deleted (or already absent — idempotent)
Response 404: Mailbox not found
Response 403: Mailbox owned by different project
```

### PATCH /mailboxes/v1/:id/webhooks/:webhook_id

```
Auth: serviceKeyAuth + lifecycleGate
Body: { url?: string, events?: string[] }  (at least one required)
Note: events is a full replacement, not a merge. Sending events: ["delivery"]
replaces the entire array, even if the webhook previously had ["delivery", "bounced"].
Response 200: { webhook_id, url, events, created_at }
Response 400: No fields to update / Invalid event / Invalid URL
Response 404: Mailbox not found / Webhook not found
Response 403: Mailbox owned by different project
```

## CLI surface

New subcommand group under `run402 email`:

```
run402 email webhooks list              # GET /mailboxes/v1/:id/webhooks
run402 email webhooks get <webhook_id>  # GET /mailboxes/v1/:id/webhooks/:webhook_id
run402 email webhooks delete <webhook_id>  # DELETE
run402 email webhooks update <webhook_id> [--url <url>] [--events <e1,e2>]  # PATCH
```

Mailbox ID is resolved from project context (same as existing `email:send`).

## MCP tools

| Tool | Gateway endpoint |
|------|-----------------|
| `list_mailbox_webhooks` | GET /mailboxes/v1/:id/webhooks |
| `get_mailbox_webhook` | GET /mailboxes/v1/:id/webhooks/:webhook_id |
| `delete_mailbox_webhook` | DELETE /mailboxes/v1/:id/webhooks/:webhook_id |
| `update_mailbox_webhook` | PATCH /mailboxes/v1/:id/webhooks/:webhook_id |
