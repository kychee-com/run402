# Consultation Result — cfdkim ZK-soundness audit

**Model**: gpt-5.4-pro-2026-03-05
**Response ID**: resp_006935a9a7292a510069dfcf66fa1c81a0a2e35748ffaf5be8
**Status**: completed
**Recovered**: 2026-04-15T22:44:35.397662

> Recovered post-hoc after consult.py crashed writing the result (Windows cp1252 codec failed on non-ASCII characters). Skill-level fix needed for consult.py.

---

Below I’m **not re-listing** the already-known `l=` issue, duplicate `From:` issue, `hash.rs:129` unwrap, or `rsa-sha1` acceptance as standalone findings.

I **did** find **6 substantive new issues** plus **1 architectural limitation** and **1 low-severity RFC-strictness bundle**.

## Summary

| # | Severity | Finding | Current layer coverage |
|---|---|---|---|
| 1 | **high** | `b=` value is removed with global `String::replace`, so other copies of the signature text inside the DKIM header are also deleted from the hashed bytes | **Not covered** |
| 2 | **high** | Algorithm/key-type mismatch accepted: `a=rsa-sha256` can verify with an **Ed25519** key/signature | **Host masks in honest flow; guest does not enforce** |
| 3 | **high** | LF-only / newline-normalized input makes the **body hash ignore the real body** | **Not covered** |
| 4 | **medium** | `simple` header canonicalization is not byte-exact; cfdkim reconstructs headers instead of hashing original bytes | **Not covered** |
| 5 | **high** | Duplicate `Subject:` / `To:` ambiguity: cfdkim authenticates bottom-most instances; your guest currently reads the first `Subject:` line | **Current system vulnerable; planned duplicate-header rejection should fix if enforced in-guest** |
| 6 | **medium** | Duplicate DKIM tag names are silently accepted with **last-wins** semantics | **Not covered** |
| 7 | **medium** | `verify_email_with_key()` is weaker than full RFC DKIM because selector-record policy tags (`h=`, `t=`, `s=`) are not proved/enforced | **Not covered** |
| 8 | **low** | Other RFC-invalid headers accepted: `v=` not first, naive `i=` suffix check, bare CR/LF accepted as FWS, parser remainder ignored | **Not covered** |

Highest-confidence items: **#1, #2, #3, #5, #6**.  
#4 and #8 partly depend on `mailparse` behavior, but cfdkim’s own tests strongly support the relevant trimming/normalization assumptions.

---

# Findings

## 1) Global `replace()` on the `b=` value corrupts DKIM-Signature header hashing

1. **Severity:** **high**
2. **File:line:** `cfdkim/src/hash.rs:126-140`
3. **Soundness consequence:**  
   cfdkim can return **pass** for a DKIM-Signature header that **no RFC-compliant verifier would accept**.  
   The bug is here:

   ```rust
   let sign = dkim_header.get_raw_tag("b").unwrap();
   let value = dkim_header.raw_bytes.replace(&sign, "");
   ```

   This removes **every occurrence** of the raw `b` value anywhere in the DKIM-Signature header, not just the `b=` tag’s own value. An attacker can deliberately place the same string in another tag (e.g. `z=`), making cfdkim hash a different header than RFC 6376 requires.
4. **Minimal reproducer:**  
   Use a short one-line Ed25519 signature string `SIG`, and construct:

   ```email
   DKIM-Signature: v=1; a=ed25519-sha256; c=relaxed/relaxed;
    d=example.com; s=sel; h=from:subject;
    z=SIG;
    bh=<correct body hash>;
    b=SIG
   From: alice@example.com
   Subject: test

   hello
   ```

   Construction recipe:

   - Build the DKIM-Signature header **with `z=` empty and `b=` empty**.
   - Compute the header hash on that header.
   - Sign it to get `SIG`.
   - Then fill **both** `z=SIG` and `b=SIG`.

   **cfdkim** removes both copies of `SIG` during verification and passes.  
   **RFC verifier** removes only the `b=` value, leaves `z=SIG` in the hashed header, and rejects.
5. **Mitigation:**  
   - **In-library patch:** track the exact byte span of the `b=` tag value and blank **only that span**. Do **not** use substring replacement.
   - **Temporary in-guest guard:** reject any DKIM-Signature where the raw `b` value occurs more than once in the raw DKIM-Signature header value.
   - **Safer temporary profile:** reject `z=` entirely until patched.
   - If patching this on top of current parsing is awkward, **replace the library/parser** with one that preserves raw byte offsets.

---

## 2) `a=` algorithm is not bound to key type; `rsa-sha256` can verify with Ed25519

