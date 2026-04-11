# Plan: zkprover (master coordination plan)

**Owner:** Barry Volinskey
**Created:** 2026-04-11
**Status:** Planning
**Spec:** docs/products/zkprover/zkprover-spec.md
**Spec-Version:** 0.1.0
**Source:** spec
**Worktree:** none — master plan runs on `main`; per-candidate work runs in per-candidate worktrees (see DD-6)

## Legend
- `[ ]` Todo | `[~]` In Progress | `[x]` Done
- Task type annotations: `[code]`, `[infra]`, `[manual]` — drive which verification methodology `/implement` applies.

## How this plan is structured

zkprover v0.1.0 is implemented as a **master plan + four independent sub-plans** so that each candidate can be built in parallel by a separate `/implement` session in its own worktree. The split mirrors the spec's F1.2 self-containment requirement.

| Plan file | Scope | Executed in |
|---|---|---|
| **`zkprover-plan.md`** (this file) | Phase 0 (prerequisites), Phase 2 (matrix), Phase 3 (winner decision). Shared setup and teardown across candidates. | `main` branch, `C:\Workspace-Kychee\kysigned\` |
| **`zkprover-A-plan.md`** | Phase 1: Candidate A — snarkjs PLONK retry | Worktree `C:\Workspace-Kychee\kysigned-zkprover-A\`, branch `zkprover-A` |
| **`zkprover-B-plan.md`** | Phase 1: Candidate B — TACEO co-snarks | Worktree `C:\Workspace-Kychee\kysigned-zkprover-B\`, branch `zkprover-B` |
| **`zkprover-C-plan.md`** | Phase 1: Candidate C — SP1 zkVM | Worktree `C:\Workspace-Kychee\kysigned-zkprover-C\`, branch `zkprover-C` |
| **`zkprover-D-plan.md`** | Phase 1: Candidate D — RISC Zero | Worktree `C:\Workspace-Kychee\kysigned-zkprover-D\`, branch `zkprover-D` |

**Execution order:**
1. `/implement zkprover` → runs Phase 0 on `main`. At Phase 0 completion, the four worktrees exist, the shared test input is committed and fast-forwarded to all four feature branches, and the AWS + Base Sepolia environment is verified.
2. Open **four separate Claude Code instances**, one per worktree. In each, run the corresponding sub-plan: `/implement zkprover-A`, `/implement zkprover-B`, `/implement zkprover-C`, `/implement zkprover-D`. Each sub-plan runs independently to completion or blocked-state for its candidate. No cross-instance coordination needed.
3. After all four sub-plans reach terminal state (`Status: Complete` or at least one task `[!]` blocked per DD-4), return to the master plan instance and run `/implement zkprover` again. Phase 2 (matrix) runs, then Phase 3 (winner decision with user).

The master plan's Design Decisions apply to every sub-plan. Sub-plans reference `zkprover-plan.md` for DDs rather than duplicating them.

---

## Design Decisions

### DD-1: Test input acquisition — Barry sends from Gmail to barry@kychee.com
- **Decision:** Barry sends a real email with body `I APPROVE` and canonical Kysigned subject format (`[kysigned] <envelopeId> <docHash>`) from his Gmail to `barry@kychee.com`. The raw `.eml` is IMAP-fetched (or downloaded directly from the Kychee mail UI) preserving DKIM headers and committed to `kysigned/zkprover-candidates/shared/test-input.eml`.
- **Alternatives:** run402 mailbox (blocked on parallel work); zkemail test vectors (don't match kysigned format).
- **Chosen because:** Realistic, kysigned-format-matching, independent of parallel work.
- **Trade-offs:** ~1 hour of human/IMAP setup.
- **Rollback:** N/A — this is the input, not the system.

### DD-2: Uniform thin-wrapper scripts across all candidates
- **Decision:** Every candidate has `build.sh`, `prove.sh <input.eml>`, `verify-local.sh`, `deploy-verifier.sh`, `verify-onchain.sh`. Each wrapper is ~3-5 lines that calls the native tool underneath (`cargo build`, `npm install`, `cargo risczero build`, etc.).
- **Alternatives:** Pure uniform (hide native tools); pure idiomatic per candidate (no wrappers).
- **Chosen because:** Enables automated matrix generation + lets anyone inspecting a single candidate see the underlying native tool trivially.
- **Trade-offs:** Minor wrapper maintenance (~25 lines total across candidates).
- **Rollback:** Wrappers can be deleted and replaced with direct native commands.

### DD-3: EC2 spend cap — $50 total, $15 per-candidate, escalate if breached
- **Decision:** Hard cap of $50 total across all zkprover work, with a $15 per-candidate sub-cap. If any per-candidate spend exceeds $15, OR the total exceeds $30 before the fourth candidate starts, work STOPS and escalates to the user. Running spend tally reported at each milestone.
- **Alternatives:** $30 (too tight), $100 (too generous for early research).
- **Chosen because:** Matches "don't care about cost" balanced with "make sure you clean up."
- **Trade-offs:** If the cap is breached, work pauses for user decision.
- **Rollback:** Cap can be raised via explicit user confirmation.

### DD-4: Blocked-threshold operational definition
- **Decision:** A candidate is marked `[!] blocked` when ALL of: (1) two distinct debugging hypotheses attempted and failed, (2) no further credible hypothesis from docs/issues/upstream, (3) next step requires upstream code changes or rebuilding tooling, (4) ≥4 hours of active debugging time, (5) blocked entry includes full context (step, error, hypotheses, theory, upstream refs). The 4-hour figure is a *lower bound*, not an upper — actively-progressing work continues past it.
- **Alternatives:** Hard time limit (contradicts "don't care about build time"); attempt-count only.
- **Chosen because:** Makes "reasonable debugging effort" operational without creating artificial pressure.
- **Trade-offs:** Judgment-based, requires clear justification in each blocked entry.
- **Rollback:** N/A.

### DD-5: zkEmail-port fork strategy — vendored clone, strip `.git`
- **Decision:** For candidates C and D, `zkemail/sp1-zkEmail` and `boundless-xyz/r0-zkEmail` are cloned into the candidate folder with `.git` stripped, becoming vendored source inside the public kysigned repo. Attribution in each candidate's `VENDOR.md` (upstream URL, commit hash, license, vendor date).
- **Alternatives:** Git submodule (fragile), NPM package (doesn't exist), HTTP fetch-at-build-time (not reproducible).
- **Chosen because:** Forkers clone kysigned and get everything — no external fetches.
- **Trade-offs:** Larger kysigned repo size; upstream updates require manual re-vendoring.
- **Rollback:** Delete the candidate folder.

### DD-6: Parallel builds via 4 git worktrees of the public kysigned repo
- **Decision:** Four git worktrees of the public kysigned repo, one per candidate, each on its own feature branch forked from `main`:

  | Worktree path | Branch | Candidate | Sub-plan |
  |---|---|---|---|
  | `C:\Workspace-Kychee\kysigned-zkprover-A\` | `zkprover-A` | A — snarkjs retry | `zkprover-A-plan.md` |
  | `C:\Workspace-Kychee\kysigned-zkprover-B\` | `zkprover-B` | B — TACEO co-snarks | `zkprover-B-plan.md` |
  | `C:\Workspace-Kychee\kysigned-zkprover-C\` | `zkprover-C` | C — SP1 zkVM | `zkprover-C-plan.md` |
  | `C:\Workspace-Kychee\kysigned-zkprover-D\` | `zkprover-D` | D — RISC Zero zkVM | `zkprover-D-plan.md` |

  Implementation across candidates proceeds in parallel — no sequential gating. Self-containment (spec F1.2) means branches never conflict when merged back to main.
- **Alternatives:** Sequential builds; single branch with subfolders (can't parallelize); four forked repos (overkill).
- **Chosen because:** User directive, self-containment makes merging trivial.
- **Trade-offs:** 4 worktree paths to manage; context-switching overhead.
- **Rollback:** `git worktree remove <path>` + `git branch -D <branch>` for each.

### DD-7: Comparison matrix is a dedicated Phase 2 task, post-all-candidates
- **Decision:** The comparison matrix (spec F4) is written in a single Phase 2 task AFTER all four sub-plans reach terminal state. Not written incrementally.
- **Alternatives:** Incremental per-candidate matrix updates.
- **Chosen because:** One authoritative matrix write is cleaner.
- **Trade-offs:** User waits for all four before seeing matrix; sees per-candidate `measurements.md` in real time.
- **Rollback:** N/A.

### DD-8: Archival in v0.1.0 is DOCUMENTED, not PERFORMED
- **Decision:** For each candidate, the archival artifact list is documented in the candidate's README and matrix. **Physical archive creation** (tarballs, Docker images, vendored crates via `cargo vendor`) is NOT a v0.1.0 deliverable — it becomes a post-winner task.
- **Alternatives:** Full archival in v0.1.0 (overkill).
- **Chosen because:** Archival discipline matters, but physical archives for four candidates is wasted work when three will be deleted.
- **Trade-offs:** Physical reproducibility deferred; not a production risk at this stage.
- **Rollback:** N/A.

### DD-9: Winner DD requires explicit user approval
- **Decision:** Phase 3 is NOT self-executing. The comparison matrix is presented to the user, the user picks the winner(s) and provides rationale, the DD is written citing specific matrix cells, the user explicitly approves before the plan is marked complete.
- **Alternatives:** Auto-select highest-scoring candidate.
- **Chosen because:** User explicitly said the choice is their call.
- **Trade-offs:** Plan requires user interaction at Phase 3.
- **Rollback:** N/A.

### DD-10: No Ship & Verify phase — internal-only per spec
- **Decision:** The spec declares v0.1.0 "internal only — no external surface." No Phase 4 "Ship & Verify," no `[ship]` tasks. v0.2.0 is a separate spec/plan that adds shipping surfaces once a winner is known.
- **Alternatives:** Speculative ship phase (violates "measure before ship").
- **Chosen because:** Follows spec exactly.
- **Trade-offs:** v0.1.0's output isn't "reachable by a fresh user"; matches spec characterization.
- **Rollback:** N/A.

### DD-11: Master/sub-plan split for parallel candidate execution
- **Decision:** The zkprover implementation is split across one master plan (this file) for shared prerequisites/matrix/decision work, and four sub-plans (`zkprover-A-plan.md`, etc.) each containing only its candidate's tasks. Each sub-plan runs in its own worktree via a separate Claude Code instance executing `/implement zkprover-<letter>`. No cross-instance coordination is required during Phase 1.
- **Alternatives:** Single monolithic plan (can only be executed sequentially by one instance); four completely independent plans with duplicated Phase 0/2/3 (messy duplication and inconsistency risk).
- **Chosen because:** Enables the user's "run in 4 instances in parallel" workflow directly, while keeping shared setup and shared decision work in one authoritative place.
- **Trade-offs:** Five plan files instead of one; cross-references between master and sub-plans need maintenance. Phase 2's gate check must validate terminal state across all four sub-plans before proceeding.
- **Rollback:** Merge sub-plan content back into the master if parallel execution creates more friction than it saves.

---

## Tasks

### Phase 0: Prerequisites `AI`

Shared setup run once on `main` before any sub-plan starts. Must complete before any of the four candidate sub-plans can execute.

- [x] **P0.1a** Create git worktree A: `git worktree add C:\Workspace-Kychee\kysigned-zkprover-A -b zkprover-A` from `main`. Confirm the worktree path exists and the new branch is checked out there. [infra] `AI`
- [x] **P0.1b** Create git worktree B: `git worktree add C:\Workspace-Kychee\kysigned-zkprover-B -b zkprover-B` from `main`. [infra] `AI`
- [x] **P0.1c** Create git worktree C: `git worktree add C:\Workspace-Kychee\kysigned-zkprover-C -b zkprover-C` from `main`. [infra] `AI`
- [x] **P0.1d** Create git worktree D: `git worktree add C:\Workspace-Kychee\kysigned-zkprover-D -b zkprover-D` from `main`. [infra] `AI`
- [x] **P0.1e** Verify all 4 worktrees exist and are on independent branches: `git worktree list` shows all four paths, `git branch -a` shows all four `zkprover-*` branches pointing at the same base commit but tracked independently. [infra] `AI`
- [x] **P0.2** On `main` (public kysigned repo), create `kysigned/zkprover-candidates/` folder with a top-level `README.md` describing the four-candidate comparison and its purpose (links to this plan + spec), and a `shared/` subfolder that will hold the test input. Initial `shared/.gitkeep` so the folder exists before P0.3. [code] `AI`
- [x] **P0.3** Acquire shared test input — Barry sent real email from `volinskey@gmail.com` to `barry@kychee.com` with body = `I APPROVE` and subject = `[kysigned] env_zkprover_test_20260411 doc_a1b2c3d4e5f60708091a2b3c4d5e6f708192a3b4c5d6e7f80910a1b2c3d4e5f6`. Raw MIME pasted into the implementation session, CRLF-normalized via Python, saved to `kysigned/zkprover-candidates/shared/test-input.eml` (6964 bytes). [manual] `HUMAN`
- [x] **P0.4** Verified shared test input: DKIM signature `True` via `dkimpy` 1.1.8. Body contains `I APPROVE` at body offset 77 (multipart/alternative, text/plain section). Subject is in the DKIM `h=` signed-headers list (F2.3 spec requirement — subject is cryptographically DKIM-bound). Provider: Gmail, `d=gmail.com`, selector `s=20251104`, canonicalization `relaxed/relaxed`, algorithm `rsa-sha256`, body size 238 bytes (23% of `maxBodyLength=1024` capacity). All details documented in `kysigned/zkprover-candidates/shared/README.md`. [code] `AI`
- [x] **P0.5** Verify Base Sepolia wallet. **Wallet chosen: `agentdb/faucet-treasury-key` → `0x1D93e3bDb66541Da5182a430A857b371Bc1DE17E`** (the shared run402 platform wallet per kysigned DD-3 — canonical for all Kychee on-chain ops, testnet and mainnet). **Current balance: 0.0378 ETH on Base Sepolia** (0 on mainnet — irrelevant for v0.1.0 which only uses testnet). Sufficient for ~38× the estimated 0.001 ETH needed for 4 verifier deploys + 4 `verifyProof` calls. RPC: `https://sepolia.base.org` (via `run402/base-sepolia-rpc-url` secret). Alternate `kysigned/ops-wallet-key` → `0x8D671Cd12ecf69e0B049a6B55c5b318097b4bc35` has 0 ETH and is NOT used by this plan. [infra] `AI`
- [x] **P0.6** Prepare shared AWS environment. **Confirmed:** AWS profile `kychee` active (account `472210437512`, role AdministratorAccess), region `us-east-1`, `EC2SSMInstanceProfile` + `EC2SSMRole` already exist (from prior 1R.3 work), default VPC `vpc-02ec599c426f66c57`, default subnet in `us-east-1b` (`subnet-0876573eefcee737f`), default SG `sg-050db8b9a042cbeed`, latest Ubuntu 24.04 LTS AMI `ami-009d9173b44d0482b`. Tagging convention: `Name=kysigned-zkprover-<letter>`, `Purpose=kysigned-zkprover-<letter>`, `AutoCleanup=true`, `Owner=barry` per candidate. Instance type default: `r5.4xlarge` on-demand (16 vCPU, 128 GB RAM). Spend cap per DD-3: $15 per candidate, $50 total. [infra] `AI`
- [x] **P0.7** Fast-forwarded all 4 feature branches to `main`'s post-Phase-0 state (commit `67cc6d0`). `git merge --ff-only main` ran successfully in each worktree. All four branches now contain `zkprover-candidates/` + `shared/test-input.eml` + `shared/README.md`. Pushed to origin: `zkprover-A`, `zkprover-B`, `zkprover-C`, `zkprover-D`. [infra] `AI`
- [x] **P0.8** Committed Phase 0 shared artifacts (`zkprover-candidates/{README.md,shared/{.gitkeep,README.md,test-input.eml}}`) to kysigned `main` as commit `67cc6d0`. Pushed to `origin/main`. [infra] `AI`
- [x] **P0.9** Signaled user ready-for-parallel — see final message in the implementation session. [manual] `AI`

