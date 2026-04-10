# GPT-5.4 Pro Consultation: kysigned Crypto Architecture Review

**Date:** 2026-04-10
**Status:** Reviewed. Actions taken on privacy fix, circuit hardening, quantum language, privacy tiers. DKIM key provenance concern (points 2, 3, 5) reviewed and **rejected** — our existing non-repudiation model (F4.9: zk proof proves key correctness + key consistency across signatures + blockchain timestamp) stands. See spec v0.9.1 for the formal analysis.

---

Short answer: **promising core**, but there is **one major cryptographic gap** in the current writeup:

> **Without authenticated DKIM key provenance, your zk proof proves “this message verifies under this key,” not “this key was the real DKIM key for that domain at that time.”**

That gap matters a lot for non-repudiation and operator trust.

## Most important findings

1. **DKIM → zk is sound only conditionally**
   - Sound for: “a raw email with these fields validates under this public key.”
   - **Not sufficient** for: “therefore Gmail/Yahoo/etc. signed it,” unless key authenticity is established.

2. **Your no-DNSSEC non-repudiation argument is not cryptographically sound as stated**
   - `EvidenceKeyRegistry` is a **transparency log / availability cache**, not an authenticity oracle.
   - “Consistency across other signatures” is only a **heuristic**, and a weak one.

3. **If `H(email)` is a Groth16 public input, your privacy story breaks**
   - Public inputs are on-chain via calldata/logs, even if not in storage.
   - A stable email hash is a stable pseudonym.

4. **`searchKey = Argon2id(email || docHash)` gives cost-amplification, not strong anonymity**
   - It slows bulk scraping.
   - It does **not** stop targeted deanonymization for a known document or small signer set.

5. **There are several email-semantic attacks you should harden against**
   - Missing `d=`/`From` alignment
   - Missing recipient binding
   - Quoted-text / MIME / HTML body ambiguity
   - Duplicate-header attacks
   - DKIM `l=` partial-body signatures

---

## 1) Is the DKIM-to-zk pipeline cryptographically sound?

### Yes, but only for a narrower claim
What your proof can soundly establish is roughly:

> There exists a raw RFC822 email `m` such that:
> - DKIM verification succeeds under public key `pk`
> - parsed `From = email`
> - signed `Subject` contains `(docHash, envelopeId)`
> - body satisfies approval condition

That is a valid cryptographic statement **if** all of the following are true:

- the circuit parses the **raw message bytes**, not trusted off-circuit parsed fields
- DKIM canonicalization is implemented exactly
- RSA/PKCS#1 v1.5 verification is exact
- the proof binds all on-chain metadata (`docHash`, `envelopeId`, key identity, email commitment) as public inputs
- the Groth16 setup is sound

### Where the gap is
That proof **does not** establish that `pk` was actually the DKIM key for `gmail.com` / `outlook.com` / etc.

A malicious operator can do:

1. generate fake RSA keypair `(sk*, pk*)`
2. craft a fake email:
   - `From: bob@gmail.com`
   - subject includes your `docHash` and `envelopeId`
   - body contains approval text
3. add `DKIM-Signature: d=gmail.com; s=whatever; ...`
4. sign it with `sk*`
5. register `(gmail.com, whatever, pk*)` in `EvidenceKeyRegistry`
6. generate a valid zk proof

Your current proof system would accept that unless there is an authenticated proof that `pk*` was actually published by Gmail.

### Hardening requirements for the circuit
At minimum, I would require:

- **`d=` alignment with `From` domain**
  - otherwise an attacker can sign `From: bob@example.com` with `d=operator.com`
- **recipient binding**
  - prove `To:` includes your reply address, and that `To` is signed in `h=`
  - better: use a **unique per-envelope reply address**
- **reject DKIM `l=`**
  - partial-body DKIM is dangerous
- **reject duplicate critical headers**
  - `From`, `Subject`, `To`, `Date`
- **strict subject grammar**
  - not “contains,” but exact machine-readable pattern
- **strict body grammar**
  - not “contains standalone line somewhere”
  - ideally exact first line or exact whole body
- **MIME restrictions**
  - simplest safe policy: only accept `text/plain`, single-part, ASCII/UTF-8 with a narrow encoding set