1. **Severity:** **high**
2. **File:line:** `cfdkim/src/lib.rs:209-235`
3. **Soundness consequence:**  
   cfdkim accepts signatures that are invalid under RFC DKIM because the **header algorithm** and the **actual key type** can disagree.

   The Ed25519 branch does **not** check that `hash_algo == Ed25519Sha256`:

   ```rust
   DkimPublicKey::Ed25519(public_key) => public_key.verify_strict(&header_hash, ...)
   ```

   So a header claiming `a=rsa-sha256` can still verify with an Ed25519 key/signature over the SHA-256 header hash.
4. **Minimal reproducer:**  
   - DKIM header says `a=rsa-sha256`
   - Body hash `bh=` is correct
   - `b=` is actually an **Ed25519** signature over the computed SHA-256 header hash
   - Call:

   ```rust
   verify_email_with_key(..., public_key = DkimPublicKey::Ed25519(...))
   ```

   Result: cfdkim can return `pass`, even though RFC says the signature algorithm is not RSA.

   Equivalent DNS-path variant:
   - selector TXT says `k=ed25519`
   - header says `a=rsa-sha256`
   - cfdkim still accepts
5. **Mitigation:**  
   - **In-library patch:** before signature verification, enforce:
     - `rsa-sha1` / `rsa-sha256` ⇒ RSA key only
     - `ed25519-sha256` ⇒ Ed25519 key only
   - **In-guest assertion:** parse `a=` inside the guest and assert it matches the supplied key type.
   - **DNS path:** also enforce `a=` compatibility with selector-record `k=`.

---

## 3) LF-only / normalized-newline input makes the body hash ignore the actual body

1. **Severity:** **high**
2. **File:line:** `cfdkim/src/hash.rs:22-24`, `cfdkim/src/bytes.rs:3-9`
3. **Soundness consequence:**  
   `get_body()` looks for `\r\n\r\n` only:

   ```rust
   bytes::get_all_after(email.raw_bytes, b"\r\n\r\n")
   ```

   If the raw email uses **LF-only** separators (`\n\n`), cfdkim treats the body as **empty**. That means two distinct LF-only emails with different bodies can produce the same body hash under cfdkim. In kysigned, this is disastrous if any ingestion/storage step normalizes CRLF to LF before proving.
4. **Minimal reproducer:**  
   Raw email bytes with LF-only line endings:

   ```text
   DKIM-Signature: v=1; a=ed25519-sha256; c=relaxed/relaxed; d=example.com; s=sel; h=from:subject; bh=47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=; b=<sig>\n
   From: alice@example.com\n
   Subject: [kysigned] env_1 doc_2\n
   \n
   I APPROVE\n
   UNSIGNED EXTRA CONTENT\n
   ```

   `bh=47DE...` is the SHA-256 of the **empty** relaxed body.  
   cfdkim hashes an empty body here because it never finds `\r\n\r\n`.
5. **Mitigation:**  
   - **In-guest assertion:** reject any message containing a lone `\n` or lone `\r`; require strict CRLF framing.
   - **Operator layer:** preserve raw SMTP bytes exactly; never newline-normalize before proof input.
   - **Long-term patch:** derive body span from a parser that preserves original raw framing, or explicitly validate raw message syntax before DKIM verification.

This one **falls through both current operator and current guest layers** unless you explicitly enforce CRLF in-guest.

---

## 4) `simple` header canonicalization is not actually simple (exact-byte binding lost)

1. **Severity:** **medium**
2. **File:line:**  
   - `cfdkim/src/hash.rs:93-95,117-123,129-134`
   - `cfdkim/src/canonicalization.rs:79-84`
3. **Soundness consequence:**  
   For `c=simple/*` (including omitted `c=`, which defaults to `simple/simple`), cfdkim does **not** hash the exact signed header bytes. It reconstructs headers as:

   ```rust
   key + ": " + value + "\r\n"
   ```

   That loses exact original bytes such as:
   - whether there was a space after the colon
   - exact raw DKIM-Signature field-name case / colon formatting
   - potentially other raw formatting preserved in true simple canonicalization

   So two different raw headers can hash the same under cfdkim even though RFC simple canonicalization would distinguish them.
4. **Minimal reproducer:**  
   Sign a message with header canonicalization `simple` and:

   ```email
   Subject: hello
   ```

   After signing, mutate only the raw header bytes to:

   ```email
   Subject:hello
   ```

   Under RFC simple canonicalization, verification should fail.  
   Under cfdkim’s reconstructed `key + ": " + value + "\r\n"` model, this can still verify.

   The same issue exists for the `DKIM-Signature` header itself, because cfdkim always reuses the constant field name `"DKIM-Signature"` instead of the original raw field-name bytes.
