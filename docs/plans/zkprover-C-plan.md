# Plan: zkprover-C (Candidate C — SP1 zkVM + zkemail/sp1-zkEmail)

**Owner:** Barry Volinskey
**Created:** 2026-04-11
**Status:** Planning
**Spec:** docs/products/zkprover/zkprover-spec.md
**Spec-Version:** 0.1.0
**Source:** spec
**Worktree:** `C:\Workspace-Kychee\kysigned-zkprover-C\` (branch `zkprover-C`)
**Master plan:** [zkprover-plan.md](zkprover-plan.md)

## Legend
- `[ ]` Todo | `[~]` In Progress | `[x]` Done

## Scope

This sub-plan covers **only Candidate C — SP1 zkVM + `zkemail/sp1-zkEmail` fork**. SP1 is Succinct Labs' STARK-based Rust zkVM. The DKIM verification logic is written as a Rust "guest program," SP1 proves it via STARKs (Plonky3 backend), then wraps the final proof in a Groth16 wrapper over Hermez ppot Phase 1 + Succinct's public Phase 2 ceremony. EVM verifier gas: ~270k (below PLONK).

**Fork strategy (DD-5):** `zkemail/sp1-zkEmail` is cloned into `C-sp1/vendor/sp1-zkEmail/` with `.git` stripped. Attribution preserved in `vendor/sp1-zkEmail/VENDOR.md`. We adapt the vendored guest program's input handling for kysigned-shaped inputs (canonical subject with envelopeId + docHash). We do NOT rewrite the DKIM verification logic — we use what zk-email already wrote and audited-upstream-in-circom.

**Important caveat:** The Rust reimplementation of DKIM canonicalization inside the zkEmail SP1 port is **unaudited** as of April 2026. Per spec F3.4 and Open Question #4, we inspect this code during the build and flag any RFC-6376 divergences or deviations from the audited `@zk-email/circuits` reference. This inspection is a **pre-requisite review**, not a post-hoc audit — it's how we qualify C for the comparison matrix. A full external audit is a **deferred task** post-winner (if C wins).

**SP1 Turbo status (post-January 2025 disclosures):** SP1 had three publicly-disclosed soundness bugs in early 2025, all fixed in SP1 Turbo. SP1 V2/V3 were end-of-lifed February 15, 2025. This sub-plan uses SP1 Turbo or later — **do not accept any SP1 version predating Turbo**.

**Sub-plan is independent.** Runs in a dedicated worktree via `/implement zkprover-C`. Shared Phase 0 prerequisites must be complete.

**Design Decisions apply from the master plan.** DDs 1-11 in `zkprover-plan.md` govern this sub-plan. DD-3 (spend cap), DD-4 (blocked threshold), DD-5 (fork strategy), DD-6 (worktree) are particularly relevant.

---

## Tasks

### Phase 1-C: Candidate C build, measure, verify

SP1 is the most complex candidate to build. Expect Rust toolchain setup, cargo build times measured in minutes, and guest-program compilation through the SP1 compiler. Budget cap ($15) gives ~15 hours of r5.4xlarge on-demand which should be sufficient.

- [ ] **1C.1** Scaffold `kysigned/zkprover-candidates/C-sp1/` with `README.md`, `build.sh`, `prove.sh`, `verify-local.sh`, `deploy-verifier.sh`, `verify-onchain.sh`, `measurements.md` template, `contracts/` subfolder, and `vendor/` subfolder. README describes SP1's Turbo post-disclosure status, the Succinct audit chain (KALOS, Cantina audit-competition, Veridise Picus FV ongoing, Zellic RV32IM), the $1B+ TVL production track record (Celestia Blobstream, OP Succinct on Mantle, Polygon AggLayer, SP1 Hypercube), and the zkEmail-port's unaudited status. [code] `AI`
- [ ] **1C.2** Clone `zkemail/sp1-zkEmail` at a pinned commit into `C-sp1/vendor/sp1-zkEmail/`. Strip `.git` after clone. Record in `vendor/sp1-zkEmail/VENDOR.md`:
  - Upstream URL: https://github.com/zkemail/sp1-zkEmail
  - Commit hash (pinned)
  - License (expected MIT)
  - Vendor date: 2026-04-11
  - Any commits since the pinned one that we're deliberately NOT pulling in (with rationale)
  [infra] `AI`
- [ ] **1C.3** **DKIM canonicalization code review (pre-audit).** Inspect the vendored SP1-zkEmail guest program. Document in `measurements.md` under "attack surface delta":
  - Which Rust crates are used for RSA-2048 signature verification (e.g., `rsa`, `ring`, `num-bigint`, custom big-int implementation)
  - Which Rust crates are used for SHA-256 (e.g., `sha2`, `ring`, custom)
  - How DKIM canonicalization is implemented (is it a dedicated library, hand-rolled against RFC 6376, or ported from @zk-email/circuits?)
  - Any obvious divergence from RFC 6376 "simple" or "relaxed" canonicalization
  - Any TODO / FIXME comments in the canonicalization code suggesting known gaps
  - Any differences from the audited `@zk-email/circuits` canonicalization behavior that could be exploited

  Flag findings. This is documentary review, not a fix — fixes are a post-winner deferred task per spec F3.4. [code] `AI`
- [ ] **1C.4** Adapt the vendored guest program's input handling to accept our `shared/test-input.eml` format. Specifically: teach the guest program to parse the canonical Kysigned Subject (`[kysigned] <envelopeId> <docHash>`) and bind its values as public inputs. **Minimal changes** — don't rewrite DKIM, just feed it our input shape. Any adaptation goes in a thin wrapper `guest/src/kysigned_adapter.rs` in the vendored folder; the upstream code stays untouched where possible. [code] `AI`
- [ ] **1C.5** Write `build.sh`: install SP1 toolchain via `curl -L https://sp1.succinct.xyz | bash && sp1up --version <pinned-turbo-or-later>`, build the guest program and host driver via `cargo build --release` in `C-sp1/`. Nested Cargo workspace inside the candidate folder — no edits to any parent Cargo.toml. [code] `AI`
- [ ] **1C.6** Write `prove.sh`: runs the SP1 host driver which (a) loads the guest ELF, (b) feeds `shared/test-input.eml`, (c) generates the STARK proof, (d) wraps it in Groth16. Captures time + peak RAM per phase (STARK vs Groth16 wrap) into `measurements.md`. [code] `AI`
- [ ] **1C.7** Provision EC2 r5.4xlarge on-demand (tag: `Purpose=kysigned-zkprover-C`), clone `C-sp1/` including vendor, run `./build.sh` then `./prove.sh ../shared/test-input.eml`. Apply DD-4 blocked protocol on failure. Watch for: guest-program compile errors (adapter issue), SP1 toolchain version mismatch, Groth16 wrapper ceremony artifact fetch failures. [infra] `AI`
- [ ] **1C.8** Write `verify-local.sh`: uses SP1's own verifier command on the Groth16 wrapper proof. Confirms valid. [code] `AI`
- [ ] **1C.9** Write `deploy-verifier.sh`: deploys SP1's generated Solidity Groth16 verifier (from `succinctlabs/sp1-contracts` at the matching version) to Base Sepolia. Records address. [infra] `AI`
- [ ] **1C.10** Write `verify-onchain.sh`: calls `verifyProof` on the deployed SP1 verifier with the Groth16 wrapper proof. Confirms returns `true`. Records tx hash + gas cost. Expected: ~270k gas. [infra] `AI`
- [ ] **1C.11** Populate `measurements.md` with complete metrics:
  - STARK proving time + peak RAM
  - Groth16 wrap time + peak RAM (measured separately from STARK — the wrap often has different characteristics)
  - Total prove time (STARK + wrap)
  - Proof size (bytes) — Groth16 wrapper is ~260 bytes
  - Deployed verifier address, tx hash, gas cost (with tier marker)
  - Trust anchor: "Hermez Perpetual Powers of Tau Phase 1 + Succinct Labs Phase 2 Groth16 wrapper ceremony (participant count TBD — document what we find via research during this task, answering spec Open Question #3)"
  - Attack surface delta: SP1 zkVM trusted computing base summary (RISC-V interpreter, Plonky3 backend, precompiles — RSA-2048, SHA-256, Keccak, etc.), zkEmail port canonicalization review findings from 1C.3, and the pre-Turbo disclosed bugs (for context, not as a disqualifier)
  - License: SP1 MIT/Apache-2.0, guest program MIT (zkEmail port)
  - Production track record: Blobstream, OP Succinct on Mantle ($2B TVL), Polygon AggLayer, SP1 Hypercube mainnet, $1B+ total TVL per Succinct
  - Audit status: KALOS (audits/kalos.md in repo), Cantina audit competition (no criticals), Veridise Picus (formal verification, ongoing), Zellic (RV32IM compliance). Three patched post-disclosure bugs (LambdaClass/3MI Labs/Aligned) in SP1 Turbo Jan 2025 — responsibly disclosed, all fixed. zkEmail-SP1-port unaudited.
  - Archival artifact list: SP1 commit/tag, guest program commit, Rust toolchain version, Cargo.lock, ptau file reference, Succinct Groth16 wrapper key artifacts
  [code] `AI`
- [ ] **1C.12** Mandatory AWS cleanup. Terminate EC2, delete EBS, verify via describe-instances filter. Log spend. Escalate if >$15. [infra] `AI`
- [ ] **1C.13** Commit `C-sp1/` subfolder to branch `zkprover-C`, including `vendor/sp1-zkEmail/` (with `.git` stripped), but EXCLUDING large build artifacts (target/, node_modules/, zkeys, proofs — use `.gitignore`). Push. Mark sub-plan `Status: Complete`. [code] `AI`

---

## Implementation Log

### Gotchas

_(empty — to be populated during implementation)_

### Deviations

_(empty — to be populated during implementation)_

### AWS Spend Tracking (Candidate C)

- Candidate C spend: $0.00 / $15 budget

---

## Log

- 2026-04-11: Sub-plan created from master zkprover-plan.md. Phase 1-C has 13 tasks. Starts after master Phase 0 completes. SP1 Turbo+ required; pre-Turbo versions are EOL'd.
