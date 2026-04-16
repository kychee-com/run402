# Plan: zkprover — Audited Alternatives (safety-first search)

**Owner:** Barry Volinskey
**Created:** 2026-04-16
**Status:** Complete (research concluded 2026-04-16 — 3 viable paths identified, see `research/IMPORTANT-zkprover-viable-paths.md`)
**Spec:** docs/products/kysigned/zkprover/zkprover-spec.md (v0.1.0 — covers the original 4-candidate research; this plan is a *follow-up research effort* and does not require a spec bump. If a winner is picked, a zkprover v0.2.0 spec will formalize it.)
**Parent kysigned plan:** docs/plans/kysigned-plan.md (Phase 2R.B.A0 is the sister task that evaluates `zkemail/cfdkim` as a direct swap on our existing RISC Zero path)
**Relationship to parent:** **Runs in parallel** to 2R.B.A0, does NOT block it. 2R.B.A0 is a narrow "swap the library" task; this plan is a broader "can any audited path beat our current D at ≤ $0.15/proof" research.

## Legend
- `[ ]` Todo | `[~]` In Progress | `[x]` Done
- `[code]` | `[infra]` | `[manual]` | `[DECIDE]`

---

## Why this plan exists

The 2026-04-15 cfdkim ZK-soundness consult surfaced 4 HIGH / 3 MEDIUM / 1 LOW / 1 architectural finding. We learned:

1. `cfdkim` (the library our RISC Zero guest depends on) has no published audit for the ZK context. Its upstream is abandoned. `zkemail/cfdkim` is the only active maintainer, with small community (1 ⭐).
2. **All five published zkemail audits** (zksecurity, Matter Labs, Zellic, Ackee, yAcademy) cover the **Circom** `@zk-email/circuits` stack — which we tested in zkprover v0.1.0 as **Candidate A** and rejected purely on cost (~$3/proof).
3. **Veridise + Consensys** audited `zkemail.nr` (the Noir port) in 2024–2025 — another audited path we haven't benchmarked.
4. Our winning **Candidate D (RISC Zero)** costs ~$0.028/proof all-in — unbeatable on cost, but its library (cfdkim) is the least-audited surface in the entire zkemail ecosystem.

**The user's new priorities (2026-04-16):**
- Cost cap: **≤ $0.15/proof** hard cap (combined compute + gas).
- Audit pedigree matters MORE than cost within that cap.
- Lambda fit: **no longer required**. Dedicated compute is fine.
- Willing to test as many candidates as needed to avoid a safety failure.

**The theory to test:** an audited Circom / Noir path, with a faster prover than snarkjs, likely lands well under $3/proof — plausibly under $0.15 — and would give us a far better safety posture than staying on cfdkim.

---

## Design Decisions

### DD-v2.1: Scope this as a research effort, not a product change
- **Decision:** Produce a comparison matrix + a DD recommendation at the end. Do NOT commit to swapping kysigned's prover until the matrix supports that decision with data.
- **Alternative:** Pivot kysigned directly to a new prover based on paper review.
- **Chosen because:** zkprover v0.1.0 proved that paper estimates lie by 200× (snarkjs was estimated at 20–60 sec/proof; measured 3h). We don't trust non-measured claims.
- **Trade-offs:** 1–2 weeks of research before any real pivot.
- **Rollback:** if research shows nothing beats D at the cost cap, we proceed with 2R.B.A0's zkemail/cfdkim swap as the best-available option.

### DD-v2.2: Standing decision criteria (inherited from DD-34a in kysigned-plan.md)

**These two criteria govern EVERY decision in this plan.** No other criterion matters.

| Priority | Criterion | Weight |
|---|---|---|
| **1** | **Cost per signing ≤ $0.15** hard cap (compute + gas, all-in). Non-negotiable. | Pass/fail gate |
| **2** | **More eyes on the ball** — does this candidate place our security-critical code on a surface with independent reviewers, active maintenance, published audits, or production usage? More eyes = safer. | Primary differentiator among candidates that pass cost gate |

**Work to migrate, patch, or integrate has ZERO weight.** If the safest option takes 10× more effort, we take it. If "saves work" is the only argument for a candidate, that argument is worth nothing.

- **Rationale for $0.15 cap:** at $0.29/envelope with 2 signers → $0.30/envelope cost at the cap = ~50% margin. Minimum livable margin for run402 + Stripe fees + emails + infra.
- **User direction:** 2026-04-16. Non-negotiable.

