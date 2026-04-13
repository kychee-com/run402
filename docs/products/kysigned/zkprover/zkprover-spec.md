---
product: zkprover
version: 0.1.0
status: Draft
type: product
interfaces: [cli]
created: 2026-04-11
updated: 2026-04-11
---

## Overview

`zkprover` is a run402 platform-service mini-product whose first consumer is kysigned. This spec (v0.1.0) covers **only the research/comparison phase**: four independent zero-knowledge prover implementations built in parallel, each producing a valid proof for a shared DKIM reply-to-sign test input, measured end-to-end, aggregated into a comparison matrix, and concluding with a winner Design Decision. The eventual run402 platform-service interface (API + CLI + MCP tool) is deferred to v0.2.0 once measurement data from v0.1.0 exists to ground the platform design.

## Interfaces & Mediums

**Developer-facing internal tooling, CLI only.** v0.1.0 has no end-user interface. Users of zkprover during this spec version are Kychee developers who interact with each candidate via command-line build scripts from the candidate's subfolder inside the public kysigned repo. Each candidate is accessed as: `cd kysigned/zkprover-candidates/<letter>-<name>/ && ./build.sh && ./prove.sh <input>.eml && ./verify-onchain.sh`. No hosted service, no API, no MCP tool in this version.

## Shipping Surfaces

**Internal only — no external surface.** Rationale: v0.1.0 is a research and comparison deliverable whose output is a set of working candidate builds + a decision document, not a user-facing product. The winning candidate becomes a shipping surface in v0.2.0 (as a run402 platform service), which is out of scope for this spec.

The artifacts produced during v0.1.0 live in two locations, both internal:

| Artifact | Location | Consumer |
|---|---|---|
| Four candidate build folders | `kysigned/zkprover-candidates/{A,B,C,D}/` (public kysigned repo, but no published release yet) | Kychee developers running the builds locally/on EC2 |
| Shared test input | `kysigned/zkprover-candidates/shared/test-input.eml` | All four candidates |
| Comparison matrix | `run402/docs/products/zkprover/research/comparison-matrix.md` | User (for decision) |
| Winner Design Decision | `run402/docs/plans/zkprover-plan.md` (DD in the plan) | kysigned's paused 1R.3 task (resumption pointer) |

## Features & Requirements

### F1 — Four candidate builds, self-contained

**F1.1** Four independent prover candidates exist, each in its own subfolder under `kysigned/zkprover-candidates/`, named and scoped as follows:
- `A-snarkjs-retry/` — snarkjs PLONK with corrected V8 flags (`--max-semi-space-size`, `--max-old-space-size`, `sysctl vm.max_map_count`), circuit byte-identical to the existing `kysigned-approval.circom`.
- `B-taceo/` — TACEO co-snarks Rust-native PLONK prover, circuit byte-identical to the existing `kysigned-approval.circom`, producing a snarkjs-compatible proof for the same Solidity verifier.
- `C-sp1/` — SP1 zkVM with a fork of `zkemail/sp1-zkEmail` as the guest program, Groth16 EVM wrapper.
- `D-risc0/` — RISC Zero zkVM with a fork of `boundless-xyz/r0-zkEmail` as the guest program, Groth16 EVM wrapper.

**F1.2** Each candidate's subfolder is fully self-contained. No file, dependency, or build artifact outside the candidate's own subfolder is created, modified, or depended upon. Specifically: no shared root-level `Cargo.toml`, no shared `package.json`, no cross-candidate symlinks, no shared build outputs. The `shared/` sibling folder (for the test input only) is read-only.

**F1.3** Each candidate's subfolder contains at minimum: a `README.md` describing what the candidate is and how to build/run it, a build script (name TBD by plan), a prove script that consumes `shared/test-input.eml`, a verify script that checks the proof locally, an on-chain deploy-and-verify script that deploys the Solidity verifier to Base Sepolia and submits the proof, and a `measurements.md` file capturing the V2 measurement outputs (see F3).