### Phase 1: Candidate builds (via sub-plans, parallel)

> **Do NOT execute Phase 1 tasks from this master plan.** All Phase 1 work lives in the sub-plans:
>
> - [zkprover-A-plan.md](zkprover-A-plan.md) — Candidate A (snarkjs PLONK retry)
> - [zkprover-B-plan.md](zkprover-B-plan.md) — Candidate B (TACEO co-snarks)
> - [zkprover-C-plan.md](zkprover-C-plan.md) — Candidate C (SP1 zkVM)
> - [zkprover-D-plan.md](zkprover-D-plan.md) — Candidate D (RISC Zero zkVM)
>
> The master plan's `/implement` session PAUSES at Phase 0.9's signal and does not resume until the user returns with "all four sub-plans are terminal."

- [ ] **P1-GATE** Confirmation gate: all four sub-plans have reached terminal state. For each sub-plan, verify either (a) `Status: Complete` with every task `[x]`, or (b) at least one task `[!]` blocked with full DD-4-compliant context in the sub-plan's Implementation Log. A sub-plan in progress (`[~]` tasks or `Status: In Progress`) means Phase 2 is not yet ready. [manual] `AI`

### Phase 2: Comparison Matrix `AI`

Executed from the master plan after the P1-GATE passes. Aggregates all four sub-plans' `measurements.md` into one authoritative comparison document.

