## Why

Run402 projects currently have no way to communicate with end users via email. Agents building apps (workout trackers, CRMs, club directories) need to invite users, send magic links, and deliver notifications. Without email, agents must punt this to the human or skip it entirely. Adding project-scoped email — bounded, template-based, and abuse-resistant — fills this gap while keeping Run402's domain reputation safe.

## What Changes

- Each project gets **1 mailbox** at `<project-slug>@mail.run402.com`, created on demand via API
- **Template-based outbound** only: `project_invite`, `magic_link`, `notification` — no arbitrary HTML
- **Reply-only inbound**: only prior recipients can reply; replies stored and available via API
- **Hard caps per tier**: daily send limit, unique-recipient limit, storage limit — 402 when exceeded
- **Blocklist** of reserved local parts (`admin`, `info`, `support`, `postmaster`, etc.)
- **Branded footer** on all outbound: "Sent by an AI agent via run402.com" (removable on paid tiers)
- **Webhook events** for delivery, bounce, complaint — with auto-suspend on abuse
- **SES integration**: outbound via SES SendEmail, inbound via SES receipt rules + S3 + Lambda
- **DNS**: MX record for `mail.run402.com`, SPF/DKIM/DMARC already configured on root domain
- Mailbox lifecycle tied to project lease — archived when project is archived
- Email addresses get a **tombstone period** after deletion (no immediate reuse)

## Capabilities

### New Capabilities
- `project-mailbox`: Mailbox creation, lookup, deletion, and lifecycle management (1 per project, tied to project lease)
- `email-send`: Template-based outbound email via SES with rate limiting, caps, and branded footer
- `email-receive`: Inbound email processing via SES receipt rules, S3 storage, reply-only policy
- `email-webhooks`: Delivery/bounce/complaint event tracking and project webhook fan-out

### Modified Capabilities
- `cascade-project-delete`: Must also delete/tombstone the project's mailbox and suppress the email address

## Impact

- **New routes**: `POST/GET/DELETE /v1/mailboxes`, `POST/GET /v1/mailboxes/:id/messages`
- **New infra**: SES receipt rule set, S3 bucket for inbound email, Lambda for inbound processing, MX record for `mail.run402.com`
- **New DB tables**: `internal.mailboxes`, `internal.email_messages`, `internal.email_suppressions`
- **CDK changes**: `pod-stack.ts` — SES identity, receipt rules, Lambda, S3 bucket, IAM for SES send
- **Gateway changes**: new route file, new service, SES SDK dependency (`@aws-sdk/client-sesv2`)
- **Shared changes**: add email limits to tier definitions
- **MCP server**: new tools (`create_mailbox`, `send_email`, `list_messages`)
