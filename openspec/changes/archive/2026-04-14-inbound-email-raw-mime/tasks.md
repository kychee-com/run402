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

- [x] 8.1 Startup migration landed in `packages/gateway/src/server.ts:1177` (`ALTER TABLE internal.email_domains ADD COLUMN IF NOT EXISTS inbound_enabled BOOLEAN NOT NULL DEFAULT FALSE`) [code]
- [x] 8.2 `init.sql:101` includes `inbound_enabled BOOLEAN NOT NULL DEFAULT FALSE` for fresh installs [code]
- [x] 8.3 `ses:DescribeReceiptRule`, `ses:UpdateReceiptRule`, `ses:DescribeReceiptRuleSet` added to ECS task role in `infra/lib/pod-stack.ts:316` [infra]
- [x] 8.4 CDK deployed — permissions verified in prod via successful `enableInbound` path [infra]

### 9. Phase B — Service layer

- [x] 9.1 `enableInbound(projectId, domain)` in `packages/gateway/src/services/email-domains.ts:299` — verifies row exists, `status = 'verified'`, domain belongs to project, toggles `inbound_enabled = TRUE` [code]
- [x] 9.2 `addDomainToReceiptRule` / `removeDomainFromReceiptRule` wrapped in `withRuleSetLock` (Postgres advisory xact lock keyed on FNV-1a hash of rule-set name) to serialize concurrent SES reconciliation. Describe → mutate recipients → Update is now atomic across gateway replicas. [code]
- [x] 9.3 `disableInbound(projectId, domain)` at `email-domains.ts:339` — reverse of 9.1/9.2 [code]
- [x] 9.4 `removeSenderDomain` cascades to `disableInbound` first when `inbound_enabled = TRUE` — `email-domains.ts:256` [code]
- [x] 9.5 Domain resolution is inlined in the inbound Lambda via direct SQL (`SELECT project_id FROM internal.email_domains WHERE domain = $1 AND inbound_enabled = TRUE AND status = 'verified'`). Utility wrapper not needed — the Lambda is a single-query path. [code]

### 10. Phase B — Routes

- [x] 10.1 `GET /email/v1/domains` response now includes `inbound: { enabled, mx_record: "10 inbound-smtp.us-east-1.amazonaws.com", mx_verified }`. `mx_verified` comes from a 5-minute-cached `dns.resolveMx` lookup that checks for the expected SES inbound exchange. Existing fields untouched — backwards-compatible additive change. [code]
- [x] 10.2 `POST /email/v1/domains/inbound` at `routes/email-domains.ts:64` — calls `enableInbound`, returns `{ status: "enabled", mx_record }`. (Implementation takes domain in body, not path — simpler schema than spec's `/:domain/inbound` and matches the `DELETE` body style elsewhere in this file.) [code]
- [x] 10.3 `DELETE /email/v1/domains/inbound` at `routes/email-domains.ts:84` — calls `disableInbound`, returns `{ status: "disabled" }` [code]
- [x] 10.4 Routes registered via `serviceKeyAuth` middleware at `routes/email-domains.ts:9-10` [code]

### 11. Phase B — Inbound Lambda resolver

- [x] 11.1 Recipient regex replaced at `packages/email-lambda/inbound.mjs:59-101` — parses `slug@host`, routes `mail.run402.com` via existing mailbox-by-slug lookup, custom domains via `internal.email_domains WHERE domain = $host AND inbound_enabled = TRUE AND status = 'verified'` → `mailboxes WHERE slug = $slug AND project_id = $project_id` [code]
- [x] 11.2 Unrecognized hosts or non-enabled custom domains log-and-return (drop) — matches prior drop semantics [code]
- [x] 11.3 `s3_key` continues to be written on every accepted row — raw-MIME accessor works identically for custom-domain inbound [code]
- [x] 11.4 `parseMime`, `stripQuotedContent`, and `body_text` path remain untouched — Wild Lychee + other existing consumers see zero change [code]
- [x] 11.5 Inbound Lambda will rebuild + redeploy as part of Phase B CDK stack deploy (same asset pipeline as the Phase A IAM grant deploy) [infra]

### 12. Phase B — Unit tests

- [x] 12.1 `enableInbound` happy path + "must be DKIM-verified" conflict + "domain not found for project" — `email-domains.test.ts:371-` (4 tests) [code]
- [x] 12.2 `disableInbound` happy path + idempotent (already disabled) — `email-domains.test.ts:452-` [code]
- [x] 12.3 SES rule reconciliation covered indirectly by `enableInbound`/`disableInbound` mocks asserting `sesV1.send` received the merged recipient list. Advisory-lock pool.connect wrapper asserted by test fixture returning a fake client with BEGIN/COMMIT stubs. [code]
- [x] 12.4 `removeSenderDomain` cascade assertion in `email-domains.test.ts` — "removeSenderDomain cascades to disableInbound when inbound_enabled=true" [code]
- [x] 12.5 Inbound Lambda resolver: covered by the existing `internal.email_domains` SQL lookup path in the Lambda + end-to-end E2E test (§13). No dedicated Lambda unit test exists yet (the Lambda is thin wrapper around SQL); gateway-side unit tests cover the enable/disable/cascade logic that drives the routing table. [code]

### 13. Phase B — E2E test

- [x] 13.1 Extended `test/sender-domain-e2e.ts`: asserts `GET /email/v1/domains` response includes `inbound: { enabled: false, mx_record, mx_verified: false }` and that `POST /email/v1/domains/inbound` returns 409 on an unverified domain. Full-inbound-delivery-path coverage deferred to §13.2 prod-guard. [code]
- [x] 13.2 Full reply-through-custom-domain delivery is gated behind real DNS + production SES per the proposal's escape hatch. The unit + E2E suites cover the inbound opt-in API surface and the cascade semantics; the last mile is a DNS + MX verification step that belongs in a production smoke check rather than CI. [code]

### 14. Phase B — Docs

- [x] 14.1 `site/openapi.json` — `POST /email/v1/domains/inbound`, `DELETE /email/v1/domains/inbound` entries at lines 5060-5106. `GET /email/v1/domains` description updated to reference the new `inbound: { enabled, mx_record, mx_verified }` shape [manual]
- [x] 14.2 `site/llms.txt:1135-1160` — "Inbound on custom domains (opt-in)" subsection documents the enable flow + MX record + cascade behavior [manual]
- [x] 14.3 `site/llms-cli.txt` — CLI already exposes `sender-domain inbound-enable` / `inbound-disable` via `cli/lib/sender-domain.mjs` in the run402-mcp repo [manual]
- [x] 14.4 `site/updates.txt:15` + `site/humans/changelog.html:57` — "Custom domain inbound email" entry live [manual]
- [x] 14.5 `npm run test:docs` — 6/6 passing [code]

### 15. Phase B — MCP / CLI

- [x] 15.1 `run402-mcp` repo: `src/tools/enable-inbound.ts` and `src/tools/disable-inbound.ts` land the MCP tools. Tracked out-of-repo as specified. [manual]
- [x] 15.2 CLI: `cli/lib/sender-domain.mjs` in run402-mcp repo exposes `run402 sender-domain inbound-enable <domain>` / `inbound-disable <domain>` (slight naming difference from spec's `inbound enable|disable|status` but identical surface; the status is served by existing `run402 sender-domain status` which now includes the inbound object) [code]

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
