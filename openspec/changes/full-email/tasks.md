## 1. Raw HTML send mode

- [x] 1.1 Add mode detection in `sendEmail()` — if `subject` + `html` present (no `template`), route to raw mode; template field takes precedence when both present
- [x] 1.2 Add raw mode validation: `subject` required (max 998 chars), `html` required (max 1MB), `from_name` optional (max 78 chars, no `<>"\n`)
- [x] 1.3 Add `stripHtml()` to email-send.ts for auto-generating plaintext fallback (port from `inbound.mjs:256-271`)
- [x] 1.4 Append FOOTER_HTML and FOOTER_TEXT to raw mode bodies
- [x] 1.5 Construct SES `SendEmailCommand` with raw subject/html/text and optional display name (`"Name" <slug@mail.run402.com>`)
- [x] 1.6 Store raw-mode messages in `internal.email_messages` with `template: null`
- [x] 1.7 Add `from_name` support to template mode (same display name logic)

## 2. Team tier limit bump

- [x] 2.1 Change `emailsPerDay` from 200 to 500 in `packages/shared/src/tiers.ts` for team tier

## 3. Functions runtime email helper

- [x] 3.1 Add `email` object with `send()` method to the inlined helper in `writeLocalFunction()` (local dev path in `functions.ts`)
- [x] 3.2 Implement lazy mailbox discovery: `GET /v1/mailboxes` → cache mailbox ID → `POST /v1/mailboxes/:id/messages`
- [x] 3.3 Support both modes: `{ to, subject, html, text?, from_name? }` (raw) and `{ to, template, variables, from_name? }` (template)
- [x] 3.4 Propagate gateway error messages on 400/402/403/404/429 responses
- [x] 3.5 Add the same email helper to the Lambda layer (`build-layer.sh` HELPERJS heredoc)
- [x] 3.6 Import-stripping regex already handles `{ db, email, getUser }` — no change needed

## 4. Unit tests

- [x] 4.1 Add unit tests for raw mode: valid send, missing subject, missing html, html too large, from_name validation, auto-plaintext generation
- [x] 4.2 Add unit tests for mode detection: template-only, raw-only, both present (template wins), neither present
- [x] 4.3 Add unit tests for display name in template mode
- [x] 4.4 Add unit test verifying team tier emailsPerDay is 500

## 5. E2E tests

- [x] 5.1 Add raw HTML send E2E test: send raw email, verify 201, verify message in list with `template: null`
- [x] 5.2 Add display name E2E test: send with `from_name`, verify from_address format in message record
- [x] 5.3 Add inbound reply E2E test: send outbound, verify thread endpoint, real SES reply deferred to production-only

## 6. Functions email helper E2E test

- [x] 6.1 Deploy a function that uses `email.send()` with raw mode, invoke it, verify the email was sent (check mailbox messages list)
- [x] 6.2 Deploy a function that uses `email.send()` with template mode, invoke it, verify the email was sent

## 7. Docs

- [x] 7.1 Update `site/openapi.json` — add raw mode fields (`subject`, `html`, `text`, `from_name`) to the send message endpoint schema
- [x] 7.2 Update `site/llms.txt` — document raw HTML send mode and email helper
- [x] 7.3 Run `npm run test:docs` to verify alignment

## 8. Lambda layer publish

- [ ] 8.1 Rebuild and publish Lambda layer with the new email helper: `cd packages/functions-runtime && AWS_PROFILE=kychee ./build-layer.sh --publish` (deploy-time)
- [ ] 8.2 Update `LAMBDA_LAYER_ARN` in `infra/lib/pod-stack.ts` with new layer version (deploy-time)
- [ ] 8.3 Deploy CDK stack to update ECS task definition with new layer ARN (deploy-time)
