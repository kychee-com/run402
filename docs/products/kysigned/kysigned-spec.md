---
product: kysigned
version: 0.1.0
status: Draft
type: product
interfaces: [website, api, cli, mcp, smart-contract]
created: 2026-04-04
updated: 2026-04-04
---

## Overview

kysigned is a blockchain-verified e-signature service that replaces DocuSign's subscription model with per-envelope pricing (~$0.25/envelope, pending gas cost validation). Every signature is recorded on Base (Ethereum L2) via a canonical smart contract, creating a permanent, vendor-independent audit trail. Two delivery modes: a hosted API at kysigned.com (`[service]`) and a free MIT-licensed repo deployable on run402 (`[repo]`).

## Interfaces & Mediums

- **Website** `[service]` — kysigned.com. Landing page, signing UI, verification page, dashboard. Clean minimal design (bld402.com as reference, not run402.com).
- **API** `[both]` — RESTful API at `/v1/`. Envelope creation, status, verification, reminders.
- **CLI/MCP** `[both]` — Agent-native interface. Canonical npm package (`kysigned-mcp`) defaults to kysigned.com. Repo forkers get the same CLI/MCP pointing to their own instance.
- **Smart Contract** `[both]` — SignatureRegistry on Base. Single canonical contract address shared by all instances (service and repo deployments). Append-only, publicly queryable.
- **Signing Page** `[both]` — Standalone page rendered per signing request. PDF viewer, signature widget, wallet detection, verification level prompts.
- **Verification Page** `[both]` — Universal verifier at `/verify`. Checks ALL envelopes on the canonical contract, not just those created by the hosting instance.

**Scope tags used throughout this spec:**
- `[both]` — feature exists in the public MIT repo AND the hosted service
- `[service]` — hosted service only (kysigned.com)
- `[repo]` — public MIT repo only

## Features & Requirements

### F1. Envelope Management `[both]`

An envelope is one document (PDF) sent to one or more signers. The envelope is the billing unit.

- F1.1. Create an envelope by providing a PDF (upload or URL) and a list of signers (email + name per signer).
- F1.2. Up to 5 signers included per envelope. Additional signers incur a per-signer surcharge (reflecting real gas costs).
- F1.3. Sender specifies signing order: parallel (default — all signers can sign in any order) or sequential (signers are notified one at a time in the specified order).
- F1.4. Sender can set per-signer options: verification level (1-3, 5 for MVP), `require_wallet` flag.
- F1.5. Envelope lifecycle statuses: draft, active, completed, expired, voided.
- F1.6. Sender can void an active envelope (cancels all pending signing requests, notifies signers).
- F1.7. Envelope expiry: configurable TTL (default TBD, validated against cost). Expired envelopes notify all parties and cannot be signed.
- F1.8. Webhook/callback URL: sender provides a URL that receives a POST when the envelope is completed.
- F1.9. Sender receives a list of individual signing links for each signer, deliverable through any channel (email, WhatsApp, SMS, Slack, etc.) in addition to automatic email delivery.

### F2. Sender Authentication `[both]` / `[service]`

Three sender paths, all MVP. Each serves a different audience.

- F2.1. **Path 1 — Has wallet** `[both]`: Sender authenticates via x402 or MPP payment header. Wallet address is identity. No account, no signup, no API key.
- F2.2. **Path 2 — Creates wallet** `[both]`: Same as Path 1 after wallet onboarding. Website guides user through wallet creation and funding. One-time setup.
- F2.3. **Path 3 — No wallet (prepaid credits)** `[service]`: Sender pays via Stripe for prepaid credit packs. Identity is email address. Authentication via magic link (email-based, no password). Per-envelope cost deducted from credit balance.
- F2.4. Path 3 magic link authentication: user enters email, receives a one-time login link, no password required. No "Sign in with Google" or social login.
- F2.5. Path 3 checkout experience is branded as kysigned (not run402). If run402 payment infrastructure cannot support branded checkout, the service uses its own Stripe integration.
- F2.6. All three paths produce the same on-chain proof. Path 3 uses a platform wallet to make on-chain recordings on the user's behalf. No second-class experience.
- F2.7. Confirm that run402 supports magic link authentication for Path 3 identity. If not, implement as part of kysigned service.

