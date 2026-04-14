---
product: kysigned
version: 0.12.1
status: Draft
type: product
interfaces: [website, api, cli, mcp, smart-contract]
created: 2026-04-04
updated: 2026-04-14
---

## Overview

kysigned is a blockchain-verified e-signature service that replaces DocuSign's subscription model with per-envelope pricing ($0.29/envelope for 2 signers, $0.10/extra signer). Signers sign by replying to an email with `I APPROVE` — their mail provider's DKIM signature provides cryptographic proof of mailbox control, which is captured as a zk proof via **RISC Zero zkVM** (STARK inner proof + Groth16 wrapper for EVM verification) and recorded on Base (Ethereum L2). The DKIM verification runs as a Rust guest program inside the RISC Zero zkVM; the inner STARK proof is math-only (no trusted setup), and only the Groth16 compression wrapper relies on RISC Zero's 238-contributor public ceremony (PSE/EF coordinated). A verifier given `(email, document)` any time in the next ~20 years can independently confirm the signature using only on-chain data (the zk proof, the archived DKIM key, and key consistency across signatures from the same provider) — no dependency on kysigned.com, run402, or any operator being reachable. Two delivery modes: a hosted API at kysigned.com (`[service]`) and a free MIT-licensed repo deployable on run402 (`[repo]`).

## Interfaces & Mediums

- **Website** `[service]` — kysigned.com. Landing page, "how it works" page, verification page, dashboard. Clean minimal design (bld402.com as reference, not run402.com).
- **API** `[both]` — RESTful API at `/v1/`. Envelope creation, status, verification, reminders.
- **CLI/MCP** `[both]` — Agent-native interface. Canonical npm package (`kysigned-mcp`) defaults to kysigned.com. Repo forkers get the same CLI/MCP pointing to their own instance.
- **Smart Contracts** `[both]` — `SignatureRegistry` and `EvidenceKeyRegistry` on Base. Canonical contract addresses shared by all instances (service and repo deployments). Append-only, publicly queryable, permissionless writes (zk-proof-gated), no owner/admin.
- **Review Page** `[both]` — Standalone page rendered per signing request. PDF viewer showing the document the signer is being asked to sign. Read-only; signing itself happens via email reply, not via this page.
- **Verification Page** `[both]` — Universal verifier at `/verify`. Accepts `(email, document)` as inputs, computes `searchKey`, and checks ALL records on the canonical contracts regardless of which instance created them.

**Scope tags used throughout this spec:**
- `[both]` — feature exists in the public MIT repo AND the hosted service
- `[service]` — hosted service only (kysigned.com)
- `[repo]` — public MIT repo only

## Shipping Surfaces

Per saas-factory F21. Each row is a user-reachable artifact. Smoke checks are NOT version-pinned — they prove the latest published artifact is reachable from outside the repo. Each surface gets a `[ship]` task in the plan's `Ship & Verify` phase.

| Name | Type | Reach | Smoke check |
|------|------|-------|-------------|
| Marketing site | url | `https://kysigned.com` | `curl -fsSL https://kysigned.com/ \| grep -q kysigned` |
| How it works page | url | `https://kysigned.com/how-it-works` | `curl -fsSL https://kysigned.com/how-it-works \| grep -q "how"` |
| llms.txt | url | `https://kysigned.com/llms.txt` | `curl -fsSL https://kysigned.com/llms.txt \| grep -q '^# kysigned'` |
| REST API | service | `https://kysigned.com/v1/` | `curl -fsSL https://kysigned.com/v1/health` |
| Verification page | url | `https://kysigned.com/verify` | `curl -fsSL https://kysigned.com/verify \| grep -q "Verify"` |
| Dashboard | url | `https://kysigned.com/dashboard` | `curl -fsSL -o /dev/null -w '%{http_code}' https://kysigned.com/dashboard \| grep -q '^200$'` |
| MCP server (npm) | npm | `npx -y kysigned-mcp` | `npx -y kysigned-mcp --version` |
| Public repo (open source release) | url | `https://github.com/kychee-com/kysigned` | `curl -fsSL https://api.github.com/repos/kychee-com/kysigned \| grep -q '"private":\s*false'` |
| SignatureRegistry — Base mainnet | other | `0x<TBD-after-mainnet-deploy>` | `curl -fsSL -X POST https://mainnet.base.org -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"eth_call","params":[{"to":"0x<TBD>","data":"0x3644e515"},"latest"]}' \| grep -q '"result":"0x[0-9a-f]\{64\}"'` |
| EvidenceKeyRegistry — Base mainnet | other | `0x<TBD-after-mainnet-deploy>` | `curl -fsSL -X POST https://mainnet.base.org -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"eth_call","params":[{"to":"0x<TBD>","data":"0x3644e515"},"latest"]}' \| grep -q '"result":"0x[0-9a-f]\{64\}"'` |

**Notes:**
- Mainnet contract addresses are `<TBD>` until Phase 13 deployment. The smoke check rows are updated once addresses are known.
- **The mainnet contract deploy is gated by the F17 dark-launch canary discipline.** The production contracts MUST NOT be deployed until the canary phase has completed its checklist and a human has explicitly approved the flip. See F17 for the full ritual.
- The previous `SignatureRegistry` on Base Sepolia (`0xAE8b6702e413c6204b544D8Ff3C94852B2016c91`) is obsolete — it used the pre-rework Method A interface. New Sepolia deployments will be created for the rewritten contracts.
- Email DKIM/SPF/DMARC for `kysigned.com` is verified as part of the marketing site `[ship]` task (deliverability check via SES verified-identities + a test send to a Kychee inbox).
- Inbound email at `reply-to-sign@kysigned.com` (or `reply-to-sign@mail.run402.com` for MVP if custom-domain inbound is not yet available) is verified as part of the signing-flow smoke test.
- Custom domain serving (`kysigned.com`) is verified as part of the marketing site smoke check — if the curl resolves and returns content, the DNS + Cloudflare/CloudFront wiring is working.

## Features & Requirements

### F1. Envelope Management `[both]`

An envelope is one document (PDF) sent to one or more signers. The envelope is the billing unit.

- F1.1. Create an envelope by providing a PDF (upload or URL) and a list of signers (email + name per signer).
- F1.2. Base price includes up to 2 signers per envelope ($0.29). Additional signers cost $0.10 each (reflecting real gas + proof generation costs). No upper limit on signer count.
- F1.3. Sender specifies signing order: parallel (default — all signers can sign in any order) or sequential (signers are notified one at a time in the specified order).
- F1.4. All signers use the same signing method (reply-to-sign email). No per-signer signing options in MVP.
- F1.5. Envelope lifecycle statuses: draft, active, completed, expired, voided.
- F1.6. Sender can void an active envelope (cancels all pending signing requests, notifies signers).
- F1.7. Envelope expiry: configurable TTL (default TBD, validated against cost). Expired envelopes notify all parties and cannot be signed.
- F1.8. Webhook/callback URL: sender provides a URL that receives a POST when the envelope is completed.
- F1.9. `[both]` Signing is email-reply-based: each signer receives a signing email and signs by replying with `I APPROVE`. The operator delivers the signing email; there are no separate "signing links" for the reply-to-sign method. A review link (read-only document preview) is included in the signing email and can be shared via any channel, but the signing act itself requires an email reply from the signer's real mailbox.
- F1.10. **Sender as signer:** If the sender also needs to sign the document, they must add themselves to the signer list. There is no "pre-sign at creation" flow. The sender signs through the same process as every other signer (same link, same verification, same on-chain proof). This ensures a uniform audit trail — every signature event is identical regardless of who initiated the envelope. The UI should make this clear: when creating an envelope, prompt "Will you also sign this document?" and auto-add the sender to the signer list if yes.

### F2. Sender Authentication & Access Control `[both]` / `[service]`

**Context — T1 vs T2 payments:**
- **T1 (operator → run402):** Every kysigned deployment (hosted or forked) pays run402 for infrastructure (compute, email, KMS wallets, gas). This is handled by run402's billing ledger. The operator's wallet is their identity for T1.
- **T2 (end-user → operator):** run402 does not yet provide a billing layer that lets apps charge their users. For the hosted service (kysigned.com), kysigned operates its own Stripe integration to sell prepaid credit packs to end users. Forkers do not get built-in T2 billing — they gate access via `allowed_senders` (F2.8) and absorb infrastructure costs themselves. If a forker wants to charge their users, they must build their own billing layer on top.

#### F2.1 Hosted Service Billing (kysigned.com) `[service]`

- F2.1.1. **Prepaid credits via Stripe.** Sender pays via Stripe for prepaid credit packs. Identity is email address. Authentication via magic link (email-based, no password). Per-envelope cost deducted from credit balance. **Kychee is the merchant of record.** kysigned operates its own Stripe account under the Kychee Stripe organization — this is NOT run402's billing.
- F2.1.2. **Magic link authentication:** user enters email, receives a one-time login link, no password required. No "Sign in with Google" or social login.
- F2.1.3. **Checkout experience is branded as kysigned** (not run402). kysigned uses its own Stripe product/price configuration under the Kychee Stripe account.
- F2.1.4. **On-chain recording via platform wallet.** Regardless of how the sender pays, the kysigned server submits all on-chain transactions using a **platform wallet** (KMS-backed, provisioned via run402). Signers sign asynchronously (hours or days after envelope creation), so the server must submit on everyone's behalf.
- F2.1.5. Confirm that run402 supports magic link authentication. If not, implement as part of kysigned service.

#### F2.9 Money Flow (revenue in, costs out)

**Revenue (fiat → kysigned):**
- `[service]` Sender pays fiat to kysigned's own Stripe account. Funds settle to Kychee's bank account. Credit balance is tracked in the kysigned database and deducted per envelope. **Kychee is the merchant of record.** run402 does NOT act as a Stripe intermediary.

**Costs (kysigned → run402 + Base blockchain):**
- The kysigned platform wallet pays ETH gas for each contract call (`recordReplyToSignSignature`, `recordCompletion`, and occasional `registerEvidenceKey`). The platform wallet holds ETH for gas. kysigned tops up ETH as needed.
- Per-envelope gas cost: ~$0.01-0.20 at typical Base gas prices (varies with zk-proof size and gas price fluctuations).

**What run402 charges kysigned for (T1 — infrastructure):**
- Compute and database hosting
- Email sending (SES via run402)
- **KMS contract wallet rental: $0.04/day per wallet ($1.20/month).** Platform wallet provisioned via `POST /contracts/v1/wallets`. Private keys never leave AWS KMS. Includes lifecycle management (suspension on unpaid rent, optional recovery address, drain endpoint). 30-day prepay ($1.20) required at creation.
- **Contract call KMS sign fee: $0.000005 per call** (the only run402 markup on contract calls). Chain gas is at-cost — kysigned still pays its own ETH gas to Base, billed as a `contract_call_gas` ledger entry with 0% markup.
- Custom domain serving

