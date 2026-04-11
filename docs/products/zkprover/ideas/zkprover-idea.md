---
product: zkprover
feature: null
status: ready
created: 2026-04-11
updated: 2026-04-11
references:
  - type: doc
    path: docs/plans/kysigned-plan.md
    description: Parent kysigned plan — DD-21 (PLONK decision), DD-23 (Rust-pivot-history), paused task 1R.3. zkprover is being brainstormed BECAUSE 1R.3 couldn't pick a proving system with confidence.
  - type: doc
    path: docs/products/kysigned/kysigned-spec.md
    description: kysigned spec v0.9.3 — the FIRST consumer of zkprover. Defines what must be proven (DKIM reply-to-sign, F3.3 / F4). zkprover's spec will be imported back into the kysigned spec once a winner is chosen.
  - type: doc
    path: docs/products/kysigned/research/R10-spike-output-summary.md
    description: The 2026-04-10 Phase R spike output that originally recommended Groth16 via zk-email SDK — then overridden by DD-21 to PLONK on trust grounds. Historical context for why we're here.
  - type: doc
    path: docs/products/kysigned/consultations/plonk-vs-alternatives-proof-system.md
    description: Prior GPT consultation that corrected the team's "zero trust" framing of PLONK — established that PLONK relies on universal Perpetual Powers of Tau (ppot), not zero-ceremony. Grounds the current trust discussion.
  - type: repo
    path: C:\Workspace-Kychee\kysigned\circuits\kysigned-approval.circom
    description: The actual circom circuit (4.6M R1CS / ~8.27M PLONK constraints) that the prover must prove. Uses @zk-email/circuits EmailVerifier + FromAddrRegex + SubjectAllRegex + I APPROVE RevealSubstring.
  - type: url
    path: https://github.com/iden3/snarkjs
    description: snarkjs — candidate A. Current baseline, hit V8 heap wall on setup; retry with correct flags.
  - type: url
    path: https://github.com/TaceoLabs/co-snarks
    description: TACEO co-snarks — candidate B. Rust-native PLONK prover that reads circom R1CS + Hermez ptau and emits snarkjs-compatible zkey/proof. Self-declared experimental/unaudited.
  - type: url
    path: https://github.com/succinctlabs/sp1
    description: SP1 — candidate C. Succinct Labs' STARK-based Rust zkVM, ships Groth16 EVM verifier ~270k gas. Post-Turbo production-grade.
  - type: url
    path: https://github.com/zkemail/sp1-zkEmail
    description: zkemail/sp1-zkEmail — official zk-email SP1 port for DKIM verification. Unaudited.
  - type: url
    path: https://github.com/risc0/risc0
    description: RISC Zero — candidate D. STARK-based Rust zkVM, Groth16 EVM verifier ~280k gas. Strongest formal verification story (Picus + Veridise), longest Base production track record via Boundless.
  - type: url
    path: https://github.com/risc0-labs/r0-zkEmail
    description: boundless-xyz/r0-zkEmail — first-party RISC Zero DKIM example. Unaudited.
---

## Problem / Opportunity

kysigned requires generating zero-knowledge proofs of DKIM-signed email replies ("reply-to-sign") and verifying them cheaply on Base L2. The first attempt to build a proving system hit a hard wall: `snarkjs plonk setup` fails on the ~8M-constraint circuit at V8 internal heap limits regardless of how much RAM is thrown at it. Multiple pivot attempts compounded the problem by trying to pick a new proving system AND a new tooling stack AND a new deploy target simultaneously, with no working proof end-to-end to validate the choices against. The team has been debating proof systems for weeks without producing a single valid proof.

**The underlying opportunity:** Kychee owns run402, and whatever proving system we adopt for kysigned must become a run402 platform service — so the decision has consequences beyond a single product. Getting the proving stack right once, with measured data from multiple actually-built candidates, unlocks zero-knowledge proving as a Kychee platform capability for every future SaaS product that needs it.

The cost of the repeated restart is concrete: ~3 full chat sessions lost to re-litigating settled constraints (Groth16 trust model, PLONK-vs-alternatives gas, whether to accept operator-verified fallback, whether to shrink the circuit) before any code runs.

## Target Audience

