# Plan: zkprover-D (Candidate D — RISC Zero + boundless-xyz/r0-zkEmail)

**Owner:** Barry Volinskey
**Created:** 2026-04-11
**Status:** Planning
**Spec:** docs/products/zkprover/zkprover-spec.md
**Spec-Version:** 0.1.0
**Source:** spec
**Worktree:** `C:\Workspace-Kychee\kysigned-zkprover-D\` (branch `zkprover-D`)
**Master plan:** [zkprover-plan.md](zkprover-plan.md)

## Legend
- `[ ]` Todo | `[~]` In Progress | `[x]` Done

## Scope

This sub-plan covers **only Candidate D — RISC Zero zkVM + `boundless-xyz/r0-zkEmail` fork**. RISC Zero is the longest-in-production Rust STARK zkVM. Same architectural approach as Candidate C: Rust guest program proves DKIM verification via STARKs, final proof wrapped in Groth16 for EVM verification. EVM verifier gas: ~280k (below PLONK).

**Why D is distinct from C despite both being Rust+STARK+Groth16-wrap:**
- **Stronger formal verification story.** RISC Zero is marketed as "first formally-verified RISC-V zkVM." Picus (Veridise) formally verifies ~45k+ constraints of the RISC-V circuit including the Keccak accelerator. SP1's Picus FV is ongoing but not as far along.
- **Larger published ceremony.** RISC Zero's Groth16 wrapper ceremony had **238 named contributors** via p0tion + PSE-coordinated, publicly verified transcripts. SP1's Phase 2 size is TBD per spec Open Question #3.
- **Longest production track record on Base specifically.** Boundless mainnet is live on Base since September 2025, 542 trillion cycles by August 2025. This is directly relevant to kysigned because kysigned targets Base.
- **Longer overall production history.** RISC Zero has been mainnet-live since 2023, vs SP1's 2024 mainnet launch.
- **Different audit chain.** Hexens + Veridise Round 2 (April 2025). No Trail of Bits or Zellic as I'd earlier mis-claimed (retracted during the confirmation research).

**Fork strategy (DD-5):** Clone `boundless-xyz/r0-zkEmail` into `D-risc0/vendor/r0-zkEmail/` with `.git` stripped. Attribution in `VENDOR.md`. Same DKIM canonicalization pre-review as C (1C.3 equivalent).

**Plonky3 shared-substrate caveat:** RISC Zero also uses Plonky3 as its STARK backend — same as SP1. A Plonky3 bug affects both simultaneously. The January 2025 Plonky3 polynomial-eval batching bug (found by Least Authority audit, fixed upstream) propagated to both. This is acknowledged as a known shared risk, not a disqualifier.

**Sub-plan is independent.** Runs in a dedicated worktree via `/implement zkprover-D`. Shared Phase 0 prerequisites must be complete.

**Design Decisions apply from the master plan.** DDs 1-11 in `zkprover-plan.md` govern this sub-plan.

---

## Tasks

### Phase 1-D: Candidate D build, measure, verify

- [ ] **1D.1** Scaffold `kysigned/zkprover-candidates/D-risc0/` with `README.md`, `build.sh`, `prove.sh`, `verify-local.sh`, `deploy-verifier.sh`, `verify-onchain.sh`, `measurements.md` template, `contracts/` subfolder, and `vendor/` subfolder. README describes RISC Zero's formal-verification story (Picus + Veridise, 45k+ formally verified constraints, "first formally-verified RISC-V zkVM"), 238-contributor Groth16 ceremony, Boundless mainnet on Base, HackenProof bug bounty, audit chain (Hexens + Veridise Round 2 April 2025). [code] `AI`
- [ ] **1D.2** Clone `boundless-xyz/r0-zkEmail` at a pinned commit into `D-risc0/vendor/r0-zkEmail/`. Strip `.git`. Record in `vendor/r0-zkEmail/VENDOR.md`:
  - Upstream URL: https://github.com/risc0-labs/r0-zkEmail (or boundless-xyz fork)
  - Commit hash (pinned)
  - License (expected Apache-2.0)
  - Vendor date: 2026-04-11
  [infra] `AI`
- [ ] **1D.3** **DKIM canonicalization code review (pre-audit).** Same scope as 1C.3: inspect the vendored r0-zkEmail guest program, document:
  - Rust crates used for RSA-2048, SHA-256
  - DKIM canonicalization implementation approach
  - Divergence from RFC 6376 or audited `@zk-email/circuits`
  - Any TODO/FIXME flagged gaps

  Document in `measurements.md` under "attack surface delta." Flag findings. [code] `AI`
- [ ] **1D.4** Adapt the vendored guest program's input handling for kysigned-shaped inputs (canonical Subject parsing for envelopeId + docHash). Minimal changes — thin adapter in `guest/src/kysigned_adapter.rs`. [code] `AI`
- [ ] **1D.5** Write `build.sh`: install RISC Zero toolchain via `curl -L https://risczero.com/install | bash && rzup install --version <pinned>`, build the guest program + host driver via `cargo risczero build` or equivalent. Nested Cargo workspace inside candidate folder. [code] `AI`
- [ ] **1D.6** Write `prove.sh`: runs the RISC Zero host driver which loads the guest ELF, feeds the test input, generates the STARK (Plonky3) proof, wraps in Groth16. Captures phase-separated time + peak RAM into `measurements.md`. [code] `AI`
- [ ] **1D.7** Provision EC2 r5.4xlarge on-demand (tag: `Purpose=kysigned-zkprover-D`), clone `D-risc0/` including vendor, run `./build.sh` then `./prove.sh ../shared/test-input.eml`. Apply DD-4 blocked protocol on failure. Watch for: toolchain version mismatches, guest-program compile errors (adapter issue), RISC Zero Groth16 wrapper artifact fetch failures. [infra] `AI`
- [ ] **1D.8** Write `verify-local.sh`: uses RISC Zero's own verifier on the Groth16 wrapper proof. Confirms valid. [code] `AI`
- [ ] **1D.9** Write `deploy-verifier.sh`: deploys RISC Zero's generated Solidity Groth16 verifier (from `risc0/risc0-ethereum` at the matching version) to Base Sepolia. Records address. [infra] `AI`
- [ ] **1D.10** Write `verify-onchain.sh`: calls `verifyProof` on the deployed RISC Zero verifier with the Groth16 wrapper proof. Confirms returns `true`. Records tx hash + gas cost. Expected: ~280k gas. [infra] `AI`
- [ ] **1D.11** Populate `measurements.md` with complete metrics:
  - STARK proving time + peak RAM
  - Groth16 wrap time + peak RAM
  - Total prove time
  - Proof size (Groth16 wrapper ~260 bytes)
  - Deployed verifier address, tx hash, gas cost (with tier marker)
  - Trust anchor: "RISC Zero 238-contributor p0tion + PSE-coordinated Groth16 wrapper ceremony, publicly verified transcripts. Inner STARK is math-only (no ceremony)."
  - Attack surface delta: RISC Zero zkVM trusted computing base (RISC-V circuit with Picus-formal-verified Keccak accelerator + 45k+ constraints, Plonky3 STARK backend shared with SP1, precompiles), r0-zkEmail port canonicalization review findings from 1D.3
  - License: RISC Zero Apache-2.0, guest program Apache-2.0
  - Production track record: Citrea Bitcoin L2 (via BitVM), Boundless mainnet on **Base** since Sept 2025 (542T cycles, 399k orders by Aug 2025), Wormhole ZK consensus integration, Nethermind Stellar zk bridge, R0VM 2.0 release. Live on Base specifically since late 2025.
  - Audit status: Hexens (v1 zk-circuit + STARK-to-SNARK wrapper, ~10 engineer-weeks), Veridise Round 2 (April 2025, `VAR-Risc0-241028-Round2-V4.pdf`). Picus formal verification covers 45k+ constraints of the RISC-V circuit. HackenProof bug bounty program. r0-zkEmail port unaudited.
  - Archival artifact list: RISC Zero commit/tag, guest program commit, Rust toolchain version, Cargo.lock, ptau reference (Phase 1), RISC Zero Groth16 wrapper key artifacts
  [code] `AI`
- [ ] **1D.12** Mandatory AWS cleanup. Terminate EC2, delete EBS, verify via describe-instances filter. Log spend. Escalate if >$15. [infra] `AI`
- [ ] **1D.13** Commit `D-risc0/` subfolder to branch `zkprover-D`, including `vendor/r0-zkEmail/` (with `.git` stripped), EXCLUDING large build artifacts. Push. Mark sub-plan `Status: Complete`. [code] `AI`

---

## Implementation Log

### Gotchas

_(empty — to be populated during implementation)_

### Deviations

_(empty — to be populated during implementation)_

### AWS Spend Tracking (Candidate D)

- Candidate D spend: $0.00 / $15 budget

---

## Log

- 2026-04-11: Sub-plan created from master zkprover-plan.md. Phase 1-D has 13 tasks. Starts after master Phase 0 completes.
