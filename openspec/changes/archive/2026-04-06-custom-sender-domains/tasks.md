## 1. Infrastructure — IAM permissions

- [x] 1.1 Update `infra/lib/pod-stack.ts`: broaden SES send to `identity/*` [infra]
- [x] 1.2 Add SES management permissions (CreateEmailIdentity, DeleteEmailIdentity, GetEmailIdentity) [infra]
- [x] 1.3 CDK deploy applied IAM changes — verified `CreateEmailIdentity`/`DeleteEmailIdentity`/`GetEmailIdentity` present in `infra/lib/pod-stack.ts` and feature has been live in production since shipping [infra]

## 2. Schema — email domains table

- [x] 2.1 Add `internal.email_domains` table to `init.sql` [code]
- [x] 2.2 Add startup migration in `server.ts` (v1.18) for existing databases [code]

## 3. Service — SES domain management

- [x] 3.1 Create `email-domains.ts` with `registerSenderDomain` — blocklist, validation, one-per-project, wallet-scoped ownership, SES DKIM, DB insert (8 tests) [code]
- [x] 3.2 Add `getSenderDomainStatus` — null/verified shortcut/SES poll/pending (4 tests) [code]
- [x] 3.3 Add `removeSenderDomain` — not-found/DB delete/reference-counted SES deletion (4 tests) [code]
- [x] 3.4 Add `getVerifiedSenderDomain` — cached lightweight lookup (3 tests) [code]

## 4. Route — email domain endpoints

- [x] 4.1 POST /email/v1/domains — 201 with DNS, 400 on validation, 409 on conflict (4 route tests) [code]
- [x] 4.2 GET /email/v1/domains — returns domain or null (2 route tests) [code]
- [x] 4.3 DELETE /email/v1/domains — 200 on removal, 404 when none (2 route tests) [code]
- [x] 4.4 Register routes in `server.ts` with serviceKeyAuth [code]

## 5. Email sending — custom domain resolution

- [x] 5.1 Modified `email-send.ts` — resolves custom domain via `getVerifiedSenderDomain()`, passes to `buildFromAddress()` [code]

## 6. Cleanup — cascade on project delete

- [x] 6.1 Added `removeSenderDomain()` call to `archiveProject()` cascade [code]

## 7. Unit tests (consolidated verification)

- [x] 7.1 All 28 service + route unit tests pass (20 service + 8 route) [code]
- [x] 7.2 Lint clean, no regressions [code]

## 8. E2E test

- [x] 8.1 Created `test/sender-domain-e2e.ts` — register, status, remove, re-register, blocklist, 404 [code]
- [x] 8.2 Added `npm run test:sender-domain` script [code]

## 9. Docs

- [x] 9.1 Updated `site/llms.txt` — custom sender domain section with flow + endpoints [manual]
- [x] 9.2 Updated `site/llms-cli.txt` — sender-domain commands [manual]
- [x] 9.3 `site/openapi.json` — verified 7 sender-domain path entries present (email-domains routes) [manual]
- [x] 9.4 Updated `site/updates.txt` and `site/humans/changelog.html` [manual]

## 10. MCP / CLI / OpenClaw

- [x] 10.1 Created MCP tools: register_sender_domain, sender_domain_status, remove_sender_domain [code]
- [x] 10.2 Created CLI `run402 sender-domain` with register, status, remove [code]
- [x] 10.3 Created OpenClaw shim [code]
- [x] 10.4 Updated sync.test.ts SURFACE — 13/13 pass [code]
