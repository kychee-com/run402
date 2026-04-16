---
product: saas-factory
version: 1.20.0
status: Draft
type: product
interfaces: [document]
created: 2026-04-04
updated: 2026-04-16
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
2. **Dual Delivery Model** — two repos per product: a public MIT-licensed repo (the forkable template — product code, schema, seeds, deploy script, customization guide) and a private repo (marketing site, hosted SaaS backend, proprietary services, billing, admin tools). The public repo is agent-deployable with a builder-targeted README. The private repo runs on run402 infrastructure and contains the monetization layer, subdomain strategy, and any paid premium services. Explicitly names three audiences: builders, end users, AI agents
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

Chapter 8 (Marketing Strategy) mandates a hypothesis card that must be completed before any marketing spend.

**Format:** All hypothesis cards for a product are delivered as a **single `.xlsx` file** with one tab per segment plus a Summary tab that shows all segments side-by-side. The operator reviews in Excel/Numbers/Sheets without needing to read markdown source, and compares segments at a glance on the Summary tab before drilling into any single one. The file lives at `<product-private-repo>/marketing/hypothesis-cards/hypothesis-cards.xlsx` and is regenerated by `<product-private-repo>/marketing/hypothesis-cards/generate.py` (openpyxl).

**Why xlsx and not markdown:** the operator (Barry) reviews these in Excel, edits cells inline, comments cells, and may share them with potential channel partners. Markdown forces a re-read every time. xlsx is review-optimized.

**Workbook structure:**

| Tab | Contents |
|---|---|
| `Summary` | One column per segment, with the at-a-glance fields as rows (TAM, Virality score, Primary channel, Pilot budget, Timeframe, Pilot revenue target, Success threshold, Next-period revenue target, Kill criteria, Status). Frozen header + first column. |
| `<Segment>` (one tab per segment) | Two-column card layout: field name in column A, value in column B. Full 19-field card (see below). A Notes block with assumptions / open questions / risks sits below the card on the same tab. |

**Required fields (in order, on the per-segment tab):**

1. Product
2. Segment name
3. **TAM (annual, bottom-up)** — dollar figure computed as `(addressable population in this segment) × (average envelopes/month) × 12 × (our price per envelope)`. **MUST use our pricing, not the competitor's.** Show the math inline so the assumptions are reviewable. One-line upside note if there's a plausible larger adjacent category.
4. Beachhead description — specific, findable, reachable group (1-3 sentences)
5. Why this segment first — the strategic reason this is segment #1, not segment #5
6. **Virality score (1-5)** — honest self-assessment of how much this segment spreads its own tools. 1 = they treat tools as competitive edge (no spread), 3 = some word-of-mouth, 5 = builds a K-factor ≥ 0.5 on its own (rare).
7. **Virality measurement plan** — if the score is ≥ 4 (HIGH), describe the concrete measurement stack: which signal, which tool, which threshold, and **when** (which week of the pilot) the signal should first appear. If score is < 4, this field can say "skip active measurement" with a one-line reason.
8. Primary channel — single channel for the pilot (default; multi-channel allowed if justified)
9. Pilot budget — `$500` reference floor, flexes up per product
10. Timeframe — 2-4 weeks typical
11. Signal metrics — product-specific (signups, stars, conversion rate, CAC, etc.) — comma-separated list
12. Success threshold — concrete, quantified target
13. **Pilot revenue target ($)** — honest dollar figure the pilot is expected to earn in the window, with inline math. Pilots are usually LEARNING spends, not revenue spends — the number is meant to be accurate, not impressive. Revenue = our price × expected envelope volume (not competitor price).
14. Kill criteria — what tells you to stop (concrete, quantified)
15. Next step if SUCCESS — budget increase, channel expansion, target KPIs
16. **Next-period revenue target ($)** — dollar figure the follow-up period is expected to earn if period 1 succeeds. Same math discipline: inline breakdown, our pricing, show the envelope-volume assumption. This is the field that tells the reviewer whether the segment is economically serious.
17. Next step if KILL — pivot, retire, retry with different segment
18. Status — one of `Draft`, `Approved`, `Running`, `Won`, `Killed`
19. Last updated — ISO date

**Revenue-targeting discipline:** all dollar figures in fields 3, 13, and 16 MUST use the product's OWN pricing, not a competitor's. The goal is to forecast the product's income, not the savings the customer realizes. Show the math inline so assumptions can be challenged in the review.

**Workflow:**

1. AI generates the single `hypothesis-cards.xlsx` file (Summary tab + one tab per segment) via the per-product generator script
2. Human reviews each in Excel/Numbers/Sheets, edits cells, may comment
3. Human flips `Status` to `Approved` on at least one card
4. Human picks ONE approved card to execute first
5. The selected card's `Status` flips to `Running` and the marketing pilot kicks off
6. At the end of the timeframe the operator flips `Status` to `Won` or `Killed` based on the metrics
7. The xlsx file remains in the repo as the historical record; new cards iterate via new files

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
3. Create GitHub repos (`kychee-com/<product>` public, `kychee-com/<product>-private` private) using the registered name
4. Copy `saas-factory.md` into the new product's repo at `docs/saas-factory.md`
5. Run `/brainstorm` with factory doc as reference — explores strategy, fills DECIDE items
6. Run `/spec` with factory doc as reference — specifies all deliverables
7. Run `/plan` with factory doc + spec as reference — decomposes all remaining tasks
8. **Bootstrap the product on run402** — provision the run402 project (ops EOA wallet → Secrets Manager → faucet → tier subscription → SIWX project create → placeholder deploy → claim `<product>.run402.com` subdomain → register `<product>.com` as a custom sender domain). See **F22. run402 Project Bootstrap** for the canonical pattern.
9. Run `/implement` — executes the plan (factory doc no longer needed)
10. Run `/validate` — tests against spec
11. Human final review — legal sign-off, collateral approval, launch go/no-go

**Template versioning:** The product copy is a snapshot — like a printed page. Teams mark checkboxes and fill DECIDE items on their copy, but never edit the template content itself. If lessons learned require changing the template, updates go to the master copy in the run402 repo only. Future products get the improved master. In-progress products are not retroactively updated — if a critical improvement is needed, the product re-copies from master and re-fills.

### F12. Dual Delivery for Every Product

Every SaaS-killer product launches simultaneously as two delivery modes, backed by **two separate repos**:

**A. Public Repo** (`kychee-com/{product}`) — MIT-licensed, forkable template
- Contains: product code (frontend, functions, schema, seeds, deploy script, customization guide, demo variants)
- Agent-deployable (an AI agent can clone and deploy on run402 with minimal prompts)
- README targets developers/builders
- Human-reviewed structure
- Clean fork experience — no marketing site, no proprietary operator code, no Kychee-specific infrastructure

**B. Private Repo** (`kychee-com/{product}-private`) — proprietary
- Contains: marketing/product website ({product-domain}.com), hosted SaaS backend, premium services (AI agents, concierge, pro tiers), billing/customer DB, admin tools
- Runs on run402 infrastructure (eat our own dog food)
- Agent-provisionable (an AI agent can provision via API or MCP)
- Product-specific monetization model (freemium, usage-based, flat fee — decided per product)
- Optional user subdomains (e.g., joe.productname.com — decided per product)

