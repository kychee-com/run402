# ZK-Email Rust Ecosystem Survey

**Date:** 2026-04-15
**Author:** Compiled via web research (WebSearch + WebFetch against GitHub, zk.email docs, Veridise, eprint.iacr.org, crates.io). **Not a live consult** — no human expert was interviewed; findings reflect what is publicly discoverable as of today.
**Context:** Kychee / kysigned currently pins `cfdkim` at `github.com/risc0-labs/dkim@3213315e` (which redirects to abandoned `boundless-xyz/dkim`). A GPT-5.4 Pro audit flagged 8 soundness issues. We need to know whether to migrate, and to what.

---

## 1. Rust DKIM libraries relevant to zkVM verification

| Library | Repo | zkVM target | Maintainer | Last commit | Stars | Audit | Notes |
|---|---|---|---|---|---|---|---|
| **zkemail/cfdkim** | `github.com/zkemail/cfdkim` | RISC Zero, SP1, generic Rust zkVM | ZK Email / PSE | 2025-06-25 | 1 (low because recently detached fork) | Not independently audited as of 2026-04 | Direct successor to the abandoned `boundless-xyz/dkim` we pin. `no_std`-friendlier: public-key bytes constructors, DNS/expiration gated behind features (added April–June 2025). Recent commits are correctness/soundness-adjacent: email normalization, invalid line endings, relaxed header canonicalization. |
| **boundless-xyz/dkim** (our current) | `github.com/boundless-xyz/dkim@3213315e` | RISC Zero | Boundless / risc0-labs | Abandoned (~2024) | — | None | Upstream of zkemail/cfdkim. No longer maintained. |
| **SoraSuegami/dkim** | `github.com/SoraSuegami/dkim` | generic (originally Circom/halo2 companion) | Sora Suegami | Stale | — | None | Original ancestor of cfdkim (pre-Cloudflare rename). Historical only. |
| **cloudflare/dkim** | `github.com/cloudflare/dkim` | none (server use) | Cloudflare | Stale | — | Not public | Original `cfdkim` crate upstream. Not zkVM-oriented. |
| **stalwartlabs/mail-auth** | `github.com/stalwartlabs/mail-auth` | not zkVM-suitable in current form | Stalwart Labs | 2026-04-13 (v0.8.0) | 120 | Not public | Production-grade DKIM/ARC/SPF/DMARC. Uses async DNS, heavy dep tree — not viable in RISC Zero guest without heavy surgery. Could be a reference for RFC correctness. |
| **Mubelotix/dkim** | `github.com/Mubelotix/dkim` | generic | — | Archived 2024-04-02 | 11 | None | Abandoned, not production. |
| **dkim-milter / mini-mail-auth / dkimdo** | crates.io | none | various | active | low | None | Server/milter focused; not zkVM candidates. |

**Bottom line:** the only actively-maintained DKIM crate built *for* zkVM constraints is **zkemail/cfdkim**. Everything else is either abandoned, targets servers with async I/O, or is the ancestor we're already on.

---

## 2. Ports of `@zk-email/circuits` to Rust

- **zkemail/zkemail.rs** (`github.com/zkemail/zkemail.rs`) — THE canonical Rust port. 9 stars, last commit 2025-11-03, active dependabot + feature PRs. Two crates: `zkemail_core` (DKIM validation, regex, circuit primitives) and `zkemail_helpers` (input generation, DNS, config). Depends on `cfdkim` (git, `default-features = false`) plus `rsa 0.9`, `sha2 0.10`, `regex-automata 0.4.8`. Explicitly a "monorepo … using different ZkVM solutions."
- **No other public port.** No independent rewrite, no academic PoC, no "porting zk-email to Rust" blog post surfaced. The zkemail team considers `zkemail.rs` the implementation path.

---

## 3. SP1-zkEmail status

