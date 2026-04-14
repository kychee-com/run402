---
product: kysigned
feature: signature-binding-rework
status: ready
created: 2026-04-09
updated: 2026-04-09
references:
  - type: doc
    path: docs/products/kysigned/kysigned-spec.md
    description: Existing kysigned spec (v0.6.x) — target for revision. Method A (F3.6–F3.7, F4.3) must be replaced; Method B (F3.8) deprecated/deferred; F7 email copy and F12 legal must be rewritten; new sections required for evidence-key archival, "how it works" page, and consent-language versioning.
  - type: doc
    path: docs/plans/kysigned-plan.md
    description: Existing kysigned plan — multiple completed [x] items in Phase 1, 2, 3 must be reopened (contract rewrite, Method A handler rewrite, email templates, Method B removal from MVP path). See "Work to reopen" section below.
  - type: doc
    path: docs/products/kysigned/ideas/kysigned-idea.md
    description: Base kysigned product idea — unchanged. Positioning ("we don't hold the proof — Base does") is strengthened, not contradicted, by this rework.
  - type: doc
    path: c:/Workspace-Kychee/kysigned/contracts/SignatureRegistry.sol
    description: Current Solidity contract. recordEmailSignature is permissionless and does not bind to mailbox control — the defect this rework addresses. recordWalletSignature (EIP-712) is cryptographically sound but its signerEmail field is a caller-chosen label — must be either removed or clearly scoped as optional metadata.
  - type: url
    path: https://prove.email
    description: zk-email project — reference circuits and Solidity verifiers for DKIM-based zk-SNARK proofs.
---

> **This is a spec-revision idea, not a greenfield idea.**
> kysigned is mid-implementation (Phase 13 canary rehearsal). This file proposes a cryptographic rework of the core signing binding and enumerates the concrete revision targets across the existing spec and plan. It should feed `/spec` in revision mode, not as a new feature add-on.

## Problem / Opportunity

The current Method A (email-based signing) does not cryptographically bind "this email signed this document." `recordEmailSignature` in the contract is permissionless and verifies nothing — it accepts whatever bytes the caller submits:

- The ephemeral Ed25519 keypair is chosen by the caller.
- The salt in `signerCommitment = hash(email || docHash || salt)` is chosen by the caller.
- The email never touches the chain.
- The contract stores the provided bytes without verification.

Consequences:

1. **Any party with an EOA and some Base ETH can write a record against the canonical `SignatureRegistry`** claiming any email signed any document, without the named signer's involvement — no fork needed, no operator access needed. The forger picks the email, picks the salt, generates their own keypair, emits `recordEmailSignature`, and later "verifies" the commitment by presenting the salt they chose.
2. **The envelope creator, the operator, a colluding insider, or a random stranger can all forge a record with the same ease.** The threat model is not "malicious sender forges recipient" — it's "anyone forges anyone."
3. **This kills the product's core value proposition.** kysigned's positioning — "permanent, vendor-independent, publicly verifiable proof that this email signed this document" — is not defensible if the proof can be manufactured by anyone. Every competitive claim ("stronger than DocuSign," "trustless," "survives our own death") collapses under a single cryptographic walk-through.
4. **The 20-year durability promise is not met.** Even a legitimate signature, recorded honestly by the operator, provides no independent cryptographic path for a future verifier to confirm the email actually consented. The verifier would have to trust the operator's word that the salt/commitment corresponds to a real email click — and the operator may not exist in 20 years.

Method B (wallet EIP-712) is cryptographically sound for the *address* field but its `signerEmail` string is a caller-chosen label with no binding to the named email, so it solves a different problem (wallet identity) and creates a misleading artifact for the email-identity case.

**This must be fixed before mainnet. The canary rehearsal is currently rehearsing a cryptographically broken product.**

## Target Audience

(Unchanged from base idea — the rework does not change who the product is for.)