**Why two repos:** The MIT license on the public repo must cover only the forkable template. Marketing copy, brand assets, proprietary operator logic, and paid features must not be MIT-licensed. The marketing site sells the hosted service and evolves with pricing/premium features, not with the template's feature set. Forkers get a pristine repo with exactly what they need.

**Build order and no-duplication rule:** The public repo is always built first as the core product. The private repo imports/depends on the public repo and adds the operator layer on top (billing, branded website, premium features, legal docs, analytics). No code duplication — the private repo never re-implements what the public repo provides. This means:
- The public repo is the library/engine; the private repo is the application built on it
- Building the private repo inherently exercises and tests the public repo extensively
- Bug fixes and improvements go into the public repo (core) and flow to the private repo automatically
- The plan builds the public repo first, then the private repo on top of it

**Dependency model between repos:** The private repo depends on the public repo as a package dependency. Both repos are cloned under the same workspace. The dependency evolves through three stages:

1. **Active development:** `"file:../{product}"` — local path reference. Changes to the public repo are instantly available in the private repo (npm/node creates a symlink). Two real repos from day one, clean boundary enforced, no commit-push-install cycle during iteration.
2. **Stable but pre-public:** `"github:kychee-com/{product}#v1.0.0"` — git dependency pinned to a tag. Used when the public repo is stable but not yet published to npm.
3. **Public and mature:** `"{product}"` — npm package, versioned. Used when the public repo is published on npm.

Each transition is a single-line change in the private repo's `package.json`. The public repo stays private on GitHub until launch-ready, then is flipped to public. **Before going public, squash all development history into a single "v1.0.0" commit** (orphan branch, force-push as main). The public sees a clean, audited first release with no draft iterations, license edits, or intermediate states. The MIT license applies from this first public commit forward.

**Workspace layout and where work happens:**
- **Product code** → product repos (`kychee-com/{product}` and `kychee-com/{product}-private`), cloned side by side under the workspace
- **Docs (plan, spec, brainstorm)** → run402 repo (`docs/products/{product}/`, `docs/plans/`)
- **run402 platform enhancements** triggered by a product's needs → run402 worktree on a feature branch. Product plans often surface missing platform capabilities (e.g., new payment models, auth methods). These are implemented in run402 via worktree, not in the product repos.

**VS Code multi-root workspace setup:** After creating and cloning the repos, create a `{product}.code-workspace` file in the parent workspace directory with all three repos as folders:
```json
{
  "folders": [
    { "path": "{product}", "name": "{product} (public)" },
    { "path": "{product}-private", "name": "{product}-private (private)" },
    { "path": "run402", "name": "run402 (docs + platform)" }
  ]
}
```
Open this workspace file in VS Code before continuing implementation. This gives visibility into all three repos, independent git context per repo, cross-repo search, and working `file:` dependency resolution. **This is a STOP point in the plan** — switch to the new workspace view before proceeding with implementation.

Both options presented on the product website (in the private repo) with a decision helper for choosing between them.

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

**F15.1. Domain & naming**

- Each product gets its own domain (only products get domains)
- Marketing hubs and segment pages live under kychee.com
- run402 is mentioned as infrastructure, never as the product brand
- Kychee is the legal entity, owner, and advertiser for all products
- SaaSpocalypse is a movement brand under Kychee (kychee.com/saaspocalypse), not a separate domain

**F15.2. Public vs private brand assets — strict separation**

Every SaaS-factory product has two repos (see F13: public forkable OSS repo + private repo). Brand assets MUST be split across them along the same line:

- **Private repo** (`<product>-private/`) holds the **operator marketing identity**: the final chosen product logo, favicons derived from that logo, marketing-site imagery, ad creatives, social cards, and any asset tied to the hosted commercial offering (e.g., kysigned.com's pen+">" logo). These are proprietary — they identify *the hosted service*, not the software.
- **Public forkable repo** (`<product>/`) holds a **neutral base look-and-feel** for forkers: a generic-but-branded placeholder favicon, a neutral color palette, and a simple template logo. These assets say "this is a kysigned-family product" without saying "this is the kysigned.com hosted service." A forker running the template for their own law firm must not end up shipping the operator's marketing identity.
- The public repo MUST NOT copy run402's (or any other product's) brand assets as a placeholder. Each public repo gets its own base look-and-feel, generated alongside the operator identity during chapter 3 (Domain and Branding).

**F15.3. Asset generation rule — chapter 3 produces two sets**

When chapter 3 (Domain and Branding) runs for a new product, it MUST produce **two** distinct asset bundles:

1. **Operator bundle** → destined for the private repo. Final logo(s), favicons, marketing imagery, ad creatives. This is the "chosen" identity.
2. **Template bundle** → destined for the public forkable repo. A neutral base look-and-feel: template favicon (distinct from the operator logo — e.g., one of the rejected logo-concept alternatives, or a purpose-generated neutral variant), minimal color tokens, and any default styles a forker would expect as a starting point.

Both bundles are generated in the same session so they share a common visual language (same font, same palette family, same rounded-square motif per Kychee house style) without the template bundle leaking the operator's specific marketing identity. The `/brainstorm` and `/spec` skills MUST surface this split explicitly; skipping the template bundle is a spec defect.

**F15.4. Enforcement**

- Before any commit to a public forkable repo, brand assets in that repo MUST be verified as belonging to the template bundle, not the operator bundle.
- Operator-bundle assets accidentally committed to a public repo MUST be removed and relocated to the private repo (precedent: kysigned's 2026-04-09 favicon cleanup).
- A public repo that references another product's brand assets (e.g., kysigned pointing to run402's favicon.svg) is a spec violation and MUST be fixed by generating the missing template bundle for that product.

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
- The app owner (Kychee for hosted services, or a forker for self-hosted) pays run402 for infrastructure: compute, database, email, KMS contract wallets ($0.04/day rental + $0.000005/sign — non-custodial KMS-backed signing, not fund custody), and custom domains.
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
- If using app-owned Stripe, keep it in the private repo (`<product>-private`), NOT the public MIT repo, to avoid forcing forkers into PCI/merchant-of-record obligations
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

**Implementation:** This is a **shared module** built once and reused across saas-factory product sites (kysigned, run402, bld402, etc.). The canonical TypeScript source lives in `run402/packages/shared/src/consent-banner/` and is exported as `consentBanner` from `@run402/shared`. Per-product customization is limited to brand colors, the cookie notice URL, and the GA4 / ad pixel wiring inside the host site's `onConsentChange` callback. Static HTML sites without a TS build pipeline ship a parallel single-file vanilla bundle (e.g. `kysigned-private/site/consent-banner.mjs`) that mirrors the shared logic — when the site grows a build step, replace the bundle with the compiled output. Use across non-saas-factory Kychee surfaces is a separate decision.

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

### F22. run402 Project Bootstrap

Every saas-factory product is **deployed on run402** (eat-our-own-dogfood). Each product needs the same set of run402 resources before any service code can run, and the provisioning of those resources is **a discrete, idempotent, scriptable step** that should be automated per product.

**Why this is its own section:** the bootstrap mixes AWS Secrets Manager writes, x402 payments, SIWX-signed API calls, and DNS-adjacent registrations. Doing it ad-hoc by hand for every product is error-prone and produces drift. A script captures the right sequence, the idempotency invariants, and the gotchas (SIWX nonce format, faucet rate limit, sender-domain wallet scoping) so the second/third/Nth product takes 60 seconds instead of 60 minutes.

