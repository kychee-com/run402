# R.1 — zk-email / prove.email Circuit Gap Analysis

**Date:** 2026-04-10
**Phase:** R (zk-email & KDF Research Spike)
**Status:** Complete

## Executive Summary

The zk-email ecosystem (`@zk-email/sdk` v2.0.11, `@zk-email/circuits` v6.4.2, `@zk-email/contracts`) provides a mature foundation for proving DKIM email authenticity on-chain via Groth16 zk-SNARKs. **kysigned can adopt the zk-email stack directly** for its core DKIM verification, but requires a **custom circuit (blueprint)** to enforce the kysigned-specific constraints (body content matching, subject format binding, `From:` commitment). The existing `DKIMRegistry.sol` is a close analog to our planned `EvidenceKeyRegistry.sol` but has important architectural differences.

## Requirement-by-Requirement Gap Analysis

### Req 1: `I APPROVE` body marker verification

**kysigned needs:** Prove the email body contains `I APPROVE` (case-insensitive, punctuation-tolerant) as a standalone line above any quoted content.

**zk-email provides:** Body content matching via decomposed regex in the SDK's Blueprint system. The `EmailVerifier` circuit supports full body verification when `skipBodyHashCheck = false`. The V2 regex format allows defining extraction patterns:

```json
[
  {"isPublic": false, "regexDef": "(\r\n|^)"},
  {"isPublic": true, "regexDef": "[Ii] [Aa][Pp][Pp][Rr][Oo][Vv][Ee]"},
  {"isPublic": false, "regexDef": "\r\n"}
]
```

**Gap:** The zk-regex subset does NOT support:
- Greedy/lazy matching (`.+`, `.*`)
- `{m,n}` quantifiers
- Lookarounds/lookbehinds

This means "first non-quoted line" detection (lines not starting with `>` or `On ... wrote:`) cannot be expressed as a single regex in the zk-regex subset. **Mitigation:** Define the pattern as `I APPROVE` appearing on a line that starts at `\r\n` (or string start), matching the first occurrence. The circuit only returns the first match. Quoted content (`>`) is ignored because `I APPROVE` preceded by `>` doesn't match the standalone-line pattern.

**Verdict:** GAP — needs custom blueprint. The regex subset is sufficient for case-insensitive `I APPROVE` on a standalone line. The "above quoted content" constraint is naturally satisfied by first-match semantics if the user follows the instructions (reply with `I APPROVE` as the first line of the reply body).

### Req 2: Subject format with envelope ID + docHash

**kysigned needs:** Prove the `Subject` header contains a specific envelope ID and docHash, binding the signing act to a specific document.

**zk-email provides:** Header extraction via decomposed regex. Subject extraction example from docs:

```json
[
  {"isPublic": false, "regexDef": "(\r\n|^)subject:"},
  {"isPublic": true, "regexDef": "[^\r\n]+"},
  {"isPublic": false, "regexDef": "\r\n"}
]
```

**Gap:** The Subject must contain BOTH envelopeId AND docHash. The circuit can extract the full Subject as a public signal, and the on-chain verifier (or the recording contract) can parse it to verify the expected format. Alternatively, two separate regex extractions can target each field. **However**, this only works if `Subject` is in the DKIM `h=` signed headers — see Req 5 below.

**Verdict:** CLOSE FIT — Subject extraction works. Format validation can happen on-chain (cheaper) or in a more specific regex pattern. Depends on R.4 (Subject in `h=`).

### Req 3: First-non-quoted-line detection

**kysigned needs:** Ensure `I APPROVE` appears before any quoted content (lines starting with `>` or `On ... wrote:`).

**zk-email provides:** First-match-only semantics for regex.

**Gap:** Cannot express "line NOT starting with `>`" in zk-regex. However, if the signing email template places `I APPROVE` instructions above the quoted reply chain, and the circuit matches the first occurrence of `I APPROVE` on a standalone line, this is naturally satisfied. The risk is a signer who manually edits and inserts `I APPROVE` inside quoted text — the circuit would still match the first occurrence (which would be above the quote).

**Verdict:** ACCEPTABLE — first-match semantics + signing email template design make this sufficient for MVP. Edge case: maliciously edited email where `I APPROVE` is inserted in quoted text below the actual first line — this is a signer intentionally trying to approve, so the circuit behavior is actually correct.