- Primary: envelope creators (freelancers, solo consultants, small agencies, real estate agents per the segment hypotheses in the base idea) who need a legally-defensible signature without DocuSign-level cost.
- Signers: zero friction is non-negotiable. The signing ritual must not require an account, an app, a wallet, or any vocabulary lesson about crypto.
- Future verifiers (lawyers, auditors, courts) evaluating a signed document up to ~20 years later. They must be able to reach a deterministic verification result using only `(document, email)` and public archival infrastructure (Base chain state + IANA DNSSEC root key history), with no dependency on kysigned.com, run402, or any operator being reachable at verification time.

## Proposed Idea

**Replace Method A with a reply-to-sign method anchored in DKIM and zk-email.**

### The signing ritual

1. The operator sends the signer an email at their real address. Subject carries the envelope ID and doc hash. Body explains in plain language: "To sign, reply to this email with `I APPROVE` as the first line above any quoted content. Nothing happens if you do not reply."
2. The signer hits reply, types `I APPROVE`, sends. The reply is DKIM-signed by the signer's mail provider on the way out. That DKIM signature is a cryptographic attestation by the signer's mail provider that a real outbound message from the signer's mailbox was sent, containing the envelope ID, the doc hash, and the `I APPROVE` phrase.
3. The operator receives the reply at a single inbound address: `reply-to-sign@<operatorDomain>` (not a per-envelope alias).
4. The operator runs a zk-email circuit over the raw email. The circuit produces a compact zk-SNARK proving:
   - The reply carries a valid DKIM signature by a public key identified as belonging to the signer's mail provider's domain.
   - The `Subject` header was included in the DKIM-signed headers list (`h=`), i.e. not tamperable in transit.
   - The `From:` header hashes to a committed email hash.
   - The subject contains the expected envelope ID.
   - The body contains `I APPROVE` as a standalone line above any quoted content, and contains the expected doc hash.
5. The operator writes the proof to an on-chain `SignatureRegistry` (a rewritten version of the current contract). Raw email is discarded after proof generation.

### The trust chain, on-chain

- **`EvidenceKeyRegistry` (new contract on Base).** Stores DKIM public keys keyed by `keyId`. Each entry contains the raw key bytes plus a full DNSSEC proof chain from the IANA DNSSEC root KSK down to `_selector._domainkey.<providerDomain>`. Operator writes one entry the first time it encounters a (provider, selector, rotation) — amortized across all signatures using that key. Permissionless writes; the DNSSEC chain makes the entry self-verifying against the independently-archived IANA root. No owner, no governance.
- **`SignatureRegistry` (rewrite of the current contract).** Stores signature records keyed by `searchKey = SlowHash(email || docHash)`. On write, the contract verifies the zk proof against the referenced evidence key before accepting. Bulky proof bytes are emitted via events; indexed fields are in storage for O(1) lookup. Permissionless writes; no owner, no admin, no attester gatekeeping, no governance.
- **No on-chain "attester" field or registry.** The zk proof verifies independently; the DKIM key is authenticated by DNSSEC; no submitter identity is part of verification. A malicious submitter cannot forge a record for an email they do not control because they cannot produce a valid DKIM-signed email from that mailbox. Provenance is preserved only via `msg.sender` in tx history, which confers no trust.
- **Both contracts are immutable once deployed.** No proxies, no upgrade paths. The 20-year durability guarantee is only credible if the contracts cannot be changed.

### The verification procedure (2046-ready)

Given `(email, docHash)`:

1. Compute `searchKey = SlowHash(email || docHash)` using the public slow-KDF parameters committed in 2026.
2. Query `SignatureRegistry` by `searchKey`. Retrieve the record (from storage + its associated event for the proof bytes).
3. Look up the referenced `evidenceKeyId` in `EvidenceKeyRegistry`. Retrieve the DKIM public key bytes and the DNSSEC proof chain.
4. Verify the DNSSEC chain against the IANA 2026 root KSK (archived globally, publicly, by many independent parties — IANA, academia, archive.org, OS trust stores, IETF RFCs).
5. Verify the zk proof against the retrieved DKIM key with public inputs `(H(email), envelopeId, docHash)`.
6. Result: "At time T, a mail server cryptographically identified as belonging to the signer's email provider signed a real outbound message from the signer's mailbox containing `I APPROVE` and referencing this document." This conclusion does not require trusting kysigned, run402, or any operator — only the contemporaneous soundness of DKIM, DNSSEC, the zk-SNARK, and Base as a state substrate.

