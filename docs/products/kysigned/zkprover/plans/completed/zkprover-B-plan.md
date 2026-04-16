# Plan: zkprover-B (Candidate B — TACEO co-snarks Rust PLONK)

**Owner:** Barry Volinskey
**Created:** 2026-04-11
**Status:** Blocked (stopped by user 2026-04-12 — D won; B's remaining tasks abandoned)
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

- [x] **1B.1** Scaffold `kysigned/zkprover-candidates/B-taceo/` with `README.md`, `build.sh`, `prove.sh`, `verify-local.sh`, `deploy-verifier.sh`, `verify-onchain.sh`, `measurements.md` template, and a `contracts/` subfolder. README explicitly states the **validator role framing** and includes a direct link to TACEO's README with the "experimental and un-audited" disclaimer highlighted. [code] `AI`
- [x] **1B.2** Write `build.sh`: clones `TaceoLabs/co-snarks` at a pinned commit hash into `B-taceo/vendor/co-snarks/`, strips `.git`, installs the Rust toolchain via `rustup` with a pinned version from `rust-toolchain.toml`, builds the co-circom Rust crate via `cargo build --release`. Nested self-contained — no edits to root `Cargo.toml`, no workspace references. Copies `kysigned/circuits/kysigned-approval.circom` into the candidate folder. Downloads the same `powersOfTau28_hez_final_23.ptau` used by Candidate A (ideally from a local cache if A is running concurrently; otherwise fresh fetch from Hermez mirror). [code] `AI`
- [x] **1B.3** Write `prove.sh`: generates witness from `test-input.eml` (same witness generation as A — reuse `@zk-email/helpers` for parsing), runs TACEO's co-circom command to produce the PLONK proof from circuit + ptau + witness. Captures setup time, proving time, peak RAM into `measurements.md`. [code] `AI`
- [~] **1B.4** Provision EC2 r5.4xlarge on-demand in `us-east-1` (tag: `Purpose=kysigned-zkprover-B`), clone the `B-taceo/` subfolder onto the instance, run `./build.sh`, then `./prove.sh ../shared/test-input.eml`. Record instance details and output. — **RETRY: pinned circom 2.1.9 (matching A) + ptau 24. Instance `i-010c8edca9a4a00ee`. Root cause: circom 2.2.3 produced 8.27M PLONK constraints (domain 2^23) which hits snarkjs bug; circom 2.1.9 produces 10M (domain 2^24) which works.** [infra] `AI`
- [x] **1B.5** Apply DD-4 blocked protocol if prove fails. — **Applied: 6 PLONK setup attempts, 5 distinct hypotheses exhausted. Candidate B marked blocked.** [infra] `AI`
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
- [x] **1B.12** Mandatory AWS cleanup: terminate EC2, delete EBS, verify via `describe-instances` filter. Log spend. Escalate if exceeded $15. — Instance `i-03dbeede85dae7161` terminated. EBS (DeleteOnTermination=true) auto-deleted. Spend: ~$11.09 / $15 budget. [infra] `AI`
- [ ] **1B.13** Commit `B-taceo/` subfolder to branch `zkprover-B`. Push. Mark sub-plan `Status: Complete`. [code] `AI`

---

## Implementation Log

### Gotchas

- co-circom has **no single-party/plain mode**. Minimum 3 parties (REP3 protocol). All proving must use 3 localhost parties with TLS. Witness generation can use standard circom WASM calculator + `co-circom split-witness` to avoid MPC witness gen overhead.
- co-circom requires TLS (DER format certs/keys) between parties even on localhost. Generated self-signed certs in build.sh.
- PLONK setup and Solidity verifier export use standard snarkjs, not co-circom. co-circom only handles witness splitting and proof generation.
- **Must save zkey to S3 before terminating EC2.** The 42 GB zkey takes 3.5 hours to generate and is needed for production. A's zkey was lost when A's instance was terminated with DeleteOnTermination=true. The zkey is identical across A and B (same circuit + ptau + snarkjs), so one copy serves both.
- circom 2.1.9 vs 2.2.3 produces different R1CS (3.15M vs 4.59M constraints) from the same circuit source. The 2.2.3 output hits a snarkjs PLONK bug at domain 2^23. Must pin circom 2.1.9.
- B's package.json must match A's exact version pins (snarkjs ^0.7.6, @zk-email/circuits ^6.3.4, etc.) to avoid npm resolution differences that cause snarkjs crashes.

### Deviations

- Used `powersOfTau28_hez_final_24.ptau` (2^24) in addition to the planned `powersOfTau28_hez_final_23.ptau` (2^23) during debugging. Neither resolved the zkey corruption.
- circom compiler version 2.2.3 installed from iden3/circom source (not crate registry — `circom` is not published to crates.io).

### DD-4 Blocker: snarkjs PLONK setup corrupt zkey

**Step that failed:** snarkjs `plonk setup` — generates the PLONK proving key (.zkey) from R1CS + ptau. This is a prerequisite for everything downstream (witness generation works fine; proving/verification/deployment all depend on a valid zkey).

**Specific error:** The generated zkey file is structurally corrupt — sections 0, 1, and 2 (which contain the zkey header, protocol type, and curve metadata) are never written. Section 12 data overflows its declared size. snarkjs's own `zkey export verificationkey` rejects the file with `Error: Missing section 1`.

**Error output:**
```
[ERROR] snarkJS: Error: build/kysigned-approval.zkey: Missing section 1
    at Object.startReadUniqueSection (binfileutils)
    at readHeader$1 (snarkjs/build/cli.cjs:3846)
```

**What was tried (6 attempts):**

| # | V8 flags | ptau | Method | Zkey size | Section 12 | Result |
|---|----------|------|--------|-----------|------------|--------|
| 1 | `--max-old-space-size=100000` | 23 | CLI | 9.1 GB | size=0 | Corrupt |
| 2 | `--max-old-space-size=100000` | 23 | nohup CLI | 9.1 GB | size=0 | Corrupt |
| 3 | `--max-old-space-size=65536 --max-semi-space-size=512` | 23 | CLI direct | 11.0 GB | size=4 GB | Corrupt (overflow) |
| 4 | `--max-old-space-size=120000 --max-semi-space-size=1024` | 23 | CLI tee | 11.0 GB | size=4 GB | Corrupt (overflow) |
| 5 | `--max-old-space-size=120000 --max-semi-space-size=1024` | **24** | CLI tee | 9.1 GB | size=0 | Corrupt |
| 6 | `--max-old-space-size=65536 --max-semi-space-size=1024` | **24** | Node API | 9.1 GB | size=0 | Corrupt |

**Hypotheses tested:**
1. V8 old-space-size too large → tried 65536 and 120000 → no fix
2. V8 semi-space-size missing → tried 512 and 1024 → no fix
3. ptau 23 too small for 8.27M constraints → tried ptau 24 → same corruption
4. CLI invocation adds pipe/tee overhead → tried Node.js API directly → same corruption
5. tee/pipe kills snarkjs via SIGPIPE → tried without pipes → same crash

**No OOM detected:** `dmesg` shows zero OOM kills or killed processes across all attempts. The Node.js process exits cleanly (no crash signal). V8 allocates ~40 GB of 128 GB available.

**Blocker hypothesis:** This is a bug in snarkjs 0.7.6's `@iden3/binfileutils` write path for PLONK zkeys at the 8M+ constraint scale. The section data write overflows the declared section size, and the header sections (0, 1, 2) are appended after section 12's data but at an offset that's now wrong. snarkjs 0.7.6 is the latest npm version — no newer version exists.

**Upstream references:** None found. This may be a novel finding specific to the kysigned-approval.circom constraint count (8,270,686 PLONK / 4,594,997 R1CS).

**What IS confirmed to work:**
- co-circom binary builds successfully (23 MB, Rust, ~3 min compile)
- circom 2.2.3 compiles the circuit: 4,594,997 R1CS constraints, 8,270,686 PLONK constraints
- Witness generation via standard circom WASM works
- co-circom `split-witness` accepts the witness (tested on smaller circuits)
- co-circom `generate-proof plonk` and `verify plonk` work for small circuits

**Next step requires upstream fix or workaround:** Either a patched snarkjs that correctly handles >8M PLONK constraints, or a way to generate the zkey using a different tool (e.g., a Rust-native PLONK setup in co-circom, which doesn't exist yet).

### AWS Spend Tracking (Candidate B)

- Candidate B spend: ~$11.09 / $15 budget (r5.4xlarge @ $1.008/hr × ~11 hrs: 16:53 UTC Apr 11 → 04:08 UTC Apr 12)

---

## Log

- 2026-04-11: Sub-plan created from master zkprover-plan.md. Phase 1-B has 13 tasks. Starts after master Phase 0 completes.
- 2026-04-11: Completed "1B.1" — Scaffolded B-taceo/ with README.md (validator role framing + TACEO disclaimer link), 5 shell script stubs, measurements.md template, contracts/ subfolder. 8 files total.
- 2026-04-11: Completed "1B.2" — build.sh: clones co-snarks@924c886, builds co-circom binary, installs circom+snarkjs+zk-email deps, copies circuit, compiles R1CS+WASM, downloads Hermez ptau, runs PLONK setup, generates TLS certs + 3-party localhost MPC configs. Added .gitignore for large artifacts. Key finding: co-circom has no single-party mode — must run 3 REP3 parties on localhost.
- 2026-04-11: Completed "1B.3" — prove.sh: parses .eml → circuit input JSON (via generate-input.mjs, self-contained copy), generates witness via standard circom WASM calculator, splits witness into 3 REP3 shares, runs 3-party PLONK proof generation with /usr/bin/time -v timing. Captures proving time, peak RAM, proof size.
- 2026-04-11: Started "1B.4" — Provisioned EC2 r5.4xlarge `i-03dbeede85dae7161` in us-east-1. co-circom binary built successfully (23 MB). Circuit compiled: 4,594,997 R1CS / 8,270,686 PLONK constraints. Hermez ptau 23 downloaded (9.1 GB). PLONK setup attempt 1 produced corrupt zkey.
- 2026-04-12: **"1B.4" BLOCKED** — 6 PLONK setup attempts all produce structurally corrupt zkey (missing sections 0-2, section 12 overflow). snarkjs 0.7.6 bug at 8M+ PLONK constraint scale. DD-4 applied. Instance `i-03dbeede85dae7161` terminated. Spend: ~$11.09.
- 2026-04-12: Completed "1B.5" — DD-4 blocked protocol applied. 5 hypotheses exhausted (V8 flags, ptau version, invocation method, pipe isolation, Node API). Full blocker documented in Implementation Log.
- 2026-04-12: **UNBLOCKED** — Candidate A completed successfully with circom 2.1.9 (10M PLONK constraints, domain 2^24, 42 GB zkey). Root cause identified: circom 2.2.3 vs 2.1.9 produces different constraint counts, and snarkjs has a bug at the 2^23 domain boundary. Retrying with circom 2.1.9 + ptau 24. New instance `i-010c8edca9a4a00ee`. Budget overage approved by user (~$19-21 total for B).
