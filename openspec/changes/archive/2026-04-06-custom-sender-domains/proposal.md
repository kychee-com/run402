## Why

Run402 sends all project email from `<slug>@mail.run402.com` via SES. Products built on run402 that need their own brand identity (e.g., sending from `notifications@kysigned.com`) can't do so today — every email carries the `mail.run402.com` domain regardless of the product.

Email deliverability depends heavily on sender domain reputation. A shared `mail.run402.com` domain means all products share reputation — one bad actor's spam complaints affect everyone. Custom sender domains isolate reputation, improve deliverability (branded DKIM signatures), and let products present a professional identity to their users.

The AWS SES infrastructure already supports this — `run402.com` is verified with production access (50k/day quota). Adding a new domain is a `CreateEmailIdentity` API call + DNS record verification. The complexity is in the user-facing flow: the domain owner needs to add DNS records, and the platform needs to track verification status.

## What Changes

- **Gateway**: New endpoints under `/email/v1/domains/` for registering a custom sender domain, checking verification status, and removing a domain. Domain registration triggers SES `CreateEmailIdentity`, returns the required DNS records (3 DKIM CNAMEs + optional SPF TXT + DMARC TXT). Status endpoint polls SES for verification progress.
- **Email sending**: When a project has a verified custom sender domain, `email-send.ts` sends from `<slug>@<custom-domain>` instead of `<slug>@mail.run402.com`. Falls back to `mail.run402.com` if the custom domain isn't verified yet.
- **IAM**: ECS task role currently scoped to `arn:aws:ses:*:*:identity/run402.com`. Needs broadening to allow sending from any verified domain (either wildcard or per-domain grants via CDK).
- **Database**: New `internal.email_domains` table tracking domain name, project ID, verification status, DNS records, and SES identity ARN. Domain ownership is per-wallet — once verified by one project, other projects owned by the same wallet can reuse it without re-verification.
- **Inbound reply support**: Optional — if the custom domain wants reply processing, the owner adds an MX record and we create a SES receipt rule. Not required for MVP (outbound-only is sufficient).
- **Docs**: Update `llms.txt`, `openapi.json`, `llms-cli.txt` with custom sender domain endpoints.
- **MCP/CLI**: New tools for domain registration, status check, and removal.
- **BREAKING**: None. Existing projects continue sending from `mail.run402.com`. Custom sender domains are opt-in.

## Non-goals

- Custom MAIL FROM subdomain configuration (can be added later for SPF alignment)
- Inbound email on custom domains (MVP is outbound-only; reply processing stays on `mail.run402.com`)
- Dedicated IP addresses per domain (SES shared IP pool is fine for typical volumes)
- Domain warmup automation (domain owners handle their own warmup for high-volume sending)
- Email template customization per domain (templates stay the same, only the From address changes)

## Capabilities

### New Capabilities

- `custom-sender-domain`: Register a custom sending domain for project email. Platform verifies the domain via SES (DKIM), provides required DNS records, tracks verification status, and routes outbound email through the verified domain. One domain per project. Includes domain removal and re-verification.

### Modified Capabilities

- `email-send` (modified): When a project has a verified custom sender domain, outbound email uses `<slug>@<custom-domain>` instead of `<slug>@mail.run402.com`. Unverified or missing custom domains fall back to the default.

## Impact

- **Gateway** (`packages/gateway/src/`): New route handler for `/email/v1/domains/`, new service module for SES domain management (`email-domains.ts`), modified `email-send.ts` to resolve sender domain per project.
- **Database**: New `internal.email_domains` table (domain, project_id, status, dkim_records, ses_identity_arn, verified_at, created_at). Startup migration in server.ts.
- **Infrastructure** (`infra/lib/pod-stack.ts`): Broaden ECS task role SES permissions from `identity/run402.com` to `identity/*` (or use a prefix pattern). Add `ses:CreateEmailIdentity`, `ses:DeleteEmailIdentity`, `ses:GetEmailIdentity` permissions.
- **Email sending**: Lookup custom domain from cache/DB before sending. If verified, use it; otherwise fall back.
- **Tests**: Unit tests for domain registration, verification polling, sender domain resolution. E2E test for register → DNS record display → (simulated) verification → send from custom domain.
- **Docs**: `site/llms.txt`, `site/llms-cli.txt`, `site/openapi.json` gain custom sender domain documentation.
- **MCP/CLI**: New tools/commands for `register_sender_domain`, `sender_domain_status`, `remove_sender_domain`.