### F3. Signing Experience `[both]`

What happens when a signer receives and acts on a signing request.

- F3.1. Signer receives an email with a one-time signing link. Link expires after the envelope TTL.
- F3.2. Signing page renders the PDF with signature fields highlighted.
- F3.3. Signing page detects browser wallet (MetaMask, Coinbase Wallet, etc.). If wallet detected, offers both Method A and Method B. If no wallet, shows Method A only. If `require_wallet` is set for this signer, shows Method B only.
- F3.4. **Signature visual mode (sender chooses per envelope):**
  - `require_drawn_signature: false` (default) — signer clicks "Sign this document" in one click. Auto-stamp embedded in PDF: signer's name rendered in a handwriting-style font + crypto verification details (method, timestamp, chain). Fastest possible UX.
  - `require_drawn_signature: true` — signer gets a drawing/typing widget to create a handwritten signature. Signer confirms the signature before it is applied. Applies to both Method A and Method B signers.
- F3.5. **Signature persistence:** After a signer draws a signature, the browser offers "Save this signature for future use?" If accepted, the signature image is stored in cookie/localStorage. On subsequent signing requests (same browser), the signer is offered "Use saved signature?" with an option to redraw. Saved signatures are never transmitted to the server until used in an actual signing event.
- F3.6. **Method A (email-based signing):** Signer completes the signature step (one-click auto-stamp or drawn, per F3.4). Browser generates an ephemeral Ed25519 keypair client-side (private key never transmitted). Browser signs `hash(document_hash + email + timestamp)`. Server records salted commitment hash on-chain. Signer never sees or touches crypto.
- F3.7. Method A key generation uses native Web Crypto API (Ed25519) with feature detection. If the browser does not support Ed25519 in Web Crypto, falls back to tweetnacl.js (pure JavaScript library). Detection and fallback are invisible to the signer.
- F3.8. **Method B (wallet signing via EIP-712):** Signer completes the signature step (one-click auto-stamp or drawn, per F3.4), then clicks "Sign with wallet." Page calls `eth_signTypedData_v4` with a DocumentSignature struct. Signer's own wallet displays human-readable signing details (document name, hash, email, envelope ID, timestamp). Server records signer's Ethereum address on-chain via `ecrecover`.
- F3.9. **Verification levels (MVP):**
  - Level 1: Email link only (low-stakes internal approvals)
  - Level 2: Email + type email confirmation (default for most contracts)
  - Level 5: Wallet signature via EIP-712 (strongest proof, requires signer wallet)
- F3.10. **Level 3 (SMS/WhatsApp code) is post-MVP.** Will be built as a run402 platform messaging service (likely AWS SNS). Until then, senders can achieve multi-channel verification manually by delivering signing links via their own SMS/WhatsApp/Slack.
- F3.11. **Level 4 (government ID verification)** is post-MVP. The verification level system accommodates it. Implementation requires integration with a third-party identity verification service (to be selected after comparative review), exposed via run402 as a paid service.
- F3.12. After signing, server embeds the visual signature (auto-stamp or drawn) into the PDF and sends a confirmation email to the signer.
- F3.13. Signer can decline to sign. Sender is notified of the decline.
- F3.14. Duplicate signing protection: if a signer who has already signed clicks a signing link again (same or different channel), they see a "You've already signed this document" message. No double-signing is possible.

### F4. On-Chain Recording `[both]`

Every signature event is recorded on the SignatureRegistry smart contract on Base.

