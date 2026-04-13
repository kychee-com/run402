---
product: kysigned
feature: wallet-binding
status: draft
created: 2026-04-13
updated: 2026-04-13
references:
  - type: doc
    path: docs/products/kysigned/kysigned-spec.md
    description: Current kysigned spec — reply-to-sign is the only signing method. This idea proposes a complementary method, not a replacement.
  - type: doc
    path: docs/products/kysigned/ideas/kysigned-signature-binding-idea.md
    description: The DKIM reply-to-sign rework idea (status ready, fed into current spec). That idea explicitly deferred wallet signing from MVP. This idea picks up that thread with a stronger design.
---

> **This is an exploratory idea, not implementation-ready.**
> No use case currently justifies building this. The idea is documented so the design conversation is not lost and can be picked up when a concrete use case emerges.

## Problem / Opportunity

The current reply-to-sign method requires an email round-trip for every document signature. This is the right default — every signature gets a fresh DKIM attestation from the signer's email provider, and the signer needs zero crypto knowledge.

However, there are scenarios where a signer who has already proven their email identity might want to sign documents faster, programmatically, or offline — without waiting for an email round-trip each time. Ethereum wallets provide instant, offline-capable, programmable signatures. If a wallet could be cryptographically bound to a DKIM-attested email, future document signatures from that wallet would carry the same email-identity guarantee without repeated email interaction.

This is strictly additive to reply-to-sign. It does not replace it.

## Target Audience

Not yet identified. Potential candidates (speculative, not validated):

- High-volume signers who sign many documents and want to skip the email round-trip after initial binding.
- Programmatic signers — smart contracts, DAOs, or automated systems that need to sign on behalf of a DKIM-attested email identity.
- Use cases where wallet signatures need to compose with on-chain logic (DeFi, escrow, conditional execution).

**No concrete use case currently exists.** This idea should not move to spec until one is identified and validated.

## Proposed Idea

### One-time wallet binding via DKIM email

1. The operator sends Alice an email asking her to bind a wallet.
2. Alice replies (DKIM-signed by her email provider): `I BIND WALLET 0xABC123...`
3. The operator generates a ZK proof (new circuit) proving:
   - Valid DKIM signature from Alice's email provider
   - Body contains the wallet address claim
   - Same hardening as reply-to-sign (d=/From alignment, no `l=` tag, no duplicate headers, recipient binding, etc.)
4. The proof produces a `bindingLeaf = Poseidon(email, walletAddress)` which is inserted into an **on-chain append-only Merkle tree** (Semaphore pattern).
5. The wallet itself confirms the binding via an on-chain transaction (`confirmBinding`), proving wallet control via `msg.sender`.
6. The binding is now active: both email ownership (DKIM) and wallet control (on-chain tx) are attested.

Nothing is stored in the clear — no email, no wallet-to-email mapping. Only the opaque Merkle leaf.

### Document signing with a bound wallet

When Alice signs a document with her bound wallet, the operator generates a **single ZK proof** that proves all of the following without revealing the wallet:

