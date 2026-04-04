---
product: saas-factory
feature: null
status: ready
created: 2026-04-04
updated: 2026-04-04
references:
  - type: doc
    path: docs/product/SAAS segments/saas-killing-segments-ranked.md
    description: Ranked list of 65 SaaS-killing segments across 4 tiers, with scoring criteria and strategic analysis
---

## Problem / Opportunity

Kychee has identified 65 SaaS segments ripe for disruption, ranked by pricing outrage, niche sharpness, and viral potential. The top 5 alone attack $120B+ in combined TAM. But launching each product requires a repeatable, high-quality process that spans product thinking, legal, marketing, collateral, and technical infrastructure — not just code.

Today, each product would be built ad-hoc, with the risk of forgetting critical steps (legal sign-off, GA4 tracking, llms.txt, cross-linking, FAQ-as-conversion-tool). The opportunity is a reference document that ensures every SaaS killer launches complete and strategically sound, while plugging seamlessly into the existing skill chain (brainstorm → spec → plan → implement → validate).

## Target Audience

The factory doc is consumed by two actors:
1. **The human operator (user)** — makes strategic decisions, approves legal/collateral/marketing, fills the hypothesis card
2. **The AI agent (Claude)** — drives execution, drafts deliverables, checks completeness against the factory doc during brainstorm/spec/plan phases

## Proposed Idea

A **SaaS Factory Reference Document** — a structured checklist and decision framework that is:
- Copied into each new product's repo under `docs/`
- Fed as context to `/brainstorm`, `/spec`, and `/plan` skills
- Not needed after `/plan` completes (all tasks are broken down by then)
- Structured so each skill can scan it and flag gaps relevant to its phase

### What the factory doc covers

