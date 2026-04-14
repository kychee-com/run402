---
name: kychon-retrofit-and-spec-feedback
description: Bidirectional alignment between kychon (first real product) and the saas-factory spec — retrofit kychon to factory compliance, and feed kychon's real-world patterns back into the factory spec.
type: feature
product: saas-factory
feature: kychon-retrofit
status: ready
created: 2026-04-14
updated: 2026-04-14
references:
  - type: doc
    path: /Users/talweiss/Developer/run402/docs/products/saas-factory/saas-factory-spec.md
    description: The saas-factory spec being refined through this exercise (v1.18.0 after this brainstorm)
  - type: doc
    path: /Users/talweiss/Developer/run402/docs/products/saas-segments/saas-killing-segments-ranked.md
    description: Segment ranking doc — kychon is listed at #24 (Tier 3) as a Memberful-killer; this brainstorm rejects that framing and re-beacheads kychon as a Wild-Apricot-killer for professional associations
  - type: repo
    path: https://github.com/kychee-com/kychon
    description: Public MIT forkable template — post-split, orphan-squashed to v1.0.0 on 2026-04-14
  - type: repo
    path: https://github.com/kychee-com/kychon-private
    description: Private operator repo — created 2026-04-14 from the split (marketing site, competitive research, operator batch-deploy config)
  - type: doc
    path: https://github.com/kychee-com/kychon/blob/main/docs/spec.md
    description: Kychon's own product spec (predates factory; still needs to be reworked against factory F1-F27)
---

## Problem / Opportunity

The saas-factory spec was designed top-down from Crossing-the-Chasm and Innovator's-Dilemma principles but was never pressure-tested against a real product. Kychon was built bottom-up over months of iteration, pre-factory, and shipped several patterns (inline editing, config-driven customization, vertical-skin seeds, i18n-from-day-one) that the factory spec did not anticipate. Meanwhile, kychon drifted from factory conventions (single-repo instead of dual-repo, no `-private` counterpart, marketing site mixed into the MIT repo, no LEGAL.md / llms.txt / Shipping Surfaces / bootstrap script).

The opportunity is bidirectional: use kychon to harden the factory spec with real-world patterns the top-down design missed, AND use the factory spec to give kychon a disciplined v1.0.0 release shape it didn't have on its own.

## Target Audience

- **Primary:** Kychee operators (Tal, Barry) — they ship kychon and write the factory spec. Both artifacts need to be coherent with each other.
- **Secondary:** Future saas-factory products (kysigned is the other active one today; more will come). They inherit the refined spec. The more battle-tested it is, the less rework each new product accumulates.
- **Tertiary:** Forkers of kychon — they benefit from a pristine v1.0.0 MIT repo that does not leak operator marketing / competitive strategy content into their fork.

## Proposed Idea

A single bidirectional alignment pass:

1. **Retrofit direction (factory → kychon):** Bring kychon into compliance with the factory's structural requirements — dual repo (F12), brand asset separation (F15), T2 billing specification (F18), LEGAL.md (F8), Shipping Surfaces (F21), bootstrap script (F22), llms.txt (F5/F17).
2. **Feedback direction (kychon → factory):** Codify kychon's shipped patterns that the factory didn't anticipate — SQL-as-agent-API, inline editing, schema-driven pages, seed-as-vertical-skin, i18n day-one, live platform-gaps feedback, demo-variant canaries.

The work has already been done for everything in the feedback direction (factory v1.17.0 + v1.18.0) and the most invasive retrofit items (dual-repo split, orphan-squash to v1.0.0). The remaining retrofit items are smaller — addable as follow-on tickets.

## Business Thinking

We did a partial lean-canvas walkthrough. Covered: problem, customer segments, unique value proposition, solution (partially), unfair advantage. Deferred: channels, revenue streams, cost structure, key metrics.

### Problem + Customer Segments

The segments doc ranks kychon #24 (Tier 3, Memberful-killer) with a "weak disruption angle" verdict. That framing was rejected during this brainstorm. The real beachhead is **professional / trade associations**, making kychon a **Wild Apricot killer**. Wild Apricot's per-contact pricing is the sharpest complaint pattern: adding 50 members jumps the monthly bill by $70+. ICPs are findable via ASAE (American Society of Association Executives), industry-specific directories, and trade-group networks.

HOA was considered and rejected because (a) operator doesn't know American HOA culture, and (b) state-by-state compliance (Florida 720, California Davis-Stirling, Texas 209) is too heavy for a first beachhead. Church was considered and rejected because (a) pricing outrage is mild (Breeze at $64/mo flat), (b) tax-receipt + child-safety features add complexity without clear wedge. Association wins on lowest-cost-to-ship with sharpest incumbent-pricing story.

### Unique Value Proposition

"Wild Apricot charges $240/month for 2,000 members. This is free forever." Secondary wedge: the vertical-skin strategy means one engine serves many niches (association, church, HOA, yacht club, alumni network, etc.) via data changes (seed SQL + strings JSON), not code changes.