**Private inputs (hidden inside ZK witness):**
- `email`, `walletAddress`, `ecdsaSig` (wallet's ECDSA signature over docHash), Merkle path in the binding tree

**Public inputs (on-chain):**
- `docHash`
- `bindingTreeRoot` (current Merkle root — contract knows this)
- `searchKey = argon2id(email || docHash)` (computed off-chain by operator)
- `emailDocCommit = Poseidon(email, docHash)`
- `nullifier` (derived from email + docHash, prevents double-recording)

**Circuit proves:**
1. `ecrecover(docHash, ecdsaSig) == walletAddress` — the wallet signed this document
2. `Poseidon(email, walletAddress)` is a leaf in the binding tree (Merkle proof against `bindingTreeRoot`) — the wallet is bound to this email
3. `emailDocCommit == Poseidon(email, docHash)` — consistent email across all commitments
4. Nullifier is correctly derived

**The wallet address never appears on-chain.** It exists only as a private witness inside the ZK proof.

### Validator flow (method-agnostic)

A validator has `(email, docHash)` and wants to know: "did this email sign this document?" They do **not** know which wallet was involved, and do not need to.

1. Compute `searchKey = argon2id(email || docHash)` (~1 second)
2. Query `SignatureRegistry.getRecords(searchKey)`
3. Record exists with a valid proof (verified by the contract at write time) — done.

This is **identical** to the reply-to-sign validator flow. The validator does not know or care whether the signature came from a DKIM email reply or a bound wallet. Both methods produce records at the same `searchKey`.

### Orthogonality with reply-to-sign

The wallet binding method is completely additive:

| Component | Existing reply-to-sign (unchanged) | Wallet binding (new, additive) |
|---|---|---|
| ZK circuit | DKIM "I APPROVE" circuit | DKIM "I BIND WALLET" circuit + ECDSA/Merkle signing circuit |
| On-chain verifier | Groth16 verifier for reply-to-sign | Second Groth16 verifier for wallet signing |
| Registry | `recordReplyToSignSignature()` | `recordWalletSignature()` — same searchKey scheme |
| Query | `getRecords(searchKey)` | Same function, returns both types |
| New contracts | None | `WalletBindingRegistry` with Merkle tree |

No changes to the existing circuit, contracts, or verification logic. The two methods share only the `searchKey` lookup namespace.

## Privacy Analysis

### Compared to reply-to-sign (the baseline)

The on-chain footprint is nearly identical — opaque `searchKey`, Poseidon commitments, ZK proofs. The wallet is hidden inside the ZK witness. No new stable identifiers. No cross-document linkability.

**One minor delta:** the `confirmBinding` transaction reveals that a specific wallet interacted with the `WalletBindingRegistry`. Observers can see "wallet 0xABC has a kysigned binding" but cannot determine which email. Mitigable via a meta-transaction relayer (operator submits on Alice's behalf), but adds complexity.

**Binding tree leaf timing correlation:** each new binding adds a Merkle leaf. The timing of leaf insertion could be correlated with `confirmBinding` transactions. If wallet Y confirms at block N and a leaf appears at block N, an observer can link them. The signing proofs hide which leaf is used (anonymous membership), but the binding event itself leaks this metadata.

### Privacy summary by attacker capability

| Attacker | Can learn |
|---|---|
| Casual observer (browsing chain) | Number of bindings, number of signatures, timing. Cannot identify anyone. |
| Has email + document | Whether that email signed that document (~1 sec argon2id). Intended use case. Cannot determine if it was email-method or wallet-method. |
| Has email only | Must guess docHash — infeasible (2^256 space). |
| Has document only | Must brute-force emails against argon2id — expensive by design. |
| Has wallet address | Can see the wallet has a binding (from `confirmBinding` tx). Cannot determine which email or which documents. |

## Security Analysis

### Genuine regression from reply-to-sign

This is the most important section. Wallet binding introduces a real security tradeoff:

| Aspect | Reply-to-sign (current) | Wallet binding (proposed) |
|---|---|---|
| Per-document attestation | Every document gets a fresh DKIM proof — email provider attests each time | Email provider attests **once** at binding time. All subsequent signatures rely solely on wallet ECDSA. |
| What attacker needs to forge | Access to the signer's email account (typically has 2FA, login alerts, anomaly detection, account recovery) | The signer's wallet private key (single secret, no 2FA, no built-in recovery) |
| Revocation on compromise | Change email password — attacker locked out instantly | Wallet key compromised — attacker can sign unlimited documents until binding is revoked. Revocation mechanism TBD (another DKIM email? on-chain call? both take time). |
| Liveness | Email provider confirms "this person sent this right now" for every signature | No ongoing liveness check. Binding could be years old. Signer might have lost the key. Someone else might have it. |
| Circuit complexity / attack surface | DKIM circuit (RSA verify + body parse) | DKIM binding circuit + ECDSA in-circuit verification + Merkle membership proof. Strictly more complex, more room for bugs. |

**The fundamental tradeoff:** reply-to-sign leverages Gmail/Outlook's full security infrastructure (2FA, anomaly detection, session management, account recovery) for every signature. Wallet binding trades that for a bare `bytes32` private key after the initial binding. This is a meaningful downgrade in authentication strength per signature.

### When the tradeoff might be acceptable

- High-volume, lower-stakes signatures where speed matters more than per-signature attestation strength.
- Programmatic signing where email round-trips are not feasible.
- Use cases where the signer explicitly accepts wallet-level security for the convenience benefit.

This tradeoff analysis should inform which use cases (if any) justify building this.

## Feasibility Notes

### ZK circuit feasibility in RISC Zero

The signing-time circuit requires:
- **ECDSA secp256k1 recovery** — standard Rust crate (`k256`), works natively in RISC Zero zkVM.
- **Poseidon hash** — standard in ZK, Rust implementations exist for RISC Zero.
- **Merkle proof verification** — trivial: hash up the path, compare to root.

None of this is exotic. Proof generation would be slower than reply-to-sign (ECDSA in zkVM adds constraints), estimated 5-8 minutes vs ~3 minutes for reply-to-sign. Acceptable for a non-interactive flow.

### On-chain feasibility

The Merkle tree (Semaphore pattern) is well-established on Ethereum/L2s. Tornado Cash and Semaphore both use this exact pattern for anonymous set membership. Gas costs for tree insertion and proof verification are well-understood.

## Key Decisions

- **Wallet binding is complementary to reply-to-sign, never a replacement.** Reply-to-sign remains the default and recommended method. Wallet binding is an opt-in alternative for signers who have a concrete reason to use it.
- **Full privacy preservation (Semaphore pattern) is the design target.** The wallet address should never appear on-chain in signing records. Whether to ship a simpler but less private version first is an open question deferred until a use case exists.
- **Two-step binding (DKIM email + wallet confirmation) prevents binding someone else's wallet.** Both the email owner and the wallet owner must agree.
- **Binding tree uses append-only Merkle tree.** Matches the immutable, ownerless contract philosophy of the existing system.
- **Revocation model is TBD.** Irrevocable bindings are simpler and match the append-only philosophy. Revocable bindings are more flexible but complicate the trust model (validators must check binding was active at signing time). Deferred until a use case clarifies requirements.
- **Method B (old wallet EIP-712 from pre-rework spec) is not this.** The old Method B had no email binding — `signerEmail` was a caller-chosen label. This idea is fundamentally different: the wallet-to-email link is cryptographically attested via DKIM.

## Open Questions

1. **Use case.** No concrete use case currently justifies building this. What scenario makes wallet-speed signing valuable enough to accept the security regression from per-document DKIM attestation?
2. **MVP vs full privacy.** Should a first version skip the Semaphore pattern (expose wallet address in signing records, accept the privacy delta) and upgrade later? Or is full privacy a hard requirement from day one? Depends on the use case.
3. **Revocation.** Irrevocable vs revocable bindings. If revocable, via what mechanism (DKIM email, wallet on-chain call, both)? How do validators handle revocation timing?
4. **Binding expiry.** Should bindings expire after some period, forcing re-attestation? This would partially mitigate the "stale binding" security concern but adds friction.
5. **Multi-wallet binding.** Can one email bind multiple wallets? Can one wallet bind multiple emails? What are the implications?
6. **Wallet type scope.** This idea assumes Ethereum EOA wallets (secp256k1 ECDSA). Smart contract wallets (ERC-4337, multisig) would need ERC-1271 signature verification in-circuit instead of `ecrecover`. Scope TBD.
7. **`confirmBinding` privacy.** The wallet's `confirmBinding` transaction is publicly visible. Is meta-transaction relaying needed to hide this? Depends on the use case's privacy requirements.
8. **Proof generation cost.** The signing-time circuit (ECDSA + Merkle in RISC Zero) will be more expensive than reply-to-sign. How does this affect pricing? Is the speed benefit worth the higher per-signature compute cost?
9. **Interaction with future DKIM key rotation.** If a DKIM key used at binding time is later rotated, the binding remains valid (the proof was verified at write time). But does this create a weaker trust signal over time compared to fresh DKIM attestation per document?

## Readiness for /spec

- [x] Problem/opportunity clearly defined
- [x] Target audience identified (speculative — no validated use case)
- [x] Core idea described
- [x] Key assumptions surfaced and challenged
- [ ] MVP or simplest version discussed (explicitly deferred — no use case to scope against)
- [ ] Business model considered (no use case, no pricing discussion)
- [x] Open questions documented

Status: **draft** — not ready for /spec. Blocked on identifying a concrete use case that justifies the security regression from per-document DKIM attestation. Revisit when such a use case emerges.
