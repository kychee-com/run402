# Proposal: mailbox-webhook-crud

**Status:** Ready to implement
**Severity:** Low — no data loss, no user-facing breakage. Functionally benign gap in API surface.

## Problem

The mailbox webhook API (`POST /mailboxes/v1/:id/webhooks`) supports registration only. There is no way to list, inspect, update, or delete registered webhooks. Every comparable email service (Resend, Postmark, SendGrid, Mailgun, SES) offers full CRUD.

This gap surfaced when KySigned's `deploy.ts` tried to check "is my webhook already registered?" before re-POSTing. The `GET` hit a 404 ("Cannot GET"). The deploy script tolerates this, but the missing operations affect:

- **Operator UX** — no way to audit what webhooks are firing for a mailbox.
- **Idempotent deploys** — callers must blindly re-register, accumulating duplicates.
- **Webhook hygiene** — stale URLs (old ngrok tunnels, decommissioned endpoints) can never be removed without direct DB access.

## What Changes

Add 4 routes to the gateway mailbox router, all with `serviceKeyAuth` + `lifecycleGate` + project-ownership check (matching the existing POST):

| Method | Path | Description |
|--------|------|-------------|
| GET | `/mailboxes/v1/:id/webhooks` | List all webhooks for a mailbox |
| GET | `/mailboxes/v1/:id/webhooks/:webhook_id` | Get one webhook |
| DELETE | `/mailboxes/v1/:id/webhooks/:webhook_id` | Unregister a webhook |
| PATCH | `/mailboxes/v1/:id/webhooks/:webhook_id` | Update url and/or events |

Propagate to all 4 surfaces: gateway routes, CLI (`run402 email webhooks {list,get,delete,update}`), MCP tools, and API docs (llms.txt + api-docs-alignment test).

## Storage

Existing `internal.email_webhooks` table — no schema change needed:

```sql
id         TEXT PRIMARY KEY,        -- whk_<ts>_<rand>
mailbox_id TEXT NOT NULL REFERENCES internal.mailboxes(id),
url        TEXT NOT NULL,
events     JSONB NOT NULL,          -- ["delivery", "bounced", ...]
created_at TIMESTAMPTZ DEFAULT NOW()
```

## Non-goals

- Auth/signing (HMAC secret on webhook payloads) — separate feature.
- Changing the POST shape, validation, or `webhook_id` format.
- Breaking changes to existing webhook behavior.
- KySigned changes — run402-only scope.

## Verification

- Unit tests in `mailbox.test.ts` or a new `mailbox-webhooks.test.ts` alongside the existing service tests.
- `api-docs-alignment.test.ts` updated to expect the 4 new routes.
- `sync.test.ts` in run402-mcp passes with 4 new entries.
- `npm run lint` + `npx tsc --noEmit -p packages/gateway` clean.