- F4.1. One canonical SignatureRegistry contract deployed on Base. All instances (service and repo deployments) record to the same contract by default.
- F4.2. Contract address is a constant in the repo code. Forkers can change it but have no incentive to (gas economics prevent spam, shared registry strengthens verification).
- F4.3. **Method A recording:** `recordEmailSignature(envelopeId, documentHash, signerCommitment, signerPubkey, signature)`. The `signerCommitment` is `hash(email + documentHash + salt)` — email is never on-chain.
- F4.4. **Method B recording:** `recordWalletSignature(envelopeId, documentHash, documentName, signerEmail, timestamp, signature)`. Contract recovers signer address via `ecrecover`. Signer's Ethereum address is on-chain (public by design — signer opted in).
- F4.5. **Completion recording:** `recordCompletion(envelopeId, originalDocHash, finalDocHash, signerCount)`. Fires when all signers have signed.
- F4.6. Mixed methods per envelope: some signers can use Method A, others Method B, within the same envelope.
- F4.7. Contract is append-only. No entry can be modified or deleted by anyone, including the contract deployer.
- F4.8. Contract is replaceable: new envelopes can be directed to a new contract at any time. Old envelopes remain verifiable at the old contract address forever. The verification page checks all known contract addresses.
- F4.9. Contract ABI and verification algorithm are published and documented from day 1. Anyone can verify signatures independently without kysigned.com.

### F5. Verification `[both]`

Public, universal, vendor-independent signature verification.

- F5.1. Verification page at `/verify` accepts a PDF upload, computes its SHA-256 hash, and queries the canonical contract(s) for matching signature events.
- F5.2. Verification page is **universal**: it verifies ANY envelope recorded on the canonical contract, regardless of which instance (kysigned.com, acme-sign.com, etc.) created it.
- F5.3. Verification results display: number of signers, signing dates, signing methods used. For Method B signers: wallet addresses. For Method A signers: "N email-verified signatures" (no identity revealed).
- F5.4. **Owner verification (dashboard):** Full audit trail per signer — email, method used, timestamp, IP, user agent, tx hash. For Method B: signer's Ethereum address.
- F5.5. **Certificate of Completion:** Generated on envelope completion. Includes: document name, document hash, all signer details, signing timestamps, tx hashes, contract address. This certificate enables third-party verification (court, auditor) against the blockchain without needing kysigned.com.
- F5.6. Third-party verification: anyone with a signed PDF and its Certificate of Completion can independently verify against the blockchain. No dependency on any kysigned instance being online.

### F6. Dashboard `[both]` basic / `[service]` enhanced

Envelope management and account overview.

- F6.1. `[both]` Envelope list with status, signer progress, creation date, completion date.
- F6.2. `[both]` Per-envelope detail view: audit trail, signer statuses, tx hashes, links to on-chain records.
- F6.3. `[both]` Resend signing request / send reminder to pending signers.
- F6.4. `[both]` Export envelope data (CSV or JSON).
- F6.5. `[both]` **Path 1/2 dashboard access:** connect wallet to authenticate. Dashboard shows all envelopes sent from that wallet address.
- F6.6. `[service]` **Path 3 dashboard access:** magic link login via email. Dashboard shows all envelopes associated with that email.
- F6.7. `[service]` Credit balance display, purchase history, low-balance indicator.
- F6.8. `[service]` Usage statistics: envelopes sent (monthly/weekly), signatures collected, completion rate.
- F6.9. `[service]` Spending history: per-envelope cost breakdown, total spend over time.

### F7. Email & Link Delivery `[both]`

Notifications and multi-channel signing link distribution.

- F7.1. Signing request email sent to each signer with a one-time link. Email includes document name, sender name, and a message from the sender.
- F7.2. Automated reminders at configurable intervals (default: 3 days, 7 days after initial send). Sender can trigger manual reminders.
- F7.3. Confirmation email sent to signer after successful signing.
- F7.4. Completion email sent to all parties (sender + all signers) with the signed PDF and Certificate of Completion attached.
- F7.5. Sender receives a list of all signing links immediately after envelope creation. These links can be delivered through any channel independently of the email system.
- F7.6. Notice to senders: prompt to contact signers and check spam if signing requests are not received. Displayed in dashboard and in API response.
- F7.7. `[service]` Email sent from a dedicated kysigned.com sending domain with SPF/DKIM/DMARC configured.
- F7.8. `[repo]` Email sending is configurable: use run402 email service (paid) or plug in own provider (SendGrid, SES, etc.).

