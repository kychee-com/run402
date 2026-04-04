# Plan: kysigned

**Owner:** Barry Volinskey
**Created:** 2026-04-04
**Status:** Ready for Implementation
**Spec:** docs/products/kysigned/kysigned-spec.md
**Spec-Version:** 0.1.0
**Upstream References:** docs/products/saas-factory/saas-factory-spec.md (v1.4.0)
**Source:** spec
**Worktree:** none — product code lives in separate repos (C:\Workspace-Kychee\kysigned and C:\Workspace-Kychee\kysigned-service). run402 platform enhancements use a run402 worktree on a feature branch.

## Legend
- `[ ]` Todo | `[~]` In Progress | `[x]` Done
- `[both]` = public repo + service repo | `[service]` = service repo only | `[repo]` = public repo only
- Task ownership: `AI` = agent executes | `HUMAN` = human action required | `DECIDE` = collaborative decision

---

## Design Decisions

### DD-1: Two-repo dependency model
- **Decision:** Public repo (`kysigned`) is the core library. Service repo (`kysigned-service`) imports it via `file:../kysigned` during development, `github:kychee-com/kysigned#tag` when stable, npm package when mature.
- **Alternatives:** Monorepo with extraction; git submodule; always-remote git dependency
- **Chosen because:** Local `file:` gives instant iteration with true repo separation. Two real repos from day one enforces clean boundaries and honest testing.
- **Trade-offs:** One-line change needed in package.json when transitioning between stages.
- **Rollback:** N/A — single-line change to switch between dependency modes.

### DD-2: Smart contract lives in public repo
- **Decision:** `SignatureRegistry.sol` lives in `kysigned/contracts/`. Forkers get everything in one clone.
- **Alternatives:** Separate `kysigned-contracts` repo; in the run402 repo
- **Chosen because:** The contract is the core product. No reason to separate unless other products use it (future concern).
- **Trade-offs:** None meaningful.

### DD-3: Platform wallet follows run402 infrastructure
- **Decision:** Path 3 on-chain recordings use whatever wallet infrastructure run402 already has (likely CDP SDK). Not a per-product decision.
- **Alternatives:** AWS KMS-managed key; dedicated wallet per product
- **Chosen because:** Platform concern, not product concern. Resolved during run402 audit.
- **Trade-offs:** Depends on run402 audit results.

### DD-4: Signature visual mode — sender controls
- **Decision:** Sender sets `require_drawn_signature` per envelope (default: false). Default = one-click auto-stamp (name in handwriting font + crypto details). If true = drawing widget for all signers. Saved signatures persist in browser cookie/localStorage.
- **Alternatives:** Always require drawing (DocuSign style); always auto-stamp
- **Chosen because:** One-click signing is fastest possible UX and a differentiator. Drawing adds zero legal value but some users/counterparties expect it. Sender (who pays) decides the formality level.
- **Trade-offs:** Some signers may initially be surprised by no drawing step.

### DD-5: Default signing order is parallel
- **Decision:** When sender doesn't specify, all signers are notified simultaneously (parallel). Sequential requires explicit `"signing_order": "sequential"`.
- **Alternatives:** Default sequential
- **Chosen because:** Matches industry convention. Simpler. Most use cases don't need ordered signing.

### DD-6: No persistent PDF storage in MVP
- **Decision:** PDFs retained for 30 days (pending cost validation) then deleted. Only metadata + on-chain hash persists. Paid retention is future feature.
- **Alternatives:** Permanent storage; no storage at all (delete immediately after completion email)
- **Chosen because:** Minimizes infra costs (enables $0.25 pricing). 30-day window gives users time to download.

### DD-7: Verification levels 1, 2, 5 for MVP
- **Decision:** Level 3 (SMS/WhatsApp) and Level 4 (government ID) are post-MVP. Manual signing link delivery via any channel covers the multi-channel gap.
- **Alternatives:** Include Level 3 with direct Twilio integration
- **Chosen because:** Avoids external messaging dependency. Manual link delivery achieves the same trust goal. Level 3/4 will be run402 platform services.

### DD-8: Email templates — HTML with plain text alternative
- **Decision:** HTML email templates in the repo with multipart plain text. Table-based layout, inline CSS, no JS, no image-heavy design, no URL shorteners. Small (<100KB). `List-Unsubscribe` header included.
- **Alternatives:** Markdown-to-email; run402 templating service
- **Chosen because:** Maximum deliverability, forkable, no dependencies.

---

## Tasks