- [ ] **P2.1** Pull the four feature branches back into a unified view by reading each sub-plan's `zkprover-candidates/<letter>-*/measurements.md` from its respective worktree. Do NOT merge the branches into main yet — matrix writing reads from the worktree file systems. [code] `AI`
- [ ] **P2.2** Write `run402/docs/products/zkprover/research/comparison-matrix.md`. Include all ten columns from spec F4.2 (Status, on-chain gas + tier marker 🟢🟡🔴, prover wallclock, peak RAM, proof bytes, trust anchor, attack surface delta, license, production track record, audit status, archival artifact list). One row per candidate. [code] `AI`
- [ ] **P2.3** For every cell in the matrix, add a citation — relative-path link to the source file (`kysigned-zkprover-<letter>/zkprover-candidates/<letter>-*/measurements.md`). Cells with no source are explicitly marked `⚠️ not measured`. [code] `AI`
- [ ] **P2.4** Write the interpretation section at the bottom: strongest candidate per axis, surprising findings flagged in plain English, blocked entries highlighted with root-cause summaries. [code] `AI`
- [ ] **P2.5** Verify matrix against spec F4 acceptance criteria (four rows, all columns present, every non-blocked cell has a value or `⚠️` marker, interpretation section exists). [code] `AI`
- [ ] **P2.6** Commit `comparison-matrix.md` to the run402 repo, push to origin/main. [code] `AI`