5. **Mitigation:**  
   - **Best short-term containment:** reject any signature whose **header** canonicalization is `simple` (including omitted `c=`).
   - **Real fix:** hash the **original raw header field bytes**, not `(key, value)` pairs from `mailparse`.
   - If current parser cannot provide raw header spans, **replace library/parser** for DKIM verification.

This is not covered by your current spec text; if you want a safe interim profile, I would **only accept `relaxed/*`**.

---

## 5) Duplicate `Subject:` / `To:` ambiguity: cfdkim authenticates bottom-most instances, your guest currently reads the first one

1. **Severity:** **high** (**kysigned-specific binding issue**)
2. **File:line:** `cfdkim/src/hash.rs:72-103` (especially `82-100`), plus absence of duplicate rejection in `cfdkim/src/lib.rs:345-415`
3. **Soundness consequence:**  
   This is the same class as your already-known duplicate `From:` issue, but it also applies to **`Subject:`** and **`To:`**.

   `select_headers()` implements DKIM’s bottom-up selection semantics. If `h=` mentions `Subject` once and the email has two `Subject:` headers, cfdkim authenticates the **bottom-most** one. Your current guest, however, extracts the **first** `Subject:` line from raw bytes.

   Result: the proof can commit an `envelope_id` / `doc_hash` from an **unsigned** `Subject:` header while cfdkim says DKIM passed.
4. **Minimal reproducer:**  

   ```email
   DKIM-Signature: ... h=from:subject:date; ...
   From: Alice <alice@example.com>
   Subject: [kysigned] env_fake doc_fake
   Date: ...
   Subject: Re: lunch?
   
   I APPROVE
   ```

   With `h=` containing `Subject` only once:
   - cfdkim authenticates `Subject: Re: lunch?` (bottom-most)
   - current guest `extract_subject_from_headers()` returns `[kysigned] env_fake doc_fake` (first one)

   So the proof can bind to an unsigned subject.

   Same family of issue applies to folded subjects, because your guest reads only the first physical `Subject:` line, not the unfolded DKIM-authenticated header field.
5. **Mitigation:**  
   - **In-guest reject duplicate `From` / `Subject` / `To`** before proof generation. Your spec already says this; it needs to be enforced cryptographically.
   - Stop using raw “first line starting with Subject:” extraction. Instead, extract the **exact DKIM-selected header instance** and unfold it using RFC 5322 rules.
   - If you later bind `To:`, same rule applies there too.

This **falls through the current system today** because you said operator pre-check currently rejects duplicate `From:` only.

---

## 6) Duplicate DKIM tag names are silently accepted; last tag wins

1. **Severity:** **medium**
2. **File:line:**  
   - `cfdkim/src/lib.rs:140-146`
   - `cfdkim/src/header.rs:14-27`
   - parsing entrypoint: `cfdkim/src/parser.rs:26-40`
3. **Soundness consequence:**  
   RFC 6376 says duplicate tag names in a DKIM-Signature tag-list are invalid. cfdkim does not reject them; it inserts tags into a map and the **last value silently overwrites** the earlier one.

   This means malformed signatures such as duplicate `h=`, `d=`, `a=`, `bh=`, or `b=` can pass in cfdkim even though RFC verifiers should reject them.

   This is especially dangerous for your planned in-guest checks on:
   - `Subject` in `h=`
   - `d=` / `From` alignment
   - algorithm checks

   because those checks would read the **attacker-chosen last tag value**.
4. **Minimal reproducer:**  

   ```email
   DKIM-Signature: v=1; a=ed25519-sha256; d=example.com; s=sel;
    h=from;
    h=from:subject;
    bh=<...>;
    b=<...>
   ```

   cfdkim uses the second `h=` and can pass if the signature is generated under cfdkim’s semantics.  
   RFC-compliant verifier should reject the whole signature as malformed.
5. **Mitigation:**  
   - **In-library patch:** reject any duplicate DKIM tag name during `validate_header()`.
   - **In-guest assertion:** if you read parsed `h=`, `d=`, `a=`, etc., also assert DKIM tag-name uniqueness.
   - Add regression tests for duplicate `h=`, `d=`, `a=`, `b=`, and `bh=`.

---

## 7) `verify_email_with_key()` cannot prove full RFC DKIM because selector-record policy tags are missing/ignored

1. **Severity:** **medium**
2. **File:line:**  
   - `cfdkim/src/lib.rs:345-415` (`verify_email_with_key` only takes a naked public key)
   - `cfdkim/src/public_key.rs:47-70` (DNS path only really enforces `v`, `k`, `p`; it ignores selector policy tags like `h=`, `s=`, `t=`)
