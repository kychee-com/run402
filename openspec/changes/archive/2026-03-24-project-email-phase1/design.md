## Context

Run402 projects currently have no email capability. The platform already has SES domain verification and DKIM configured for `run402.com`, and Route 53 is fully managed. The subdomain system (`internal.subdomains`) provides a proven pattern for project-scoped resource management with blocklists, validation, caching, and ownership checks.

Projects are scoped to wallet-authenticated tiers (prototype/hobby/team) with hard caps. Email must follow the same bounded model: capped sends, lease-tied lifecycle, 402 on exhaustion.

SES is currently in sandbox mode (200/day, verified recipients only). Production access request is pending.

## Goals / Non-Goals

**Goals:**
- 1 mailbox per project at `<slug>@mail.run402.com`
- Template-based outbound (invite, magic link, notification) via SES
- Reply-only inbound via SES receipt rules → S3 → Lambda → Postgres
- Per-tier send caps with hard limits
- Branded footer on all outbound ("Sent by an AI agent via run402.com")
- Abuse prevention: auto-suspend on bounce/complaint, suppression lists
- Clean lifecycle: mailbox archived with project, tombstone on email address

**Non-Goals:**
- Arbitrary HTML email composition
- CC/BCC or multi-recipient sends
- Attachments (inbound or outbound)
- Custom sending domains
- SMTP/IMAP access
- Full inbox semantics (threads, labels, search)
- Mailbox aliases or plus-addressing (future phase)

## Decisions

### 1. Use `mail.run402.com` subdomain, not root domain

Mailbox addresses are `<slug>@mail.run402.com`, not `<slug>@run402.com`.

**Why:** Isolates agent-generated mail from company/brand mail. Reduces stoplist burden. Keeps root domain available for human mailboxes (info@, support@, etc.). If agent mail damages reputation, only the `mail` subdomain is affected.

**Alternative considered:** Root domain addresses — rejected because the blocklist becomes enormous and any abuse taints the entire domain's deliverability.

### 2. Template-only outbound

Agents pick from predefined templates (`project_invite`, `magic_link`, `notification`) and fill variables. No freeform subject/body.

**Why:** Controls every character leaving `run402.com`. Prevents phishing, impersonation, and spam. The footer ("Sent by an AI agent via run402.com") is guaranteed present. Agents can still customize the content via template variables (project name, invite URL, message text).

**Alternative considered:** Freeform with content scanning — rejected because content moderation is complex and unreliable at low volume.

### 3. Reply-only inbound

Inbound mail is accepted only from addresses that the project has previously sent to (tracked in `internal.email_messages`). All other inbound is silently dropped.

**Why:** Prevents the mailbox from becoming a spam target. Projects don't need arbitrary inbound — they need replies to their invites/notifications.

**Alternative considered:** Allowlist-based inbound — deferred to phase 2.

### 4. SES receipt rules → S3 → Lambda for inbound

Inbound flow: MX record for `mail.run402.com` → SES receipt rule → store raw MIME in S3 → trigger Lambda → Lambda parses, validates sender against reply-only policy, stores metadata in Postgres.

**Why:** SES has no built-in mailbox. S3 + Lambda is the standard AWS pattern for programmatic inbound. Lambda can run the reply-only check, parse MIME, and write to the DB. The gateway doesn't need to be involved in receiving.

**Alternative considered:** SNS → gateway webhook — rejected because it couples inbound processing to gateway availability and adds latency.

### 5. Slug = project name, not project ID

The mailbox address uses the project's `name` field (slugified), not the UUID. E.g., `workout-tracker@mail.run402.com` not `p0042@mail.run402.com`.

**Why:** Human-readable email addresses. Recipients see a meaningful sender name. The project name is already unique-ish (validated at creation), and the mailbox table enforces uniqueness on the slug.

**Alternative considered:** Project ID — rejected because `a1b2c3d4@mail.run402.com` looks like spam.

### 6. Tombstone period for deleted mailboxes

When a project is archived, the mailbox is marked `tombstoned` with a `tombstoned_at` timestamp. The slug cannot be reused for 90 days.

**Why:** Prevents a new project from receiving password resets, delayed replies, or private mail intended for the previous owner.

### 7. Per-tier email caps

| Tier | Sends/day | Unique recipients/lease | Mailbox |
|------|-----------|------------------------|---------|
| prototype | 10 | 25 | 1 |
| hobby | 50 | 200 | 1 |
| team | 200 | 1000 | 1 |

**Why:** Aggressive limits match the use case (invite a few users to your project) and prevent bulk sending. The unique-recipient cap bounds the blast radius even if daily caps are hit repeatedly.

### 8. Gateway sends outbound directly via SES SDK

The gateway service calls `@aws-sdk/client-sesv2` `SendEmail` directly, rather than going through a queue or worker.

**Why:** Simplicity. Volume is tiny (max 200/day on team tier). No need for async processing. The gateway already has AWS credentials via the ECS task role. If volume grows, this can be extracted to a queue later.

**Note:** The ECS tasks run in public subnets with public IPs (no NAT gateway), so they can reach SES endpoints directly.

## Risks / Trade-offs

**[SES sandbox mode]** → Currently limited to 200 emails/day and verified recipients only. Production access request is pending. Mitigation: the per-tier caps are well below 200/day total, so sandbox is only a problem for recipient verification. Must get production access before launch.

**[Domain reputation]** → Even with templates, a bad actor could use `notification` template with misleading content in the message variable. Mitigation: rate limits bound the damage; auto-suspend on first complaint; consider content-length limits on freeform variables.

**[Slug collisions]** → Two projects named "my-app" would conflict. Mitigation: mailbox creation checks uniqueness and returns 409. Agent can retry with a different name or use a suffix.

**[Inbound Lambda cold starts]** → Replies may take 1-2s to process on cold start. Mitigation: acceptable for email — users don't expect instant processing of replies.

**[Tombstone bloat]** → Long tombstone periods accumulate rows. Mitigation: 90-day TTL with periodic cleanup job. Low volume makes this negligible.