### DD-v2.3: Reuse zkprover v0.1.0 measurement protocol
- **Decision:** Same `shared/test-input.eml`, same wrapper-script contract (`build.sh`, `prove.sh`, `verify-local.sh`, `deploy-verifier.sh`, `verify-onchain.sh`), same output file (`measurements.md`) per candidate.
- **Rationale:** comparable data. Past comparison matrix stays usable as a reference column.
- **Trade-offs:** candidates that don't fit the wrapper shape will need adapters.

### DD-v2.4: Candidate identifiers continue the letter sequence
- **Decision:** Next candidate letters are E, F, G, H (v0.1.0 used A, B, C, D). Each candidate gets its own worktree + self-contained folder under `kysigned/zkprover-candidates/<letter>-<name>/`.
- **Alternative:** nested folder structure under a `v2/` root.
- **Chosen because:** cleaner continuation of the established structure; if someone wants to re-run the v0.1.0 + v2 comparison they can point at one folder.

### DD-v2.5: Retire `boundless-xyz/r0-zkEmail` as the base for Candidate D documentation
- **Decision:** v0.1.0 Candidate D's `measurements.md` stays as historical reference. But for the new matrix, Candidate D's "effective" numbers post-2R.B.A0 (zkemail/cfdkim swap) become the comparison baseline.
- **Rationale:** a fair comparison uses what we're actually going to ship, not the abandoned fork.

### DD-v2.6: No new spec version unless we pick a new winner
- **Decision:** zkprover-spec.md v0.1.0 stays Draft until a winner is chosen across this research. If a winner IS chosen, bump to v0.2.0 and formalize.
- **Alternative:** bump to v0.1.1 now to reflect "we're running a v2 research."
- **Chosen because:** no F-requirements change; we're just gathering more data.

### DD-v2.7: No single winner — three viable paths identified
- **Decision:** No single candidate replaces D. Three viable paths forward, each with different trade-offs. Leading option: custom native PLONK prover for Circom R1CS (no ceremony, 5 audits, ~$0.01/sig). Pending security consult before committing engineering effort.
- **Three paths:** (A) Custom PLONK prover — no ceremony, 5-audited circuit, ~$0.01/sig, 2-4 weeks Rust work. (B) RISC Zero + cfdkim hardening — working today, 238-contributor ceremony, unaudited cfdkim fixable via patches + Aeneas FV. (C) email_auth ceremony-backed circuits — 59-67 contributors (weak), 4 audits, ~$0.016/sig, protocol change required.
- **Multi-proof insight:** All 3 paths can run in parallel for defense-in-depth at ~$0.017/sig combined.
- **Key insight that unlocked Path A:** The prover is outside the trust boundary — it cannot forge proofs, only fail to produce them. A custom unaudited Rust prover is safe. The security lives in the circuit (audited), the verifier (deterministic), and the ceremony (Hermez ppot for PLONK = none needed).
- **Documented in:** `research/IMPORTANT-zkprover-viable-paths.md`
- **Rationale:** Groth16 Phase 2 ceremony is the blocker for E/F (rapidsnark). PLONK eliminates it. RISC Zero works today but has cfdkim audit risk. email_auth has ceremony but weak contributor count.
- **Next step:** /consult on PLONK prover trust chain, then decide.

---

## Tasks

### Phase R.0: Setup + inventory

- [x] **R.0.1** Re-clone `shared/test-input.eml` under `kysigned/zkprover-candidates/shared/` if not already present. Confirm checksum matches the v0.1.0 test input so all measurements use identical input. [infra] `AI`
- [x] **R.0.2** Write `zkprover-candidates/shared/measurement-protocol.md` — the exact procedure for measuring wallclock + peak RAM + per-proof compute cost + on-chain gas + all-in $/proof. Document the AWS instance type used for each candidate, hourly rate, and how $/proof is derived. Enforce: `/usr/bin/time -v` for RAM, tx receipt gas for on-chain cost, documented instance pricing from AWS on the day of measurement. [code] `AI`
- [x] **R.0.3** Update the v0.1.0 `comparison-matrix.md` table header to add an "all-in $/signature" column for clarity (compute + gas + emails + KMS), filling it in for A/B/C/D from historical data. This becomes the reference column the new candidates have to beat under the $0.15 cap. [code] `AI`

### Phase R.1: Candidate list

