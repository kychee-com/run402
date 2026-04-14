---
product: kysigned
feature: canary-mainnet-deploy
status: ready
created: 2026-04-08
updated: 2026-04-08
references:
  - type: doc
    path: docs/plans/kysigned-plan.md
    description: Current Phase 13 (mainnet deploy) — target for re-sequencing
  - type: doc
    path: docs/products/kysigned/kysigned-spec.md
    description: kysigned spec v0.6.0 — target for DD-10 addition + Shipping Surfaces row update
  - type: doc
    path: docs/products/saas-factory/saas-factory-spec.md
    description: saas-factory spec — target for new F24 (alongside existing F22 bootstrap + F23 trojan horse)
  - type: doc
    path: C:/Workspace-Kychee/run402/CLAUDE.md
    description: KMS contract wallets section — IAM policy, prepay amount ($1.20), rpc secret rotation
  - type: doc
    path: C:/Workspace-Kychee/kysigned-private/STATUS.md
    description: kysigned-private current state — private repo, runs the deployment glue
---

## Problem / Opportunity

kysigned is about to perform its first mainnet deploy of `SignatureRegistry.sol` on Base. Three compounding risks make the "just deploy it" path unattractive:

1. **Reputational, not financial.** A botched-but-already-verified-on-Basescan contract with kysigned branding is visible forever. A redeploy fixes the software but doesn't remove the embarrassing first contract, which becomes permanent OSINT fodder for competitors and hostile customers framing "they're not serious." The actual cash exposure is rounding error (~$5 of gas), but the reputational exposure is permanent.

2. **kysigned is the first production consumer of run402's KMS-wallet contract-deploy path.** Several operations — the drain endpoint, the recovery address mechanism, the 90-day KMS deletion lifecycle, and the KMS-signs-arbitrary-transaction flow used for every envelope — have **zero production test coverage**. The kysigned plan's Phase 13 "first-exercise watchlist" already acknowledges this. Running these paths for the first time against a live kysigned-branded contract compounds risk #1 with risk #2.

3. **Launch-day compression.** Under the current plan, the first time the full kysigned product (frontend + service + wallet + contract + email + dashboard + verification) operates as an integrated system on mainnet is when real users first land on kysigned.com. This is the worst possible moment to discover integration bugs, because every failure is visible.

The opportunity is to decouple these risks: deploy and operate kysigned in full production mode against an anonymous on-chain backend, iterate until confident, and then "launch" by relabeling rather than deploying. The framing — "dark-launch with anonymous backend, unmask to launch" — generalizes beyond kysigned to any saas-factory product with an irreversible public launch moment.

## Target Audience

Two distinct audiences:

1. **Primary — kysigned operators (Barry, Tal).** They bear the reputational risk of a botched first launch, they're the ones who exercise the canary, and they're the humans who make the final go/no-go call to relabel canary → production.

2. **Secondary — future saas-factory product authors.** Every future Kychee product with an irreversible public launch moment (on-chain address, verified contract, distinctive public identity, first-commit-to-public-repo) benefits from the same discipline. This brainstorm's output makes the pattern a factory-level practice via a new `F24` in `saas-factory-spec.md`.

## Proposed Idea

### The principle

**Run kysigned-private in full production mode against an anonymous on-chain backend (the "canary"), dogfood it until a feature checklist is fully green and a human explicitly approves, then "launch" by flipping two environment variables from canary references to production references — not by deploying new code.**

The launch moment becomes a relabel operation, not a fresh deploy. By the time production users land on kysigned.com, every code path they touch has been exercised in real production use for days or weeks.

### The mechanism (ephemeral canary, byte-identical flip)

Canary lifecycle is a single ritual performed once per launch (and once per future contract change, if kysigned ever needs one):

1. **Provision a fresh canary KMS wallet** under the existing kysigned run402 project. This is separate from the eventual production KMS wallet. Cost: $1.20 prepay + ~$25 ETH float (float is recoverable via drain).

2. **Deploy `SignatureRegistry.sol` to Base mainnet via the canary KMS wallet.** The deployed contract is an ordinary mainnet contract, on Base, functionally identical to what the production deploy will produce. Critical properties:
   - **No Basescan source verification** — the contract is deployed but its source is never submitted to Basescan. Observers see bytecode only.
   - **No kysigned branding in the deploy artifacts** — deployer wallet has no name, no tags referencing kysigned; the contract has no name tag; the deploy transaction carries no identifying metadata.
   - **Bytecode is identical to what the production deploy will produce** — because the canary and production deploys use the same Solidity source. This is a feature, not a coincidence.