### F8. PDF Handling `[both]`

Document processing with no persistent storage in MVP.

- F8.1. Accept PDF upload (base64 in API body or URL reference).
- F8.2. Compute `SHA-256(pdf_bytes)` as the canonical document hash.
- F8.3. Render PDF in browser on the signing page using pdf.js.
- F8.4. Embed visual signature images into the PDF after each signer signs (server-side, using pdf-lib or equivalent).
- F8.5. Generate final signed PDF with all signatures embedded on envelope completion.
- F8.6. **No persistent document storage in MVP.** PDFs are retained for a configurable period (default 30 days, validated against storage costs) after envelope completion, then permanently deleted.
- F8.7. Users are clearly notified of the retention policy: at envelope creation, at completion (in the completion email), and with a reminder before deletion.
- F8.8. After deletion, only metadata persists: document name, document hash, signer statuses, tx hashes, timestamps. The on-chain hash remains forever.
- F8.9. Future feature: paid document retention (user pays for extended storage at a per-GB/year rate). Not in MVP scope.
- F8.10. Multi-signature PDFs (multiple signature fields per page or per section) are post-MVP. MVP supports one set of signature fields per signer per document.

### F9. Prepaid Credits `[service]`

Pay-as-you-go billing for Path 3 (no wallet) users.

- F9.1. Credit packs purchasable via Stripe: multiple tiers (e.g., $5, $10, $20). Exact tiers and per-envelope rates set after gas cost measurement.
- F9.2. Per-envelope cost deducted from credit balance on envelope creation.
- F9.3. Credit balance visible in dashboard at all times.
- F9.4. Purchase history viewable in dashboard.
- F9.5. Low-balance alert when credits fall below a threshold (e.g., fewer than 5 envelopes remaining).
- F9.6. Credits do not expire.
- F9.7. Checkout experience is branded as kysigned.
- F9.8. **run402 dependency:** Prepaid credit/paycard model requires run402 platform support (buy credits, deduct per API call). If run402 does not currently support this, it must be implemented as a run402 feature or kysigned service uses its own Stripe integration as fallback.

### F10. CLI / MCP `[both]`

Agent-native interface for programmatic signing.

- F10.1. MCP server exposing core signing operations: create envelope, check status, list envelopes, verify document.
- F10.2. Canonical npm package (`kysigned-mcp` or similar) defaults to kysigned.com endpoint.
- F10.3. Repo includes the same MCP server, configurable to point to any instance.
- F10.4. Agents authenticate via x402 or MPP payment header (Path 1/2). No API keys required.
- F10.5. Agent can discover kysigned via llms.txt on kysigned.com.

### F11. Website `[service]`

Marketing site and product pages at kysigned.com.

- F11.1. Landing page led by the cost attack angle ("DocuSign charges $3-5 per signature. kysigned charges ~$0.25. Proof on the blockchain, not their servers."). No "kill" language.
- F11.2. Dual CTA: "Send a document" (hosted service) and "Deploy your own" (GitHub repo).
- F11.3. "SaaS vs Repo" decision helper explaining the tradeoffs for each delivery mode.
- F11.4. Pricing page showing per-envelope costs, credit pack tiers, and a comparison table vs DocuSign/GoodSign/others.
- F11.5. **FAQ as conversion weapon** — six categories:
  - Trust/survival: "What if you shut down?" → "Your proofs are on the blockchain. They survive us."
  - Migration: "How do I move from DocuSign?" → envelope-by-envelope, no lock-in.
  - Capability gap: honest comparison of what kysigned does and does not do vs DocuSign.
  - Legal/compliance: "Are blockchain signatures legal?" → ESIGN Act, UETA, state statutes.
  - Pricing/catch: "How is this so cheap?" → you pay for infrastructure, not subscription overhead.
  - SaaS vs repo: decision helper with how-to snippets for agent-assisted deployment.
