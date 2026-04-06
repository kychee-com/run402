---
product: saas-factory
version: 1.9.0
status: Draft
type: product
interfaces: [document]
created: 2026-04-04
updated: 2026-04-06
---

## Overview

The SaaS Factory is a single-file reference document template that ensures every Kychee SaaS-killer product launches complete and strategically sound. It is copied into each new product's repo, fed as context to the `/brainstorm`, `/spec`, and `/plan` skills, and retired after `/plan` completes. It codifies the full lifecycle — from disruption strategy through legal, marketing, collateral, and cross-linking — using Crossing the Chasm and Innovator's Dilemma as guiding frameworks.

## Interfaces & Mediums

- **Format:** Single markdown file (`saas-factory.md`)
- **Location in each product repo:** `docs/saas-factory.md`
- **Master copy location:** `docs/products/saas-factory/saas-factory.md` in the run402 repo
- **Consumed by:** Human operator (reads, fills DECIDE items, approves), AI agent (scans during skill execution, flags gaps, drafts deliverables)
- **Consumed during:** `/brainstorm`, `/spec`, `/plan` phases only — not needed during `/implement` or `/validate`

## Features & Requirements

### F1. Document Structure

The factory doc is a single markdown file organized into numbered chapters. Each chapter covers one domain of the product launch lifecycle. Chapters contain:
- Brief context explaining why this domain matters
- Checkboxes for actionable tasks
- Every checkbox is tagged with exactly one ownership label: `AI`, `HUMAN`, or `DECIDE`
- Framework callouts (Crossing the Chasm, Innovator's Dilemma) where strategic methodology applies

### F2. Chapter Coverage

The factory doc contains 11 chapters, in this order:

1. **Product Strategy** — kill target, attack angle, beachhead segment (Crossing the Chasm), low-end disruption angle (Innovator's Dilemma), core differentiator, competitive landscape, MVP definition
2. **Dual Delivery Model** — two repos per product: a public MIT-licensed repo (the forkable template — product code, schema, seeds, deploy script, customization guide) and a private service repo (marketing site, hosted SaaS backend, proprietary services, billing, admin tools). The public repo is agent-deployable with a builder-targeted README. The private repo runs on run402 infrastructure and contains the monetization layer, subdomain strategy, and any paid premium services. Explicitly names three audiences: builders, end users, AI agents
3. **Domain and Branding** — product domain name selection, logo, brand assets (colors, typography, tone), domain registration
4. **Website** — landing page (attack-angle-led, dual CTA for SaaS and repo), "SaaS vs Repo" decision helper, pricing page, documentation. Three content layers: FAQ (human), how-to snippets (human-to-agent), llms.txt (agent-native)
5. **Legal** — Terms of Service, Privacy Policy, Cookie/consent notice, Acceptable Use Policy, DPA. All drafted from existing Kychee/Eleanor/run402 templates. All require human approval before launch
6. **Analytics and Tracking** — GA4 property setup under Kychee account, measurement ID, data streams, page tags, key events, conversion goals
7. **Infrastructure Review** — audit run402 capabilities vs product needs, list gaps, create enhancement tasks, implement changes. Not a gate — a task list
8. **Marketing Strategy** — hypothesis card (beachhead, channel, budget, timeframe, signal metrics, success threshold, kill criteria, next steps), shared marketing infrastructure (SaaSpocalypse movement hub, segment hubs), per-product channel strategy and ad campaigns
9. **Collateral** — logo, ad creatives (static), video ad, social media assets, README hero image/screenshots. All AI-generated, human-approved
10. **Cross-Linking** — kychee.com portfolio entry, "Built on run402" mention, bld402 cross-links, segment hub links, SaaSpocalypse hub links, run402.com showcase
11. **Business Plan** — monetization model, cost structure, hypothesis, success criteria, scale plan, unfair advantage

### F3. Task Ownership Taxonomy

Every checkbox in the factory doc uses exactly one of three labels:
- **AI** — task is executed by the AI agent, may require human review
- **HUMAN** — task requires human action or final approval (human gate)
- **DECIDE** — strategic decision that must be made collaboratively (typically during brainstorm or spec phase)

Tasks that are AI-executed but require human approval use the format: `AI: [task description] -> HUMAN: Approve`

### F4. FAQ as Conversion Weapon

Chapter 4 (Website) mandates a strategically structured FAQ with six categories that every product must address:
1. **Trust/survival** — "What if you shut down?", "Where's my data?", "Can I export?"
2. **Migration** — "How do I move from [incumbent]?", "Will I lose my data?"
3. **Capability gap** — honest comparison of what this product does and does not do vs the incumbent
4. **Legal/compliance** — "Is this GDPR compliant?", "Who owns my data?"
5. **Pricing/catch** — "How is this free?", "What's the catch?"
6. **SaaS vs repo guidance** — decision helper for choosing between hosted SaaS and self-hosted repo, including how-to snippets for agent-assisted deployment

### F5. Three Content Layers

Every product website ships three distinct content layers targeting three audiences:
1. **FAQ** — human-readable, conversion-focused, addresses the six categories above
2. **How-to snippets** — copyable prompts for humans who use AI agents (e.g., "Tell your agent to deploy this with run402")
3. **llms.txt** — machine-readable product description following the llms.txt convention, enabling AI agents to autonomously discover and provision the product

### F6. Hypothesis Card

Chapter 8 (Marketing Strategy) mandates a hypothesis card that must be completed before any marketing spend. The card contains:
- Beachhead segment — specific, findable, reachable group
- Primary channel — single channel for the pilot (default; multi-channel allowed if justified)
- Pilot budget — $500 reference floor, flexes up per product
- Timeframe — 2-4 weeks typical
- Signal metrics — product-specific (signups, stars, conversion rate, CAC, etc.)
- Success threshold — concrete, quantified target
- Kill criteria — what tells you to stop
- Next step if success — budget increase, channel expansion, target KPIs

### F7. Shared Marketing Infrastructure

The factory doc connects each product to two shared marketing layers:
1. **SaaSpocalypse** — movement brand with Facebook page and hub at kychee.com/saaspocalypse. Aggregates all SaaS-killer products under a "we're killing overpriced SaaS" narrative
2. **Segment hubs** — audience-specific pages (e.g., kychee.com/for/freelancers) that curate relevant products per target audience

Each product specifies which SaaSpocalypse channels and segment hubs it participates in.

**SaaSpocalypse content model:** Event-driven, not calendar-driven. Content is posted when there is something worth saying — product launches, industry pricing outrage news, community feedback sessions ("tell us what you need"), engagement posts. No fixed cadence.

**Segment hub curation:** When multiple products target the same segment, the order/emphasis on the hub page is manually curated by the human operator (HUMAN task) based on strategic priority for that audience — not by recency or automated ranking.

### F8. Legal Human Gate

All legal documents (ToS, Privacy Policy, Cookie notice, AUP, DPA) are drafted by AI from existing Kychee/Eleanor/run402 templates but require explicit human approval before the product launches. The factory doc marks these as `AI: [draft] -> HUMAN: Approve` and the product cannot ship until all legal approvals are checked off.

**Public repo legal (LEGAL.md):** Every public MIT-licensed repo ships a `LEGAL.md` file separate from the MIT `LICENSE`. The MIT license covers code usage rights and the standard "AS IS" / no warranty disclaimer. `LEGAL.md` covers product-specific disclaimers that MIT does not address:
- What the product's output proves and does not prove (evidentiary value, not guaranteed legal enforceability)
- No guarantee of legal enforceability in any specific jurisdiction
- Permanence disclaimers for on-chain or irreversible operations
- Operator responsibility: the forker/deployer is responsible for their own privacy compliance, Terms of Service, and legal obligations — not Kychee
- Product-specific excluded use cases or regulatory limitations

`LEGAL.md` is drafted by AI and requires human approval before the repo is published: `AI: Draft LEGAL.md -> HUMAN: Approve`.

**Reference LEGAL.md:** Use `kysigned/LEGAL.md` as the canonical reference template for future SaaS products. It covers all required sections (evidentiary disclaimers, jurisdictional limitations, smart contract permanence, operator responsibility, excluded document types, AS-IS/no-liability, no legal advice) and has been human-approved. Adapt product-specific sections as needed; preserve the structure and liability language.

### F9. Cross-Linking to Kychee Ecosystem

Chapter 10 mandates that every product is woven into the broader Kychee ecosystem:
- Listed on kychee.com (portfolio/products page)
- "Built on run402" mention with link on the product site
- Cross-linked to/from bld402 where the builder audience is relevant
- Cross-linked to/from applicable segment hub pages
- Cross-linked to/from the SaaSpocalypse hub
- Added to run402.com showcase/examples where appropriate
- Added to kychee.com/llms.txt (central agent-discovery directory for all Kychee products)
- Added to run402.com/llms.txt (central agent-discovery directory for all run402-hosted products)

### F10. Skill Chain Integration

The factory doc is designed to be consumed as a reference by three skills:

| Skill | Chapters scanned | Purpose |
|---|---|---|
| `/brainstorm` | 1, 2, 8, 11 | Ensure strategic decisions are explored before specifying |
| `/spec` | 2, 3, 4, 5, 6, 7, 10 | Ensure spec covers all deliverables (website, FAQ, legal, llms.txt, analytics, cross-links) |
| `/plan` | All (1-11) | Ensure every unchecked task becomes a planned work item with role assignment |

The factory doc is not consumed by `/implement` (plan has all tasks) or `/validate` (validates against spec).

### F11. Lifecycle Per Product

The factory doc prescribes this lifecycle for each SaaS-killer product:
1. **Name and domain** — Choose a product name. Search for available `.com` domains. Register the domain via AWS Route 53 (AI can do this — use `aws route53domains register-domain` with the `kychee` AWS profile). The domain defines the product name, repo names, doc paths, and all downstream naming. Do this first — everything else depends on it.
2. Mark the segment as "🔨 IN PROCESS" in `docs/products/saas-segments/saas-killing-segments-ranked.md` with a link to the product repo — signals that implementation has begun and prevents duplicate efforts
3. Create GitHub repos (`kychee-com/<product>` public, `kychee-com/<product>-service` private) using the registered name
4. Copy `saas-factory.md` into the new product's repo at `docs/saas-factory.md`
5. Run `/brainstorm` with factory doc as reference — explores strategy, fills DECIDE items
6. Run `/spec` with factory doc as reference — specifies all deliverables
7. Run `/plan` with factory doc + spec as reference — decomposes all remaining tasks
8. Run `/implement` — executes the plan (factory doc no longer needed)
9. Run `/validate` — tests against spec
10. Human final review — legal sign-off, collateral approval, launch go/no-go

**Template versioning:** The product copy is a snapshot — like a printed page. Teams mark checkboxes and fill DECIDE items on their copy, but never edit the template content itself. If lessons learned require changing the template, updates go to the master copy in the run402 repo only. Future products get the improved master. In-progress products are not retroactively updated — if a critical improvement is needed, the product re-copies from master and re-fills.

### F12. Dual Delivery for Every Product

Every SaaS-killer product launches simultaneously as two delivery modes, backed by **two separate repos**:

**A. Public Repo** (`kychee-com/{product}`) — MIT-licensed, forkable template
- Contains: product code (frontend, functions, schema, seeds, deploy script, customization guide, demo variants)
- Agent-deployable (an AI agent can clone and deploy on run402 with minimal prompts)
- README targets developers/builders
- Human-reviewed structure
- Clean fork experience — no marketing site, no proprietary service code, no Kychee-specific infrastructure

**B. Private Service Repo** (`kychee-com/{product}-service`) — proprietary
- Contains: marketing/product website ({product-domain}.com), hosted SaaS backend, premium services (AI agents, concierge, pro tiers), billing/customer DB, admin tools
- Runs on run402 infrastructure (eat our own dog food)
- Agent-provisionable (an AI agent can provision via API or MCP)
- Product-specific monetization model (freemium, usage-based, flat fee — decided per product)
- Optional user subdomains (e.g., joe.productname.com — decided per product)

**Why two repos:** The MIT license on the public repo must cover only the forkable template. Marketing copy, brand assets, proprietary service logic, and paid features must not be MIT-licensed. The marketing site sells the hosted service and evolves with pricing/premium features, not with the template's feature set. Forkers get a pristine repo with exactly what they need.

**Build order and no-duplication rule:** The public repo is always built first as the core product. The private service repo imports/depends on the public repo and adds the service layer on top (billing, branded website, premium features, legal docs, analytics). No code duplication — the service repo never re-implements what the public repo provides. This means:
- The public repo is the library/engine; the service repo is the application built on it
- Building the service repo inherently exercises and tests the public repo extensively
- Bug fixes and improvements go into the public repo (core) and flow to the service automatically
- The plan builds the public repo first, then the service repo on top of it

**Dependency model between repos:** The service repo depends on the public repo as a package dependency. Both repos are cloned under the same workspace. The dependency evolves through three stages:

1. **Active development:** `"file:../{product}"` — local path reference. Changes to the public repo are instantly available in the service repo (npm/node creates a symlink). Two real repos from day one, clean boundary enforced, no commit-push-install cycle during iteration.
2. **Stable but pre-public:** `"github:kychee-com/{product}#v1.0.0"` — git dependency pinned to a tag. Used when the public repo is stable but not yet published to npm.
3. **Public and mature:** `"{product}"` — npm package, versioned. Used when the public repo is published on npm.

Each transition is a single-line change in the service repo's `package.json`. The public repo stays private on GitHub until launch-ready, then is flipped to public. **Before going public, squash all development history into a single "v1.0.0" commit** (orphan branch, force-push as main). The public sees a clean, audited first release with no draft iterations, license edits, or intermediate states. The MIT license applies from this first public commit forward.

**Workspace layout and where work happens:**
- **Product code** → product repos (`kychee-com/{product}` and `kychee-com/{product}-service`), cloned side by side under the workspace
- **Docs (plan, spec, brainstorm)** → run402 repo (`docs/products/{product}/`, `docs/plans/`)
- **run402 platform enhancements** triggered by a product's needs → run402 worktree on a feature branch. Product plans often surface missing platform capabilities (e.g., new payment models, auth methods). These are implemented in run402 via worktree, not in the product repos.

**VS Code multi-root workspace setup:** After creating and cloning the repos, create a `{product}.code-workspace` file in the parent workspace directory with all three repos as folders:
```json
{
  "folders": [
    { "path": "{product}", "name": "{product} (public)" },
    { "path": "{product}-service", "name": "{product}-service (private)" },
    { "path": "run402", "name": "run402 (docs + platform)" }
  ]
}
```
Open this workspace file in VS Code before continuing implementation. This gives visibility into all three repos, independent git context per repo, cross-repo search, and working `file:` dependency resolution. **This is a STOP point in the plan** — switch to the new workspace view before proceeding with implementation.

Both options presented on the product website (in the private service repo) with a decision helper for choosing between them.

### F13. Three Audiences as First-Class

Every chapter of the factory doc considers three distinct audiences:
1. **Builders** — want the repo, will fork/customize, self-host on run402 or elsewhere
2. **End users** — want the hosted SaaS, want it to work immediately
3. **AI agents** — acting on behalf of a human, need to deploy the repo on run402 OR provision the hosted SaaS programmatically

### F14. Strategic Frameworks

The factory doc applies two complementary disruption frameworks:
1. **Crossing the Chasm (Moore)** — pick one beachhead segment, dominate it completely, then expand. Applied in: beachhead selection, channel focus, segment hubs
2. **Innovator's Dilemma (Christensen)** — disrupt from below with "good enough + free" where incumbents can't respond. Applied in: attack angle, MVP definition, pricing strategy

### F15. Branding Rules

- Each product gets its own domain (only products get domains)
- Marketing hubs and segment pages live under kychee.com
- run402 is mentioned as infrastructure, never as the product brand
- Kychee is the legal entity, owner, and advertiser for all products
- SaaSpocalypse is a movement brand under Kychee (kychee.com/saaspocalypse), not a separate domain

### F16. Agent-Ready: Product CLI/MCP

Every product ships with a CLI and/or MCP server exposing its core functions, when applicable to the product's domain. This enables AI agents to:
- Provision and configure the hosted SaaS programmatically
- Deploy the OSS repo on run402 (or elsewhere) without human intervention
- Interact with the product's core features (e.g., create a form, add a booking slot, pull analytics)

The CLI/MCP is a first-class deliverable, not an afterthought — it is part of the product's agent-readiness alongside llms.txt.

### F17. Central Agent Discovery

Both kychee.com and run402.com maintain an llms.txt file that serves as a central directory of all Kychee SaaS products. Each entry links to the individual product's llms.txt. This enables AI agents to discover all available products from one endpoint. Updated as a cross-linking task (chapter 10) whenever a new product launches.

### F18. T1/T2 Billing Model

Every Kychee SaaS product must be designed with a clear distinction between two tiers of payment:

**T1 — Infrastructure billing (app-owner → run402):**
- The app owner (Kychee for hosted services, or a forker for self-hosted) pays run402 for infrastructure: compute, database, email, wallet custody, custom domains, KMS key management.
- T1 is always active for any deployed instance. Without T1, nothing runs.
- run402 currently supports T1 via its existing billing and credit system.

**T2 — End-user billing (app-user → app-owner):**
- The app's end users pay the app owner for the product's value (e.g., $0.25 per signed envelope, $2 per booking).
- T2 may or may not exist depending on the product:
  - **Internal-use forkers** (e.g., a law firm running kysigned for employees) have no T2 — they absorb T1 costs.
  - **Commercial SaaS operators** (e.g., kysigned.com) need T2 to charge end users.
- T2 can be implemented in three ways:
  1. **Wallet-native (x402/MPP)** — the app user's wallet pays the app owner's wallet directly via an HTTP payment header. run402 provides the protocol middleware (already implemented). This is the cleanest T2 pattern because it requires no Stripe integration, no merchant-of-record liability, and works natively for wallet-having users.
  2. **App-owned Stripe integration** — the app operates its own Stripe account and handles fiat billing itself. The app is the merchant of record. Required when targeting non-wallet users. Requires PCI compliance awareness, Stripe account lifecycle management, and careful legal framing.
  3. **Platform T2 via run402 (FUTURE, not yet available)** — run402 would offer Stripe-collection-as-a-service: run402 accepts Stripe payments from end users on the app's behalf and credits the app's run402 balance. Would eliminate app-owned Stripe for every product. Deferred post-MVP across all products.

**Design rule for every new Kychee product:**
- Explicitly specify which T2 mechanism(s) the product uses (wallet-native, app-owned Stripe, or "no T2 — internal use only")
- If using app-owned Stripe, keep it in the private `[service]` repo, NOT the public MIT repo, to avoid forcing forkers into PCI/merchant-of-record obligations
- If the public repo supports only wallet-native T2 (common case), provide a clear `allowed_senders`-style access control primitive so self-hosted forkers can safely deploy without becoming an open relay (see kysigned F2.8 for reference)
- When platform T2 via run402 becomes available, every product with app-owned Stripe should have a documented migration path to switch to it

**Key language for specs, docs, and conversations:**
- "T1" = infrastructure (app pays run402)
- "T2" = end-user billing (user pays app)
- "T2-native" = wallet-based payment where the user's wallet pays directly (x402/MPP)
- "T2-reseller" = the app operates its own Stripe to resell run402 capacity as an end-user service
- Never conflate T1 and T2 in product specs. Any ambiguity about which tier a payment belongs to must be resolved before implementation begins.

### F19. Geo-Aware Cookie Consent

Every Kychee product website must implement a **geo-aware cookie consent banner** that minimizes friction for users in jurisdictions where consent is not legally required, while staying compliant where it is.

**The rule:** Show the banner only when required by the user's jurisdiction. Default-on for analytics (no banner) where the law permits. When the jurisdiction is unknown or detection fails, **fail-safe to compliant** — show the banner.

**Required jurisdictions (banner MUST be shown):**
- European Union member states (GDPR + ePrivacy Directive) — granular consent, default-off, equally prominent reject button
- United Kingdom (UK GDPR + PECR) — same as EU
- Brazil (LGPD) — same standards
- Canada (PIPEDA) — informed consent required
- Switzerland (revFADP)
- California (CPRA) — show "Do Not Sell or Share" link in footer; full banner not strictly required but recommended for ad cookies

**Permitted jurisdictions (no banner needed, default-on):**
- United States (other than California) — federal law permits analytics and advertising cookies without banner
- Most of Asia, Latin America, Africa (varies, conservative default = US-permissive)

**Detection method (in order of preference):**
1. **Cloudflare CF-IPCountry header** — free, reliable, available on Cloudflare-fronted sites
2. **AWS CloudFront geo headers** — `cloudfront-viewer-country`
3. **Lightweight server-side IP geolocation** — only if neither of the above is available
4. **Browser language as a weak hint only** — never as the sole signal (a German-speaking user in Texas should not see the banner)
5. **Fallback: show the banner** — when detection fails or returns unknown

**Banner UX requirements (when shown):**
- Three categories with independent toggles: Essential (always on, not toggleable), Analytics, Marketing
- "Reject all" button MUST be as visually prominent and as easy to click as "Accept all"
- Default state: all non-essential OFF (must be opt-IN, not opt-OUT)
- Block GA4 and ad pixels until consent is recorded
- Persist consent in `localStorage` as `kychee_consent` with shape `{essential, analytics, marketing, ts, region}`
- "Cookie settings" link in the footer to re-open the panel
- Re-prompt only when the consent is older than 12 months OR the cookie/policy categories change

**Implementation:** This is a **shared module** built once and reused across all Kychee product sites. It lives in `kychee/site-modules/consent-banner/` (TBD) and is symlinked or imported into each product site. Per-product customization is limited to brand colors and the link to the product's specific Cookie Notice page.

**Why geo-aware:** The default approach of "always show the banner" creates friction for the ~70% of kysigned visitors who arrive from the United States — and US users find consent banners annoying and unnecessary. Geo-targeting cuts banner exposure to the ~25% who actually need it (EU/UK/BR/CA), without sacrificing GDPR compliance for those users.

**Privacy by design:** The geo detection itself does NOT use third-party tracking cookies. It uses CDN-provided IP-derived headers, which are processed server-side and never leave our infrastructure.

### F20. Monitoring & Alerting Standard

Every Kychee SaaS product uses a shared monitoring and alerting standard. The implementation lives in `run402/packages/shared/monitoring/` and is consumed by all saas-factory products.

**Three severity levels, three channels:**

| Severity | Description | Channels |
|---|---|---|
| **INFO** | Notable but normal events. Not actionable. Daily summaries, signups, key milestones. | Telegram (per-product channel) |
| **WARN** | Anomalies, recoverable failures, degradation. Actionable but not urgent. | Telegram + Bugsnag |
| **CRITICAL** | Service-down, data loss risk, security incident, suspected breach. Urgent. | Telegram + Bugsnag + email to barry@kychee.com and tal@kychee.com |

**Standard signals every product MUST monitor:**
1. **Error rate** — unhandled exceptions captured by Bugsnag (existing)
2. **Authentication anomalies** — failed login spikes, magic link abuse, token reuse → WARN
3. **Authorization failures** — repeated 403s from same identity → WARN
4. **Database health** — connection failures, slow queries (>1s), pool exhaustion → CRITICAL
5. **External service failures** — Stripe, SES, blockchain RPC, OpenRouter — single failures → WARN, sustained failures (>5 in 5 min) → CRITICAL
6. **Storage anomalies** — unusual S3 access patterns, large bulk reads → WARN; very large or unexpected-region downloads → CRITICAL
7. **Rate limit hits** — when an identity hits per-sender quotas → INFO (operational signal)
8. **Daily summary** — every morning, post a summary to Telegram with: events created, errors, top issues → INFO

**Shared module API (`run402/packages/shared/monitoring/`):**
```ts
notifyInfo(event: string, details?: object)
notifyWarn(event: string, details?: object, error?: Error)
notifyCritical(event: string, details?: object, error?: Error)
```

Each function:
- Always logs to console with severity prefix
- WARN and CRITICAL also send to Bugsnag
- All severities send to the configured Telegram channel
- CRITICAL also sends an email to barry@kychee.com and tal@kychee.com via SES

**Per-product configuration (AWS Secrets Manager):**
- `<product>/telegram-bot-token` (or shared `kychee/monitoring-telegram-token`)
- `<product>/telegram-chat-id` — distinct per product so kysigned alerts go to the kysigned channel, not run402's
- `<product>/bugsnag-api-key`

**Hard-coded recipients for CRITICAL:**
- barry@kychee.com
- tal@kychee.com

These addresses are NOT configurable per product. CRITICAL alerts always reach the founders.

**Telegram channel structure:**
- One channel per product (e.g., `kysigned-alerts`, `run402-alerts`, `bld402-alerts`)
- Devs are members of the channels for products they own
- CRITICAL messages tag `@barry` and `@tal` in the message body

**Incident response runbook (per product):**
A standard `docs/incident-response.md` template ships with every saas-factory product. Includes:
- Severity definitions (matching above)
- On-call rotation (or "Barry + Tal for now")
- First-response checklist: acknowledge → assess scope → contain → communicate
- Communication templates for customer notice and internal post-mortem
- Reference to the product's DPA breach notification timeline (typically 72 hours from confirmation)

**Why this standard exists:**
- **GDPR Article 33 alignment** — products that process personal data have a 72-hour breach notification obligation. The monitoring standard plus the runbook provide a defensible "reasonable diligence" story: alerts are captured with timestamps (Bugsnag), triaged in chat (Telegram audit trail), and escalated to humans (founder email) before the GDPR clock ends.
- **Operational consistency** — every Kychee product behaves the same way during incidents. Engineers can switch between products without re-learning the monitoring system.
- **Cost efficiency** — one shared module, one set of channels, one runbook template. Adding a new product means adding a Telegram chat and a Bugsnag project, not building a monitoring stack.

### F21. Shipping Surfaces & Smoke Verification

Every Kychee SaaS product must declare its **shipping surfaces** in the spec and verify them via the `Ship & Verify` plan phase. This is the contract that "code merged to main" became "user can use it" — and that contract is enforced by the spec → plan → implement skill chain.

**Why this matters:** A common failure mode is shipping a `package.json` change without actually publishing to npm, or merging a backend change without redeploying the service. The user experience is "the bug is still there" even though `git log` shows it was "fixed." Shipping Surfaces makes this gap impossible to ignore — every user-reachable artifact must have a smoke check that proves the latest version is reachable from outside the repo.

**Spec requirement:** Every product spec MUST include a `## Shipping Surfaces` section listing every user-reachable artifact (per the `/spec` skill format):

| Field | Description |
|---|---|
| **Name** | Short label (e.g., "MCP CLI", "API", "Marketing site", "Smart contract") |
| **Type** | One of: `npm`, `url`, `app-store`, `binary`, `library`, `service`, `other` |
| **Reach** | One-line action a fresh user takes (e.g., `npm install -g foo`, `https://kysigned.com`) |
| **Smoke check** | Single shell command that, run from a clean environment, proves the latest version is reachable. Exit code 0 = pass. Must NOT be version-pinned. |

If a product has no external surface (internal tooling, library not yet published, etc.), it MUST state explicitly: **"internal only — no external surface"** with a one-line rationale. No spec is `/plan`-ready without this section.

**Plan requirement:** Every plan MUST end with a `Ship & Verify` phase containing one `[ship]` task per shipping surface declared in the spec. The `/implement` skill executes these via the `[ship]` task type:
1. Publish/deploy via the project's `/publish` (or `/deploy`) skill, or per the procedure documented in `CLAUDE.md` / `AGENTS.md`
2. Run the spec's smoke check from a clean working directory (NOT the repo or worktree)
3. Confirm exit code 0 AND the output reflects the just-shipped change (new version string, new endpoint response, etc.)
4. Record evidence in the plan's Implementation Log

If the spec is "internal only", the plan omits the `Ship & Verify` phase and adds a Design Decision (DD-N) explaining why no shipping verification is required.

**Iron Law:** Code merged ≠ shipped. A `[ship]` task is done when the spec's smoke check passes against the published artifact, from outside the repo. No exceptions, including for patch releases.

**Common Kychee SaaS surface examples:**
- **Marketing/product website** — type: `url`, reach: `https://<product>.com`, smoke: `curl -fsSL https://<product>.com/health` or `curl -fsSL https://<product>.com/llms.txt`
- **REST API** — type: `service`, reach: `https://api.<product>.com`, smoke: `curl -fsSL https://api.<product>.com/health`
- **MCP server (npm)** — type: `npm`, reach: `npx -y <product>-mcp`, smoke: `npx -y <product>-mcp --version`
- **Public repo (open source release)** — type: `url`, reach: `https://github.com/kychee-com/<product>`, smoke: `curl -fsSL https://api.github.com/repos/kychee-com/<product> | grep -q '"private":false'`
- **Smart contract on Base mainnet** — type: `other`, reach: `0x<address>`, smoke: `cast call 0x<address> '<view-function>()' --rpc-url https://mainnet.base.org` (or equivalent)
- **Mobile app (Play Store / App Store)** — type: `app-store`, reach: store URL, smoke: API call to store listing (or manual install verification)

**Shipping Surfaces apply to ALL Kychee products without exception.** Even an internal-only library still gets the section — it just contains "internal only — no external surface".

## Acceptance Criteria

### F1. Document Structure
- [ ] Factory doc is a single markdown file
- [ ] Every chapter has a brief context paragraph before its task list
- [ ] Every checkbox is tagged with exactly one of: AI, HUMAN, DECIDE
- [ ] No untagged tasks exist

### F2. Chapter Coverage
- [ ] All 11 chapters are present in the specified order
- [ ] No chapter is empty — each has at least one task
- [ ] Chapters reference the specific strategic framework (CtC or ID) where applicable

### F3. Task Ownership Taxonomy
- [ ] AI tasks are clearly scoped — an AI agent can execute without ambiguity
- [ ] HUMAN tasks identify what requires human judgment or approval
- [ ] DECIDE tasks frame the decision with relevant options or trade-offs
- [ ] Dual-ownership tasks (AI draft -> HUMAN approve) are clearly marked

### F4. FAQ Categories
- [ ] All six FAQ categories are listed with example questions
- [ ] FAQ section explicitly states it is a conversion tool, not help documentation
- [ ] Each category explains what objection it addresses

### F5. Three Content Layers
- [ ] FAQ, how-to snippets, and llms.txt are specified as separate deliverables
- [ ] Each layer names its target audience
- [ ] llms.txt references the llms.txt convention format

### F6. Hypothesis Card
- [ ] All 8 fields of the hypothesis card are defined
- [ ] The card is marked as a prerequisite to marketing spend
- [ ] Budget is specified as a floor ($500) with flex language

### F7. Shared Marketing Infrastructure
- [ ] SaaSpocalypse hub location is specified (kychee.com/saaspocalypse)
- [ ] Segment hub URL pattern is specified (kychee.com/for/{segment})
- [ ] Each product has tasks to determine which hubs it joins
- [ ] Content model is event-driven (not calendar-driven)
- [ ] Segment hub curation is manual (HUMAN task) based on strategic priority

### F8. Legal Human Gate
- [ ] All 5 service legal document types are listed (ToS, Privacy, Cookie, AUP, DPA)
- [ ] Each service legal doc is marked as AI-drafted, human-approved
- [ ] Reference to existing Kychee/Eleanor/run402 templates is included
- [ ] The doc states no product ships without legal sign-off
- [ ] Public repo LEGAL.md requirement is specified (separate from MIT LICENSE)
- [ ] LEGAL.md covers: evidentiary value disclaimers, jurisdictional limitations, permanence/irreversibility disclaimers, operator responsibility, product-specific exclusions
- [ ] LEGAL.md is marked as AI-drafted, human-approved before repo publication

### F9. Cross-Linking
- [ ] All 8 cross-link targets are listed (kychee.com, run402 mention, bld402, segment hubs, SaaSpocalypse, run402.com showcase, kychee.com/llms.txt, run402.com/llms.txt)
- [ ] Each is a checkbox task in chapter 10

### F10. Skill Chain Integration
- [ ] The skill-to-chapter mapping table is included
- [ ] Skills only reference relevant chapters, not all 11
- [ ] The doc explicitly states it is not needed after `/plan`

### F11. Lifecycle
- [ ] All 8 lifecycle steps are listed in order
- [ ] Step 1 marks the segment as IN PROCESS in the segments ranking doc with a link to the product repo
- [ ] Step 2 specifies the copy location (`docs/saas-factory.md`)
- [ ] Steps 3-5 name the factory doc as a reference input
- [ ] Steps 6-7 explicitly state the factory doc is not consumed
- [ ] Template versioning rule is stated: product copy is a snapshot (printed page), changes go to master only, future products get the improved master

### F12. Dual Delivery
- [ ] Two-repo structure is specified: public MIT repo (`{product}`) and private service repo (`{product}-service`)
- [ ] Public repo contents are defined (product code, schema, seeds, deploy script, customization guide, demos)
- [ ] Private repo contents are defined (marketing site, hosted backend, premium services, billing, admin)
- [ ] Public repo contains no marketing site, brand assets, or proprietary service code
- [ ] Agent-deployable (public) and agent-provisionable (private) are explicit requirements
- [ ] Monetization model and subdomain strategy are marked as DECIDE items
- [ ] Private service repo runs on run402 infrastructure
- [ ] Build order specified: public repo built first as core, service repo built on top
- [ ] No-duplication rule stated: service repo imports/depends on public repo, never re-implements core code
- [ ] Bug fixes flow into public repo (core) and propagate to service automatically
- [ ] Dependency model specified: three stages (local `file:` path → git dependency → npm package)
- [ ] Both repos cloned under same workspace during development
- [ ] Public repo stays private on GitHub until launch-ready
- [ ] Workspace layout specified: product code in product repos, docs in run402, platform enhancements in run402 worktree
- [ ] VS Code multi-root workspace setup specified with STOP point before implementation continues

### F13. Three Audiences
- [ ] Builders, end users, and AI agents are named in the dual delivery section
- [ ] The website decision helper addresses all three audiences
- [ ] llms.txt specifically targets the AI agent audience

### F14. Strategic Frameworks
- [ ] Both Crossing the Chasm and Innovator's Dilemma are named
- [ ] Each framework is applied to specific decisions (not just referenced generically)
- [ ] Product Strategy chapter includes tasks for both beachhead (CtC) and low-end disruption (ID)

### F15. Branding Rules
- [ ] Own domain per product is stated
- [ ] kychee.com for hubs is stated
- [ ] "run402 as infrastructure, not brand" rule is stated
- [ ] Kychee as legal entity for all products is stated

### F16. Agent-Ready: Product CLI/MCP
- [ ] Factory doc includes a task for CLI/MCP creation when applicable to the product's domain
- [ ] CLI/MCP enables provisioning, configuring, and interacting with the product's core features programmatically
- [ ] CLI/MCP is listed as a first-class deliverable alongside llms.txt

### F17. Central Agent Discovery
- [ ] kychee.com/llms.txt specified as a central directory of all Kychee SaaS products
- [ ] run402.com/llms.txt specified as a central directory of all run402-hosted products
- [ ] Each entry links to the individual product's llms.txt
- [ ] Update is a cross-linking task in chapter 10

### F18. T1/T2 Billing Model
- [ ] Product spec explicitly identifies T1 infrastructure dependencies (compute, db, email, wallet, KMS, etc.)
- [ ] Product spec explicitly identifies T2 mechanism(s): wallet-native (x402/MPP), app-owned Stripe, or "no T2" (internal use)
- [ ] If app-owned Stripe is used, it lives in the private `[service]` repo, NOT the public MIT repo
- [ ] Public repo that supports only wallet-native T2 includes an access control primitive (e.g., `allowed_senders` table) to prevent open-relay abuse by self-hosted forkers
- [ ] Migration path to future run402 platform T2 is documented as an open question
- [ ] Spec never conflates T1 and T2 — every payment flow is explicitly labeled with its tier

### F19. Geo-Aware Cookie Consent
- [ ] Banner is shown ONLY when the user is in EU, UK, Brazil, Canada, Switzerland, or California (or when location is unknown)
- [ ] Banner is NOT shown for US (non-CA) and other permissive jurisdictions
- [ ] Detection uses CDN headers (Cloudflare or CloudFront), never third-party tracking cookies
- [ ] Failure to detect = show the banner (fail-safe to compliant)
- [ ] When shown, banner has three independent toggles (Essential / Analytics / Marketing) with default-OFF for non-essential
- [ ] "Reject all" button is as prominent and easy to click as "Accept all"
- [ ] GA4 and ad pixels are NOT loaded until consent is recorded (in jurisdictions that require it)
- [ ] Consent state persists in `localStorage` as `kychee_consent` with all required fields
- [ ] "Cookie settings" link in footer re-opens the consent panel
- [ ] Re-prompts user when consent is older than 12 months OR cookie categories change
- [ ] Implementation is shared across all Kychee product sites (single module, per-product brand customization only)

### F20. Monitoring & Alerting Standard
- [ ] Shared monitoring module exists in `run402/packages/shared/monitoring/`
- [ ] Module exposes `notifyInfo`, `notifyWarn`, `notifyCritical` with consistent API
- [ ] WARN and CRITICAL events go to Bugsnag
- [ ] All severities post to a per-product Telegram channel
- [ ] CRITICAL events additionally email barry@kychee.com and tal@kychee.com via SES
- [ ] Per-product Telegram chat ID configurable via AWS Secrets Manager
- [ ] CRITICAL recipient emails (barry+tal kychee.com) are NOT configurable per product
- [ ] Standard signals (auth anomalies, DB health, external service failures, storage anomalies) are wired in by default
- [ ] Each product ships with `docs/incident-response.md` runbook based on the standard template
- [ ] Daily summary post to Telegram (env created, error count, top issues)
- [ ] Bugsnag captures every alert with timestamp for "reasonable diligence" GDPR audit trail

### F21. Shipping Surfaces & Smoke Verification
- [ ] Every product spec has a `## Shipping Surfaces` section listing all user-reachable artifacts (or "internal only — no external surface")
- [ ] Each shipping surface row has Name, Type, Reach, and Smoke check fields
- [ ] Smoke checks are not version-pinned (they test "latest reachable" not a specific version)
- [ ] Every plan ends with a `Ship & Verify` phase containing one `[ship]` task per shipping surface
- [ ] Each `[ship]` task references the spec's smoke check and is verified via the `/implement` skill `[ship]` methodology
- [ ] Internal-only specs omit the `Ship & Verify` phase and document the rationale in a Design Decision
- [ ] No task is marked done if it produces output that must reach users via a shipping surface and no `[ship]` task exists
- [ ] Smoke checks are run from a clean working directory (not the repo or worktree) for verification

## Constraints & Dependencies

- **Existing skill chain:** The factory doc must be consumable by `/brainstorm`, `/spec`, and `/plan` as-is — passed as a file reference argument. No skill code changes required for initial version.
- **Existing legal templates:** Factory doc references ToS, Privacy Policy, and related templates from kychee.com, ai4eleanor.com, and run402.com as drafting sources.
- **GA4 infrastructure:** All product analytics run under the Kychee GA4 account (account ID 361235691). New properties created per product.
- **run402 platform:** Products are built on run402 infrastructure. Infrastructure gaps are addressed as tasks, not gates.
- **Kychee as legal entity:** All products are owned by Kychee. Legal docs, advertising accounts, and domain registrations are under Kychee.

## Open Questions

None — all resolved.