- **bind `(d, selector, publicKey)` to the proof**
  - not just the key bytes

---

## 2) Non-repudiation without DNSSEC

## This argument is **not sound** in the strong cryptographic sense

Your current claim:

> zk proof proves key was correct at proof time; on-chain archive + timestamp + consistency across other signatures gives non-repudiation

The problem is that “correct key” here only means:

> the message verifies under that key

It does **not** mean:

> the domain actually published that key in DNS

### Why the current argument fails
`EvidenceKeyRegistry` is permissionless. Anyone can register:

- `domain = gmail.com`
- `selector = fake2025`
- `publicKey = myFakeKey`

The blockchain timestamp then proves only:

> someone registered this claimed key at time T

It does **not** prove:

> Gmail served this key at time T

### Why “consistency across signatures” is only heuristic
This helps a bit socially, but not cryptographically, because:

- **single operator** can fabricate a self-consistent fake history
- **permissionless operators are sybilable**
  - “multiple operators” means nothing unless operator identities are authenticated
- **providers legitimately use multiple selectors / keys concurrently**
  - so multiple keyIds are not automatically suspicious
- **custom domains kill the “all Gmail signatures” argument**
  - for `bob@lawfirm.com`, the relevant DKIM domain is often `lawfirm.com`, not “Google”
- **first signature / low-volume domain** has no corroboration at all

### Best way to think about it
Right now, your registry is a **public transparency log of claimed DKIM keys used in proofs**.

That is useful.

It is **not** a substitute for authenticated key provenance.

### Practical recommendation
Do **not** remove DNSSEC entirely. Use it **when available**, and mark those records as higher-assurance.

For non-DNSSEC domains, use a separate assurance tier, e.g.:

- **Tier A**: DNSSEC-backed key provenance
- **Tier B**: threshold witness/notary attestation of observed DNS
- **Tier C**: operator-archived key only

That would make your claims much more accurate.

---

## 3) Operator trust model

## What a malicious operator can do today

### They can forge signatures
Yes — **under the current no-authenticated-key design**, they can fabricate a fake DKIM key and a fake message and prove it.

That is the biggest issue.

### They can selectively omit signatures
Definitely.

And omission is particularly important because the signer may **not** possess the final wire-image with the DKIM-Signature header in their Sent folder. So they may not be able to independently recreate the evidence.

### They can delay submission
They can receive a valid approval and post it later, unless you enforce timing/deadline rules.

### They can mis-index
If `searchKey` is not cryptographically bound by the proof, they can post a valid proof under the wrong index and make discovery fail.

### They can retain raw email
Your privacy is only public-chain privacy, not privacy from the operator.

## Minimal trust assumption, honestly stated
Today the minimal trust assumption is closer to:

- operator honestly uses the **real** DKIM key for the domain
- operator honestly proves over the **actual** received email
- operator honestly indexes and submits it
- operator does not censor

That is substantially stronger than the current docs imply.

### If you fix key provenance
Then operator trust drops mainly to:

- availability / censorship
- privacy of raw email handling
- timely submission

That is a much better position.

---

## 4) Privacy guarantees

## Not quite as strong as stated

### Critical issue: public `H(email)` breaks privacy
If the circuit exposes `Poseidon(email)` as a **public signal**, then:

- all records by the same signer become linkable
- anyone can dictionary-attack many emails cheaply
- `searchKey` no longer matters much

**Important:** public inputs are public on-chain even if you do not store them in contract storage.

### Fix
If you need an email-derived public signal, make it **document-scoped** or envelope-scoped, e.g.

- `emailCommit = Poseidon(normalizedEmail, docHash, envelopeId, domainSep)`

That preserves verifier checkability without creating a global pseudonym.

---

### `searchKey` does not stop enumeration; it only raises cost
Your statement:

> observer with only an email cannot enumerate signatures because docHash space is 2^256

is misleading because the attacker does **not** search all 2^256 hashes.

They search the finite set of **public docHashes already on-chain**.

So an attacker with only an email can do:

- enumerate all observed docHashes on-chain
- compute `Argon2id(email, docHash_i)` for each
- test for matches

That may still be expensive, but it is **O(number of public docs)**, not `2^256`.

