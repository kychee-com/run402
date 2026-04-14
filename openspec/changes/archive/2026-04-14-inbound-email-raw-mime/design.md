## Context

Run402's inbound email pipeline already persists raw RFC-822 bytes to S3 and writes an `s3_key` pointer onto the `internal.email_messages` row (see `packages/email-lambda/inbound.mjs:157` and `infra/lib/pod-stack.ts:285-356`). The public API path (`packages/gateway/src/routes/mailboxes.ts:208`, service in `packages/gateway/src/services/email-send.ts:431`) exposes only the parsed `body_text` that the Lambda generated after running `stripQuotedContent()`. For display/threading use cases this is ideal; for cryptographic verification it is fatally lossy.

kysigned is pivoting to a reply-to-sign signing method where a zk-email circuit is run over the exact DKIM-signed bytes of a reply. Any modification to those bytes — even whitespace normalization or CRLF cleanup — invalidates the DKIM signature and breaks the zk proof. run402 is the email surface, and kysigned is a run402 application, so this is a platform change, not a kysigned-specific one; any app doing DKIM checks, SPF replay detection, or archival-grade email storage benefits.

The second pain point (Phase B) is that inbound receipt is hardcoded to `mail.run402.com` at both the SES receipt-rule level (`infra/lib/pod-stack.ts:345`) and the inbound Lambda regex level (`packages/email-lambda/inbound.mjs:62`). Outbound custom sender domains already exist (archived `2026-04-06-custom-sender-domains`), but that change explicitly punted inbound as a non-goal. Extending the mechanism to cover inbound is additive to the existing `internal.email_domains` table, but it touches infrastructure (SES rule reconciliation) and DNS instructions (MX records), so it is meaningfully larger than Phase A.

Related prior art: the archived `2026-03-28-full-email` change added the raw-HTML send mode and the inbound reply E2E test in `test/email-e2e.ts`. Its shape (modify existing route file, add service method, extend the E2E test) is the template for Phase A.

## Goals

- Expose inbound messages' raw RFC-822 bytes through the gateway API with bit-identical fidelity to the S3 object.
- Keep the existing parsed-`body_text` path and its consumers completely unchanged.
- Preserve the gateway's auth and project-ownership boundary — no direct S3 URL handoff.
- Enable (Phase B) verified custom sender domains to also receive inbound mail, with a clear opt-in and a DNS MX instruction surface.

## Non-Goals

- Server-side parsing, extraction, or re-encoding of raw bytes.
- Streaming / chunked responses or range requests (10 MB single-response cap).
- Raw access to outbound messages.
- Multiple custom inbound domains per project.
- Automated MX record creation (user brings their own DNS).
- DKIM verification inside the gateway — that is the consuming app's job.

## Decisions

### 1. Phase A: new endpoint, not a query param or JSON field

**Choice**: Add a new route `GET /v1/mailboxes/:id/messages/:msgId/raw` returning `Content-Type: message/rfc822` with the raw bytes as the response body. The existing `GET .../messages/:msgId` JSON response is untouched.

**Alternatives considered**:

- *Query parameter `?format=raw` on the existing endpoint.* Rejected because the response content type would need to flip between `application/json` and `message/rfc822` on the same path, which complicates CDN caching, OpenAPI typing, and MCP/CLI tooling (which introspects by path). It also means one code path has to branch on every read.
- *New JSON field (`raw_mime_base64`) on the existing response.* Rejected for three reasons: (a) base64 bloats the payload 33% which matters for the 10 MB cap; (b) every existing caller of the endpoint would start shipping the raw bytes unnecessarily; (c) JSON encoders are free to reorder or re-escape keys, which does not affect the base64 payload but opens a surface where a clumsy client might try to "normalize" the envelope and break the chain. A dedicated endpoint with `message/rfc822` makes the byte-preservation contract visually obvious.

**Rationale**: A dedicated endpoint with a dedicated content type communicates the contract ("these bytes are verbatim") clearly and keeps the existing JSON endpoint's shape locked.

### 2. Inbound-only access

**Choice**: The endpoint returns 404 for messages with `direction != 'inbound'` or with a NULL `s3_key`. It does not expose outbound messages, even though the gateway has the data it would take to reconstruct outbound MIME.