### Solution

Kychon already ships ~80% of what a Wild Apricot killer needs: member directory, announcements, committees, events, resources, forum, polls, admin overlays, i18n, multiple demo tenants. What's missing for the association beachhead specifically: tiered memberships with auto-renewal, event registration with tickets, member application/approval workflow, gated content for paid members. These are scoped as post-v1.0.0 features.

### Unfair Advantage

The run402 coupling via factory F23 + F26. F23 couples the product to run402's HTTP APIs for runtime paths (auth, payment, mailbox). F26 couples the product to run402's Postgres database as the customization surface (SQL-as-agent-API, seed files, JSONB config). Together they make "fork kychon for my yacht club" a data operation on run402's database, not a code operation. A coding agent can spin up a niche variant in minutes without ever leaving the run402 data plane. This is what makes the vertical-skin strategy tractable, and it compounds run402 adoption with every fork.

## Key Decisions

1. **Beachhead = professional / trade associations (Wild Apricot killer).** Rationale: sharpest incumbent-pricing outrage, lowest regulatory friction, globally applicable (not US-specific like HOA), kychon's existing feature set already covers ~80% of what's needed. How to apply: chapter 1 of kychon's own factory doc copy targets associations; chapter 4's FAQ "migration from Wild Apricot" category is mandatory; chapter 8's hypothesis card focuses on ASAE / industry-directory channels.

2. **Shipping thesis overrides segments-doc Tier 3 ranking.** Rationale: kychon is being shipped seriously as a real product. The Tier 3 ranking assumed generic-membership framing; the vertical-skin framing (one engine, many niches) pushes kychon into Tier 1/2 territory. How to apply: segments-doc row for kychon should be updated to reflect the association-specific framing after this brainstorm; Kychon's own spec emphasizes vertical-skin as the core strategy, not generic-membership.

3. **Dual-repo split executed on 2026-04-14.** Public `kychee-com/kychon` (MIT, forkable, demo variants included) + private `kychee-com/kychon-private` (marketing site, competitive research, operator batch-deploy config). Rationale: MIT can't cover commercial marketing identity or competitive positioning docs; pristine fork experience requires separation. How to apply: all future commercial / operator-only content goes to the private repo; demo variants (silver-pines, eagles, barrio-unido) stay public as F26.4 + F25.13 reference artifacts.

4. **Naming convention `-private`, not `-service`.** Rationale: `-service` presumes hosted infrastructure; kychon's private repo is mostly marketing + ops with no hosted backend yet. `-private` generalizes across product shapes. How to apply: factory v1.18.0 updated throughout; kysigned will rename `kysigned-private` → `kysigned-private` in lockstep (no grandfather clause).

5. **Public kychon orphan-squashed to v1.0.0.** Rationale: factory F12 mandates "squash all development history into a single v1.0.0 commit before going public." Kychon was already public with 106 commits of pre-factory iteration; orphan-squash applied retroactively. User confirmed: zero existing forks/users, so history disruption is moot. How to apply: archive branch `archive/pre-v1.0.0` preserves the pre-squash history for audit; the public repo now starts fresh at v1.0.0 with a clean MIT baseline.