### Privacy properties

- `searchKey = SlowHash(email || docHash)` means:
  - A verifier with both inputs finds the record in one lookup.
  - An observer with only an email cannot enumerate that user's signatures (would require guessing every doc hash, 2^256 space).
  - An observer with only a doc hash cannot learn who signed (would require brute-forcing the email space against a deliberately-slow KDF; cost is tuned to make bulk enumeration prohibitive).
  - Cross-document linkability is eliminated: `searchKey` for (Alice, docA) and (Alice, docB) share no visible relationship.
- No email plaintext or stable email hash is stored anywhere on-chain. The zk proof commits to `H(email)` internally without exposing the value.
- No discovery API, no directory, no "find all docs Alice signed" feature exists or is planned. The verifier is expected to hold both the document and the relevant emails; the party bringing a claim has both by assumption. Any discovery tooling would directly undermine the privacy model.

### What happens to Method B (wallet EIP-712)

Method B is **removed from the MVP product** and deferred to a future-features internal note. The reasoning: in a reply-to-sign world, wallets are not the primary identifier, the search key is `SlowHash(email || docHash)`, and wallet co-signature is strictly additive. Shipping wallet-only signing or wallet+email dual signing adds scope without MVP value.

The existing `recordWalletSignature` function on the current contract becomes irrelevant and should be removed from the rewritten contract. If wallet co-signature is ever added as a future feature, it is layered on top of a reply-to-sign record, not a parallel path.

### What happens to the visual signature layer

The current spec's visible signature blocks embedded in the document body (F3.4, F8.4) are **dropped from MVP**. Replacement: the operator automatically appends a **certificate page** to the final rendered PDF at completion. The certificate page contains the original docHash, the envelope ID, each signer's email + timestamp + tx hash, the operator identity, plain verification instructions, and a QR code. This is pure rendering; the cryptographic record is against the original docHash, not the rendered PDF. The current `recordCompletion(envelopeId, originalDocHash, finalDocHash, signerCount)` shape accommodates this with no contract changes beyond the broader rewrite.

Signers do not interact with the certificate page during signing. The envelope creator does not need to opt in. Zero friction.

### Email copy tone and "how it works" page

