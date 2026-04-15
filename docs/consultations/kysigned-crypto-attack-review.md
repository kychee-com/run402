# Consultation Result

**Model**: gpt-5.4-pro
**Submitted**: 2026-04-15T15:06:17.604738
**Completed**: 2026-04-15T16:08:13.273944
**Status**: completed

---

Line refs below are approximate to the pasted snippets.

Bluntly: **Method A is currently not cryptographically sound for the claim “Alice approved document X.”**  
The biggest problems are not edge-case nits; they are statement/binding failures.

## Executive summary

The 3 worst attack classes I see:

1. **Any valid reply-to-sign proof can be replayed and relabeled as a signature on arbitrary docs/envelopes.**  
   `docHash`, `envelopeId`, `searchKey`, `evidenceKeyId`, `timestamp`, and `nullifier` are all caller-controlled metadata, not bound to the proof.

2. **Even if you fixed the contract binding, the circuit itself does not prove the email was about the document.**  
   `subjectHash` is hardcoded to `0`, and the only body check is “the raw body contains `I APPROVE` somewhere.” That means unrelated emails, quoted text, hidden MIME parts, or “I APPROVE … but not this one” all qualify.

3. **The DKIM-key story is not authenticated.**  
   `EvidenceKeyRegistry` is permissionless, the proof’s `pubkeyHash` is not tied on-chain to `evidenceKeyId`, and I see no proof of DKIM `d=` / selector / DNS authenticity or From-domain alignment. So a malicious actor can fabricate “Gmail” or “victim@example.com” proofs offline.

If you are making public “zero trust / nobody needs to be trusted / operator cannot fabricate” claims, **those claims are false today for Method A**.

---

# Critical findings

## 1) Method A record fields are not bound to the SNARK statement
**Where:**  
- `contracts/SignatureRegistry.sol:100-130`  
- `contracts/IGroth16Verifier.sol:4-15`

**Why this is fatal:**  
`recordReplyToSignSignature()` only checks:

- `evidenceKeyId` exists in the registry
- `nullifier` hasn’t been used
- the Groth16 proof verifies for `_pubSignals`

It does **not** check that the proof says anything about the caller-supplied:

- `searchKey`
- `docHash`
- `envelopeId`
- `evidenceKeyId`
- `timestamp`
- `nullifier`

So these are just metadata chosen at submission time.

### Concrete attack path
Any observer can:

1. Watch a real `recordReplyToSignSignature` tx on Base.
2. Copy `_pA/_pB/_pC/_pubSignals`.
3. Submit a new tx with:
   - fresh `nullifier`
   - arbitrary `docHash`
   - arbitrary `envelopeId`
   - arbitrary `searchKey`
   - arbitrary `timestamp`
   - arbitrary registered `evidenceKeyId`

The verifier still returns true, because the proof is unchanged.

### Impact
- A real proof from one envelope can be relabeled as approval for another.
- A proof from Bob can be indexed under Alice’s `searchKey`.
- A sequencer/mempool observer can **front-run the canonical write** and choose the public metadata first.

### Extra-bad detail
A `nullifier` that is not derived from the proof/witness is **not a nullifier**. It is just a caller-chosen nonce.

Likewise:
- `searchKey` is not a bound search index; it is a caller label.
- `evidenceKeyId` is not bound evidence; it is a caller label.

---

## 2) The verifier ABI says there are only 3 public signals; docHash/envelopeId binding is therefore probably not even externally auditable
**Where:**  
- `contracts/IGroth16Verifier.sol:4-15`
- `circuits/kysigned-approval.circom:28-32, 102-103, 125`

**Why this is a red alert:**  
Your Circom source declares:

- outputs: `pubkeyHash`, `emailCommit`, `subjectHash`, `docHashOut`, `envelopeIdOut`
- public inputs: `docHash`, `envelopeId`

Under standard Circom semantics, `main` outputs are public, and the listed inputs are public too.

But your Solidity verifier interface says:

```solidity
uint[3] calldata _pubSignals
// [0] pubkeyHash
// [1] emailCommit
// [2] subjectHash
```

These two descriptions **cannot both be the live artifact**.

### Why this matters
If the deployed verifier really only has 3 public signals, then `docHash` and `envelopeId` are hidden witness values. In that case:

- the contract cannot bind them to stored fields
- **third parties cannot audit them from calldata either**
- “binding via `emailCommit`” is not independently verifiable