- **Primary:** kysigned as a product. Needs a working prover that generates DKIM reply-to-sign proofs reliably, with trust ≥ PLONK-ppot, gas ≈ PLONK-BN254 verifier, security ≥ current baseline.
- **Secondary:** run402 as a platform. The winner becomes a run402 base service (API + CLI + MCP) available to every forker. This means the winning tool's licensing, archivability, deployment footprint, and operational story must all be compatible with run402's fork-out-of-the-box posture.
- **Tertiary:** future Kychee products that need zk proving (any verification-intensive SaaS). The winner becomes the default proving stack across the product family.
- **Not in scope:** third-party consumers of the proving API (until run402-zkprover is productized as a standalone service).

## Proposed Idea

Build **four independent prover implementations in parallel** inside the public kysigned repo under `zkprover-candidates/{A,B,C,D}/`, each self-contained, each producing a valid proof for a representative DKIM reply-to-sign input. Measure each honestly (proving time, memory footprint, gas cost, archival complexity, new attack surface), then pick one (or two, for defense-in-depth) for kysigned to adopt and for run402 to productize as a platform service.

The four candidates — chosen after cross-referencing three rounds of research against the settled trust and gas constraints — are:

**Candidate A — snarkjs PLONK retry.** Rerun the original `snarkjs plonk setup` that failed, this time with `NODE_OPTIONS="--max-semi-space-size=1024 --max-old-space-size=120000"` and `sudo sysctl -w vm.max_map_count=655300`. The original failure error (`"Scavenger: semi-space copy Allocation failed"`) was in V8's young-generation semi-space, a heap region not controlled by `--max-old-space-size`. The missing flag may turn the wall into a non-issue. Free to test, zero code change, no new attack surface. If it works, kysigned ships tomorrow with the existing circuit and verifier shape.

