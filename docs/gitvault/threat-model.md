# gitvault — Threat model (protocol `r402s/v0`, rev 42)

**Status:** source of truth for every claim the product makes about itself. The marketing page, the `humans/` pages, the MCP tool descriptions, and the CLI help all derive their claims vocabulary from here (tasks 6.4, 5.11, 5.7). This page copies the protocol's normative language **byte-for-byte** wherever the protocol marks it normative; the anchors are listed at the bottom so a later grep-gate can pin them. Where this page and [protocol-v0.md](protocol-v0.md) ever disagree, the protocol wins and this page is wrong.

The page is written for the reader who wants to know, precisely, what run402 can and cannot do to their source — and who would rather hear a narrow true sentence than a broad comfortable one. That is the posture of the whole product: *the response is part of the contract* ([docs/vision.md](../../../vision.md), Principle #9). A claim we cannot execute is scoped to what we can, never asserted on faith.

**Rev 42 (2026-08-27) activates `transition.kind:"rotate_epoch"`** — epoch rotation + human-recipient key management (change `gitvault-human-envelopes`, D193–D203, closing a three-round `/consult` review: [round 1](../../../consultations/gitvault-epoch-rotation-review-round-1.md) reject-and-redesign → [round 2](../../../consultations/gitvault-epoch-rotation-review-round-2.md) reject-and-redesign → [round 3](../../../consultations/gitvault-epoch-rotation-review-round-3.md) accept-with-changes). Two different things shipped on two different dates and must not be conflated: **multi-recipient envelopes for an existing vault are live in production** (2026-08-26 — a second org member can hold their own confirmed envelope and read history independently of the creator); **the rotation mechanism itself — the thing that makes removing a recipient cryptographic rather than administrative — is not yet operational** (the DB substrate and object-kind schemas have landed; the admission-time fence, routes, and vectors have not). §3 and §4 state exactly what each half means today.

---

## 1. The claims (normative for all copy)

These three sentences are the entire approved claims vocabulary. Copy may shorten them only by omission of a whole clause, never by paraphrase.

> **Claims (normative for all copy):** *"Run402 cannot decrypt your gitvault or repository history. Deployment artifacts remain a disclosed plaintext custody boundary."* · *"Activation requires vault admission by default; an explicit, audited override can bypass it."* · Retention is an **operational promise of the platform, not a cryptographic guarantee against it** (the host controls timestamps and bytes).

Read them as three separate promises with three separate strengths:

1. **Confidentiality of the vault** is a *cryptographic* property against run402 itself. There is no key material server-side, so it is not a policy we follow; it is a capability we do not have.
2. **Push-gated activation** is an *operational platform invariant*. It is enforced by the platform, auditable by the owner, and bypassable only by the owner's own explicit, step-up-authorized override — but it is not cryptographic against the platform.
3. **Retention** (≥90 days of unreachable history) is an *operational promise*. The host can delete bytes and controls the admission clock. We commit to it; we cannot make it impossible for ourselves to break.

The asymmetry is the point. Conflating the three is exactly the failure mode the banned list (§8) exists to prevent.

**Exit-ramp additions (claims gate passed 2026-08-26, Tal; shipped by `gitvault-mirror-and-recover`).** Four further sentences joined the approved vocabulary. The first two are true unconditionally; the last two are conditioned in surrounding copy on the owner having configured the opt-in mirror, and were gate-approved to land only after the live recovery drill passed and the client release shipped (both satisfied):

> *"Your repository ciphertext moves directly between your machine and storage — our servers never handle it."* (Architectural: uploads are create-only presigned PUTs and payload reads presigned GETs; gateway compute touches only heads and admission records, which are declared disclosed metadata — verifiable from network topology.)
>
> *"Every prune requires receipts from two independently built open-source implementations — one in TypeScript, one in Rust."* (Wire-enforced: `implementation_id ∈ {run402-cli, r402s-verify}` is a closed schema set.)
>
> *"If we disappeared tomorrow, your repository is recoverable from a bucket listing and your keys, with an open-source tool. No server required. Provable, not promised."* (Proved by the live drill: a real production vault, mirrored, recovered ref-exact with the gateway unreachable. The keystore qualifier stands — without your keys, mirrored ciphertext recovers nothing.)
>
> *"Your ciphertext replicates to a bucket you own. We can't decrypt your repository history — and we can't hold it either."* (The gate approved "read your code" phrasing here; it is deliberately narrowed to the scoped decrypt form because the unscoped read-claim is §8-banned — the deploy lane holds plaintext artifacts.)

Every recovery/mirror surface also states, verbatim: offline recovery proves **validity, never freshness** (a stale mirror is indistinguishable from a short history), and a mirror **does not alter the V0 terminal-loss posture** — without the principal keystore, mirrored ciphertext recovers nothing.

---

## 2. Trust boundary

Copied verbatim from protocol §0:

> **Trust boundary:** the creator's machine + keystore are trusted. `source.run402.com` and the bucket are untrusted for confidentiality — structurally (no key material server-side). The platform separately, custodially holds plaintext source-artifacts of every deploy in its CAS (deploy lane) — the disclosed boundary; that custodial restore is the support path when every principal envelope is lost. **In V0-A, whole-machine or whole-keystore loss is terminal for vault history** (`VAULT_UNRECOVERABLE`) until `add_envelope` ships; doctor/status state this verbatim. **Rev 42 narrows, but does not close, one instance of this:** losing the CREATOR's specific keystore immediately after an N-recipient genesis (D198) no longer strands other currently-keyed, confirmed founding members — each holds its own epoch-1 envelope in the same admitted genesis object. Every OTHER instance is unchanged: a principal who has never enrolled a key has nothing sealed to it regardless of recipient count (D3's ordinary eventual-custody model, untouched), and simultaneous loss of every birth-time recipient's keystore before any of them ever touches the vault remains `VAULT_UNRECOVERABLE`. The vault protects source history from host-side loss **while a principal keystore survives** — that is the honest durability sentence.

**What this means for a vault today, not just a vault under D198's not-yet-shipped N-recipient genesis (§6):** the same "another confirmed recipient's keystore is an independent opener" logic already holds for the multi-recipient-envelope path that IS shipped — a post-genesis wrap via the reconcile flow, not D198's atomic genesis. A vault holding at least one other confirmed, keyed recipient survives creator-keystore loss; a creator-only vault does not. §6 states this precisely, table form.

Two lanes, two trust positions, and they must never be blurred in copy:

| Lane | What it holds | Who can read it | Why it exists |
|---|---|---|---|
| **Vault lane** (`r402s/v0`) | Encrypted `pack_set`s, signed create-only heads, ref transactions, checkpoint sets, envelopes | Holders of `K_repo` only — the creator's keystore, plus any confirmed non-creator recipient whose envelope has been reconciled (§4) | Source history that survives the machine |
| **Deploy lane** (CAS) | The plaintext source-artifacts of every deploy (`internal.content_objects`, `sites/<dpl>/…`) | The platform, custodially | Serving the deployed app; the custodial restore path |

The deploy lane is not a leak in the vault's design — it is the *disclosed* custody boundary, and it is what makes "cannot decrypt your gitvault or repository history" a narrower sentence than "cannot read your source." The platform can read what you deployed. It cannot read what you did not.

---

## 3. Property table (§0)

Copied verbatim from protocol §0. Every property is stated against a **malicious** control plane plus a malicious bucket — that is the adversary, not a misconfigured one.

| Property | Against malicious control plane + bucket |
|---|---|
| Confidentiality | Cryptographic (client-side encryption; no server keys; all server-comparable digests are keyed) |
| Authenticity | Cryptographic for pinned clients; receipt-anchored for recovering clients |
| Freshness | Pin-relative only; genesis receipt gives authenticity, not suffix freshness |
| Availability / durability / retention timing | Operational promises — the host can delete bytes and controls `admitted_at` |
| Activation policy (push gate) | Operational platform invariant, not cryptographic against the platform |

How to read each row:

- **Confidentiality — cryptographic.** Source payload and repository-history content are ciphertext-only; the substrate retains only enumerated plaintext metadata and holds zero vault keys (D57 / D168 — the scoped form, and the only form this page or any derivative may use). `K_repo` is generated on the client; `k_obj` is derived per object from it; a vault may hold more than one `key_envelope` today — the creator's own (HPKE, §2) plus, where a wrap has run, one per confirmed non-creator recipient (human envelopes, shipped 2026-08-26). No plaintext-derived digest is ever server-comparable un-keyed.
- **Authenticity — cryptographic for pinned clients; receipt-anchored for recovering clients.** A client holding its trust pin verifies every head signature against the registered writer key and every object against its receipt. A client recovering with nothing but the recovery receipt can authenticate *genesis* — and so can detect a substituted vault — but is anchored to the receipt, not to a cryptographic chain it already held.
- **Freshness — pin-relative only.** The host can serve a *stale but authentic* suffix. A pinned client detects regression below its pin (`GENERATION_REGRESSION`); it cannot cryptographically prove it is seeing the newest generation. The genesis receipt says "this is my vault," not "this is all of my vault."
- **Availability / durability / retention timing — operational promises.** See §6. The host can delete bytes and controls `admitted_at`. The protocol makes deletion *attested and two-phase* (§7.3) and makes retention *schedule-relative to storage-commit time* (§7.1), which bounds honest-host mistakes — it does not bound a dishonest host.
- **Activation policy — operational platform invariant.** `gitvault_policy = required` from allocation; activation consumes an `activation_token` that the platform mints only against a capture receipt matching the operation's `capture_id`, canonical plan digest, and snapshot commitment (§6.5). The owner can override it with `gitvault.override_unvaulted` (owner + step-up or explicit emergency grant), and the override is journaled, loud, and advisory-persistent until a matching capture completes it. It is not cryptographic against the platform because the platform is the party enforcing it.

**Client obligations (§0, verbatim):** compare every finalization receipt against the local expected manifest before signing a head over it; read the admitted head back from storage (verify stored-bytes hash) before reporting a push landed or advancing a pin. The properties above hold only for a client that does this; a client that reports "pushed" on a 200 without the read-back has given the host a freshness oracle it was not supposed to have.

**Epoch rotation and post-removal revocation — protocol-approved (rev 42), not yet operational.** The property table above is unchanged by rev 42: it describes what a vault's *content* is protected by, and that has not moved. What rev 42 adds is a SIXTH property this table has never had to state, because until now the platform never issued more than one envelope: what happens to confidentiality *after a recipient is removed*. Verbatim from the round-3 `/consult` "Strict claim boundary" (D193–D202 — the exact scope this fold is entitled to state, no more) — the claim a vault is entitled to make **once it has actually undergone an admitted rev-42 rotation**, never before:

> For a new vault, or a pre-revision vault forced through a first rev-42 rotation, an admitted rotation that is linearized against a frozen recipient and revocation state; binds one immutable, secret-committed attempt; partitions every active principal bijectively into owner-confirmed included principal/key pairs or explicit exclusion classes; seals one independently sampled epoch key to exactly those included keys; and encrypts every carrying-generation object under that key provides post-rotation forward revocation against holders of prior epoch keys who are not included in the new epoch, subject to the selected HPKE, HKDF, HMAC, signature, and AEAD assumptions and absent recipient collusion or endpoint/owner compromise.

> For operator-confirmed mode (the ONLY mode this revision ships), the additional honest boundary is: Ciphertext construction and storage remain confidential against the host only while no host-controlled key has been operator-confirmed into the selected recipient set. Recipient authenticity is operator-confirmed, not host-blind. The owner-signed recipient-authority registry is required before unattended auto-wrap or a host-blind recipient-authenticity claim.

**What is true today, before that rotation exists as an operational mechanism.** The claim above is protocol-approved, not shipped: the admission-time fence, the routes, and the vectors that would let a vault actually perform `rotate_epoch` have not landed (only the DB substrate and the four new object-kind schemas have — task 1.2's first slice). No vault today has undergone a rev-42 rotation, so no vault today is entitled to the claim above. Concretely: **removing a principal — from the org, or by revoking its key — is authorization-backed, not cryptographic.** The gateway stops honoring that principal's credentials (no new heads, ciphertext, or envelopes), but nothing re-keys the vault: a former recipient who already opened `K_repo` from their own envelope, or who retained a copy of already-fetched ciphertext, can still decrypt it, indefinitely, with no cryptographic mechanism to stop them. This is not a defect the confidentiality row above overlooked — the platform never held the key to revoke; a rotation is what invalidates the recipient's own copy, and a rotation is not yet a thing any vault can do. §4's observer matrix states the same fact from the removed recipient's own vantage.

---

## 4. Observer matrix

Protocol §10 is the normative statement of what each observer sees. Copied verbatim:

> The control plane sees vault↔org/project binding, principal identities and access times, object counts/ciphertext sizes/ids, generations + cadence, `base_generation`s, admission times, capture bindings (capture_id + plan digest), policy state, `resource_binding`s (purpose, cycle/attempt ids, reservations), maintenance leases, cutoff tickets, claim sets (checkpoint child ids/hashes/sizes), maintenance stage roots/pages, cycle terminal records, issuance objects (incl. `client_open_id`), and completion cuts (candidate/completion GROUPING by cycle/role/batch — ids, kinds, hashes, sizes, timings; no plaintext content), admission records, and prune intents/completions (delete-set ids/sizes + keyed digests only) — all declared plaintext-structured objects; the bucket operator sees the same minus API context plus S3 access patterns; the network sees endpoints/sizes/timing; **the deploy-lane CAS custodially holds plaintext source-artifacts of every deploy** (the corrected claim's disclosed boundary); local telemetry/crash reporters are scrubbed (no keystore paths, no presigned URLs, no plaintext). No plaintext-derived digest is ever server-comparable un-keyed. Logs/errors/telemetry never contain plaintext source or complete presigned URLs.

The same facts, laid out per observer. "Content" below means source bytes, commit messages, file names, branch names, and any other plaintext inside a `pack_set`, `ref_state`, or checkpoint. "Metadata" means the enumerated plaintext-structured objects of §10 — nothing else.

| Observer | Sees | Does NOT see | Can do |
|---|---|---|---|
| **Platform operator** (run402 staff with control-plane + DB access) | Everything in the §10 list: vault↔org/project binding, principal ids + access times, object counts / ciphertext sizes / ids, generations + cadence, admission times, capture bindings (capture_id + plan digest), policy state, maintenance/prune structure, keyed digests. **Plus the deploy lane's plaintext artifacts of every deploy.** | Vault content. `K_repo`. Commit ids (`gitvault_commit` is printed client-side and never reaches the platform). Any un-keyed plaintext-derived digest. | Delete bytes; stall or misreport `admitted_at`; serve a stale-but-authentic suffix; refuse service. **Cannot** forge a head (no writer key), cannot decrypt, cannot mint an `activation_token` for a capture that was not admitted without leaving an audit trail. |
| **S3 / bucket operator** | The same object set minus API context, plus S3 access patterns (which keys, when, from where). | Everything the platform operator does not see, *plus* the control-plane context (org/project binding, principal ids, policy). | Delete or withhold bytes; observe access timing. Cannot decrypt; cannot forge. |
| **Network** (on-path) | Endpoints, sizes, timing. TLS covers the rest. | Object ids, content, identities beyond what endpoint shape reveals. | Deny or delay. |
| **An org member holding their own confirmed envelope** (reconciled via a wrap — human envelopes, shipped 2026-08-26) | Everything the "reader holding the vault key" row below sees: with their own `key_envelope` sealed and TOFU-pinned to their enrolled X25519 key, they open `K_repo` themselves — chain-verify, decrypt content, read full history, independently of the creator. | Nothing withheld by the cryptography, for the history covered by their envelope. | Decrypt, read, verify, recover from their own envelope. **Cannot** sign a new head unless separately holding `gitvault.writer` — an envelope grants reading, not writing. Revoking their org membership does **not** revoke this — see the removed-recipient row below. |
| **An org member with no envelope** (never reconciled, or excluded from a wrap; owner/admin membership) | What their capability grants through the control plane: heads listing, the vault record (policy, allocation generation, receipt copy, storage + maintenance state), ciphertext via presigned GET if `gitvault.writer`; may `compact`/`prune`/`repair` (owner; repair with step-up) and manage policy (owner + step-up). | **Content.** No envelope is addressed to them, and `gitvault.read_envelope` is recipient-only. | Run owner maintenance on ciphertext they cannot read; change the activation policy (audited, reason required, doctor-persistent warning while `grandfathered`); override activation with `gitvault.override_unvaulted`. Cannot read history. |
| **A removed recipient** (was an org member holding a confirmed envelope; membership revoked or key revoked) | Nothing new through the control plane — the gateway stops honoring their credentials for this org's routes: no further heads, ciphertext, or envelopes. | Nothing new. | **Can still decrypt anything already opened or retained** — their already-derived `K_repo`, or any ciphertext fetched before removal. Authorization revocation is not key revocation. Only an admitted rev-42 `rotate_epoch` closes this (§3); until one commits for this vault, the gap is open, and it is open for every vault today (no vault has run one yet). |
| **A delegate** (`gitvault.writer` bundle = {read_head, read_ciphertext, upload, publish} — the deploy delegate's scope) | Heads, ciphertext objects, receipts for what it uploads. | Content, unless it is also the principal whose keystore holds `K_repo` (the cold-start agent that created the vault is exactly this case — a delegate *is* the creator there, and reads its own vault). No envelope is issued to a delegate qua delegate. | Push (under the writer key it holds), publish heads. **Never** compact, prune, repair, change policy, or override activation — those are owner (+ step-up) capabilities and a delegate is structurally never an owner. |
| **A reader holding the vault key** (`K_repo` + trust pin — the creator's keystore, or a confirmed non-creator recipient's) | Everything: content, full history, authenticated against the pin. | Nothing withheld by the cryptography. Freshness remains pin-relative even for this reader — the host can still withhold the newest suffix. | Decrypt, verify, recover from own envelope; push only if also holding the Ed25519 signing key (the creator's, in V0-A). This is the reader the confidentiality claim is *for* — no longer only the creator, now that envelopes exist for other confirmed principals. |

Four rows deserve emphasis because they are the ones people get wrong:

- **Human envelopes shipped (2026-08-26) — a second org member CAN now read the vault, if reconciled.** The old V0-A fact ("exactly one envelope, the creator's, always") no longer holds for any vault that has run a wrap. What has NOT shipped is the other half of collaboration: removing that member does not re-key anything — see the removed-recipient row and §3. Copy may now describe reading as available to a confirmed recipient; copy must not describe removal as revoking their ability to decrypt what they already hold, because it does not, until a rev-42 rotation is operational.
- **A removed recipient is not a revoked key.** The row is deliberately its own line, not a clause tacked onto "org member": removing membership or revoking a key is a control-plane action, and control-plane actions stop future API calls, not past key material. Doctor/status and any collaborator-facing copy must say "revoke access," never "revoke the key" or "they can no longer read the history" — until rotation ships, both of those are false.
- **A delegate can push but cannot delete.** The deploy delegate can advance the vault (that is what deploy-implies-capture needs) but cannot run prune, cannot repair, cannot grandfather the policy, and cannot override activation. Nothing the agent holds can destroy the history it wrote.
- **The platform operator row has two halves.** The first half (metadata) is the vault lane and is the disclosed, enumerated, closed list of §10. The second half (plaintext deploy artifacts) is the deploy lane and is custodial. A reader who only hears the first half has been misled; the corrected claim carries both.

---

## 5. What the platform can see — and cannot

**Can (the plaintext metadata boundary, closed list).** The §10 enumeration above is *exhaustive* for the vault lane. Any plaintext-structured object the platform stores or logs beyond that list is a protocol violation, not an implementation detail. In particular the platform sees: that a vault exists and whose it is; how big it is in ciphertext and how many objects it holds; how often heads are admitted and at what generation; that a capture bound to a given apply-plan digest happened; the policy state and every policy change; the structural skeleton of maintenance (claim sets, stage roots, cycle terminals, prune intents) as ids, sizes, hashes, and timings.

**Cannot.** Vault content of any kind. Branch names, commit messages, file paths, and commit ids (all inside ciphertext; `gitvault_commit` is client-printed). `K_repo`, `k_obj`, or any key material. An un-keyed digest of any plaintext (every server-comparable digest is keyed — `snapshot_oid_hmac` is the canonical example: the platform can check that two captures commit to the *same* snapshot without learning which snapshot). Complete presigned URLs in any log. Keystore paths in any crash report.

**Can, separately, in the deploy lane.** The plaintext of every deployed release — which is every file the owner chose to publish to the world anyway, plus build inputs under `functions`/`site` as declared. This is the custody boundary the corrected claim discloses, and it is also the only recovery net that survives total keystore loss (§6).

---

## 6. Terminal loss

**Scope.** The protocol is exact about which losses are survivable (§5.1, verbatim):

> Partial-loss transitions: repo file lost + identity intact → restore K_repo from own envelope; signing key lost → read-only; stale pin → re-verify from genesis. Whole-keystore loss → `VAULT_UNRECOVERABLE` (§0).

| You lost | Vault history is | Because |
|---|---|---|
| `repos/<repo_id>.json` (K_repo, pins), identity intact | **Recovered** | Your own envelope is addressed to the identity's X25519 key; open it, restore K_repo |
| The Ed25519 signing key, K_repo held | **Readable, read-only** | You can decrypt and verify; you cannot sign a new head |
| Your trust pin only | **Recovered** | Re-verify from genesis against the recovery receipt |
| **The creator's** whole `~/.config/run402/gitvault/` keystore, every copy — **the vault has ≥1 OTHER confirmed, keyed recipient** (a reconciled human envelope, shipped 2026-08-26) | **Recovered, by the other recipient** | That recipient's own envelope is an independent opener — the same mechanism §2's "rev 42 narrows" paragraph states for a D198 genesis, already true today for a post-genesis wrap. It recovers the vault for THEM; it does not hand the creator's identity or signing key back. |
| **Any single principal's** whole keystore, every copy — **that principal is the vault's only keyed recipient** (no wrap has ever run, or every other recipient has also lost theirs) | **Terminal** — `VAULT_UNRECOVERABLE` | No principal envelope survives; run402 holds zero vault keys |
| The whole machine | Same as the row above the recipient count applies to | "Whole-machine" is "whole-keystore" plus everything else |

**The doctor / status sentence.** The client states this verbatim while V0-A is current (client-surface spec, "The recovery receipt authenticates; V0 machine loss is terminal and said so") — unchanged by rev 42, and deliberately not rewritten here even though protocol-v0.md's own §0 now refers to the same gap by the dead-end wire transition name `add_envelope` (D199 retired it from ever activating; the feature it once would have carried shipped through a different, non-wire mechanism instead, task 1.1's own residual note):

> **whole-machine or whole-keystore loss is terminal for vault history until human envelopes ship**

Read literally against the table above, this remains true for a creator-only vault and stops applying the moment a vault has a second confirmed, keyed recipient — the client's own coverage state (`covered_count`/`missing`/`pending_removal`, `services/gitvault/coverage.ts`) already knows the difference; this sentence is the client's blanket doctor line, not a per-vault verdict.

and the error registry entry the client surfaces is (schemas/errors.json, verbatim):

```
VAULT_UNRECOVERABLE  (retryable: false)
next_action: no principal keystore survives; restore deployed artifacts from CAS
```

A sibling entry covers the recoverable-if-you-act case:

```
KEYSTORE_MISSING  (retryable: false)
next_action: restore ~/.config/run402/gitvault from backup or accept vault loss
```

The remaining paths after `VAULT_UNRECOVERABLE` are the platform's custodial restore of deployed artifacts (deploy lane) and org/infra recovery. The client **never implies the receipt can decrypt anything.**

**The recovery receipt's role.** Per §4.9 (verbatim): `recovery_receipt` = creator-signed `{repo_id, org_id, project_id, genesis_sha256, creator fingerprints}` — integrity data; printed + stored locally + copied to the vault record; a recovery without receipt/pin is labeled unauthenticated salvage. And per §5.4: emitted at ACTIVE; not a secret; the more copies the better.

The receipt is an *integrity* anchor, not a *confidentiality* key. It lets a client that still holds `K_repo` (or can restore it from its envelope) confirm the vault it is served is the one it created — a fabricated, internally consistent substitute is refused on genesis-hash mismatch. It does not, and cannot, decrypt. Copy that calls it a "recovery key" is wrong; copy that suggests keeping it secret is also wrong (print it, email it to yourself, put it in the README — the more copies the better).

**Why this is stated so loudly.** A product whose confidentiality rests on "run402 holds zero vault keys" has, by construction, no platform-side rescue for a lost keystore. The honest durability sentence (§0) is **the vault protects source history from host-side loss while a principal keystore survives.** The "while" clause is load-bearing: the keystore qualifier is not a caveat appended to a strong claim, it is the claim. Human envelopes — a second principal with their own envelope — shipped 2026-08-26 as a post-genesis wrap onto an existing vault; a genesis that starts with N confirmed recipients (D198) has not, and remains blocked on the same rev-42 rotation mechanism as the removal half (§3). A vault with no second envelope is exactly where V0-A single-writer coverage always was; a vault that has run a wrap is not, and copy should say so plainly rather than defaulting to the single-envelope framing everywhere.

---

## 7. Retention and durability — operational, not cryptographic

**Retention contract (§7.1, verbatim):**

> Unreachable history (dropped/force-displaced tips) is recoverable for **at least 90 days** from the drop's **`effective_admitted_at`** (§4.10 — storage-commit time, never the pre-I/O `prepared_at`; a delayed record PUT extends the lane, never shortens it; the delayed-PUT case is a virtual-clock vector). Roots expire from `retention_roots` only at the first checkpoint-bearing generation after expiry (§4.5); physical bytes disappear only at the first successful prune after that. History MAY remain longer; conformance tests "recoverable at day 89" (guaranteed) and "a post-expiry checkpoint no longer covers the root, and the subsequent prune removes it" — the calendar-exact day-91 refusal test is replaced by this schedule-relative pair. Retention timing is an operational promise (§0 table).

**What "operational promise" means here.** Against an *honest* host the protocol is strong: the clock is storage-commit time (the host cannot shorten the lane by delaying its own record PUT), expiry is schedule-relative rather than calendar-exact, deletion is two-phase and attested, a prune intent is a stored signed object the owner can audit, and every delete set is receipted. Against a *malicious* host none of that binds: the host controls `admitted_at`, and the host can delete bytes. There is no cryptographic construction by which a storage provider can be prevented from deleting what it stores; the protocol does not pretend otherwise. What the protocol does is make every deletion *attributable* — a prune that was not owner-authorized at the current `gc_epoch` leaves a ledger gap the owner's client can detect (`CHAIN_BROKEN` / `CHAIN_UNUSABLE`), so silent loss is loud loss.

**Durability is keystore-qualified.** The sentence is (§0, verbatim): **The vault protects source history from host-side loss while a principal keystore survives — that is the honest durability sentence.** Two losses compose: host-side loss is what the vault defends against; keystore loss is what the vault cannot defend against. Copy that states the first without the second — in any phrasing — is on the banned list.

**Availability** is likewise operational. `source.run402.com` can be down; the push gate then yields `DEPLOY_BLOCKED_PUSH_FAILED` rather than a silent unvaulted deploy, and the owner's override is the documented escape. Outage is a deploy blocker by design, not a data-loss event.

---

## 8. Never say (banned copy)

The protocol bans specific phrasings. They are listed here **only** so that a derivative surface can be checked against them; none may appear in product copy, help text, tool descriptions, or marketing.

| Banned phrase (verbatim from the protocol's own list) | Why it is banned | Say instead |
|---|---|---|
| "cannot read your source" | Overclaims: the deploy lane custodially holds plaintext artifacts of every deploy. True of the vault lane; false of the platform. | *"Run402 cannot decrypt your gitvault or repository history. Deployment artifacts remain a disclosed plaintext custody boundary."* |
| "no release ever activates unvaulted" | False: an explicit, audited owner override exists (`gitvault.override_unvaulted`), by design. | *"Activation requires vault admission by default; an explicit, audited override can bypass it."* |
| "stops the bleeding" without the keystore qualifier | Implies durability against all loss; V0-A durability holds only while a principal keystore survives. | *"The vault protects source history from host-side loss while a principal keystore survives."* |

The protocol's banned-copy line, verbatim, for pinning: `Banned copy: "cannot read your source", "no release ever activates unvaulted", "stops the bleeding" without the keystore qualifier.`

Two further phrasings are forbidden patterns in the alignment gate (D168) because they are the *unqualified* forms of the confidentiality claim: the bare "stores ciphertext only" copy and the unscoped "storage with receipts" phrase. The only permitted form is the scoped one — *source payload and repository-history content are ciphertext-only; the substrate retains only enumerated plaintext metadata and holds zero vault keys.* Derivative copy reuses that sentence or omits the topic.

The strategy document's own claim gate ([strategy-synthesis.md §11.4](strategy-synthesis.md)) is stricter still: the unconditional campaign claim waits on key epochs, collaborator removal, independent cryptographic review, and more — none of which V0-A ships. This threat-model page is a prerequisite for that gate, not a satisfaction of it.

---

## 9. The standalone shape (D183)

A vault-only project is first-class. Verbatim from the decision log:

> **D183** Standalone gitvault (task 1.5, Tal 2026-08-21): a vault-only project — `run402 init` → `git push run402 …` via `git-remote-run402`, then compact/prune/verify, and NEVER a deploy — is a supported first-class shape, not a degraded one. Nothing in allocation, admission, retention, or maintenance requires a deployment, an apply operation, or a release to exist (deploy-implies-capture constrains deploys, never the vault); `run402 doctor`/status stay truthful for such a project (no deploy-related warning, the V0 terminal-loss statement unchanged); billing is the ordinary org-pooled tier `storage_bytes` through the `source_bytes` counter — no vault-only tier in V0. Out of scope: self-hosting the control plane — V0 is host-blind, not host-less.

For the threat model this matters in one way: **a vault-only project has no deploy lane.** The "disclosed plaintext custody boundary" of the corrected claim is then *empty* — there are no deployed artifacts for the platform to hold in plaintext, and consequently there is **no custodial restore path** after `VAULT_UNRECOVERABLE`. The standalone shape is the purest form of the product and also the one where the keystore qualifier bites hardest for a creator-only vault. Doctor says the same terminal-loss sentence; for a vault with no other confirmed recipient it is simply more final — §6's other-recipient recovery path applies here exactly as it does to a deployed project, since D183 changes nothing about who holds envelopes.

"Host-blind, not host-less" is the other boundary: run402 still runs the control plane, still sees the §10 metadata, still makes the operational promises of §7, and still cannot be removed from the availability picture. Nothing in D183 changes a single row of the observer matrix.

---

## 10. What this is not

- **Not zero-knowledge hosting.** The platform learns the §10 metadata — including that the vault exists, whose it is, how it grows, and when it is touched. Only *content* is hidden.
- **Not a backup of your machine.** It is a backup of your *repository history* that survives your machine **only while a principal keystore survives**. Back up `~/.config/run402/gitvault/`.
- **Not deletion-proof storage.** Retention and durability are operational promises (§7). Deletion is attested and two-phase so that it is *attributable*, not so that it is *impossible*.
- **Not a guarantee that you see the newest history.** Freshness is pin-relative. A pinned client detects rollback below its pin; no client can cryptographically prove the host is not withholding a newer suffix.
- **Not fully collaborator-ready yet — half shipped, half protocol-approved.** Human envelopes (a confirmed org member reading independently of the creator) shipped 2026-08-26; a genesis that starts with N recipients (D198) and a working `rotate_epoch` that makes removal cryptographic (D193–D202) are both rev-42 protocol decisions, neither yet operational. Read a former recipient's access as revoked-from-the-platform, not revoked-from-what-they-hold, until rotation ships (§3, §4).
- **Not a statement about deployed artifacts.** What you deploy, the platform holds in plaintext, custodially, and says so. The vault claim is about the repository, not the release.
- **Not independently reviewed yet.** Thirty-six adversarial design-review rounds are folded into the rev-41 freeze, plus a further three-round `/consult` review (reject-and-redesign twice, then accept-with-changes) folded into rev 42's epoch-rotation activation, D193–D203. The strategy document's campaign-claim gate (§11.4) requires independent cryptographic review before the unconditional claim may be used anywhere. Until then, this page's vocabulary is the ceiling.
- **Not self-hostable.** Host-blind, not host-less (D183).

---

## Verbatim anchors

Every block marked verbatim above is copied byte-for-byte from the source named here. A grep-gate may pin each one against its source; if a source sentence changes, this page must change in the same commit.

| This page | Source | Anchor text (first words) |
|---|---|---|
| §1 — the three claims | `protocol-v0.md` line 5, **Claims (normative for all copy)** | `**Claims (normative for all copy):** *"Run402 cannot decrypt your gitvault or repository history. …` |
| §2 — trust boundary paragraph | `protocol-v0.md` §0, **Trust boundary** | `**Trust boundary:** the creator's machine + keystore are trusted. …` |
| §3 — property table (5 rows) | `protocol-v0.md` §0, the `| Property | Against malicious control plane + bucket |` table | `| Confidentiality | Cryptographic (client-side encryption; …` |
| §3 — client obligations | `protocol-v0.md` §0, **Client obligations** | `compare every finalization receipt against the local expected manifest …` |
| §3 — epoch-rotation confidentiality/revocation claim (2 paragraphs) | `protocol-v0.md` §0, **Epoch-rotation confidentiality and revocation claim** (rev 42, D193–D202; sourced verbatim from `docs/consultations/gitvault-epoch-rotation-review-round-3.md`, **Strict claim boundary**) | `For a new vault, or a pre-revision vault forced through a first rev-42 rotation, an admitted rotation …` / `For operator-confirmed mode (the ONLY mode this revision ships), the additional honest boundary is: …` |
| §3 / §8 — scoped confidentiality sentence | `protocol-v0.md` D57 (rev 26 scoping), D168 | `source payload and repository-history content are ciphertext-only, the substrate retains only enumerated plaintext metadata and holds zero vault keys` |
| §4 — observer matrix paragraph | `protocol-v0.md` §10 **Metadata disclosure (observer matrix)** | `The control plane sees vault↔org/project binding, …` |
| §4 — authorization matrix facts | `protocol-v0.md` §9.1 | **`gitvault.writer`** bundle = {read_head, read_ciphertext, upload, publish} (the deploy delegate's scope) |
| §6 — partial-loss transitions | `protocol-v0.md` §5.1 **Keystore** | `Partial-loss transitions: repo file lost + identity intact → restore K_repo from own envelope; …` |
| §6 — doctor/status sentence | `openspec/changes/add-gitvault/specs/gitvault-client-surface/spec.md`, requirement "The recovery receipt authenticates; V0 machine loss is terminal and said so" | `whole-machine or whole-keystore loss is terminal for vault history until human envelopes ship` |
| §6 — `VAULT_UNRECOVERABLE` next_action | `schemas/errors.json` | `no principal keystore survives; restore deployed artifacts from CAS` |
| §6 — `KEYSTORE_MISSING` next_action | `schemas/errors.json` | `restore ~/.config/run402/gitvault from backup or accept vault loss` |
| §6 — recovery receipt definition | `protocol-v0.md` §4.9 + §5.4 | `recovery_receipt = creator-signed {repo_id, org_id, project_id, genesis_sha256, creator fingerprints} — integrity data; …` / `emitted at ACTIVE; not a secret; the more copies the better.` |
| §6 / §7 — keystore-qualified durability sentence | `protocol-v0.md` §0 (last sentence of Trust boundary); D57 | `The vault protects source history from host-side loss **while a principal keystore survives** — that is the honest durability sentence.` |
| §7 — retention contract | `protocol-v0.md` §7.1 **Contract — at least 90 days**; D51 | `Unreachable history (dropped/force-displaced tips) is recoverable for **at least 90 days** from the drop's **`effective_admitted_at`** …` |
| §7 — retention = operational promise | `protocol-v0.md` line 5 (Claims) + §0 table row | `operational promise of the platform, not a cryptographic guarantee against it` |
| §8 — banned-copy list | `protocol-v0.md` line 5, **Banned copy:** | `Banned copy: "cannot read your source", "no release ever activates unvaulted", "stops the bleeding" without the keystore qualifier.` |
| §8 — D168 forbidden unqualified forms | `protocol-v0.md` D168 | `The unqualified forms (the bare stores-ciphertext-only copy and the unscoped storage-with-receipts phrase) are forbidden patterns.` |
| §9 — standalone shape | `protocol-v0.md` D183 | `**D183** Standalone gitvault (task 1.5, Tal 2026-08-21): a vault-only project — …` |

Protocol revision pinned by this page: **rev 42**. Observer-matrix disclosure as a decision: D29. Claims / copy correction lineage: D57 → D168 → D170 (the gate pins the full confidentiality invariant on D57). Epoch-rotation decision lineage (rev 42, protocol-approved, not yet operational — §3, §4): D193 (activation + mandatory migration flag) → D194 (fence-frozen watermarks) → D195 (secret-committed attempt identity) → D196 (pair-level H-partition) → D197 (receipted pin manifest) → D198 (N-recipient genesis) → D199 (urgent/elective reason taxonomy) → D200 (per-recipient one-key self-check) → D201 (reaper narrowing) → D202 (full-history-on-join liveness) → D203 (exactness/referential closure, retiring the earlier draft's self-contradictory "ABSOLUTE" confidentiality wording).
