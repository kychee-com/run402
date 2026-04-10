# R.10 — Phase R Spike Output Summary

**Date:** 2026-04-10
**Phase:** R (zk-email & KDF Research Spike)
**Status:** Awaiting approval

## Purpose

This document summarizes all Phase R research findings into the decisions that Phase 1R (contract rework) and Phase 2R (engine rework) will consume. Each decision is committed — changing them after Phase 1R begins requires re-planning.

---

## (a) Circuit: Custom kysigned Blueprint on zk-email SDK

**Source:** R.1, R.2

- **Base:** `@zk-email/circuits` v6.4.2 `EmailVerifier` (DKIM signature verification)
- **Body regex:** `I APPROVE` (case-insensitive) on standalone line — first-match semantics
- **Header regexes:** `From:` email extraction (Poseidon-hashed), `Subject` extraction (full text, contains envelopeId + docHash)
- **Public signals:** `pubkeyHash`, `emailCommit` (document-scoped: `Poseidon(email, docHash, envelopeId)` — NOT a stable pseudonym), `subject`
- **Private constraint:** body must contain `I APPROVE` — proof fails to generate if absent, so the proof's existence IS the attestation. No need to put the literal string on-chain.
- **Circuit parameters:** `emailBodyMaxLength=4096`, `emailHeaderMaxLength=1024`, `ignoreBodyHashCheck=false`, `removeSoftLinebreaks=true`
- **SDK:** `@zk-email/sdk` v2.0.11 — Blueprint definition + registry compilation
- **Blueprint definition:** `scripts/research/define-kysigned-blueprint.ts`
- **Proof prototype:** `scripts/research/generate-proof-prototype.ts` (awaiting real .eml for hands-on test)

## (b) Proof System: Groth16

**Source:** R.3

- **Proof size:** ~260 bytes
- **On-chain verification gas:** ~250K gas (~$0.01-0.05 on Base L2)
- **Server-side generation:** <5 seconds (128-core), <$0.01/proof
- **Trusted setup:** Via zk-email SDK registry compilation (handles Phase 1 + Phase 2 setup)
- **Verifier contract:** Auto-generated `KysignedVerifier.sol` via `snarkjs zkey export solidityverifier`
- **Per-envelope gas:** ~$0.05-0.06 (2 signers worst case), leaving ~$0.33 margin at $0.39 price

## (c) On-chain Verifier Contract Pattern

**Source:** R.3

- `KysignedVerifier.sol` — single function `verifyProof(a, b, c, input) → bool`
- Deployed once per circuit version alongside `SignatureRegistry.sol` + `EvidenceKeyRegistry.sol`
- `SignatureRegistry.recordReplyToSignSignature()` calls the verifier before recording

## (d) Proof Size + Gas Cost Estimates

**Source:** R.3

| Operation | Gas estimate | Base L2 cost |
|-----------|-------------|-------------|
| `recordReplyToSignSignature` (with Groth16 verify) | ~350K | ~$0.02 |
| `registerEvidenceKey` (new key) | ~150K | ~$0.01 |
| `recordCompletion` | ~80K | <$0.01 |
| **2-signer envelope (worst case)** | **~930K** | **~$0.06** |

## (e) KDF Algorithm + Committed Parameters

**Source:** R.7

```typescript
export const SEARCH_KEY_PARAMS = {
  algorithm: 'argon2id',
  memorySizeKiB: 262144,   // 256 MiB
  iterations: 4,
  parallelism: 1,
  hashLength: 32,
  salt: SHA256("kysigned-searchkey-v1"), // deterministic protocol salt
} as const;
```

- **Library:** `hash-wasm` (pure WASM, Node.js + all browsers)
- **Performance:** ~800ms desktop, ~400-500ms server, ~1.5-3s mobile
- **Immutable:** Parameters committed forever — changing breaks searchKey lookups

## (f) Key Archival & Non-Repudiation

**Source:** R.5

- **Core insight:** The zk proof's existence proves the DKIM key was correct at registration time. A wrong key → DKIM verification fails → no proof generated. The `EvidenceKeyRegistry` + `block.timestamp` is the on-chain attestation "on day X this key was legit."
- **Non-repudiation:** Every signature record contains `evidenceKeyId`. All signatures from the same provider during the same key period reference the same `keyId`. An operator fabricating one key creates a detectable inconsistency against all other signatures from that provider. Multiple independent operators sharing the canonical contract make fabrication infeasible.
- **DNSSEC: removed entirely.** Gmail/Outlook/Yahoo don't have it. The trust model doesn't need it — the zk proof IS the key authenticity proof. No `@ensdomains/dnsprovejs` dependency.

