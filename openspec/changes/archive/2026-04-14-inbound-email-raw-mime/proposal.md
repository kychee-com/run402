## Why

Run402 already receives and persists inbound email end-to-end (SES receipt rule → S3 → `packages/email-lambda/inbound.mjs` → Postgres). Raw RFC-822 bytes are stored in S3 and the `internal.email_messages` row carries an `s3_key` pointer. But the public API (`GET /v1/mailboxes/:id/messages/:msgId`) only exposes the *parsed, cleaned* `body_text` produced by `stripQuotedContent()` — there is no way for an app to read the original DKIM-signed bytes that S3 holds.

This blocks any app doing **cryptographic verification over inbound email**. The motivating consumer is kysigned, which is pivoting to a "reply-to-sign" signing method: the signer replies to an email with `I APPROVE`, their mail provider DKIM-signs the outbound reply, and kysigned runs a zk-email circuit over the *exact* raw MIME to produce a zk-SNARK proving the signer's mail provider attested the reply. The proof is computed against the bytes covered by the DKIM signature — any post-processing (whitespace normalization, header unfolding, quoted-content stripping, charset decoding) invalidates the DKIM signature and breaks the cryptographic chain. See `docs/products/kysigned/ideas/kysigned-signature-binding-idea.md` for the full context.

The bytes are already on disk. We just need a read-only accessor that returns them untouched. No new storage, no new pipeline, no new dependencies.

A second, independent pain point: kysigned wants replies to arrive at `reply-to-sign@kysigned.com`, not `reply-to-sign@mail.run402.com`. Outbound custom sender domains already exist (archived `2026-04-06-custom-sender-domains`), but that change explicitly punted inbound as a non-goal. Extending the same machinery to route inbound through a verified custom domain is the second half of the kysigned unblock — but it is larger in scope (SES receipt rule reconciliation, DNS MX instructions) and **can be deferred** if it turns out to stretch the change.

## What Changes

### Phase A — Raw-MIME API accessor (must ship first)

- **Gateway**: New endpoint `GET /v1/mailboxes/:id/messages/:msgId/raw` that streams the exact S3 object bytes for an inbound message. `Content-Type: message/rfc822`. service_key auth (same model as the existing message endpoints), project ownership enforced identically to `GET .../messages/:msgId`. Inbound messages only (direction = `inbound`); outbound returns 404. If the row has no `s3_key`, returns 404 with a clear error. Objects larger than 10 MB return 413.
- **Service layer**: New method on `packages/gateway/src/services/email-send.ts` (or a sibling module) that loads the `s3_key` for a message row and fetches the bytes from S3 with **zero** parsing, cleaning, or normalization — not even CRLF cleanup. The S3 `GetObject` response body is forwarded verbatim.
- **Infrastructure**: Grant the gateway ECS task role `s3:GetObject` on the `agentdb-inbound-email-*` bucket. Currently only the inbound Lambda has read access (pod-stack.ts:331). Added in `infra/lib/pod-stack.ts`.
- **Docs**: `site/llms.txt`, `site/openapi.json`, `site/updates.txt`, `site/humans/changelog.html`. The spec SHALL document that raw-MIME is the correct access path for cryptographic verification (zk-email, DKIM checks), and that `body_text` is for display and threading only.
- **CLI**: If `packages/cli` exposes a message-read command, add a raw flavor. If not, no change.
- **MCP**: The run402 MCP server lives in the separate `kychee-com/run402-mcp` repo; any new tool is tracked there, out of scope for this change.
- **Existing behavior stays frozen**: the `stripQuotedContent`/`body_text` parsing path in `packages/email-lambda/inbound.mjs:216` is untouched; existing consumers (Wild Lychee etc.) see no change.

### Phase B — Inbound routing on custom sender domains (can defer)