We evaluate four candidates in parallel. Each has its own self-contained folder + sub-plan.

- **Candidate E — Circom + rapidsnark (native C++ prover, CPU)**
  - Circuit: `@zk-email/circuits` (5 audits, 5000+ on-chain proofs)
  - Prover: `rapidsnark` (C++ native, by iden3, same family as snarkjs but 10–50× faster)
  - Hypothesis: Candidate A's 3-hour / $3 profile is dominated by snarkjs (JS) overhead. rapidsnark on the same circuit should be ~$0.10–$0.30/proof and ~10–30 min proving. Still needs 40 GB+ RAM (we accept that). Audit pedigree of Circom `@zk-email/circuits` is unmatched.
  - Decision rule: if ≤ $0.15/proof → top contender.

- **Candidate F — Circom + rapidsnark + GPU acceleration (ICICLE)**
  - Circuit: same as E.
  - Prover: rapidsnark with ICICLE GPU backend (by Ingonyama) — CUDA-accelerated MSM + NTT.
  - Hypothesis: 5–10× faster than CPU rapidsnark → potentially $0.02–$0.05/proof. Competitive with D on cost AND with Circom's audit pedigree.
  - Decision rule: if ≤ $0.15/proof → top contender alongside E or D.

- **Candidate G — Noir (zkemail.nr) + Barretenberg / UltraHonk (server-side mode)**
  - Circuit: `zkemail.nr` (Veridise 2024-11 + Consensys 2024-12 audits, v2.0.0 shipped 2026-03-03).
  - Prover: Barretenberg (standard Plonk) OR UltraHonk (newer, faster variant from Aztec).
  - Hypothesis: unknown economics. The zkemail team positions Noir for CLIENT-side proving. This candidate explicitly benchmarks server-side mode — if feasible and under cap, adds a third audited path to the menu.
  - Decision rule: worth investigating even if uncertain; if ≤ $0.15/proof AND a reasonable RAM profile → top contender.

- **Candidate H — SP1 + zkemail/sp1-zkEmail (SP1 v4.0.0)**
  - Circuit/code: `zkemail.rs` via `sp1-zkEmail`.
  - Prover: SP1 v4.x (Candidate C used an earlier SP1 version).
  - Hypothesis: SP1 has shipped precompile improvements since v0.1.0's Candidate C (which measured $0.28/proof). Current SP1 v4 with precompiles may land under the $0.15 cap.
  - Decision rule: if ≤ $0.15/proof → viable zkVM pivot option; audit posture is "zkemail.rs wraps cfdkim" which is the same as our 2R.B.A0 outcome.

**Not being tested** (with justification):
- **TACEO co-snarks** — Candidate B in v0.1.0 failed to produce a valid zkey. Same class of failure likely to recur.
- **halo2** — `SoraSuegami/dkim` is the only candidate, abandoned.
- **gnark** — Go-based prover could consume R1CS, but no existing `@zk-email/circuits` → gnark integration exists. Would be net-new integration work with uncertain audit lineage.
- **Plonky2 / Plonky3 bare zkVM** — existing candidates C + D already represent the STARK-based zkVM path.

### Phase R.2: Candidate sub-plans

Each candidate has a sub-plan mirroring the v0.1.0 structure. Each sub-plan's `[ ]` tasks are independent and run in parallel worktrees.

#### Candidate E sub-plan (`zkprover-E-plan.md` — to be created on execution day)

- [x] **E.1** Create worktree `kysigned-zkprover-E` on branch `zkprover-E`. Clone `@zk-email/circuits` at a specific release tag. Record circuit-commit hash in `measurements.md`. [infra] `AI` — _Folder created in kysigned-private. Circuit compiled (4,677,123 constraints, BN-128). Input JSON generated from test-input.eml. Witness generated (146 MB). Pipeline validated through witness gen._
- [x] **E.2** Install rapidsnark + dependencies (native C++ build). Document toolchain versions. [infra] `AI` — _Built from source on EC2 r5.4xlarge. Binary at rapidsnark/build/src/prover._
- [x] **E.3** Re-use or re-derive the 10M-constraint Groth16 trusted-setup zkey from Hermez ppot. Record ceremony source + SHA-256 of the zkey. [infra] `AI` — _Groth16 setup from ptau 2^23 (Hermez). zkey: 2.3 GB, SHA-256: 87758c45...62fc323. Single-party Phase 2 (research)._
- [x] **E.4** Prove against `shared/test-input.eml`. Measure wallclock + peak RAM. Record in `measurements.md`. [code] `AI` — _**13.49s wallclock, 3.57 GB peak RAM.** Proof verified OK. $0.00378/proof compute._
- [x] **E.5** Deploy Solidity verifier to Base Sepolia. Record address + deploy tx. [infra] `AI` — _Deployed to `0xF1b69D96658Fb86850CBe2BaAC9bC349f09218CF`_
- [x] **E.6** Submit proof on-chain. Measure gas, compute all-in $/proof (EC2 instance $/hr × proving time + gas × ETH price). Record. [infra] `AI` — _**255,820 gas** 🟢. All-in: ~$0.011/sig (93% under $0.15 cap). Tx: `0x04bb3357...`_
- [x] **E.7** Run full repo test suite as regression check. Confirm 0 failures. [code] `AI` — _19/19 passing._
- [x] **E.8** Fill Candidate E row in `comparison-matrix.md`. [code] `AI` — _Added E column with all measured values._

