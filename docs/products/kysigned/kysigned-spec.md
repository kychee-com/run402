---
product: kysigned
version: 0.9.0
status: Draft
type: product
interfaces: [website, api, cli, mcp, smart-contract]
created: 2026-04-04
updated: 2026-04-10
---

## Overview

kysigned is a blockchain-verified e-signature service that replaces DocuSign's subscription model with per-envelope pricing (~$0.39/envelope). Signers sign by replying to an email with `I APPROVE` — their mail provider's DKIM signature provides cryptographic proof of mailbox control, which is captured as a zk-email proof and recorded on Base (Ethereum L2). A verifier given `(email, document)` any time in the next ~20 years can independently confirm the signature using only on-chain data and the publicly-archived IANA DNSSEC root — no dependency on kysigned.com, run402, or any operator being reachable. Two delivery modes: a hosted API at kysigned.com (`[service]`) and a free MIT-licensed repo deployable on run402 (`[repo]`).

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
- F1.2. Up to 5 signers included per envelope. Additional signers incur a per-signer surcharge (reflecting real gas costs).
- F1.3. Sender specifies signing order: parallel (default — all signers can sign in any order) or sequential (signers are notified one at a time in the specified order).
- F1.4. All signers use the same signing method (reply-to-sign). No per-signer signing options in MVP.
- F1.5. Envelope lifecycle statuses: draft, active, completed, expired, voided.
- F1.6. Sender can void an active envelope (cancels all pending signing requests, notifies signers).
- F1.7. Envelope expiry: configurable TTL (default TBD, validated against cost). Expired envelopes notify all parties and cannot be signed.
- F1.8. Webhook/callback URL: sender provides a URL that receives a POST when the envelope is completed.
- F1.9. `[service]` Signing is email-reply-based: each signer receives a signing email and signs by replying with `I APPROVE`. The operator delivers the signing email; there are no separate "signing links" for the reply-to-sign method. A review link (read-only document preview) is included in the signing email and can be shared via any channel, but the signing act itself requires an email reply from the signer's real mailbox.
- F1.9.1. `[repo]` The public repo also supports wallet-based signing (Method B / EIP-712) for forkers who have externally established wallet ↔ identity binding. Forkers may offer signing links that lead to the wallet-signing page. The hosted service at kysigned.com does NOT expose wallet signing to signers.
- F1.10. **Sender as signer:** If the sender also needs to sign the document, they must add themselves to the signer list. There is no "pre-sign at creation" flow. The sender signs through the same process as every other signer (same link, same verification, same on-chain proof). This ensures a uniform audit trail — every signature event is identical regardless of who initiated the envelope. The UI should make this clear: when creating an envelope, prompt "Will you also sign this document?" and auto-add the sender to the signer list if yes.

### F2. Sender Authentication & Access Control `[both]` / `[service]`

**Context — T1 vs T2 payments:** run402 handles T1 (app-owner pays run402 for infrastructure). T2 (end-users pay the app operator) is **deferred** — run402 does not yet provide a billing layer that lets apps charge their users. Until T2 is available, each kysigned deployment must handle its own user charging (if any) AND gate access so random internet users can't drain the operator's run402 balance on gas and emails.

Three sender paths, all MVP. Each serves a different audience.

- F2.1. **Path 1 — Has wallet** `[both]`: Sender authenticates via x402 or MPP payment header. Wallet address is identity. No account, no signup, no API key. The wallet pays the x402/MPP fee directly — this is the closest thing to native T2 in the MVP.
- F2.2. **Path 2 — Creates wallet** `[both]`: Same as Path 1 after wallet onboarding. Website guides user through wallet creation and funding. One-time setup.
- F2.3. **Path 3 — No wallet (prepaid credits)** `[service]`: Sender pays via Stripe for prepaid credit packs. Identity is email address. Authentication via magic link (email-based, no password). Per-envelope cost deducted from credit balance. **Path 3 is kysigned's own billing layer — kysigned operates as a T2 reseller using its own Stripe integration, not run402's billing.**
- F2.4. Path 3 magic link authentication: user enters email, receives a one-time login link, no password required. No "Sign in with Google" or social login.
- F2.5. Path 3 checkout experience is branded as kysigned (not run402). kysigned uses its own Stripe integration.
- F2.6. **All three paths produce the same on-chain proof.** Regardless of how the sender pays kysigned (wallet via x402/MPP, or Stripe credits), the kysigned server always submits the on-chain transaction using a **platform wallet**. This is because signers typically sign asynchronously (hours or days after the sender creates the envelope), so the server must submit on everyone's behalf. `[repo]` For wallet signing (Method B), the signer's EIP-712 signature is passed to the server and verified on-chain via `ecrecover` — the signer's address ends up recorded on-chain even though the platform wallet submitted the transaction. No second-class experience for any path.
- F2.7. Confirm that run402 supports magic link authentication for Path 3 identity. If not, implement as part of kysigned service.

#### F2.9 Money Flow (revenue in, costs out)

**Revenue (USDC or fiat → kysigned):**
- **Path 1/2 (wallet):** Sender's wallet sends USDC to the kysigned platform wallet via x402/MPP payment header. The x402 middleware verifies the payment and allows the request through. run402 is the protocol layer, not a payment intermediary — funds go directly to kysigned's wallet.
- **Path 3 (no wallet) `[service]`:** Sender pays fiat to kysigned's own Stripe account. Funds settle to Kychee's bank account. Credit balance is tracked in the kysigned database and deducted per envelope. **Kychee is the merchant of record for Path 3.** run402 does NOT act as a Stripe intermediary in the MVP.

**Costs (kysigned → Base blockchain):**
- **All paths:** The kysigned platform wallet pays ETH gas for each contract call (`recordSignature`, `recordWalletSignature`, `recordCompletion`, and occasional `registerEvidenceKey`). The platform wallet holds both USDC (from Path 1/2 revenue) and ETH (for gas). kysigned tops up ETH as needed.
- Per-envelope gas cost: ~$0.01-0.20 at typical Base gas prices (varies with zk-proof size and gas price fluctuations).

**What run402 charges kysigned for (T1 — infrastructure):**
- Compute and database hosting
- Email sending (SES via run402)
- **KMS contract wallet rental: $0.04/day per wallet ($1.20/month).** Platform wallet provisioned via `POST /contracts/v1/wallets`. Private keys never leave AWS KMS. Includes lifecycle management (suspension on unpaid rent, optional recovery address, drain endpoint). 30-day prepay ($1.20) required at creation.
- **Contract call KMS sign fee: $0.000005 per call** (the only run402 markup on contract calls). Chain gas is at-cost — kysigned still pays its own ETH gas to Base, billed as a `contract_call_gas` ledger entry with 0% markup.
- Custom domain serving