3. **Soundness consequence:**  
   This is an **architectural limitation** of using `verify_email_with_key()` as your in-guest predicate.

   Full RFC DKIM validity is not just “signature verifies under this public key”. The selector TXT record can impose additional constraints, e.g.:
   - `h=`: allowed hash algorithms
   - `t=s`: strict AUID granularity
   - `s=`: service type restrictions

   Your guest never sees these tags, so it can return `pass` for messages that RFC 6376 would reject.
4. **Minimal reproducer:**  
   Selector TXT:

   ```text
   v=DKIM1; k=rsa; h=sha1; p=<rsa-public-key>
   ```

   Email header:

   ```text
   DKIM-Signature: v=1; a=rsa-sha256; d=example.com; s=sel; ...
   ```

   If the RSA signature verifies under that key:
   - `verify_email_with_key(..., rsa_key)` can pass
   - RFC verifier should reject, because selector `h=sha1` disallows `sha256`
5. **Mitigation:**  
   - If you want the proof to mean **full RFC-valid DKIM**, you need to bring the **selector record** (or a committed digest of it plus full policy data) into the guest and enforce at least `k`, `h`, `s`, `t`.
   - Otherwise, explicitly downgrade the security claim to **“valid under a supplied public key”**, not “RFC-valid DKIM”.
   - Operational stopgap: whitelist only provider selectors known not to use restrictive `h=` / `s=` / `t=` tags.

This one is **not covered** by your current operator or guest layers.

---

## 8) Other RFC-invalid headers are accepted due to permissive parsing/validation

1. **Severity:** **low**
2. **File:line:**  
   - `cfdkim/src/lib.rs:123-165`
   - `cfdkim/src/parser.rs:26-40`
   - `cfdkim/src/parser.rs:101-104`
3. **Soundness consequence:**  
   A few more RFC-invalid DKIM-Signature headers can pass:
   - `v=` is checked for value but **not required to be first**
   - `i=` / `d=` alignment is a naive `ends_with()` check, so `i=user@notexample.com` passes for `d=example.com`
   - `fws()` accepts bare `\r` / `\n` as folding whitespace, which is looser than RFC FWS
   - `validate_header()` discards the parser remainder (`let (_, tags) = ...`), so any junk left unparsed is not rejected
4. **Minimal reproducer:**  
   Header fragments that cfdkim can accept if otherwise correctly signed:
   - `a=rsa-sha256; v=1; d=example.com; ...`  (`v=` not first)
   - `d=example.com; i=user@notexample.com; ...`  (naive suffix match)
   - DKIM-Signature folding that uses bare LF rather than CRLF+WSP
5. **Mitigation:**  
   - Enforce `v=` as the first tag
   - Parse and validate `i=` as an addr-spec/domain with proper label-boundary matching
   - Tighten `FWS` parsing to RFC rules
   - Reject any non-empty parser remainder after tag-list parsing

Low severity individually, but together they show `validate_header()` is **not RFC-strict**.

---

# Deepening the already-known items

A few short notes on the issues you already know about:

- **Known `l=` issue:** your fix plan is right, but note that **rejecting `l=` is not enough** if LF-only input is allowed; with LF-only input, cfdkim can already ignore the entire body even without `l=`.
- **Known duplicate `From:` issue:** the same bottom-up selection logic applies to **`Subject:` and `To:`**. For kysigned, duplicate `Subject:` is immediately dangerous because your guest currently parses the first raw subject line.
- **Known `rsa-sha1` issue:** if you ever rely on DNS-path verification outside the guest, selector-record `h=` restrictions are also ignored, so `rsa-sha1` pre-check alone is not the whole story.

---

# Recommended minimum hardening before trusting this in zk

If you need a **safe interim profile** before patching/replacing cfdkim, I would make the guest reject unless all of the following hold:

1. `verified == true` is **asserted**, not journaled as a bool
2. `from_domain` is derived from the authenticated `From:`
3. no `l=`
4. no duplicate `From` / `Subject` / `To`
5. no duplicate DKIM tag names
6. no lone `\n` / `\r` anywhere; strict CRLF framing only
7. header canonicalization is **not simple** (`c` must be `relaxed/...`)
8. `a=` family matches supplied key type
9. reject `rsa-sha1`
10. until #1 is patched, reject `z=` or at least reject when raw `b` value appears more than once in the DKIM-Signature header

And if you want the proof to mean **full RFC-valid DKIM**, not just “signature under supplied key”, you need to **prove selector-record policy** too.

If you want, I can turn this into a **patch plan** against cfdkim with concrete Rust diffs/tests for the top 4 issues.

---
**Tokens**: 24,933 input, 73,523 output (68,821 reasoning), 98,456 total
**Estimated cost**: $13.9821