6. **Factory spec additions (v1.17.0 + v1.18.0):**
   - **F25.13** — demo-variant canary pattern as the database-driven instantiation of F25 dark-launch, parallel to kysigned F17's on-chain instantiation. Silver-pines cited as canonical worked example.
   - **F26** — Agent-Forkable Database-Driven Architecture. Five sub-requirements: SQL-as-agent-API via `site_config` JSONB (F26.1), inline editing in place of an admin CMS (F26.2), schema-driven content via `pages` + `sections` tables (F26.3), seed files as the vertical-skin mechanism (F26.4), i18n from day one via the Krello pattern (F26.5). Kychon cited as canonical reference (F26.6).
   - **F27** — Live Platform-Gaps Feedback Loop. Every product ships a public `docs/run402-feedback.md` as a running backlog of missing platform capabilities, with workarounds documented and a `✅ FIXED` closure marker when the platform ships the capability upstream. kychon's on-signup lifecycle hook is the closed-loop worked example.
   
   Rationale for F26/F27 especially: both codify real kychon patterns that were load-bearing in practice but missing from the spec. The hidden motive (per the operator's direction during this brainstorm) is **run402 coupling as trojan horse**: F23 couples on the HTTP surface, F26 couples on the database surface, F27 coalesces platform demand across products. A forker who accepts F26 has accepted run402's Postgres as the configuration plane; a forker who accepts F27 has accepted run402's lifecycle as the feedback target. How to apply: every database-driven future product inherits F26/F27; opt-outs require a positive one-paragraph rationale.

7. **`site/` directory deleted outright, not moved.** Rationale: legacy pre-Astro code, fully superseded by `src/pages/*.astro` (commit `1a8e93b` made the migration). `deploy.js` never referenced `site/`; build output goes to `dist/`. Stale refs in docs (`site/custom/strings/`) were mechanically updated to `public/custom/strings/`. How to apply: future products following F26 should not carry parallel "legacy" directories into the factory-compliant v1.0.0; either delete or explicitly justify.

8. **`app-silver-pines.example.json` committed as F25.13 reference.** Rationale: the factory spec calls out silver-pines as the canonical demo-variant config, but the live `app-silver-pines.json` was gitignored and never actually visible to forkers. `.gitignore` now ignores `app-*.json` but explicitly tracks `app-*.example.json` (and `app.example.json` for future use). How to apply: every product with run402 project configs should ship `.example` counterparts tracked in git while keeping live configs gitignored.

9. **Stale `claude/*` branches deleted from kychon remote.** Rationale: those branches pointed at pre-orphan-squash commits and would only confuse readers of the repo going forward.

## Open Questions

1. **Channels for the association beachhead.** Not explored in this brainstorm. Needs the factory F6 hypothesis card filled out for at least one segment before marketing spend begins. ASAE and industry-specific directories look like the leading candidates.
2. **T2 billing mechanism for hosted kychon.** Factory F18 requires explicit T2 choice (wallet-native via x402 vs. app-owned Stripe vs. "no T2 — internal use"). Not yet decided. Affects the private repo's scope substantially (Stripe integration is a week of work; wallet-native leverages existing run402 middleware).
3. **Pricing model for hosted kychon commercial offering.** Freemium? Flat per-tenant? Per-member-tier? Not decided. Interacts with (2).
4. **Kychon.com marketing story shape.** Vertical-skin-per-page (e.g., `kychon.com/for/associations`, `/for/churches`, `/for/hoa`) vs. single generic page with vertical examples. Current `marketing/` has both HOA, church, sports, and associations pages — leaning vertical-per-page but unconfirmed.
5. **`app.example.json` — ship one alongside `app-silver-pines.example.json`?** `.gitignore` already has the exception rule but no file. Forkers may want the base deploy config as a reference too.
6. **Naming polish for `kychon-private/docs/`.** Currently has `docs/comparisons/` + `docs/consultations/`. `docs/strategy/` or `docs/positioning/` may be clearer categorization for future additions. Low priority.
7. **Timing of the physical `kysigned-private` → `kysigned-private` GitHub rename.** Factory v1.18.0 prescribes it; the rename is the operator's to-do (not part of this brainstorm's execution).
8. **Long-term: cross-product `run402-feedback.md` aggregation.** F27 prescribes per-product files. Once 3+ products are shipping, a central index on `run402.com/feedback` (or similar) is probably the natural consolidation — but that's future work.

## Follow-on retrofit tasks (not executed in this brainstorm)

These are the factory-compliance items still open for kychon. Track as their own change / plan when the user is ready:

**Public `kychee-com/kychon`:**
- `LEGAL.md` (F8) — product-specific disclaimers separate from MIT LICENSE
- `llms.txt` (F5 + F17) — agent-discovery manifest listing `site_config` keys, allowed values, entity schemas
- `## Shipping Surfaces` section in `docs/spec.md` (F21) — enumerate user-reachable artifacts with smoke checks
- `CUSTOMIZING.md` updated to explicitly document F26.1–F26.5 compliance (agents read this as the seed-file / config-key reference)

**Private `kychee-com/kychon-private`:**
- `scripts/bootstrap-run402.ts` (F22) — idempotent 9-step provisioning script, copied and adapted from `kysigned-private/scripts/bootstrap-run402.ts` once that is renamed
- `package.json` with `"kychon": "file:../kychon"` dependency (F12 local-dev stage)
- `legal/` directory with approved ToS, Privacy Policy, Cookie notice, AUP, DPA sources

**Segments doc:**
- Update row 24 in `docs/products/saas-segments/saas-killing-segments-ranked.md` to reflect the Wild-Apricot-killer + vertical-skin framing, not the generic Memberful-killer framing. Likely re-tiers kychon out of Tier 3.

## Readiness for /spec

- [x] Problem/opportunity clearly defined
- [x] Target audience identified
- [x] Core idea described
- [x] Key assumptions surfaced and challenged
- [x] MVP or simplest version discussed (kychon's current state is the MVP; orphan-squashed v1.0.0 is the shipping cut; remaining retrofit items are explicit follow-on tasks)
- [x] Business model considered (beachhead chosen; T2 + pricing deferred as open questions)
- [x] Open questions documented

Status: **ready** — but note that the "bidirectional feedback" portion of this idea has already been executed via factory spec v1.17.0 (F25.13, F26, F27) and v1.18.0 (the `-service` → `-private` rename) on 2026-04-14. The "retrofit" portion is partially executed (dual-repo split + orphan-squash) and partially deferred to follow-on work (LEGAL.md, llms.txt, Shipping Surfaces, bootstrap script, CUSTOMIZING.md F26 compliance, segments-doc re-tier). A subsequent `/spec` run should either (a) spec the remaining retrofit items as a kychon-specific change, or (b) skip `/spec` for these small-enough items and handle them as ad-hoc tickets. Operator's call.
