# zkprover v0.1.0 — Comparison Matrix

**Date:** 2026-04-12
**Spec:** docs/products/zkprover/zkprover-spec.md v0.1.0
**Candidates tested:** A (snarkjs PLONK), B (TACEO co-snarks), C (SP1 zkVM), D (RISC Zero zkVM), **E (Circom + rapidsnark)**
**Shared test input:** `kysigned/zkprover-candidates/shared/test-input.eml` — DKIM-signed Gmail reply-to-sign email, DKIM verified via dkimpy 1.1.8

---

## Results Matrix

| Metric | **A — snarkjs PLONK** | **B — TACEO** | **C — SP1 zkVM** | **D — RISC Zero** | **E — rapidsnark** |
|---|---|---|---|---|---|
| **Status** | ✅ Complete | ❌ Blocked (DD-4) | ✅ Complete | ✅ Complete | ✅ **Complete** |
| **Proof generated?** | ✅ Yes (PLONK) | ❌ No (zkey corrupt after 6 attempts) | ✅ Yes (STARK + Groth16 wrap) | ✅ Yes (STARK; Groth16 wrap needs Bonsai) | ✅ **Yes (Groth16)** |
| **On-chain verified?** | ✅ `verifyProof` returned `true` | ❌ | ❌ Blocked on ABI encoding | ❌ Groth16 wrap not executed locally | ✅ **`verifyProof` returned `true`** |
| **On-chain gas** | 🟢 **297,968** (measured) | ⚠️ not measured | 🟢 **~270k** (documented, not measured) | 🟢 **~280k** (documented, not measured) | 🟢 **255,820** (measured) |
| **Per-proof time** | ⚠️ **3h 05m** | ⚠️ blocked | **16m 35s** | 🟢 **3m 03s** | 🟢 **13.49s** |
| **Per-proof peak RAM** | ⚠️ **88.1 GB** | ⚠️ blocked | **34.2 GB** | 🟢 **8.4 GB** | 🟢 **3.57 GB** |
| **One-time setup time** | 3h 37m (PLONK setup, never repeated unless circuit changes) | N/A | N/A (no per-circuit setup) | N/A (no per-circuit setup) | ~13 min (Groth16 setup, per-circuit Phase 2) |
| **Proof size** | 2,248 bytes | N/A | **256 bytes** | **~260 bytes** | **707 bytes** |
| **zkey size** | ⚠️ **42 GB** (lost, must regenerate) | N/A | N/A (no zkey) | N/A (no zkey) | **2.3 GB** |
| **Trust anchor** | Hermez ppot (100+ contributors, EF/Vitalik/Zcash) | Same as A | Hermez ppot Phase 1 + Succinct Phase 2 (participant count TBD) | **STARK = math-only (no ceremony)** + RISC Zero 238-contributor Groth16 wrapper (PSE/EF coordinated) | Hermez ppot Phase 1 + **single-party Phase 2 (research only)** |
| **Attack surface delta** | None vs baseline (snarkjs IS the baseline) | TACEO unaudited; snarkjs verifier is trust root | SP1 zkVM (audited: KALOS, Cantina, Veridise Picus, Zellic) + unaudited zkemail Rust port (cfdkim) | RISC Zero zkVM (audited: Hexens, Veridise R2, Picus FV 45k+ constraints) + unaudited zkemail Rust port (same cfdkim) | **None vs baseline — same circuit as A, different prover** |
| **License** | GPL-3.0 (copyleft) | MIT/Apache-2.0 | MIT/Apache-2.0 | **Apache-2.0** (permissive) | GPL-3.0 (rapidsnark + snarkjs + circom) |
| **Production track record** | Ubiquitous (Semaphore, Tornado, World ID legacy) | None | Blobstream, OP Succinct Mantle ($2B TVL), Polygon AggLayer, $1B+ TVL | Citrea, **Boundless on Base** (Sept 2025, 542T cycles), Wormhole, Nethermind | **rapidsnark: Polygon ID, iden3. Circuit: 5000+ production proofs** |
| **Audit status** | No major-firm audit of snarkjs | None (self-declared experimental) | KALOS + Cantina + Veridise Picus (ongoing) + Zellic RV32IM | Hexens + Veridise Round 2 + **Picus FV 45k+ constraints** + HackenProof bounty | **5 audits on circuit: zksecurity, Matter Labs, Zellic, Ackee, yAcademy** |
| **Formal verification** | None | None | In progress (Veridise Picus) | **First FV'd RISC-V zkVM** (Picus, 45k+ constraints) | None (circuit FV possible via Halva) |
| **Fits Lambda (10 GB)?** | ❌ No (88 GB) | N/A | ❌ No (34 GB) | ✅ **Yes (8.4 GB)** | ✅ **Yes (3.57 GB)** |
| **Fits Fargate (16 GB)?** | ❌ No | N/A | ❌ No (34 GB; needs 64+ GB) | ✅ **Yes** | ✅ **Yes** |
| **Per-proof compute cost** | ~$3.00 | N/A | ~$0.28 | 🟢 **~$0.005** | 🟢 **~$0.004** |
| **All-in $/signature** | ❌ **~$3.03** (compute $3.00 + gas $0.02 + email $0.001 + KMS $0.005) | N/A | ❌ **~$0.31** (compute $0.28 + gas $0.02 + email $0.001 + KMS $0.005) | 🟢 **~$0.033** (compute $0.005 + Groth16 wrap $0.002 + gas $0.02 + email $0.001 + KMS $0.005) | 🟢 **~$0.011** (compute $0.004 + gas $0.001 + email $0.001 + KMS $0.005) |
| **Passes $0.15/sig cap?** | ❌ No (20× over) | N/A | ❌ No (2× over) | ✅ **Yes** ($0.033 — 78% under cap) | ✅ **Yes** ($0.011 — **93% under cap**) |
| **Per-2-signer-envelope cost** | ~$6.06 (exceeds $0.29 pricing) | N/A | ~$0.62 | 🟢 **~$0.066** | 🟢 **~$0.022** |
| **Reproducibility** | ⚠️ npm-resolution sensitive, no lockfile committed, 42 GB zkey lost | ⚠️ Failed to reproduce A | ✅ Cargo.lock vendored | ✅ **Cargo.lock vendored, deterministic Rust build** | ✅ npm lockfile committed, zkey reproducible from ptau |
| **Archival complexity** | High (snarkjs versions + ptau + 42 GB zkey + npm lockfile) | N/A | Medium (SP1 toolchain + Cargo.lock + ptau + wrapper keys) | **Low** (risc0-zkvm crate + Cargo.lock; no per-circuit artifacts) | Medium (circom + rapidsnark + ptau + 2.3 GB zkey) |
| **AWS spend** | $8.07 | $11.09 (wasted — no result) | TBD (not reported) | **$0.82** | **~$1.00** (30 min EC2 including setup) |