- F11.6. **Three content layers:**
  - FAQ — human-readable, conversion-focused
  - How-to snippets — copyable prompts for humans using AI agents
  - llms.txt — machine-readable product description for agent discovery
- F11.7. Clean, minimal design following bld402.com aesthetic. Not crowded.

### F12. Legal `[service]` + `[repo]`

- F12.1. `[service]` **Terms of Service** — drafted from existing Kychee/Eleanor/run402 templates. Must precisely state what signatures prove: "someone with access to email X signed the document," not "person X signed." Requires human approval before launch.
- F12.2. `[service]` **Privacy Policy** — drafted from templates. Requires human approval.
- F12.3. `[service]` **Cookie/consent notice** — drafted from templates. Requires human approval.
- F12.4. `[service]` **Acceptable Use Policy** — drafted from templates. Requires human approval.
- F12.5. `[service]` **DPA (Data Processing Agreement)** — drafted from templates. Requires human approval.
- F12.6. `[repo]` **LICENSE** — MIT license covering the code.
- F12.7. `[repo]` **LEGAL.md** — disclaimers separate from the MIT license:
  - What signatures prove and don't prove (evidentiary value, not guaranteed legal enforceability)
  - No guarantee of legal enforceability in any specific jurisdiction
  - Smart contract permanence disclaimer (recordings on Base are permanent, cannot be deleted or modified by anyone)
  - Operator responsibility: the forker/deployer is responsible for their own privacy compliance, Terms of Service, and legal obligations — not Kychee
  - Excluded document types that cannot be e-signed under ESIGN/UETA (wills, codicils, etc.)
- F12.8. No product launch until all `[service]` legal documents are human-approved.

### F13. Cross-Linking `[service]`

Per the SaaS Factory spec (Chapter 10).

- F13.1. Listed on kychee.com portfolio/products page.
- F13.2. "Built on run402" mention with link on kysigned.com.
- F13.3. Cross-linked to/from bld402 where builder audience is relevant.
- F13.4. Cross-linked to/from applicable segment hub pages (kychee.com/for/freelancers, etc.).
- F13.5. Cross-linked to/from SaaSpocalypse hub (kychee.com/saaspocalypse).
- F13.6. Added to run402.com showcase/examples.
- F13.7. Added to kychee.com/llms.txt (central agent-discovery directory).
- F13.8. Added to run402.com/llms.txt (central agent-discovery directory).

### F14. Analytics `[service]`

Per the SaaS Factory spec (Chapter 6).

- F14.1. GA4 property created under Kychee account (account ID 361235691) for kysigned.com.
- F14.2. Key events tracked: envelope created, signature completed, envelope completed, credit pack purchased, repo fork/clone (via GitHub).
- F14.3. Conversion goals: visitor → envelope creation, visitor → credit purchase, visitor → repo clone.

## Acceptance Criteria

### F1. Envelope Management
- [ ] Sender creates an envelope with a PDF and 1-5 signers; receives envelope_id, status_url, verify_url, and individual signing links per signer
- [ ] Envelope with 6+ signers applies a per-signer surcharge beyond 5
- [ ] Parallel signing: all signers receive signing links simultaneously and can sign in any order
- [ ] Sequential signing: signers are notified one at a time; next signer is notified only after previous signer completes
- [ ] Sender voids an active envelope; all pending signers receive a cancellation notice; no further signing is possible
- [ ] Expired envelope returns "expired" status; pending signers are notified; signing links no longer work
- [ ] Webhook URL receives a POST with envelope completion data when all signers have signed
- [ ] API response includes a list of individual signing links per signer for manual distribution

