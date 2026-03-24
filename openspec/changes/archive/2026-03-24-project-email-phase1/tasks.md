## 1. Infrastructure & DNS

- [x] 1.1 Add MX record for `mail.run402.com` → `inbound-smtp.us-east-1.amazonaws.com` in Route 53 (via CDK or CLI)
- [x] 1.2 Create S3 bucket for inbound email storage (`agentdb-inbound-email-{account}`)
- [x] 1.3 Create SES receipt rule set with a rule for `mail.run402.com` → S3 + Lambda
- [x] 1.4 Create inbound email processing Lambda function (skeleton)
- [x] 1.5 Add IAM permissions: ECS task role → `ses:SendEmail`, `ses:SendRawEmail` for `mail.run402.com`
- [x] 1.6 Add all infra to `pod-stack.ts` (SES receipt rule, S3 bucket, Lambda, IAM)

## 2. Shared: Tier Config

- [x] 2.1 Add email limits to `TierConfig` type in `packages/shared/src/types.ts`: `emailsPerDay`, `uniqueRecipientsPerLease`
- [x] 2.2 Add email limit values to each tier in `packages/shared/src/tiers.ts` (prototype: 10/25, hobby: 50/200, team: 200/1000)

## 3. Database Schema

- [x] 3.1 Create `internal.mailboxes` table: `id`, `slug`, `project_id`, `status` (active/suspended/tombstoned), `tombstoned_at`, `sends_today`, `sends_today_reset_at`, `unique_recipients`, `created_at`, `updated_at`
- [x] 3.2 Create `internal.email_messages` table: `id`, `mailbox_id`, `direction` (outbound/inbound), `template`, `to_address`, `from_address`, `subject`, `body_text`, `ses_message_id`, `status` (sent/delivered/bounced/complained), `in_reply_to_id`, `s3_key` (raw MIME for inbound), `created_at`
- [x] 3.3 Create `internal.email_suppressions` table: `email_address`, `scope` (global/project), `project_id`, `reason` (bounce/complaint), `created_at`
- [x] 3.4 Create `internal.email_webhooks` table: `id`, `mailbox_id`, `url`, `events` (jsonb array), `created_at`
- [x] 3.5 Add indexes: mailboxes(project_id), mailboxes(slug), email_messages(mailbox_id, created_at), email_messages(to_address, mailbox_id), email_suppressions(email_address)

## 4. Mailbox Service

- [x] 4.1 Create `packages/gateway/src/services/mailbox.ts` with blocklist, slug validation (reuse subdomain pattern), CRUD operations
- [x] 4.2 Implement `createMailbox(slug, projectId)` — validate slug, check blocklist, check tombstone, check uniqueness, insert
- [x] 4.3 Implement `getMailbox(id)`, `listMailboxes(projectId)`, `deleteMailbox(id, projectId)` with tombstoning
- [x] 4.4 Implement `initMailboxesTable()` for auto-create on startup (same pattern as subdomains)

## 5. Email Send Service

- [x] 5.1 Create `packages/gateway/src/services/email-send.ts` with SES integration
- [x] 5.2 Define email templates (project_invite, magic_link, notification) with HTML + text versions and branded footer
- [x] 5.3 Implement `sendEmail(mailboxId, template, to, variables)` — validate template, check suppressions, check rate limits, render template, call SES SendEmail, store record
- [x] 5.4 Implement daily send counter with midnight UTC reset
- [x] 5.5 Implement unique recipient tracking per lease period
- [x] 5.6 Add `@aws-sdk/client-sesv2` dependency to gateway package.json

## 6. Email Receive Lambda

- [x] 6.1 Create inbound Lambda function: parse raw MIME from S3, extract sender/subject/body
- [x] 6.2 Implement reply-only validation: look up sender in `internal.email_messages` outbound records for the target mailbox
- [x] 6.3 Implement reply threading: match `In-Reply-To`/`References` headers to stored `ses_message_id`
- [x] 6.4 Store accepted replies in `internal.email_messages` with direction=inbound
- [x] 6.5 Drop silently for: unknown mailbox, tombstoned mailbox, unknown sender

## 7. Webhook & Event Processing

- [x] 7.1 Set up SES configuration set with SNS topic for delivery/bounce/complaint events
- [x] 7.2 Create SNS → Lambda handler to update message status in `internal.email_messages`
- [x] 7.3 Implement auto-suspend logic: suspend mailbox on first complaint or 3 bounces in 24h
- [x] 7.4 Implement suppression list management: add to global on complaint, add to project on hard bounce
- [x] 7.5 Implement project webhook fan-out: POST events to registered webhook URLs with retry (3 attempts, exponential backoff)

## 8. API Routes

- [x] 8.1 Create `packages/gateway/src/routes/mailboxes.ts` with `POST /v1/mailboxes`, `GET /v1/mailboxes`, `GET /v1/mailboxes/:id`, `DELETE /v1/mailboxes/:id`
- [x] 8.2 Add `POST /v1/mailboxes/:id/messages` — send email (template, to, variables)
- [x] 8.3 Add `GET /v1/mailboxes/:id/messages` — list messages with pagination
- [x] 8.4 Add `GET /v1/mailboxes/:id/messages/:messageId` — get single message with replies
- [x] 8.5 Add `POST /v1/mailboxes/:id/webhooks` — register webhook
- [x] 8.6 Add `PUT /v1/mailboxes/:id/status` — admin-only reactivate suspended mailbox
- [x] 8.7 Register routes in `server.ts`

## 9. Cascade Delete Integration

- [x] 9.1 Add `tombstoneProjectMailbox(projectId)` to the cascade in `packages/gateway/src/services/projects.ts`
- [x] 9.2 Ensure tombstoning is best-effort (log warning on failure, don't block archive)

## 10. Testing

- [x] 10.1 Write unit tests for slug validation and blocklist
- [x] 10.2 Write E2E test: create project → create mailbox → send invite → verify message stored → delete project → verify tombstone
- [x] 10.3 Test rate limiting: verify daily cap and unique recipient cap enforcement
- [x] 10.4 Test suppression: verify sends to suppressed addresses are rejected