Sources: Each cell references the candidate's `measurements.md` in its respective worktree branch (`zkprover-{A,B,C,D}`).

**All-in $/signature methodology (added v2.0):** Compute cost + on-chain gas cost (Base L2, ~$0.02 for ~280k gas) + email cost (~$0.001/sig, AWS SES) + KMS sign fee (~$0.005/sig, run402 markup). For Candidate D, includes Groth16 wrap compute (~$0.002). Gas USD derived from ~0.01 gwei Base gas price + L1 data posting. Per-signer costs sourced from `kysigned-spec.md` (§ Cost Model). The **$0.15/sig hard cap** is from DD-v2.2 (audited-alternatives plan).

---

## Interpretation

### Winner: Candidate D (RISC Zero)

**D dominates on every operational axis:**

- **60× faster** proving than A (3 min vs 3 hours)
- **10× leaner** RAM than A (8.4 GB vs 88 GB) — fits Lambda, fits Fargate, fits any modest compute tier
- **600× cheaper** per proof than A ($0.005 vs $3.00) — healthy margin at $0.29/envelope pricing
- **No zkey to manage** — no 42 GB artifact to store, back up, and regenerate if lost
- **Strongest formal verification** — Picus verifies 45k+ zkVM constraints, "first formally-verified RISC-V zkVM"
- **238-contributor ceremony** — larger and more recent than Hermez ppot, PSE/EF coordinated
- **Trust model is strictly better** than PLONK: the inner STARK proof is math-only (no ceremony); only the Groth16 compression wrapper uses a ceremony
- **Longest Base-specific production track record** — Boundless on Base since Sept 2025
- **Permissive license** (Apache-2.0 vs snarkjs GPL-3.0)
- **Deterministic builds** (Cargo.lock + pinned Rust toolchain vs npm resolution sensitivity)

### C (SP1) is a credible backup but not preferred

C is also a valid zkVM path with strong production track record ($1B+ TVL). However:
- 5× slower than D (16 min vs 3 min)
- 4× more RAM than D (34 GB vs 8.4 GB) — does NOT fit Lambda or modest Fargate
- SHA-256 precompile was not active in the test build (patch version mismatch), so C's numbers may improve with a fix
- On-chain verification was blocked on ABI encoding — unresolved
- SP1's Phase 2 ceremony participant count is TBD (less transparency than RISC Zero's 238-contributor figure)

### A confirmed the hypothesis but is economically unviable

A proved that snarkjs PLONK works at 10M constraints with the corrected V8 flags (`--max-semi-space-size=1024`). This is a valuable finding that resolves the original 1R.3 blocker. However, the per-proof operational profile (3h, 88 GB, $3/proof) makes A unsuitable for production at any volume — the compute cost exceeds the per-envelope revenue.

### B produced no result and confirmed snarkjs fragility

B spent $11+ and 6 attempts without producing a valid zkey. The root cause: snarkjs PLONK setup produces structurally corrupt zkeys when dependency versions differ slightly from A's environment. This finding independently validates choosing D over the snarkjs path — snarkjs at this scale is fragile and hard to reproduce.

### Shared finding across C and D: cfdkim is the DKIM trust gap

Both C and D use `cfdkim` (RISC Zero fork of Cloudflare's DKIM library) for canonicalization. This library is unaudited in the ZK context. Before either C or D is adopted for production, the cfdkim code at commit `3213315e` must be reviewed against RFC 6376 and the audited `@zk-email/circuits` Circom implementation. This is a post-winner deferred task, not a candidate selection criterion (since both share the same dependency).

### Surprising findings

1. **A's per-proof time (3h 5m) was ~200× worse than the pre-build estimate (20-60 seconds).** The estimate was based on native-code provers; snarkjs is JavaScript. This gap was the single biggest revelation of the v0.1.0 research.
2. **D's per-proof RAM (8.4 GB) fits in AWS Lambda's 10 GB cap.** This was uncertain before measurement. It means D can deploy as a serverless function — the simplest possible run402 platform extension.
3. **B's inability to reproduce A's zkey** despite using the same snarkjs version reveals that snarkjs PLONK setup is non-deterministic or environment-sensitive at 10M constraints. This is a production reliability concern for any snarkjs-based path.
4. **D cost $0.82 total** for the entire build+prove cycle — 10× less than A ($8.07) and 13× less than B ($11.09, with no result).