**Candidate B — TACEO co-snarks (validator role).** `TaceoLabs/co-snarks` is a Rust-native PLONK prover (April 2025 release) that reads circom `.r1cs` + Hermez `.ptau` and produces snarkjs-compatible zkey + proof. The circuit stays byte-identical to candidate A. The Solidity verifier is snarkjs-compatible. **TACEO self-declares as "experimental and un-audited" in its README**, so its role in this plan is explicitly as a **validator, not a production-primary** — the snarkjs-compatible verifier is the cryptographic trust root, and a buggy TACEO prover can at worst produce proofs that *fail* to verify (it cannot produce proofs that verify but shouldn't, because the verifier checks the math independently). Building it proves a Rust circom-PLONK pipeline is possible and gives us a production candidate once TACEO is audited later.

**Candidate C — SP1 zkVM + `zkemail/sp1-zkEmail` fork.** SP1 is Succinct Labs' STARK-based Rust zkVM. Write the DKIM verification logic as a Rust "guest program," SP1 proves it via STARKs (transparent, no ceremony), then wraps the final proof in a Groth16 wrapper over Hermez ppot Phase 1 + Succinct's public Phase 2 ceremony. EVM verifier gas: ~270k (**cheaper than PLONK's 330-520k**). Fork `zkemail/sp1-zkEmail` — zk-email's own official SP1 DKIM port — and adapt the outer "I APPROVE + envelope binding" logic. **The zkEmail port itself is unaudited**; we review/port its DKIM canonicalization code against the audited `@zk-email/circuits` reference before production adoption. SP1 has had three publicly-disclosed soundness bugs patched in "SP1 Turbo" (Jan 2025) and now secures $1B+ TVL across Celestia Blobstream, OP Succinct on Mantle, Polygon AggLayer.

**Candidate D — RISC Zero + `boundless-xyz/r0-zkEmail` fork.** RISC Zero is the longest-in-production Rust STARK zkVM. Same approach as C (Rust guest program, STARK inner, Groth16 wrapper for EVM). EVM verifier gas: ~280k. Fork `boundless-xyz/r0-zkEmail` — the first-party DKIM example. **Strongest safety story of the four:** Picus formally verifies ~45k+ constraints of the RISC-V circuit including the Keccak accelerator (RISC Zero markets itself as "first formally-verified RISC-V zkVM"); 238-contributor p0tion ceremony for the Groth16 wrapper; longest production track record including Boundless (mainnet on Base since Sept 2025, 542T cycles by Aug 2025) — the same chain kysigned targets. The r0-zkEmail port is also unaudited and receives the same DKIM canonicalization review treatment as C.

**The build methodology matters as much as the candidate list:** each candidate's code is fully self-contained under its own subfolder — no shared `Cargo.toml`, no shared `package.json`, no cross-folder dependencies — so losing candidates can be deleted with a single `rm -rf` at the end of the experiment without side effects. Parallel work is enabled via four git worktrees (one per candidate) forked from `main`, so the builds do not block each other.

## Business Thinking

**Problem (3 hardest):**
1. kysigned cannot ship without a working proof system; the current approach has produced zero valid proofs over multiple weeks of effort.
2. The current "debate-then-build" pattern has repeatedly picked a proving system on paper, then hit a hard tooling wall at build time, then re-debated. The cycle wastes calendar time and erodes confidence in the plan. Building multiple candidates in parallel kills the cycle.
3. Every proving-system decision for kysigned implicitly commits run402 to a platform extension to host that prover. Without measured data from real builds, the platform-extension decision is equally speculative.

**Customer Segments (for the platform service perspective):**
- kysigned (first consumer, already committed, blocks its own launch on this)
- Any future Kychee SaaS product that needs zk proofs (currently hypothetical; the saas-factory spec allows for future products at cadence)
- Third-party forkers of run402 who want to deploy kysigned or any other zk-enabled product out of the box

**Unique Value Proposition (for run402-zkprover as a platform service):** "The only forkable zk proving service — clone run402, get a production-grade zk prover with the same trust model as Ethereum's Perpetual Powers of Tau." This is aligned with DD-9's trojan horse posture: run402 extensions become reasons to use run402, not reasons to peel off from it.

**Unfair Advantage:** Kychee owns both sides — the product (kysigned) that demands the prover AND the platform (run402) that hosts it. Competitors offering zk proving as a service (Sindri, Succinct Prover Network) cannot integrate as tightly with their consumers as we can integrate with ourselves. The kysigned-on-run402 deployment becomes a reference implementation that's strictly easier for forkers to adopt than "stand up your own proving infra + point kysigned at it."

**Key Metrics (for judging the winning candidate — not yet a KPI set for a production service):**
1. **Does it produce a valid proof for a representative DKIM reply-to-sign input?** (binary, yes/no — the first hard gate)
2. **Actual gas cost of the EVM verifier contract** (measured, not estimated — hard gate: within ~2x of PLONK's 330-520k)
3. **Measured proving time and peak memory** (informational, not a gate — the user explicitly said these don't block the decision)
4. **Archival complexity:** how many artifacts need vendoring to reproduce the build in 5+ years?
5. **Attack surface delta vs current baseline** (qualitative — audited? how many LOC? production-deployed?)
6. **run402 extension cost:** what platform changes does run402 need to host this prover at scale?

**Cost Structure:**
- Engineering time for the four builds (user explicitly ruled as non-constraining — "I don't care about build time")
- AWS compute for the builds themselves ($20 hard cap per DD-23, plus whatever `/plan` decides for each candidate)
- One-time ceremony verification + archival work for the winning candidate (low, ~1 day)
- Ongoing: whatever run402 extension is needed to host the winner (TBD, depends on winner)

## Key Decisions

### Settled constraints (do not relitigate)

1. **Groth16 with a Kychee-run per-circuit ceremony is permanently off the table.** Stored in user memory. The whole product premise is "trust no operator," which means we cannot run the ceremony.
2. **Moving security-critical checks out of the circuit is permanently off the table.** Stored in user memory.
3. **Trust anchor floor = Perpetual Powers of Tau (Hermez ceremony, 100+ public contributors including EF, Vitalik, Zcash, major L2 teams).** Any candidate with equivalent or better public multi-party ceremonies is acceptable. SP1, RISC Zero, Noir/Aztec Ignition all qualify by the user's "as low as PLONK" bar.
4. **Hard gates on every candidate:** (a) trust ≥ ppot, (b) EVM verifier gas ≈ PLONK (within ~2x, accept up to ~1M gas), (c) no new attack vector beyond what's in scope for the candidate's class, (d) no external proving service dependency — prover runs on our own infrastructure, fully open source, reproducible from vendored deps.
5. **Don't-care constraints:** build time, one-time setup cost, per-proof wallclock. The user has been explicit about all three — none of them block the decision.

### Scope and output

6. **Build four candidates in parallel, not sequentially.** Parallel via git worktrees. Each candidate self-contained under `kysigned/zkprover-candidates/<letter>/`.
7. **Each candidate must actually produce a valid proof for the existing `kysigned-approval.circom` circuit or a Rust port of its semantics** — the output gate is binary, "do we have a real proof or not," not "does it compile." No candidate is judged "done" on paper.
8. **TACEO (B) starts as a validator, not a production-primary — role can change later.** Building it is valuable regardless of audit status because the snarkjs-compatible verifier independently checks the proof math: a buggy TACEO prover can at worst produce proofs that *fail* to verify, not proofs that fraudulently verify. Adopting it as production requires waiting for an audit (which may happen organically — TACEO is actively developed and Least Authority already audits adjacent TACEO products). **The "validator" label is the starting posture for this iteration, not a permanent role** — if measurement shows B is the clear winner on other axes, Kychee may sponsor or commission an audit to elevate it to production-primary.
9. **SP1 and RISC Zero zkEmail ports (C and D) require DKIM canonicalization review before production adoption.** This is a post-build task, not a pre-build gate. Options for the review: (a) internal review against RFC 6376 and audited `@zk-email/circuits`, (b) external audit, (c) byte-for-byte port of audited canonicalization logic into the Rust guest. Choice is deferred until we see which candidate wins.
10. **Cross-candidate dependency sharing is forbidden.** Each candidate's folder is self-contained. This guarantees losing candidates can be deleted with a single `rm -rf` after the winner is chosen.

### Rejected alternatives — do not re-open

These are **permanently rejected** for this iteration and any reasonable future iteration. Stored here to prevent circular debates in later sessions.

11. **Circuit shrinking (cutting `maxBodyLength`, `maxHeaderLength`, `FromAddrRegex`, etc.) is NOT bundled into this pivot.** Was considered as a way to bring the ~8M constraint count down to something snarkjs could handle natively at 2M constraints. Rejected because: (a) it changes two variables simultaneously (prover AND circuit) making it impossible to debug failures; (b) it introduces a delicate security concern with the FromAddrRegex binding that deserves its own adversarial TDD cycle; (c) the proving systems we selected (SP1, RISC Zero, TACEO) don't need it — they handle 8M constraints natively or in Rust guest programs. Revisit circuit shrinking only as a **standalone optimization task** AFTER a working proof exists.
12. **Transparent systems (Halo2-IPA, STARK-direct-on-EVM, Plonky2 direct verifier, MicroNova)** — all fail the gas gate. Plonky2 direct verifier costs 18-27M gas (50x over budget); Halo2-IPA has no production EVM verifier (PSE explicitly swapped IPA→KZG "for cost-effective Ethereum verifiability" and put the repo in maintenance mode Jan 2025); MicroNova at ~2.2M gas is the only transparent system within striking distance of the bar but is research-grade with no audited Solidity verifier. **Revisit in 18-24 months if the ecosystem improves.**
13. **gnark (Go, ConsenSys)** — has no circom R1CS loader, so it would require rewriting the circuit in gnark's Go DSL (full circuit rewrite), AND no zk-email primitives exist in `gnark-crypto` so the DKIM verification code would also need to be rewritten from scratch. The effort-for-certainty tradeoff is strictly worse than SP1 or RISC Zero, which have pre-built first-party Rust zk-email ports. [`vocdoni/circom2gnark`](https://github.com/vocdoni/circom2gnark) only lets gnark *verify* snarkjs proofs (recursion), not *prove* circom circuits.
14. **Proving services (Sindri, Succinct cloud, =nil; foundation, Brevis Pico cloud, etc.)** — rejected by user directive: "there will be no 'outside' on the final solution because we want to enable forkers to run it out of the box over run402." The prover must be self-hostable.
15. **FFLONK (in snarkjs or anywhere else).** Same trust model as PLONK (universal ppot) and often marketed as "cheaper PLONK" on verifier gas. In practice, snarkjs's FFLONK implementation uses **more** memory than PLONK and needs a ptau file roughly three orders of magnitude larger for equivalent circuit power ([hanzeG/snarkjs_bench](https://github.com/hanzeG/snarkjs_bench), Jan 2025). It is NOT a memory escape hatch for the 8M-constraint wall. Do not re-propose as a "try FFLONK instead of PLONK" alternative.
16. **rapidsnark (iden3 C++ prover).** Still Groth16-only as of April 2026. `iden3/go-rapidsnark` issue #17 ("PLONK support") is open with no PLONK branch. Since Groth16 is permanently off the table, rapidsnark is inapplicable regardless of its other merits. Do not re-propose.
17. **fluidex/plonkit.** Real Rust `circom → PLONK → Solidity-verifier` pipeline that exists and works. Fails the trust gate because it uses matter-labs' `bellman_ce` PLONK flavor with its own separate SRS — not Hermez ppot. Also unmaintained since Jan 2023 (no commits in 3+ years). Do not re-propose as "a Rust PLONK option" — TACEO co-snarks (candidate B) is the Rust-native circom-PLONK path that actually uses Hermez ppot.
18. **Jolt (a16z), Nexus zkVM, Pico (Brevis).** All Rust zkVMs in the same broad family as SP1/RISC Zero, considered and dropped for different reasons: Jolt is alpha in April 2026 with no shipped EVM verifier and 200KB+ proof sizes; Nexus is pivoting to its own NexusEVM L1 rather than a general "prove-on-foreign-EVM" story; Pico/Brevis's Gnark-Groth16 wrapper ceremony is run by Brevis themselves with no public multi-party transcript (fails the ceremony trust gate). **Revisit individually if any of them publishes a credible production EVM path with an attested multi-party ceremony.**
19. **`ark-circom` + `jellyfish`, `ark-circom` + `zk-garage/plonk`, and any arkworks-based PLONK backend.** No working bridge exists between arkworks R1CS (what `ark-circom` produces) and any arkworks-based PLONK gate representation — jellyfish and zk-garage PLONK both have their own native gate APIs that do not consume arkworks R1CS, and the bridge tickets on the tracking repos never shipped. The first research round spent time investigating this path before finding it was a dead end. **Do not re-propose as "use arkworks."** TACEO co-snarks (candidate B) is the only known working Rust-native circom-PLONK path.

### Deferred for future iteration

These are **not rejected** — they're reasonable options that are being parked for now and may come back in a later iteration if the current shortlist underperforms, the ecosystem matures, or a specific motivation surfaces.

20. **Noir + Barretenberg (UltraHonk) with [`zkemail.nr`](https://github.com/zkemail/zkemail.nr)** — candidate E in earlier drafts. The zkemail.nr library is real, audited by Consensys Diligence (Dec 2024), and ships production-grade DKIM/RSA-2048/SHA-256 primitives. Barretenberg uses Aztec Ignition (176 contributors, Vitalik as #1, ppot-equivalent trust). Dropped from the current shortlist because: (a) smallest production track record of the available options, (b) Barretenberg's UltraHonk Solidity verifier gas number is unpublished as of April 2026 — unacceptable risk to commit without measurement, (c) the build effort is comparable to SP1/RISC Zero without offering a clearly better trust or cost story. **Revisit if:** the current four-candidate shortlist underperforms, OR Barretenberg publishes verified gas numbers in the PLONK-BN254 class, OR Noir becomes the clearly-dominant zk-email reference implementation in the ecosystem. This is the most likely "next step" if we need one.

### Orthogonal optimizations (can be applied to any winner)

These are NOT alternatives to the proving-system choice — they're optimizations that can be layered on top of whatever candidate wins. Parked until a single-signer proof is working end-to-end.

21. **Batching / recursive aggregation of multiple signatures into one proof.** Proposed by the 2026-04-10 GPT consultation (`plonk-vs-alternatives-proof-system.md`) as "the most realistic hybrid for your architecture — batch multiple signer approvals into one proof, especially per-envelope." The math is the same for any PLONK-family or zkVM-wrapped candidate; this is a circuit-level and application-level optimization, not a proof-system choice. Deferred until (a) at least one candidate produces a valid single-signer proof end-to-end, (b) kysigned's production economics at scale create a measurable case for amortizing verifier gas across signers. Revisit when the first candidate ships a working single-signer proof.

### Core differentiator approaches (explored during brainstorm)

The core differentiator of zkprover is the **answer to "which proving system powers the platform service."** Three distinct approaches were explored during brainstorm:

**Approach 1 — Stay on PLONK, fix the tooling.** Keep the existing circom circuit byte-identical and swap the prover (snarkjs retry, TACEO, or similar circom-compatible Rust tool). Pros: minimal code change, unchanged trust model, existing Solidity verifier still works. Cons: gambles that some PLONK-capable prover will actually handle the 8M-constraint scale in practice — if they all hit a wall, we've spent effort to learn "no circom-PLONK path works for us" and are back where we started.

**Approach 2 — Rust zkVM path.** Rewrite the DKIM verification logic as a Rust program running inside a mature zkVM (SP1 or RISC Zero), wrap the final proof in a Groth16 for EVM verification. Pros: proven production-grade tools, first-party zk-email examples available, cheaper gas than PLONK, strongest audit and formal-verification track record (especially RISC Zero). Cons: larger trusted codebase (the zkVM implementation is new trusted code); the zkEmail port is currently unaudited and needs review.

**Approach 3 — Transparent / math-only system.** Eliminate ceremony trust entirely via Halo2-IPA or STARKs with direct EVM verification. Pros: strictly better trust story. Cons: no production-ready implementation hits the gas budget as of April 2026 — transparency fundamentally costs more on EVM because ceremony-based pairing verifiers exploit the BN254 precompile while FRI/IPA verifiers cannot.

**Chosen approach: mix of 1 and 2 — build all four candidates (two from Approach 1, two from Approach 2) in parallel, measure them, then pick.** The user explicitly authorized building multiple candidates because "I don't care about build time, I want certainty, not guesses." Approach 3 is deferred to a future iteration when the ecosystem produces a transparent system within the gas bar.

## Open Questions

These are intentionally left for `/spec` and `/plan` to resolve, or for measurement during `/implement`:

1. **Will candidate A (snarkjs retry with correct V8 flags) actually work on the current 8M-constraint circuit?** Free to test, answer in ~1 day. If yes, it becomes the obvious primary and reduces the urgency of C and D.
2. **What is Noir/Barretenberg's UltraHonk Solidity verifier gas cost in April 2026?** Unpublished. If it turns out to be substantially cheaper than SP1/RISC Zero, Noir comes back into the shortlist — but measuring requires building candidate E, which we're deferring.
3. **What is Succinct's SP1 Groth16 wrapper Phase 2 ceremony's exact participant count and attestation quality?** The confirmation research confirmed SP1 is audited and production-grade but did not nail down the Phase 2 ceremony size. Answer before C is adopted as production primary.
4. **What specific libraries does each zkEmail port use for RSA-2048 / SHA-256 / DKIM canonicalization in the Rust guest?** These become part of the trusted computing base for C and D. Deferred to the implementation phase — we'll see the deps when we fork the repos.
5. **How much does each candidate cost to deploy on run402?** The "run402 extension scope" from the earlier Q1-Q3 discussion — only answerable after we know which candidate wins. Answer before `/spec` for the platform-service layer of zkprover.
6. **Should we keep all four candidates in the repo indefinitely (as documentation / comparison reference) or delete losing candidates?** Leaning "keep all" per the "avoid circular discussions" feedback memory — having the four builds alongside each other in `zkprover-candidates/` is exactly the kind of artifact that stops future sessions from re-running the decision. But this is a minor preference, can be decided after the builds are done.
7. **If two candidates work equally well (e.g., A AND D both produce valid proofs cleanly), do we adopt one as primary and one as fallback, or just pick one?** Deferred to decision time.
8. **How does the zk-email upstream team's recommended stack look in the second half of 2026?** We're picking now based on April 2026 information; if zk-email announces a clearly-preferred path in H2 2026 we may want to revisit. Not a blocker.

## Readiness for /spec

- [x] Problem/opportunity clearly defined
- [x] Target audience identified (kysigned primary, run402 platform service secondary, fork-ability tertiary)
- [x] Core idea described (build four candidates in parallel, measure, pick winner)
- [x] Key assumptions surfaced and challenged (trust model, gas bar, attack surface delta, zkEmail port audit status)
- [x] MVP or simplest version discussed (candidate A is the simplest-case MVP — snarkjs retry is hours of work to validate)
- [x] Business model considered (run402 platform service, forkable out of the box, trojan horse alignment)
- [x] Open questions documented

Status: **ready** — all required items checked.