That turns the proof statement into something like:

> there exists some hidden `docHash` and hidden `envelopeId` such that `emailCommit = Poseidon(fromHash, docHash, envelopeId)`

That does **not** prove the stored `docHash`/`envelopeId`.

### Severity note
This is either:
- a **real binding failure**, or
- a **source/deployment mismatch severe enough to break auditability**

Either way: bad.

---

## 3) The circuit does not bind the approval email to the document at all
**Where:**  
- `circuits/kysigned-approval.circom:25-32, 70-103`

**Why this is fatal:**  
The circuit proves:

- DKIM signature valid
- a syntactically valid `From` exists
- a `Subject` exists
- the body contains `I APPROVE` somewhere
- `emailCommit = Poseidon(fromHash, docHash, envelopeId)`

But `docHash` and `envelopeId` are **prover inputs**, not extracted from the email.  
And `subjectHash` is literally hardcoded to `0`.

So the proof does **not** establish that the signer saw, referenced, or approved the target document.

### Concrete attack path
A malicious operator only needs **any** DKIM-valid email from the signer’s mailbox that contains `I APPROVE` somewhere. Then they can choose **any** `docHash` / `envelopeId` in the witness and generate a valid proof.

This remains true **even if you later fix the contract to compare public outputs**, because the circuit itself doesn’t tie the email content to the target doc.

### Impact
This directly kills the trust-model claim that the operator “cannot forge or fabricate.”

The current statement is much closer to:

> “Some DKIM-valid email from this mailbox contained the 9 bytes `I APPROVE` somewhere.”

That is not the same as:

> “The signer approved this specific document/envelope.”

---

## 4) “I APPROVE” anywhere in raw body is semantically broken; quoted text can turn a decline into an approval
**Where:**  
- `circuits/kysigned-approval.circom:80-94`

**Why this is catastrophic:**  
`approvalStartIndex` is prover-controlled. The only requirement is that the 9-byte substring at that index equals `I APPROVE`.

There is **no** requirement that it be:

- in the new reply text
- on the first line
- a standalone token
- unquoted
- outside MIME/HTML noise
- not part of a larger negated sentence

### Concrete attack path
If your invitation email says something like:

> Reply exactly “I APPROVE” to sign

and the signer replies:

> No.

many mail clients will include the original message below. The reply body now contains the quoted phrase `I APPROVE`. The prover points `approvalStartIndex` into the quoted text, and the proof passes.

So a malicious operator can convert **“No”** into **“I APPROVE.”**

Other variants:
- `I APPROVE the previous amendment, not this contract`
- hidden HTML / quoted MIME part
- a signature block or footer containing those bytes
- a forwarded thread containing those bytes

### Impact
This is one of the most embarrassing issues in the whole design.

If your email template itself contains `I APPROVE`, then **any reply at all may be weaponizable**.

---

## 5) Method A does not authenticate mailbox ownership; with current registry design, anyone can fabricate “Gmail” proofs offline
**Where:**  
- `contracts/EvidenceKeyRegistry.sol:18-36`
- `contracts/SignatureRegistry.sol:112-118`
- `circuits/kysigned-approval.circom:54-68`

**Why this is fatal:**  
DKIM by itself does **not** prove the `From` mailbox controls the key. It proves only that some DKIM key signed the message.

Your on-chain system does not authenticate that key against DNS. `EvidenceKeyRegistry.registerEvidenceKey()` is permissionless and accepts arbitrary `(domain, selector, publicKey)` tuples.

### Concrete attack path
An attacker can:

1. Generate an RSA keypair locally.
2. Register it on-chain as:
   - `domain = "gmail.com"`
   - `selector = "whatever"`
   - `publicKey = attacker key`
3. Create a raw email blob:
   - `From: alice@gmail.com`
   - body contains `I APPROVE`
   - `DKIM-Signature: d=gmail.com; s=whatever; ...`
4. Sign that blob with the attacker private key.
5. Generate the SNARK proof.
6. Submit it.

No Gmail mailbox was involved. No Gmail DNS record was involved. No actual SMTP delivery was required.

### Impact
Method A, as written, can be forged by **anyone with a supported RSA keypair**.

Your “outlier vs. thousands of other signatures” defense is not cryptographic. It is social/manual forensics, and an attacker can spam fake signatures too.

---