### F2. Sender Authentication
- [ ] Path 1: API call with x402 payment header succeeds; wallet address recorded as sender identity; no account or API key required
- [ ] Path 1: API call with MPP payment header succeeds identically to x402
- [ ] Path 2: Website guides user through wallet creation; after wallet setup, user can send envelopes via Path 1
- [ ] Path 3: User purchases credit pack via Stripe; checkout page is branded as kysigned; credits appear in dashboard
- [ ] Path 3: Magic link login — user enters email, receives login link, clicks to authenticate. No password field. No social login.
- [ ] Path 3: Envelope creation deducts from credit balance; fails with clear error if balance insufficient
- [ ] Path 3: On-chain recording made via platform wallet is indistinguishable from Path 1/2 recording in verification results

### F3. Signing Experience
- [ ] Signer clicks email link; signing page renders PDF with signature fields highlighted
- [ ] Browser with wallet: signing page shows both Method A and Method B options
- [ ] Browser without wallet: signing page shows Method A only
- [ ] Signer with `require_wallet: true`: signing page shows Method B only; Method A is not available
- [ ] Default mode (`require_drawn_signature: false`): signer clicks "Sign this document"; auto-stamp with handwriting-font name + crypto details embedded in PDF; no drawing widget shown
- [ ] Drawn mode (`require_drawn_signature: true`): signer draws/types signature in widget; confirms before applying; works for both Method A and Method B
- [ ] Signature persistence: after drawing, signer offered "Save for future use?"; saved in cookie/localStorage; on next signing, offered "Use saved signature?" with redraw option
- [ ] Method A: Ed25519 keypair generated client-side; signature recorded on-chain with salted commitment hash; signer never sees crypto terminology
- [ ] Method A: Ed25519 via Web Crypto API succeeds on supported browsers; falls back to tweetnacl.js on unsupported browsers; signer sees no difference
- [ ] Method B: signer completes signature step (auto-stamp or drawn), then wallet displays human-readable DocumentSignature struct; signer approves; Ethereum address recorded on-chain
- [ ] Level 1: signing completes with email link click only
- [ ] Level 2: signer must type their email as confirmation before signing completes
- [ ] Level 5: signing completes only via EIP-712 wallet signature
- [ ] Signer who has already signed clicks signing link again (any channel): sees "You've already signed this document" message; no duplicate recording
- [ ] Signer declines: sender is notified; signer status updated to "declined"

### F4. On-Chain Recording
- [ ] Method A signature event recorded on canonical SignatureRegistry contract on Base with correct envelopeId, documentHash, signerCommitment, signerPubkey, and signature
- [ ] Method B signature event recorded on canonical contract with signer address recovered correctly via ecrecover
- [ ] Completion event recorded when all signers have signed, with correct originalDocHash, finalDocHash, and signerCount
- [ ] Mixed-method envelope: some signers use Method A, others Method B; all recorded correctly; completion event fires after all sign
- [ ] No entry on the contract can be modified or deleted after recording
- [ ] Contract replacement: new envelopes can be directed to a new contract; old envelopes remain verifiable at old contract address

### F5. Verification
- [ ] Upload a previously signed PDF to `/verify`; page displays correct signer count, dates, and methods
- [ ] Verification page on instance X correctly verifies an envelope created by instance Y (universal verification)
- [ ] Method B signers: wallet addresses displayed in verification results
- [ ] Method A signers: only "email-verified signature" shown; no identity revealed
- [ ] Certificate of Completion includes document hash, signer details, tx hashes, and contract address
- [ ] Third party with only the signed PDF and Certificate can verify against the blockchain without any kysigned instance online

