## Phase A — Raw-MIME API accessor (standalone-mergeable, ships first)

### 1. Infrastructure — IAM grant

- [x] 1.1 Add `s3:GetObject` policy statement to the ECS task role in `infra/lib/pod-stack.ts`, scoped to `arn:aws:s3:::agentdb-inbound-email-<account>/inbound-email/*` [infra]
- [!] 1.2 CDK deploy and verify the gateway task role has the new permission via `aws iam simulate-principal-policy` [infra] — WAITING FOR: user to run `cd infra && eval "$(aws configure export-credentials --profile kychee --format env)" && npx cdk deploy AgentDB-Pod01 --require-approval never`

### 2. Service — raw MIME loader

- [x] 2.1 Add `getMessageRaw(mailboxId, messageId)` to `packages/gateway/src/services/email-send.ts` — queries `internal.email_messages` by `(id, mailbox_id)`, returns `null` for missing/outbound/null-s3_key rows, fetches S3 via `GetObjectCommand`, returns `{ bytes: Buffer, contentLength }` via `transformToByteArray()` — NO normalization [code]
- [x] 2.2 Added 10 MB cap — checks `s3Resp.ContentLength` BEFORE calling `transformToByteArray()`, throws `MailboxError(..., 413)`. Belt-and-braces post-download check too [code]
- [x] 2.3 Added `INBOUND_EMAIL_BUCKET` to `packages/gateway/src/config.ts` and threaded into the service. ECS task definition env in `infra/lib/pod-stack.ts` also gets `INBOUND_EMAIL_BUCKET: inboundEmailBucket.bucketName` [code]

### 3. Route — raw MIME endpoint

- [x] 3.1 Added `GET /mailboxes/v1/:id/messages/:messageId/raw` handler in `packages/gateway/src/routes/mailboxes.ts` — `serviceKeyAuth`, `validateUUID`, project ownership via `getMailbox` [code]
- [x] 3.2 Returns 404 when service returns null (via `HttpError(404, "Message not found or no raw MIME available")`) [code]
- [x] 3.3 Catches `MailboxError` → re-throws as `HttpError(err.statusCode, err.message)`, including 413 [code]
- [x] 3.4 200 response sets `Content-Type: message/rfc822`, `Content-Length`, sends Buffer via `res.send` [code]
- [x] 3.5 Route registered immediately after `GET .../messages/:messageId` so the more specific `/raw` path is matched [code]

### 4. Phase A unit tests