The document is organized into chapters. Each chapter contains:
- Context/rationale for why this matters
- Checkboxes for tasks (marked AI or HUMAN)
- Decision points that must be resolved (marked DECIDE)
- References to frameworks (Crossing the Chasm, Innovator's Dilemma) where relevant

### Chapters

#### 1. Product Strategy
- [ ] DECIDE: Identify the kill target (which incumbent SaaS)
- [ ] DECIDE: Define the attack angle (pricing outrage, fear, legal vulnerability — per segments doc)
- [ ] DECIDE: Define the beachhead segment (Crossing the Chasm — one specific, findable, reachable group)
- [ ] DECIDE: Define the low-end disruption angle (Innovator's Dilemma — what's "good enough + free" that incumbents can't respond to)
- [ ] DECIDE: Identify the core differentiator — the one thing that makes this product different (not commodity features)
- [ ] AI: Research competitive landscape — what exists, what's open source, what's the gap
- [ ] DECIDE: Define what "good enough" means for MVP vs incumbent feature set

#### 2. Dual Delivery Model
Every product ships two ways, launched simultaneously:

**A. Open Source Repo**
- [ ] AI: Scaffold the repo (MIT license, README, agent-friendly setup)
- [ ] AI: Ensure repo is agent-deployable — an AI agent can clone and deploy on run402 with minimal prompts
- [ ] AI: Write clear README targeting developers/builders
- [ ] HUMAN: Review and approve repo structure

**B. Hosted SaaS**
- [ ] AI: Build the hosted version on run402 infrastructure
- [ ] AI: Ensure SaaS is agent-provisionable — an AI agent can sign up / provision via API or MCP
- [ ] DECIDE: Define monetization model for the hosted version (freemium, usage-based, flat fee, etc.)
- [ ] DECIDE: Define subdomain strategy (e.g., joe.productname.com)

**Three audiences to serve:**
1. Builders — want the repo, will customize
2. End users — want the hosted SaaS, just want it to work
3. AI agents — need to deploy repo OR provision SaaS programmatically

#### 3. Domain and Branding
- [ ] DECIDE: Choose product domain name (only products get domains; everything else under kychee.com)
- [ ] AI: Generate logo options → HUMAN: Approve
- [ ] AI: Generate brand assets (colors, typography, tone) → HUMAN: Approve
- [ ] AI: Check domain availability and register → HUMAN: Approve purchase

#### 4. Website
Each product domain hosts a website that serves all three audiences.

**Core pages:**
- [ ] AI: Landing page — leads with attack angle, offers both SaaS signup and repo link
- [ ] AI: "SaaS vs Repo — which is right for you?" decision helper (qualifying flow)
- [ ] AI: Pricing page (for hosted SaaS)
- [ ] AI: Documentation / getting started

**FAQ (conversion weapon — NOT boilerplate):**
FAQ is a strategic conversion tool. Every product must address these categories:
- [ ] AI: Trust/survival — "What if you shut down?" "Where's my data?" "Can I export?"
- [ ] AI: Migration — "How do I move from [incumbent]?" "Will I lose [data/subscribers]?"
- [ ] AI: Capability gap — honest "what we do and don't do" vs incumbent
- [ ] AI: Legal/compliance — "Is this GDPR compliant?" "Who owns my data?"
- [ ] AI: Pricing/catch — "How is this free?" "What's the catch?"
- [ ] AI: SaaS vs repo guidance — "Which option should I choose?"
- [ ] AI: How-to snippets — copyable prompts ("tell your agent to do X")
- [ ] HUMAN: Review and refine all FAQ content — this is a sales page disguised as help

**Three content layers:**
- [ ] AI: FAQ (human-readable, conversion-focused)
- [ ] AI: How-to snippets (human-to-agent bridge, copyable prompts)
- [ ] AI: llms.txt (agent-native, machine-readable product description for autonomous discovery)

#### 5. Legal
Draft from existing Kychee/Eleanor/run402 templates. ALL legal documents require human approval.

- [ ] AI: Terms of Service → HUMAN: Approve
- [ ] AI: Privacy Policy (tailored per product — data handling differs by segment) → HUMAN: Approve
- [ ] AI: Cookie/consent notice → HUMAN: Approve
- [ ] AI: Acceptable Use Policy (if users host content) → HUMAN: Approve
- [ ] AI: Data Processing Agreement / DPA (especially for EU-targeting products) → HUMAN: Approve
- [ ] Repo: MIT license (standard, no approval needed)

#### 6. Analytics and Tracking
- [ ] AI: Set up GA4 property for the product (under Kychee GA4 account)
- [ ] AI: Configure measurement ID and data streams
- [ ] AI: Implement GA4 tags on all pages
- [ ] AI: Define key events to track (signup, repo clone, SaaS-vs-repo choice, FAQ engagement)
- [ ] DECIDE: Define conversion goals per product

#### 7. Infrastructure Review
Not a gate — just a task list. Review run402 capabilities and fill gaps.

- [ ] AI: Audit what the product needs vs what run402 provides today
- [ ] AI: List infrastructure gaps (e.g., WebSockets, event ingestion, video hosting)
- [ ] AI: Create run402 enhancement tasks for any gaps
- [ ] AI: Implement run402 changes as needed

#### 8. Marketing Strategy

**Frameworks:** Crossing the Chasm (beachhead dominance) + Innovator's Dilemma (disrupt from below)

**Hypothesis Card (must be completed before pilot spend):**
- [ ] DECIDE: Beachhead segment — specific, findable, reachable group
- [ ] DECIDE: Primary channel — single channel for pilot (developer → HN/Reddit/GitHub organic; B2B → Google Ads; creator/prosumer → social)
- [ ] DECIDE: Pilot budget — $500 as reference floor, flex up per product
- [ ] DECIDE: Timeframe — 2-4 weeks typical
- [ ] DECIDE: Signal metrics — signups, stars, conversion rate, CAC, etc.
- [ ] DECIDE: Success threshold — concrete number (e.g., "50 signups at <$10 CAC")
- [ ] DECIDE: Kill criteria — what tells you to stop
- [ ] DECIDE: Next step if success — budget increase, channel expansion, target KPIs

**Shared marketing infrastructure (SaaSpocalypse + segment hubs):**
- [ ] DECIDE: Which SaaSpocalypse channels this product appears on (Facebook page, kychee.com/saaspocalypse)
- [ ] DECIDE: Which segment hubs this product belongs to (e.g., kychee.com/for/freelancers)
- [ ] AI: Create/update hub page content for this product
- [ ] AI: Create social posts for SaaSpocalypse page
- [ ] AI: Create segment-specific social content

**Per-product marketing:**
- [ ] DECIDE: Channel strategy — where to focus (Google Ads, Facebook, Instagram, TikTok, HN, Reddit, ProductHunt, other)
- [ ] AI: Generate ad creative → HUMAN: Approve
- [ ] AI: Generate first video ad concept → HUMAN: Approve
- [ ] DECIDE: Social presence — does this product need its own social accounts or only hub presence?
- [ ] AI: Set up ad campaigns → HUMAN: Approve spend

#### 9. Collateral
All AI-generated, human-approved. Iterate until satisfactory.

- [ ] AI: Logo → HUMAN: Approve
- [ ] AI: Ad creatives (static) → HUMAN: Approve
- [ ] AI: Video ad (first version) → HUMAN: Approve
- [ ] AI: Social media assets → HUMAN: Approve
- [ ] AI: README hero image / screenshots for repo → HUMAN: Approve

#### 10. Cross-Linking (Kychee Ecosystem)
Every product must be woven into the Kychee ecosystem.

- [ ] AI: Add product to kychee.com (portfolio/products page)
- [ ] AI: Add "Built on run402" mention with link on product site
- [ ] AI: Cross-link to/from bld402 where relevant (builder audience)
- [ ] AI: Cross-link to/from relevant segment hub pages
- [ ] AI: Cross-link to/from SaaSpocalypse hub
- [ ] AI: Update run402.com showcase/examples if appropriate

#### 11. Business Plan
Per-product, filled during spec phase.

- [ ] DECIDE: Monetization model for hosted SaaS
- [ ] DECIDE: Cost structure (run402 infra cost, domain, ad spend)
- [ ] DECIDE: Hypothesis — what the pilot spend should prove
- [ ] DECIDE: Success criteria — quantified
- [ ] DECIDE: Scale plan if success — next budget, next channel, target KPIs
- [ ] DECIDE: Unfair advantage — what can't be easily copied (run402 infra? agent-native? vertical niche?)

### How this doc feeds the skill chain

| Skill | How it uses the factory doc |
|---|---|
| `/brainstorm` | Scans chapters 1, 2, 8, 11 — ensures strategic decisions are explored |
| `/spec` | Scans chapters 2-7, 10 — ensures spec covers all deliverables (website, FAQ, legal, llms.txt, analytics, cross-links) |
| `/plan` | Scans all chapters — ensures every unchecked task becomes a planned work item with role assignment |
| `/implement` | Not needed — plan has all tasks |
| `/validate` | Not needed — validates against spec |

### Lifecycle per product

1. Copy factory doc into `docs/` of new product repo
2. Run `/brainstorm` with factory doc as reference — explores strategy, fills DECIDE items in chapters 1, 2, 8, 11
3. Run `/spec` with factory doc as reference — specifies all deliverables, fills remaining DECIDE items
4. Run `/plan` with factory doc + spec as reference — breaks all remaining tasks into actionable work items
5. Run `/implement` — executes the plan
6. Run `/validate` — tests against spec
7. Human final review — legal sign-off, collateral approval, launch go/no-go

## Key Decisions

- **Factory doc is a reference, not an orchestrator.** It doesn't replace or wrap the existing skills — it feeds them as context. Chosen because the skill chain already works; the gap is completeness of input, not process.
- **Copied per product, not shared.** Each repo gets its own copy so it can be annotated and checked off. Avoids coupling between products.
- **Not needed after /plan.** Once the plan exists, the factory doc's job is done. All tasks are decomposed. This keeps it from becoming a parallel tracking system.
- **Three audiences are first-class.** Builders, end users, and AI agents are not an afterthought — every chapter considers all three.
- **FAQ is a conversion weapon.** Treated as strategic sales content, not help documentation. Six mandatory categories per product.
- **Legal is a human gate.** AI drafts, human approves. No shipping without legal sign-off.
- **Hypothesis card before spend.** No marketing dollars without a concrete, falsifiable hypothesis with success/kill criteria.
- **SaaSpocalypse is a movement under Kychee**, not its own brand/domain. Lives at kychee.com/saaspocalypse.
- **Single-channel pilot by default.** $500 proves nothing split across 4 channels. Template encourages focus, but allows flex per product.

## Open Questions

- **Template versioning:** As we learn from each product launch, the factory doc will evolve. Should there be a "master" copy that gets updated, with product copies forked from it? Or is each copy independent after creation?
- **Skill modifications:** Do `/brainstorm`, `/spec`, and `/plan` need code changes to auto-detect and consume the factory doc, or is it sufficient to pass it as a reference argument?
- **SaaSpocalypse content strategy:** Who creates ongoing content for the movement page? Is it automated from product launches, or does it need its own editorial calendar?
- **Agent marketplace integration:** As AI agents become distribution channels, should there be a registry or MCP tool listing for each product so agents can discover all Kychee SaaS offerings?

## Readiness for /spec

- [x] Problem/opportunity clearly defined
- [x] Target audience identified
- [x] Core idea described
- [x] Key assumptions surfaced and challenged
- [x] MVP or simplest version discussed
- [x] Business model considered (or explicitly deferred)
- [x] Open questions documented

Status: ready — ready for `/spec` to turn this into the formal factory document.
