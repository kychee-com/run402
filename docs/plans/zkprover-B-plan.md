# Plan: zkprover-B (Candidate B — TACEO co-snarks Rust PLONK)

**Owner:** Barry Volinskey
**Created:** 2026-04-11
**Status:** Planning
**Spec:** docs/products/zkprover/zkprover-spec.md
**Spec-Version:** 0.1.0
**Source:** spec
**Worktree:** `C:\Workspace-Kychee\kysigned-zkprover-B\` (branch `zkprover-B`)
**Master plan:** [zkprover-plan.md](zkprover-plan.md)

## Legend
- `[ ]` Todo | `[~]` In Progress | `[x]` Done

## Scope

This sub-plan covers **only Candidate B — TACEO co-snarks Rust-native PLONK prover**. Circuit stays byte-identical to `kysigned/circuits/kysigned-approval.circom`. The hypothesis: TACEO's Rust prover can produce a snarkjs-compatible PLONK proof from the same circuit + Hermez ppot, proving that a Rust-native circom-PLONK pipeline exists and works at the 8M-constraint scale.

**Important role framing:** Candidate B is a **validator build, not production-primary**. Per the master plan and the spec's ideas file (Key Decision #8), TACEO's prover is self-declared "experimental and un-audited." The snarkjs-compatible Solidity verifier is the cryptographic trust root — a buggy TACEO prover can at worst produce proofs that *fail* to verify on-chain; it cannot produce proofs that fraudulently verify, because the verifier independently checks the PLONK math. This sub-plan's value is (a) proving a Rust-native circom-PLONK pipeline works for kysigned, (b) giving us a future production candidate once TACEO is audited, (c) cross-validating Candidate A's output via a completely independent prover on the same math. **This role may be revisited if measurement shows B is clearly superior on other axes.**

**Sub-plan is independent.** Runs in a dedicated worktree via `/implement zkprover-B`. Shared Phase 0 prerequisites must be complete before this sub-plan starts — the master `zkprover-plan.md` enforces this.

**Design Decisions apply from the master plan.** DDs 1-11 in `zkprover-plan.md` govern this sub-plan. Particularly relevant:
- DD-2: uniform thin-wrapper scripts
- DD-3: $15 per-candidate spend cap
- DD-4: blocked threshold
- DD-6: worktree is `C:\Workspace-Kychee\kysigned-zkprover-B\`

---

## Tasks

### Phase 1-B: Candidate B build, measure, verify, cross-validate

- [ ] **1B.1** Scaffold `kysigned/zkprover-candidates/B-taceo/` with `README.md`, `build.sh`, `prove.sh`, `verify-local.sh`, `deploy-verifier.sh`, `verify-onchain.sh`, `measurements.md` template, and a `contracts/` subfolder. README explicitly states the **validator role framing** and includes a direct link to TACEO's README with the "experimental and un-audited" disclaimer highlighted. [code] `AI`
- [ ] **1B.2** Write `build.sh`: clones `TaceoLabs/co-snarks` at a pinned commit hash into `B-taceo/vendor/co-snarks/`, strips `.git`, installs the Rust toolchain via `rustup` with a pinned version from `rust-toolchain.toml`, builds the co-circom Rust crate via `cargo build --release`. Nested self-contained — no edits to root `Cargo.toml`, no workspace references. Copies `kysigned/circuits/kysigned-approval.circom` into the candidate folder. Downloads the same `powersOfTau28_hez_final_23.ptau` used by Candidate A (ideally from a local cache if A is running concurrently; otherwise fresh fetch from Hermez mirror). [code] `AI`
- [ ] **1B.3** Write `prove.sh`: generates witness from `test-input.eml` (same witness generation as A — reuse `@zk-email/helpers` for parsing), runs TACEO's co-circom command to produce the PLONK proof from circuit + ptau + witness. Captures setup time, proving time, peak RAM into `measurements.md`. [code] `AI`
- [ ] **1B.4** Provision EC2 r5.4xlarge on-demand in `us-east-1` (tag: `Purpose=kysigned-zkprover-B`), clone the `B-taceo/` subfolder onto the instance, run `./build.sh`, then `./prove.sh ../shared/test-input.eml`. Record instance details and output. [infra] `AI`
- [ ] **1B.5** Apply DD-4 blocked protocol if prove fails. TACEO is newer than snarkjs so unknown failure modes are possible — specifically watch for: (a) zkey format mismatch with Hermez ptau, (b) constraint-count limits, (c) Rust OOM at setup (less likely given the Rust allocator, but measure). Debug up to two hypotheses before escalating. [infra] `AI`
- [ ] **1B.6** Write `verify-local.sh`: runs TACEO's own verifier on the proof. If successful, also runs `snarkjs plonk verify vkey.json public.json proof.json` (using A's snarkjs verifier) as a **cross-check against A's independent implementation**. If both verifiers pass on the same proof, this is strong evidence of snarkjs-compatibility. [code] `AI`
- [ ] **1B.7** Export the Solidity verifier via TACEO's export command. Run a byte-level diff against A's Solidity verifier (after metadata strip per the kysigned DD-17 playbook). If byte-identical, log that as evidence of full snarkjs-compatibility. If not identical, document the differences in `measurements.md` — this is a meaningful finding. Copy the verifier into `B-taceo/contracts/`. [code] `AI`
- [ ] **1B.8** Write `deploy-verifier.sh`: deploys B's own Solidity verifier to Base Sepolia (per self-containment, even if byte-identical to A's, B deploys its own copy). Records address. [infra] `AI`
- [ ] **1B.9** Write `verify-onchain.sh`: calls `verifyProof` on B's deployed verifier with B's proof. Records tx hash + gas cost. [infra] `AI`
- [ ] **1B.10** **Cross-validation cross-check:** Submit A's proof to B's deployed verifier, and B's proof to A's deployed verifier (this requires reading A's verifier address from A's `measurements.md` in the A worktree, which may require cross-worktree coordination — if A's worktree is accessible, read it; otherwise defer this task and note in the log). If both proofs verify on both verifiers, document it as strong evidence of convergent correctness. [infra] `AI`
- [ ] **1B.11** Populate `measurements.md` with complete metrics:
  - Setup time, peak setup RAM
  - Proving time, peak proving RAM
  - Proof size (bytes), zkey size (bytes)
  - Deployed verifier address (Base Sepolia), tx hash, gas cost (with tier marker)
  - Byte-identicality cross-check result with A's verifier
  - Cross-validation result (A↔B proof/verifier cross-checks, if performed)
  - Trust anchor: "Hermez Perpetual Powers of Tau (same as Candidate A)"
  - Attack surface delta: "TACEO co-snarks Rust codebase is self-declared experimental and un-audited. Mitigation: the snarkjs-compatible Solidity verifier is the trust root — a buggy TACEO prover can only produce proofs that fail to verify. Recommended role: validator, not production-primary, until TACEO is audited."
  - License: MIT/Apache-2.0 per TACEO repo
  - Production track record: "None named. Active development (754 commits as of Nov 2025 release). Underpins TACEO's Private Shared State / Aztec work."
  - Audit status: "No public audit of co-snarks itself as of April 2026. TACEO's OPRF circuits (separate product) audited by Least Authority Jan 2026."
  - Archival artifact list: TACEO commit hash, Rust toolchain version, Cargo.lock of vendored deps, circom compiler version, ptau file SHA-256.
  [code] `AI`
- [ ] **1B.12** Mandatory AWS cleanup: terminate EC2, delete EBS, verify via `describe-instances` filter. Log spend. Escalate if exceeded $15. [infra] `AI`
- [ ] **1B.13** Commit `B-taceo/` subfolder to branch `zkprover-B`. Push. Mark sub-plan `Status: Complete`. [code] `AI`

---

## Implementation Log

### Gotchas

_(empty — to be populated during implementation)_

### Deviations

_(empty — to be populated during implementation)_

### AWS Spend Tracking (Candidate B)

- Candidate B spend: $0.00 / $15 budget

---

## Log

- 2026-04-11: Sub-plan created from master zkprover-plan.md. Phase 1-B has 13 tasks. Starts after master Phase 0 completes.