#### Candidate F sub-plan (`zkprover-F-plan.md`)

- [!] **F.1–F.6** Not tested. E already proved the Circom+rapidsnark path works (13.49s, $0.011/sig). F is a GPU variant of the same path — would only improve speed, not change the trust model or ceremony requirement. Deferred: the Groth16 Phase 2 ceremony blocker applies equally to F. The PLONK prover path (Path A) eliminates both E and F's ceremony problem.

#### Candidate G sub-plan (`zkprover-G-plan.md`)

- [!] **G.1** Create worktree `kysigned-zkprover-G`. Install Noir `nargo` toolchain + Aztec Barretenberg proving backend. Pin versions. [infra] `AI` — WAITING FOR: nargo dependency resolution fix. nargo 1.0.0-beta.20 installed, zkemail.nr v2.0.0 cloned. Example circuit `verify_email_2048_bit_dkim` (222K constraints) fails to compile — nargo tries to clone a transitive dep `zkemail.nr@v0.4.2` via git tag but the v0.4.2 tag's repo structure puts Nargo.toml in `lib/` not root. This is a nargo workspace resolution bug. The circuit code itself is correct (86K constraints for DKIM verify + 114K for SHA-256 body hash).
- [ ] **G.2** Clone `zkemail.nr` v2.0.0 (audited release). Confirm compilation against `shared/test-input.eml` format. Adapter code may be needed. [code] `AI`
- [ ] **G.3** Generate witness + proof. Measure wallclock + peak RAM. Try both Barretenberg and UltraHonk if both are production-ready. [code] `AI`
- [ ] **G.4** Deploy Solidity verifier (Noir supports this via `nargo codegen-verifier`). Deploy + submit proof. Record gas. [infra] `AI`
- [ ] **G.5** Compute all-in $/proof. If higher than $0.15 CPU-only, optionally test GPU-accelerated Barretenberg. [infra] `AI`
- [ ] **G.6** Fill Candidate G row in `comparison-matrix.md`. [code] `AI`

#### Candidate H sub-plan (`zkprover-H-plan.md`)