## (g) Subject in DKIM `h=` Coverage

**Source:** R.4

- **Result:** All 6 surveyed providers (Gmail, Outlook, Yahoo, ProtonMail, iCloud, Fastmail) include `Subject` in `h=`
- **RFC 6376:** Subject is SHOULD-sign (Section 5.4.1)
- **Defense-in-depth:** Runtime check at reply processing — reject if Subject not in `h=`
- **No fallback needed for MVP** (all major providers comply)

## (h) DKIM Rotation Strategy

**Source:** R.6

1. Extract `s=` selector from DKIM-Signature header at reply time
2. Check `EvidenceKeyRegistry` on-chain — if `keyId` exists, use cached key
3. If not: DNS lookup → `registerEvidenceKey(domain, selector, publicKey)` on-chain
4. In-memory LRU cache (TTL 1h) for hot path, avoids redundant DNS lookups
5. DNS failure: retry 3x with exponential backoff, then reject reply with error

**Provider rotation frequency:** 6-12 months (Gmail, Outlook); years (Yahoo, ProtonMail)

## (i) Quantum-Resistance Summary

**Source:** R.8, DD-20

| Component | Status | Action |
|-----------|--------|--------|
| argon2id (KDF) | Safe | None |
| SHA-256 (docHash) | Safe | None |
| DKIM RSA-2048 | Vulnerable (Shor's, ~2035+) | Mitigated by key archival in EvidenceKeyRegistry |
| Groth16 (zk-SNARK) | Vulnerable (Shor's) | STARK upgrade path when gas costs drop |
| Poseidon (hashing) | Safe | None |

---

## Deliverables

| Item | Location | Status |
|------|----------|--------|
| R.1 Gap analysis | `docs/research/R1-zk-email-gap-analysis.md` | Complete |
| R.2 Blueprint definition | `scripts/research/define-kysigned-blueprint.ts` | Awaiting .eml |
| R.2 Proof prototype | `scripts/research/generate-proof-prototype.ts` | Awaiting .eml |
| R.3 Verifier strategy | `docs/research/R3-on-chain-verifier-strategy.md` | Complete |
| R.4 Subject in h= | `docs/research/R4-subject-dkim-h-tag.md` | Complete |
| R.5 Key archival & non-repudiation | `docs/research/R5-dnssec-proof-chain.md` | Complete (DNSSEC removed) |
| R.6 DKIM rotation | `docs/research/R6-dkim-key-rotation.md` | Complete |
| R.7 KDF benchmark | `docs/research/R7-kdf-benchmark.md` | Complete |
| R.7 Benchmark script | `scripts/research/benchmark-kdf.ts` | Complete |
| R.8 Quantum posture | `docs/research/R8-quantum-resistance-posture.md` | Complete |
| R.9 Contract | `contracts/EvidenceKeyRegistry.sol` | Complete (8 tests) |
| R.10 This summary | `docs/research/R10-spike-output-summary.md` | This document |

## Dependencies for Phase 1R+

| Package | Version | Purpose |
|---------|---------|---------|
| `@zk-email/sdk` | ^2.0.11 | Blueprint API, proof generation |
| `@zk-email/helpers` | ^6.4.2 | DKIM parsing, circuit input prep |
| `@zk-email/circuits` | ^6.4.2 | EmailVerifier base circuit |
| `hash-wasm` | ^4.x | argon2id for searchKey |
| `snarkjs` | latest | Groth16 proving + verifier generation |

## Blocking Item

**R.2 hands-on test** is blocked on a real `.eml` file from a DKIM-signed reply. The Blueprint definition and proof generation script are ready — they need a real email to run. This does NOT block Phase 1R (contract rework) or Phase 2R.1-2R.5 (Method A removal). It blocks Phase 2R.6+ (inbound email handler).

---

**APPROVAL GATE:** Phase 1R begins after this document is reviewed and approved. The committed parameters (KDF, circuit shape, proof system) are locked at that point.
