# R.5 — DKIM Key Archival & Non-Repudiation

**Date:** 2026-04-10 (revised)
**Phase:** R (zk-email & KDF Research Spike)
**Status:** Complete

## Goal

Archive DKIM public keys on-chain so signatures remain verifiable after providers rotate their keys out of DNS. Ensure a signer cannot repudiate by claiming the operator fabricated the key.

## Trust Model

### Why the zk proof IS the key authenticity proof

1. The operator receives a DKIM-signed reply from the signer
2. The operator fetches the provider's DKIM public key from DNS (same as every mail server globally)
3. The zk-email circuit verifies the DKIM signature against that key
4. **If the key were wrong, the DKIM signature would not verify, and no proof could be generated**
5. The operator registers the key in `EvidenceKeyRegistry` with `block.timestamp`
6. The proof is recorded in `SignatureRegistry` referencing that `evidenceKeyId`

The zk proof's existence is cryptographic proof the key was correct. No external attestation needed.

### Non-repudiation via key consistency

Every signature record contains `evidenceKeyId` — a reference to which DKIM key was used. All signatures from the same provider during the same key period reference the **same** `keyId = keccak256(domain, selector, publicKey)`.

**Signer repudiation attack:** "The operator fabricated my DKIM key and forged my signature."

**Defense:** To fabricate Bob's key, the operator would need to fabricate a `PKfake` that:
- Produces valid DKIM signatures (requires knowing the private key)
- Is registered on-chain as the same `keyId` referenced by ALL other Gmail signatures during that period

This means the operator would need to fake ALL Gmail DKIM verifications during that key period — not just Bob's. A single legitimate Gmail signing from any other user corroborates the real key.

**With multiple operators:** If multiple independent operators share the canonical `EvidenceKeyRegistry`, each independently verifies and registers the same key. Fabrication by one operator is immediately detectable as an outlier against the consensus.

## EvidenceKeyRegistry Design

```solidity
struct EvidenceKey {
    string domain;      // e.g., "gmail.com"
    string selector;    // e.g., "20230601"
    bytes publicKey;    // raw DKIM public key bytes
    uint256 registeredAt; // block.timestamp
}
```

- **Permissionless:** any address can register
- **Append-only:** no deletion, no revocation, no admin
- **Idempotent:** registering the same key twice is a no-op
- **keyId:** `keccak256(abi.encode(domain, selector, publicKey))`

## Why DNSSEC was removed

DNSSEC would provide a cryptographic chain from the IANA root to the DNS record, proving the DNS response wasn't tampered. However:

- **Gmail, Outlook, Yahoo don't have DNSSEC** (~5% global DNSSEC signing)
- The zk proof already proves the key was correct (see above)
- Adding DNSSEC would add complexity for a feature that works for <5% of real emails
- The non-repudiation argument (key consistency) is stronger than DNSSEC for the dispute scenario that matters (signer repudiation)

**Decision: DNSSEC removed entirely from the MVP.** No `dnssecProof` field, no `@ensdomains/dnsprovejs` dependency, no tiered trust model.

## Registration Flow

1. Extract `s=` selector and `d=` domain from DKIM-Signature header
2. Compute `keyId = keccak256(domain, selector, publicKey)`
3. Check `EvidenceKeyRegistry.isKeyRegistered(keyId)` — if yes, use cached keyId
4. If not: fetch key from DNS, call `registerEvidenceKey(domain, selector, publicKey)`

One registration per unique key, amortized across all signatures using it.