Likewise, with a known document and a small candidate signer list, targeted deanonymization is feasible.

### So the real privacy claim should be
- good resistance to **bulk passive scraping**
- **not** strong anonymity against targeted investigation

### Other privacy leakage
Because `docHash` is public:
- anyone with the document can find all records for that document
- observers can count signers / timing for a document campaign

That may be acceptable, but it should be stated plainly.

---

## 5) Signer repudiation attack

## Your current defense is not sufficient

Bob’s argument:

> “The operator fabricated my signature using a fake DKIM key after the real key rotated.”

is **plausible** under your current design.

### Why “must fake all signatures from that provider” is too strong
This is not generally true because:

- the relevant scope may be a **custom domain**, not Gmail globally
- multiple selectors may coexist
- there may be only one or a few signatures for that domain
- a malicious operator can create a fake self-consistent history
- “multiple operators” is sybilable unless operator identities are anchored

### Edge cases where your defense is especially weak
- first-ever signature for a domain/selector
- small-volume custom domains
- single-operator deployments
- domains with concurrent selectors
- all records coming from one operator ecosystem

### What would make repudiation much harder
- DNSSEC-backed key proof when available
- k-of-n independent DNS witnesses
- reply sent to multiple independent witness inboxes
- authenticated operator/notary identities
- explicit assurance level on each signature record

---

## 6) Attack vectors you should explicitly handle

## High priority
- **DKIM key provenance forgery**  
  Biggest issue.

- **`d=` / `From` misalignment**  
  Must reject or strictly define allowed alignment.

- **Missing recipient binding**  
  Prove the message was sent to your designated reply address.

- **Quoted-text body attack**  
  If your original email says “reply with I APPROVE,” many clients will quote that line.  
  A signer could reply with something else, and your current body rule might still pass.

- **DKIM `l=` partial-body attack**  
  Reject `l=` entirely.

- **Duplicate-header ambiguity**
  - duplicate `Subject`
  - duplicate `From`
  - duplicate `To`

- **Multiple DKIM-Signature headers**
  - define deterministic selection
  - or reject ambiguous cases

- **MIME / HTML / transfer-encoding ambiguity**
  - raw-body substring search is not enough
  - define exactly what body representation is approved

## Medium priority
- **Replay / duplicate submission**
  - add a nullifier based on canonical signed content or message commitment
- **Front-running**
  - mostly a duplicate/DoS issue if nullifier missing
- **Timing semantics**
  - chain time is posting time, not guaranteed send time
- **Groth16 trusted setup**
  - toxic-waste compromise is catastrophic
- **Domain-admin / provider impersonation**
  - especially relevant for custom domains and shared mailboxes

## Claim-level correction
- **Quantum-resistance section is overstated**
  - archived RSA public keys do **not** make RSA non-repudiation post-quantum
  - Groth16 is also not post-quantum
  - chain timestamps help chronology, but not future cryptographic soundness for new forged records

---

## What I would change before calling this a DocuSign replacement

1. **Add authenticated key provenance**
   - DNSSEC when available
   - otherwise threshold DNS witness/notary model

2. **Remove any stable public email hash**
   - use doc/envelope-scoped commitment instead

3. **Harden the email acceptance profile**
   - aligned DKIM only
   - signed `To`
   - unique reply address
   - reject `l=`
   - reject duplicate headers
   - narrow MIME support

4. **Strengthen approval semantics**
   - use exact challenge text, not generic `I APPROVE`
   - ideally exact body or exact first unquoted line

5. **Add replay/nullifier protection**

6. **Be explicit about trust assumptions**
   - operator
   - provider/domain admin
   - SNARK setup

---

## Bottom line

### Can this be a public, privacy-keeping approval system?
**Yes**, with some hardening.

### Can it, in its current no-DNSSEC single-operator form, honestly claim operator-independent cryptographic non-repudiation?
**No.** That is the main unsound claim.

A better current description would be:

> “A publicly verifiable, privacy-preserving evidence system for mailbox-originated approvals, with stronger non-repudiation when DKIM key provenance is independently authenticated.”

If you want, I can next turn this into:
- a **threat model table**
- a **must-pass circuit checklist**
- or a **revised security claims section** you can drop into your docs/contracts.