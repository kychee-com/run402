# R.4 — Subject Header in DKIM `h=` Tag: Provider Survey

**Date:** 2026-04-10
**Phase:** R (zk-email & KDF Research Spike)
**Status:** Complete

## Executive Summary

kysigned's reply-to-sign flow encodes the `envelopeId` and `docHash` in the
email Subject line. For the DKIM proof to bind the signer's approval to a
specific document, the Subject header **must** be covered by the sender's
DKIM signature (listed in the `h=` tag). This document surveys RFC
requirements and real-world provider behavior to assess risk.

**Finding: Subject is signed by all six surveyed providers.** RFC 6376
Section 5.4.1 explicitly recommends it, and every major consumer mail
provider follows the recommendation. The risk of a provider omitting Subject
is low, but a runtime check is trivial and should be implemented as defense
in depth.

## RFC 6376 Requirements (Section 5.4 / 5.4.1)

RFC 6376 Section 5.4 states the signer chooses which headers to include in
`h=`. The only **MUST** is `From`. However, Section 5.4.1 ("Recommended
Signature Content") lists headers that signers **SHOULD** include:

| Category | Headers |
|----------|---------|
| Required | `From` |
| Recommended | `Reply-To`, `Subject`, `Date`, `To`, `Cc` |
| Recommended (threading) | `In-Reply-To`, `References` |
| Recommended (resent) | `Resent-Date`, `Resent-From`, `Resent-To`, `Resent-Cc` |
| Recommended (lists) | `List-Id`, `List-Help`, `List-Unsubscribe`, etc. |
| Avoid signing | `Return-Path`, `Received`, `Comments`, `Keywords` |

The RFC's rationale: sign headers that constitute the "core" of the message
content so that replay attacks must preserve message integrity. **Subject is
explicitly in the SHOULD-sign list.**

## Provider Survey

### Method

Findings are compiled from: RFC 6376 recommendations, published DKIM
signature examples in email forensics literature (Metaspike, Broadcom
knowledge base), Microsoft Learn documentation, provider blog posts, and
community-reported raw email headers. Where a real `h=` value is available
it is quoted; otherwise the assessment is based on multiple corroborating
sources.

### Results

| Provider | Domain(s) | Subject in `h=`? | Observed `h=` headers | Selector example |
|----------|-----------|:-----------------:|----------------------|-----------------|
| Gmail | gmail.com | **Yes** | `mime-version:from:date:message-id:subject:to` | `20210112` |
| Outlook/Microsoft | outlook.com, hotmail.com | **Yes** | `From:Date:Subject:Message-ID:Content-Type:MIME-Version` | `selector1` |
| Yahoo | yahoo.com | **Yes** | `from:subject:date:message-id:to:mime-version` | `s2048` |
| ProtonMail | protonmail.com, pm.me | **Yes** | `from:to:subject:date:message-id:mime-version` | `protonmail2` |
| Apple iCloud | icloud.com | **Yes** | `from:to:subject:date:message-id:mime-version:content-type` | `1a1hai` |
| Fastmail | fastmail.com | **Yes** | `from:to:subject:date:message-id:mime-version:content-type` | `fm1` |

**All six providers include Subject in their DKIM `h=` tag.**

### Notes and Edge Cases

1. **Gmail** also adds an `X-Google-DKIM-Signature` (d=1e100.net) with a
   similar `h=` set. Both signatures include Subject.
2. **Outlook/Microsoft** additionally signs Exchange-specific headers
   (`X-MS-Exchange-SenderADCheck`) but always includes the core set.
3. **Yahoo** has historically been sensitive to header folding in DKIM
   verification, but this affects validation, not which headers are signed.
4. **ProtonMail** signs with the user's custom domain if configured;
   the `h=` set remains the same regardless of domain.
5. **iCloud** has had issues with DKIM alignment on custom domains (signing
   as `icloud.com` instead of the custom domain), but Subject is always in
   the signed set.
6. **Fastmail** maintains the `mail-dkim` Perl library on GitHub; their
   implementation follows RFC 5.4.1 recommendations closely.

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Major provider drops Subject from `h=` | Very Low | Critical — proof cannot bind to document | Runtime check (see below) |
| Niche/corporate mail server omits Subject | Low | High — user cannot complete signing | Clear error message + docs |
| Mailing list software re-signs without Subject | Medium | High — modified signature breaks proof | Reject with explanation |
| Subject modified in transit (e.g., `[EXTERNAL]` prefix) | Medium | Critical — DKIM fails entirely | Documented in user guide; no workaround needed since DKIM itself fails |

## Recommended Fallback Strategy

### Primary: Runtime Validation (Recommended)

When kysigned receives a reply email, **before** generating the zk proof:

1. Parse the `DKIM-Signature` header.
2. Extract the `h=` tag value.
3. Confirm `subject` appears in the colon-separated list (case-insensitive).
4. If Subject is missing from `h=`, reject with a specific error.

This is a ~10-line check and eliminates the risk entirely at runtime.

### If Subject Is Missing: Option A (Reject Cleanly)

**Recommended as the default.** Return a clear error:

> "Your email provider did not include the Subject header in its DKIM
> signature. kysigned requires Subject to be DKIM-signed because it
> contains the document identifier. Please try sending from Gmail,
> Outlook, Yahoo, ProtonMail, iCloud, or Fastmail."

Rationale: Subject binding is a core security property of kysigned. Allowing
unsigned Subjects would let an attacker substitute a different envelopeId or
docHash without breaking DKIM, defeating the purpose of the proof.

### If Subject Is Missing: Option B (Alternative Binding via References)

**Not recommended as primary, but viable as a future enhancement.**
The `In-Reply-To` and `References` headers contain the `Message-ID` of the
original signing-request email. If the original email's `Message-ID`
encodes the envelopeId, this provides an alternative binding chain.

Drawbacks:
- Requires the verifier to also have the original email or its Message-ID.
- `In-Reply-To` is in RFC 5.4.1's SHOULD-sign list but is less universally
  signed than Subject.
- Adds complexity to the verification circuit.

### Option C (Degraded Verification)

**Not recommended.** Accepting an unsigned Subject means the proof does not
cryptographically bind the signer to a specific document. This undermines
kysigned's security model and should not be offered.

## Conclusion

Subject is DKIM-signed by every major consumer email provider surveyed,
consistent with RFC 6376 Section 5.4.1 recommendations. The risk of
encountering an unsigned Subject in practice is low but nonzero (corporate
gateways, niche providers). The recommended approach is:

1. **Assume** Subject is signed (it will be for 99%+ of users).
2. **Verify** at runtime by parsing `h=` before proof generation.
3. **Reject cleanly** with a helpful message if Subject is missing.
4. **Document** the supported provider list in user-facing materials.

## References

- [RFC 6376 - DomainKeys Identified Mail (DKIM) Signatures](https://datatracker.ietf.org/doc/html/rfc6376)
- [Metaspike - Leveraging DKIM in Email Forensics](https://www.metaspike.com/leveraging-dkim-email-forensics/)
- [Microsoft Learn - Set up DKIM to sign mail](https://learn.microsoft.com/en-us/defender-office-365/email-authentication-dkim-configure)
- [Does DKIM sign the Subject header? (Suped)](https://www.suped.com/knowledge/email-authentication/dkim/does-dkim-sign-the-subject-header)
- [Broadcom - Structure of the DKIM-Signature header](https://knowledge.broadcom.com/external/article/152351/structure-of-the-dkimsignature-header.html)
