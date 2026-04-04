---
product: kysigned
feature: null
status: ready
created: 2026-04-04
updated: 2026-04-04
references:
  - type: doc
    path: ~/Downloads/kysigned-product-doc-v2_1.md
    description: Full product document covering architecture, legal framework, competitive landscape, pricing, data model, and repo structure
  - type: doc
    path: docs/products/saas-factory/saas-factory-spec.md
    description: SaaS Factory spec — launch template for all Kychee SaaS-alternative products
  - type: doc
    path: docs/products/saas-segments/saas-killing-segments-ranked.md
    description: Ranked SaaS segments — kysigned is segment #34 (E-Signature), marked IN PROCESS
---

## Problem / Opportunity

DocuSign dominates e-signatures (~67% market share, $2.8B revenue) with subscription pricing that punishes low-volume users. Freelancers pay $2-3 per signature on plans that cost $10-25/month. Small agencies pay $75+/month. The pricing model charges for the most basic action — sending a document for someone to sign — and locks users into monthly commitments regardless of usage.

The e-signature market is $7B (2025), projected $24.5B by 2030 at 28% CAGR. Documented, citable user outrage exists across G2, Trustpilot, and DocuSign's own community forums.

DocuSign cannot compete at $0.25/envelope without destroying their subscription business. Textbook Innovator's Dilemma: the incumbent's business model is the vulnerability.

## Target Audience

Four segments identified for initial testing (beachhead to be selected based on traction data):

1. **Freelancers** — 2-5 signatures/month. Currently paying $10-15/month for DocuSign. Findable on r/freelance, Twitter/X, freelancer communities.
2. **Solo consultants/coaches** — 5-15 signatures/month. Send a contract per client. Findable on LinkedIn, Twitter/X.
3. **Small agencies** — 10-20 signatures/month for proposals and SOWs. 3+ seats at $25/seat = $75+/month on DocuSign. Findable via agency directories, Slack communities.
4. **Real estate agents** — high volume, daily pain. DocuSign has a captive market plan ($20-25/month). Findable via obvious channels.

Wedding vendors were considered but deferred — seasonal usage pattern creates uncertainty about retention.

**Repo forkers (secondary audience):** Organizations wanting a branded signing server for internal use (law firms, agencies, enterprises). They deploy on run402 and are run402 infrastructure customers, not kysigned service customers. The repo is for self-use, not resale.

## Proposed Idea

A blockchain-verified e-signature service that replaces DocuSign's subscription model with per-envelope pricing. Two delivery modes: a hosted API at kysigned.com and a free MIT-licensed repo deployable on run402.

Every signature event is recorded on Base (Ethereum L2) via a smart contract. The on-chain recording creates a permanent, vendor-independent audit trail. Verification works even if kysigned.com disappears.

### Three sender paths (who sends the document)

- **Path 1: Has wallet** — native x402/MPP payment per envelope. No account, no signup. Wallet address is identity.
- **Path 2: Creates wallet** — same as Path 1 after 60-second onboarding. One-time setup, then zero friction.
- **Path 3: No wallet** — Stripe checkout for prepaid signing credit packs ($5-20). Email-based identity. Platform wallet handles on-chain recording. Widest funnel.

All three paths are MVP — they serve different audiences, not different feature tiers. Path 3 users get the same on-chain proof as Path 1/2.

### Two signer methods (who signs the document)

- **Method A: Email-based** — identical UX to DocuSign. Signer never sees crypto. Browser generates ephemeral Ed25519 keypair, signs client-side. Salted commitment hash recorded on-chain (privacy-preserving).
- **Method B: Wallet signing (EIP-712)** — signer's own wallet displays exactly what they're signing. Strongest possible evidence of informed consent. Signer's Ethereum address recorded on-chain (public by design — signer opts in).

### Positioning hierarchy

1. **Cost** — pay per use, not per month. ~90% cheaper than DocuSign. "Pay for infrastructure used, not subscription locks and overheads. Don't use, don't pay." This is the universal message across all Kychee SaaS-alternative products.
2. **Trustless proof** — you don't need to trust us. Proof is on the blockchain, algorithm is open source, verification is independent. If we shut down, your paper trail lives forever. "We don't hold the proof — Base does."
3. **Agent-native** — CLI/MCP for AI agents. Agent discovers (llms.txt), pays (x402/MPP), and executes (API) signing requests autonomously. No other e-signature product offers this.
4. **"Payment IS the proof"** — the micropayment that pays for the signature and the on-chain evidentiary record are one transaction. This is the "How it works" explanation, not a direct user value prop.