- **Repo:** `github.com/zkemail/sp1-zkEmail` (lives under `zkemail`, not `succinctlabs`).
- **Metrics:** 8 stars, 1 fork, 0 open issues, 21 commits, MIT, 93.5% Rust.
- **Dependencies (Cargo.toml):** `sp1-zkvm / sp1-sdk / sp1-helper = 4.0.0`; `zkemail-core` and `zkemail-helpers` pulled directly from `github.com/zkemail/zkemail.rs`. It does **not** depend on `cfdkim` directly — it goes through `zkemail.rs`, which in turn uses `cfdkim`.
- **Audit:** none published specifically for sp1-zkEmail.
- **Positioning:** the ZK Email team's own stated preference for **server-side** proving is SP1 over RISC Zero, citing RISC Zero polling quirks (~10s slowdown) and weaker precompiles. Latest benchmarks still put SP1 at ~2–3× slower than circom for RSA/SHA and ~10× slower for regex, but improving.

---

## 4. Academic / research papers

Nothing DKIM-in-ZK-specific, but relevant adjacent work:

- **Chaliasos et al., "SoK: What Don't We Know? Understanding Security Vulnerabilities in SNARKs"** (arXiv 2402.15293, 2024). Taxonomy of SNARK bugs: 95 studied circuit vulns, most caused by under-constraint — exactly the soundness-issue class our GPT-5.4 audit flagged.
- **"Towards Fuzzing Zero-Knowledge Proof Circuits"** (arXiv 2504.14881 / Chaliasos et al., 2025). Credits Aayush Gupta (zkemail) for help with zk-regex bugs. Shows fuzzing surfaces circuit issues that manual review misses — relevant if we want to harden our guest.
- **No formal-verification paper on DKIM implementations** (zk or otherwise) found.
- **No CVE-tracked vulnerability on `cfdkim` or `zkemail.rs`.** The GPT-5.4 findings are not publicly disclosed, and nothing in the zkemail issue tracker duplicates them.

---

## 5. Blog posts / articles

- **Aayush Gupta, "ZK Email"** — `blog.aayushg.com/zkemail/`. Conceptual overview (DKIM + arbitrary-length SHA256 + DFA regex). Does NOT discuss Rust/SP1/RISC Zero tradeoffs.
- **zk.email blog, "Account Recovery Audits Complete" (2024-12)** — `zk.email/blog/audits`. Ships production audits for the Circom stack; notes the Noir + Rust/SP1/RISC0 paths are newer, unaudited at that time.
- **Veridise, "Lessons from the auditing trenches: What do ZK developers get wrong?"** (Medium). General guidance; Veridise has audited zkemail.nr and other circuits — RSA/SHA precompile issues and body-hash bypass are the recurring finding class.
- **Consensys Diligence, "ZK Email Noir" audit (2024-12)** — `diligence.security/audits/2024/12/zk-email-noir/`. Complementary to Veridise's zkemail.nr audit.
- **docs.zkverify.io zkemail explorer** — SDK-level Groth16 consumption; no Rust-zkVM content.
- **"Making ZK More Human with Aayush from ZK Email"**, Zero Knowledge Podcast #353. Roadmap-level; confirms Circom is the only fully audited surface.

No public write-up mentions the 8 soundness issues we found; no public cfdkim security disclosure exists.

---

## 6. zkemail.org ecosystem status (canonical path, 2026)

From zk.email docs and the zkemail org README:

