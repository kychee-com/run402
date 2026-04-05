## Context

Run402 sends all project email from `<slug>@mail.run402.com` via AWS SES. The `run402.com` domain is verified in SES with DKIM signing, production access (50k/day), and 14/sec send rate. Custom website domains already exist via Cloudflare (user adds CNAME, Cloudflare provisions SSL). Custom sender domains follow the same "bring your own domain" pattern but for email, using SES domain verification instead of Cloudflare.

## Goals

- Add API endpoints for registering, checking, and removing a custom email sender domain
- Verify custom domains via SES DKIM (3 CNAME records the user adds to their DNS)
- Route outbound email through verified custom domain when available
- Broaden IAM permissions so the gateway can manage SES identities

## Non-Goals

- Domain registration (user brings their own domain)
- Inbound email on custom domains (replies stay on `mail.run402.com`)
- Custom MAIL FROM subdomain (SPF alignment — can add later)
- Dedicated IPs per domain
- Multiple sender domains per project

## Decisions

### 1. SES domain verification (not Cloudflare)

**Choice:** Custom sender domains use AWS SES `CreateEmailIdentity` + DKIM CNAME verification. Completely separate from the Cloudflare-based website custom domains.

**Alternatives considered:**
- *Reuse Cloudflare for email:* Cloudflare Email Routing exists but is for inbound only. Outbound still needs SES. Mixing two systems for one feature adds complexity.
- *Third-party email provider (Postmark, SendGrid):* Would require migrating all email sending. SES is already working and verified.

**Rationale:** SES is already the email provider. Adding a domain to SES is one API call. The user adds 3 CNAME records (same pattern as adding a CNAME for website custom domains). No new infrastructure needed.

### 2. Endpoints under `/email/v1/domains/` (not `/v1/domains/`)

**Choice:** Email sender domains live at `/email/v1/domains/` — separate from website custom domains at `/v1/domains/`.

**Alternatives considered:**
- *Same `/v1/domains/` endpoint:* Would conflate two different systems (Cloudflare for websites, SES for email). A domain could be used for both but verification is independent.

**Rationale:** Clear separation. A project might have `kysigned.com` as a website domain (Cloudflare) AND as a sender domain (SES). These are verified independently and serve different purposes. Separate endpoints prevent confusion.

### 3. One sender domain per project, wallet-scoped ownership

**Choice:** Each project can have at most one custom sender domain. Domain ownership is per-wallet — once a domain is verified by one project, other projects owned by the same wallet can reuse it instantly (no re-verification). Different wallets cannot claim the same domain.

**Rationale:** The domain owner proves ownership once via DNS. All their projects (same wallet) should benefit without repeating verification. This matches how a company owns one domain but runs multiple products. The SES identity is shared — `DeleteEmailIdentity` is only called when the last project using the domain removes it.

**Alternatives considered:**
- *Globally unique (one project only):* Unnecessarily restrictive for multi-project operators.
- *No ownership restriction:* Would allow domain stealing — anyone could claim any domain. DNS verification prevents this in theory but adds a race condition window.

### 4. Fallback to `mail.run402.com` when unverified

**Choice:** If a project registers a custom domain but it's not yet verified (DNS records not added), email continues sending from `<slug>@mail.run402.com`. No disruption.

**Rationale:** Registration is async (user must add DNS records). Blocking email sending during verification would be a bad UX. The transition is seamless — email starts going through the custom domain the moment verification succeeds.

### 5. IAM broadening: `identity/*` with SES management permissions

**Choice:** Broaden ECS task role from `ses:SendEmail` on `identity/run402.com` to `identity/*`. Add `ses:CreateEmailIdentity`, `ses:DeleteEmailIdentity`, `ses:GetEmailIdentity`.

**Alternatives considered:**
- *Per-domain IAM grants:* Add a policy statement for each new domain. Precise but requires CDK deploy for every new domain — defeats the purpose of self-service.

**Rationale:** The gateway already validates ownership (project must own the domain in DB). IAM-level restriction to specific domains would require infrastructure changes per domain. Wildcard is safe because the gateway enforces all access control.

### 6. Blocklist: platform domains + common public email providers

**Choice:** Block registration of `run402.com`, `mail.run402.com`, `kychee.com`, and common public email providers (`gmail.com`, `outlook.com`, `yahoo.com`, etc.).

**Rationale:** Prevents impersonation of the platform and abuse via public email domains (which would fail SES verification anyway, but better to catch early with a clear error).

## Risks / Trade-offs

**DNS propagation delay** → User adds CNAME records but verification takes time (minutes to hours). *Mitigation:* The status endpoint polls SES live. Document expected timeline.

**Orphaned SES identities** → Project deleted but SES identity remains. *Mitigation:* Cascade domain cleanup on project deletion (same pattern as website custom domains).

**SES identity limit** → Default SES limit is 10,000 identities per account. *Mitigation:* Well within expected scale. Can request increase if needed.

## Migration Plan

Additive change. No breaking migrations.

1. CDK deploy: broaden ECS task role SES permissions + add SES management permissions
2. Gateway startup migration: `CREATE TABLE IF NOT EXISTS internal.email_domains`
3. Deploy gateway with new routes + modified email-send
4. Existing projects unaffected — custom sender domains are opt-in