### Phase 0: Foundation `AI`

- [x] Create private GitHub repo `kychee-com/kysigned` [infra]
- [x] Create private GitHub repo `kychee-com/kysigned-service` [infra]
- [x] Clone both repos locally under `C:\Workspace-Kychee\` (`kysigned` and `kysigned-service` side by side) [infra]
- [x] Create VS Code multi-root workspace file `C:\Workspace-Kychee\kysigned.code-workspace` with all three repos [infra]
- [ ] **STOP — switch to the new workspace view before continuing** [manual] `HUMAN`
- [ ] Initialize `kysigned` repo: package.json, tsconfig, README stub, MIT LICENSE, .gitignore [code]
- [ ] Initialize `kysigned-service` repo: package.json with `"kysigned": "file:../kysigned"` dependency, tsconfig, .gitignore [code]
- [ ] Draft LEGAL.md for public repo (signature validity disclaimers, jurisdictional limitations, smart contract permanence, operator responsibility, excluded document types) [code] `AI -> HUMAN: Approve`
- [ ] Audit run402 capabilities for kysigned dependencies [infra]:
  - Prepaid credit/paycard model (buy credits, deduct per API call)
  - Magic link authentication (email-only, no password)
  - Custom domain mapping for forkers
  - Email sending service (deliverability, SPF/DKIM/DMARC)
  - Platform wallet for on-chain recordings
- [ ] For each missing run402 capability: create a run402 enhancement task with scope estimate, implement in run402 worktree (feature branch) [manual] `AI`
- [ ] Register domain kysigned.com [manual] `HUMAN`

### Phase 1: Smart Contract `AI`

- [ ] Write SignatureRegistry.sol with EIP-712 domain separator (Base chainId 8453) [code]
  - `recordEmailSignature(envelopeId, documentHash, signerCommitment, signerPubkey, signature)`
  - `recordWalletSignature(envelopeId, documentHash, documentName, signerEmail, timestamp, signature)` with ecrecover
  - `recordCompletion(envelopeId, originalDocHash, finalDocHash, signerCount)`
  - `getSignatures(documentHash)` and `verifyWalletSignature(documentHash, expectedSigner)` query functions
  - Append-only — no update or delete functions
- [ ] Write contract unit tests (Hardhat/Foundry) [code]
  - Method A recording and retrieval
  - Method B recording with ecrecover verification
  - Completion event
  - Mixed-method envelope
  - Immutability (no modification/deletion possible)
  - Replay protection via EIP-712 domain separator
- [ ] Deploy to Base Sepolia testnet [infra]
- [ ] Measure gas costs per operation on testnet (recordEmailSignature, recordWalletSignature, recordCompletion) [infra]
- [ ] Document contract ABI and publish verification algorithm [code]

### Phase 2: Core Engine — Public Repo `[both]` `AI`

#### 2A. Database & Data Model

- [ ] Write database migrations for envelopes table (id, sender_type, sender_wallet, document_name, document_hash, status, signing_order, require_drawn_signature, created_at, completed_at, pdf_storage_key, signed_pdf_key, completion_tx, callback_url, expiry_at) [code]
- [ ] Write database migrations for envelope_signers table (id, envelope_id, email, name, salt, verification_level, require_wallet, signing_method, status, signing_order, signature_fields, signing_token, token_expires_at, signed_at, signer_ip, signer_user_agent, signer_pubkey, ephemeral_signature, signer_commitment, drawn_signature, signer_wallet, eip712_signature, tx_hash, reminder_count, last_reminder_at) [code]
- [ ] Write RLS policies for envelope access (sender can read own envelopes, signers can read their own signer record) [code]

#### 2B. Envelope Management API

- [ ] Implement `POST /v1/envelope` — create envelope with PDF + signers, compute SHA-256, generate envelope_id, generate per-signer salts and signing tokens, store PDF, return envelope_id + status_url + verify_url + signing links [code]
- [ ] Implement `GET /v1/envelope/:id` — return envelope status, signer statuses, tx hashes [code]
- [ ] Implement `POST /v1/envelope/:id/void` — void active envelope, notify pending signers [code]
- [ ] Implement `POST /v1/envelope/:id/remind` — resend notification to pending signers [code]
- [ ] Implement webhook delivery on envelope completion (POST to callback_url) [code]
- [ ] Implement envelope expiry logic — check TTL, transition to expired, notify parties [code]
- [ ] Implement sequential signing logic — notify next signer only after previous completes [code]
- [ ] Implement x402 payment middleware for Path 1/2 sender authentication [code]
- [ ] Implement MPP payment middleware for Path 1/2 sender authentication [code]

#### 2C. Signing Engine

- [ ] Implement `POST /v1/sign/:envelope_id/:token` — validate token, accept signature payload [code]
- [ ] Implement Method A server-side: verify Ed25519 signature, compute signer_commitment, call recordEmailSignature on contract [code]
- [ ] Implement Method B server-side: verify EIP-712 signature, call recordWalletSignature on contract [code]
- [ ] Implement duplicate signing protection — reject if signer already signed [code]
- [ ] Implement decline flow — update signer status, notify sender [code]
- [ ] Implement auto-stamp generation — render signer name in handwriting font + crypto details as PNG [code]
- [ ] Implement completion logic — detect all-signed, generate final PDF, compute final hash, call recordCompletion, fire webhook [code]

#### 2D. PDF Handling

- [ ] Implement PDF upload (base64 and URL) with SHA-256 hash computation [code]
- [ ] Implement signature embedding into PDF using pdf-lib (visual signature image at designated positions) [code]
- [ ] Implement final signed PDF generation with all signatures embedded [code]
- [ ] Implement Certificate of Completion PDF generation (document name, hash, signer details, timestamps, tx hashes, contract address) [code]
- [ ] Implement PDF retention/deletion — configurable TTL (default 30 days), metadata persists after deletion [code]
- [ ] Implement retention notification system — notify at creation, completion, and before deletion [code]

#### 2E. Email System

- [ ] Create HTML email templates (multipart HTML + plain text) for: signing request, reminder, confirmation, completion, void notification, expiry notification, retention warning [code]
  - Table-based layout, inline CSS, no JS, <100KB, List-Unsubscribe header
- [ ] Implement email sending abstraction — pluggable provider (run402 email service or custom SMTP/API) [code]
- [ ] Implement automated reminder scheduling (default: 3 days, 7 days) [code]
- [ ] Include spam notice in API response and dashboard: "Contact signers to check spam if not received" [code]

#### 2F. Verification

- [ ] Implement `GET /verify` page logic — accept PDF upload, compute hash, query ALL known contract addresses for matching events [code]
- [ ] Implement universal verification — check all envelopes on canonical contract, not just own instance [code]
- [ ] Implement contract address list (supports multiple historical contracts for future-proofing) [code]

#### 2G. Dashboard API

- [ ] Implement wallet-based authentication for dashboard (Path 1/2 — connect wallet, verify ownership) [code]
- [ ] Implement envelope list endpoint — filter by sender wallet, include status/progress/dates [code]
- [ ] Implement envelope detail endpoint — full audit trail per signer [code]
- [ ] Implement export endpoint — CSV and JSON formats [code]

### Phase 3: Frontend — Public Repo `[both]` `AI`

#### 3A. Signing Page

- [ ] Build PDF viewer component using pdf.js with signature field highlighting [frontend-visual]
- [ ] Build wallet detection — check for window.ethereum, show Method A/B options accordingly [frontend-logic]
- [ ] Build Method A signing flow: one-click auto-stamp (default) or drawing widget (if require_drawn_signature) [frontend-logic]
- [ ] Build Ed25519 key generation with Web Crypto API feature detection + tweetnacl.js fallback [frontend-logic]
- [ ] Build Method B signing flow: eth_signTypedData_v4 call with DocumentSignature struct [frontend-logic]
- [ ] Build signature drawing/typing widget with save-to-localStorage and "Use saved signature?" prompt [frontend-logic]
- [ ] Build verification level prompts: Level 1 (click only), Level 2 (type email confirmation) [frontend-logic]
- [ ] Build `require_wallet: true` enforcement — show Method B only [frontend-logic]
- [ ] Build duplicate signing screen — "You've already signed this document" [frontend-visual]
- [ ] Build decline flow UI [frontend-visual]
- [ ] Build signing confirmation screen with next steps [frontend-visual]

#### 3B. Verification Page

- [ ] Build `/verify` page — PDF upload, hash computation, results display [frontend-visual]
- [ ] Build verification results UI — signer count, dates, methods, wallet addresses (Method B), "email-verified" label (Method A) [frontend-visual]

#### 3C. Dashboard

- [ ] Build wallet connect authentication flow [frontend-logic]
- [ ] Build envelope list view — status, signer progress, dates [frontend-visual]
- [ ] Build envelope detail view — audit trail, signer statuses, tx hashes, on-chain links [frontend-visual]
- [ ] Build resend/remind button [frontend-logic]
- [ ] Build export button (CSV/JSON download) [frontend-logic]
- [ ] Build envelope creation form — PDF upload, add signers, set signing order, set require_drawn_signature, set verification levels, set require_wallet per signer [frontend-visual]

### Phase 4: Service Layer — Service Repo `[service]` `AI`

- [ ] Implement Path 3 prepaid credit system (via run402 paycard or own Stripe integration — based on Phase 0 audit) [code]
  - Stripe checkout for credit pack purchase (branded as kysigned)
  - Credit balance storage and per-envelope deduction
  - Insufficient balance error handling
  - Non-expiring credits
  - Low-balance threshold alert
  - Purchase history
- [ ] Implement magic link authentication for Path 3 (via run402 or own implementation — based on Phase 0 audit) [code]
  - Enter email → receive login link → click to authenticate
  - No password, no social login
  - Session management
- [ ] Implement platform wallet for Path 3 on-chain recordings (using run402's wallet infrastructure) [code]
  - On-chain recordings indistinguishable from Path 1/2
- [ ] Implement Path 3 dashboard extensions [frontend-logic]
  - Magic link login flow
  - Credit balance display
  - Purchase history view
  - Low-balance indicator
  - Usage statistics (envelopes sent, signatures collected, completion rate — monthly/weekly)
  - Spending history (per-envelope cost, total spend over time)
- [ ] Implement Path 2 wallet onboarding flow on website — guide user through wallet creation and funding [frontend-visual]

### Phase 5: Domain & Branding `AI` / `HUMAN`

- [ ] Design kysigned logo [manual] `AI -> HUMAN: Approve`
- [ ] Define brand assets: colors, typography, tone of voice [manual] `AI -> HUMAN: Approve`
- [ ] Create brand asset files (logo variants, color palette, font files) [frontend-visual] `AI`
- [ ] Configure DNS for kysigned.com [infra] `HUMAN`

### Phase 6: Website — Service Repo `[service]` `AI`

- [ ] Build landing page — cost attack angle lead, no "kill" language, dual CTA (hosted service + GitHub repo) [frontend-visual]
  - Clean minimal design (bld402.com aesthetic)
  - Above-fold: headline, cost comparison, dual CTA
- [ ] Build pricing page — per-envelope cost, credit pack tiers, comparison table vs DocuSign/GoodSign/others [frontend-visual]
- [ ] Build "SaaS vs Repo" decision helper page — tradeoffs for builders, end users, agents [frontend-visual]
- [ ] Build FAQ page — six categories [frontend-visual]:
  - Trust/survival: "What if you shut down?"
  - Migration: "How do I move from DocuSign?"
  - Capability gap: honest comparison vs DocuSign
  - Legal/compliance: "Are blockchain signatures legal?"
  - Pricing/catch: "How is this so cheap?"
  - SaaS vs repo: decision helper with how-to snippets
- [ ] Write how-to snippets for agent-assisted deployment (human-to-agent content layer) [manual] `AI`
- [ ] Create llms.txt at kysigned.com/llms.txt — machine-readable product description [code] `AI`
- [ ] Write README.md for public repo — builder-targeted, "Built on run402" mention, deployment instructions [manual] `AI -> HUMAN: Approve`

### Phase 7: Legal `AI -> HUMAN: Approve`

- [ ] Draft Terms of Service — from existing Kychee/Eleanor/run402 templates. Must state what signatures prove ("someone with access to email X signed") and what they don't guarantee [manual] `AI -> HUMAN: Approve`
- [ ] Draft Privacy Policy [manual] `AI -> HUMAN: Approve`
- [ ] Draft Cookie/consent notice [manual] `AI -> HUMAN: Approve`
- [ ] Draft Acceptable Use Policy [manual] `AI -> HUMAN: Approve`
- [ ] Draft DPA (Data Processing Agreement) [manual] `AI -> HUMAN: Approve`
- [ ] Publish all legal docs on kysigned.com [infra] `AI`
- [ ] Verify LEGAL.md in public repo is approved (from Phase 0) [manual] `HUMAN`

### Phase 8: Analytics & Tracking `AI`

- [ ] Create GA4 property for kysigned.com under Kychee account (account ID 361235691) [infra]
- [ ] Configure measurement ID and data streams [infra]
- [ ] Implement page tags on all kysigned.com pages [code]
- [ ] Configure key events: envelope created, signature completed, envelope completed, credit pack purchased [infra]
- [ ] Configure conversion goals: visitor → envelope creation, visitor → credit purchase, visitor → repo clone [infra]

### Phase 9: Agent Interface `[both]` `AI`

- [ ] Build MCP server exposing: create envelope, check status, list envelopes, verify document [code]
- [ ] Implement x402/MPP authentication in MCP [code]
- [ ] Implement configurable endpoint (default: kysigned.com, overridable for self-hosted) [code]
- [ ] Publish canonical npm package (`kysigned-mcp`) [infra]
- [ ] Write MCP documentation and usage examples [manual] `AI`

### Phase 10: Collateral `AI -> HUMAN: Approve`

- [ ] Generate ad creatives — static images for target segments (freelancers, consultants, agencies, real estate) [manual] `AI -> HUMAN: Approve`
- [ ] Generate video ad (short-form, cost comparison focus) [manual] `AI -> HUMAN: Approve`
- [ ] Generate social media assets (profile images, cover photos, post templates) [manual] `AI -> HUMAN: Approve`
- [ ] Create README hero image / screenshots for public repo [manual] `AI -> HUMAN: Approve`

### Phase 11: Marketing Strategy `DECIDE` / `HUMAN`

- [ ] Write hypothesis card for Freelancers segment [manual] `AI -> HUMAN: Approve`
  - Beachhead: freelancers (2-5 sigs/month)
  - Primary channel, pilot budget ($500+ floor), timeframe (2-4 weeks)
  - Signal metrics, success threshold, kill criteria, next steps
- [ ] Write hypothesis card for Solo Consultants segment [manual] `AI -> HUMAN: Approve`
- [ ] Write hypothesis card for Small Agencies segment [manual] `AI -> HUMAN: Approve`
- [ ] Write hypothesis card for Real Estate Agents segment [manual] `AI -> HUMAN: Approve`
- [ ] Select ONE hypothesis card to execute first [manual] `HUMAN`
- [ ] Determine SaaSpocalypse participation — which channels, what content [manual] `DECIDE`
- [ ] Determine segment hub participation — which hubs (kychee.com/for/freelancers, etc.) [manual] `DECIDE`

### Phase 12: Cross-Linking `AI`

- [ ] Add kysigned to kychee.com portfolio/products page [code]
- [ ] Add "Built on run402" mention with link on kysigned.com [code]
- [ ] Add cross-links to/from bld402 where builder audience is relevant [code]
- [ ] Add cross-links to/from applicable segment hub pages [code]
- [ ] Add cross-links to/from SaaSpocalypse hub (kychee.com/saaspocalypse) [code]
- [ ] Add kysigned to run402.com showcase/examples [code]
- [ ] Add kysigned entry to kychee.com/llms.txt [code]
- [ ] Add kysigned entry to run402.com/llms.txt [code]

### Phase 13: Gas Measurement & Final Pricing `AI` / `DECIDE`

- [ ] Deploy SignatureRegistry.sol to Base mainnet [infra]
- [ ] Measure actual gas costs per operation on mainnet [infra]
- [ ] Calculate true per-envelope cost (gas + email + compute + storage for 30 days) [manual] `AI`
- [ ] Set final per-envelope pricing (~$0.25 target, adjusted by actual costs) [manual] `DECIDE`
- [ ] Set credit pack tiers and per-envelope rates for Path 3 [manual] `DECIDE`
- [ ] Update pricing page with final numbers [frontend-visual] `AI`

### Phase 14: Launch Prep `HUMAN` / `AI`

- [ ] Email deliverability setup — dedicated sending domain, SPF/DKIM/DMARC, warm-up plan [infra] `AI`
- [ ] Flip public repo from private to public on GitHub [manual] `HUMAN`
- [ ] Human review — legal sign-off on all docs [manual] `HUMAN`
- [ ] Human review — collateral approval [manual] `HUMAN`
- [ ] Human review — website copy and design approval [manual] `HUMAN`
- [ ] Human review — pricing approval [manual] `HUMAN`
- [ ] Launch go/no-go decision [manual] `HUMAN`
- [ ] Execute first marketing hypothesis card [manual] `HUMAN`

---

## Implementation Log

_Populated during implementation by `/implement`, AFTER tasks are being executed._

### Gotchas

_None yet_

### Deviations

_None yet_

---

## Log

- 2026-04-04: Plan created from spec v0.1.0 + saas-factory spec v1.3.0
- 2026-04-05: Phase 0 — created repos (kychee-com/kysigned, kychee-com/kysigned-service), cloned locally, workspace file ready