## 6) `evidenceKeyId` is not bound to the proof’s public key
**Where:**  
- `contracts/SignatureRegistry.sol:112-130`
- `contracts/IGroth16Verifier.sol:11-15`

**Why this is severe:**  
The proof exposes `pubkeyHash` as a public signal.  
The contract checks only that `evidenceKeyId` is registered. It does **not** check that:

- the proof’s `pubkeyHash` matches the registry’s `publicKey`
- the registry’s `domain/selector` match the DKIM header
- the `From` domain aligns with the DKIM signing domain

### Concrete attack path
Use a proof generated with attacker-controlled key material, but point the record at a **real existing Gmail evidenceKeyId**.

The record now looks like it used a genuine Gmail key, even though it did not.

### Impact
This defeats the stated “key-consistency / outlier detection” story even further.

Even if the key registry were curated perfectly, this missing binding still breaks the trust model.

---

# Potentially critical: must inspect these library details immediately

These depend on `@zk-email` / regex circuit internals, which I cannot see from the snippets.

## 7) If bytes beyond `emailHeaderLength` / `emailBodyLength` are not forced to zero, the circuit may be completely unsound
**Where:**  
- `circuits/kysigned-approval.circom:44-57, 70-84`

`EmailVerifier` gets lengths.  
But `fromRegex`, `subjectRegex`, and `RevealSubstring` scan the full fixed arrays.

### What must be checked
Verify that `EmailVerifier` (or another gadget) enforces:

- `emailHeader[i] == 0` for all `i >= emailHeaderLength`
- `emailBody[i] == 0` for all `i >= emailBodyLength`

If not, the prover can put fake:
- `From:` text
- `Subject:` text
- `I APPROVE`

into unused slack space outside the signed email, and the regex/body gadgets may match it.

If unconstrained, this is another **complete break**.

---

## 8) DKIM `l=` tag handling could allow unsigned suffix injection
**Where:**  
- in `@zk-email` `EmailVerifier` implementation, not shown

### What must be checked
Does the library:
- reject DKIM signatures with `l=` entirely, or
- prove that the matched `I APPROVE` lies inside the signed body prefix?

If not, an attacker may append `I APPROVE` after the signed portion.

Given your body check is “substring anywhere,” this would be dangerous.

---

## 9) Duplicate headers / signed-header-instance ambiguity
**Where:**  
- `circuits/kysigned-approval.circom:54-57, 70-73`
- `@zk-email` header parsing, not shown

### What must be checked
For DKIM, duplicate headers and `h=` ordering matter.

Your regex scans the whole raw header block. You need to verify that the `From` / `Subject` instance being matched is the one actually authenticated by DKIM.

Otherwise a prover may exploit:
- duplicate `From:`
- duplicate `Subject:`
- weird folding
- comments/display names that contain email-like substrings

This is especially important for `FromAddrRegex`: test cases like

```text
From: "Alice <alice@gmail.com>" <attacker@attacker.com>
```

If the regex extracts the wrong address-like substring, impersonation gets even easier.

---

# High severity

## 10) `recordCompletion()` is fully forgeable
**Where:**  
- `contracts/SignatureRegistry.sol:170-185`

Anyone can push arbitrary:

- `envelopeId`
- `originalDocHash`
- `finalDocHash`
- `signerCount`

There is no auth, no cross-check, no relationship to actual signatures.

### Attack path
Any EOA calls `recordCompletion(...)` on a target envelope/doc with bogus values.

### Impact
If any verifier/UI says “the chain shows the envelope was completed,” that statement is spoofable.

This directly undermines your “verifier reads blockchain → sees completion” story.

---

## 11) Your official verification flow is not actually independent verification
**Where:**  
- `src/verification/verify.ts` note
- `SignatureRegistry.sol` events at `60-76` do **not** emit the proof/public signals

You note that the frontend verifier does **not** reverify the Groth16 proof locally.

Given the Method A binding problems, that means the verifier is currently trusting the contract write path far more than the docs suggest.

### Two separate problems
1. **State alone is insufficient.** The stored record does not contain the bound proof statement.
2. **Groth16 has setup trust.** If the setup or deployed verifier artifacts are wrong/tainted, the current verifier won’t catch it.

### Also:
Your docs say proof bytes are “carried in event history,” but the event doesn’t emit them. They are in tx calldata, not logs.

### What to check
- exact deployed verifier bytecode
- exact `zkey` / `vkey`
- ceremony provenance
- reproducible build from this source to that verifier