**What run402 does NOT currently provide (T2 — end-user billing):**
- Stripe-collection-as-a-service: run402 does not accept Stripe payments from kysigned's end users on kysigned's behalf. kysigned operates its own Stripe account. If run402 adds T2 billing capability post-MVP, kysigned could migrate to it (Open Question #17).

**Pricing model:**
- **$0.29 per envelope** (includes up to 2 signers)
- **$0.10 per additional signer** beyond 2
- Example: 5-signer envelope = $0.29 + (3 × $0.10) = $0.59

**Per-signer cost breakdown (RISC Zero zkVM — STARK + Groth16 wrapper on Base L2):**
- Gas (`recordReplyToSignSignature` with Groth16 verify): ~$0.02 (~280k gas on Base)
- Proof generation (RISC Zero STARK proving, ~3 min on 8.4 GB instance): ~$0.005
- Groth16 wrapping (compression for EVM, ~30-60s): ~$0.002
- Email (signing request + confirmation): ~$0.001
- KMS sign fee: ~$0.005
- Total per signer: ~$0.03-0.04

**Per-envelope margin illustration:**
- 2 signers: $0.29 revenue, ~$0.08 cost, ~72% margin
- 5 signers: $0.59 revenue, ~$0.20 cost, ~66% margin
- 10 signers: $1.09 revenue, ~$0.40 cost, ~63% margin

**Proof system reference:** See `docs/products/zkprover/research/comparison-matrix.md` for the full measured comparison of four prover candidates (snarkjs PLONK, TACEO co-snarks, SP1 zkVM, RISC Zero zkVM) and the rationale for choosing RISC Zero (DD-12 in `docs/plans/zkprover-plan.md`).

#### F2.10 Forker Model (public repo) `[repo]`

- F2.10.1. **The public repo does NOT include end-user billing.** Forkers pay run402 for infrastructure (T1) and can send as many envelopes as they like. There is no built-in mechanism for forkers to charge their own users (T2). Forkers who want to charge their users must build their own billing layer — the `allowed_senders` table (F2.8) provides the authorization primitive they can hook into.
- F2.10.2. **Most forkers (internal use) don't need billing at all.** A law firm or small agency deploys kysigned for their employees, pays run402 for infrastructure, and uses `allowed_senders` to gate access. No user billing required. This is the intended primary use case for forkers.
- F2.10.3. **Documentation must explicitly state:** "Charging your end users for envelopes is not currently available through kysigned or run402. If you need to bill your users, implement your own billing layer using `allowed_senders` as the authorization hook."
- F2.10.4. **Rationale:** Keeping billing out of the public repo avoids forcing forkers to manage PCI compliance, merchant-of-record liability, and Stripe account lifecycle. The internal-use model (operator pays run402 directly, gates access via allowlist) is the simplest and most common deployment pattern.

#### F2.8 Sender Access Control (`allowed_senders`) `[both]`

**Critical:** Without this, a deployed kysigned instance is an open relay — anyone on the internet can call `POST /v1/envelope` and spend the operator's run402 balance on gas and emails. This feature is mandatory for every deployment.

- F2.8.1. **Access control layer:** Every kysigned instance MUST have an authorization layer that gates the "create envelope" action. Authentication is provided by run402 (wallet, magic link, password, OAuth); kysigned adds authorization on top.
- F2.8.2. **`allowed_senders` table:** Each instance stores a list of authorized sender identities — email addresses or role names. Schema:
  ```
  allowed_senders (
    id UUID PRIMARY KEY,
    identity TEXT NOT NULL,       -- email address or role name
    identity_type TEXT NOT NULL,  -- 'email' | 'role'
    quota_per_month INT,          -- optional: max envelopes/month, NULL = unlimited
    added_at TIMESTAMPTZ,
    added_by TEXT,
    note TEXT                     -- human-readable label
  )
  ```
- F2.8.3. **Enforcement:** `POST /v1/envelope` MUST check: (a) requester is authenticated, AND (b) requester identity is in `allowed_senders`. Requests failing either check return 403.
- F2.8.4. **Default-deny:** An empty `allowed_senders` table means NO ONE can create envelopes. This prevents accidentally exposing a fresh deployment. The deployment wizard/docs must prompt the operator to add at least one sender.
- F2.8.5. **Admin interface:** Operator has an admin UI and/or API to add, remove, and list allowed senders. Requires operator authentication (separate from sender authentication).
- F2.8.6. **Optional per-sender quotas:** Each `allowed_senders` row can include a monthly envelope quota (e.g., "John Smith: 50/month"). When exceeded, envelope creation fails with a clear error. Quotas are optional — NULL means unlimited.
- F2.8.7. **kysigned.com SaaS mode:** The hosted service at kysigned.com uses `allowed_senders` with a special rule: any user with sufficient credit balance is effectively allowlisted for envelope creation. The gate is "has credits" rather than "on an explicit list". Implementation: the enforcement check is pluggable — hosted mode swaps the allowlist check for a credit-balance check.
- F2.8.8. **Forked/self-hosted mode:** A forker (e.g., a law firm) deploys kysigned and maintains an explicit `allowed_senders` list (employees, contractors). No end-user payment — costs absorbed by the operator. The operator gets a clean internal tool.
- F2.8.9. **Deployment documentation:** The README and self-hosting guide MUST prominently warn: "Before going live, configure your `allowed_senders` list or your instance is open to abuse. Default-deny is enforced, but you must explicitly add your first sender."
- F2.8.10. **Future T2 path:** If/when run402 adds native end-user billing (T2), kysigned can optionally shift from its own Stripe integration to using run402's billing layer, and the access control can shift from "explicit allowlist" to "any user with sufficient credits in the run402 customer account." This is a post-MVP enhancement; the `allowed_senders` feature stays in place as the generic authorization primitive.

### F3. Signing Experience

What happens when a signer receives and acts on a signing request.

#### F3.A Reply-to-Sign (email DKIM) `[both]`

The primary signing method. Used by the hosted service and available in the public repo.

- F3.1. `[both]` Signer receives an email from the operator with: the document name, the sender's name, the document hash (`docHash`), the envelope ID, a review link (read-only document preview), and clear instructions to sign by replying with `I APPROVE`.
- F3.2. `[both]` The review page renders the PDF in the browser using pdf.js. The page displays the `docHash` prominently and provides a client-side hash verification tool ("verify this document's hash in your browser"). The review page is read-only — it does not complete a signature.
- F3.3. `[both]` **The signing act:** the signer replies to the signing email from their own mailbox with `I APPROVE` (case-insensitive, punctuation-tolerant) as a standalone line above any quoted content. The reply goes to `reply-to-sign@<operatorDomain>` (a single inbound address, not per-envelope). The signer's mail provider DKIM-signs the outbound reply — this is the cryptographic proof of mailbox control.
- F3.3.1. `[both]` **Subject line as binding:** the email subject carries the envelope ID and `docHash`. The subject must be present in the DKIM `h=` signed-headers list. The zk-email circuit rejects any reply where `Subject` is not among the DKIM-signed headers.
- F3.3.2. `[both]` **`I APPROVE` validation:** the operator's inbound handler checks the reply body for `I APPROVE` as a standalone line above quoted content. Other replies (questions, blank, random text) are NOT treated as signatures. The operator auto-responds with guidance: "your reply did not match the signing format — to sign, reply with `I APPROVE`; to ask a question, contact the sender at [sender-email]."
- F3.3.3. `[both]` **zk-email proof generation:** the operator runs a zk-email circuit over the raw DKIM-signed reply. The circuit produces a zk-SNARK proving: (a) a valid DKIM signature exists by the signer's mail provider's key, (b) `Subject` is in the DKIM `h=` list, (c) the `From:` header produces a document-scoped commitment `emailCommit = Poseidon(email, docHash, envelopeId)` (not a stable email hash — prevents cross-document linkability), (d) the subject contains the envelope ID and `docHash`, (e) the body contains `I APPROVE` as a standalone line, (f) the `d=` domain in the DKIM-Signature aligns with the `From:` domain, (g) the DKIM signature does not use `l=` (partial body), (h) no duplicate critical headers (`From`, `Subject`, `To`). The raw email is discarded after proof generation.
- F3.3.4. `[both]` **Circuit hardening requirements** (from adversarial review):
  - **DKIM `d=` / `From` alignment:** the circuit rejects emails where the DKIM-Signature `d=` domain does not match or align with the `From:` header domain. Prevents an attacker from signing as `d=attacker.com` while claiming `From: bob@gmail.com`.
  - **Reject DKIM `l=` tag:** partial-body DKIM signatures (`l=<length>`) allow appending arbitrary content after the signed portion. The circuit rejects any DKIM-Signature containing `l=`.
  - **Reject duplicate critical headers:** the circuit rejects emails with duplicate `From`, `Subject`, or `To` headers (ambiguity attack).
  - **MIME restrictions:** only `text/plain` single-part messages with ASCII/UTF-8 encoding are accepted for proof generation. `text/html`, `multipart/*`, and exotic transfer encodings are rejected at the operator pre-check layer (before circuit input preparation).
  - **Replay nullifier:** each proof includes a nullifier derived from the canonical DKIM signature bytes, preventing the same email from being used to generate multiple proofs.
  - **Recipient binding:** the circuit proves that the `To:` header (if in DKIM `h=`) includes the operator's designated reply address (`reply-to-sign@<operatorDomain>`), binding the reply to a specific kysigned instance.
- F3.3.5. `[both]` **Bait-and-switch protection is native.** The `docHash` is in the DKIM-signed email the signer received and replied to. The zk circuit binds the signature to the exact hash present in the email. An operator cannot stage a different document — the reply's DKIM signature covers the hash the signer actually saw.
- F3.4. `[both]` **No signer-drawn signatures.** Signers do not draw, scribble, or click a visual signature. The signing act is the email reply. The system auto-generates a proof block per signer (see F16) that is appended to the PDF by the operator — the signer has no input into its visual appearance.
- F3.5. `[both]` After signing is confirmed (zk proof generated, on-chain record written), the operator sends a confirmation email to the signer with the transaction hash and a proof link.
- F3.6. `[both]` **Decline:** a signer who does not wish to sign simply does not reply. There is no explicit decline action in the MVP. Envelope expiry (F1.7) handles the timeout case. The sender is notified when the envelope expires with incomplete signatures.
- F3.7. `[both]` **Duplicate signing protection:** if the operator receives a second valid `I APPROVE` reply from the same signer for the same envelope, the first is used and subsequent replies are no-ops. The operator responds with "you have already signed this document."

#### ~~F3.B Wallet Signing (Method B / EIP-712)~~ — REMOVED (v0.12.0)

> Moved to Future Features. Wallet signing was removed from both the hosted service and the public repo for MVP simplification. The only signing method is reply-to-sign email. See Future Features section.

### F4. On-Chain Recording `[both]`

Every signature event is recorded on canonical smart contracts on Base.

#### F4.A Contracts

- F4.1. **Two canonical contracts deployed on Base:** `SignatureRegistry` (signature records) and `EvidenceKeyRegistry` (DKIM public keys). All instances (service and repo deployments) record to the same contracts by default.
- F4.2. Contract addresses are constants in the repo code. Forkers can change them but have no incentive to (shared registry strengthens verification).
- F4.3. Both contracts are immutable once deployed: no owner, no admin, no upgrade mechanism, no proxy pattern. Append-only. No entry can be modified or deleted by anyone, including the deployer.
- F4.4. Both contracts accept permissionless writes — any funded EOA can submit records. The contract verifies the zk proof against the referenced evidence key before accepting. Invalid proofs are rejected at write time.
- F4.5. Contracts are replaceable: new envelopes can be directed to new contracts at any time. Old records remain verifiable at old contract addresses forever. The verification page checks all known contract addresses.
- F4.6. Contract ABIs and verification algorithms are published and documented from day 1. Anyone can verify signatures independently without kysigned.com.

#### F4.B Evidence Key Registry (new)

- F4.7. `EvidenceKeyRegistry` stores DKIM public keys keyed by `keyId = keccak256(domain, selector, publicKey)`. Each entry contains: provider domain, DKIM selector, raw public key bytes, and a registration timestamp (`block.timestamp`). Permissionless, append-only, no admin, no revocation.
- F4.8. One entry per (provider, selector, key rotation). Amortized across all signatures using the same key. Registered on first encounter by any operator.
- F4.9. **Non-repudiation via key consistency:** The zk proof's existence proves the DKIM key was correct at proof generation time (wrong key → DKIM verification fails → no proof). The `EvidenceKeyRegistry` + `block.timestamp` creates an immutable on-chain record: "on day X this DKIM key was used to verify a legitimate email signature." A signer cannot repudiate by claiming the operator fabricated the key, because the same `keyId` is referenced by ALL signatures from that provider during the same key period — the operator would need to fabricate ALL Gmail (or Outlook, etc.) signatures in that window, not just the disputed one. Multiple independent operators sharing the canonical `EvidenceKeyRegistry` contract make fabrication infeasible (each operator independently verifies and registers the same key). Even with a single operator, the consistency requirement across all signatures from the same provider during the same key period makes selective fabrication detectable.
- F4.9.1. **DNSSEC: not required.** Major providers (Gmail, Outlook, Yahoo) do not sign their `_domainkey` DNS zones with DNSSEC (~5% global DNSSEC coverage). The trust model does not depend on DNSSEC — the zk proof itself is the cryptographic attestation of key correctness. DNSSEC would add defense-in-depth for archival key provenance but is unavailable for the vast majority of real-world emails and is therefore omitted from the MVP.
- F4.9.2. **Standardisation opportunity (future):** If multiple independent operators standardise on the same canonical `EvidenceKeyRegistry` contract, every operator's registrations corroborate every other operator's. A fabricated key would be immediately detectable as an outlier against the consensus of independent operators. This is the strongest form of non-repudiation and requires no protocol change — only adoption of the same contract address by multiple parties.
- F4.9.3. **Operator censorship is detectable.** The operator could refuse to submit a proof on-chain, but this is detectable: the sender or signer can independently query the blockchain using the verification script (`scripts/verify-envelope.ts` in the public repo). If the signature isn't on-chain, the operator is caught. The trust model, DKIM key explanation, and verification procedure are documented in `docs/trust-model.md` in the public repo — written for non-technical users.

#### F4.C Reply-to-Sign Recording `[both]`

- F4.10. **Record structure:** each reply-to-sign signature record contains:
  - `searchKey` — `SlowHash(email || docHash)` using a deterministic slow KDF with fixed parameters committed forever in the spec.
  - `docHash` — SHA-256 of the original document.
  - `envelopeId` — unique envelope identifier.
  - `evidenceKeyId` — reference to the DKIM key entry in `EvidenceKeyRegistry`.
  - `timestamp` — signing time.
  - Bulky data (zk proof bytes, public inputs) emitted via events, not stored in contract storage (cheaper gas, permanently retrievable from block history).
- F4.11. **Privacy (tiered exposure model):** No email plaintext or stable email identifier is on-chain. The email commitment is document-scoped (`emailCommit = Poseidon(email, docHash, envelopeId)`) — different for every document, preventing cross-document linkability. Privacy degrades with attacker knowledge:
  - **Casual observer** (no document, no email): sees opaque hashes, timestamps, provider references. Cannot determine who signed what. **Strong privacy.**
  - **Has the document** (not the email): finds all records for that document via `docHash`. Learns signer count, timing, providers used. To identify signers: must brute-force candidate emails via argon2id (~1 second per guess, 256 MiB memory). Small candidate set (2-3 people): seconds. Employee directory (10K): hours. Global email enumeration: infeasible. **Moderate privacy — targeted confirmation is computationally expensive.**
  - **Has email + document** (the verification scenario): confirms signature in ~1 second. **By design — this is the intended use case.**
  - **Has email, wants all documents** (surveillance): must try every `docHash` on-chain. At 100K documents: ~28 hours. At 10M documents: ~116 days. Memory-hard KDF limits GPU/ASIC speedup. **Expensive even for state-level attackers, but not impossible for high-value targets with known email addresses.**
  - `docHash` is public — anyone with the document can find all signature records for it. This is a deliberate design choice: verification requires the document, and document holders are expected to have it.
- F4.12. **On write:** the contract verifies the zk proof against the referenced evidence key. Invalid proofs are rejected. Valid proofs are stored and the signature event is emitted.
- F4.13. **Submitted by the kysigned server via the platform wallet**, not by the signer. The signer's involvement ends when their DKIM-signed reply is received.

#### ~~F4.D Wallet Signing Recording~~ — REMOVED (v0.12.0)

> Moved to Future Features. `recordWalletSignature` remains in the deployed contract (immutable, cannot be removed) but is not used by any current code path.

#### F4.E Completion Recording `[both]`

- F4.15. `recordCompletion(envelopeId, originalDocHash, finalDocHash, signerCount)`. Fires when all signers have signed. Links the original document hash to the final rendered PDF hash (which includes the approval page with proof blocks).

### F5. Verification `[both]`

Public, universal, vendor-independent signature verification — designed to work ~20 years from now with no dependency on any operator.

#### F5.A Verification procedure (reply-to-sign)

- F5.1. **Verification inputs:** `(email, document)`. The verifier must have both. There is no "lookup by email only" or "lookup by document only" — this is a deliberate privacy property.
- F5.2. Verification page at `/verify` accepts a PDF upload and an email address. It computes `docHash = SHA-256(pdf_bytes)` and `searchKey = SlowHash(email || docHash)`, then queries the canonical `SignatureRegistry` contract(s) for a matching record.
- F5.3. If a record is found, the page:
  1. Retrieves the zk proof from the signature event (block history).
  2. Looks up the `evidenceKeyId` in `EvidenceKeyRegistry` to get the DKIM public key + registration timestamp.
  3. Verifies the zk proof against the DKIM key with public inputs `(emailCommit, envelopeId, docHash)` where `emailCommit = Poseidon(email, docHash, envelopeId)` — document-scoped, not a stable pseudonym.
  4. Checks key consistency: the same `keyId` is referenced by other signatures from the same provider during the same period (corroboration — see F4.9).
  5. Displays result: "This email signed this document at [timestamp]. Verification is independent — it does not depend on kysigned.com or any operator."
- F5.4. Verification page is **universal**: it verifies ANY record on the canonical contracts, regardless of which instance (kysigned.com, acme-sign.com, etc.) created it.
- F5.5. **No discovery.** The verification page does NOT support "search by email" or "list all documents signed by X." The verifier must provide both inputs. This is not a limitation — it is the privacy guarantee.

#### ~~F5.B Verification procedure (wallet signing)~~ — REMOVED (v0.12.0)

> Moved to Future Features. `verifyWalletSignature` remains callable on the deployed contract but is not exposed in the verification UI.

#### F5.C Approval page, proof blocks, and proof links

- F5.7. **Approval page:** a single page appended to the final PDF on envelope completion (see F8, F16). Contains one **proof block** per signer (see F16.1) and document-level metadata: document name, original `docHash`, envelope ID, operator identity, verification instructions.
- F5.8. Third-party verification: anyone with the signed PDF can independently verify against the blockchain using the proof block data. Each proof block contains a verification key string with chain, contract address, searchKey, and envelope ID — sufficient for any validator (human or AI agent) to query the on-chain record directly. No dependency on any kysigned instance being online.
- F5.9. **Proof link:** `/verify/<envelopeId>` displays the full verification record for a completed envelope — signer count, signing dates, tx hashes, and direct links to each transaction on Basescan. No PDF upload required (the envelope ID is sufficient to query the contract for the completion record). This is the link shared in the completion email (F7.4).
- F5.10. **Owner verification (dashboard):** Full audit trail per signer — email, timestamp, tx hash. Available to the sender via the dashboard (F6).

### F6. Dashboard `[both]` basic / `[service]` enhanced

Envelope management and account overview.

- F6.1. `[both]` Envelope list with status, signer progress, creation date, completion date.
- F6.2. `[both]` Per-envelope detail view: audit trail, signer statuses, tx hashes, links to on-chain records.
- F6.3. `[both]` Resend signing request / send reminder to pending signers.
- F6.4. `[both]` Export envelope data (CSV or JSON).
- F6.5. `[both]` **Dashboard access:** magic link login via email. Dashboard shows all envelopes associated with that email.
- F6.6. `[service]` Credit balance display, purchase history, low-balance indicator.
- F6.7. `[service]` Usage statistics: envelopes sent (monthly/weekly), signatures collected, completion rate.
- F6.8. `[service]` Spending history: per-envelope cost breakdown, total spend over time.

### F7. Email & Link Delivery `[both]`

Email is the core signing channel, not just a notification mechanism.

#### F7.A Signing email (outbound to signer)

- F7.1. `[both]` Signing email sent to each signer. Email includes: sender name, document name, `docHash`, envelope ID, a review link (read-only document preview), the `How it works →` link (F11.7), and clear instructions: "To sign, reply to this email with `I APPROVE` as the first line."
- F7.1.1. `[both]` The `Reply-To` header is set to `reply-to-sign@<operatorDomain>` (single inbound address for all envelopes). Envelope and signer identity are inferred from the reply's `From:` header and subject line.
- F7.1.2. `[both]` **Email tone:** privacy-first and deliberately non-scary. The primary call-to-action conveys "this is private, simple, and only findable by someone who already has both your email and the document." Legal and technical specifics live on the "how it works" page and in a collapsible footer — not in the primary signing instruction.
- F7.1.3. `[both]` **Consent language versioning.** Every user-facing string that constitutes signing intent (email body, subject line, auto-reply wording, approval page wording, "how it works" page text) is versioned. The version in force at the time of signing is recorded alongside each envelope in operator state. Disputes can reference the exact text a signer was shown.

#### F7.B Inbound reply handling

- F7.2. `[both]` Operator receives replies at `reply-to-sign@<operatorDomain>` via the run402 inbound email surface (SES receipt rule → S3 → email-lambda → Postgres). Raw MIME is preserved in S3 with DKIM headers intact.
- F7.2.1. `[both]` The operator's signing handler retrieves raw MIME from S3 (NOT the parsed/cleaned `body_text`), validates DKIM, extracts subject and body, checks for the `I APPROVE` marker, and proceeds to zk proof generation (F3.3.3).
- F7.2.2. `[both]` Replies that do not match the signing format (wrong subject, missing `I APPROVE`, or extra content without `I APPROVE`) trigger an auto-reply: "Your reply did not match the signing format. To sign, reply with `I APPROVE` as the first line. To ask a question, contact the sender at [sender-email]."

#### F7.C Reminders, confirmation, and completion

- F7.3. `[both]` Automated reminders at configurable intervals (default: 3 days, 7 days after initial send). Sender can trigger manual reminders. Reminder emails repeat the signing instructions in the reply-to-sign format.
- F7.4. `[both]` Confirmation email sent to signer after their signature is recorded on-chain. Includes the transaction hash and a proof link.
- F7.5. `[both]` **Completion email** sent to all parties (sender + all signers) with: the aggregated signed PDF (including approval page with proof blocks, see F8 + F16), a proof link (`/verify/<envelopeId>`), and plain-text blockchain reference details (contract address, chain, tx hashes). Recipients can independently verify on any block explorer even if kysigned.com is unreachable.
- F7.6. `[both]` Notice to senders: prompt to contact signers and check spam if signing requests are not received. Displayed in dashboard and in API response.

#### F7.D Infrastructure

- F7.7. `[service]` Email sent from a dedicated kysigned.com sending domain with SPF/DKIM/DMARC configured.
- F7.7.1. `[service]` Inbound replies received at `reply-to-sign@kysigned.com` (or `reply-to-sign@mail.run402.com` for MVP if custom-domain inbound is not yet available).
- F7.8. `[repo]` Outbound email sending is configurable: use run402 email service (paid) or plug in own provider (SendGrid, SES, etc.). Inbound email handling requires an SES-compatible inbound pipeline that preserves raw MIME with DKIM headers.

### F8. PDF Handling `[both]`

**Ephemeral PDF storage by design.** kysigned holds PDFs only as long as operationally necessary, not for a fixed retention period. This minimizes the breach blast radius: at any given moment, only PDFs for active envelopes (or recently completed envelopes still being delivered) exist in storage. Historical envelopes have only metadata + on-chain hashes.

- F8.1. Accept PDF upload (base64 in API body or URL reference).
- F8.2. Compute `SHA-256(pdf_bytes)` as the canonical document hash.
- F8.3. Render PDF in browser on the review page using pdf.js.
- F8.4. **No signer-drawn signatures.** Signers do not draw or scribble a signature. The system auto-generates a proof block per signer (see F16) embedded in the approval page appended to the PDF. The signing act is the email reply, not a visual mark.
- F8.5. **Approval page appended at completion.** On envelope completion, the operator automatically appends an approval page to the final PDF. The approval page contains one proof block per signer (see F16.1) plus document-level metadata (original `docHash`, envelope ID, operator identity, verification instructions). This is purely cosmetic rendering — the cryptographic record is against the original `docHash`, not the rendered PDF. Zero friction for signers (they never see this page during signing) and zero opt-in for the sender (added automatically by default).
- F8.5.1. The completion record (F4.15) stores both `originalDocHash` (pre-approval-page) and `finalDocHash` (post-approval-page). A verifier computes `SHA-256(final PDF)`, looks up the completion record by `finalDocHash`, reads `originalDocHash`, then looks up signatures by `originalDocHash`.
- F8.6. **Ephemeral retention rule:**
  - **Active envelope (status='active'):** PDF retained — needed for signing
  - **Voided or expired envelope:** PDF deleted immediately (no party will sign or receive a completion email)
  - **Completed envelope, completion emails queued:** PDF retained until delivery is confirmed
  - **Completed envelope, ALL completion emails delivered (SES delivery webhook received for every recipient):** PDF deleted immediately. This typically happens within minutes-to-hours of completion, not days.
  - **Completed envelope, one or more completion emails bounced:** PDF retained for 7 days. Sender is notified of the bounce. After 7 days, the PDF is deleted regardless and the sender is responsible for re-delivering via their own channel using the proof link.
  - **Hard maximum:** No PDF is ever retained longer than 30 days from completion, regardless of delivery status. This is a hard cap, not configurable upward.
- F8.7. Users are clearly notified at envelope creation that PDFs are ephemeral and they should keep their own copy. The completion email itself contains the signed PDF as an attachment, so all parties have a permanent copy.
- F8.8. After PDF deletion, only metadata persists: document name, document hash, signer statuses, tx hashes, timestamps. The on-chain hash remains forever.
- F8.9. Future feature: optional paid document retention tier (user pays for extended storage). Not in MVP scope. If/when added, retention will be opt-in per envelope and the user will be the explicit data controller for the retained content.
- F8.10. **Multi-section signing is out of scope.** MVP treats the entire document as a single unit — one `I APPROVE` covers the whole document. Contracts or papers that require initials on specific pages, or multiple separate signatures for different sections, are not supported. A future feature may break a document into multiple sections each with its own `I APPROVE` email, but this requires a separate brainstorm + spec cycle. See FAQ.
- F8.11. **Security framing:** This ephemeral retention pattern is a deliberate security property, not just a feature. It is the primary mitigation for the risk that an attacker compromising kysigned's storage could exfiltrate document content. The smaller the window of retention, the smaller the breach blast radius.

### F9. Prepaid Credits `[service]`

Pay-as-you-go billing for hosted service users. This is the only payment mechanism for end users on kysigned.com.

- F9.1. Credit packs purchasable via Stripe: multiple tiers (e.g., $5, $10, $20). Exact tiers and per-envelope rates set after gas cost measurement. **kysigned uses its own Stripe product/price configuration under the Kychee Stripe account** — this is T2 billing (kysigned charging its users), separate from T1 billing (run402 charging kysigned for infrastructure).
- F9.2. Per-envelope cost deducted from credit balance on envelope creation.
- F9.3. Credit balance visible in dashboard at all times.
- F9.4. Purchase history viewable in dashboard.
- F9.5. Low-balance alert when credits fall below a threshold (e.g., fewer than 5 envelopes remaining).
- F9.6. Credits do not expire.
- F9.7. Checkout experience is branded as kysigned (not run402).
- F9.8. **Stripe setup required:** Create a kysigned product in the Kychee Stripe account. Define price tiers for credit packs. Implement Stripe Checkout sessions for purchase, webhook handler for payment confirmation, and credit balance tracking in the kysigned database. This is kysigned-private code (not in the public repo).

### F10. CLI / MCP `[both]`

Agent-native interface for programmatic signing and instance setup.

#### F10.A Signing Operations

- F10.1. MCP server exposing core signing operations: create envelope, check status, list envelopes, verify document.
- F10.2. Canonical npm package (`kysigned-mcp` or similar) defaults to kysigned.com endpoint.
- F10.3. Repo includes the same MCP server, configurable to point to any instance.
- F10.4. `[service]` Agents authenticate via a kysigned API key or session token associated with a credit-holding account. `[repo]` Forkers configure their own authentication — the `allowed_senders` check applies to MCP requests the same as API requests.
- F10.5. Agent can discover kysigned via llms.txt on kysigned.com.

#### F10.B Instance Setup (`init`) `[repo]`

The kysigned CLI/MCP provides an `init` command that bootstraps a new kysigned instance on run402. This is the forker's entry point — an agent or developer runs `kysigned init` and gets a working deployment.

- F10.6. **`init` command** available via both CLI (`kysigned init`) and MCP tool (`init`). Idempotent — safe to re-run.
- F10.7. **What `init` does:** provisions everything a forker needs to run their own kysigned instance on run402. Uses run402's public APIs (REST, MCP, CLI) — does NOT require access to run402's internal monorepo or AWS. Steps include:
  - Create or reuse a run402 allowance wallet (the operator's identity for T1 billing)
  - Subscribe to a run402 tier (prototype for testnet, hobby/team for production)
  - Create a run402 project for this kysigned instance
  - Store project credentials locally (project ID, service key, anon key)
  - Register a custom sender domain for outbound email (or use run402 default domain)
  - Add the operator as the first `allowed_senders` entry
  - Report next steps: "Your instance is ready. Deploy with `kysigned deploy` or configure your endpoint."
- F10.8. **What `init` does NOT do:** give the forker testnet money, deploy contracts (those are shared canonical contracts), or set up Stripe billing (forkers handle T2 themselves if needed). The focus is on the minimum viable deployment: a run402 project with email, database, and the operator authorized to send envelopes.
- F10.9. **Reference implementation:** kysigned's `init` is modeled after run402's own `init` flow but is NOT a wrapper around it. It implements only what kysigned needs, using run402's public API surface. The run402 `init` (which creates a generic allowance wallet and drips testnet funds) is a reference, not a dependency.
- F10.10. **Credential storage:** operator credentials stored locally at `~/.config/kysigned/` (or `KYSIGNED_CONFIG_DIR` env var) with restricted file permissions (0600). Includes: run402 project credentials, operator identity, instance endpoint URL.
- F10.11. **Integration testing:** the public repo's integration test suite uses `init` as the setup step — proving the same flow a real forker would follow. Tests run against testnet and exercise the full envelope lifecycle after init.
- F10.12. **Dogfooding:** the hosted service (kysigned-private) bootstraps using the public repo's setup flow (or a close equivalent) to prove the forker path works. The service is the first and most important forker of the public repo. If the service needs a shortcut that a forker wouldn't have, that's a signal the public repo is missing something.

### F11. Website `[service]`

Marketing site and product pages at kysigned.com.

- F11.1. Landing page led by the cost attack angle ("DocuSign charges $3-5 per signature. kysigned charges $0.29. Proof on the blockchain, not their servers."). No "kill" language.
- F11.2. Dual CTA: "Send a document" (hosted service) and "Deploy your own" (GitHub repo).
- F11.3. "SaaS vs Repo" decision helper explaining the tradeoffs for each delivery mode.
- F11.4. Pricing page showing per-envelope costs ($0.29 base + $0.10/extra signer), credit pack tiers, and a comparison table vs DocuSign/GoodSign/others.
- F11.5. **FAQ as conversion weapon** — six categories:
  - Trust/survival: "What if you shut down?" → "Your proofs are on the blockchain. They survive us."
  - Migration: "How do I move from DocuSign?" → envelope-by-envelope, no lock-in.
  - Capability gap: honest comparison of what kysigned does and does not do vs DocuSign.
  - Legal/compliance: "Are blockchain signatures legal?" → ESIGN Act, UETA, state statutes.
  - Pricing/catch: "How is this so cheap?" → you pay for infrastructure, not subscription overhead.
  - SaaS vs repo: decision helper with how-to snippets for agent-assisted deployment.
  - Multi-section signing: "Does kysigned support initials on specific pages or multiple signatures per document?" → "Not yet. kysigned treats the entire document as a single unit — one approval covers the whole document. Multi-section signing (initials per page, separate approvals per section) is a planned future feature."
  - Agent validation: "How can I verify a signed document?" → "Every signed PDF contains a proof block with a verification key. Give your AI agent this instruction: 'Read the verification key from the proof block and call getReplyToSignRecords(searchKey) on the Base contract at the address shown.' Any agent can validate any signed document — no account or service needed."
- F11.6. **Three content layers:**
  - FAQ — human-readable, conversion-focused
  - How-to snippets — copyable prompts for humans using AI agents
  - llms.txt — machine-readable product description for agent discovery
- F11.7. **"How it works" page** at `/how-it-works`. Public-facing, linked from every signing email. Written in entirely non-technical language — no "blockchain," "DKIM," "hash," "zero-knowledge proof." Explains to a non-technical signer: what replying does, what gets stored, who can find their signature (only someone with both their email and the document), what we cannot do (no "list all docs Alice signed"), and that records last forever on a public database no single company controls. Target: readable in under one minute by someone who has never heard of cryptography.
- F11.8. Clean, minimal design following bld402.com aesthetic. Not crowded.

### F12. Legal `[service]` + `[repo]`

- F12.1. `[service]` **Terms of Service** — drafted from existing Kychee/Eleanor/run402 templates. Must precisely state what reply-to-sign signatures prove: "the signer's mail provider cryptographically attested that a real outbound email from the signer's mailbox contained `I APPROVE` and referenced this document's hash." Must clarify that this does NOT prove "person X signed" — it proves "someone with mailbox control of email X signed." Mailbox compromise is explicitly listed as a limitation (same as every digital signing product). Requires human approval before launch.
- F12.2. `[service]` **Privacy Policy** — drafted from templates. Must explain: no email plaintext stored on-chain or in operator state after proof generation; raw MIME discarded after zk proof; records are only findable by someone with both the email and the document. Requires human approval.
- F12.3. `[service]` **Cookie/consent notice** — drafted from templates. Requires human approval.
- F12.4. `[service]` **Acceptable Use Policy** — drafted from templates. Requires human approval.
- F12.5. `[service]` **DPA (Data Processing Agreement)** — drafted from templates. Requires human approval.
- F12.6. `[repo]` **LICENSE** — MIT license covering the code.
- F12.7. `[repo]` **LEGAL.md** — disclaimers separate from the MIT license:
  - What reply-to-sign signatures prove: "the signer's mail provider's DKIM key, archived on-chain with an immutable timestamp, attested an outbound email from the signer's mailbox containing `I APPROVE` and the document hash. The key's authenticity is corroborated by every other signature from the same provider during the same key period (see F4.9)." Not "person X signed."
  - No guarantee of legal enforceability in any specific jurisdiction
  - Smart contract permanence disclaimer (recordings on Base are permanent, cannot be deleted or modified by anyone)
  - Operator responsibility: the forker/deployer is responsible for their own privacy compliance, Terms of Service, and legal obligations — not Kychee
  - Excluded document types that cannot be e-signed under ESIGN/UETA (wills, codicils, etc.)
- F12.8. No product launch until all `[service]` legal documents are human-approved.
- F12.9. `[both]` **Consent language is versioned and legally reviewed.** Every user-facing string that constitutes signing intent is versioned (F7.1.3). Legal review required before launch — the exact email copy, "how it works" page text, and approval page wording must be approved by someone with legal expertise.

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

### F15. Geo-Aware Cookie Consent `[service]`

Per the SaaS Factory spec (F19). kysigned.com uses the shared Kychee geo-aware consent banner module.

- F15.1. Banner shown only to visitors from EU, UK, Brazil, Canada, Switzerland, or California.
- F15.2. Banner NOT shown to visitors from US (non-CA) and other permissive jurisdictions.
- F15.3. When detection fails, banner is shown (fail-safe to compliant).
- F15.4. GA4 (`G-27SFFZ8KQW`) and any ad pixels load only after consent in jurisdictions that require it.
- F15.5. Three categories with independent toggles: Essential, Analytics, Marketing.
- F15.6. "Reject all" button equally prominent as "Accept all".
- F15.7. Consent state persisted in `localStorage` as `kychee_consent`.
- F15.8. "Cookie settings" link in footer re-opens the panel.
- F15.9. Re-prompts user when consent is older than 12 months.

### F16. Signed PDF: Proof Blocks, Aggregation & Resend `[both]`

This feature covers three connected capabilities: (1) per-signer proof blocks embedded in the PDF, (2) multi-envelope aggregation into a single signed PDF, and (3) resend-to-missing-signers flow.

#### F16.A Proof Blocks `[both]`

Each signer's signature is represented as an auto-generated **proof block** — a visual element embedded in the approval page appended to the final PDF. The signer has no input into its appearance (no drawing, no scribbling — see F3.4).

- F16.1. **Proof block contents.** Each proof block contains:
  - Signer name and date signed
  - **QR code** linking to the operator's verification page: `https://{operatorDomain}/verify/{envelopeId}`. The `operatorDomain` is configured per deployment — forkers set their own domain.
  - **Verification key string** (plain text, machine-readable): `Chain: Base | Contract: 0x{signatureRegistry} | SearchKey: 0x{searchKey} | EnvelopeId: 0x{envelopeId}`. This is all any validator (human or AI agent) needs to query the on-chain record directly via `getReplyToSignRecords(searchKey)` — no dependency on any kysigned instance.
- F16.2. **Proof block states.** A proof block shows one of three states:
  - **Signed** — signer name, date, QR code, verification key string (full proof block)
  - **Waiting** — signer name, "signature pending" label (envelope still active)
  - **Failed** — signer name, "did not sign" label (envelope expired/voided without this signer's signature)
- F16.3. **Standalone validator.** The public repo includes a standalone validator tool that accepts a PDF, reads the proof block data, and verifies each signer's record on-chain. This is independent of the kysigned hosted service. Any AI agent given the instruction "verify this document using the proof block data" can do so by calling the contract's read functions. The FAQ positions this as: "give these instructions to your agent and it can validate any signed document."
- F16.4. **Operator domain configuration.** The QR code URL domain (`operatorDomain`) is set during deployment. Forkers configure their own domain. The verification key string uses on-chain data only (no operator URL) — so even if the operator disappears, the string alone is sufficient for verification.

#### F16.B Multi-Envelope Aggregation `[both]`

When a sender creates multiple envelopes for the same document (same `document_hash`), the system aggregates all signer signatures into a single signed PDF.

- F16.5. **Aggregation key.** Envelopes are grouped by `(document_hash, sender_identity)`. The sender sees one logical "document" in their dashboard, with a history of envelopes and a combined signer ledger.
- F16.6. **Aggregated signed PDF.** The final signed PDF contains one approval page with proof blocks for ALL signers across ALL envelopes for that document. Each proof block's verification key points to the specific envelope where that signer signed. Automatically generated on envelope completion and sent in the completion email (F7.5). Can also be regenerated anytime from the dashboard.
- F16.7. **Dashboard document view.** The sender's dashboard shows documents (grouped by `document_hash`) rather than raw envelopes. Each document row shows: document name, combined signer status (e.g., "2 of 3 signed"), and the history of envelopes (e.g., "Envelope 1: expired with 2/3, Envelope 2: completed with 1/1").
- F16.8. **On-chain verification is unchanged.** Each envelope still produces its own independent on-chain record. Aggregation is a presentation layer — the cryptographic story is per-envelope. A verifier checks each signer's proof block independently.

#### F16.C Resend to Missing Signers `[both]`

When an envelope expires or is voided with some signers still pending, the sender can resend to only the missing signers.

- F16.9. **"Resend to missing" action.** Available in the dashboard when a document has pending signers from a completed/expired/voided envelope. Creates a new envelope with the same PDF (same `document_hash`) and only the signers who did not sign in previous envelopes.
- F16.10. **Automatic detection.** When a sender uploads a PDF whose `document_hash` matches an existing document with incomplete signers, the system surfaces: "This document has N signatures already — would you like to send to only the missing signers?"
- F16.11. **Billing.** Each resend is a new envelope and is billed at the standard per-envelope rate. No discount for resends (defer discount consideration until usage data exists).
- F16.12. **Aggregated result.** After the resend envelope completes, the aggregated signed PDF is regenerated to include all signers across both envelopes. The sender receives the updated PDF.

#### F16.D Future: Multi-Section Signing (out of scope)

> **Not in MVP.** Contracts and papers that require initials on specific pages or multiple separate signatures for different sections are not supported. MVP treats the entire document as a single unit — one `I APPROVE` covers the whole document. A future feature may break a document into sections, each requiring its own `I APPROVE` email. This requires a separate brainstorm + spec cycle and is not planned.

### F17. Pre-Launch Dark-Launch Canary Discipline `[service]` + `[repo]`

> **Principle:** kysigned's first mainnet deploy of `SignatureRegistry.sol` is preceded by a dark-launch canary phase in which the full kysigned product (frontend + service + wallet + contract + email + dashboard + verification) operates in real production mode against an anonymous on-chain backend. The canary phase continues until every feature on a concrete checklist is fully green AND Barry+Tal explicitly approve via a ceremonial go/no-go step. "Launch" then becomes a relabel operation — two environment variables flip from canary references to production references, no application code change — not a fresh deploy. This discipline is kysigned's instantiation of the saas-factory factory-level practice (saas-factory spec F25 — pending spec update alongside this one).
>
> **Why:** kysigned is run402's first production consumer of the KMS-wallet contract-deploy path (drain endpoint, recovery address, 90-day KMS deletion lifecycle, KMS-signs-arbitrary-transaction flow — all with zero production test coverage). A botched first launch is cheap in cash (~$5 of gas) but reputationally permanent (a verified-on-Basescan kysigned-branded contract is forever, even after redeploy). The canary decouples these risks: exercise every untested code path against an anonymous backend first, then "launch" by relabeling when confident.

- F17.1. **Two separate KMS wallets under the kysigned run402 project.** Canary wallet is ephemeral (provisioned fresh per canary session, drained and KMS-deletion-scheduled at session end). Production wallet is long-lived (the address that lives on for every real envelope post-launch). The two wallets must not share a deployer EOA — the canary contract's `Contract Creator` on Basescan must be a distinct address from the production contract's, so linking the two requires real OSINT work rather than a single click.
- F17.2. **Canary and production contracts compile from identical Solidity source.** The canary `SignatureRegistry` and `EvidenceKeyRegistry` contracts are not simplified, renamed, or otherwise-differentiated rehearsal contracts — they compile from the exact same source as the eventual production contracts. Identical bytecode is a feature, not a coincidence: it is the cryptographic guarantee that the canary rehearses the production path.
- F17.3. **Byte-identical bytecode gate at the flip moment.** Before flipping canary → production, the runtime bytecode of the canary contract (fetched via `eth_getCode` on the canary address) MUST be compared against the runtime bytecode of the freshly-deployed production contract (fetched via `eth_getCode` on the production address). If they differ in anything beyond the Solidity metadata suffix (the compiler-hash tail), the flip MUST be aborted and the divergence investigated. A matching bytecode pair is a hard pre-flip gate — no flip without it.
- F17.4. **No Basescan source verification for the canary contract.** The canary contract is deployed to Base mainnet but its source is never submitted to Basescan. External observers see bytecode only. The production contract IS submitted for Basescan verification.
- F17.5. **No kysigned branding in canary deploy artifacts.** The canary KMS wallet has no name tag referencing kysigned; the canary contract has no Basescan name tag referencing kysigned; the canary deploy transaction carries no identifying metadata linking it to kysigned. The only public information about the canary contract is its bytecode.
- F17.6. **kysigned-private runs in full production mode against canary references during the canary phase.** The same kysigned-private deployment that will eventually be used for the launch is configured with two environment variables — `KYSIGNED_CONTRACT_ADDRESS` pointing at the canary contract address and `KYSIGNED_KMS_WALLET` pointing at the canary KMS wallet — for the duration of the canary phase. No separate staging environment. No mock data. Real frontend, real SES, real PDF rendering, real dashboard, real verification.
- F17.7. **The canary phase exercises the full product via the full set of surfaces.** At least one end-to-end envelope MUST be created via each of: the hosted dashboard, the public REST API, and the MCP server. The reply-to-sign flow (email reply → DKIM verification → zk proof → on-chain recording → verification), parallel signing, sequential signing, and the verification page MUST all be exercised at least once against the canary contracts. The plan (kysigned-plan.md) enumerates the exact checklist; the principle here is that no feature from F1–F15 is exempt from canary exercise.
- F17.8. **Exit criterion = checklist fully green AND explicit human go/no-go.** The canary phase ends only when (a) every item on the canary checklist (enumerated in the plan) has been confirmed to work end-to-end against the canary, AND (b) Barry and Tal explicitly approve the flip via a ceremonial go/no-go prompt that presents the checklist summary and demands an explicit APPROVE / ABORT / KEEP TESTING decision. There is no automatic advancement. There is no time-boxing. A partial checklist does not unlock the flip, and a fully-green checklist does not itself trigger the flip — the human decision is independent and required.
- F17.9. **"Launch" is a relabel, not a deploy.** The launch moment consists of: (1) provision the production KMS wallet, (2) deploy the production `SignatureRegistry` contract via the production wallet, (3) run the F17.3 byte-identical bytecode gate, (4) flip the two kysigned-private environment variables from canary references to production references, (5) redeploy kysigned-private (config change only; no application code change), (6) send one smoke-test envelope through the production contract end-to-end, (7) drain the canary wallet back to the ops wallet, (8) schedule KMS key deletion on the canary KMS key. No application code ships on launch day — every line of code has already been exercised against the canary for the duration of the canary phase.
- F17.10. **The canary contract remains on-chain forever after retirement.** Because smart contracts are immutable, the canary contract cannot be deleted. What IS retired: the canary wallet (drained and KMS-deletion-scheduled), the service's environment variables (flipped to production), and every reference to the canary in AWS Secrets Manager (the `kysigned/canary-*` secrets can be deleted the day after the flip is confirmed stable). The canary contract itself becomes a bytecode-only artifact on Base mainnet with no known connection to kysigned.
- F17.11. **Anti-leakage discipline: single pre-squash working-tree scan at Phase 14.** The canary contract address and canary KMS wallet address are the single-point-of-failure secrets. The only control required to protect them is a working-tree scan of the public kysigned repository for both values, run as a Phase 14 plan checklist item immediately before the orphan-branch squash that precedes the private→public flip. If the scan matches either value anywhere in the tree, the flip MUST be aborted and the references removed. This single control is sufficient because (a) the public repo is private throughout the canary phase — references in the tree are internal state, not a leak, and (b) the Phase 14 squash creates a single `v1.0.0` orphan commit, wiping all prior history.
- F17.12. **Canary address storage: AWS Secrets Manager only.** The canary contract address and canary wallet address are stored exclusively in AWS Secrets Manager under the `kysigned/canary-*` namespace. They are NEVER committed to any repository — not the public `kysigned` repo, not the private `kysigned-private` repo — and are read at deploy time via environment injection from Secrets Manager.
- F17.13. **Human discipline for non-repo channels.** The canary address SHOULD NOT be pasted into public-facing channels (Slack messages that might be screenshotted, GitHub issues, external chat, blog drafts). Internal Kychee channels (private Telegram, private Slack, private meetings) are acceptable. This is operator discipline, not enforceable tooling.

## Acceptance Criteria

### F1. Envelope Management
- [ ] Sender creates an envelope with a PDF and 1-5 signers; receives envelope_id, status_url, verify_url, and review links per signer
- [ ] Envelope with 6+ signers applies a per-signer surcharge beyond 5
- [ ] Parallel signing: all signers receive signing emails simultaneously and can reply in any order
- [ ] Sequential signing: signers are notified one at a time; next signer receives signing email only after previous signer's reply is recorded
- [ ] Sender voids an active envelope; all pending signers receive a cancellation notice; no further signing is possible
- [ ] Expired envelope returns "expired" status; pending signers are notified; replies to expired envelopes trigger an auto-response explaining the expiry
- [ ] Webhook URL receives a POST with envelope completion data when all signers have signed
- [ ] Sender adds themselves as signer: envelope creation UI prompts "Will you also sign?"; if yes, sender appears in signer list and signs through the same reply-to-sign flow as other signers
- [ ] Sender-as-signer produces identical on-chain proof to any other signer (no special-case recording)

### F2. Sender Authentication
- [ ] `[service]` User purchases credit pack via Stripe; checkout page is branded as kysigned; credits appear in dashboard
- [ ] `[service]` Magic link login — user enters email, receives login link, clicks to authenticate. No password field. No social login.
- [ ] `[service]` Envelope creation deducts from credit balance; fails with clear error if balance insufficient
- [ ] `allowed_senders` enforcement: unauthenticated `POST /v1/envelope` returns 403
- [ ] `allowed_senders` enforcement: authenticated requester NOT in allowlist returns 403
- [ ] `allowed_senders` default-deny: empty allowlist blocks ALL envelope creation
- [ ] Admin API: operator can add, remove, and list allowed senders
- [ ] Per-sender monthly quota: exceeding quota returns a clear error
- [ ] kysigned.com SaaS mode: users with sufficient credits bypass explicit allowlist (credit-balance check)
- [ ] Self-hosted mode: explicit allowlist with no credit check (internal use)
- [ ] Public repo does NOT contain Stripe integration code (billing is `[service]` only)
- [ ] Public repo README and documentation clearly state: "Charging your end users is not currently available through kysigned or run402. Use `allowed_senders` to gate access."
- [ ] `[service]` FAQ explains "Do I need a wallet?" → "No — you buy credits with a credit card and sign by replying to an email"

### F3. Signing Experience — Reply-to-Sign
- [ ] Signer receives signing email with document name, sender name, `docHash`, envelope ID, review link, and `How it works →` link
- [ ] Signing email `Reply-To` header is `reply-to-sign@<operatorDomain>`; subject contains envelope ID and `docHash`
- [ ] Signer replies with `I APPROVE` (case-insensitive, punctuation-tolerant) → operator receives the reply with raw DKIM headers preserved
- [ ] Operator validates: DKIM signature is valid, `Subject` is in the DKIM `h=` signed-headers list, `From:` matches expected signer, body contains `I APPROVE` as standalone line above quoted content, subject contains correct envelope ID and `docHash`
- [ ] zk-email circuit produces a valid proof binding `emailCommit = Poseidon(email, docHash, envelopeId)`, `envelopeId`, and `docHash` to the DKIM signature; email commitment is document-scoped (no stable pseudonym); raw email is discarded after proof generation
- [ ] Signature record written to `SignatureRegistry` with correct `searchKey`, `docHash`, `envelopeId`, `evidenceKeyId`, zk proof in event
- [ ] Reply without `I APPROVE` (question, blank, wrong text) triggers auto-reply with guidance; no signature recorded
- [ ] Duplicate reply from same signer for same envelope: first is used, subsequent are no-ops with auto-reply "you have already signed"
- [ ] Signer who does not reply: envelope expires per F1.7; no explicit decline action required
- [ ] Review page renders PDF correctly in browser via pdf.js; displays `docHash`; provides client-side hash verification tool
- [ ] Confirmation email sent to signer after on-chain recording with tx hash and proof link

### ~~F3. Signing Experience — Wallet Signing~~ — REMOVED (v0.12.0)

### F4. On-Chain Recording
- [ ] `SignatureRegistry` deployed on Base; accepts reply-to-sign records with valid zk proof; rejects records with invalid proofs
- [ ] `EvidenceKeyRegistry` deployed on Base; stores DKIM public keys with domain, selector, raw key bytes, and registration timestamp
- [ ] Reply-to-sign signature record keyed by `searchKey = SlowHash(email || docHash)`; contains `docHash`, `envelopeId`, `evidenceKeyId`, `timestamp`; zk proof emitted as event
- [ ] Evidence key registered once per (provider, selector, rotation); key consistency verifiable across signatures from the same provider
- [ ] Completion event recorded when all signers have signed, with correct `originalDocHash`, `finalDocHash`, and `signerCount`
- [ ] No entry on either contract can be modified or deleted after recording
- [ ] Both contracts are permissionless (any funded EOA can write) and ownerless (no admin functions)

### F5. Verification
- [ ] Verification page accepts `(email, document PDF)` as inputs; computes `searchKey`; finds matching reply-to-sign record
- [ ] Verification retrieves zk proof from event, looks up evidence key, verifies zk proof, checks key consistency — all client-side or against on-chain data only
- [ ] Verification page is universal: verifies ANY record on the canonical contracts regardless of which instance created it
- [ ] No "search by email" or "list all docs signed by X" — verifier must provide both email and document
- [ ] Approval page appended to final PDF includes per-signer proof blocks (name, date, QR code, verification key string), `docHash`, envelope ID, operator identity, verification instructions
- [ ] Third party with signed PDF can verify against the blockchain using the proof block verification key string — no kysigned instance needed, no email address needed
- [ ] Proof link (`/verify/<envelopeId>`) displays full verification record — signer count, dates, tx hashes, Basescan links
- [ ] Completion email includes proof link, contract address, chain name, and all tx hashes in plain text

### F6. Dashboard
- [ ] Magic link login; dashboard displays all envelopes associated with that email
- [ ] Envelope list shows status, signer progress, dates for each envelope
- [ ] Per-envelope detail view shows full audit trail per signer (email, timestamp, tx hash)
- [ ] Resend/remind button sends a new signing email to pending signers (reply-to-sign format)
- [ ] Export envelopes as CSV or JSON
- [ ] `[service]` Credit balance, purchase history, and low-balance indicator visible for authenticated users
- [ ] `[service]` Usage statistics displayed: envelopes sent, signatures collected, completion rate (monthly/weekly)
- [ ] `[service]` Spending history displayed: per-envelope cost, total spend over time

### F7. Email & Link Delivery
- [ ] Signing email received by signer within 60 seconds of envelope creation; contains document name, sender name, `docHash`, envelope ID, review link, `How it works →` link, and reply-to-sign instructions
- [ ] Signing email `Reply-To` header set to `reply-to-sign@<operatorDomain>`
- [ ] Email tone: privacy-first, non-scary; legal/technical details on linked "how it works" page only
- [ ] Consent language version recorded per envelope at time of signing
- [ ] Inbound reply received at `reply-to-sign@<operatorDomain>` via run402 inbound email surface; raw MIME preserved in S3
- [ ] Non-matching replies trigger auto-reply with guidance; no signature recorded
- [ ] Automated reminder sent at configured intervals (default 3 days, 7 days) in reply-to-sign format
- [ ] Manual reminder triggered by sender; signer receives new signing email
- [ ] Confirmation email sent to signer after on-chain recording
- [ ] Completion email sent to all parties with aggregated signed PDF (including approval page with proof blocks), proof link, and blockchain reference details
- [ ] Spam notice displayed to sender in dashboard after envelope creation
- [ ] `[service]` Emails sent from dedicated kysigned.com domain with SPF/DKIM/DMARC
- [ ] `[repo]` Email provider is configurable (run402 email service or custom SMTP/API); inbound requires SES-compatible pipeline preserving raw MIME

### F8. PDF Handling
- [ ] PDF uploaded via API (base64 or URL); SHA-256 hash computed and returned in response
- [ ] Review page renders PDF correctly in browser via pdf.js
- [ ] No signer-drawn signatures — proof blocks are auto-generated by the system (F3.4, F16.1)
- [ ] Approval page automatically appended to final PDF on completion — contains per-signer proof blocks (F16.1), `docHash`, envelope ID, operator identity, verification instructions
- [ ] Completion record stores both `originalDocHash` (pre-approval-page) and `finalDocHash` (post-approval-page)
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
- [ ] Agent creates envelope via MCP; receives envelope_id and review links
- [ ] Agent checks envelope status via MCP; receives current signer statuses
- [ ] Agent verifies a document via MCP; receives verification results
- [ ] MCP endpoint configurable to point to any kysigned instance (self-hosted or hosted)
- [ ] kysigned.com/llms.txt exists and describes the product for agent discovery
- [ ] `kysigned init` (CLI) and `init` (MCP tool) provisions a new kysigned instance on run402: creates allowance wallet, subscribes tier, creates project, stores credentials locally, registers sender domain, adds operator to `allowed_senders`
- [ ] `kysigned init` is idempotent — re-running on an already-initialized instance is a no-op with status report
- [ ] Credentials stored at `~/.config/kysigned/` with 0600 permissions
- [ ] Public repo integration tests use `init` as the setup step, proving the same flow a real forker follows

### F18. Testing `[both]`

The public repo includes comprehensive integration tests that mirror run402-mcp's testing framework. All payment/billing tests run on testnet. The canary and mainnet phases are only needed for testing the actual signing service (zk proof generation, on-chain recording), not payment flows.

- F18.1. **Integration tests against run402** `[both]`: the public repo's test suite includes real integration tests that hit a live run402 instance (testnet). These are not mocked — they exercise the actual run402 API surface that a forker's deployment would use. Gated by env vars; skip cleanly when env is not configured.
- F18.2. **MCP integration tests** `[both]`: the public repo includes integration tests for the kysigned MCP server that call real MCP tool handlers against a live kysigned API endpoint. Mirrors run402-mcp's `mcp-integration.test.ts` pattern.
- F18.3. **Stripe end-to-end test** `[service]`: the service repo includes a test for the full credit purchase flow: magic link login → Stripe checkout → credit balance → envelope creation → balance deduction. Uses Stripe test mode with test card tokens. Follow the same Stripe testing patterns used in run402's billing tests and other Kychee Stripe-integrated products.
- F18.4. **All payment tests on testnet.** Integration tests that involve billing (T1: kysigned paying run402) use testnet currencies. Stripe tests (T2: user paying kysigned) use Stripe test mode. No mainnet funds or real charges required for any payment testing. Mainnet and the canary phase are ONLY needed for the signing service itself (zk proof generation, on-chain recording, DKIM verification) — payment flows are identical on testnet.
- F18.5. **`init`-based test setup.** Public repo integration tests use `kysigned init` (or equivalent programmatic setup) as the first step, proving the forker onboarding flow works end-to-end before testing envelope operations.
- F18.6. **Two-directional integration tests** `[both]`: the public repo tests exercise BOTH directions:
  - **Toward run402** — kysigned calling run402's APIs (project provisioning, email sending, DB operations, KMS wallet). Proves the T1 integration works.
  - **Toward kysigned's own users** — simulating a forker (or agent) using kysigned's CLI/MCP/API to create envelopes, check status, verify documents. Proves the product interface works end-to-end. These tests can be pointed at any deployment (local, testnet service, production) via `KYSIGNED_ENDPOINT` env var.

### F11. Website
- [ ] Landing page loads at kysigned.com; leads with cost comparison, not blockchain jargon
- [ ] No "kill," "killer," or "killing" language appears anywhere on the site
- [ ] Dual CTA visible above fold: hosted service and GitHub repo
- [ ] "How it works" page at `/how-it-works`; entirely non-technical; no "blockchain," "DKIM," "hash," "zero-knowledge proof"; readable in under one minute
- [ ] Every signing email links to the "how it works" page
- [ ] Decision helper page explains SaaS vs repo tradeoffs for builders, end users, and agents
- [ ] Pricing page shows per-envelope cost ($0.29 base + $0.10/extra signer), credit pack tiers, and comparison table vs competitors
- [ ] FAQ covers all six categories with specific questions and answers; wallet FAQ updated ("Do I need a wallet to SIGN?" → "No, you reply to an email")
- [ ] llms.txt accessible at kysigned.com/llms.txt
- [ ] Design is clean and minimal (bld402.com aesthetic)

### F12. Legal
- [ ] `[service]` ToS, Privacy Policy, Cookie notice, AUP, and DPA are published on kysigned.com
- [ ] `[service]` ToS states what reply-to-sign signatures prove ("signer's mail provider attested outbound email with `I APPROVE` and document hash") and what they do not guarantee (not "person X signed" — only "mailbox control of email X")
- [ ] `[service]` Privacy Policy explains: no email plaintext on-chain; raw MIME discarded after zk proof; records only findable with both email and document
- [ ] `[service]` No launch until all legal documents are human-approved
- [ ] `[service]` Consent language version recorded per envelope; exact text of all signing-intent strings is recoverable for dispute
- [ ] `[repo]` MIT LICENSE file present in repo root
- [ ] `[repo]` LEGAL.md present with disclaimers: reply-to-sign proof semantics, jurisdictional limitations, smart contract permanence, operator responsibility, excluded document types

### F13. Cross-Linking
- [ ] kysigned listed on kychee.com portfolio page
- [ ] "Built on run402" with link appears on kysigned.com
- [ ] Cross-links to/from bld402, segment hubs, SaaSpocalypse hub, run402.com showcase are live
- [ ] kysigned entry added to kychee.com/llms.txt and run402.com/llms.txt

### F14. Analytics
- [ ] GA4 property active for kysigned.com under Kychee account
- [ ] Key events firing: envelope created, signature completed, envelope completed, credit purchased
- [ ] Conversion goals configured: visitor → envelope, visitor → credit purchase, visitor → repo clone

### F15. Geo-Aware Cookie Consent
- [ ] EU/UK/BR/CA/CH/California visitors see the consent banner; US (non-CA) visitors do not
- [ ] When IP geolocation fails, banner is shown (fail-safe to compliant)
- [ ] GA4 does not load until consent is recorded in jurisdictions that require it
- [ ] Banner has Essential/Analytics/Marketing toggles, default-off for non-essential
- [ ] "Reject all" is as prominent as "Accept all"
- [ ] Consent persists in `localStorage` as `kychee_consent`
- [ ] Footer "Cookie settings" link re-opens the panel

### F16. Signed PDF: Proof Blocks, Aggregation & Resend
- [ ] Each signer's proof block in the approval page contains: name, date, QR code (operator verify URL), and verification key string (chain, contract, searchKey, envelopeId)
- [ ] QR code domain is configurable per deployment (`operatorDomain`) — forkers set their own
- [ ] Verification key string contains ONLY on-chain data (no operator URL) — sufficient for stateless verification even if the operator disappears
- [ ] Proof block shows "signed" state with full data for completed signers
- [ ] Proof block shows "waiting" state for pending signers on active envelopes
- [ ] Proof block shows "did not sign" state for pending signers on expired/voided envelopes
- [ ] Standalone validator in public repo accepts a PDF, reads proof block data, queries on-chain records, and reports verification results
- [ ] An AI agent given the verification key string from a proof block can independently verify the signature by calling `getReplyToSignRecords(searchKey)` on the contract
- [ ] Dashboard groups envelopes by `(document_hash, sender_identity)` into a single "document" view
- [ ] Aggregated signed PDF contains proof blocks for ALL signers across ALL envelopes for the same document
- [ ] Aggregated signed PDF is automatically generated and sent in the completion email when all intended signers have signed (across one or more envelopes)
- [ ] Aggregated signed PDF can be regenerated anytime from the dashboard
- [ ] "Resend to missing" creates a new envelope with same PDF and only the signers who didn't sign in previous envelopes
- [ ] When uploading a PDF whose hash matches an existing document with incomplete signers, the system suggests sending to only missing signers
- [ ] Each resend is billed at the standard per-envelope rate
- [ ] After resend completes, the aggregated signed PDF is regenerated to include all signers across all envelopes

### F17. Pre-Launch Dark-Launch Canary Discipline
- [ ] Canary KMS wallet is provisioned under the kysigned run402 project separately from the eventual production wallet; the two wallets have distinct deployer EOAs
- [ ] Canary `SignatureRegistry` and `EvidenceKeyRegistry` deploy to Base mainnet via the canary KMS wallet and compile from the same Solidity source as the production contracts
- [ ] Canary contract source is NOT submitted to Basescan for verification; the contracts are visible as bytecode only
- [ ] Canary KMS wallet has no name tag, no identifying metadata, and no public reference linking it to kysigned at provision time
- [ ] kysigned-private is deployed to production with contract addresses and KMS wallet pointing at canary references for the duration of the canary phase
- [ ] At least one end-to-end reply-to-sign envelope is created via each of: the hosted dashboard, the REST API, and the MCP server during the canary phase
- [ ] Reply-to-sign flow exercised end-to-end against canary contracts: email reply → DKIM verification → zk proof → on-chain recording → verification page confirms
- [ ] Parallel and sequential signing flows both exercised end-to-end against canary contracts
- [ ] The verification page correctly verifies a canary-signed envelope using only the canary contract addresses
- [ ] Ephemeral PDF retention triggers as expected on at least one canary envelope (F8.6 rule holds on the canary deployment)
- [ ] The canary exercise checklist (enumerated in kysigned-plan.md) reaches 100% green before any flip is considered
- [ ] The go/no-go human gate is explicitly invoked with a summary of the checklist status and demands an APPROVE / ABORT / KEEP TESTING decision; no automatic advancement
- [ ] Production KMS wallet is provisioned and production contracts are deployed only AFTER the go/no-go APPROVE
- [ ] Byte-identical bytecode gate for BOTH contracts: `eth_getCode(canary)` and `eth_getCode(production)` match beyond the Solidity metadata suffix; the flip is blocked until both checks pass
- [ ] Flip consists of updating contract addresses and KMS wallet in the service configuration and redeploying kysigned-private; no application code changes are bundled with the flip
- [ ] One smoke-test envelope completes end-to-end against the production contracts immediately after the flip
- [ ] Canary wallet is drained back to the ops wallet within 24 hours of the successful flip
- [ ] KMS key deletion is scheduled on the canary KMS key within 24 hours of the successful flip
- [ ] Canary contract addresses and canary wallet address are stored exclusively in AWS Secrets Manager under `kysigned/canary-*`; a repo-wide `grep` of both the public `kysigned` and private `kysigned-private` repositories returns zero matches for any value
- [ ] Phase 14 checklist includes a pre-squash working-tree scan for canary addresses + canary wallet in the public `kysigned` repo; the private→public flip is aborted if the scan finds any value
- [ ] The `SignatureRegistry — Base mainnet` and `EvidenceKeyRegistry — Base mainnet` rows in the Shipping Surfaces table are not updated from `<TBD>` until the production contract deploy completes, which cannot happen before the canary phase ends

### F18. Testing
- [ ] Public repo integration tests hit a live run402 instance (testnet) and exercise the actual API surface a forker would use
- [ ] Integration tests use `kysigned init` (or equivalent) as the setup step — same flow a real forker follows
- [ ] MCP integration tests call real MCP tool handlers against a live kysigned API endpoint (not mocked)
- [ ] Integration tests exercise BOTH directions: toward run402 (T1 infra) AND toward kysigned's own CLI/MCP/API users (product interface)
- [ ] Integration tests can be pointed at any deployment via `KYSIGNED_ENDPOINT` env var (local, testnet, production)
- [ ] `[service]` Stripe end-to-end test: magic link → checkout → credits → envelope creation → balance deduction (Stripe test mode, test card tokens)
- [ ] `[service]` Stripe test follows the same patterns used in run402's billing tests and other Kychee Stripe-integrated products
- [ ] All payment-related integration tests use testnet currencies (T1) or Stripe test mode (T2) — no mainnet funds or real charges required
- [ ] Integration tests are gated by env vars and skip cleanly when the environment is not configured
- [ ] `[service]` Hosted service bootstraps using the public repo's setup flow (dogfooding — F10.12)

## Constraints & Dependencies

- **run402 platform:** kysigned runs on run402 infrastructure. run402 handles T1 (app-owner pays for infrastructure). T2 (end-users pay the app) is NOT provided by run402 — kysigned.com uses its own Stripe integration for end-user billing. Self-hosted forkers use `allowed_senders` to gate access and absorb infrastructure costs (no built-in T2 billing for forkers).
- **run402 magic link auth:** Hosted service requires magic link authentication. Confirmed available (shipped in Phase 0).
- **Kychee Stripe account:** kysigned needs its own Stripe product/price configuration under the Kychee Stripe account for T2 end-user billing (credit pack purchases). This is separate from any run402 Stripe integration.
- **run402 email service (outbound):** Repo forkers rely on run402 email service (paid) or bring their own. Email deliverability reputation is critical — signing requests in spam is product-killing.
- **run402 email service (inbound):** Reply-to-sign requires an inbound email surface that delivers raw RFC-822 MIME with DKIM headers preserved. Confirmed present on run402 (SES receipt rule → S3 → `packages/email-lambda/inbound.mjs` → Postgres; raw MIME persisted in S3 via `s3_key`). Two small enhancements needed: (a) raw-MIME API accessor on `GET /v1/mailboxes/:id/messages/:msgId` returning S3 bytes, (b) inbound routing on kysigned custom sender domain (or MVP ships on `reply-to-sign@mail.run402.com`). These are tracked as a parallel run402 openspec change.
- **run402 custom domains:** Repo forkers can use subdomains (acme-sign.run402.com) or custom domains (acme-sign.com). Outbound custom sender domains confirmed available (shipped in Phase 0). Inbound custom domain routing is the enhancement tracked above.
- **zk-email circuit:** Reply-to-sign requires a zk-email circuit that produces a zk-SNARK over a DKIM-signed email. Candidate: adopt or customize from [prove.email](https://prove.email). Circuit must match our exact public-input shape (searchKey commitment, subject format, `I APPROVE` body marker, first-non-quoted-line detection). Audit strategy TBD.
- **~~DNSSEC proof chain capture:~~** REMOVED (v0.9.1). Major providers (Gmail, Outlook, Yahoo) don't have DNSSEC. The zk proof itself proves key correctness; key consistency across signatures provides non-repudiation (F4.9). DNSSEC is omitted from MVP.
- **Slow-KDF parameters:** `searchKey = SlowHash(email || docHash)` requires committing forever to a specific KDF algorithm and parameters. Must be chosen carefully — too fast enables enumeration, too slow degrades verifier UX. Candidate: argon2id with parameters tuned for ~1 second on consumer hardware.
- **Base gas costs:** Per-signer gas cost estimated at ~$0.02 (RISC Zero Groth16 wrapper verification on Base, ~280k gas). Pricing: $0.29 base (2 signers) + $0.10/extra signer. Re-measure on Sepolia/mainnet canary to confirm. Previous PLONK estimate ($0.05, ~298k gas) replaced per zkprover v0.1.0 comparison matrix.
- **Smart contract deployment:** `SignatureRegistry` and `EvidenceKeyRegistry` must be deployed on Base mainnet before any production signing. Both contracts are immutable once deployed.
- **Existing legal templates:** Legal documents drafted from existing Kychee/Eleanor/run402 templates. All `[service]` legal docs require human approval.
- **No "kill" language:** All public-facing materials use "alternative to," "replace," "switch from," "better than." Internal docs may use competitive framing.

## Open Questions

### New (from signature-binding rework)

1. **zk-email circuit adoption vs customization.** Can we adopt a circuit from prove.email directly, or do we need to customize for our public-input shape (`I APPROVE` marker, subject format, first-non-quoted-line rule)? Audit strategy and cost?
2. **~~DNSSEC proof chain capture.~~** RESOLVED (v0.9.1). DNSSEC removed from MVP. The zk proof proves key correctness; key consistency across signatures provides non-repudiation (F4.9).
3. **`Subject` not in DKIM `h=`.** Some mail providers do not include `Subject` in DKIM-signed headers. What fraction of real-world email is affected? Do we reject cleanly with a helpful message, or find an alternative binding?
4. **DKIM key rotation race.** A reply's DKIM header specifies the selector. The operator must fetch the exact key version at the time of reply. Implementation detail but operationally important.
5. **Slow-KDF parameters.** Exact algorithm (argon2id vs scrypt vs PBKDF2) and parameter values. Fixed forever once committed. Must be expensive enough to resist a 1000x hardware speedup while remaining tolerable (~1s) for a legitimate verifier.
6. **Explicit decline phrase.** Should `I DECLINE` be a first-class decline action, or is "do not reply" the only decline path?
7. **Retry UX for non-delivery.** Replies can bounce or be filtered. What does the nudge/re-send flow look like?
8. **Consent language review.** Who reviews the email copy, "how it works" page, and approval page wording before launch? Legal expertise required.
9. **Dispute scenarios — PARTIALLY RESOLVED (v0.9.1).** Signer repudiation analysis:
   - **Scenario:** Bob signed, then claims the operator fabricated his signature using a fake DKIM key (after the real key rotated out of DNS).
   - **Defense (trusted operator):** No issue — the operator is trusted, the zk proof exists, the key is archived on-chain with `block.timestamp`.
   - **Defense (untrusted operator):** The operator would need to fabricate ALL DKIM signatures from Bob's provider (e.g., Gmail) during the key period, because every legitimate signing references the same `keyId`. A single legitimate Gmail signature from any other user during the same period corroborates the key. The on-chain `keyId = keccak256(domain, selector, publicKey)` is the anchor — all proofs referencing it are mutually corroborating.
   - **Defense (multiple operators):** If multiple independent operators share the canonical `EvidenceKeyRegistry`, each independently verifies and registers the same key. Fabrication by one operator is immediately detectable as an outlier. This is the strongest form and requires no protocol change — only adoption.
   - **Remaining scenarios** (sender forgery, future crypto break, duress) still open — lock before launch.
10. **Internationalization of `I APPROVE`.** English-only for MVP. Future consideration for localized signing phrases.
11. **Internal future-features note.** Create a separate internal file tracking: OAuth-based identity verification, wallet co-signature as additive proof, visible signature blocks, alternative delivery channels (WhatsApp etc.). Not in public repo, not mentioned publicly.

### Carried forward (unchanged)

12. **Envelope expiry default** — 30 days assumed; notification sequence before deletion TBD.
13. **PDF retention cost model** — future paid retention: per-GB/year rate, tiers.
14. **Multi-signature PDFs** — post-MVP. UX and hash structure for per-page/per-section signatures.
15. **run402 prepaid credit model** — does run402 support buy-credits-and-deduct-per-call? If not, scope needed.
16. **Email deliverability strategy** — dedicated sending domain, IP warm-up, deliverability monitoring.
17. **~~Certificate of Completion design~~** — RESOLVED (v0.11.0). Renamed to "approval page" with per-signer proof blocks (F16). Design: QR code + verification key string per signer, document metadata, operator identity.
18. **Credit pack tiers and pricing** — optimize after gas costs are known.
19. **Future: run402 T2 payment collection (DEFERRED)** — see original OQ #17 text.

### Carried forward (F17 canary — unchanged)

20. **F17 run402 capability gaps** — two KMS wallets per project, bytecode return on deploy, rate-limiting on provision-wallet. Facts to discover before canary execution.
21. **F17 byte-identical bytecode check mechanism** — deferred to plan; spec commits to the gate being hard.
22. **F17 canary checklist contents** — plan enumerates; candidate items now include: reply-to-sign end-to-end via each surface, evidence key registration, zk proof generation, verification page, parallel + sequential signing, ephemeral PDF retention, approval page generation with proof blocks.
23. **F17 bytecode-divergence playbook** — deferred to plan.
24. **F17 production-contract smoke specifics** — deferred to plan.

## Future Features (removed from MVP)

The following features were part of earlier spec versions and have been moved here for potential future implementation. They are NOT in scope for the current MVP.

### Wallet-Based Payment (formerly Path 1/2)

> **Removed in v0.12.0.** Sender authentication via x402/MPP payment header with wallet address as identity. Users would pay per-envelope in USDC on Base directly from their wallet. Included wallet onboarding flow on the website.
>
> **Why removed:** MVP simplification. Stripe credit packs are a lower-friction payment mechanism for the target audience. Wallet-based payment adds complexity (wallet onboarding, USDC funding, gas management) without proportional value for MVP users. Forkers who want wallet-based billing can implement it themselves using the `allowed_senders` authorization primitive.
>
> **Revisit when:** There is demonstrated demand from users who want to pay with crypto, or when run402 ships native T2 billing that makes wallet-based payment trivial to wire.

### Wallet Signing (formerly Method B / EIP-712)

> **Removed in v0.12.0.** Signer proves identity by signing an EIP-712 typed-data struct with their Ethereum wallet. Was available in the public repo behind a feature flag (`VITE_ENABLE_WALLET_SIGNING`).
>
> **Why removed:** Reply-to-sign is the only signing method needed for MVP. Wallet signing adds complexity (wallet detection, onboarding panel, EIP-712 UI, identity binding gap documentation) and serves a niche audience (crypto-native parties who already have wallet ↔ identity binding established externally). The `recordWalletSignature` function remains in the deployed smart contract (immutable, cannot be removed) and can be re-enabled in a future version.
>
> **Revisit when:** A credible global crypto-identity initiative (e.g., a widely-adopted DID/verifiable credential system) makes wallet ↔ identity binding straightforward, or when a significant forker audience requests it.