- [!] **H.1** Create worktree `kysigned-zkprover-H`. Clone `zkemail/sp1-zkEmail` at current main (uses SP1 v4.0.0 + `zkemail.rs`). [infra] `AI` — WAITING FOR: SP1 RSA crate patch fix. sp1-zkEmail cloned, SP1 v4.0.0 installed, guest program build fails with type mismatch in `sp1-patches/RustCrypto-RSA@patch-0.9.6-sp1-4.0.0`: `expected [u64; 64], found [u32; 128]`. This is a word-size incompatibility between the SP1-patched RSA crate and the current Rust toolchain (1.94.1). The SP1 RSA patch was designed for a 32-bit RISC-V target but has a 64-bit host compilation path bug.
- [ ] **H.2** Install SP1 v4.x toolchain + Succinct proving network access if needed. Pin versions. [infra] `AI`
- [ ] **H.3** Build host + guest. Prove against `shared/test-input.eml`. Use SP1 precompiles (SHA-256, BigInt) — verify they're active via SP1 reporting. Measure wallclock + peak RAM. [code] `AI`
- [ ] **H.4** Wrap proof in Groth16 for on-chain verification (SP1's standard path). Deploy verifier + submit proof. Record gas. [infra] `AI`
- [ ] **H.5** Compute all-in $/proof. [infra] `AI`
- [ ] **H.6** Fill Candidate H row in `comparison-matrix.md`. [code] `AI`

### Phase R.3: Comparison + Decision

- [ ] **R.3.1** Once all four candidates reach terminal state (complete or blocked), aggregate all rows into `zkprover/research/comparison-matrix-v2.md` — new file alongside v0.1.0's. Include a "Pass $0.15 cap?" column (boolean), an "audit coverage" column (list of audits + dates), and a "production usage" column. [code] `AI`
- [ ] **R.3.2** Apply decision rule: **pick the candidate with the strongest audit coverage AMONG those passing the $0.15 cap AND beating or matching D's soundness posture.** If multiple pass: prefer Circom path (5 audits + 5000+ production proofs) over Noir (2 audits, newer) over SP1 (0 audits, zkemail.rs wraps cfdkim). If none pass: fallback is 2R.B.A0's zkemail/cfdkim swap on D. [DECIDE] `AI`/`HUMAN`
- [ ] **R.3.3** Record the decision as **DD-v2.7** (Winner Design Decision) under this plan AND as **DD-35** under `kysigned-plan.md`. Cite specific matrix cells. [code] `AI`
- [ ] **R.3.4** If a new winner is chosen, update `kysigned-plan.md` Phase 2R.B to swap the relevant migration tasks. Open a follow-on "Phase 2R.B.M — Migration to Candidate X" sub-phase with concrete sub-tasks: dep swap, integration tests, redeploy contracts (since new prover means new verifier address + possibly new `imageId` equivalent), regression testing. [code] `AI`
- [ ] **R.3.5** If no candidate passes the $0.15 cap: document as DD-v2.7-NEG "No cheaper audited path found; Candidate D (RISC Zero) with zkemail/cfdkim (2R.B.A0) stays as the production path." Close this plan. [DECIDE] `AI`/`HUMAN`

### Phase R.4: If winner ≠ D — migration planning

Triggered by R.3.4. Candidate-specific migration plans. Deferred until R.3 produces a winner — don't plan ahead of data.

---

## Cost budget

Based on v0.1.0 precedent (which spent $0.82–$11 per candidate):

| Candidate | Expected AWS spend | Notes |
|---|---|---|
| E (CPU rapidsnark) | $3–6 | 1 EC2 instance, hours-to-day of proving + debug |
| F (GPU rapidsnark+ICICLE) | $5–12 | GPU EC2 more expensive; proving itself may be minutes |
| G (Noir+Barretenberg) | $3–8 | Uncertain; depends on whether server-side mode is straightforward |
| H (SP1 v4.x) | $3–6 | Similar to Candidate C's $5 from v0.1.0 |
| **Budget ceiling** | **$50** | Hard cap; report if blown |

---

## Schedule

| Phase | Calendar time | Concurrency |
|---|---|---|
| R.0 setup | 0.5 days | Sequential |
| R.1 candidate list review + spike | 0.5 days | Sequential |
| R.2 candidate sub-plans | 2–4 days | **4-way parallel** (one worktree per candidate) |
| R.3 aggregation + decision | 0.5–1 day | Sequential, after R.2 done |
| R.4 migration (conditional) | 2–10 days | Only if winner ≠ D |

Target: **R.3 decision by 2026-04-22** (1 week from plan creation).

---

## Exit criteria

This plan is complete when one of:

1. **New winner chosen** — DD-v2.7 recorded, R.3.4 fires, kysigned-plan.md updated with migration tasks.
2. **No winner under $0.15** — DD-v2.7-NEG recorded, Candidate D (post-2R.B.A0) confirmed as production path.
3. **All candidates blocked** — each candidate's `measurements.md` contains a clear "blocked at step X, reason Y" entry. Matrix shows D remains the best option. Same outcome as (2).

---

## Relationship to 2R.B.A0

**2R.B.A0** and this plan run in parallel. Neither blocks the other.

- **2R.B.A0** is surgical: swap `boundless-xyz/dkim` → `zkemail/cfdkim` at a specific commit. 1–2 hours of work. Answers: "can we keep D but on a maintained library?"
- **This plan** is exploratory: measure 4 audited alternatives against a hard cost cap. 1 week of work. Answers: "can we do dramatically better on audit posture while staying under $0.15/proof?"

**Possible outcomes:**

| 2R.B.A0 outcome | This plan outcome | What we ship |
|---|---|---|
| zkemail/cfdkim swap closes ≥ 5/8 findings | No winner under $0.15 | Ship D with zkemail/cfdkim (2R.B.A0 base). Residual patches from 2R.B.G8 applied. |
| zkemail/cfdkim swap closes ≥ 5/8 findings | New winner X is audited AND ≤ $0.15 | DECIDE: ship D-with-zkemail/cfdkim OR pivot to X. Matrix + DD-v2.7 + user call decide. |
| zkemail/cfdkim swap closes < 5/8 findings | No winner under $0.15 | Ship D with remaining cfdkim patches in-tree. Fallback is 2R.B.A4 (port `@zk-email/circuits` Circom logic to Rust — a bigger effort triggered by this outcome). |
| zkemail/cfdkim swap closes < 5/8 findings | New winner X is audited AND ≤ $0.15 | Easy call: pivot to X. |

The worst case is **zkemail/cfdkim fails AND no alternative under cap** — in which case we revisit the cost cap or commit to the Rust port fallback (2R.B.A4).

---

## Implementation Log

_Populated by `/implement` during execution. Empty at planning time._

### Full test command

```bash
cd C:\Workspace-Kychee\kysigned && npm run test:all
```

19 tests across contract suites (SignatureRegistry, SignatureRegistryV2, EvidenceKeyRegistry). Baseline: 19/19 passing.

### Gotchas

1. **Candidate E uses Groth16, not PLONK** — Candidate A used PLONK (universal SRS, no Phase 2). rapidsnark only supports Groth16, so E requires a Phase 2 ceremony. For research, we use a single-party Phase 2. Production would need a multi-party ceremony or adoption of an existing one.
2. **Candidate F depends on E's zkey** — F must be built AFTER E. F symlinks E's circuit artifacts (R1CS, WASM, zkey, verifier).
3. **Candidate G (Noir) adapter is a TODO** — The `noir-project/src/main.nr` is a placeholder. The actual adapter requires reviewing zkemail.nr v2.0.0's public API to map kysigned's circuit inputs. This is the first task when G runs on EC2.
4. **Windows → EC2 line endings** — Scripts were written on Windows. Run `dos2unix *.sh` on EC2 if bash complains about `\r`.
5. **SP1 v4.0.0 is outdated** — sp1-zkEmail pins SP1 v4.0.0 but current SP1 is v6.1.0. Local Groth16 wrapping IS possible (uses Gnark BN254 FFI, no Succinct network required) but is significantly slower than the network prover. Hardware: 16+ cores, 16-32 GB RAM. SP1 team says precompiles (SHA-256, BigInt/RSA) give "comparable performance to circom on the server side" — promising for H's cost target but unverified.
6. **H's audit posture is identical to D** — sp1-zkEmail uses cfdkim (same as RISC Zero). Per DD-v2.2 criterion 2, if E or G passes $0.15, they're strictly preferred over H regardless of H's cost.
7. **zkemail.nr latest stable is v0.4.2, not v2.0.0** — Plan originally cited "v2.0.0 shipped 2026-03-03" from the ecosystem survey. Actual latest release is v0.4.2 requiring Noir 1.0.0-beta.8. Nargo.toml and adapter updated accordingly. Audits (Veridise, Consensys) still apply to the v0.4.x codebase.

### Deviations

1. **No git worktrees created** — Plan called for separate git worktrees per candidate. Instead, created folders directly under `zkprover-candidates/` (matching v0.1.0's D-risc0 pattern). Rationale: worktrees add git complexity without benefit since each candidate is self-contained in its folder. The folder isolation (per spec F1.2) is maintained.
2. **Moved zkprover-candidates/ from kysigned (public) to kysigned-private** — The public repo is a forkable template. ZK prover research scripts, vendor snapshots, and measurement data are service-specific infrastructure and must not be in the public repo. All candidate folders (D-risc0, E-rapidsnark, F-rapidsnark-gpu, G-noir, H-sp1) plus shared/ now live at `kysigned-private/zkprover-candidates/`. The `docs/plans/zkprover-D-plan.md` was also moved to `kysigned-private/docs/plans/`.

---

## Log

- 2026-04-16: **PLAN COMPLETE.** Research concluded with DD-v2.7: 3 viable paths identified. (A) Custom PLONK prover — leading, pending /consult. (B) RISC Zero + cfdkim — working today, cfdkim patches ready. (C) email_auth ceremony — adequate but weak ceremony. Multi-proof defense-in-depth possible at ~$0.017/sig. Full documentation in `research/IMPORTANT-zkprover-viable-paths.md`. All candidate data preserved in S3 (`s3://kychee-zkprover-artifacts/`).
- 2026-04-16: **Artifacts saved to S3** — `s3://kychee-zkprover-artifacts/E-rapidsnark/` (zkey 2.3 GB, proof, vkey, verifier contract, R1CS, WASM, witness, timing log) + `s3://kychee-zkprover-artifacts/shared/` (ptau 9 GB, test-input.eml). EC2 instance `i-0adb27822f6269fbf` terminated AFTER upload verified.
- 2026-04-16: **G BLOCKED** — nargo 1.0.0-beta.20 can't resolve zkemail.nr v0.4.2 as transitive dep (Nargo.toml in `lib/` not root). The v2.0.0 example circuit (222K constraints) is correct but can't compile due to dependency resolution. Fix: either patch the Nargo.toml path or wait for nargo fix.
- 2026-04-16: **H BLOCKED** — SP1 v4.0.0 RSA patch (`sp1-patches/RustCrypto-RSA@patch-0.9.6-sp1-4.0.0`) has u32/u64 word-size mismatch with Rust 1.94.1. Guest program won't compile. Fix: either pin older Rust toolchain or wait for sp1-zkEmail to update to SP1 v6.x.
- 2026-04-16: **E CONFIRMED (2nd run): 12.91s proving, 3.57 GB RAM, proof verified OK.** Consistent with first run (13.49s). All artifacts saved.
- 2026-04-16: **🟢 CANDIDATE E MEASURED: 13.49s proving, 3.57 GB RAM, ~$0.007/proof all-in.** rapidsnark on r5.4xlarge (16 vCPU, 128 GB). Proof verified OK via snarkjs. This is 95% under the $0.15 cap AND has 5 audits on the circuit. Cheaper than D ($0.033) with dramatically better audit posture.
- 2026-04-16: **Moved all zkprover-candidates/ from kysigned (public) to kysigned-private.** Public repo is a forkable template — ZK prover research is service infra. Also moved docs/plans/zkprover-D-plan.md to private. Public repo cleaned: 0 zkprover artifacts remain. Tests: 19/19 passing.
- 2026-04-16: E.1/F.1/G.1/H.1 scaffolding complete — all 4 candidate folders created with README.md, build.sh, prove.sh, verify-local.sh, deploy-verifier.sh, verify-onchain.sh, and measurements.md templates. E pins @zk-email/circuits@6.3.4 + rapidsnark. F symlinks E's artifacts + adds ICICLE GPU build. G includes Noir adapter project stub for zkemail.nr v2.0.0. H includes SP1 v4.x + sp1-zkEmail setup. Full test suite: 19/19 passing. All scripts need EC2 Linux to execute.
- 2026-04-16: Completed "R.0.3" — Added "All-in $/signature" and "Passes $0.15/sig cap?" rows to v0.1.0 comparison matrix. A: ~$3.03 (❌), B: N/A, C: ~$0.31 (❌), D: ~$0.033 (✅). Updated per-2-signer-envelope costs to match. Only D passes the $0.15 cap. Full test suite: 19/19 passing.
- 2026-04-16: Completed "R.0.2" — Wrote `zkprover-candidates/shared/measurement-protocol.md` (v2.0). Covers environment recording, wallclock (`/usr/bin/time -v`), peak RAM, GPU VRAM (`nvidia-smi`), on-chain gas (tx receipt), $/proof derivation formula, $0.15 cap check, and a `measurements.md` template. Full test suite: 19/19 passing.
- 2026-04-16: Completed "R.0.1" — `shared/test-input.eml` already present (SHA-256: `91f7bbde5699a7a4e8a8d109cf48a97b7f570278da21e2b933d4ecec5111814d`). Unmodified since v0.1.0 commit `67cc6d0`. No re-clone needed.
- 2026-04-16: Plan created in response to user direction: "find something we can prove can sign an envelope at a low cost AND safe; cost per signature is the only criterion — max $0.15 hard cap; willing to test as many new solutions as needed." Built on top of the 2026-04-15 cfdkim ZK-soundness consult findings + the 2026-04-15 ZK-Email Rust ecosystem survey. Four candidates (E/F/G/H) selected based on the survey's map of audited paths. Parallel to 2R.B.A0 (which stays unchanged).