Given the 3-public-signals mismatch, this is especially urgent.

---

## 12) `searchKey` integrity and privacy are unenforced
**Where:**  
- `contracts/SignatureRegistry.sol:100-130`
- trust-model claim 4

### Integrity problem
Because `searchKey` is caller-supplied and not bound to the proof:
- the operator can index Bob’s proof under Alice’s search key
- the operator can make a real signature hard to find by using a random search key
- absence under the expected search key does **not** prove absence of a signature

So the “search” layer is trust-the-submitter.

### Privacy problem
Even if the submitter behaves, `argon2id(email || docHash)` with:
- no secret pepper
- public `docHash`
- likely small candidate signer sets

does **not** give strong privacy against targeted attacks.

A 256 MB / ~1 s KDF is decent against cheap bulk scraping, but not against:
- known signer lists
- company employee directories
- likely address patterns for a domain

So the privacy claim is overstated.

---

## 13) Method B is replayable/pollutable; low-`s` is not checked
**Where:**  
- `contracts/SignatureRegistry.sol:133-167, 206-216`

This is much less bad than Method A, but still real.

### What is true
- A front-runner **cannot rewrite** `envelopeId/documentHash/documentName/signerEmail/timestamp` after the signer signs. Those are inside the signed digest.
- But anyone who sees the signature can **re-submit it forever** because there is no used-digest / used-signature check.

### Also
`ecrecover` is used directly, with no low-`s` enforcement.  
EIP-2 killed high-`s` for **transactions**, not for arbitrary `ecrecover` payloads. So malleable duplicates exist.

### Impact
- duplicate records
- array bloat
- confusing event history
- possible DoS for clients that read all signatures

Malleability is secondary, though: exact replay already works.

---

## 14) `verifyWalletSignature()` is context-blind and can bleed signatures across envelopes
**Where:**  
- `contracts/SignatureRegistry.sol:159-200`

Wallet signatures are stored under `documentHash`, and `verifyWalletSignature(documentHash, expectedSigner)` only checks whether that address ever appears in the array.

It ignores:
- `envelopeId`
- `documentName`
- `signerEmail`
- `timestamp`

### Attack path
If the same document bytes are reused in two envelopes, a signature for envelope A can make `verifyWalletSignature(docHash, signer)` return true when someone really meant envelope B.

### Impact
This is a real verification bug for integrators.

---

# Medium severity

## 15) Wallet method does not prove email ownership; it proves only that a wallet signed a string
**Where:**  
- `contracts/SignatureRegistry.sol:141-167`

`signerEmail` is part of the typed data, but there is no proof the wallet owner controls that mailbox.

So Method B means:

> wallet X attested to the string `signerEmail = "alice@example.com"`

not

> Alice’s mailbox owner signed

That may be fine if clearly documented, but it is not equivalent identity semantics to Method A.

Also:  
`src/signing/engine.ts` appears to store `input.walletAddress` into Postgres without comparing it to the recovered on-chain address. That is an off-chain integrity bug if the UI later trusts DB state.

---

## 16) Reply-to-sign timestamp is untrusted metadata
**Where:**  
- `contracts/SignatureRegistry.sol:100-130`

`timestamp` is caller-supplied and not in the proof.

So the submitter can backdate or future-date the signature record arbitrarily.

For legal/audit purposes, the only trustworthy anchoring is:
- tx inclusion time / block
- or a signed/proved email `Date` header, if you expose it

Right now, the on-chain stored `timestamp` for Method A is not authoritative.

---

## 17) `docHash` as a single field element is under-specified and risky
**Where:**  
- `circuits/kysigned-approval.circom:25-26, 96-103`
- `src/signing/commitment.ts:11-16`

A SHA-256 hash is 256 bits. BN254 field elements are ~254 bits.

If the proof generator feeds a 256-bit SHA-256 directly into a Circom signal, it is typically interpreted modulo the field prime. Then:
- `emailCommit` is binding `docHash mod p`, not the raw bytes32
- two different bytes32 values can map to the same field element
- independent verifiers must reproduce the exact same reduction/encoding

I would not call this a practical second-preimage attack today, but it is a bad design choice. Split the hash into limbs or hash-to-field explicitly.

`uuidToBytes32()` is less worrying because 128 bits fit comfortably, assuming consistent big-endian interpretation everywhere.

---

