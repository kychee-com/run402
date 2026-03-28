## Why

Run402's email system has solid infrastructure (SES, rate limits, suppression, bounce handling, inbound replies, webhooks) but the composition layer is locked to 3 fixed templates. The `notification` template caps at 500 chars of plain text. This blocks any app that needs rich emails — welcome messages with logos, event confirmations with details, weekly digests, renewal reminders. Wild Lychee alone needs 5+ email types that don't fit the existing templates.

The current workaround is calling an external email API (Resend, SES direct) from an edge function — which bypasses Run402's rate limits, suppression checks, and bounce handling. Making the platform email more capable actually improves safety by keeping traffic in the monitored pipeline.

## What Changes

### 1. Raw HTML send mode

Add a raw-body mode to the existing `POST /v1/mailboxes/:id/messages` endpoint. When the request includes `subject` + `html` (and no `template`), the system sends a custom email instead of rendering a template. Optional `text` field for plaintext fallback; auto-stripped from HTML when omitted. HTML body capped at 1MB. The Run402 transparency footer is appended to both HTML and plaintext bodies.

### 2. Display name support

Add an optional `from_name` field to the send endpoint. Renders as `"Display Name" <slug@mail.run402.com>` in the From header. Agents can brand their emails without a custom domain.

### 3. Team tier daily limit bump

Raise the team tier daily send limit from 200 to 500. A 400-member community sending a weekly newsletter fits within the limit with room for transactional emails throughout the day.

### 4. `email.send()` functions runtime helper

Add `email` as a first-class export from `@run402/functions`, alongside `db` and `getUser`. Supports both template mode and raw HTML mode via the same function signature. Under the hood, calls the gateway mailbox API using the injected service key. Caches the mailbox ID after first lookup.

### 5. Inbound reply E2E test

Add a real E2E test that sends an outbound email, replies to it via SES, and verifies the reply appears in the message thread via the API. Tests the full inbound pipeline: SES receipt rule -> S3 -> Lambda -> DB -> API.

## Capabilities

### New Capabilities
- `email-raw-send`: Raw HTML email composition with subject, html body, optional plaintext fallback, display name, and 1MB size limit.
- `functions-email-helper`: First-class `email.send()` in the functions runtime supporting both template and raw modes.

### Modified Capabilities
- `email-send`: Existing endpoint gains raw mode (subject + html fields), from_name field, and auto-generated plaintext fallback.
- `email-send` spec: Team tier daily limit changes from 200 to 500.

## Impact

- **Gateway email service** (`packages/gateway/src/services/email-send.ts`): raw mode detection, HTML size validation, plaintext auto-generation, from_name rendering, footer injection into HTML
- **Gateway routes** (`packages/gateway/src/routes/mailboxes.ts`): no route changes — same endpoint, new fields
- **Tier config** (`packages/shared/src/tiers.ts`): team `emailsPerDay` 200 -> 500
- **Functions runtime** (`packages/functions-runtime/`): new `email.send()` helper + mailbox ID discovery/caching
- **Lambda layer**: must be rebuilt and published after functions-runtime changes
- **E2E tests** (`test/email-e2e.ts`): new inbound reply test sequence
- **OpenAPI + llms.txt** (`site/openapi.json`, `site/llms.txt`): document new fields on the send endpoint
- **MCP server** (separate repo): `send_email` tool gains raw mode params (out of scope, tracked separately)

## Non-goals

- Batch/bulk send endpoint — agents loop over recipients; 500/day limit is the governor
- Custom email domains — `slug@mail.run402.com` only for now
- Email template storage in DB (Handlebars/Mustache) — raw HTML is simpler and more flexible
- Attachments — not needed for transactional email; can link to storage URLs
- Unsubscribe management — transactional email doesn't require it; apps that need it can implement in their own DB