### F2 — Shared test input

**F2.1** A single DKIM reply-to-sign `.eml` file exists at `kysigned/zkprover-candidates/shared/test-input.eml`, representing one realistic "signer replied `I APPROVE`" email. All four candidates consume this identical file as their proving input so that the comparison is apples-to-apples.

**F2.2** The test input is a real DKIM-signed email from a major mail provider (e.g., Gmail, Outlook, Apple iCloud, ProtonMail — the exact provider chosen by the plan), not a synthetic or hand-crafted MIME. The raw `.eml` file is committed to the repo alongside the candidate folders so that re-running the builds years later produces identical results.

**F2.3** The test input includes: a valid DKIM signature over headers including `From`, `Subject`, and a canonicalized body containing the literal string `I APPROVE` on a standalone line. The chosen Subject header contains a representative envelopeId + docHash pattern matching kysigned's production format.

### F3 — Per-candidate V2 verification

**F3.1** Each candidate successfully parses the shared test input, prepares its circuit-specific inputs (or guest-program inputs for the zkVM candidates), and invokes its prover to produce a proof artifact (PLONK proof bytes for A/B, Groth16 wrapper bytes for C/D). Success here means "the prover process exits cleanly with a proof file on disk."

**F3.2** Each candidate's Solidity verifier contract is deployed to Base Sepolia from the candidate's own deploy script. The deployed contract address is recorded in the candidate's `measurements.md`.

**F3.3** Each candidate submits its proof (plus public inputs) to its deployed Solidity verifier's `verifyProof` function on Base Sepolia, and the call returns `true`. The successful transaction hash is recorded in the candidate's `measurements.md`.

**F3.4** The gas cost of the on-chain `verifyProof` call is measured from the transaction receipt and recorded in `measurements.md`. This is the **real measured gas cost**, not an estimate.

**F3.5** The prover wallclock time (from invocation to proof file on disk) and peak RAM (via `/usr/bin/time -v` or equivalent OS-native measurement) are captured and recorded in `measurements.md`.

**F3.6** If a candidate cannot complete F3.1–F3.4 after reasonable debugging effort, it is marked **blocked** rather than silently failed. A blocked entry in the candidate's `measurements.md` contains: (a) which step failed, (b) the specific error output, (c) what was tried to resolve it, (d) the blocker hypothesis, (e) any upstream issue/PR references. A blocked candidate still contributes data to the comparison matrix — the matrix entry is "blocked at step X, reason Y."

### F4 — Comparison matrix

**F4.1** A comparison matrix document exists at `run402/docs/products/zkprover/research/comparison-matrix.md`. The matrix aggregates the measurement data from all four candidates into a single authoritative table for the winner decision.

**F4.2** The matrix contains one row per candidate with at minimum the following columns:
- **Status** — `✅ complete` / `⚠️ blocked` / `🚧 partial`
- **On-chain gas** — numeric gas count + tier marker: 🟢 (<1M), 🟡 (1M-2M), 🔴 (>2M). Missing if blocked.
- **Prover wallclock** — seconds for the one proof generation
- **Peak RAM** — GB during prover execution
- **Proof bytes** — size of the proof file emitted by the prover
- **Trust anchor** — short description of the ceremony backing the candidate's proof system (e.g., "Hermez ppot", "Succinct Groth16 wrapper over Hermez ppot Phase 1 + Succinct multi-party Phase 2", "RISC Zero p0tion 238-contributor Groth16 wrapper")
- **Attack surface delta** — qualitative summary of new code-trust beyond the current snarkjs baseline
- **License** — SPDX of the prover's license
- **Production track record** — one-line summary (e.g., "Blobstream, OP Succinct Mantle $2B TVL", "Citrea, Boundless mainnet on Base")
- **Audit status** — current audits as of the measurement date, cited
- **Archival artifact list** — what needs to be vendored for multi-year reproducibility