- **Audited, production-ready today:** Circom `@zk-email/circuits` (zksecurity 2024-05, Matter Labs 2024-10, Zellic 2024-09, Ackee 2024-07, yAcademy 2023). Over 5000 proofs verified on-chain in production via account recovery.
- **Audited, newer:** `zkemail.nr` (Noir) — Veridise 2024-11 (14 issues, 1 high-severity body-hash bypass — since fixed; v2.0.0 shipped 2026-03-03). Consensys Diligence parallel audit 2024-12. Intended for **client-side** proving.
- **Unaudited Rust path:** `zkemail.rs` + `sp1-zkEmail` + `r0-zkEmail` (Boundless's RISC Zero demo, 3 stars, marked "experimental, do not use in production"). Targeted at **server-side** proving of large bodies / attachments.
- **Stated roadmap split:** Noir for client, Circom for small server-side, SP1 for large server-side. RISC Zero is explicitly deprioritized by the zkemail team.

---

## 7. Assessment: ranked alternatives to our pinned `boundless-xyz/dkim@3213315e`

**1. Migrate to `zkemail/cfdkim` (pin a specific commit).** Strongest option.
- Same crate lineage, drop-in-ish replacement.
- Actively maintained by the team that owns the protocol (ZK Email / PSE).
- Has already shipped fixes explicitly targeting our problem class: relaxed header canonicalization, body parsing line-ending edge cases, email normalization, zkVM-friendly public-key constructors, optional DNS/expiration features. These overlap with several of the 8 GPT-5.4 findings.
- Caveat: not independently audited. Pin a commit, diff against our fork, confirm each of our 8 audit findings is closed (open issue upstream for any that aren't), and keep our own guest-side property tests.

**2. Move up one layer: depend on `zkemail/zkemail.rs` instead of cfdkim directly.** Medium-term option.
- This is what the zkemail team themselves do in `sp1-zkEmail`. You get `zkemail_core` abstractions (input gen, DKIM, regex) already wired for zkVM use — less glue code in our guest.
- Still unaudited, but the blast radius of our own code shrinks.
- Aligns us with the upstream path most likely to receive future precompile work and audits.
- Con: heavier dep surface; you inherit `zkemail.rs`'s choices on regex-automata, RSA version, etc.

**3. Keep `boundless-xyz/dkim@3213315e` and fix all 8 issues in-tree.** Defensible only short-term.
- Pro: zero migration risk, full control.
- Con: we become the sole maintainer of a DKIM parser — an adversarial input surface. Every future RFC edge case (DKIM-over-ARC, ed25519-sha256 handling, canonicalization quirks) is on us. We'd diverge further from upstream and lose the community fixes already landed in zkemail/cfdkim.
- Only choose this if migration timeline is a blocker and a hotfix-only path is needed.

**4. Consider `sp1-zkEmail` as an alternate zkVM target.** Strategic, not near-term.
- The zkemail team's own stated preference for server-side proving is SP1; RISC Zero performance is known to be worse for this workload (they call out ~10s polling hiccups and weaker precompiles).
- If kysigned is locked to RISC Zero for other reasons (Boundless marketplace, Bonsai, existing deploy), stay with (1) or (2) and treat SP1 as a future port target, not a now decision.
- If zkVM choice is still open, benchmark both. The precompile gap matters more than DKIM library choice for end-to-end cost.

**5. Adopt `stalwartlabs/mail-auth` as a reference, not a dependency.** Non-option for guest code.
- Best RFC-correct Rust DKIM impl in the wild, but async DNS and dep weight make it unusable inside a zkVM guest. Good to diff against when validating edge cases in our parser.

**Recommendation.** Do #1 now (migrate the pin to a specific zkemail/cfdkim commit, reaudit the 8 findings against it, file upstream issues for whichever remain). Put #2 on the roadmap for a later refactor once our guest stabilizes. Defer #4 until after we have a working RISC Zero build we can benchmark honestly.

---

### Load-bearing file/source pointers

- `github.com/zkemail/cfdkim` — active maintained fork; recent commits listed above.
- `github.com/zkemail/zkemail.rs/blob/main/Cargo.toml` — pulls `cfdkim` from `github.com/zkemail/cfdkim.git`, `default-features = false`.
- `github.com/zkemail/sp1-zkEmail/blob/main/Cargo.toml` — pulls `zkemail-core` + `zkemail-helpers` from `zkemail.rs`, SP1 v4.0.0.
- `github.com/boundless-xyz/r0-zkEmail` — our ecosystem-adjacent RISC Zero demo; 3 stars, "experimental, unaudited, do not use in production."
- `docs.zk.email/audits` — master list of audits (none yet for the Rust path).
- Veridise zkemail.nr audit: `veridise.com/wp-content/uploads/2025/04/VAR_Mach34_241104_zkemail_nr_V2.pdf` — body-hash bypass class is the one to watch for in our own guest.