**What run402 does NOT currently provide (T2 — end-user billing, deferred):**
- Stripe-collection-as-a-service: run402 does not accept Stripe payments from kysigned's end users on kysigned's behalf. kysigned operates its own Stripe account for Path 3. If run402 adds this capability post-MVP, Path 3 could migrate to use it (Open Question #17).
- Note: Path 1/2 does NOT need run402's T2 — x402/MPP is already a native T2 mechanism (user wallet pays app wallet directly, per-call).

**Per-envelope margin illustration (approximate, at $0.39/envelope target):**
- Path 1/2: sender pays ~$0.39 USDC → kysigned wallet; kysigned spends ~$0.01-0.20 ETH on gas; net ~$0.19-0.38 per envelope.
- Path 3: sender pays ~$0.39 fiat → kysigned Stripe; Stripe fees ~$0.03; gas ~$0.01-0.20; net ~$0.16-0.35 per envelope.

#### F2.10 Forker Billing (public repo)

- F2.10.1. **The public repo ships Path 1/2 only.** Stripe integration (Path 3) lives in the service repo and is NOT included in the public MIT-licensed repo. Forkers get wallet-native billing out of the box.
- F2.10.2. **No "insert your Stripe key here" pattern.** A forker who wants to charge their own users in fiat must build their own billing layer on top — the `allowed_senders` table (F2.8) provides the authorization primitive they can hook into.
- F2.10.3. **Rationale:** Keeping Stripe out of the public repo avoids forcing forkers to manage PCI compliance, merchant-of-record liability, and Stripe account lifecycle. Wallet-native billing is simpler, legally cleaner, and aligns with the product's blockchain-first positioning.
- F2.10.4. **Most forkers (internal use) don't need billing at all.** A law firm or small agency deploys kysigned for their employees, pays run402 for infrastructure, and uses `allowed_senders` to gate access. No user billing required. This is the intended primary use case for forkers.

#### F2.8 Sender Access Control (`allowed_senders`) `[both]`

**Critical:** Without this, a deployed kysigned instance is an open relay — anyone on the internet can call `POST /v1/envelope` and spend the operator's run402 balance on gas and emails. This feature is mandatory for every deployment.

- F2.8.1. **Access control layer:** Every kysigned instance MUST have an authorization layer that gates the "create envelope" action. Authentication is provided by run402 (wallet, magic link, password, OAuth); kysigned adds authorization on top.
- F2.8.2. **`allowed_senders` table:** Each instance stores a list of authorized sender identities — wallet addresses, email addresses, or role names. Schema:
  ```
  allowed_senders (
    id UUID PRIMARY KEY,
    identity TEXT NOT NULL,       -- wallet address or email
    identity_type TEXT NOT NULL,  -- 'wallet' | 'email' | 'role'
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
- F2.8.7. **kysigned.com SaaS mode:** The hosted service at kysigned.com uses `allowed_senders` with a special rule: any user with sufficient Path 3 credit balance (or a funded wallet for Path 1/2) is effectively allowlisted for envelope creation. The gate is "has credits" rather than "on an explicit list". Implementation: the enforcement check is pluggable — hosted mode swaps the allowlist check for a credit-balance check.
- F2.8.8. **Forked/self-hosted mode:** A forker (e.g., a law firm) deploys kysigned and maintains an explicit `allowed_senders` list (employees, contractors). No end-user payment — costs absorbed by the operator. The operator gets a clean internal tool.
- F2.8.9. **Deployment documentation:** The README and self-hosting guide MUST prominently warn: "Before going live, configure your `allowed_senders` list or your instance is open to abuse. Default-deny is enforced, but you must explicitly add your first sender."
- F2.8.10. **Future T2 path:** If/when run402 adds native end-user billing (T2), kysigned can optionally shift from Stripe-based Path 3 to using run402's billing layer, and the access control can shift from "explicit allowlist" to "any user with sufficient credits in the run402 customer account." This is a post-MVP enhancement; the `allowed_senders` feature stays in place as the generic authorization primitive.

### F3. Signing Experience

What happens when a signer receives and acts on a signing request.

#### F3.A Reply-to-Sign (email DKIM) `[both]`

The primary signing method. Used by the hosted service and available in the public repo.

- F3.1. `[both]` Signer receives an email from the operator with: the document name, the sender's name, the document hash (`docHash`), the envelope ID, a review link (read-only document preview), and clear instructions to sign by replying with `I APPROVE`.
- F3.2. `[both]` The review page renders the PDF in the browser using pdf.js. The page displays the `docHash` prominently and provides a client-side hash verification tool ("verify this document's hash in your browser"). The review page is read-only — it does not complete a signature.
- F3.3. `[both]` **The signing act:** the signer replies to the signing email from their own mailbox with `I APPROVE` (case-insensitive, punctuation-tolerant) as a standalone line above any quoted content. The reply goes to `reply-to-sign@<operatorDomain>` (a single inbound address, not per-envelope). The signer's mail provider DKIM-signs the outbound reply — this is the cryptographic proof of mailbox control.
- F3.3.1. `[both]` **Subject line as binding:** the email subject carries the envelope ID and `docHash`. The subject must be present in the DKIM `h=` signed-headers list. The zk-email circuit rejects any reply where `Subject` is not among the DKIM-signed headers.
- F3.3.2. `[both]` **`I APPROVE` validation:** the operator's inbound handler checks the reply body for `I APPROVE` as a standalone line above quoted content. Other replies (questions, blank, random text) are NOT treated as signatures. The operator auto-responds with guidance: "your reply did not match the signing format — to sign, reply with `I APPROVE`; to ask a question, contact the sender at [sender-email]."
- F3.3.3. `[both]` **zk-email proof generation:** the operator runs a zk-email circuit over the raw DKIM-signed reply. The circuit produces a zk-SNARK proving: (a) a valid DKIM signature exists by the signer's mail provider's key, (b) `Subject` is in the DKIM `h=` list, (c) the `From:` header hashes to a committed email hash, (d) the subject contains the envelope ID and `docHash`, (e) the body contains `I APPROVE` as a standalone line. The raw email is discarded after proof generation.
- F3.3.4. `[both]` **Bait-and-switch protection is native.** The `docHash` is in the DKIM-signed email the signer received and replied to. The zk circuit binds the signature to the exact hash present in the email. An operator cannot stage a different document — the reply's DKIM signature covers the hash the signer actually saw.
- F3.4. `[both]` **No visual signature blocks in MVP.** Signers do not draw or click a visual signature. The signing act is the email reply. Visual signature blocks (drawn handwriting, auto-stamp) are deferred to a future feature.
- F3.5. `[both]` After signing is confirmed (zk proof generated, on-chain record written), the operator sends a confirmation email to the signer with the transaction hash and a proof link.
- F3.6. `[both]` **Decline:** a signer who does not wish to sign simply does not reply. There is no explicit decline action in the MVP. Envelope expiry (F1.7) handles the timeout case. The sender is notified when the envelope expires with incomplete signatures.
- F3.7. `[both]` **Duplicate signing protection:** if the operator receives a second valid `I APPROVE` reply from the same signer for the same envelope, the first is used and subsequent replies are no-ops. The operator responds with "you have already signed this document."

#### F3.B Wallet Signing (Method B / EIP-712) `[repo]`

Available in the public repo for forkers who have externally established wallet ↔ identity binding. NOT exposed by the hosted service at kysigned.com.

- F3.8. `[repo]` Signer clicks a signing link, signing page detects browser wallet (MetaMask, Coinbase Wallet, etc.). Page calls `eth_signTypedData_v4` with a DocumentSignature struct. Signer's own wallet displays human-readable signing details (document name, hash, email, envelope ID, timestamp). Server records signer's Ethereum address on-chain via `ecrecover`.
- F3.8.1. `[repo]` **Cryptographic gap — clearly documented.** Method B proves "wallet address X signed document Y." It does NOT prove "the person who controls email Z also controls wallet X." The `signerEmail` field in the EIP-712 struct is a caller-chosen label — anyone with the wallet private key can sign and claim any email. Forkers who use Method B are responsible for establishing the wallet ↔ identity binding externally (e.g., via their own KYC, internal directory, or prior authentication). This gap MUST be clearly stated in `docs/wallet-guide.md`, the README, and `LEGAL.md`.
- F3.8.2. `[repo]` Wallet onboarding documentation: `docs/wallet-guide.md` with two sections — "For Envelope Creators (Path 1/2)" (install + fund with USDC on Base) and "For Signers (Method B)" (install, no funding needed, only approving a message). Linked from README and `llms.txt`.
- F3.9. `[repo]` When a signer encounters wallet signing but has no wallet installed, the signing page shows a "How to get a wallet" panel with install guides and a note that no funding is needed.

### F4. On-Chain Recording `[both]`

Every signature event is recorded on canonical smart contracts on Base.

#### F4.A Contracts

- F4.1. **Two canonical contracts deployed on Base:** `SignatureRegistry` (signature records) and `EvidenceKeyRegistry` (DKIM public keys + DNSSEC proofs). All instances (service and repo deployments) record to the same contracts by default.
- F4.2. Contract addresses are constants in the repo code. Forkers can change them but have no incentive to (shared registry strengthens verification).
- F4.3. Both contracts are immutable once deployed: no owner, no admin, no upgrade mechanism, no proxy pattern. Append-only. No entry can be modified or deleted by anyone, including the deployer.
- F4.4. Both contracts accept permissionless writes — any funded EOA can submit records. For reply-to-sign, the contract verifies the zk proof against the referenced evidence key before accepting. Invalid proofs are rejected at write time. For wallet signing (Method B), the contract verifies the EIP-712 signature via `ecrecover` (unchanged from current).
- F4.5. Contracts are replaceable: new envelopes can be directed to new contracts at any time. Old records remain verifiable at old contract addresses forever. The verification page checks all known contract addresses.
- F4.6. Contract ABIs and verification algorithms are published and documented from day 1. Anyone can verify signatures independently without kysigned.com.

#### F4.B Evidence Key Registry (new)

- F4.7. `EvidenceKeyRegistry` stores DKIM public keys keyed by `keyId`. Each entry contains: provider domain, DKIM selector, raw public key bytes, a DNSSEC proof chain from the IANA DNSSEC root KSK down to the provider's `_selector._domainkey.<domain>` record, and a registration timestamp.
- F4.8. One entry per (provider, selector, key rotation). Amortized across all signatures using the same key. Registered on first encounter by any operator.
- F4.9. A 2046 verifier can independently confirm the key's authenticity by validating the DNSSEC chain against the IANA root KSK (archived globally and publicly by multiple independent parties).

#### F4.C Reply-to-Sign Recording `[both]`

- F4.10. **Record structure:** each reply-to-sign signature record contains:
  - `searchKey` — `SlowHash(email || docHash)` using a deterministic slow KDF with fixed parameters committed forever in the spec.
  - `docHash` — SHA-256 of the original document.
  - `envelopeId` — unique envelope identifier.
  - `evidenceKeyId` — reference to the DKIM key entry in `EvidenceKeyRegistry`.
  - `timestamp` — signing time.
  - Bulky data (zk proof bytes, public inputs) emitted via events, not stored in contract storage (cheaper gas, permanently retrievable from block history).
- F4.11. **Privacy:** `searchKey = SlowHash(email || docHash)` ensures: a verifier with both inputs finds the record; an observer with only an email cannot enumerate signatures (docHash space is 2^256); an observer with only a docHash faces slow-KDF cost to enumerate emails; cross-document records by the same signer are unlinkable. No email plaintext or stable email hash is on-chain.
- F4.12. **On write:** the contract verifies the zk proof against the referenced evidence key. Invalid proofs are rejected. Valid proofs are stored and the signature event is emitted.
- F4.13. **Submitted by the kysigned server via the platform wallet**, not by the signer. The signer's involvement ends when their DKIM-signed reply is received.

#### F4.D Wallet Signing Recording `[repo]`

- F4.14. `[repo]` **Method B recording (unchanged):** `recordWalletSignature(envelopeId, documentHash, documentName, signerEmail, timestamp, signature)`. Submitted by the server via the platform wallet. Contract recovers signer's Ethereum address via `ecrecover`. The `signerEmail` field is a caller-chosen label, NOT cryptographically bound to the wallet — see F3.8.1.

#### F4.E Completion Recording `[both]`

- F4.15. `recordCompletion(envelopeId, originalDocHash, finalDocHash, signerCount)`. Fires when all signers have signed. Links the original document hash to the final rendered PDF hash (which includes the certificate page).
- F4.16. `[repo]` Mixed methods per envelope: some signers can use reply-to-sign, others wallet signing (Method B), within the same envelope. The hosted service uses reply-to-sign only.

### F5. Verification `[both]`

Public, universal, vendor-independent signature verification — designed to work ~20 years from now with no dependency on any operator.

#### F5.A Verification procedure (reply-to-sign)

- F5.1. **Verification inputs:** `(email, document)`. The verifier must have both. There is no "lookup by email only" or "lookup by document only" — this is a deliberate privacy property.
- F5.2. Verification page at `/verify` accepts a PDF upload and an email address. It computes `docHash = SHA-256(pdf_bytes)` and `searchKey = SlowHash(email || docHash)`, then queries the canonical `SignatureRegistry` contract(s) for a matching record.
- F5.3. If a record is found, the page:
  1. Retrieves the zk proof from the signature event (block history).
  2. Looks up the `evidenceKeyId` in `EvidenceKeyRegistry` to get the DKIM public key + DNSSEC proof chain.
  3. Verifies the DNSSEC chain (against the IANA root KSK archived in the registry entry).
  4. Verifies the zk proof against the DKIM key with public inputs `(H(email), envelopeId, docHash)`.
  5. Displays result: "This email signed this document at [timestamp]. Verification is independent — it does not depend on kysigned.com or any operator."
- F5.4. Verification page is **universal**: it verifies ANY record on the canonical contracts, regardless of which instance (kysigned.com, acme-sign.com, etc.) created it.
- F5.5. **No discovery.** The verification page does NOT support "search by email" or "list all documents signed by X." The verifier must provide both inputs. This is not a limitation — it is the privacy guarantee.

#### F5.B Verification procedure (wallet signing) `[repo]`

- F5.6. `[repo]` For Method B records, verification is by `(documentHash, expectedSignerAddress)`. The contract's existing `verifyWalletSignature(documentHash, expectedSigner)` function returns true/false. The verification page also supports this mode.

#### F5.C Certificate of Completion and proof links

- F5.7. **Certificate of Completion:** generated as a certificate page appended to the final PDF on envelope completion (see F8). Includes: document name, original `docHash`, per-signer email + timestamp + tx hash, operator identity, verification instructions, QR code linking to the verification page.
- F5.8. Third-party verification: anyone with the signed PDF and a signer's email can independently verify against the blockchain. No dependency on any kysigned instance being online.
- F5.9. **Proof link:** `/verify/<envelopeId>` displays the full verification record for a completed envelope — signer count, signing dates, tx hashes, and direct links to each transaction on Basescan. No PDF upload required (the envelope ID is sufficient to query the contract for the completion record). This is the link shared in the completion email (F7.4).
- F5.10. **Owner verification (dashboard):** Full audit trail per signer — email, timestamp, tx hash. Available to the sender via the dashboard (F6).

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

Email is the core signing channel, not just a notification mechanism.

#### F7.A Signing email (outbound to signer)

- F7.1. `[both]` Signing email sent to each signer. Email includes: sender name, document name, `docHash`, envelope ID, a review link (read-only document preview), the `How it works →` link (F11.7), and clear instructions: "To sign, reply to this email with `I APPROVE` as the first line."
- F7.1.1. `[both]` The `Reply-To` header is set to `reply-to-sign@<operatorDomain>` (single inbound address for all envelopes). Envelope and signer identity are inferred from the reply's `From:` header and subject line.
- F7.1.2. `[both]` **Email tone:** privacy-first and deliberately non-scary. The primary call-to-action conveys "this is private, simple, and only findable by someone who already has both your email and the document." Legal and technical specifics live on the "how it works" page and in a collapsible footer — not in the primary signing instruction.
- F7.1.3. `[both]` **Consent language versioning.** Every user-facing string that constitutes signing intent (email body, subject line, auto-reply wording, certificate page wording, "how it works" page text) is versioned. The version in force at the time of signing is recorded alongside each envelope in operator state. Disputes can reference the exact text a signer was shown.

#### F7.B Inbound reply handling

- F7.2. `[both]` Operator receives replies at `reply-to-sign@<operatorDomain>` via the run402 inbound email surface (SES receipt rule → S3 → email-lambda → Postgres). Raw MIME is preserved in S3 with DKIM headers intact.
- F7.2.1. `[both]` The operator's signing handler retrieves raw MIME from S3 (NOT the parsed/cleaned `body_text`), validates DKIM, extracts subject and body, checks for the `I APPROVE` marker, and proceeds to zk proof generation (F3.3.3).
- F7.2.2. `[both]` Replies that do not match the signing format (wrong subject, missing `I APPROVE`, or extra content without `I APPROVE`) trigger an auto-reply: "Your reply did not match the signing format. To sign, reply with `I APPROVE` as the first line. To ask a question, contact the sender at [sender-email]."

#### F7.C Reminders, confirmation, and completion

- F7.3. `[both]` Automated reminders at configurable intervals (default: 3 days, 7 days after initial send). Sender can trigger manual reminders. Reminder emails repeat the signing instructions in the reply-to-sign format.
- F7.4. `[both]` Confirmation email sent to signer after their signature is recorded on-chain. Includes the transaction hash and a proof link.
- F7.5. `[both]` **Completion email** sent to all parties (sender + all signers) with: the final PDF (including certificate page, see F8), a proof link (`/verify/<envelopeId>`), and plain-text blockchain reference details (contract address, chain, tx hashes). Recipients can independently verify on any block explorer even if kysigned.com is unreachable.
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
- F8.4. **No visual signature blocks in MVP.** Visible signature images embedded in the document body (drawn handwriting, auto-stamp) are deferred to a future feature. The signing act is the email reply, not a visual mark on the document.
- F8.5. **Certificate page appended at completion.** On envelope completion, the operator automatically appends a certificate page to the final PDF. The certificate page contains: original `docHash`, envelope ID, per-signer email + timestamp + tx hash, operator identity, verification instructions, and a QR code linking to the verification page. This is purely cosmetic rendering — the cryptographic record is against the original `docHash`, not the rendered PDF. Zero friction for signers (they never see this page during signing) and zero opt-in for the sender (added automatically by default).
- F8.5.1. The completion record (F4.15) stores both `originalDocHash` (pre-certificate) and `finalDocHash` (post-certificate). A verifier computes `SHA-256(final PDF)`, looks up the completion record by `finalDocHash`, reads `originalDocHash`, then looks up signatures by `originalDocHash`.
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
- F8.10. Multi-signature PDFs (multiple signature fields per page or per section) are post-MVP. MVP supports one set of signature fields per signer per document.
- F8.11. **Security framing:** This ephemeral retention pattern is a deliberate security property, not just a feature. It is the primary mitigation for the risk that an attacker compromising kysigned's storage could exfiltrate document content. The smaller the window of retention, the smaller the breach blast radius.

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

- F11.1. Landing page led by the cost attack angle ("DocuSign charges $3-5 per signature. kysigned charges ~$0.39. Proof on the blockchain, not their servers."). No "kill" language.
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
  - What reply-to-sign signatures prove: "the signer's mail provider's DKIM key, archived on-chain with a DNSSEC proof chain, attested an outbound email from the signer's mailbox containing `I APPROVE` and the document hash." Not "person X signed."
  - What wallet signatures (Method B) prove and do NOT prove: "wallet address X signed document Y." The `signerEmail` field is a caller-chosen label, NOT cryptographically bound. Forkers must establish wallet ↔ identity binding externally. **This gap must be prominently documented.**
  - No guarantee of legal enforceability in any specific jurisdiction
  - Smart contract permanence disclaimer (recordings on Base are permanent, cannot be deleted or modified by anyone)
  - Future cryptographic break acknowledgment: DKIM RSA and zk-SNARKs could theoretically be broken by quantum computing; records from before a break are evaluated in historical context
  - Operator responsibility: the forker/deployer is responsible for their own privacy compliance, Terms of Service, and legal obligations — not Kychee
  - Excluded document types that cannot be e-signed under ESIGN/UETA (wills, codicils, etc.)
- F12.8. No product launch until all `[service]` legal documents are human-approved.
- F12.9. `[both]` **Consent language is versioned and legally reviewed.** Every user-facing string that constitutes signing intent is versioned (F7.1.3). Legal review required before launch — the exact email copy, "how it works" page text, and certificate page wording must be approved by someone with legal expertise.

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

### F16. Document-Level Aggregation View `[both]` — DEFERRED, full spec TBD

> **Status: concept-only — not yet specced for implementation.** Added 2026-04-08 to capture the idea surfaced while planning Phase 4B e2e tests. **Before this feature is implemented, `/spec kysigned` must be re-run to flesh out the full requirements and acceptance criteria.** Until then, the kysigned plan carries a placeholder Phase 2H marker pointing back here.

**The concept:** kysigned currently treats every envelope as an independent unit. When a sender (X) creates envelope E1 to get signers Y1, Y2, Y3 to sign a PDF, and E1 expires with only Y1 + Y2 signed, X's only recourse is to create envelope E2 with Y3 as the sole signer — paying again. E1 and E2 have the **same `document_hash`** (same PDF) but are unrelated in the current data model. The dashboard shows them as two separate envelopes; the verify page verifies each envelope independently; nothing in the product acknowledges that both envelopes are attestations of the same document.

This feature introduces a new conceptual layer above envelopes: the **document**. A document is identified by `(document_hash, creator_identity)` and aggregates all envelopes the creator has sent against that PDF. The aggregation enables:

- **Document history in the dashboard:** the sender sees "NDA.pdf" as a single row with a history trail (envelope 1 expired with 2/3 signed, envelope 2 completed with 1/1 signed) and a combined signer ledger across all envelopes.
- **Combined attestation view on the verify page:** when someone presents the final signed PDF, the verifier can check whether every intended signer has signed SOMEWHERE in the document's envelope history, not just in one specific envelope.
- **Creator UX hints:** when a creator uploads a PDF that already has attested envelopes, kysigned surfaces "this document was partially attested in envelope XYZ — only invite the missing signer this time?"
- **Optional — clearer cryptographic story:** each envelope still produces its own on-chain record (envelopes don't share signatures at the cryptographic layer; reply-to-sign and wallet signing both bind to envelope_id), but the off-chain aggregation surfaces a unified "document was attested by A + B via E1, and by C via E2" view to humans.

**Why deferred:** the full scope needs a brainstorm + spec pass to answer open questions:
- Does the `document_hash` aggregation key include the sender identity, or is any sender's attestation of the same PDF relevant? (probably sender-scoped to avoid cross-user leakage)
- How does the on-chain verification layer handle this? (probably unchanged — each envelope is verified independently; aggregation is a UI concern only)
- Does this interact with the F8.6 ephemeral PDF retention? (the PDF itself is deleted after completion; only the hash persists — aggregation works on the hash, so yes, compatible)
- Should the sender get a billing discount when re-sending the same document to fewer signers? (product decision — defer until we have data)
- New database entity: is it a materialized view over envelopes, or a first-class table with its own row per document? (affects the data model)
- New UI routes: `/dashboard/documents/:document_hash` and `/verify/by-document/:document_hash`?
- Email template: "envelope X for your document Y has expired — you've already collected M of N signatures on this document; would you like to re-send to only the missing signers?"

**Acceptance criteria:** TBD — see concept bullets above. Full AC to be drafted during the deferred `/spec` session.

### F17. Pre-Launch Dark-Launch Canary Discipline `[service]` + `[repo]`

> **Principle:** kysigned's first mainnet deploy of `SignatureRegistry.sol` is preceded by a dark-launch canary phase in which the full kysigned product (frontend + service + wallet + contract + email + dashboard + verification) operates in real production mode against an anonymous on-chain backend. The canary phase continues until every feature on a concrete checklist is fully green AND Barry+Tal explicitly approve via a ceremonial go/no-go step. "Launch" then becomes a relabel operation — two environment variables flip from canary references to production references, no application code change — not a fresh deploy. This discipline is kysigned's instantiation of the saas-factory factory-level practice (saas-factory spec F25 — pending spec update alongside this one).
>
> **Why:** kysigned is run402's first production consumer of the KMS-wallet contract-deploy path (drain endpoint, recovery address, 90-day KMS deletion lifecycle, KMS-signs-arbitrary-transaction flow — all with zero production test coverage). A botched first launch is cheap in cash (~$5 of gas) but reputationally permanent (a verified-on-Basescan kysigned-branded contract is forever, even after redeploy). The canary decouples these risks: exercise every untested code path against an anonymous backend first, then "launch" by relabeling when confident.

- F17.1. **Two separate KMS wallets under the kysigned run402 project.** Canary wallet is ephemeral (provisioned fresh per canary session, drained and KMS-deletion-scheduled at session end). Production wallet is long-lived (the address that lives on for every real envelope post-launch). The two wallets must not share a deployer EOA — the canary contract's `Contract Creator` on Basescan must be a distinct address from the production contract's, so linking the two requires real OSINT work rather than a single click.
- F17.2. **Canary and production contracts compile from identical Solidity source.** The canary `SignatureRegistry` and `EvidenceKeyRegistry` contracts are not simplified, renamed, or otherwise-differentiated rehearsal contracts — they compile from the exact same source as the eventual production contracts. Identical bytecode is a feature, not a coincidence: it is the cryptographic guarantee that the canary rehearses the production path.
- F17.3. **Byte-identical bytecode gate at the flip moment.** Before flipping canary → production, the runtime bytecode of the canary contract (fetched via `eth_getCode` on the canary address) MUST be compared against the runtime bytecode of the freshly-deployed production contract (fetched via `eth_getCode` on the production address). If they differ in anything beyond the Solidity metadata suffix (the compiler-hash tail), the flip MUST be aborted and the divergence investigated. A matching bytecode pair is a hard pre-flip gate — no flip without it.
- F17.4. **No Basescan source verification for the canary contract.** The canary contract is deployed to Base mainnet but its source is never submitted to Basescan. External observers see bytecode only. The production contract IS submitted for Basescan verification.
- F17.5. **No kysigned branding in canary deploy artifacts.** The canary KMS wallet has no name tag referencing kysigned; the canary contract has no Basescan name tag referencing kysigned; the canary deploy transaction carries no identifying metadata linking it to kysigned. The only public information about the canary contract is its bytecode.
- F17.6. **kysigned-service runs in full production mode against canary references during the canary phase.** The same kysigned-service deployment that will eventually be used for the launch is configured with two environment variables — `KYSIGNED_CONTRACT_ADDRESS` pointing at the canary contract address and `KYSIGNED_KMS_WALLET` pointing at the canary KMS wallet — for the duration of the canary phase. No separate staging environment. No mock data. Real frontend, real SES, real PDF rendering, real dashboard, real verification.
- F17.7. **The canary phase exercises the full product via the full set of surfaces.** At least one end-to-end envelope MUST be created via each of: the hosted dashboard, the public REST API, and the MCP server. The reply-to-sign flow (email reply → DKIM verification → zk proof → on-chain recording → verification), parallel signing, sequential signing, and the verification page MUST all be exercised at least once against the canary contracts. Wallet signing (Method B) is already tested against the existing Sepolia contract and does not need re-canary for the service (but the `[repo]` code path should be exercised once against the canary `SignatureRegistry` to confirm the rewritten contract still accepts EIP-712 records). The plan (kysigned-plan.md) enumerates the exact checklist; the principle here is that no feature from F1–F15 is exempt from canary exercise.
- F17.8. **Exit criterion = checklist fully green AND explicit human go/no-go.** The canary phase ends only when (a) every item on the canary checklist (enumerated in the plan) has been confirmed to work end-to-end against the canary, AND (b) Barry and Tal explicitly approve the flip via a ceremonial go/no-go prompt that presents the checklist summary and demands an explicit APPROVE / ABORT / KEEP TESTING decision. There is no automatic advancement. There is no time-boxing. A partial checklist does not unlock the flip, and a fully-green checklist does not itself trigger the flip — the human decision is independent and required.
- F17.9. **"Launch" is a relabel, not a deploy.** The launch moment consists of: (1) provision the production KMS wallet, (2) deploy the production `SignatureRegistry` contract via the production wallet, (3) run the F17.3 byte-identical bytecode gate, (4) flip the two kysigned-service environment variables from canary references to production references, (5) redeploy kysigned-service (config change only; no application code change), (6) send one smoke-test envelope through the production contract end-to-end, (7) drain the canary wallet back to the ops wallet, (8) schedule KMS key deletion on the canary KMS key. No application code ships on launch day — every line of code has already been exercised against the canary for the duration of the canary phase.
- F17.10. **The canary contract remains on-chain forever after retirement.** Because smart contracts are immutable, the canary contract cannot be deleted. What IS retired: the canary wallet (drained and KMS-deletion-scheduled), the service's environment variables (flipped to production), and every reference to the canary in AWS Secrets Manager (the `kysigned/canary-*` secrets can be deleted the day after the flip is confirmed stable). The canary contract itself becomes a bytecode-only artifact on Base mainnet with no known connection to kysigned.
- F17.11. **Anti-leakage discipline: single pre-squash working-tree scan at Phase 14.** The canary contract address and canary KMS wallet address are the single-point-of-failure secrets. The only control required to protect them is a working-tree scan of the public kysigned repository for both values, run as a Phase 14 plan checklist item immediately before the orphan-branch squash that precedes the private→public flip. If the scan matches either value anywhere in the tree, the flip MUST be aborted and the references removed. This single control is sufficient because (a) the public repo is private throughout the canary phase — references in the tree are internal state, not a leak, and (b) the Phase 14 squash creates a single `v1.0.0` orphan commit, wiping all prior history.
- F17.12. **Canary address storage: AWS Secrets Manager only.** The canary contract address and canary wallet address are stored exclusively in AWS Secrets Manager under the `kysigned/canary-*` namespace. They are NEVER committed to any repository — not the public `kysigned` repo, not the private `kysigned-service` repo — and are read at deploy time via environment injection from Secrets Manager.
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
- [ ] Path 1: API call with x402 payment header succeeds; wallet address recorded as sender identity; no account or API key required
- [ ] Path 1: API call with MPP payment header succeeds identically to x402
- [ ] Path 2: Website guides user through wallet creation; after wallet setup, user can send envelopes via Path 1
- [ ] Path 3: User purchases credit pack via Stripe; checkout page is branded as kysigned; credits appear in dashboard
- [ ] Path 3: Magic link login — user enters email, receives login link, clicks to authenticate. No password field. No social login.
- [ ] Path 3: Envelope creation deducts from credit balance; fails with clear error if balance insufficient
- [ ] Path 3: On-chain recording made via platform wallet is indistinguishable from Path 1/2 recording in verification results
- [ ] `allowed_senders` enforcement: unauthenticated `POST /v1/envelope` returns 403
- [ ] `allowed_senders` enforcement: authenticated requester NOT in allowlist returns 403
- [ ] `allowed_senders` default-deny: empty allowlist blocks ALL envelope creation
- [ ] Admin API: operator can add, remove, and list allowed senders
- [ ] Per-sender monthly quota: exceeding quota returns a clear error
- [ ] kysigned.com SaaS mode: users with sufficient credits bypass explicit allowlist (credit-balance check)
- [ ] Self-hosted mode: explicit allowlist with no credit check (internal use)
- [ ] Public repo does NOT contain Stripe integration code (Path 3 is `[service]` only)
- [ ] Path 1/2 sender without a wallet: README and wallet-guide.md explain how to install + fund a wallet with USDC on Base
- [ ] `docs/wallet-guide.md` exists in the public repo with sections for senders (Path 1/2) and signers (Method B) and is linked from README + llms.txt
- [ ] `[service]` FAQ has "Do I need a wallet to SEND?" and "Do I need a wallet to SIGN?" questions with clear, distinct answers (answer to the latter: "No — you sign by replying to an email")

### F3. Signing Experience — Reply-to-Sign
- [ ] Signer receives signing email with document name, sender name, `docHash`, envelope ID, review link, and `How it works →` link
- [ ] Signing email `Reply-To` header is `reply-to-sign@<operatorDomain>`; subject contains envelope ID and `docHash`
- [ ] Signer replies with `I APPROVE` (case-insensitive, punctuation-tolerant) → operator receives the reply with raw DKIM headers preserved
- [ ] Operator validates: DKIM signature is valid, `Subject` is in the DKIM `h=` signed-headers list, `From:` matches expected signer, body contains `I APPROVE` as standalone line above quoted content, subject contains correct envelope ID and `docHash`
- [ ] zk-email circuit produces a valid proof binding `H(email)`, `envelopeId`, and `docHash` to the DKIM signature; raw email is discarded after proof generation
- [ ] Signature record written to `SignatureRegistry` with correct `searchKey`, `docHash`, `envelopeId`, `evidenceKeyId`, zk proof in event
- [ ] Reply without `I APPROVE` (question, blank, wrong text) triggers auto-reply with guidance; no signature recorded
- [ ] Duplicate reply from same signer for same envelope: first is used, subsequent are no-ops with auto-reply "you have already signed"
- [ ] Signer who does not reply: envelope expires per F1.7; no explicit decline action required
- [ ] Review page renders PDF correctly in browser via pdf.js; displays `docHash`; provides client-side hash verification tool
- [ ] Confirmation email sent to signer after on-chain recording with tx hash and proof link

### F3. Signing Experience — Wallet Signing (Method B) `[repo]`
- [ ] `[repo]` Signer clicks signing link; page detects wallet; calls `eth_signTypedData_v4`; wallet displays human-readable DocumentSignature struct; Ethereum address recorded on-chain via ecrecover
- [ ] `[repo]` `LEGAL.md` and `docs/wallet-guide.md` clearly state the gap: Method B proves "wallet X signed doc Y" but NOT "wallet X = email Y"; forker must establish identity binding externally
- [ ] `[repo]` Signing page without wallet shows onboarding panel with install guides and "no funding needed" clarification

### F4. On-Chain Recording
- [ ] `SignatureRegistry` deployed on Base; accepts reply-to-sign records with valid zk proof; rejects records with invalid proofs
- [ ] `EvidenceKeyRegistry` deployed on Base; stores DKIM public keys with DNSSEC proof chains from IANA root
- [ ] Reply-to-sign signature record keyed by `searchKey = SlowHash(email || docHash)`; contains `docHash`, `envelopeId`, `evidenceKeyId`, `timestamp`; zk proof emitted as event
- [ ] Evidence key registered once per (provider, selector, rotation); DNSSEC proof chain validates against IANA root
- [ ] `[repo]` Method B (wallet) signature recorded via `recordWalletSignature` with correct signer address recovered via ecrecover
- [ ] Completion event recorded when all signers have signed, with correct `originalDocHash`, `finalDocHash`, and `signerCount`
- [ ] `[repo]` Mixed-method envelope: some signers use reply-to-sign, others wallet; all recorded; completion fires after all sign
- [ ] No entry on either contract can be modified or deleted after recording
- [ ] Both contracts are permissionless (any funded EOA can write) and ownerless (no admin functions)

### F5. Verification
- [ ] Verification page accepts `(email, document PDF)` as inputs; computes `searchKey`; finds matching reply-to-sign record
- [ ] Verification retrieves zk proof from event, looks up evidence key, verifies DNSSEC chain, verifies zk proof — all client-side or against on-chain data only
- [ ] Verification page is universal: verifies ANY record on the canonical contracts regardless of which instance created it
- [ ] No "search by email" or "list all docs signed by X" — verifier must provide both email and document
- [ ] `[repo]` Wallet signing verification: `verifyWalletSignature(documentHash, expectedSigner)` returns correct true/false
- [ ] Certificate page appended to final PDF includes `docHash`, envelope ID, per-signer audit trail, operator identity, verification instructions, QR code
- [ ] Third party with signed PDF + signer email can verify against the blockchain without any kysigned instance online
- [ ] Proof link (`/verify/<envelopeId>`) displays full verification record — signer count, dates, tx hashes, Basescan links
- [ ] Completion email includes proof link, contract address, chain name, and all tx hashes in plain text

### F6. Dashboard
- [ ] Path 1/2: connect wallet; dashboard displays all envelopes sent from that wallet
- [ ] Path 3: magic link login; dashboard displays all envelopes associated with that email
- [ ] Envelope list shows status, signer progress, dates for each envelope
- [ ] Per-envelope detail view shows full audit trail per signer (email, timestamp, tx hash)
- [ ] Resend/remind button sends a new signing email to pending signers (reply-to-sign format)
- [ ] Export envelopes as CSV or JSON
- [ ] `[service]` Credit balance, purchase history, and low-balance indicator visible for Path 3 users
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
- [ ] Completion email sent to all parties with final PDF (including certificate page), proof link, and blockchain reference details
- [ ] Spam notice displayed to sender in dashboard after envelope creation
- [ ] `[service]` Emails sent from dedicated kysigned.com domain with SPF/DKIM/DMARC
- [ ] `[repo]` Email provider is configurable (run402 email service or custom SMTP/API); inbound requires SES-compatible pipeline preserving raw MIME

### F8. PDF Handling
- [ ] PDF uploaded via API (base64 or URL); SHA-256 hash computed and returned in response
- [ ] Review page renders PDF correctly in browser via pdf.js
- [ ] No visual signature blocks embedded in document body (deferred to future feature)
- [ ] Certificate page automatically appended to final PDF on completion — contains `docHash`, envelope ID, per-signer audit trail, operator identity, verification instructions, QR code
- [ ] Completion record stores both `originalDocHash` (pre-certificate) and `finalDocHash` (post-certificate)
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
- [ ] Agent creates envelope via MCP with x402 payment; receives envelope_id and review links
- [ ] Agent checks envelope status via MCP; receives current signer statuses
- [ ] Agent verifies a document via MCP; receives verification results
- [ ] MCP endpoint configurable to point to any kysigned instance (self-hosted or hosted)
- [ ] kysigned.com/llms.txt exists and describes the product for agent discovery

### F11. Website
- [ ] Landing page loads at kysigned.com; leads with cost comparison, not blockchain jargon
- [ ] No "kill," "killer," or "killing" language appears anywhere on the site
- [ ] Dual CTA visible above fold: hosted service and GitHub repo
- [ ] "How it works" page at `/how-it-works`; entirely non-technical; no "blockchain," "DKIM," "hash," "zero-knowledge proof"; readable in under one minute
- [ ] Every signing email links to the "how it works" page
- [ ] Decision helper page explains SaaS vs repo tradeoffs for builders, end users, and agents
- [ ] Pricing page shows per-envelope cost (~$0.39), credit pack tiers, and comparison table vs competitors
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
- [ ] `[repo]` LEGAL.md present with disclaimers: reply-to-sign proof semantics, Method B wallet gap (prominently documented — "does NOT prove wallet X = email Y"), jurisdictional limitations, smart contract permanence, future crypto break acknowledgment, operator responsibility, excluded document types

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

### F17. Pre-Launch Dark-Launch Canary Discipline
- [ ] Canary KMS wallet is provisioned under the kysigned run402 project separately from the eventual production wallet; the two wallets have distinct deployer EOAs
- [ ] Canary `SignatureRegistry` and `EvidenceKeyRegistry` deploy to Base mainnet via the canary KMS wallet and compile from the same Solidity source as the production contracts
- [ ] Canary contract source is NOT submitted to Basescan for verification; the contracts are visible as bytecode only
- [ ] Canary KMS wallet has no name tag, no identifying metadata, and no public reference linking it to kysigned at provision time
- [ ] kysigned-service is deployed to production with contract addresses and KMS wallet pointing at canary references for the duration of the canary phase
- [ ] At least one end-to-end reply-to-sign envelope is created via each of: the hosted dashboard, the REST API, and the MCP server during the canary phase
- [ ] Reply-to-sign flow exercised end-to-end against canary contracts: email reply → DKIM verification → zk proof → on-chain recording → verification page confirms
- [ ] `[repo]` Wallet signing (Method B) exercised once against canary `SignatureRegistry` to confirm rewritten contract still accepts EIP-712 records
- [ ] Parallel and sequential signing flows both exercised end-to-end against canary contracts
- [ ] The verification page correctly verifies a canary-signed envelope using only the canary contract addresses
- [ ] Ephemeral PDF retention triggers as expected on at least one canary envelope (F8.6 rule holds on the canary deployment)
- [ ] The canary exercise checklist (enumerated in kysigned-plan.md) reaches 100% green before any flip is considered
- [ ] The go/no-go human gate is explicitly invoked with a summary of the checklist status and demands an APPROVE / ABORT / KEEP TESTING decision; no automatic advancement
- [ ] Production KMS wallet is provisioned and production contracts are deployed only AFTER the go/no-go APPROVE
- [ ] Byte-identical bytecode gate for BOTH contracts: `eth_getCode(canary)` and `eth_getCode(production)` match beyond the Solidity metadata suffix; the flip is blocked until both checks pass
- [ ] Flip consists of updating contract addresses and KMS wallet in the service configuration and redeploying kysigned-service; no application code changes are bundled with the flip
- [ ] One smoke-test envelope completes end-to-end against the production contracts immediately after the flip
- [ ] Canary wallet is drained back to the ops wallet within 24 hours of the successful flip
- [ ] KMS key deletion is scheduled on the canary KMS key within 24 hours of the successful flip
- [ ] Canary contract addresses and canary wallet address are stored exclusively in AWS Secrets Manager under `kysigned/canary-*`; a repo-wide `grep` of both the public `kysigned` and private `kysigned-service` repositories returns zero matches for any value
- [ ] Phase 14 checklist includes a pre-squash working-tree scan for canary addresses + canary wallet in the public `kysigned` repo; the private→public flip is aborted if the scan finds any value
- [ ] The `SignatureRegistry — Base mainnet` and `EvidenceKeyRegistry — Base mainnet` rows in the Shipping Surfaces table are not updated from `<TBD>` until the production contract deploy completes, which cannot happen before the canary phase ends

## Constraints & Dependencies

- **run402 platform:** kysigned runs on run402 infrastructure. run402 handles T1 (app-owner pays for infrastructure). T2 (end-users pay the app) is **deferred** — run402 does not currently provide end-user billing. For MVP, kysigned.com uses its own Stripe integration for Path 3 billing. Self-hosted forkers get the `allowed_senders` access control and handle user charging separately (or not at all, for internal use).
- **run402 magic link auth:** Path 3 requires magic link authentication. Confirmed available (shipped in Phase 0).
- **run402 email service (outbound):** Repo forkers rely on run402 email service (paid) or bring their own. Email deliverability reputation is critical — signing requests in spam is product-killing.
- **run402 email service (inbound):** Reply-to-sign requires an inbound email surface that delivers raw RFC-822 MIME with DKIM headers preserved. Confirmed present on run402 (SES receipt rule → S3 → `packages/email-lambda/inbound.mjs` → Postgres; raw MIME persisted in S3 via `s3_key`). Two small enhancements needed: (a) raw-MIME API accessor on `GET /v1/mailboxes/:id/messages/:msgId` returning S3 bytes, (b) inbound routing on kysigned custom sender domain (or MVP ships on `reply-to-sign@mail.run402.com`). These are tracked as a parallel run402 openspec change.
- **run402 custom domains:** Repo forkers can use subdomains (acme-sign.run402.com) or custom domains (acme-sign.com). Outbound custom sender domains confirmed available (shipped in Phase 0). Inbound custom domain routing is the enhancement tracked above.
- **zk-email circuit:** Reply-to-sign requires a zk-email circuit that produces a zk-SNARK over a DKIM-signed email. Candidate: adopt or customize from [prove.email](https://prove.email). Circuit must match our exact public-input shape (searchKey commitment, subject format, `I APPROVE` body marker, first-non-quoted-line detection). Audit strategy TBD.
- **DNSSEC proof chain capture:** The operator needs a way to fetch the full DNSSEC chain from IANA root down to a provider's DKIM selector record at evidence-key-registration time. Library/service TBD. Domains without DNSSEC require a fallback policy (reject? degrade?).
- **Slow-KDF parameters:** `searchKey = SlowHash(email || docHash)` requires committing forever to a specific KDF algorithm and parameters. Must be chosen carefully — too fast enables enumeration, too slow degrades verifier UX. Candidate: argon2id with parameters tuned for ~1 second on consumer hardware.
- **Base gas costs:** Final per-envelope pricing depends on measured gas costs for the rewritten contracts on Base. Pricing target: ~$0.39/envelope. On-chain cost per envelope estimated at $0.01–$0.20; re-measure on Sepolia/mainnet canary.
- **Smart contract deployment:** `SignatureRegistry` and `EvidenceKeyRegistry` must be deployed on Base mainnet before any production signing. Both contracts are immutable once deployed.
- **Existing legal templates:** Legal documents drafted from existing Kychee/Eleanor/run402 templates. All `[service]` legal docs require human approval. LEGAL.md must prominently document the Method B wallet gap.
- **No "kill" language:** All public-facing materials use "alternative to," "replace," "switch from," "better than." Internal docs may use competitive framing.

## Open Questions

### New (from signature-binding rework)

1. **zk-email circuit adoption vs customization.** Can we adopt a circuit from prove.email directly, or do we need to customize for our public-input shape (`I APPROVE` marker, subject format, first-non-quoted-line rule)? Audit strategy and cost?
2. **DNSSEC proof chain capture.** Which library/service to fetch the full DNSSEC chain from IANA root to a provider's DKIM selector? Fallback for domains without DNSSEC — reject cleanly, or degrade?
3. **`Subject` not in DKIM `h=`.** Some mail providers do not include `Subject` in DKIM-signed headers. What fraction of real-world email is affected? Do we reject cleanly with a helpful message, or find an alternative binding?
4. **DKIM key rotation race.** A reply's DKIM header specifies the selector. The operator must fetch the exact key version at the time of reply. Implementation detail but operationally important.
5. **Slow-KDF parameters.** Exact algorithm (argon2id vs scrypt vs PBKDF2) and parameter values. Fixed forever once committed. Must be expensive enough to resist a 1000x hardware speedup while remaining tolerable (~1s) for a legitimate verifier.
6. **Explicit decline phrase.** Should `I DECLINE` be a first-class decline action, or is "do not reply" the only decline path?
7. **Retry UX for non-delivery.** Replies can bounce or be filtered. What does the nudge/re-send flow look like?
8. **Consent language review.** Who reviews the email copy, "how it works" page, and certificate page wording before launch? Legal expertise required.
9. **FAQ on dispute scenarios.** Lock once architecture is frozen. Enumerate: sender forgery, signer repudiation, operator forgery, future crypto break, duress.
10. **Internationalization of `I APPROVE`.** English-only for MVP. Future consideration for localized signing phrases.
11. **Internal future-features note.** Create a separate internal file tracking: OAuth-based identity verification, wallet co-signature as additive proof, visible signature blocks, alternative delivery channels (WhatsApp etc.). Not in public repo, not mentioned publicly.

### Carried forward (unchanged)

12. **Envelope expiry default** — 30 days assumed; notification sequence before deletion TBD.
13. **PDF retention cost model** — future paid retention: per-GB/year rate, tiers.
14. **Multi-signature PDFs** — post-MVP. UX and hash structure for per-page/per-section signatures.
15. **run402 prepaid credit model** — does run402 support buy-credits-and-deduct-per-call? If not, scope needed.
16. **Email deliverability strategy** — dedicated sending domain, IP warm-up, deliverability monitoring.
17. **Certificate of Completion design** — what do courts/auditors expect to see?
18. **Credit pack tiers and pricing** — optimize after gas costs are known.
19. **Future: run402 T2 payment collection (DEFERRED)** — see original OQ #17 text.

### Carried forward (F17 canary — unchanged)

20. **F17 run402 capability gaps** — two KMS wallets per project, bytecode return on deploy, rate-limiting on provision-wallet. Facts to discover before canary execution.
21. **F17 byte-identical bytecode check mechanism** — deferred to plan; spec commits to the gate being hard.
22. **F17 canary checklist contents** — plan enumerates; candidate items now include: reply-to-sign end-to-end via each surface, evidence key registration, zk proof generation, verification page, parallel + sequential signing, ephemeral PDF retention, certificate page generation.
23. **F17 bytecode-divergence playbook** — deferred to plan.
24. **F17 production-contract smoke specifics** — deferred to plan.