- Email copy is **privacy-first and deliberately non-scary**. The primary call-to-action message is: "this is private, simple, and only findable by someone who already has both your email and the document." Legal and technical specifics live in a linked "how it works" page and a collapsible footer — not in the primary signing instruction.
- Every signing email links to a **public "how it works" page** (`/how-it-works` on the operator's marketing site) written in entirely non-technical language. No "blockchain," no "DKIM," no "hash," no "zero-knowledge proof." Technical concepts are replaced with natural analogies ("your email provider stamps your reply," "we scramble the record so only people with both pieces can find it"). A first-draft version of this copy is captured in the brainstorming notes and needs legal + plain-language review before launch.
- **Consent language is legally load-bearing and versioned.** Every user-facing string that constitutes signing intent (email copy, subject line, auto-reply wording, certificate page wording, "how it works" page) is versioned, and the version in force at the time of signing is recorded alongside each envelope in operator state. This lets disputes reference the exact bytes of text a signer was shown.

### Anti-bait-and-switch

Bait-and-switch is natively defeated because the doc hash appears in the DKIM-signed email the signer is replying to. The zk circuit binds the signature to the exact hash present in the email. An operator cannot stage a different document behind the signer's back — the reply's DKIM signature covers the hash the signer actually saw. Signers are additionally instructed in the "how it works" page on how to independently verify the hash.

### Relationship to run402

- kysigned is a run402 application. All operator functions (data store, blob store, outbound email, **inbound email**, compute, Base RPC, key/secret management, payment collection via x402/MPP rails) use run402 surfaces. This is unchanged from the current spec.
- The **inbound email surface already exists on run402** — confirmed 2026-04-09 by inspection of `packages/email-lambda/inbound.mjs` and the archived `2026-03-28-full-email` change. The production pipeline is SES receipt rule → S3 → email-lambda → Postgres. Raw MIME is persisted in S3 with DKIM headers intact (`s3_key` is stored on each message row in `internal.email_messages`). The inbound-reply E2E test in `test/email-e2e.ts` covers it end-to-end. Two small enhancements are needed for kysigned:
  - **Raw-MIME API accessor.** `GET /v1/mailboxes/:id/messages/:msgId` currently returns parsed `body_text` but not raw bytes. The zk-email circuit needs the exact DKIM-signed canonical form. Since `s3_key` is already on every row, this is a small addition: new endpoint or field that returns raw MIME from S3. Do NOT operate on the stripped/cleaned `body_text` — use raw bytes directly.
  - **Inbound on the kysigned custom sender domain.** Outbound custom sender domains already exist (`custom-sender-domains` enhancement). Inbound custom domain routing (so replies arrive at `reply-to-sign@kysigned.com` rather than `reply-to-sign@mail.run402.com`) likely needs a small addition to the SES receipt rule wiring. Alternatively, MVP can ship with `reply-to-sign@mail.run402.com` and add custom-domain inbound as a follow-up.
- No separate attester service. Operator does everything. Forks are also run402 applications unless they rewrite the surface layer themselves.
- Run402 has no privileged on-chain position and no trust anchor role. Its name may appear off-chain in email templates and certificate pages as the infrastructure provider — pure branding, not protocol.
- Surfaces added in the previous spec that are no longer needed by this design are **left in place as self-standing per direction**; the rework does not actively remove them.

## Key Decisions

### Protocol

- **Reply-to-sign is the only signing method for MVP.** `I APPROVE` standalone on the first non-quoted line. Subject line carries envelope ID + doc hash and must be present in the DKIM `h=`. Inbound goes to a single address `reply-to-sign@<operatorDomain>`.
- **DKIM + zk-email + DNSSEC-rooted key archival is the trust chain.** No party confers cryptographic trust. Verification is math against the IANA DNSSEC root.
- **Email is the durable identifier; wallets are not.** All records are searchable by `SlowHash(email || docHash)`. Wallet signatures removed from MVP.
- **No on-chain attester concept.** No `AttesterRegistry`, no attester signature on records, no named-party trust. `msg.sender` provides bare tx-history provenance only.
- **Two immutable contracts on Base: `SignatureRegistry` (rewritten) and `EvidenceKeyRegistry` (new).** Both permissionless. Both ownerless. Both govern-less.
- **Proof bytes go in events, not storage.** Indexed fields in storage for O(1) lookup. Reduces per-envelope gas dramatically.
- **Privacy: `searchKey = SlowHash(email || docHash)`** with slow-KDF parameters fixed forever in the spec. No plaintext or stable email hashes on-chain. No discovery API, ever.

### Scope and product shape

- **Method B (wallet EIP-712) removed from MVP.** Deferred to a future-features internal note.
- **Visible signature blocks in the document body removed from MVP.** Replaced by an auto-appended certificate page at completion.
- **OAuth-based identity verification (Google/Microsoft JWT) is deferred entirely to an internal exploration note.** Not mentioned in any public surface. Not committed to ship. May never happen.
- **Alternative delivery channels (WhatsApp, SMS, Slack) out of MVP.** Out of spec. Captured in the internal future-features note as a notification-only augmentation if user research later shows email delivery is a conversion bottleneck.
- **Consent language is versioned and legally reviewed before launch.**
- **Pricing target: $0.39 per envelope** (up from $0.25 in the current spec). Provisional until the business model canvas pass is complete. On-chain cost per envelope estimated at $0.01–$0.20 depending on Base gas conditions, leaving comfortable margin.

### Operator and infrastructure

- **kysigned remains a run402 application.** All operator functions run on run402 surfaces.
- **Inbound email surface on run402 is a prerequisite.** Must be confirmed or enhanced before spec revision locks.
- **`kysigned-private` (private) remains the flagship operator.** Same code as the public repo, different config and branding.
- **Run402 has no privileged on-chain role.** Off-chain branding only.

## Work to reopen (existing plan items affected)

This rework re-opens work that is currently marked `[x]` in `docs/plans/kysigned-plan.md`. These items must be reset or revised as part of the spec revision and re-planning pass:

### Phase 1 — Smart Contract (re-open nearly all)

- **REWRITE.** `SignatureRegistry.sol` — the current contract's `recordEmailSignature` is the core defect. The rewrite must verify a zk-SNARK proof against a referenced evidence key, key records by `searchKey`, emit bulky proof data as events, and drop `recordWalletSignature` from MVP scope.
- **NEW.** `EvidenceKeyRegistry.sol` — does not exist today. DKIM key + DNSSEC proof chain storage with on-chain or on-first-use DNSSEC validation.
- **REWRITE.** Contract unit tests — current 9 tests cover the old interface. New tests cover zk-proof acceptance, DNSSEC-chain validation, searchKey lookup, permissionless-spam resistance, and event-based evidence retrieval.
- **REWRITE.** Sepolia testnet deployment — existing address `0xAE8b6702e413c6204b544D8Ff3C94852B2016c91` is obsolete; redeploy the new contracts.
- **REWRITE.** Gas cost measurement. Previous measurements (220K/243K/158K) do not apply. New ballpark per brainstorming: ~200K gas per signature (including zk verify + event emission), evidence key registration amortized. Target: $0.01–$0.20 per envelope on-chain; re-measure on Sepolia/mainnet canary.
- **REWRITE.** Published contract ABI + verification algorithm documentation. `docs/contract-abi.md` in the public repo must be rewritten for the new contract shape and the new 2046-verification procedure.

### Phase 2 — Core Engine Method A handler (re-open)

- **REWRITE.** `src/signing/` — the Method A handler (ephemeral Ed25519 + commitment) is replaced by a zk-email proof-generation pipeline. The new handler:
  - Accepts raw inbound email from the reply-to-sign inbound surface.
  - Validates DKIM off-chain (as a fast-fail before zk).
  - Parses subject for envelope ID, body for `I APPROVE` marker and doc hash, with the non-quoted-line rule.
  - Invokes the zk-email circuit to produce the proof.
  - Computes `searchKey = SlowHash(email || docHash)`.
  - Submits the signature record to `SignatureRegistry`.
  - Discards the raw email.
- **REWRITE.** The `POST /v1/sign/:envelope_id/:token` endpoint semantics — there is no click-and-sign flow anymore. Signing is driven by inbound email. This endpoint may still exist as a review/read-only surface, but it does not complete a signature.
- **REMOVE.** Method A Ed25519 keypair generation in the browser (Web Crypto + tweetnacl fallback) — no longer needed; all signing intent comes from the DKIM-signed reply.
- **REMOVE from MVP.** Method B server-side handler (`recordWalletSignature` call). Move to internal future-features note.
- **REWRITE.** Duplicate-signing protection — now must handle the case where the same signer replies twice (both replies are DKIM-valid). Either first-reply-wins with no-op on subsequent, or explicit deduplication.
- **REWRITE.** Decline flow — there is no click-to-decline. A signer who does not wish to sign simply does not reply. Decline becomes a timeout/expiry concern, not an explicit action. Alternatively, an explicit decline phrase (`I DECLINE`) can be supported — open question.

### Phase 2 — PDF / completion

- **REVISE.** Auto-stamp generation and signature embedding — drop in-body visible signature blocks. Keep the completion PDF pipeline, but restructure to append the certificate page instead of embedding mid-document signature blocks.
- **NEW.** Certificate page generator — operator-automatic, 0-friction, contains the original docHash, envelope ID, per-signer audit trail, operator identity, verification instructions, QR code.

### Phase 2 — Email templates (re-open most)

- **REWRITE.** All 7 email templates. The current templates describe click-to-sign and auto-stamp UX. They must be rewritten for reply-to-sign with the privacy-first, low-scary tone, the `I APPROVE` ritual instructions, and the `How it works →` link.
- **REWRITE.** Reminder and nudge wording — same reply-to-sign framing.
- **NEW.** Auto-reply handler for non-matching inbound mail — "your reply did not match the signing format; to sign, reply with `I APPROVE`; to ask a question, contact the sender at [sender-email]."

### Phase 2 — Verification

- **REWRITE.** Verify by hash / verify by envelope ID — query shape changes because records are keyed by `searchKey`. The public verification page must accept `(document, email)` as inputs and compute `searchKey` client-side.
- **REWRITE.** Contract address list — one canonical address per new contract. The old `SignatureRegistry` address is obsolete for MVP purposes (the old contract continues to exist on Sepolia but is not referenced).

### Phase 2 — Allowed senders, payments, admin

- **UNCHANGED.** `allowed_senders`, x402/MPP payment middleware, admin API, per-sender quotas, pluggable enforcement strategy — all orthogonal to the signing-binding rework and remain as built.

### Phase 7 — Email delivery infrastructure

- **NEW.** Inbound email handling at `reply-to-sign@<operatorDomain>`. This is the single biggest new dependency and likely requires a run402 enhancement task (analogous to the six enhancements landed in Phase 0). Must deliver raw email bytes with DKIM headers preserved, not a processed/cleaned representation.
- **UNCHANGED.** SPF/DKIM/DMARC on the outbound sending domain — still required.

### Phase 13 — Canary mainnet deploy

- **BLOCKED on rework.** The canary is currently rehearsing a cryptographically broken product. No mainnet flip until the new contracts are deployed, the new signing handler is shipped, the canary is re-run against the new contracts, and the smoke tests pass with the new flow.
- **Canary ritual itself is unaffected** (DD-17 remains valid) — it's the subject contract that changes.

### Legal and docs

- **REWRITE.** `LEGAL.md` in the public repo — the old language around Method A's cryptographic guarantees must be rewritten. The new language should describe the reply-to-sign mechanism, the DKIM/DNSSEC trust chain, and be truthful about what the on-chain record proves ("a mail provider cryptographically attested a real outbound email from this mailbox containing `I APPROVE` and this document hash").
- **REWRITE.** `README.md` in the public repo — current Method A / Method B / wallet language is obsolete. New README describes reply-to-sign as *the* signing method.
- **NEW.** `how-it-works` public page on the kysigned-private marketing site. Plain English, no jargon.

## Work that stays as-is

These are explicitly unaffected by this rework and remain as currently built/planned:

- Envelope creation, state machine, expiry, reminders, void flow.
- `allowed_senders` and all sender access control (F2.8).
- x402 / MPP payment integration.
- Run402 KMS contract wallet integration (the EOA that submits on-chain writes — new contracts, same wallet).
- MCP server (`kysigned-mcp`) — tool signatures stay; underlying endpoints change their proof shape but not their interface.
- Dashboard, exports, analytics.
- Sender-as-signer flow (sender replies to their own envelope from their own email — same rules).
- Sequential vs parallel signing order.
- Canary/mainnet deploy discipline (F17, DD-17) — the discipline is unchanged; only the subject contract differs.
- PDF upload, SHA-256 hashing, per-envelope retention.

## Open Questions

1. **Run402 inbound email surface — CONFIRMED PRESENT.** Production pipeline exists (SES receipt rule → S3 → `packages/email-lambda/inbound.mjs` → Postgres). Raw MIME with DKIM headers intact is persisted in S3; `s3_key` is stored per message row in `internal.email_messages`. Inbound E2E test exists in `test/email-e2e.ts`. Two small enhancements needed (not blockers): (a) raw-MIME API accessor on `GET /v1/mailboxes/:id/messages/:msgId` that returns bytes from S3 rather than the parsed/cleaned `body_text`; (b) inbound routing on kysigned's custom sender domain, OR accept MVP ships with `reply-to-sign@mail.run402.com` and custom-domain inbound is a follow-up.
2. **zk-email circuit adoption vs customization.** Can we adopt a circuit from [prove.email](https://prove.email) directly, or do we need to customize one to match our exact public-input shape (searchKey commitment, subject format, `I APPROVE` body marker rule, first-non-quoted-line detection)? Audit strategy and cost?
3. **DNSSEC proof chain capture.** Which library / service to fetch the full DNSSEC chain from IANA root down to a provider's DKIM selector record at key-registration time? Fallback handling for domains without DNSSEC? Reject or degrade?
4. **`Subject` not in DKIM `h=`.** Some mail providers do not include `Subject` in DKIM-signed headers by default. What fraction of real-world email is affected? If a signer's provider does not sign `Subject`, do we reject cleanly with a helpful message, or degrade to another proof variant?
5. **DKIM key rotation race.** A reply's DKIM header specifies the selector that signed it. The operator must fetch the exact key version at the time of reply, not the current one. Implementation detail but operationally important for reliability.
6. **Explicit decline phrase.** Should `I DECLINE` be a first-class decline action (with its own auto-reply and state transition), or is "do not reply" the only decline path? Product decision.
7. **Retry UX for non-delivery.** Replies can bounce or be filtered as spam. What does the nudge / re-send flow look like? Current spec has reminders for pending envelopes; the reminder copy needs the new ritual.
8. **Consent language review.** Who reviews the new email copy, the `how it works` page, and the certificate page wording before launch? Internal lawyer? External reviewer? This text is legally load-bearing.
9. **Slow-KDF parameters.** Exact choice of algorithm (argon2id vs scrypt vs PBKDF2) and parameter values. These are fixed forever once the spec commits — a verifier in 2046 must use the same KDF. The choice must tolerate future hardware by being expensive enough today that a 1000x hardware speedup still leaves bulk enumeration uneconomic.
10. **FAQ on dispute scenarios.** Lock once architecture is frozen. Should enumerate: sender forgery (cryptographically prevented), signer repudiation with mailbox-compromise claim (burden of proof on signer, same as every digital signing product), operator/collusion forgery (cryptographically prevented because the operator cannot produce a DKIM-signed outbound email from a mailbox it does not control), future crypto break (acknowledged long-term risk, same as every cryptographic system), "I signed under duress" (out of scope for cryptographic verification, handled by courts).
11. **Terminology.** Use "reply-to-sign" as the product-facing name for the signing method. No "tier" terminology anywhere. Internally in the spec use "the DKIM-based method" for technical precision.
12. **Obsolete surfaces from the pre-rework spec.** Per direction, self-standing surfaces added in the earlier spec phases are left in place and not actively removed. A small audit should identify which surfaces are now unused and document them as legacy so future spec readers are not confused.
13. **Internal-only future-features note.** A separate internal file should be created (not in the public repo, not referenced in any public surface) tracking: OAuth-based identity verification, wallet co-signature, visible signature blocks, alternative delivery channels. None of these are committed, mentioned publicly, or scheduled. They exist only so the design conversation is not lost.

## Readiness for /spec

- [x] Problem/opportunity clearly defined (current Method A is cryptographically unsound; product value is defeated; canary is rehearsing a broken product)
- [x] Target audience identified (unchanged from base idea)
- [x] Core idea described (reply-to-sign + DKIM + zk-email + DNSSEC-rooted key archival)
- [x] Key assumptions surfaced and challenged (attester role removed, wallet as identifier rejected, Method B deferred, visible sig block deferred, OAuth deferred, inbound email surface flagged as the biggest dependency)
- [x] MVP or simplest version discussed (one signing method, two contracts, certificate page, no tiers, no wallet, no visible block)
- [x] Business model considered (pricing bumped to $0.39 provisional, on-chain cost modeled, full canvas pass deferred)
- [x] Open questions documented (13 items, with run402 inbound email as the gating dependency)
- [x] Work-to-reopen section written (explicit plan-item list with REWRITE / NEW / REMOVE / UNCHANGED markers)

Status: **ready** — this feeds `/spec` in revision mode. The spec revision should update kysigned-spec.md in place (F3, F4, F7, F8, F12 substantially; F1, F2, F5, F6, F9–F16 lightly or not at all), bump the spec version per the spec-versioning rule, and trigger a plan revision that re-opens the items listed in "Work to reopen."