**Rationale**: Outbound messages are built server-side by our own SES send path. There is no externally-meaningful DKIM signature on them from the project's perspective — the signature, when SES adds it, covers bytes the gateway composed. A "raw outbound" accessor would tempt apps to verify run402's own DKIM against itself, which is not a meaningful trust anchor. Keeping the endpoint inbound-only makes the mental model clean: raw = received from third party, verifiable against third-party DKIM.

**Trade-off**: If a future use case wants raw outbound for audit-log archival, we'd add a separate path. The two use cases are distinct enough that conflating them would be a mistake.

### 3. Size cap at 10 MB, full response, no streaming

**Choice**: The service layer reads the S3 object into memory via `GetObjectCommand` + `transformToByteArray()` and returns it as a single response. If `ContentLength` reported by S3 exceeds 10 MB, return 413 without downloading the body.

**Rationale**: Typical reply-to-sign messages are text-only and well under 200 KB. The 10 MB cap absorbs realistic headroom (photo attachments, long quoted threads) without exposing the gateway to arbitrary memory pressure from an attacker storing multi-gigabyte objects. Streaming would add implementation complexity for an unneeded corner case; if someone later needs it, they can add a range-request variant.

**Alternatives considered**:

- *Stream the S3 body straight through.* More complex error handling (partial-response failures), and the simple full-response path fits the kysigned workload cleanly.
- *No cap, let the gateway decide at runtime.* Rejected — creates a DoS vector.

### 4. IAM: narrow `s3:GetObject` grant on the inbound bucket, not broader

**Choice**: Add a new `iam.PolicyStatement` to the ECS task role in `infra/lib/pod-stack.ts` granting `s3:GetObject` on `arn:aws:s3:::agentdb-inbound-email-<account>/inbound-email/*`. No list permission, no write, no delete, no grant on any other bucket.

**Rationale**: Minimum viable surface. The gateway only needs to read the specific objects the inbound Lambda wrote. `inbound-email/*` prefix limits the grant to the Lambda-written namespace.

**Trade-off**: If we later put other artifacts in the same bucket under a different prefix, this grant continues to isolate them.

### 5. Byte-preservation contract

**Choice**: The service method MUST NOT touch the returned bytes. No `transformToString()`, no normalizer, no UTF-8 decode/re-encode, no CRLF cleanup. The response body is set from a `Uint8Array`/`Buffer` derived from `transformToByteArray()`. Unit tests assert byte-identity against a fixture.

**Rationale**: The whole point of the endpoint. Any post-processing, no matter how "innocuous," could invalidate a future DKIM check.

### 6. Phase B: runtime SES rule reconciliation, not wildcard recipient

**Choice**: When a project enables inbound on a verified custom domain, the gateway calls `ses:UpdateReceiptRule` to add the domain to the existing rule's `Recipients` list. Disable (or domain removal) calls it again to remove the domain.

**Alternatives considered**:

- *Single rule with a wildcard recipient (`*`) + domain resolution fully in the Lambda.* SES receipt rules support recipient matching and bill per evaluation for matching mail. A wildcard rule would cause every piece of inbound mail SES receives on run402's account to hit our Lambda, including mail destined for unrelated identities. Even if the Lambda then drops it, we pay for the evaluation and take on a noisy blast radius. Rejected.
- *A separate rule per custom domain.* The rule set's ordering and limits (200 rules per set) make this noisier and more brittle than modifying one rule's recipient list in place.

**Rationale**: In-place recipient list updates are atomic, bounded in cost, and keep the SES surface quiet. The user must add an MX record anyway before SES will route to us, so the enable flow naturally has a "pending MX" state that we can check by calling `ses:GetIdentityMailFromDomainAttributes` or simply by attempting delivery. We gate on the existing `email_domains.status = 'verified'` flag plus a new `inbound_enabled` flag.

### 7. Phase B: opt-in inbound via explicit flag

**Choice**: New column `inbound_enabled BOOLEAN NOT NULL DEFAULT FALSE` on `internal.email_domains`. A domain is verified for DKIM (outbound) by default; enabling inbound is a separate explicit call via `POST /email/v1/domains/:domain/inbound`.