### F6. Dashboard
- [ ] Path 1/2: connect wallet; dashboard displays all envelopes sent from that wallet
- [ ] Path 3: magic link login; dashboard displays all envelopes associated with that email
- [ ] Envelope list shows status, signer progress, dates for each envelope
- [ ] Per-envelope detail view shows full audit trail per signer (email, method, timestamp, IP, user agent, tx hash)
- [ ] Resend/remind button sends a new notification to pending signers
- [ ] Export envelopes as CSV or JSON
- [ ] `[service]` Credit balance, purchase history, and low-balance indicator visible for Path 3 users
- [ ] `[service]` Usage statistics displayed: envelopes sent, signatures collected, completion rate (monthly/weekly)
- [ ] `[service]` Spending history displayed: per-envelope cost, total spend over time

### F7. Email & Link Delivery
- [ ] Signing request email received by signer within 60 seconds of envelope creation; contains document name, sender name, message, and signing link
- [ ] Automated reminder sent at configured intervals (default 3 days, 7 days)
- [ ] Manual reminder triggered by sender; signer receives new notification
- [ ] Completion email sent to all parties with signed PDF and Certificate of Completion attached
- [ ] Signing link list returned in API response; links work regardless of delivery channel
- [ ] Spam notice displayed to sender in dashboard after envelope creation
- [ ] `[service]` Emails sent from dedicated kysigned.com domain with SPF/DKIM/DMARC
- [ ] `[repo]` Email provider is configurable (run402 email service or custom SMTP/API)

### F8. PDF Handling
- [ ] PDF uploaded via API (base64 or URL); SHA-256 hash computed and returned in response
- [ ] Signing page renders PDF correctly in browser via pdf.js
- [ ] Visual signature embedded into PDF after each signer signs
- [ ] Final signed PDF generated with all signatures on envelope completion
- [ ] PDF deleted after retention period (default 30 days); only metadata and on-chain hash persist
- [ ] User notified of retention policy at envelope creation, in completion email, and before deletion
- [ ] After PDF deletion, envelope metadata (name, hash, statuses, tx hashes) remains accessible in dashboard

### F9. Prepaid Credits
- [ ] Credit pack purchase via Stripe completes; credits appear in user's balance immediately
- [ ] Per-envelope deduction on envelope creation; balance decreases by correct amount
- [ ] Insufficient balance prevents envelope creation with clear error message
- [ ] Credits do not expire
- [ ] Low-balance alert shown when fewer than 5 envelopes worth of credits remain
- [ ] Purchase history lists all transactions with dates and amounts

### F10. CLI / MCP
- [ ] `kysigned-mcp` installable via npx; connects to kysigned.com by default
- [ ] Agent creates envelope via MCP with x402 payment; receives envelope_id and signing links
- [ ] Agent checks envelope status via MCP; receives current signer statuses
- [ ] Agent verifies a document via MCP; receives verification results
- [ ] MCP endpoint configurable to point to any kysigned instance (self-hosted or hosted)
- [ ] kysigned.com/llms.txt exists and describes the product for agent discovery

### F11. Website
- [ ] Landing page loads at kysigned.com; leads with cost comparison, not blockchain jargon
- [ ] No "kill," "killer," or "killing" language appears anywhere on the site
- [ ] Dual CTA visible above fold: hosted service and GitHub repo
- [ ] Decision helper page explains SaaS vs repo tradeoffs for builders, end users, and agents
- [ ] Pricing page shows per-envelope cost, credit pack tiers, and comparison table vs competitors
- [ ] FAQ covers all six categories with specific questions and answers
- [ ] llms.txt accessible at kysigned.com/llms.txt
- [ ] Design is clean and minimal (bld402.com aesthetic)

### F12. Legal
- [ ] `[service]` ToS, Privacy Policy, Cookie notice, AUP, and DPA are published on kysigned.com
- [ ] `[service]` ToS explicitly states what signatures prove ("someone with access to email X signed") and what they do not guarantee
- [ ] `[service]` No launch until all legal documents are human-approved
- [ ] `[repo]` MIT LICENSE file present in repo root
- [ ] `[repo]` LEGAL.md present with disclaimers: signature validity, jurisdictional limitations, smart contract permanence, operator responsibility, excluded document types