- **Infrastructure**: Reconcile SES receipt-rule recipients at runtime. Today `infra/lib/pod-stack.ts:345` hardcodes `recipients: ["mail.run402.com"]`. When a project enables inbound on a verified custom sender domain, the gateway calls `ses:UpdateReceiptRule` to add the domain to the recipient list. Cleanup runs on domain removal or inbound-disable.
- **IAM**: Add `ses:DescribeReceiptRule`, `ses:UpdateReceiptRule` to the gateway task role.
- **Database**: Add an `inbound_enabled` (boolean, default false) column to `internal.email_domains` via a startup migration in `server.ts`.
- **Service layer**: `email-domains.ts` gains `enableInbound`/`disableInbound` methods that update the DB flag AND call SES to reconcile the rule set. Domain removal cascades to disable.
- **Gateway routes**: The `GET /email/v1/domains` response gains an `inbound` object with `enabled`, the required MX record (`10 inbound-smtp.us-east-1.amazonaws.com`), and verification state. A new `POST /email/v1/domains/:domain/inbound` endpoint enables inbound (requires the domain to already be DKIM-verified) and returns the MX record for the user to add. A `DELETE` disables it.
- **Inbound Lambda**: Generalize the recipient regex in `packages/email-lambda/inbound.mjs:62` from `^([^@]+)@mail\.run402\.com$` to `^([^@]+)@([^@]+)$`, then resolve the domain — if it's `mail.run402.com`, use the existing mailbox lookup; if it's a custom domain, look it up in `internal.email_domains`, verify inbound is enabled, and resolve the project's mailbox owning the slug. If neither matches, drop.
- **Docs**: Same doc surfaces as Phase A, plus the MX record instructions on the domain status endpoint.
- **MVP escape hatch**: If Phase B turns out to touch more surfaces than expected or the SES rule-set reconciliation path hits snags, it is **acceptable to land Phase A alone** and spin Phase B into a separate follow-up change. kysigned can launch on `reply-to-sign@mail.run402.com` in the interim — the raw-MIME accessor is the cryptographically load-bearing piece; the custom domain is cosmetic.

## Capabilities

### Modified Capabilities

- `email-send` (modified): Adds a raw-MIME accessor for inbound messages and (Phase B) extends the per-project sender domain machinery to cover inbound routing in addition to outbound.

## Impact

- **Gateway routes** (`packages/gateway/src/routes/mailboxes.ts`): new `GET /v1/mailboxes/:id/messages/:msgId/raw` handler (Phase A). Modified `GET /email/v1/domains/*` handlers to surface inbound state and MX instructions (Phase B).
- **Gateway services** (`packages/gateway/src/services/email-send.ts`): new `getMessageRaw(mailboxId, messageId)` returning `{ bytes, contentLength }` or null. Keeps `getMessage` and `formatMessage` untouched.
- **Gateway services** (`packages/gateway/src/services/email-domains.ts`): new `enableInbound`/`disableInbound` + SES rule-set reconciliation (Phase B only).
- **Inbound Lambda** (`packages/email-lambda/inbound.mjs`): recipient regex generalized + domain resolver against `internal.email_domains` (Phase B only). The `parseMime`/`stripQuotedContent` path stays untouched regardless of phase.
- **Database**: `internal.email_domains` gains `inbound_enabled boolean DEFAULT false` column (Phase B only). Startup migration in `server.ts`.
- **Infrastructure** (`infra/lib/pod-stack.ts`): ECS task role gains `s3:GetObject` on the inbound bucket (Phase A). Gains `ses:DescribeReceiptRule`, `ses:UpdateReceiptRule` (Phase B).
- **E2E tests** (`test/email-e2e.ts`): Phase A extension asserting raw bytes are byte-identical to the sent reply and that the `DKIM-Signature` header substring is present. Phase B extension enabling inbound on a custom domain and delivering a reply through it (or deferred to a follow-up).
- **Unit tests**: new service-layer tests for `getMessageRaw` (inbound-only, missing s3_key, project-ownership, byte-identity).
- **Docs**: `site/llms.txt`, `site/openapi.json`, `site/updates.txt`, `site/humans/changelog.html` (Phase A always; Phase B if bundled).

## Non-goals

- **Server-side parsing of raw bytes**. The accessor is a byte pipe from S3 to the client. Any header extraction, MIME parsing, charset decoding, or quoted-content stripping happens in the consuming app, not the gateway. The whole point is that the bytes the client receives are bit-identical to what the DKIM signature was computed over.
- **Streaming uploads or chunked responses for huge messages**. A typical DKIM-signed reply (text-only, no attachments) is well under 200 KB. The endpoint returns a single full response, capped at 10 MB. Anything larger is rejected with 413. Attachments are out of scope — kysigned's use case is plain-text replies.
- **Raw access to outbound messages**. Outbound messages don't carry a meaningful DKIM signature from the project's perspective — the gateway built them server-side. Raw access is inbound-only.
- **Signed URLs to the S3 bucket**. Direct S3 access would bypass the gateway's auth and rate-limiting surfaces and couple consumers to the bucket name. The gateway proxies the bytes.
- **Retroactive raw access for messages from before this change shipped**. The `s3_key` column has been populated since the inbound feature shipped (`2026-03-28-full-email`), so in practice all existing inbound messages remain accessible. This is noted only to scope guarantees: if any inbound row exists with `s3_key = NULL`, it returns 404.
- **Inbound on custom domains not verified for DKIM**. Phase B requires the domain to already be DKIM-verified via the existing custom-sender-domains flow before inbound can be enabled. No shortcut for inbound-only domains.
- **Multiple inbound domains per project**. Phase B piggybacks on the existing one-sender-domain-per-project constraint.
- **Automated DNS MX record creation**. User brings their own DNS; we surface the required MX record on the status endpoint and wait for the user to add it.