## 18) `PackBytesFromRegex` truncates at 496 bytes and does not include explicit length
**Where:**  
- `circuits/kysigned-approval.circom:59-68, 106-123`

This may be harmless if `FromAddrRegex.reveal0` is guaranteed to output only the addr-spec and that spec is bounded.

But if the regex can reveal something longer / non-canonical, the tail is ignored.

Also no explicit length is mixed in, so canonicalization must be exact.

I would classify this as a “must test,” not the main break.

---

# Low / trust-model caveats

## 19) Base finality / censorship claims are too strong
Base is an L2 with sequencer censorship risk and short-term reorg/finality caveats.

So “permanent, nobody can refuse” is too strong in the first minutes/hours unless you qualify it.

Not unique to you, but worth toning down.

---

## 20) Wallet-method privacy is basically nonexistent
`WalletSignatureRecorded` emits plaintext:
- `documentName`
- `signerEmail`

So any broad product-level privacy claim needs to exclude Method B explicitly.

---

# Things I do **not** think are your biggest problems

- **EIP-712 domain separation** in Method B looks standard.  
  `chainId + verifyingContract` is the right idea. I do **not** see a major cross-chain replay bug there.

- **Poseidon itself** is not what worries me.  
  The problem is what you are binding (or failing to bind), not Poseidon as a primitive.

- **UUID left-padding to bytes32** is probably fine, assuming the proof generator uses the same numeric interpretation.

---

# Direct answers to your specific bullets

- **“Is the circuit actually sound?”**  
  **No**, not for the intended statement. It proves too weak a thing.

- **“Is `_pubSignals[3]` vs docHash/envelopeId a binding failure?”**  
  **Yes, very likely critical.** If live verifier really has 3 publics, third parties cannot audit doc/env binding.

- **“Nullifier arbitrary?”**  
  **Yes.** Replay protection is effectively nonexistent.

- **“Can same proof be re-submitted with new nullifier and different searchKey/docHash/envelopeId?”**  
  **Yes.** That is one of the worst issues.

- **“searchKey arbitrary?”**  
  **Yes.** Operator can misindex, hide, or frame.

- **“recordWalletSignature with arbitrary envelopeId/documentName/signerEmail/timestamp?”**  
  A front-runner cannot change those **after signing**. But anyone can replay, and `signerEmail` is only a signed string, not mailbox ownership.

- **“ECDSA malleability?”**  
  **Yes**, but replay already gives duplicates; low-`s` omission is not the primary Method B issue.

- **“recordCompletion zero auth?”**  
  **Yes. Fully forgeable.**

- **“Permissionless EvidenceKeyRegistry?”**  
  **Yes, major problem.** As implemented it is a public note board, not an authenticated DNS archive.

- **“Argon2 privacy?”**  
  Good speed bump, not strong anonymity. No secret pepper + public docHash means targeted deanonymization is practical.

- **“DKIM `l=` / folding / duplicate headers?”**  
  **Must inspect library.** Could be severe.

- **“Is ‘I APPROVE’ uniquely identifying?”**  
  **No.** Not even close.

---

# Four POCs I would try immediately

1. **Quote attack**
   - Send template containing “reply `I APPROVE`”.
   - Reply “No”.
   - See if prover can match the quoted original text.

2. **Public-proof replay**
   - Take any live reply-to-sign tx calldata.
   - Re-submit proof with different `docHash`, `envelopeId`, `searchKey`, fresh `nullifier`.

3. **Fake Gmail key**
   - Register attacker RSA key as `gmail.com`.
   - Fabricate raw DKIM-signed blob with `From: victim@gmail.com`.
   - Prove and record.

4. **Completion spoof**
   - Call `recordCompletion()` with garbage for a real envelope/doc.
   - See how UI/verifier reacts.

---

# Bottom line

If I had to summarize harshly:

- **Method A is currently a broken statement-binding system.**
- **Method B is comparatively sane, but replay/pollution-prone and semantically weaker than you may be implying.**

I would **not** make “zero trust,” “operator cannot forge/fabricate,” or “independently verifiable” claims for Method A until you fix the critical issues above.

If you want, I can turn this into a remediation plan with exact contract/circuit changes and a minimal safe redesign for Method A.

---
**Wall time**: 61m 55s
**Tokens**: 6,234 input, 73,845 output (68,503 reasoning), 80,079 total
**Estimated cost**: $13.4791