### F13. Cross-Linking
- [ ] kysigned listed on kychee.com portfolio page
- [ ] "Built on run402" with link appears on kysigned.com
- [ ] Cross-links to/from bld402, segment hubs, SaaSpocalypse hub, run402.com showcase are live
- [ ] kysigned entry added to kychee.com/llms.txt and run402.com/llms.txt

### F14. Analytics
- [ ] GA4 property active for kysigned.com under Kychee account
- [ ] Key events firing: envelope created, signature completed, envelope completed, credit purchased
- [ ] Conversion goals configured: visitor → envelope, visitor → credit purchase, visitor → repo clone

## Constraints & Dependencies

- **run402 platform:** kysigned runs on run402 infrastructure. The prepaid credit/paycard model (buy credits, deduct per API call) may require new run402 platform capabilities. If not available, kysigned service falls back to its own Stripe integration.
- **run402 magic link auth:** Path 3 requires magic link authentication. Must confirm run402 supports this; if not, implement within kysigned service.
- **run402 email service:** Repo forkers rely on run402 email service (paid) or bring their own. Email deliverability reputation is critical — signing requests in spam is product-killing.
- **run402 custom domains:** Repo forkers can use subdomains (acme-sign.run402.com) or custom domains (acme-sign.com). Must confirm run402 supports custom domain mapping.
- **Base gas costs:** Final per-envelope pricing depends on measured gas costs for SignatureRegistry operations on Base. Pricing (~$0.25/envelope) is a starting assumption pending validation.
- **Smart contract deployment:** SignatureRegistry.sol must be deployed on Base mainnet before any production signing. Contract is immutable once deployed.
- **Existing legal templates:** Legal documents drafted from existing Kychee/Eleanor/run402 templates. All `[service]` legal docs require human approval.
- **Third-party ID verification (Level 4):** Post-MVP. Requires integration with an identity verification provider (Jumio, Onfido, etc.) via run402 as a paid service. Comparative review needed before selection.
- **No "kill" language:** All public-facing materials use "alternative to," "replace," "switch from," "better than." Internal docs may use competitive framing.

## Open Questions

1. **Exact gas costs on Base** — deploy SignatureRegistry.sol on Base testnet/mainnet and measure per-signature and per-completion costs. Final pricing depends on this.
2. **Envelope expiry default** — 30 days assumed, must validate against storage costs. What is the notification sequence before deletion (e.g., 7 days before, 1 day before)?
3. **PDF retention cost model** — future paid retention feature: what per-GB/year rate is sustainable? What tiers?
4. **Multi-signature PDFs** — post-MVP. UX and hash structure for per-page/per-section signatures needs design.
5. **Second-channel verification** — generating a second signing link deliverable via any channel as independent proof. Priority and scope TBD. (Note: F1.9 already provides manual signing links; this is about formalizing it as a verification level.)
6. **run402 prepaid credit model** — does run402 currently support buy-credits-and-deduct-per-call billing? If not, scope of platform work needed.
7. **run402 magic link auth** — does run402 support magic link (email-only, no password) authentication? If not, kysigned implements its own.
8. **run402 custom domain mapping** — confirm forkers can map custom domains to their run402-hosted instances.
9. **Email deliverability strategy** — dedicated sending domain, IP warm-up plan, deliverability monitoring for the service.
10. **Certificate of Completion design** — what do courts/auditors expect to see? Research needed.
11. **Contract naming** — should SignatureRegistry.sol be named independently of kysigned (for protocol neutrality)?
13. **Platform wallet security** — key management strategy for the server-side wallet that makes Path 3 on-chain recordings.
14. **Credit pack tiers and pricing** — optimize for conversion vs margin after gas costs are known.
15. **Mobile wallet signing UX** — does `eth_signTypedData_v4` work reliably in mobile wallet browsers?
17. **Future: run402 payment collection for server builders** — could run402 offer Stripe-based payment collection so repo forkers can charge their own users? Not kysigned scope, but a platform idea that benefits all SaaS-alternative products.