**Rationale**: Most projects that want a branded sender domain do not want inbound routed through run402 — they already have a mail server or forwarder answering their custom domain. Inbound is a destructive DNS change from the user's perspective (MX record). Making it opt-in prevents accidentally hijacking an existing mailbox.

### 8. Phase B: recipient resolver in the Lambda

**Choice**: Generalize the hardcoded regex at `packages/email-lambda/inbound.mjs:62`. New resolver logic:

1. Parse `slug` and `host` out of the recipient.
2. If `host === 'mail.run402.com'`, use the existing mailbox-by-slug lookup.
3. Else look up `internal.email_domains WHERE domain = $host AND inbound_enabled = TRUE`. If found, resolve the mailbox by slug within that domain's project. Otherwise drop.

The rest of `parseMime` and `stripQuotedContent` stays unchanged — the `body_text` parsing behavior for existing consumers is frozen. `s3_key` continues to be written on every row regardless of host.

**Rationale**: Minimal surface area change. The Lambda does one lookup more than it does today, no structural changes.

### 9. Phase B is splittable

**Choice**: Phase B is explicitly marked as deferrable. Phase A is written to be meaningful and mergeable alone. If Phase B is deferred, the kysigned launch uses `reply-to-sign@mail.run402.com` as the signer-facing address.

**Rationale**: The raw-MIME accessor is the cryptographically load-bearing piece — without it kysigned literally cannot produce a valid zk proof. The custom-domain inbound is cosmetic branding for kysigned (still important, but non-blocking). Keeping them splittable lets us ship the blocker fast and take more care with the infra-heavy part.

## Risks / Trade-offs

- **Raw byte exposure in logs.** If a raw request error is logged with the S3 response body attached, we leak inbound mail contents. *Mitigation*: the service layer passes the byte array to the Express response without logging it on the happy path; error handling logs only the S3 error string + s3_key, not the bytes.
- **Project boundary drift.** A future refactor that reuses `getMessageRaw` in another code path could accidentally skip the `getMailbox`/`project_id` ownership check. *Mitigation*: the service method takes `mailboxId` and returns null for rows whose `mailbox_id` does not match, mirroring `getMessage`. Same boundary discipline, same tests.
- **S3 object gone but DB row present.** The inbound bucket lifecycle policy in `pod-stack.ts:296` expires objects after 90 days. A message older than that returns 404 on the raw endpoint but still shows `body_text` via the JSON endpoint. *Mitigation*: documented in the spec; kysigned's operator is expected to pull the raw bytes within minutes of receipt, well before the lifecycle rule fires. A future enhancement could extend retention for inbound bound to a project explicitly requesting it.
- **Phase B: SES rule update concurrency.** Two concurrent enable calls could race on `UpdateReceiptRule`. *Mitigation*: read-modify-write inside a DB transaction on `email_domains`, with the SES call serialized by advisory lock on the rule-set name. Low traffic path, simple to get right.
- **Phase B: MX record abandonment.** User enables inbound and never adds the MX; SES rule has the domain but no mail arrives. Harmless but creates a weird `inbound_enabled = true` + zero receipts state. *Mitigation*: status endpoint reports `"mx_verified": false` based on a DNS lookup; UI can surface it.

## Migration Plan

Additive throughout. No breaking migrations.

**Phase A (standalone-mergeable):**

1. Infra CDK deploy: add `s3:GetObject` on the inbound bucket prefix to the ECS task role.
2. Gateway deploy: new route + service method + IAM consumption.
3. No DB migration needed — `s3_key` column already exists since the inbound feature shipped.
4. Extend `test/email-e2e.ts` and run against staging.

**Phase B (if bundled; else spun out):**

1. Startup migration in `server.ts` — `ALTER TABLE internal.email_domains ADD COLUMN IF NOT EXISTS inbound_enabled BOOLEAN NOT NULL DEFAULT FALSE`.
2. Infra CDK deploy: `ses:UpdateReceiptRule`/`ses:DescribeReceiptRule` on the rule-set ARN for the ECS task role.
3. Gateway deploy: new `enableInbound`/`disableInbound` service methods + new routes + inbound Lambda recipient resolver.
4. Inbound Lambda is a separate deployable — publish a new Lambda version before the gateway routes go live.
5. Existing projects unaffected — inbound on custom domains is opt-in and defaults to `FALSE`.