3. **Deploy kysigned-private to production for real.** Frontend bundle replaces the placeholder, SES webhooks wired, crons wired — the entire deployment-glue chat (#1 in the current next-phases list) ships. **But the service is configured with canary references**: `KYSIGNED_CONTRACT_ADDRESS=<canary>` and `KYSIGNED_KMS_WALLET=<canary wallet>`. The service is live, at `https://kysigned.run402.com` and `https://kysigned.com`, and running.

4. **Exercise the canary as real users.** Barry and Tal send real envelopes to each other via dashboard, API, and MCP — signing real PDFs, receiving real emails, verifying real documents. Every successful envelope produces a real on-chain recording on the canary contract. The full kysigned feature set is exercised.

5. **Iterate.** Find bugs, fix them, redeploy the service (config change + redeploy, no contract change), keep testing. The canary phase continues until:
   - **Every item on the canary checklist is fully green** (checklist content enumerated in the plan, not the spec — see Open Questions)
   - **Barry and Tal explicitly approve** the flip via a ceremonial go/no-go step. No automatic advancement, no time-boxing, no "if N days have passed assume it's fine."

6. **Provision the production KMS wallet and deploy the production `SignatureRegistry` contract.** Cost: another $1.20 prepay + more ETH float for the production wallet, which will be the long-lived one.

7. **Byte-identical bytecode gate.** Before the flip, compare the runtime bytecode of the canary contract (via `eth_getCode` on the canary address) with the runtime bytecode of the production contract (via `eth_getCode` on the production address). If they differ in anything but the metadata suffix, **abort the flip** and investigate — it means something changed between the two deploys that the canary didn't catch. If they match, proceed.

8. **Flip the service configuration** from canary references to production references. Redeploy kysigned-private (config change only, no application code change). This is the "launch."

9. **Smoke test one envelope on the production contract** end-to-end. Because the service code is unchanged and the contract bytecode is byte-identical, this smoke confirms the address swap itself, not the product. If the smoke passes, kysigned is effectively launched.

10. **Drain the canary wallet back to the ops wallet and schedule KMS key deletion on the canary KMS key.** The canary wallet is retired. The canary CONTRACT remains on Base mainnet forever (smart contracts are immutable), but nothing references it in any kysigned artifact.

11. **Flip the public repo private → public** (Phase 14 orphan-branch squash → single `v1.0.0` commit → force-push → flip). This is the ONLY moment at which any kysigned-branded code becomes publicly visible, and by this point the product has been running in real production use for days or weeks.

### Why "relabel as launch" is safer than "deploy at launch"

- **Launch day has no deploys.** Every line of code has been running in production for the entire canary period. The only thing that changes at launch is two environment variable values.
- **The byte-identical bytecode check is a cryptographic proof that the canary rehearsed the real thing.** If the two bytecodes match, the service code path Barry and Tal already exercised is the exact code path production users will exercise.
- **The drain endpoint gets its first real exercise on the easy path.** Ending every canary session with a drain means run402's drain endpoint is tested reliably, on our schedule, as a scheduled closing step — not "during an incident" as the current watchlist framing implies.
- **The KMS-signs-arbitrary-transaction flow is exercised on mainnet for every canary envelope.** Not just the one-time deploy tx — every single envelope recording during the canary period is a live test of the production signing path.

### Anti-leakage discipline (single control, single moment)

The canary contract address and canary KMS wallet address are the single-point-of-failure secrets. Everything else (bytecode, contract internals, EIP-712 domain separator) is public information on Base mainnet and cannot be hidden. Protecting the address mapping is sufficient.

Because the public repo is:
- **Private throughout the canary phase** — canary references in the private working tree are internal state, not a leak.
- **Squashed to a single `v1.0.0` orphan commit at Phase 14**, immediately before the flip to public — git history is wiped.

...the entire leakage threat model collapses to **one control at one moment**: a pre-squash working-tree scan for the canary address and canary wallet address, run as a new checklist item in Phase 14 immediately before the orphan-branch creation. If the scan hits, **abort the flip**. Fix. Re-scan.

The canary address lives in AWS Secrets Manager under `kysigned/canary-*` namespace, is never committed to any repo (public OR service — the service repo reads the secret at deploy time via environment injection, never from a file), and is mentioned in chat/docs only as "the canary address" (symbolic reference), not as the literal value.

Human discipline covers the residual surfaces (Slack/Telegram chat, shell history, IDE workspace state). One-line "don't paste the canary address into public-facing channels" in the spec. Not enforceable via tooling; relies on normal hygiene.

### Saas-factory generalization

The pattern is genuinely product-agnostic. Any saas-factory product with an irreversible public launch moment benefits from the same discipline. This brainstorm produces a new top-level requirement in `saas-factory-spec.md`:

**F24 — Pre-launch dark-launch with anonymous backend.** Soft enforcement: every saas-factory product SHOULD run a dark-launch canary before any irreversible public launch moment (smart contract, Basescan verification, domain branding, public registry entry, distinctive on-chain identity). Products that opt out must justify why in their own spec — there's no automatic waiver. kysigned becomes the reference implementation, cited at the bottom of F24 the same way F23 cites kysigned's DD-9.

## Key Decisions

1. **Identical bytecode, not different bytecode.** The canary contract compiles from the same Solidity source as the production contract. Anonymization happens at the framing layer (no Basescan source verification, no kysigned branding in deploy artifacts), not the bytecode layer. If the two bytecodes ever differ, that's a SIGNAL that the canary caught something — not a property to engineer away. **Rationale:** identical bytecode is the cryptographic guarantee that the canary rehearsed the real thing. Manufactured differences would undermine the guarantee without meaningfully improving anonymity (bytecode comparison across all Base contracts is real OSINT work regardless).

2. **Adversary model: competitive/hostile-customer OSINT, not nation-state forensics.** The bar is "doesn't show up in casual searches and has a good cover story if found." If someone deliberately investigates and links the canary to kysigned, the framing is "yes, that was our staging deploy — that's why we did it before launch, to find issues without affecting customers." Plausible deniability via labeled-as-test, not via cryptographic obfuscation.

3. **Two separate KMS wallets, not one.** One canary wallet (ephemeral, drained and KMS-deletion-scheduled at session end), one production wallet (long-lived, the address that lives on for every real envelope). Cost: $2.40 prepay total instead of $1.20. The extra $1.20 buys wallet-level separation: the canary and production contracts cannot be linked by a single "Contract Creator" click on Basescan; linking requires deliberate investigation. **Rationale:** Basescan shows the deployer EOA one click away from every contract. Same-wallet = one-click linkable; different-wallet = at least requires real investigation.

4. **Ephemeral canary (provision fresh each session), not long-lived.** Amortizing $1.20 across 1–3 likely canary events over kysigned's lifespan is a rounding-error saving that's not worth the recurring overhead of long-lived canary infrastructure (60-day bump cron, current-canary-address bookkeeping, extra 90-day watchlist item). Ephemeral canary is self-contained: each ritual provisions, exercises, drains, and schedules deletion. **Rationale:** matches expected canary event frequency (1 at launch, maybe 1–2 more over kysigned's lifespan), gives the drain endpoint a reliable exercise home, eliminates all bookkeeping.

5. **Full product soft-launch, not contract-only rehearsal.** The canary is not "exercise the wallet + contract in isolation via raw viem scripts." It is "run kysigned-private in real production mode against anonymous on-chain references — real emails, real PDFs, real signing UX, real dashboard, real verification — and dogfood the entire product until happy." **Rationale:** kysigned is the first production consumer of the KMS-signs-arbitrary-transaction path AND the full product integration is itself untested on mainnet. Both concerns are addressed by the full soft-launch approach with almost the same infrastructure effort — since the service has to be deployed to production anyway as part of the `kysigned-private` chat, routing it at the canary instead of production for an intermediate phase costs essentially nothing beyond the canary wallet itself.

6. **Launch = relabel, not deploy.** The moment of launch is flipping two environment variables (`KYSIGNED_CONTRACT_ADDRESS`, `KYSIGNED_KMS_WALLET`) in kysigned-private's configuration and redeploying the service. No application code changes. The byte-identical bytecode gate is the proof that this is safe. **Rationale:** launch day with deploys is the highest-risk configuration. Launch day with only a config change is the lowest-risk configuration. The canary phase earns the right to this posture.

7. **Exit criterion = checklist + explicit human go/no-go.** The canary phase ends only when (a) every item on a concrete feature checklist is fully green, AND (b) Barry and Tal explicitly approve the flip via a ceremonial go/no-go prompt. No automatic advancement, no time-boxing. The checklist content lives in the plan, not the spec; the principle ("checklist exists and must be fully green before flip is offered") lives in the spec. **Rationale:** keeps the spec stable while allowing the plan to evolve the checklist during implementation. Guarantees the highest-leverage human gate is never accidentally skipped.

8. **Anti-leakage = one control at one moment, not ongoing tooling.** A pre-squash working-tree scan for canary address + canary wallet address, run as a Phase 14 checklist item immediately before the orphan-branch creation. No git hooks, no GitHub Actions during the canary phase, no pre-commit scanning. **Rationale:** the public repo is private throughout canary phase and is squashed to a single commit at Phase 14. Only the final tree matters; history is wiped. One scan is sufficient.

9. **Saas-factory generalization shape = new F24, soft enforcement.** New top-level requirement in `saas-factory-spec.md` titled "Pre-launch dark-launch with anonymous backend." Products with irreversible public launch moments SHOULD adopt it; opt-outs must justify. **Rationale:** this is a genuine factory-level operating principle, deserves visibility equal to F22 (bootstrap) and F23 (trojan horse). Soft enforcement avoids forcing ceremony on products that don't have meaningful irreversibility.

10. **Phase 13 and the kysigned-private deploy merge into one interleaved workflow.** They are no longer independent chats. The service deploy must land first (as a canary-pointed deployment), the canary exercise runs for as long as needed, and the "ship" step of the service deploy is the env var flip. The current plan's separation between Phase 13 (deploy contract) and the "service deploy" chat (deploy frontend+backend) no longer reflects reality. **Rationale:** the canary IS the service running in production; the two can't be decoupled.

## Open Questions

These are deliberately deferred to `/spec` and `/plan` rather than hashed out in brainstorm, because they're concrete technical facts or implementation-level details rather than principle-level decisions.

1. **run402 capability gaps — potential blockers.** Does run402 actually support two KMS wallets provisioned under the same run402 project? Does the `contracts/v1` deploy API return the deployed bytecode for a post-deploy identity check, or do we need a separate `eth_getCode` call? Is there rate-limiting on `provision-wallet` that would bite two back-to-back provision calls? If any of these are missing, they become run402 enhancement tasks that must land before the canary workflow is executable. These are facts to discover by reading the `run402/packages/gateway/src/routes/contracts.ts` source and/or trying the API, not user decisions.

2. **Byte-identical bytecode check: precise mechanism.** Where does the check run (service-repo script? one-liner in the flip ritual checklist? CI gate?). What exactly is compared: local compilation artifact vs. deployed runtime bytecode? Two on-chain runtime bytecodes fetched via `eth_getCode`? How are Solidity metadata suffixes handled (the last ~50 bytes of compiled contract bytecode include a compiler-version hash that can legitimately differ even between two identical-source compilations)? The spec commits to the principle; the plan specifies the mechanism.

3. **Canary checklist contents.** The spec commits to "a concrete checklist exists and all items must be green before the flip is offered." The plan enumerates the items. Candidate items (not binding): end-to-end envelope via dashboard, via API, via MCP; Method A (auto-stamp) and Method B (wallet signing); sequential and parallel signing; verify-by-hash and verify-by-envelope-id; ephemeral PDF retention actually triggers; SES bounce handling; magic-link login (Path 3 if Path 3 is live by canary time); Stripe credit purchase (Path 3); dashboard audit trail correctness; export CSV/JSON; void and remind.

4. **What happens if the byte-identical check fails at flip time?** The principle says "abort the flip." The plan needs to specify: (a) what triggers the investigation, (b) what the remediation path looks like (fix bug → redeploy canary → re-run checklist from scratch? Or from last-passed item?), (c) who decides whether the divergence is material enough to re-run canary or just redeploy production. This is an incident-response-like playbook and belongs in the plan.

5. **Final-smoke semantics on the production contract.** The spec says "one envelope smoke on the production contract after the flip." The plan should specify: which envelope path (dashboard? API? MCP?), which signer (Barry signing to Tal? self-sign?), how long the team waits before declaring success, what rollback looks like if the smoke fails. Minor but launch-critical.

6. **Ongoing anti-leakage for private channels.** The spec has a one-line mention of "don't paste the canary address into public-facing channels." Is there any tooling — e.g., a Slack bot that scans for patterns matching `0x[a-fA-F0-9]{40}` and warns — that's worth the effort, or is this pure human discipline? Deferred because the answer depends on how much channel volume exists and how bad the failure mode actually is.

## Readiness for /spec

- [x] Problem/opportunity clearly defined
- [x] Target audience identified
- [x] Core idea described
- [x] Key assumptions surfaced and challenged
- [x] MVP or simplest version discussed
- [ ] Business model considered (not applicable — this is a launch discipline for an existing product with an existing business model, not a new revenue surface)
- [x] Open questions documented

Status: **ready** — all required items (first 5) are checked. Business model item is not applicable; the idea is a risk-reduction discipline for an existing product's launch, not a new product or revenue line.