**F4.3** Every matrix cell cites the source document (usually a link to the candidate's `measurements.md` or `README.md`). No cell is filled in from memory or speculation — if the measurement isn't captured in a committed file, the cell shows `⚠️ not measured`.

**F4.4** The matrix document contains an "interpretation" section at the bottom, written by the implementer, summarizing which candidate(s) appear strongest on which axis and flagging any surprising findings from the measurements (e.g., "Candidate D gas cost came in at 340k, 20% below the prior estimate of 280k").

### F5 — Winner decision

**F5.1** A Design Decision (DD) is added to the zkprover plan document (`run402/docs/plans/zkprover-plan.md`) naming the winning candidate (or, if two candidates are chosen as primary + fallback, naming both). The DD is numbered consecutively with the plan's other DDs.

**F5.2** The DD cites specific rows and cells of the comparison matrix as justification. Vague rationale is not acceptable ("D feels right"); the DD must explicitly tie the choice to measured data (e.g., "D chosen as primary over C because D's verifier gas at 340k is 7% lower, D's Veridise Picus formal-verification work covers 45k+ constraints of the zkVM, and D's Boundless deployment on Base since Sept 2025 provides the longest production track record on the exact chain kysigned targets").

**F5.3** The DD explicitly states whether the chosen winner is the sole production candidate or whether a fallback/secondary is also adopted for defense-in-depth. If secondary, the conditions under which the secondary takes over must be documented.

**F5.4** The DD notes any deferred audit or review tasks required before the winner can be adopted in kysigned production — e.g., "zkEmail-SP1-port DKIM canonicalization code review required before kysigned integration, tracked as a post-winner task."

## Acceptance Criteria

### F1 — Four candidate builds, self-contained

- [ ] `kysigned/zkprover-candidates/A-snarkjs-retry/` exists with a README, build script, prove script, verify script, on-chain deploy-and-verify script, and `measurements.md`.
- [ ] `kysigned/zkprover-candidates/B-taceo/` exists with the same file set.
- [ ] `kysigned/zkprover-candidates/C-sp1/` exists with the same file set.
- [ ] `kysigned/zkprover-candidates/D-risc0/` exists with the same file set.
- [ ] No file outside `kysigned/zkprover-candidates/<letter>/` is modified or created by any candidate's build process (verified via `git status` after a clean build of each candidate in an isolated worktree).
- [ ] No Cargo workspace, npm workspace, or any other root-level dependency-management file links across candidates.
- [ ] Each candidate's `README.md` explains (a) which proof system it uses, (b) how to build it, (c) how to run the test proof end-to-end, (d) which external resources it depends on (crates, npm packages, ptau files, docker images), (e) its current measured results.

### F2 — Shared test input

- [ ] `kysigned/zkprover-candidates/shared/test-input.eml` exists.
- [ ] The file parses as a valid MIME email with a verifiable DKIM signature, confirmed by running any external DKIM verifier tool (e.g., `opendkim-testmsg`) against it.
- [ ] The body contains the literal string `I APPROVE` on a line above any quoted content.
- [ ] The Subject header contains a representative envelopeId and docHash pattern.
- [ ] The mail provider whose DKIM key signed the email is documented in `kysigned/zkprover-candidates/shared/README.md`.

### F3 — Per-candidate V2 verification

For **each** candidate (A, B, C, D):

- [ ] Prover binary builds cleanly from the candidate's build script (exit code 0).
- [ ] Prover binary runs against `shared/test-input.eml` and produces a proof file (exit code 0).
- [ ] Prover output is verified locally (prover's own verifier returns "valid").
- [ ] Solidity verifier contract for this candidate is deployed to Base Sepolia; contract address is recorded in the candidate's `measurements.md`.
- [ ] Submitting the proof to the deployed verifier via `verifyProof` returns `true`; transaction hash is recorded in `measurements.md`.
- [ ] On-chain gas cost of the `verifyProof` call is captured from the tx receipt and recorded in `measurements.md`.
- [ ] Prover wallclock time (invoke → proof file on disk) is measured and recorded.
- [ ] Prover peak RAM is measured (`time -v` or equivalent) and recorded.
- [ ] Proof file size in bytes is recorded.
- [ ] If any of the above fails after debugging, the candidate is marked `[!] blocked` in its `measurements.md` with full failure context (step, error, attempts, hypothesis, upstream references).

### F4 — Comparison matrix

- [ ] `run402/docs/products/zkprover/research/comparison-matrix.md` exists.
- [ ] The matrix has exactly four rows, one per candidate (A, B, C, D).
- [ ] The matrix has at minimum the columns listed in F4.2: status, gas + tier, wallclock, RAM, proof bytes, trust anchor, attack surface delta, license, production track record, audit status, archival artifacts.
- [ ] Every measurement cell either (a) contains a value, or (b) contains `⚠️ not measured` for blocked candidates at the blocked step, or (c) contains `⚠️ blocked` for entire candidates whose V2 run failed.
- [ ] Every non-blocked cell cites a source file (link to `measurements.md` or `README.md`).
- [ ] The interpretation section at the bottom of the matrix summarizes strongest candidate per axis and flags surprising findings in plain English.

### F5 — Winner decision

- [ ] A Design Decision is added to `run402/docs/plans/zkprover-plan.md` naming the winner (or winner + fallback).
- [ ] The DD cites specific matrix cells (row, column) as justification — rationale maps explicitly to measurements, not hand-waving.
- [ ] The DD states whether the winner is primary-only or primary + fallback; if fallback, conditions for failover are documented.
- [ ] The DD lists deferred tasks that must complete before kysigned adopts the winner (e.g., DKIM canonicalization review for SP1/RISC Zero, archival build capture, etc.).
- [ ] The DD is reviewed and approved by the user (spec-level approval; no implicit "I wrote the DD, it's done" — the user explicitly confirms).

## Constraints & Dependencies

### Hard gates (non-negotiable)

1. **Trust anchor floor:** Every candidate's proving system must rely on at most "Hermez Perpetual Powers of Tau (ppot) — 100+ public contributors including EF, Vitalik, Zcash team, major L2 teams" as its trust root, OR a ceremony of demonstrably equivalent or greater attestation quality. Candidates with smaller ceremonies (e.g., Brevis Pico's self-run wrapper ceremony) or unattested setups are rejected regardless of other merits.
2. **Security non-regression:** Every candidate must not introduce new cryptographic attack vectors beyond those already present in (a) the current snarkjs baseline, or (b) audited, production-deployed zkVM implementations with public disclosure history (SP1, RISC Zero). "New attack vector" does not include "more code in the trusted computing base" — that's a known tradeoff. It does include "new unaudited cryptographic math layer" or "a new ceremony we'd have to trust."
3. **No external proving services:** The prover binary for every candidate must run on our own infrastructure (local dev, EC2, or eventually run402 platform). No dependency on Sindri, Succinct Prover Network (hosted), =nil; foundation, Brevis cloud, or any other third-party proving service for the critical path. Open-source tools that HAPPEN to also offer a hosted version (e.g., SP1's Succinct Prover Network is optional) are fine — we just don't use the hosted path.
4. **Fully open source:** Every component of every candidate's prover stack (prover binary, zkVM runtime, guest program libraries, STARK backend, Groth16 wrapper, Solidity verifier generator) is released under an OSI-approved license. Proprietary or source-available-but-not-OSS components are rejected.
5. **Reproducible from vendored dependencies:** Each candidate's build must be reproducible years later from a vendored dependency set (`cargo vendor` for Rust, `npm ci` against committed `package-lock.json` for Node, pinned Docker image digests, pinned system-package versions). Candidates relying on unreproducible nightly toolchains or unpinned dependencies are rejected.
6. **Self-containment:** Each candidate's subfolder is independently buildable and independently deletable. Touching files outside the candidate's own subfolder is forbidden by F1.2. This is a hard gate because it enables `rm -rf` cleanup of losing candidates without side effects.

### Soft constraints (measured, not gated)

- **Gas cost tiers:** 🟢 (<1M gas on-chain verify), 🟡 (1M-2M, flagged for user review), 🔴 (>2M, exceeds target budget). A candidate landing in 🟡 or 🔴 is not auto-rejected but is flagged for explicit user decision at winner-pick time.
- **Prover wallclock time:** Recorded, not gated. Per user directive: "proving time as defined above is irrelevant (as no one needs to wait for it)."
- **Peak RAM:** Recorded, not gated. The measured value feeds into the future run402 platform-extension decision (deferred to v0.2.0).
- **One-time setup cost:** Recorded, not gated. Per user directive: don't care about setup time.

### External dependencies

- **Hermez Perpetual Powers of Tau `.ptau` file** — canonical reference, download from the official Hermez archive or zkemail's Phase 1 mirror. Consumed by candidates A, B, and (indirectly, via Phase 1 of the SP1/RISC Zero Groth16 wrappers) C and D.
- **Base Sepolia RPC endpoint** — for deploying each candidate's Solidity verifier and running V2 verification. Any standard RPC (Alchemy, Infura, Base's own public endpoint) suffices.
- **Base Sepolia test ETH** — funded from our existing Base Sepolia wallet. Minimal amount needed per candidate.
- **AWS EC2** — for the build and proving compute. Instance types and spend cap determined by the plan, not the spec.
- **GitHub source repos** — [iden3/snarkjs](https://github.com/iden3/snarkjs), [TaceoLabs/co-snarks](https://github.com/TaceoLabs/co-snarks), [succinctlabs/sp1](https://github.com/succinctlabs/sp1), [zkemail/sp1-zkEmail](https://github.com/zkemail/sp1-zkEmail), [risc0/risc0](https://github.com/risc0/risc0), [boundless-xyz/r0-zkEmail](https://github.com/risc0-labs/r0-zkEmail), the existing [kysigned-approval.circom](../../kysigned/circuits/kysigned-approval.circom) circuit source.

## Open Questions

These are unresolved decisions that will be answered during implementation or in a follow-up spec version. Each is annotated with where the answer comes from.

1. **Will candidate A (snarkjs PLONK retry) actually work with the missing V8 flags?** Answered during A's implementation. Expected: free 1-day test.
2. **Which specific mail provider's DKIM signature is used for the shared test input?** Answered during F2 implementation. Options: Gmail, Outlook/O365, Apple iCloud, ProtonMail. Plan decides based on what's easy to generate and what's most representative.
3. **Exact Succinct SP1 Groth16 wrapper Phase 2 ceremony participant count and attestation quality.** Answered during C's implementation or as a prerequisite to C's DD entry. If the Phase 2 ceremony turns out to be small or poorly attested, C's trust anchor is weaker than the other candidates and this must be reflected in the matrix.
4. **Exact libraries (RSA, SHA-256, DKIM canonicalization) used by `zkemail/sp1-zkEmail` and `boundless-xyz/r0-zkEmail` guest programs.** Answered during C and D implementation. These libraries become part of the trusted computing base for C and D; surfacing them is required for the "Attack surface delta" column of the matrix.
5. **run402 platform-extension scope required to host the winner** — deferred per user decision: "we build, see what is needed from run402, then decide." Answered in v0.2.0 of zkprover after v0.1.0's winner is locked.
6. **Whether to keep all four candidates in the repo after the winner is chosen, or delete losers** — deferred to post-winner discussion. Leaning "keep all as documentation," but not a v0.1.0 acceptance criterion.
7. **Whether the winner's zkEmail-port DKIM canonicalization code needs a full external audit or an internal review is sufficient** — deferred to post-winner discussion. v0.1.0 requires only that the deferred review task be NAMED in the winner DD (per F5.4), not completed.