**Required steps (in order, idempotent):**

1. **Generate or load the ops EOA wallet** — fresh `viem` private key, written ONLY to AWS Secrets Manager as `<product>/ops-wallet-key`. Address stored separately as `<product>/ops-wallet-address` so lookups don't require pulling the private key. Private key never on disk, never printed, never logged.
2. **Check tier status** via SIWX (free) **before** funding/subscribing. If a tier is already active, skip steps 3 and 4 — this is what makes the script safe to re-run against the run402 faucet's 1-per-IP-per-24h rate limit.
3. **Fund via the run402 testnet faucet** — `POST /faucet/v1` for 0.25 Base Sepolia USDC. Wait for the on-chain receipt before proceeding (RPC propagation can lag — block on the receipt, not on a balance read).
4. **Subscribe to prototype tier** via x402 — `POST /tiers/v1/prototype` with the `@x402/fetch` payment client (free, 7-day testnet lease).
5. **Create the run402 project** via SIWX — `POST /projects/v1` with `{ "name": "<product>" }`. Persist the returned `project_id`, `anon_key`, and `service_key` as `<product>/run402-project-id`, `<product>/run402-anon-key`, `<product>/run402-service-key` in Secrets Manager. **SIWX nonce must be alphanumeric and length > 8** — `crypto.randomUUID()` is REJECTED by the SIWE spec because of hyphens; use `crypto.randomBytes(16).toString('hex')`.
6. **Deploy a placeholder site** — `POST /deployments/v1` with one HTML file (`index.html` containing a "coming soon" page). Subdomain claim requires a `deployment_id`, so this happens before step 7.
7. **Claim the `<product>` subdomain** — `POST /subdomains/v1` with `{ "name": "<product>", "deployment_id": "<from step 6>" }`. Idempotent — auto-reassigns to future deployments. The product is now reachable at `https://<product>.run402.com`.
8. **Register `<product>.com` as a custom sender domain** — `POST /email/v1/domains`. Handle the **409 "Domain is registered by another wallet"** case explicitly: it usually means a prior dev/QA test left a stale row. The fix is to query `internal.email_domains` via the admin SQL endpoint (`POST /projects/v1/admin/<own-project>/sql` runs against the gateway pool, which owns the table), find the orphan row, and `DELETE FROM internal.email_domains WHERE domain = '<product>.com' AND project_id = '<orphan>'`. The new wallet can then re-register cleanly. **Bonus:** if the orphan registration was already verified, the existing DKIM CNAMEs in the product's Route 53 zone are still valid — SES's `CreateEmailIdentity` is idempotent and returns the same DKIM tokens, so the new registration should auto-verify on the first GET poll with **zero DNS changes**.
9. **STOP and report** the DNS records (DKIM CNAMEs + SPF + DMARC) the script returned. Do NOT auto-write to Route 53 — DNS changes on the production apex are a separate human-approved step.

**Idempotency invariants every bootstrap script MUST satisfy:**
- Re-running the script with all secrets present should make zero state-changing API calls
- The wallet generation step is gated on the absence of `<product>/ops-wallet-key`
- The faucet/subscribe steps are gated on tier-status check
- The project creation step is gated on the absence of all three project secrets
- The sender-domain step uses 409→GET fallback to surface current state without creating duplicates