### Phase 3: Winner Decision `AI` / `HUMAN`

Requires explicit user approval per DD-9.

- [ ] **P3.1** Present the comparison matrix to the user with a short summary: per-candidate status, gas cost ranking, RAM ranking, attack-surface commentary, any hard-gate failures (🟡 or 🔴 gas tiers, blocked entries). Include my honest read on which candidate appears strongest and why. [manual] `AI`
- [ ] **P3.2** User picks winner (or primary + fallback) and provides rationale. [manual] `HUMAN`
- [ ] **P3.3** Write DD-12 (or next available number) in this master plan naming the winner(s), citing specific comparison-matrix rows/columns as justification. If primary + fallback, document failover conditions. [code] `AI`
- [ ] **P3.4** Document deferred tasks in the winner DD per spec F5.4: (a) DKIM canonicalization review for zkEmail ports if winner is C or D, (b) audit sponsorship for TACEO if winner is B, (c) physical archival (cargo vendor, Docker images, pinned toolchain), (d) run402 platform-extension scope determination (Open Question #5 from spec). [code] `AI`
- [ ] **P3.5** User explicitly reviews and approves the final DD text. No implicit approval. [manual] `HUMAN`
- [ ] **P3.6** Mark master plan `Status: Complete` with today's date. Add final Log entry summarizing: four candidates built, matrix produced, winner named, deferred tasks documented. [code] `AI`
- [ ] **P3.7** Update kysigned's paused 1R.3 task (in `run402/docs/plans/kysigned-plan.md`) with a one-line pointer: "zkprover v0.1.0 complete — winner = candidate X — 1R.3 resumes with <summary of next steps>." [code] `AI`

### Worktree cleanup (conditional, post-Phase 3)

Per DD-8 (archival documented, not performed) and the user's "keep each to a clean sub-product folder so we may chuck the others" directive, the disposition of losing candidates is decided in Phase 3 and executed separately. The master plan does NOT auto-delete worktrees or branches — that's a deliberate user decision recorded in the winner DD.

---

## Implementation Log

_Populated during implementation. Gotchas, deviations, emergent decisions go here._

### Gotchas

_(empty — to be populated during implementation)_

### Deviations

_(empty — to be populated during implementation)_

### AWS Spend Tracking

Running tally. Hard cap: $50 total, $15 per candidate. Escalate to user at breach.

- Phase 0 spend: _(pending)_
- Candidate A spend: _(from zkprover-A-plan.md — tracked in that sub-plan)_
- Candidate B spend: _(from zkprover-B-plan.md)_
- Candidate C spend: _(from zkprover-C-plan.md)_
- Candidate D spend: _(from zkprover-D-plan.md)_
- **Total: $0.00 / $50 budget**

Per-sub-plan spend is tracked in each sub-plan's Implementation Log and rolled up here at Phase 2 matrix-writing time.

---

## Log

- 2026-04-11: Plan created from spec v0.1.0. 11 Design Decisions locked. Master/sub-plan split (DD-11) enables parallel candidate execution across 4 worktrees. Phase 0 has 11 tasks (P0.1a-d split + verify + setup + signal). Phase 2 has 6 tasks. Phase 3 has 7 tasks. Four sub-plans created for candidates A/B/C/D.
- 2026-04-11: **Phase 0 complete.** All 11 tasks `[x]`. Worktrees created at `C:\Workspace-Kychee\kysigned-zkprover-{A,B,C,D}\` on their respective branches. Shared test input captured from `volinskey@gmail.com` → `barry@kychee.com` with canonical Kysigned subject (DKIM verified via dkimpy 1.1.8, subject in `h=`, body offset 77). Wallet `agentdb/faucet-treasury-key` → `0x1D93...DE17E` has 0.0378 ETH on Base Sepolia. AWS env confirmed (kychee profile, us-east-1, r5.4xlarge Ubuntu 24.04 `ami-009d9173b44d0482b`). kysigned `main` at commit `67cc6d0`, all 4 feature branches fast-forwarded and pushed to `origin/zkprover-{A,B,C,D}`. Master plan paused — ready for parallel sub-plan execution in 4 separate Claude Code instances.