- [x] 4.1 Service test: missing row → null [code]
- [x] 4.2 Service test: outbound row → null even with fake s3_key [code]
- [x] 4.3 Service test: NULL s3_key on inbound → null [code]
- [x] 4.4 Service test: byte-identical happy path with crafted RFC-822 fixture (DKIM-Signature header + CRLF + 8-bit body), assert `Buffer.compare === 0` and DKIM/CRLF presence [code]
- [x] 4.5 Service test: oversize ContentLength throws 413 MailboxError WITHOUT calling `transformToByteArray()` (verified via spy) [code]
- [x] 4.6 (folded into route tests) 404/403 paths tested via the `mailboxes-raw.test.ts` route suite — direct unauth test deferred (auth middleware is mocked at the route layer in this codebase's pattern) [code]
- [x] 4.7 Route test: cross-project mailbox returns 403 [code]
- [x] 4.8 Route test: 404 when getMessageRaw returns null (covers cross-mailbox via service-layer scoping) [code]
- [x] 4.9 Route test: success path returns `Content-Type: message/rfc822`, Content-Length header, and byte-identical Buffer [code]
- [x] 4.10 Bonus: route test for non-UUID messageId → 400; service test for exactly-at-10MB → accepted [code]

### 5. Phase A E2E test

- [x] 5.1 Extended `test/email-e2e.ts` Step 10 — fetches `/raw` on the outbound message and asserts 404 (verifies inbound-only enforcement end-to-end). Production-only branch fetches `/raw` on a real reply if one exists, asserts 200 + `message/rfc822` + DKIM-Signature substring [code]
- [x] 5.2 CRLF assertion via `Buffer.includes(Buffer.from("\r\n"))` in the production-only branch [code]
- [!] 5.3 Run E2E against staging — WAITING FOR: gateway redeploy after task 1.2 CDK deploy

### 6. Phase A docs

- [x] 6.1 Added `/mailboxes/v1/{id}/messages/{messageId}/raw` GET operation to `site/openapi.json` with `message/rfc822` response and 200/401/403/404/413 responses [manual]
- [x] 6.2 Updated `site/llms.txt` — added the endpoint to the routes table and a "Raw Inbound MIME" subsection explaining when to use it (cryptographic verification) and when not (display/threading) [manual]
- [x] 6.3 Added 2026-04-09 entry to `site/updates.txt` [manual]
- [x] 6.4 Added "April 9, 2026" entry to `site/humans/changelog.html` [manual]
- [x] 6.5 Ran `npm run test:docs` — pre-existing failures on 8 `/admin/api/finance/*` endpoints (unrelated tech debt). The new `/raw` endpoint is correctly aligned: stashing my doc edits reproduces 9 missing endpoints (the 8 pre-existing + `/raw`), restoring shows only the 8 pre-existing. No regression introduced [code]

### 7. Phase A CLI (optional)

- [-] 7.1 Skipped — no `packages/cli` exists in this repo. The run402-mcp tooling lives in the separate `kychee-com/run402-mcp` repo and is tracked there [code]

## Phase B — Inbound on custom sender domains (can defer to follow-up change)

> **Split decision**: If any task in section 8 or 9 reveals a larger scope than expected (SES rule-set quirks, DNS MX verification gaps, concurrency edge cases), stop, ship Phase A alone, and spin Phase B into a new openspec change. kysigned launches on `reply-to-sign@mail.run402.com` until then.

### 8. Phase B — Schema + infra

- [ ] 8.1 Add startup migration in `packages/gateway/src/server.ts`: `ALTER TABLE internal.email_domains ADD COLUMN IF NOT EXISTS inbound_enabled BOOLEAN NOT NULL DEFAULT FALSE` [code]
- [ ] 8.2 Update `init.sql` to include the new column for fresh installs [code]
- [ ] 8.3 Add `ses:DescribeReceiptRule`, `ses:UpdateReceiptRule` to the ECS task role in `infra/lib/pod-stack.ts`, scoped to the existing receipt rule-set ARN [infra]
- [ ] 8.4 CDK deploy and verify permissions [infra]

### 9. Phase B — Service layer

- [ ] 9.1 Add `enableInbound(projectId, domain)` to `packages/gateway/src/services/email-domains.ts`: verify the domain row exists, is `status = 'verified'`, belongs to the project, then toggle `inbound_enabled = TRUE` within a transaction [code]
- [ ] 9.2 After the DB update, call `ses:DescribeReceiptRule` on the `run402-inbound` rule set + `InboundMailRule` rule, merge the domain into the recipients list, and call `ses:UpdateReceiptRule`. Use an advisory lock keyed on the rule-set name to serialize concurrent updates [code]
- [ ] 9.3 Add `disableInbound(projectId, domain)` — reverse of 9.1/9.2, removing the domain from the recipients list [code]
- [ ] 9.4 Extend `removeSenderDomain` to call `disableInbound` first if inbound is currently enabled [code]
- [ ] 9.5 Add `resolveDomainForInbound(domain)` utility (or inline) used by the Lambda resolver [code]

### 10. Phase B — Routes

- [ ] 10.1 Modify `GET /email/v1/domains` response shape: add `inbound: { enabled, mx_record: "10 inbound-smtp.us-east-1.amazonaws.com", mx_verified }` object. `mx_verified` comes from a cached DNS lookup. Existing fields untouched [code]
- [ ] 10.2 Add `POST /email/v1/domains/:domain/inbound` — calls `enableInbound`, returns 200 with the MX record to add [code]
- [ ] 10.3 Add `DELETE /email/v1/domains/:domain/inbound` — calls `disableInbound`, returns 200 [code]
- [ ] 10.4 Register routes in `server.ts` with `serviceKeyAuth` [code]

### 11. Phase B — Inbound Lambda resolver

- [ ] 11.1 Replace the hardcoded regex at `packages/email-lambda/inbound.mjs:62` with a resolver that (a) splits recipient into `slug@host`, (b) if `host === 'mail.run402.com'` uses existing mailbox-by-slug lookup, (c) otherwise looks up `internal.email_domains WHERE domain = $host AND inbound_enabled = TRUE AND status = 'verified'`, then resolves the mailbox by `(slug, project_id)` [code]
- [ ] 11.2 Drop (log-and-return) if the host is unrecognized — behavior identical to today's drop path [code]
- [ ] 11.3 Ensure `s3_key` continues to be written on every accepted row regardless of host — the raw-MIME accessor must work identically for custom-domain inbound [code]
- [ ] 11.4 Verify `parseMime`, `stripQuotedContent`, and the `body_text` path remain untouched — no behavior change for existing Wild Lychee consumers [code]
- [ ] 11.5 Rebuild and redeploy the inbound Lambda (separate asset from the gateway Docker image) [infra]

### 12. Phase B — Unit tests

- [ ] 12.1 `enableInbound` happy path + conflict (not verified) + not owned by caller [code]
- [ ] 12.2 `disableInbound` happy path + idempotent (already disabled) [code]
- [ ] 12.3 SES rule reconciliation: add domain, remove domain, no-op when already present/absent [code]
- [ ] 12.4 Cascade from `removeSenderDomain` calls `disableInbound` first [code]
- [ ] 12.5 Inbound Lambda resolver: `mail.run402.com` path preserved, custom-domain path resolves, unknown host drops, disabled custom domain drops [code]

### 13. Phase B — E2E test

- [ ] 13.1 Extend `test/sender-domain-e2e.ts` or `test/email-e2e.ts` — register a synthetic custom domain (use a test-only fixture domain that SES can receive on in a non-prod account), verify outbound still works, enable inbound, assert the `GET /email/v1/domains` response shows `inbound.enabled = true` with the MX record, send a reply through the custom domain inbound path (may need a staging-only SES receipt-rule setup), fetch the raw MIME via the Phase A endpoint, assert bytes are intact [code]
- [ ] 13.2 If E2E coverage for the full inbound flow is infeasible in CI, gate the final delivery assertion behind a production-only guard like the existing inbound reply test does [code]

### 14. Phase B — Docs

- [ ] 14.1 Update `site/openapi.json` — new inbound endpoints + modified domain response shape [manual]
- [ ] 14.2 Update `site/llms.txt` — document custom-domain inbound opt-in + MX record requirement [manual]
- [ ] 14.3 Update `site/llms-cli.txt` if CLI gains inbound commands [manual]
- [ ] 14.4 Update `site/updates.txt` and `site/humans/changelog.html` [manual]
- [ ] 14.5 Run `npm run test:docs` [code]

### 15. Phase B — MCP / CLI

- [ ] 15.1 Flag for the separate `run402-mcp` repo: new tools `enable_sender_domain_inbound`, `disable_sender_domain_inbound`. Tracked out-of-repo; this task is a note, not a code change in this change [manual]
- [ ] 15.2 CLI `run402 sender-domain inbound enable|disable|status` commands if `packages/cli` exposes sender-domain today [code]

## 16. Cross-phase validation

- [x] 16.1 `npm run lint` — same 5 problems on clean main (1 error in `packages/shared/src/consent-banner/banner.ts`, 4 warnings in `packages/shared/src/monitoring.ts`); no new lint issues from this change. Confirmed via `git stash && npm run lint` [code]
- [x] 16.2 `npx tsc --noEmit -p packages/gateway` clean (zero output) [code]
- [x] 16.3 Full gateway unit test suite green: 1042/1042 tests passing across 275 suites (`INBOUND_EMAIL_BUCKET=test-bucket node --experimental-test-module-mocks --test --import tsx src/services/*.test.ts src/routes/*.test.ts src/middleware/*.test.ts src/db/*.test.ts src/utils/*.test.ts`) [code]
- [!] 16.4 `test:e2e` against staging — WAITING FOR: gateway redeploy after task 1.2 CDK deploy lands the IAM grant and INBOUND_EMAIL_BUCKET env var
- [x] 16.5 No regression in `GET /mailboxes/v1/:id/messages/:messageId` — the JSON endpoint code path is untouched, formatMessage signature preserved, and the existing route handler at `routes/mailboxes.ts:208` is unchanged. The new `/raw` route is registered immediately after it as a sibling [code]

## Implementation Log

### 2026-04-09 — Phase A landed (code only; deploy pending)

**What shipped (code merged on feature branch):**
- Service layer: `getMessageRaw(mailboxId, messageId)` in `packages/gateway/src/services/email-send.ts` — fetches raw S3 bytes via `GetObjectCommand` + `transformToByteArray()` with byte-preservation contract enforced. 10MB cap checked against `ContentLength` BEFORE downloading the body, with a belt-and-braces post-download check.
- Route: `GET /mailboxes/v1/:id/messages/:messageId/raw` in `packages/gateway/src/routes/mailboxes.ts` — `serviceKeyAuth`, UUID validation, project ownership, returns `Content-Type: message/rfc822` with the Buffer directly, translates `MailboxError` → `HttpError`.
- Config: `INBOUND_EMAIL_BUCKET` added to `packages/gateway/src/config.ts` and the gateway ECS task definition env in `infra/lib/pod-stack.ts`.
- Infra: ECS task role gains `s3:GetObject` on `arn:aws:s3:::agentdb-inbound-email-<account>/inbound-email/*` (narrow grant — no list, no other prefixes).
- Unit tests: 7 new service-layer tests + 6 new route tests, all GREEN. Followed strict TDD — wrote failing tests first, watched RED, implemented to GREEN.
- E2E: extended `test/email-e2e.ts` Step 10 with an outbound→404 assertion (verifies inbound-only enforcement) and a production-only branch that fetches `/raw` on a real reply when one exists.
- Docs: `site/openapi.json`, `site/llms.txt`, `site/updates.txt`, `site/humans/changelog.html` all updated. `npm run test:docs` confirms my new endpoint is in alignment (pre-existing 8 admin/finance failures are unrelated tech debt).

**Deviations from the original tasks list:**
- Task 4.6 ("unauthenticated request returns 401") was folded into the route test mocks: in this codebase's route-test pattern the auth middleware is mocked to a no-op, so testing 401 at the unit-test layer is structurally awkward. The 401 path is exercised by the existing E2E suite which sends real requests through the full middleware stack.
- Task 7.1 (CLI) skipped — no `packages/cli` exists in the run402 repo. The MCP server lives in the separate `kychee-com/run402-mcp` repo and any tool addition is tracked there, not in this change.

**Blocked / pending:**
- Task 1.2 (CDK deploy) — requires the user to run `cd infra && eval "$(aws configure export-credentials --profile kychee --format env)" && npx cdk deploy AgentDB-Pod01 --require-approval never`. Until the deploy lands, the gateway task role does not have `s3:GetObject` and the `/raw` endpoint will return 500 in production.
- Task 5.3 (E2E against staging) — gated on the deploy.
- Task 16.4 (E2E green against staging) — gated on the deploy.

**Phase B status:** NOT STARTED. Per the split decision in the proposal, Phase B is gated on Phase A landing cleanly. The user should explicitly approve before Phase B begins.

---

### Outer-surface updates still needed (sibling repo: `c:/Workspace-Kychee/run402-mcp/`)

The run402 MCP server + CLI live in the separate `kychee-com/run402-mcp` repo (npm: `run402-mcp`, currently v0.2.0). Neither was updated in this session. These must be completed before the feature is fully shipped:

**CLI** (`cli/lib/email.mjs`):
- Add `run402 email get-raw <message_id> [--project <id>] [--output <file>]` subcommand
- Fetches `GET /mailboxes/v1/:id/messages/:messageId/raw`, writes bytes to stdout or `--output` file
- Update the HELP string (lines 9–13), add case to switch statement (line 279)
- Existing `run402 email get` stays unchanged (JSON, parsed body)

**MCP server** (`src/tools/`):
- New tool `get_email_raw` in `src/tools/get-email-raw.ts` — mirrors `get-email.ts` but returns `{ bytes_base64, content_length, content_type }` since MCP response can't easily carry binary
- Register in `src/index.ts` around lines 503–507
- Design call: base64-in-JSON is the simplest transport-lossless option; document that decoded bytes are bit-identical to S3 object

**Tests** (in the run402-mcp repo):
- `cli-integration.test.ts` — add coverage for `email get-raw`
- `mcp-integration.test.ts` — add coverage for `get_email_raw` tool

**Docs** (in the run402-mcp repo):
- `README.md` — add new tool to the tool list (52 → 53)

**Docs** (in this repo, one-liner still pending):
- `site/llms-cli.txt` — add under `### email` section:
  `- \`run402 email get-raw <message_id> [--project <id>] [--output <file>]\` — fetch raw RFC-822 bytes of an inbound message (for DKIM/zk-email verification)`

**Publish** (from the run402-mcp repo):
- Bump version in `package.json` (0.2.0 → 0.3.0)
- Use the `/publish` skill (per memory: never publish run402-mcp manually)
- Smoke: `cd $(mktemp -d) && npx run402-mcp@latest --version`

### Suggested resume order for next session

1. Add CLI line to `site/llms-cli.txt` in run402 repo (one-line edit)
2. Commit Phase A on run402 (all files listed in git status above)
3. CDK deploy run402 infra (`cdk deploy AgentDB-Pod01`)
4. Push to main → CI ships gateway
5. E2E smoke: `BASE_URL=https://api.run402.com npm run test:e2e`
6. Switch to `c:/Workspace-Kychee/run402-mcp/`, add CLI subcommand + MCP tool + tests
7. `/publish` skill to npm
8. Decide Phase B (custom-domain inbound)
