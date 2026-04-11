# Plan: zkprover-A (Candidate A — snarkjs PLONK retry)

**Owner:** Barry Volinskey
**Created:** 2026-04-11
**Status:** Planning
**Spec:** docs/products/zkprover/zkprover-spec.md
**Spec-Version:** 0.1.0
**Source:** spec
**Worktree:** `C:\Workspace-Kychee\kysigned-zkprover-A\` (branch `zkprover-A`)
**Master plan:** [zkprover-plan.md](zkprover-plan.md)

## Legend
- `[ ]` Todo | `[~]` In Progress | `[x]` Done
- Task type annotations: `[code]`, `[infra]`, `[manual]` — drive which verification methodology `/implement` applies.

## Scope

This sub-plan covers **only Candidate A — snarkjs PLONK retry with corrected V8 flags**. The circuit stays byte-identical to `kysigned/circuits/kysigned-approval.circom`. The hypothesis is that the previous snarkjs PLONK setup failure was caused by missing `--max-semi-space-size` and `vm.max_map_count` system tuning, not a fundamental V8 limit. If the retry succeeds, Candidate A is the cheapest and lowest-risk path (zero new attack surface, byte-identical to the current baseline).

**Sub-plan is independent.** It runs in a dedicated worktree via its own `/implement zkprover-A` session. Shared Phase 0 prerequisites (worktree creation, shared test input, Base Sepolia wallet, AWS env) must be complete before this sub-plan starts — the master `zkprover-plan.md` enforces this.

**Design Decisions apply from the master plan.** DDs 1-11 in `zkprover-plan.md` govern this sub-plan. In particular:
- DD-2: uniform thin-wrapper scripts
- DD-3: $15 per-candidate spend cap, escalate at breach
- DD-4: blocked threshold (two hypotheses, 4 hours minimum)
- DD-6: worktree is `C:\Workspace-Kychee\kysigned-zkprover-A\`, branch `zkprover-A`

Do NOT duplicate or re-decide DDs here.

---

## Tasks

### Phase 1-A: Candidate A build, measure, verify

Expected: snarkjs is cheap to test. If Phase 1A completes cleanly, Candidate A produces a valid PLONK proof over the existing circuit against the shared test input, deploys its Solidity verifier on Base Sepolia, and passes `verifyProof` on-chain. The measurements land in `zkprover-candidates/A-snarkjs-retry/measurements.md`.

- [ ] **1A.1** Scaffold `kysigned/zkprover-candidates/A-snarkjs-retry/` with `README.md`, `build.sh`, `prove.sh`, `verify-local.sh`, `deploy-verifier.sh`, `verify-onchain.sh`, `measurements.md` template, and a `contracts/` subfolder for the generated Solidity verifier. README describes the retry hypothesis (missing V8 flags), the specific flags being set, and links to iden3/snarkjs#397 and the 2025 snarkjs_bench findings. [code] `AI`
- [ ] **1A.2** Write `build.sh`: nested `package.json` at `A-snarkjs-retry/package.json` (NOT the kysigned root package.json), installs specific versions of `snarkjs`, `ffjavascript`, `circom_runtime`, `@zk-email/circuits`, `@zk-email/zk-regex-circom`, `circomlib` via `npm install --prefix A-snarkjs-retry`. Copies `kysigned/circuits/kysigned-approval.circom` into the candidate folder for byte-exact reproducibility. Downloads `powersOfTau28_hez_final_23.ptau` from the canonical Hermez source (2^23 capacity, sufficient for the ~8.27M PLONK constraints). All paths nested inside `A-snarkjs-retry/`. [code] `AI`
- [ ] **1A.3** Write `prove.sh`: generates witness from `test-input.eml` (uses `@zk-email/helpers` to parse MIME and prep circuit inputs), runs `snarkjs plonk setup kysigned-approval.r1cs powersOfTau28_hez_final_23.ptau circuit_final.zkey` with V8 flags `NODE_OPTIONS="--max-semi-space-size=1024 --max-old-space-size=120000"`, then runs `snarkjs plonk prove circuit_final.zkey witness.wtns proof.json public.json`. Captures setup time, proving time, peak RAM via `/usr/bin/time -v` into `measurements.md` automatically. [code] `AI`
- [ ] **1A.4** Provision EC2 r5.4xlarge on-demand in `us-east-1` (tag: `Purpose=kysigned-zkprover-A`), run `sudo sysctl -w vm.max_map_count=655300`, clone the `A-snarkjs-retry/` subfolder onto the instance, run `./build.sh`. Record the time and instance details in `measurements.md`. [infra] `AI`
- [ ] **1A.5** Run `./prove.sh ../shared/test-input.eml` on the EC2 instance. Monitor for V8 errors; if the Scavenger failure recurs, this is the critical test of the V8-flags hypothesis. On success, confirm `proof.json` and `public.json` exist. On failure, apply DD-4 blocked protocol: document the exact error, attempt a second hypothesis (e.g., split circuit into smaller sub-circuit for setup, or try an alternate ptau degree), then escalate. [infra] `AI`
- [ ] **1A.6** Write `verify-local.sh`: runs `snarkjs plonk verify vkey.json public.json proof.json`, exits 0 on valid. Run it against the proof generated in 1A.5. Confirm valid. [code] `AI`
- [ ] **1A.7** Export the Solidity verifier: `snarkjs zkey export solidityverifier circuit_final.zkey contracts/Verifier.sol`. Copy into `A-snarkjs-retry/contracts/`. Commit the generated verifier to the branch. [code] `AI`
- [ ] **1A.8** Write `deploy-verifier.sh`: deploys `contracts/Verifier.sol` to Base Sepolia using `cast send` (or `forge create`) with the kysigned ops wallet key from AWS Secrets Manager (`x402/base-sepolia-deployer-key` or whichever wallet has Sepolia ETH per P0.5). Records deployed address to `measurements.md` under `verifier_address_sepolia`. [infra] `AI`
- [ ] **1A.9** Write `verify-onchain.sh`: calls `verifyProof(a, b, c, publicSignals)` on the deployed verifier using `cast call` (dry-run first for gas estimation), then `cast send` for the actual transaction. Captures tx hash, block number, gas used from the receipt into `measurements.md`. Expected gas: ~290k-330k based on snarkjs PLONK verifier benchmarks. [infra] `AI`
- [ ] **1A.10** Populate `measurements.md` with complete metrics:
  - Setup time (ms), peak setup RAM (GB)
  - Proving time (ms), peak proving RAM (GB)
  - Proof size (bytes)
  - zkey size (bytes)
  - Deployed verifier address (Base Sepolia)
  - verifyProof transaction hash
  - On-chain gas used (with tier marker: 🟢 <1M, 🟡 1M-2M, 🔴 >2M)
  - Trust anchor: "Hermez Perpetual Powers of Tau (100+ contributors, EF, Vitalik, Zcash, L2 teams)"
  - Attack surface delta: "None — byte-identical circuit, snarkjs is the current baseline. v0.7.6 is the latest with recent CVE-class fix (public-signals validation)."
  - License: snarkjs is GPL-3.0
  - Production track record: "Ubiquitous — Semaphore, Tornado Cash (pre-sanctions), World ID legacy, Worldcoin orb tooling, many zkEVMs"
  - Audit status: "No major-firm audit of snarkjs itself; relies on circom-pairing community review. v0.7.6 (Jan 2026) fixed public-signals validation class CVE-2023-33252."
  - Archival artifact list: snarkjs version, ffjavascript version, circomlib version, circom compiler version, Node.js version, ptau file SHA-256, package-lock.json hash.
  [code] `AI`
- [ ] **1A.11** Mandatory AWS cleanup: terminate the EC2 instance explicitly, delete the EBS volume if it didn't auto-delete, remove any security groups created for this candidate, verify via `aws ec2 describe-instances --filters Name=tag:Purpose,Values=kysigned-zkprover-A --query 'Reservations[].Instances[].[InstanceId,State.Name]'` — should return empty or all `terminated`. Log the final spend for candidate A in `measurements.md` and in this plan's Implementation Log. Per DD-3, if spend exceeded $15 at any point, escalate to user. [infra] `AI`
- [ ] **1A.12** Commit `A-snarkjs-retry/` subfolder (including README, scripts, contracts/, measurements.md, but NOT the large ptau file or zkey file if >100MB — use `.gitignore` to exclude and document the download URL in README) to branch `zkprover-A`. Push to `origin/zkprover-A`. Mark this sub-plan `Status: Complete`. [code] `AI`

---

## Implementation Log

_Populated during implementation. Gotchas, deviations, emergent decisions go here._

### Gotchas

_(empty — to be populated during implementation)_

### Deviations

_(empty — to be populated during implementation)_

### AWS Spend Tracking (Candidate A)

Running tally. Per-candidate cap: $15. Escalate to user at breach.

- Candidate A spend: $0.00 / $15 budget

---

## Log

- 2026-04-11: Sub-plan created from master zkprover-plan.md. Phase 1-A has 12 tasks. Starts after master Phase 0 completes (worktrees created, shared test input available, Base Sepolia wallet funded).