### Req 4: `From:` header → H(email) commitment

**kysigned needs:** Prove the email was sent from a specific email address, and commit to `H(email)` (hash of the sender's email) as a public signal without revealing the raw email.

**zk-email provides:** `From:` header extraction via decomposed regex. The extracted email address can be hashed inside the circuit using Poseidon.

**Gap:** The existing `EmailVerifier` circuit outputs `pubkeyHash` (Poseidon hash of the DKIM public key). It does NOT automatically output `H(From)`. A custom circuit must add a Poseidon hash computation over the extracted `From:` address bytes.

**Verdict:** GAP — needs custom circuit composition. The zk-email building blocks (EmailVerifier + regex extraction + Poseidon) are all available; they just need to be composed into a kysigned-specific circuit.

### Req 5: `Subject` in DKIM `h=` signed-headers check

**kysigned needs:** Verify that the `Subject` header was cryptographically signed by the sending mail provider's DKIM key.

**zk-email provides:** The `EmailVerifier` circuit verifies the DKIM signature over ALL headers listed in the DKIM-Signature's `h=` tag. The circuit takes the full signed header block as input. If `Subject` is in `h=`, the circuit covers it. If not, the circuit cannot prove `Subject` authenticity.

**Gap:** Whether `Subject` is in `h=` depends on the sending mail provider — this is R.4's investigation. The zk-email docs confirm `h=from:to:subject:date` is the typical configuration. The circuit itself does NOT check whether a specific header name appears in `h=` — it verifies the signature over whatever headers are included.

**Verdict:** DEPENDS ON R.4 — if major providers include `Subject` in `h=` (expected), no gap. If some don't, kysigned needs a fallback (reject cleanly, or use `In-Reply-To`/`References` as alternative binding).

### Req 6: On-chain DKIM key registry (EvidenceKeyRegistry)

**kysigned needs:** An on-chain registry of DKIM public keys keyed by `keyId = keccak256(domain, selector, publicKey)`.

**zk-email provides:** `DKIMRegistry.sol` — stores Poseidon hashes of DKIM public keys per domain. Owner-controlled registration (not permissionless). `UserOverrideableDKIMRegistry.sol` — user-overrideable variant with time-delayed owner approval.

**Gap:** Significant architectural differences:
1. **Hash format:** zk-email uses `Poseidon(key split into 9×242-bit chunks)`. kysigned spec calls for `keccak256`. Decision needed: adopt Poseidon (circuit-friendly, cheaper in zk proofs) or stick with keccak256 (EVM-native, cheaper in Solidity)?
2. **Access control:** zk-email's `DKIMRegistry` is owner-controlled. kysigned spec calls for permissionless, append-only writes. Our `EvidenceKeyRegistry.sol` (R.9) should be permissionless.
3. **No DNSSEC dependency:** Neither zk-email nor kysigned requires DNSSEC. The zk proof's existence proves the key was correct at proof generation time. kysigned's `EvidenceKeyRegistry` archives the key with a blockchain timestamp; non-repudiation comes from key consistency across signatures (F4.9).
4. **Key rotation:** zk-email supports revocation via `revokeDKIMPublicKeyHash()`. kysigned's model is append-only (old keys are never revoked — they remain valid for signatures made while that key was active).

**Verdict:** We write our own `EvidenceKeyRegistry.sol` (R.9) — permissionless + append-only vs zk-email's owner-controlled + revocable. We SHOULD adopt Poseidon hashing for the `pubkeyHash` that appears as a circuit public signal, to match zk-email's internal representation.

## Performance Characteristics

Based on zk-email blog and documentation:

| Metric | Circom/Groth16 (server) | Circom/Groth16 (browser) | Halo2 (browser) |
|--------|------------------------|-------------------------|-----------------|
| Proof generation | <5 seconds (128-core) | Minutes | ~15 seconds |
| Circuit size (header-only) | ~1M constraints | ~1M constraints | — |
| Circuit size (with body) | 3-8M+ constraints | 3-8M+ constraints | — |
| Proof size | ~260 bytes (Groth16) | ~260 bytes | Larger (compressed) |
| On-chain verification gas | ~250K gas (Ethereum) | ~250K gas | — |
| Cost per proof (server) | <$0.01 (spot instances) | N/A | — |

**For kysigned:** Server-side Groth16 proving is the clear choice. The operator generates the proof server-side after receiving the DKIM-signed reply. No client-side proving needed. ~5 seconds per proof, <$0.01 per proof, ~260 bytes on-chain, ~250K gas verification — all well within kysigned's cost model ($0.39/envelope).

**On Base L2:** Gas costs are ~10-100x cheaper than Ethereum mainnet. 250K gas on Base ≈ $0.01-0.05. This is negligible.

## Recommended Architecture

### Circuit: Custom kysigned Blueprint

Compose from zk-email building blocks:

1. **Base:** `EmailVerifier` circuit (DKIM signature verification)
2. **Body regex:** Decomposed regex matching `I APPROVE` on standalone line
3. **From regex:** Decomposed regex extracting sender email
4. **Subject regex:** Decomposed regex extracting subject (contains envelopeId + docHash)
5. **Public signals (3):**
   - `pubkeyHash` — Poseidon hash of DKIM public key (from EmailVerifier)
   - `fromHash` — Poseidon hash of extracted From email bytes
   - `subjectPublic` — full subject string as public signal
   Note: `I APPROVE` body match is a private circuit constraint, NOT a public signal. The proof's existence proves the body matched — putting the literal string on-chain wastes gas for information already implied by a valid proof.

### Proof System: Groth16

- Smallest proof size (~260 bytes)
- Cheapest on-chain verification (~250K gas, ~$0.01-0.05 on Base)
- Fastest server-side generation (<5 seconds)
- Mature tooling (snarkjs, rapidsnark, @zk-email/sdk)
- Trade-off: requires trusted setup (one-time ceremony per circuit)

### On-chain Contracts

1. **`EvidenceKeyRegistry.sol`** (custom, R.9) — permissionless, append-only, blockchain-timestamped
2. **`Groth16Verifier.sol`** (generated by snarkjs from the circuit's verifying key)
3. **`SignatureRegistry.sol`** (rewritten in Phase 1R) — calls `Groth16Verifier` to validate proofs before recording

### SDK Integration

Use `@zk-email/sdk` v2+ Blueprint system:
- Define kysigned-specific blueprint with body + header regex patterns
- Server-side: `blueprint.createProver()` → `prover.generateProof(rawMime)`
- On-chain: `verifier.verifyProof(proof, publicSignals)`

## Packages to Adopt

| Package | Version | Purpose |
|---------|---------|---------|
| `@zk-email/sdk` | ^2.0.11 | Blueprint definition, proof generation |
| `@zk-email/helpers` | ^6.4.2 | DKIM parsing, circuit input generation |
| `@zk-email/circuits` | ^6.4.2 | EmailVerifier base circuit |
| `@zk-email/contracts` | ^6.4.2 | Reference (NOT adopted directly — we write our own registry) |
| `snarkjs` | latest | Groth16 proof generation + verification |

## Open Questions for R.2+

1. **Circuit compilation time:** How long to compile the custom blueprint? (measured in R.2)
2. **Trusted setup:** Use Powers of Tau ceremony from zk-email, or run our own? (R.3)
3. **Body length limit:** What `maxBodyLength` to choose? Larger = more constraints = slower proving. Most approval replies are short (<1KB body). (R.2)
4. **Subject in h=:** Confirmed typical but needs R.4 empirical data.
5. **Poseidon vs keccak256 for fromHash on-chain:** Poseidon is cheaper in-circuit but adds a dependency. keccak256 is EVM-native. The searchKey uses argon2id anyway, so this is just for the circuit's public signals. (R.7 informs this)

## Conclusion

**Recommendation: Adopt zk-email as the foundation, build a custom kysigned Blueprint circuit.**

The zk-email stack provides 80% of what kysigned needs out of the box. The remaining 20% is circuit composition (combining EmailVerifier + regex patterns + custom public signals) and a custom `EvidenceKeyRegistry.sol` contract. The SDK and toolchain are mature (v6.4.2, audited by zkSecurity + yAcademy), the performance characteristics fit kysigned's cost model, and the Groth16 proof system delivers the smallest on-chain footprint.

No fundamental blockers. The custom work is circuit definition + contract writing, not cryptographic innovation.