### Payment protocols

Both x402 and MPP (Stripe's Machine Payment Protocol) are supported on run402. kysigned accepts either for Path 1/2 sender payments. This gives agents two rails — crypto-native (x402) or fiat-native (MPP) — into the same product.

## Key Decisions

- **All three sender paths are MVP.** They complement audiences, not compete. Path 3 (Stripe prepaid) is essential for the widest funnel (non-crypto users). Path 1/2 (wallet) serves developers, agents, crypto-native users.
- **Beachhead selection deferred to data.** Four hypothesis cards will be prepared (freelancers, solo consultants, small agencies, real estate agents). One will be selected before the first marketing campaign. This is a pragmatic deviation from strict Crossing the Chasm "pick one" orthodoxy — a lightweight test phase before committing.
- **Pricing ~$0.25/envelope (pending gas cost measurement).** Actual costs on Base need to be measured before final pricing. Each signature requires gas, so per-signer costs are real (unlike centralized competitors where adding a signer costs nothing). Starting assumption: $0.25/envelope is 10x cheaper than the cheapest pay-per-use competitor (GoodSign at $1.50) and 90%+ cheaper than DocuSign.
- **Verification open from day 1, signing protocol standardization deferred.** The smart contract is public on Base, ABI published, verification algorithm documented. "How to prove this document was signed in 2026" must work in 2046 without kysigned. Whether to position the signing protocol as an open standard for others to adopt is a future decision based on traction.
- **No "kill" language in public-facing materials.** Internal docs use "SaaS-killer" framing. Customer-facing copy (landing page, FAQ, README, ads, legal, llms.txt) uses "alternative to," "replace," "switch from," "better than."
- **Repo forkers are run402 customers, not kysigned resellers.** Self-hosted instances use run402 infrastructure (paid via Stripe or x402). The repo is for organizational self-use. Forkers can use custom subdomains (acme-sign.run402.com) or their own domain (acme-sign.com) — run402 supports both.
- **Core differentiator approach: combined B+C.** Cost (Approach C) leads the pitch, trustless proof (Approach B) differentiates from other cheap alternatives, "payment IS proof" (Approach A) explains the mechanism in FAQs. None of these alone is the positioning — the stack is.
- **x402 AND MPP supported.** The "payment IS the proof" model is not x402-specific. Both machine payment protocols work for agent-driven signing.

## Open Questions

1. **Actual gas costs on Base** — deploy SignatureRegistry.sol and measure per-signature and per-completion transaction costs. Pricing depends on this.
2. **Multi-signature PDFs** — documents with multiple signature fields (per page, per section). What's the UX? Hash whole doc once or hash per section? Does the signer confirm reading each section? Likely post-MVP but needs design thinking.
3. **Second-channel verification feature** — generate a second verification link sendable via any channel (SMS, WhatsApp, Slack) as independent proof alongside email. Strengthens the "someone with access to email X signed" claim. Feature scope and priority TBD.
4. **T&C precision on what signatures prove** — Terms of Service must clearly explain the evidentiary value: "someone with access to email X signed." Not "person X signed." Legal language needs care.
5. **Custom domain support for forkers** — run402 supports subdomains (acme-sign.run402.com) and likely custom domains. Needs confirmation.
6. **Proof verifier app** — a standalone tool (part of the MIT repo or separate) that anyone can use to verify signatures against the canonical contract without kysigned.com. Makes the "survives vendor death" promise tangible.
7. **Future: run402 payment collection for server builders** — could run402 offer Stripe-based payment collection so repo forkers can charge their own users? Not in kysigned scope, but a run402 platform feature that would benefit all SaaS-alternative products. Worth noting somewhere as a platform idea.
8. **Envelope terminology** — adopting industry-standard "envelope" (one document package, one or more signers). No reason to break from DocuSign's established terminology. Per-signer surcharge beyond 5 signers reflects real gas costs.
9. All 13 open questions from the product doc (email deliverability, PDF rendering, certificate design, sequential vs parallel signing, expiry TTL, document retention, contract naming, protocol spec timing, platform wallet security, credit pack pricing, visual signature for Method B, mobile wallet UX) remain open for `/spec` phase.

## Readiness for /spec

- [x] Problem/opportunity clearly defined
- [x] Target audience identified
- [x] Core idea described
- [x] Key assumptions surfaced and challenged
- [x] MVP or simplest version discussed
- [x] Business model considered (or explicitly deferred)
- [x] Open questions documented

Status: ready
