# R.8 — Quantum-Resistance Posture

**Date:** 2026-04-10
**Phase:** R (zk-email & KDF Research Spike)
**Status:** Complete
**Source:** DD-20 (kysigned plan)

## Summary

kysigned acknowledges quantum computing risks in documentation but does NOT implement post-quantum cryptographic primitives in the MVP. The posture is: **document the threat, design for upgradeability, revisit when PQ standards mature.**

## Component-by-Component Analysis

### 1. KDF (searchKey): Quantum-Safe

| Property | Value |
|----------|-------|
| Algorithm | argon2id |
| Purpose | `searchKey = argon2id(email \|\| docHash)` — privacy-preserving lookup key |
| Quantum threat | Grover's algorithm gives quadratic speedup on brute-force |
| Mitigation | Memory-hard KDFs resist Grover. Doubling memory/iterations restores full security |
| OWASP 2026 recommendation | argon2id at 128 MiB / 3 iterations |
| **Verdict** | **Safe. No action needed.** |

### 2. SHA-256 (docHash): Quantum-Safe

| Property | Value |
|----------|-------|
| Algorithm | SHA-256 |
| Purpose | `docHash = SHA-256(pdf_bytes)` — document fingerprint |
| Quantum threat | Grover reduces collision resistance from 2^128 to 2^64 (preimage from 2^256 to 2^128) |
| Assessment | NIST assesses SHA-256 remains quantum-secure. 128-bit security against Grover is sufficient for 20+ year horizon |
| **Verdict** | **Safe. No action needed.** |

### 3. DKIM Signatures (RSA-2048): Vulnerable (Mitigated)

| Property | Value |
|----------|-------|
| Algorithm | RSA-2048 (most providers) |
| Purpose | Mail provider attests email authenticity |
| Quantum threat | Shor's algorithm can factor RSA keys in polynomial time on a sufficiently large quantum computer |
| Timeline | NIST estimates large-scale quantum ~2035+ |
| **Mitigation** | `EvidenceKeyRegistry` creates a permanent blockchain-timestamped record of the DKIM key valid *at signing time*. Non-repudiation via key consistency across signatures (F4.9). When mail providers migrate to PQ-safe DKIM keys (likely 2028-2032), new evidence keys registered at that time will use PQ algorithms. |
| **Verdict** | **Vulnerable but mitigated by key archival. Acceptable for MVP.** |

### 4. zk-SNARKs (Groth16): Vulnerable (Upgrade Path Noted)

| Property | Value |
|----------|-------|
| Algorithm | Groth16 (BN254 elliptic curve pairings) |
| Purpose | Prove DKIM email authenticity without revealing email content |
| Quantum threat | Shor's algorithm breaks elliptic curve discrete log |
| Post-quantum alternative | STARKs (hash-based, no elliptic curves) — 50-200 KB proofs, 10-100x gas |
| **Mitigation** | STARK upgrade path documented. The proof architecture is modular: `SignatureRegistry.recordReplyToSignSignature()` calls a verifier contract address stored in config. Switching from Groth16 to a STARK verifier requires: (1) new circuit compilation, (2) new verifier contract deployment, (3) config update pointing to new verifier. No application code change. |
| **Verdict** | **Vulnerable. STARK upgrade path noted. Acceptable for MVP.** |

### 5. Poseidon Hash (pubkeyHash, fromHash): Quantum-Safe

| Property | Value |
|----------|-------|
| Algorithm | Poseidon (algebraic hash over prime fields) |
| Purpose | Hash DKIM public keys and email addresses inside zk circuits |
| Quantum threat | Grover reduces collision resistance by sqrt — same as SHA-256 |
| **Verdict** | **Safe. No action needed.** |

## NIST PQC Standards Timeline

| Standard | Status (2026) | Relevance |
|----------|---------------|-----------|
| ML-KEM (CRYSTALS-Kyber) | Finalized (FIPS 203) | Key exchange — not relevant to kysigned |
| ML-DSA (CRYSTALS-Dilithium) | Finalized (FIPS 204) | Digital signatures — future DKIM replacement candidate |
| SLH-DSA (SPHINCS+) | Finalized (FIPS 205) | Stateless hash-based signatures — conservative DKIM alternative |
| HQC | Expected 2026-2027 | KEM — not directly relevant |

**kysigned's threat model is archival integrity** (signatures verified decades from now), not real-time key exchange. The PQ migration path is:
1. Mail providers adopt PQ-safe DKIM (ML-DSA or SLH-DSA)
2. New evidence keys use PQ algorithms (registered in `EvidenceKeyRegistry`)
3. Existing pre-PQ records are "pre-quantum era" — evaluated historically, same as all digital signatures created before a cryptographic break

## Documentation Deliverables

- [x] This document (`docs/research/R8-quantum-resistance-posture.md`)
- [ ] LEGAL.md F12.7 section (Phase 7 task)
- [ ] "How it works" page FAQ on longevity (Phase 3R.12 task)
- [ ] Spec OQ section acknowledging the timeline (already in spec v0.9.0)

## Revisit When

- NIST PQ signature standards widely deployed by mail providers (likely 2028-2032)
- A credible quantum threat timeline accelerates to <5 years
- STARK gas costs on Base drop to <2x Groth16 (making the upgrade economically viable)