**Reference implementation:** [`kysigned-private/scripts/bootstrap-run402.ts`](https://github.com/kychee-com/kysigned-private/blob/main/scripts/bootstrap-run402.ts) is the canonical example. Future products copy + adapt: change the `<product>` and `<product>.com` constants, the secret namespace, the placeholder HTML branding, and the project name. Everything else is portable. (When the third product needs the same script, that's the trigger to extract a generic `saas-factory-bootstrap` package — until then, copy + adapt is faster than premature abstraction.)

**Outcome of a successful bootstrap:**
- Live placeholder site at `https://<product>.run402.com`
- `<product>.com` registered + verified as a custom sender domain on the project
- All credentials in `<product>/*` namespace in AWS Secrets Manager (none on disk)
- Project ready for `/contracts/v1/wallets` (KMS contract wallet provisioning, when needed for production signing — see F18 / DD-3 / kysigned Phase 13)
- Project ready for `POST /mailboxes/v1` to start sending email from `<slug>@<product>.com`
- Project ready for the actual product deployment via `POST /deployments/v1` (the placeholder gets replaced)

### F23. Public Repo as run402 Trojan Horse

Every saas-factory product ships as **two repos**: the public MIT-licensed repo (`kychee-com/<product>`) and the private hosted-deployment repo (`kychee-com/<product>-private`). The default architectural framing (which a careful reader might assume from the dual-repo split) is that the public repo is "standalone" and the private repo is a "thin run402 adapter" — the public repo would compile and run with no run402 dependency at all, and the private repo would inject run402-specific clients via a pluggable-provider pattern.

**That framing is wrong for saas-factory products.** The public repo is **architecturally and intentionally coupled** to run402 services. The dependency is the marketing strategy: a forker who clones the public repo gets a working product that uses run402 for payment validation, auth, mailbox sending, contract wallet operations, etc. Replacing run402 is possible but is real work. The forker becomes a run402 user. That is the funnel.

**The rule:**

A saas-factory public repo MAY (and typically SHOULD) depend on run402 services, **as long as the dependency uses only run402's publicly-accessible surfaces**.

| Allowed (publicly accessible) | Forbidden (internal-only) |
|---|---|
| `https://api.run402.com/*` HTTP endpoints | `file:../run402/packages/shared` deps |
| The run402 MCP server | Internal admin SQL via `agentdb/admin-key` |
| The run402 CLI | Anything requiring being inside the run402 monorepo |
| npm-published `@x402/*` packages | Hardcoded references to non-public run402 endpoints |
| The public x402 / SIWE / EIP-712 protocols | "Will be public someday" — must be public TODAY |

**What this means in practice:**

- The public repo CAN call `fetch('https://api.run402.com/email/v1/domains', ...)` directly inside a handler. No abstraction layer required.
- The public repo CAN read `KYSIGNED_RUN402_SERVICE_KEY` from env vars in production code (not just tests). A forker creates their own run402 project and supplies their own service_key.
- The public repo CAN import `@x402/fetch` or similar npm packages and use them directly.
- The public repo CANNOT import from `@run402/shared` via a `file:..` dependency (that's a monorepo-internal coupling, not a npm-published package).
- The public repo CANNOT execute admin SQL against `internal.email_domains` or any other gateway-internal table (that requires the platform admin key, which forkers don't have).

**The pluggable-provider pattern is still used where it earns its keep** — for things where forker substitution is genuinely valuable:
- `EmailProvider` interface — a forker might want to send via Postmark / SendGrid / their own SMTP. Pluggable.
- `senderGate.hosted.getCreditBalance` callback — a forker might use their own credit ledger. Pluggable.
- `RegistryClient` for smart contract calls — a forker might use their own RPC node and their own wallet. Pluggable.
- `DbPool` — a forker might run their own Postgres outside run402. Pluggable.

**The pluggable pattern is NOT used for things where the trojan horse takes priority:**
- x402 / MPP payment validation — calls `api.run402.com` directly
- Dashboard wallet auth (SIWX/SIWE) — calls `api.run402.com/auth/v1/*` directly
- Magic-link auth flow — calls `api.run402.com/auth/v1/magic-link` directly
- Mailbox sending (when used) — calls `api.run402.com/mailboxes/v1/*` directly
- KMS contract wallet operations — calls `api.run402.com/contracts/v1/*` directly

**What the private repo (`<product>-private`) is for:**

Originally framed as "the run402 adapter layer". With F23, the private repo becomes much narrower — it's **deployment glue and private business logic only**:
- The bootstrap script (per F22)
- Stripe integration for any path that uses the operator's own Stripe account (NOT run402's billing)
- Production deployment scripts for the run402 functions/site/database
- Monitoring configuration (per F20)
- Account-deletion cron (per the product's DPA commitment)
- Any private business logic / pricing / kill-switches the operator wants to keep out of MIT

**Reference example (kysigned):** see `kysigned/docs/plans/kysigned-plan.md` DD-9 for the full rationale and the four specific public-repo tasks (Phase 2B x402 + MPP middleware, Phase 2G dashboard auth, Phase 9 MCP x402) that were originally mis-framed as private-repo work and corrected to public-repo work under DD-9.

**Acceptance:** every saas-factory product spec MUST include a Design Decision (typically `DD-N: public repo trojan horse`) explicitly stating that the public repo depends on run402 publicly-accessible surfaces and listing which run402 endpoints are used. Products that legitimately don't depend on run402 (a CLI tool, a static library, a pure smart-contract project) MUST state that explicitly with a one-line rationale.

### F24. Platform Admin Auth Service (FUTURE ENHANCEMENT — not yet specced)

> **Status: Note only — deferred.** Surfaced 2026-04-08 while planning kysigned's admin-routes auth story (see `run402/docs/plans/kysigned-plan.md` DD-15). This section is a placeholder so the problem doesn't get lost — **when prioritized, run `/brainstorm` then `/spec` to properly design it before `/plan`**.

Every saas-factory product that ships with operator-facing admin routes (allowed_senders management, feature flags, project configuration, etc.) faces the same auth problem: how does a forker's deployed instance verify "this admin request is from the authorized operator of this specific instance"? kysigned's MVP answer is a per-product env var (`KYSIGNED_ADMIN_WALLETS`) listing authorized admin wallet addresses, verified via SIWE on each request — see kysigned DD-15. This works but has known gaps that every saas-factory product will inherit identically:

- **No backend-enforced 2FA.** The only factor is "something you have" (the wallet private key). Hardware wallets add wallet-level security but cannot be required (too much friction for forkers).
- **No recovery path for forkers.** If a forker's single admin wallet is compromised or lost, they have no backstop — they don't have run402 platform AWS access (that's Kychee's account), so the env var cannot be updated without at least one surviving wallet in the admin list. The mitigation is "always configure ≥2 admin wallets", which is operator discipline, not a platform guarantee.
- **No per-admin revocation.** Removing one admin requires editing the env var and redeploying, not a dashboard click.
- **No cross-product admin identity.** A Kychee operator managing multiple saas-factory products has to maintain a separate admin wallet entry per product.
- **No audit trail beyond what each product builds individually.** No unified "who did what across the Kychee portfolio."

The platform-level solution is a **run402 admin-identity service** that saas-factory products delegate admin auth to, providing:
1. Multi-admin per project with per-user revocation via a run402 API
2. Backend-enforced second factor (TOTP / passkey / email confirmation / optional multisig)
3. Recovery flows (operator-configured 2-of-N threshold, OR a Kychee-operated "admin recovery service" forkers can opt into for a fee)
4. Unified audit trail visible in the run402 admin dashboard
5. A thin SDK for saas-factory products to delegate admin auth (`requireAdmin(request)` returns the verified admin identity or throws)

**Dependency:** this feature is likely an upstream run402 enhancement (new endpoints + new DB tables + new dashboard) that saas-factory products then consume. It is NOT a saas-factory-local capability.

**Scope when prioritized:** brainstorm session → spec (this section becomes a proper F24 with acceptance criteria) → plan → implement. Not time-boxed; picked up when a forker hits the recovery-path problem in production OR when operator 2FA becomes a customer requirement.

**Interim policy for saas-factory products shipping before this lands:** use the kysigned DD-15 pattern (per-product `<PRODUCT>_ADMIN_WALLETS` env var + SIWE verification) and document the recovery limitation in the product's operator README. Every product that adopts this interim pattern gains a migration task when the platform service lands (swap the env-var-based middleware for the SDK's `requireAdmin(request)` call).

### F25. Pre-Launch Dark-Launch with Anonymous Backend

> **Principle:** Every saas-factory product with an irreversible public launch moment SHOULD run the product in full production mode against an anonymous backend for a dark-launch phase BEFORE it becomes publicly associated with its brand. The dark-launch phase ends only when a concrete feature checklist is fully green AND a human explicitly approves. "Launch" then becomes a relabel operation — the product's configuration is flipped from anonymous backend references to production references, with no application code change — rather than a fresh deploy. This discipline decouples reputational risk (permanent public association with a branded failure) from the product's actual development, and uses the full-product exercise itself as the strongest possible pre-launch test.
>
> **Soft enforcement.** Every saas-factory product SHOULD adopt this discipline. Products that opt out MUST document the opt-out in their own spec with a one-paragraph rationale explaining why their launch has no meaningful irreversibility. There is no automatic waiver — products that legitimately don't have irreversible launch moments (e.g., a pure CLI tool with no public branding, a documentation site, an internal-only experiment) simply state the rationale and move on; everything else adopts F25.

**What counts as an "irreversible public launch moment" (triggers for F25):**

- Deploying a smart contract to a public blockchain whose address will be published in product documentation or branded artifacts
- Submitting source code to a public verification service (Basescan, Etherscan, Sourcify, etc.) under the product's identity
- Flipping a public git repository from private to public
- Claiming a distinctive public subdomain or apex domain that will be cited in marketing
- Publishing a canonical npm/PyPI/cargo package under the product's brand
- Submitting to an app store under the product's brand
- Registering in a public directory (W3C registries, EIP protocol registries, ENS, etc.) under the product's identity
- Any other "contract of record" the product is signalling to the outside world for the first time

Products may have multiple such moments in their launch; F25 applies to the moment(s) that are reputationally or technically the hardest to reverse.

**Requirements (what the discipline consists of):**

- F25.1. **Separation at the trust-root level.** Whatever backend resource embodies the irreversible moment (smart contract wallet, domain, signing key, API account) MUST exist as two separate instances during the dark-launch phase: one anonymous "canary" instance provisioned specifically for the dark-launch phase, and the eventual production instance. The two instances MUST be independently linkable to the product only via deliberate OSINT work, not via a single click of public tooling. For on-chain products, this means two separate deployer EOAs; for domain-bound products, this means a non-branded staging subdomain or IP; for package-bound products, this means an anonymously-named staging package.
- F25.2. **Functional identity between canary and production.** The code path that the canary exercises MUST be bit-for-bit identical to the code path the production instance will run, wherever the artifact has a verifiable identity (bytecode, package hash, image digest, build artifact checksum). Cosmetic differences (names, branding strings, comments) are allowed; functional differences are not. Each product's spec (or plan) specifies the exact identity check appropriate to its artifact type (e.g., for smart contracts: runtime bytecode beyond the compiler metadata suffix; for npm packages: tarball content hash excluding package name/version; for Docker images: digest excluding tag).
- F25.3. **Identity gate at the flip moment.** Before the canary → production flip, the product MUST verify that the canary artifact and the freshly-created production artifact pass the F25.2 identity check. If they do not, the flip MUST be aborted and the divergence investigated. A matching identity pair is a hard pre-flip gate — no flip without it.
- F25.4. **No public verification or branding on the canary artifact.** Whatever verification surface the production artifact will use (Basescan source verification, npm README with product name, Play Store listing, etc.) MUST NOT be populated for the canary. External observers see an opaque artifact with no public association to the product.
- F25.5. **The product runs in full production mode against canary references during the dark-launch phase.** The same deployment that will eventually serve launch traffic is configured with environment variables (or equivalent config mechanism) pointing at the canary backend(s) for the duration of the dark-launch phase. There is no separate staging environment, no mock data, no reduced feature surface. Real infrastructure, real integrations, real user flows — just against anonymous references.
- F25.6. **Internal dogfood as primary exercise.** During the dark-launch phase, the product's operators (or a small trusted internal group) use the product as real users — creating real workloads, completing real flows, verifying real outputs. The dogfooding MUST exercise every user-facing surface the product will ship with, not just a smoke subset. The product's plan (not this spec) enumerates the specific dogfood checklist.
- F25.7. **Exit criterion: checklist fully green AND explicit human go/no-go.** The dark-launch phase ends only when (a) every item on the product's dark-launch checklist (enumerated in the product's plan) is confirmed green, AND (b) a human operator explicitly approves the flip via a ceremonial go/no-go prompt that presents the checklist summary and demands an APPROVE / ABORT / KEEP TESTING decision. There is no automatic advancement. There is no time-boxing. A partial checklist does not unlock the flip, and a fully-green checklist does not itself trigger the flip — the human decision is independent and required.
- F25.8. **"Launch" is a relabel, not a deploy.** The launch moment consists of: (1) provisioning the production backend instance(s), (2) running the F25.3 identity gate, (3) flipping the product's configuration from canary references to production references, (4) redeploying the product with the new config (no application code changes bundled with the flip), (5) running one smoke check against the production backend. No application code ships on launch day — every code path has already been exercised against the canary.
- F25.9. **Canary retirement.** After a successful flip, the canary backend instance(s) MUST be retired within a short well-defined window (the specific window is set by each product's plan based on incident-response considerations — e.g., 24 hours for on-chain wallets, immediately for package registry staging, etc.). Retirement means: drain any recoverable resources back to the operator, schedule deletion of any retained credentials or keys, and remove references from active configuration. The canary artifact itself may be immutable (a deployed smart contract cannot be deleted), in which case it becomes an orphaned public artifact with no known association to the product; that is acceptable.
- F25.10. **Anti-leakage: the canary identity is the single-point-of-failure secret.** For each saas-factory product adopting F25, the canary instance's identifying values (contract address, wallet address, package name, subdomain, etc.) MUST be treated as secrets until after the canary is retired. The minimal control is a single working-tree scan of the product's public repository for each canary identifier, run immediately before any moment that would publish the repository to a wider audience (e.g., a private → public flip, a first-time npm publish, a first-time release). The scan MUST abort the publication if any canary identifier is found anywhere in the tree. Products whose public repository is private throughout the dark-launch phase and is squashed to an orphan commit at publication time (the kysigned F17 pattern) MAY rely on that single scan as the only anti-leakage control; products with different repository lifecycles MUST define an equivalent-or-stronger control in their own spec.
- F25.11. **Canary identity storage.** Canary identifiers MUST be stored exclusively in a secret-management system (AWS Secrets Manager, or equivalent). They MUST NOT be committed to any repository, public or private, and MUST be read at deploy time via environment injection. This applies to both public product repositories and private operator repositories; the discipline is "the canary identifier never touches disk in a git-tracked file, anywhere."
- F25.12. **Opt-out disclosure.** Products that choose not to adopt F25 MUST include a one-paragraph rationale in their own spec explaining why their launch has no meaningful irreversibility. The opt-out MUST be a positive statement (e.g., "This product is an internal tool with no public branding or public identity, so F25 does not apply"), not silence. Silent non-adoption is a spec defect, not an opt-out.
- F25.13. **Reference instantiation for database-driven SaaS: demo-variant canaries.** Products whose core is a database-driven site (per F26) MAY instantiate F25 as a **demo tenant**: a deployment on the same production run402 infrastructure as the branded launch, but reached via a non-branded subdomain (e.g., `silver-pines.run402.com`) and seeded with a plausible-but-identity-free dataset (e.g., `seed-silver-pines.sql`) that exercises every user-facing surface without carrying the product's marketing brand. The F25.2 identity check for this instantiation is "same build artifact, same deployment config excluding the `BRAND_*` and `DOMAIN_*` environment variables." The launch flip consists of adding the branded subdomain to the same deployment and pointing the apex DNS — no application code ships. The demo-variant subdomain and its seed-file name are canary identifiers under F25.10 and MUST be scanned for before any private → public repo flip. `kychee-com/kychon`'s `app-silver-pines.json` is the canonical worked example; multiple concurrent demo variants (silver-pines, others) are permitted and in fact desirable — each exercises the same code path against a different seed file, broadening the dogfood surface without branding exposure.

**Reference implementation: kysigned F17.** The first saas-factory product to adopt F25 is kysigned, via its `kysigned-spec.md` F17 ("Pre-Launch Dark-Launch Canary Discipline"). kysigned F17 instantiates F25 for an on-chain context: two separate KMS wallets, the F25.2 identity check is runtime bytecode comparison beyond the Solidity metadata suffix, canary exercise is Barry+Tal dogfooding the full kysigned product against an anonymous canary contract, and the anti-leakage control is a single pre-squash working-tree scan at the kysigned Phase 14 private→public flip. Any future saas-factory product with an on-chain component can use kysigned F17 as a template; products with different launch-moment shapes (domain claim, npm publish, app store submission, public registry entry, etc.) should derive their own F25 instantiation from the principles above, using kysigned F17 as a worked example.

**Relationship to other factory requirements:**

- **F22 (run402 project bootstrap)** is executed BEFORE the F25 dark-launch phase begins. The bootstrap creates the run402 project and provisions the initial (long-lived) production resources; F25 inserts a dark-launch phase between "bootstrap complete" and "publicly announced product," in which the bootstrap's production infrastructure runs against canary backend references.
- **F23 (public repo as run402 trojan horse)** and F25 are independent but complementary. F23 describes how the public repo depends on run402 publicly-accessible surfaces; F25 describes how the product transitions from dark-launch to launch. A product adopting F23 still needs F25 if its launch has irreversible moments.
- **F21 (shipping surfaces & smoke verification)** provides the smoke checks that F25 consumes — the dark-launch checklist in each product's plan is implemented on top of F21's `[ship]` task infrastructure, and the F25.8 production smoke check reuses the F21 smoke command for each surface.

### F26. Agent-Forkable Database-Driven Architecture

Every saas-factory product whose core is a database-driven user-facing site (membership portals, directories, CRMs, event registration, client portals, booking, helpdesks — roughly half of the saas-killer segments in `docs/products/saas-segments/saas-killing-segments-ranked.md`) MUST adopt an **agent-forkable architecture**: the customization surface is **data, not code**. A coding agent takes the stock product and produces a Wild-Apricot-killer for professional associations, a Dubsado-killer for wedding vendors, or a TownSq-killer for HOAs **without writing new code** — only by editing rows and translations.

**Strategic rationale — double purpose:**

1. **Product benefit.** Data-first customization collapses the cost of niche variants. The "one engine, many niches" vertical-skin strategy (referenced throughout the segments doc — CRM, scheduling, forms, etc.) is only tractable if a niche is a row in a table, not a fork of the code. F26 makes that mechanism concrete and mandatory, so future saas-factory products inherit it by default.
2. **run402 coupling (the hidden motive).** The customization surface IS the run402 Postgres database. Every agent-driven customization exercises run402's database surface (PostgREST + admin SQL) directly. run402's "simple database for agents" positioning becomes load-bearing: the database is not a backing store hidden behind an app — it IS the app's configuration, content, and localization layer. Forking, skinning, restructuring, and localizing the product all happen through run402's data plane. This deepens the F23 trojan horse: where F23 couples the product to run402 HTTP APIs for runtime paths (payment, auth, mailbox, contracts), F26 couples the product to run402's database as the **customization** surface. A forker who accepts F26 has already accepted run402 as the configuration backend.

Together, F23 and F26 form a complete coupling story: F23 for runtime, F26 for customization. Both are required for the trojan-horse dynamic to hold.

**F26.1. SQL as the primary agent API.**

The product MUST expose a single JSONB configuration table (canonical name: `site_config`) containing all runtime-tunable settings — theme tokens (colors, typography), feature flags, navigation structure, hero copy, social links, pricing config, and any product-specific toggles. The site fetches this config on every request (or caches per-deploy) and wires it into the UI via a provider component. An agent asked to rebrand the product to "ClubNexus for yacht clubs" accomplishes 80%+ of the work via `UPDATE site_config SET value = $1 WHERE key IN (...);` — no build step, no code edit, no redeploy of application code.

The JSONB schema MUST be documented in the product's `CUSTOMIZING.md`, and the product's `llms.txt` (F5) MUST list `site_config` keys with their allowed values. An agent reaching the product via `llms.txt` can customize end-to-end via run402's admin SQL endpoint with no prior product knowledge.

**F26.2. Inline editing — "the page IS the admin".**

The product MUST NOT ship a separate admin CMS for content editing. Member and admin users see the same URL; admins get edit overlays activated by `data-editable` attributes on editable elements. Three editing layers are standard:

- Simple text: native `contenteditable` (~30 lines JS, no dependency)
- Rich text: headless editor (e.g., Tiptap) lazy-loaded only for admin sessions
- Images: click-to-upload handler

Member page bundle stays small (< ~20kB JS); admin adds a lazy-loaded island (~60kB) via `client:idle` or equivalent. Every editable surface is edited **in place, under production styles, against production data** — no "WordPress admin dashboard" paradigm.

Beyond UX, the double motive is agent ergonomics: **there is no separate admin UI for an agent to learn.** The agent customizes the same DOM a user sees, and the edits land via the same data layer as F26.1. A coding agent that understands the site's JSONB config and the `data-editable` targets can drive the entire content layer through run402's database without ever rendering an admin page.

**F26.3. Schema-driven content — pages as rows, not files.**

Any content area that a human (or agent) would plausibly want to restructure MUST be stored as rows in a database table, NOT as hardcoded files. The canonical pattern is a `pages` table + a `sections` table with ordering + a section-type discriminator. The site's renderer reads these tables and composes the page at runtime.

Consequence: "reorganize the homepage for a yacht club variant" is a sequence of `INSERT INTO sections ...` and `UPDATE sections SET order = ...` statements, not a code change. Niche variants ship their own seed SQL that produces their own page structure out of the same rendering engine.

Content that is legitimately static (privacy policy, terms) MAY live as files. Any content that vertical-skin variants would plausibly want to restructure MUST be schema-driven. The product spec MUST enumerate which areas are schema-driven and which are static.

**F26.4. Seed files as the vertical-skin mechanism.**

The product MUST ship one or more `seed-<variant>.sql` files under version control, one per supported vertical. Each file contains the `site_config` rows, the `pages`/`sections` rows, default content, and any variant-specific defaults for that niche. Choosing a variant at deploy time is selecting which seed file runs, nothing more.

This is the concrete mechanism that makes the vertical-skin strategy real. The niche is not a fork of the code, not a branch of the repo, not a configuration file read at boot — it is a SQL script that populates the database once. A coding agent producing a new variant produces a new seed file; the application code is untouched. The product's `CUSTOMIZING.md` MUST document the seed-file naming convention and the expected schema so agents can produce new variants without reading source.

Seed files also feed the F25.13 demo-variant canary pattern: a "silver-pines" demo tenant is the product deployed with a non-branded name and a seed file that produces a plausible but identity-free instance.

**F26.5. i18n from day one.**

The product MUST ship with a runtime i18n layer from the first release, even if only one language is shipped at launch. The canonical pattern (the "Krello pattern"):

- Strings live in `custom/strings/<lang>.json` — one file per language, flat key space
- Keys follow a stable convention (`_one` suffix for plurals, `{placeholder}` for interpolation)
- A `t(key, vars)` function performs lookup with English fallback
- The active language is a `site_config` value; the default is `site_config.defaultLanguage`
- The set of available languages is `site_config.languages` (array)

**Why day-one and not "add later":** retrofitting i18n onto a code-first product is a large rewrite. Shipping the layer from day one makes "localize this product for German HOAs" a file-add operation, not a refactor — same agent-forkability discipline as F26.4. The Krello-pattern convention MUST be documented in `CUSTOMIZING.md` so an agent can produce `strings/pt.json` for a Portuguese variant by translating the English file.

This is also the mechanism that lets localized niche variants win SEO in non-English markets (per the segments doc, "App para barbearias" beats every English-only SaaS in Portuguese markets). The cost of a localized vertical variant is one seed file + one translations file — no engineering.

**F26.6. Reference implementation and opt-out.**

`kychee-com/kychon` is the canonical reference for F26. It instantiates all five sub-requirements (F26.1–F26.5) and ships three seed files (`seed-association.sql`, `seed-church.sql`, `seed-hoa.sql`) as a worked example of the vertical-skin mechanism. New saas-factory products with a database-driven core SHOULD study kychon's structure before specifying their own.

Products whose core is NOT a database-driven site (CLI tool, static documentation site, smart-contract-only project, webhook inspector, etc.) MUST state the F26 opt-out explicitly with a one-paragraph rationale in their own spec. Silent non-adoption is a spec defect, not an opt-out.

### F27. Live Platform-Gaps Feedback Loop

Every saas-factory product MUST maintain a `docs/run402-feedback.md` file (or equivalent, named consistently across products) in the **private repo** that enumerates, in real time, the run402 platform capabilities the product needs but doesn't yet have. Each entry is a short numbered paragraph covering:

- The gap (what capability is missing)
- The workaround the product uses today (or "blocks the product" if none exists)
- A suggested API or platform feature that would close the gap cleanly
- Priority (blocker / important / nice-to-have)

The file is kept current during the product's build — when a developer or agent discovers a platform gap while implementing a plan task, the gap is appended to `docs/run402-feedback.md` **in the same commit as the workaround**. The run402 platform team reviews these files across all saas-factory products on a recurring cadence (suggested: weekly during active build-out, monthly after launch) and prioritizes platform enhancements based on demonstrated product demand.

**Strategic rationale.** Without this loop, platform priorities drift away from product reality. With it, every saas-factory product doubles as a live backlog of platform improvements, sized by the number of products hitting the same gap. "Three products need batch PATCH" is a stronger prioritization signal than any single operator's intuition.

**Format requirement.** `docs/run402-feedback.md` uses a flat numbered list with one paragraph per gap, NOT a table. Tables discourage nuance; gaps need a sentence of workaround context to be actionable upstream. The file lives in the **private repo**, not the public repo — it is operator-internal content: incident records, admin-SQL surgery recipes, operator workarounds specific to the hosted deployment, and strategic roadmap-adjacent commentary. Forkers deploying the public template on their own run402 projects will hit different gaps than the hosted operator and should maintain their own private feedback log; listing the hosted operator's entire gap history in the MIT template both leaks strategy and gives competitors a ready-made weakness map. Public-facing platform transparency (if desired) belongs in a sanitized, generic summary on the product's marketing site — not in the raw operator feedback log.

**Closure loop.** When a platform gap is closed upstream, the corresponding entry in each product's `run402-feedback.md` is marked `✅ FIXED` with a link to the run402 PR/commit that shipped the fix, and the product's workaround code is replaced with a call to the new capability. The entry is NOT deleted — the historical record remains as evidence of the feedback loop working.

**Reference implementation.** `kychee-com/kychon-private/docs/run402-feedback.md` (15 items as of 2026-04-14, 2 FIXED) is the canonical example. It surfaced the lifecycle-hooks gap that is now shipped as run402's `on-signup` function trigger — a closed feedback loop from product demand to platform capability. It also surfaced the silent auto-archive / pin chicken-and-egg / orphaned custom-domain issues that triggered the 2026-04-14 kychon recovery (items 1-4).

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
- [ ] All 19 fields of the hypothesis card are defined
- [ ] The card is marked as a prerequisite to marketing spend
- [ ] Budget is specified as a floor ($500) with flex language
- [ ] Card delivery format is a single `.xlsx` file with Summary tab + one tab per segment, not markdown or per-segment files
- [ ] TAM field is bottom-up, uses the product's OWN pricing, and shows inline math
- [ ] Virality score (1-5) is required on every card; HIGH scores (≥ 4) require a measurement plan with a concrete signal + threshold + week-of-pilot timing
- [ ] Pilot and next-period revenue targets are both expressed in dollars earned (not profit) using the product's own pricing, with inline math
- [ ] Summary tab shows all segments side-by-side on the at-a-glance fields (TAM, Virality, channel, budget, timeframe, pilot revenue, success threshold, next-period revenue, kill criteria, status)
- [ ] Each product ships a `marketing/hypothesis-cards/generate.py` script that emits the single workbook via openpyxl
- [ ] Status field has a defined lifecycle (Draft → Approved → Running → Won/Killed) and is a dropdown on every segment tab

### F7. Shared Marketing Infrastructure
- [ ] SaaSpocalypse hub location is specified (kychee.com/saaspocalypse)
- [ ] Segment hub URL pattern is specified (kychee.com/for/{segment})
- [ ] Each product has tasks to determine which hubs it joins
- [ ] Content model is event-driven (not calendar-driven)
- [ ] Segment hub curation is manual (HUMAN task) based on strategic priority

### F8. Legal Human Gate
- [ ] All 5 operator legal document types are listed (ToS, Privacy, Cookie, AUP, DPA)
- [ ] Each operator legal doc is marked as AI-drafted, human-approved
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
- [ ] Two-repo structure is specified: public MIT repo (`{product}`) and private repo (`{product}-private`)
- [ ] Public repo contents are defined (product code, schema, seeds, deploy script, customization guide, demos)
- [ ] Private repo contents are defined (marketing site, hosted backend, premium services, billing, admin)
- [ ] Public repo contains no marketing site, brand assets, or proprietary operator code
- [ ] Agent-deployable (public) and agent-provisionable (private) are explicit requirements
- [ ] Monetization model and subdomain strategy are marked as DECIDE items
- [ ] Private repo runs on run402 infrastructure
- [ ] Build order specified: public repo built first as core, private repo built on top
- [ ] No-duplication rule stated: private repo imports/depends on public repo, never re-implements core code
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
- [ ] F15.2: public vs private brand asset split is stated; operator-marketing assets live only in the private repo
- [ ] F15.3: chapter 3 produces BOTH a operator bundle and a template bundle; the template bundle is a distinct neutral base look-and-feel (not a copy of run402's or any other product's assets)
- [ ] F15.4: public repo brand assets are verified as template-bundle only before commit; cross-product asset references (e.g., kysigned → run402 favicon) are flagged as violations

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
- [ ] If app-owned Stripe is used, it lives in the private repo (`<product>-private`), NOT the public MIT repo
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

### F23. Public Repo as run402 Trojan Horse
- [ ] Every saas-factory product spec includes a Design Decision (`DD-N: public repo trojan horse` or equivalent) stating the public repo depends on run402 publicly-accessible surfaces by design
- [ ] The Design Decision lists which run402 endpoints / packages are used
- [ ] Public repo handler code calls `https://api.run402.com` directly via `fetch` for the run402-coupled paths (payment, auth, mailbox, contract wallet) — no abstraction layer
- [ ] Public repo MAY use npm-published packages under `@x402/*`, `@run402/*` (when published), and the public x402 / SIWE protocols
- [ ] Public repo MUST NOT use `file:..` deps to internal monorepo packages, MUST NOT execute admin SQL against gateway-internal tables, MUST NOT hardcode any non-publicly-accessible run402 surface
- [ ] Pluggable-provider pattern is RESERVED for places where forker substitution adds genuine value (`EmailProvider`, `RegistryClient`, `DbPool`, `senderGate.hosted.getCreditBalance`) — NOT for run402-coupled trojan-horse surfaces
- [ ] Private repo (`<product>-private`) is narrow: bootstrap glue + private business logic + production deployment + monitoring config — does NOT contain run402 adapters

### F22. run402 Project Bootstrap
- [ ] F11 lifecycle includes a discrete "Bootstrap on run402" step
- [ ] Every product ships a `<product>-private/scripts/bootstrap-run402.ts` script (or equivalent) that performs the 9 steps idempotently
- [ ] The script writes the ops EOA private key ONLY to AWS Secrets Manager under `<product>/ops-wallet-key` (never on disk, never printed)
- [ ] The script checks tier status via SIWX BEFORE calling the faucet (avoids the 1-per-IP-per-24h rate limit on re-runs)
- [ ] The script uses `crypto.randomBytes(16).toString('hex')` for SIWX nonces, NOT `crypto.randomUUID()` (UUIDs are rejected by SIWE because of hyphens)
- [ ] The script handles the 409 "Domain registered by another wallet" case on `POST /email/v1/domains` by surfacing the gateway-pool admin SQL release pattern
- [ ] The script STOPS before writing DNS records to Route 53 — DNS changes on the production apex are a separate human-approved step
- [ ] kysigned-private/scripts/bootstrap-run402.ts is called out as the canonical reference implementation in F22

### F25. Pre-Launch Dark-Launch with Anonymous Backend
- [ ] Every product with an irreversible public launch moment has a dark-launch phase specified in its own spec (F17-style feature requirement or equivalent)
- [ ] Products that legitimately have no irreversible launch moments include a positive opt-out paragraph in their own spec explaining why (silent non-adoption is a spec defect)
- [ ] Each adopting product specifies two separate backend instances during the dark-launch phase: one anonymous canary, one eventual production
- [ ] The canary backend instance has no public branding or verification linking it to the product (no Basescan source verification, no branded npm README, no product-name-in-subdomain, etc. — whatever applies to the artifact type)
- [ ] Each adopting product specifies the exact identity check that the F25.3 pre-flip gate uses (e.g., runtime bytecode beyond metadata suffix for smart contracts; tarball content hash excluding package name/version for npm packages)
- [ ] Each adopting product runs its full production deployment against canary backend references during the dark-launch phase (no separate staging environment, no mock data, no reduced feature surface)
- [ ] Each adopting product's plan enumerates a concrete dark-launch exercise checklist covering every user-facing surface the product will ship with
- [ ] The dark-launch phase exit requires (a) full checklist green AND (b) explicit human go/no-go — the spec enforces the principle, the plan enumerates the items
- [ ] The flip from canary to production is a configuration-only operation — no application code ships on launch day
- [ ] The pre-flip identity gate (F25.3) is enforced before any flip proceeds; flip is blocked until canary and production artifacts pass the identity check
- [ ] After a successful flip, canary backend resources are retired within the window specified in the product's plan; canary credentials and keys are scheduled for deletion
- [ ] Canary identifiers (address, package name, subdomain, etc.) are stored exclusively in a secret-management system; a grep of the product's public repository tree returns zero matches for any canary identifier
- [ ] Before any moment that widens the audience for the product's public repository (private → public flip, first npm publish, first release), a working-tree scan for canary identifiers is run; the moment is aborted if any identifier is found
- [ ] The kysigned F17 implementation is cited in F25 as the reference worked example; new products with different launch-moment shapes derive their own F25 instantiation from the principles
- [ ] F25.13: products whose core is database-driven (per F26) MAY instantiate F25 via a demo-variant canary on the same production infrastructure, reached via a non-branded subdomain and seeded with a plausible-but-identity-free dataset
- [ ] F25.13: each adopting product names its demo-variant seed file (e.g., `seed-silver-pines.sql`) in its own spec and treats the demo subdomain and seed-file name as canary identifiers under F25.10

### F26. Agent-Forkable Database-Driven Architecture
- [ ] Every saas-factory product with a database-driven core adopts F26; products that legitimately don't (CLI tool, static site, smart-contract-only, etc.) include a positive one-paragraph opt-out in their own spec
- [ ] F26.1: product exposes a single JSONB configuration table (canonical name `site_config`) covering theme, feature flags, navigation, copy, pricing config, and product-specific toggles
- [ ] F26.1: `site_config` schema is documented in `CUSTOMIZING.md` and its keys + allowed values are listed in the product's `llms.txt`
- [ ] F26.1: rebrand/re-skin operations are achievable via `UPDATE site_config` alone — no code edit, no build step, no application redeploy
- [ ] F26.2: product has no separate admin CMS for content editing; admins edit inline via `data-editable` overlays on the same URLs members see
- [ ] F26.2: member page JS bundle stays small (target < ~20kB); admin editor is a lazy-loaded island (e.g., `client:idle`), not part of the member-facing bundle
- [ ] F26.3: any content area a niche variant would plausibly restructure (homepage sections, custom pages, navigation) is schema-driven via `pages` + `sections` tables (or equivalent), not hardcoded files
- [ ] F26.3: the product spec enumerates which areas are schema-driven and which remain static
- [ ] F26.4: product ships at least one `seed-<variant>.sql` file per supported vertical, under version control
- [ ] F26.4: `CUSTOMIZING.md` documents the seed-file naming convention and expected row schema so agents can produce new variants without reading source
- [ ] F26.4: choosing a vertical variant at deploy time is selecting a seed file, not editing code
- [ ] F26.5: product ships a runtime i18n layer (Krello pattern: `custom/strings/<lang>.json` + `t(key, vars)` function) from the first release, even if only one language is shipped at launch
- [ ] F26.5: active language is a `site_config` value; available languages are `site_config.languages` (array); default is `site_config.defaultLanguage`
- [ ] F26.5: adding a new language is a file-add operation (`strings/<lang>.json`), not a code change
- [ ] F26.6: `kychee-com/kychon` is cited as the reference implementation of F26

### F27. Live Platform-Gaps Feedback Loop
- [ ] Every saas-factory product ships a `docs/run402-feedback.md` (or equivalently named) file in the PRIVATE repo (operator-internal; see F27 rationale)
- [ ] Entries are flat numbered paragraphs, not a table, with four fields: gap, workaround, suggested platform feature, priority
- [ ] When a platform gap is discovered during implementation, the entry is appended in the same commit as the workaround
- [ ] When a platform gap is closed upstream, the entry is marked `✅ FIXED` with a link to the run402 PR/commit; the entry is NOT deleted (historical record preserved)
- [ ] The product's workaround code is replaced with a call to the new platform capability once an entry is marked FIXED
- [ ] kychon's `docs/run402-feedback.md` is cited as the reference implementation, with the `on-signup` lifecycle hook called out as a closed-loop example

## Constraints & Dependencies

- **Existing skill chain:** The factory doc must be consumable by `/brainstorm`, `/spec`, and `/plan` as-is — passed as a file reference argument. No skill code changes required for initial version.
- **Existing legal templates:** Factory doc references ToS, Privacy Policy, and related templates from kychee.com, ai4eleanor.com, and run402.com as drafting sources.
- **GA4 infrastructure:** All product analytics run under the Kychee GA4 account (account ID 361235691). New properties created per product.
- **run402 platform:** Products are built on run402 infrastructure. Infrastructure gaps are addressed as tasks, not gates.
- **Kychee as legal entity:** All products are owned by Kychee. Legal docs, advertising accounts, and domain registrations are under Kychee.
- **Product docs live in the product's private repo (v1.20.0 — 2026-04-16).** Every saas-factory product has (at least) a private repo for service code + internal docs. All product-level documentation — spec (`docs/product/<product>-spec.md`), plan (`docs/plans/<product>-plan.md`), consultations (`docs/consultations/`), ideas (`docs/ideas/`), research (`docs/research/`), scripts (`docs/scripts/`) — MUST live in that private repo, NOT in run402. Earlier products (pre-2026-04-16) may have docs parked in `run402/docs/products/<product>/` as a bootstrap shortcut; those should be migrated (simple copy) to their respective product repos when convenient. The `run402` repo holds ONLY run402-platform-level docs (platform spec, platform plans, platform features). **New-product bootstrap**: do NOT create `run402/docs/products/<product>/` even as a placeholder. Create the product's private repo first, then put docs there from day one.

## Open Questions

None — all resolved.
