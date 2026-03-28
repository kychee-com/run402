## Context

Run402's email system has production-grade infrastructure (SES, rate limits, suppression, bounce handling, inbound reply processing, webhooks) but the composition layer is locked to 3 fixed templates. The `notification` template caps at 500 chars of plain text. This forces apps that need rich emails (Wild Lychee, any community/SaaS template) to bypass Run402's email entirely by calling external services from edge functions — losing rate limiting, suppression, and deliverability protections.

The gateway's `sendEmail()` function in `email-send.ts` currently requires a `template` string that maps to a hardcoded `TEMPLATES` dict. The SES send path, rate limiting, suppression checking, and message recording are template-agnostic — they work with any subject/body pair. The fix is surgical: add a second code path that accepts raw subject + HTML instead of a template name.

The functions runtime (`@run402/functions`) currently exports `db` and `getUser`. The helper is inlined into function code at deploy time (see `writeLocalFunction()` in `functions.ts:910-1007` for local dev, and `buildShimCode()` for Lambda). Adding `email.send()` follows the same inlining pattern.

## Goals / Non-Goals

**Goals:**
- Agents can send emails with arbitrary HTML content through the same monitored pipeline
- Display names in the From header for branded emails
- Team tier supports 500 emails/day (up from 200) for community newsletter use cases
- `email.send()` is a first-class helper in the functions runtime
- Inbound replies are tested end-to-end against production

**Non-Goals:**
- Batch/bulk send endpoint — agents loop; the daily limit is the governor
- Custom email domains — `slug@mail.run402.com` only
- Template storage in DB (Handlebars/Mustache) — raw HTML is simpler
- Attachments
- Unsubscribe management — apps implement their own if needed

## Decisions

### 1. Raw mode via same endpoint, field-based dispatch

**Decision:** Add raw mode to `POST /v1/mailboxes/:id/messages`. The presence of `subject` + `html` (without `template`) triggers raw mode. Existing template mode is unchanged.

**Why not a new endpoint:** The rate limiting, suppression, recipient tracking, and message recording are identical. Two endpoints would duplicate all that middleware. Field-based dispatch keeps the pipeline unified.

**Why not extend the template system:** Templates are for common patterns with a known structure. Raw HTML is for "I know exactly what I want to send." These are different use cases; forcing raw content through a template abstraction adds complexity without value.

### 2. HTML size limit: 1MB

**Decision:** Cap the `html` field at 1,048,576 bytes. Reject with 400 if exceeded.

**Why 1MB:** SES limits messages to 10MB. A 1MB HTML email is enormous (typical newsletters are 15-30KB). This catches accidental abuse (base64-encoded images inline, repeated content) while leaving ample room for any legitimate transactional or newsletter email. The Express body parser already limits JSON to 1MB for most routes, so this is consistent.

### 3. Auto-generate plaintext from HTML when `text` omitted

**Decision:** When `text` is not provided in raw mode, auto-strip HTML tags to generate a plaintext fallback. Use the same `stripHtml()` logic already in `packages/email-lambda/inbound.mjs:256-271`.

**Why:** Most agents won't bother writing two versions. A reasonable plaintext fallback is better than no plaintext at all (some email clients are text-only). Agents that care can provide their own `text` field.

### 4. Transparency footer always appended

**Decision:** Append the Run402 footer to both HTML and plaintext bodies in raw mode, same as template mode.

**Why:** The footer protects Run402's SES reputation and provides transparency that the email came from an AI agent. It's a small `<p>` — agents can style around it but can't remove it. This is analogous to Mailchimp/SendGrid mandatory footers.

### 5. Display name via `from_name` field

**Decision:** Add optional `from_name` string field. Renders as `"Display Name" <slug@mail.run402.com>` in the SES `FromEmailAddress` parameter.

**Why:** End users see a real name in their inbox instead of a cryptic slug. This is a one-line change in the SES `SendEmailCommand` construction — `FromEmailAddress: from_name ? \`"${from_name}" <${address}>\` : address`. The `from_name` is stored in the email_messages record for audit.

**Validation:** Max 78 chars (RFC 5322 display name limit). Must not contain `<`, `>`, `"`, or newlines.

### 6. `email.send()` helper pattern

**Decision:** Add `email` object to the inlined `@run402/functions` helper with a single `send()` method. Supports both template and raw modes. Discovers the project's mailbox ID lazily on first call and caches it.

```
email.send({ to, subject, html, text?, from_name? })     // raw mode
email.send({ to, template, variables, from_name? })       // template mode
```

Under the hood: `GET /v1/mailboxes` → cache mailbox ID → `POST /v1/mailboxes/:id/messages`.

**Why lazy discovery:** The function doesn't know its mailbox ID at deploy time. The helper fetches `GET /v1/mailboxes` (which returns the project's mailbox) on first send and caches the ID for subsequent calls in the same invocation. If no mailbox exists, throws a clear error: `"No mailbox configured for this project"`.

### 7. Team tier bump: 200 → 500 daily

**Decision:** Change `emailsPerDay` for team tier from 200 to 500 in `packages/shared/src/tiers.ts`.

**Why 500:** A 400-member community newsletter + transactional emails throughout the day. 500 fits this with headroom. The unique recipient cap stays at 1000 per lease — already generous.

### 8. Inbound reply E2E test: real email round-trip

**Decision:** Add an E2E test that sends an outbound email via the API, then sends a reply to the mailbox address via SES `SendEmail`, waits for the inbound Lambda to process it, and verifies the reply appears in the message thread via `GET /v1/mailboxes/:id/messages/:messageId`.

**Why real E2E:** The inbound pipeline crosses SES receipt rules → S3 → Lambda → Aurora → API. A mock test wouldn't catch issues in the Lambda MIME parser, S3 key resolution, or thread linking. The real test takes ~10-15 seconds (SES processing + Lambda cold start) but validates the entire chain.

**Test approach:** Use SES `SendRawEmail` from the test runner to send a reply with proper `In-Reply-To` and `References` headers pointing at the outbound message's SES message ID. Poll `GET /messages/:id` until the reply appears (max 30s, poll every 2s).

## Risks / Trade-offs

**Risk: Raw HTML enables phishing-looking emails** → Mitigated by: x402 payment gate (costs real money to get a tier), daily rate limits (500 max), unique recipient caps (1000 per lease), SES bounce/complaint feedback loops (auto-suspend on high bounce rate), and the mandatory footer disclosing it's from an AI agent via Run402.

**Risk: Large HTML bodies increase SES costs** → Mitigated by: 1MB cap. SES pricing is per-message, not per-byte. Even at 500 emails × 1MB = 500MB/day, the cost is negligible ($0.10/1000 emails = $0.05/day max).

**Risk: Inbound E2E test is flaky due to SES processing delay** → Mitigated by: generous polling timeout (30s), retry with backoff. SES typically processes inbound within 2-5 seconds. If it's consistently slow, the test can be tagged as `@slow` and run only in the full suite.

**Risk: `email.send()` in functions adds network latency** → Two HTTP calls per send (one cached mailbox lookup + one send). At ~50ms per call, that's ~100ms for the first send and ~50ms for subsequent sends. Acceptable for transactional email; agents sending 400 newsletters will take ~20 seconds total.

**Trade-off: Footer is mandatory, even in raw mode** → Some agents may want full control over email appearance. But the footer protects the platform's reputation and is a small price for using a managed email service. Agents that need zero-footer emails should use an external provider.
