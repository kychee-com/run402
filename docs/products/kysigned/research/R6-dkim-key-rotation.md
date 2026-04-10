# R.6 — DKIM Key Rotation Handling

**Date:** 2026-04-10
**Phase:** R (zk-email & KDF Research Spike)
**Status:** Complete

## Goal

Design the key-fetch, cache, and rotation-detection strategy for DKIM public keys used in kysigned proof generation. Keys rotate; the system must handle this gracefully.

## Provider Rotation Frequency

| Provider | Selector format | Key size | Rotation frequency | Notes |
|----------|----------------|----------|-------------------|-------|
| Gmail (`gmail.com`) | Date-based: `20230601` | 2048-bit RSA | ~6-12 months | Selector encodes generation date (YYYYMMDD) |
| Google Workspace | Configurable: `google`, `gappssmtp` | 1024 or 2048-bit | Manual (admin-triggered) | Many orgs never rotate |
| Outlook (`outlook.com`) | `selector1`, `selector2` | 2048-bit RSA | ~6-12 months | Alternates between two selectors |
| Yahoo (`yahoo.com`) | `s2048` | 2048-bit RSA | Rare (years) | Very infrequent rotation |
| Proton Mail | `protonmail3` | 2048-bit RSA | Rare | Privacy-focused, stable keys |
| Custom domains (Sendgrid, Mailgun, etc.) | Varies (`s1`, `k1`, `smtpapi`) | 1024-2048-bit | Varies | Depends on ESP + domain admin |

**Key insight:** Major providers rotate every 6-12 months. The old selector remains in DNS for a grace period (typically weeks to months) after rotation, since in-flight emails still reference it. There is no formal deprecation signal — the old TXT record simply disappears eventually.

## How DKIM Selectors Work

The `DKIM-Signature` header in every signed email contains `s=<selector>` and `d=<domain>`:

```
DKIM-Signature: v=1; a=rsa-sha256; d=gmail.com; s=20230601;
    h=from:to:subject:date:message-id; ...
    b=<signature bytes>
```

The verifier looks up `<selector>._domainkey.<domain>` in DNS to get the public key:

```
20230601._domainkey.gmail.com TXT "v=DKIM1; k=rsa; p=MIIBIjANBg..."
```

**Each `(domain, selector)` pair maps to exactly one key.** When a provider rotates, they publish a new selector (e.g., `20250101`) and start signing with it. The old selector (`20230601`) stays in DNS until the provider removes it.

## Key-Fetch + Cache Strategy

### Fetch Flow (at reply processing time)

```
1. Parse DKIM-Signature from reply email → extract (domain, selector)
2. Check local cache for (domain, selector)
   → HIT + fresh (< 1 hour): use cached key
   → HIT + stale (> 1 hour): re-fetch from DNS, update cache
   → MISS: fetch from DNS, populate cache
3. Verify DKIM signature using the fetched key
4. Check EvidenceKeyRegistry for existing registration
   → EXISTS: use existing keyId for proof
   → NOT EXISTS: register new key via `registerEvidenceKey(domain, selector, publicKey)`
5. Generate zk proof referencing the key's pubkeyHash
```

### Cache Design

| Property | Value | Rationale |
|----------|-------|-----------|
| Cache key | `${domain}:${selector}` | One entry per unique key |
| TTL (fresh) | 1 hour | Balance between DNS load and freshness |
| TTL (stale-while-revalidate) | 24 hours | Serve stale if DNS is temporarily down |
| TTL (hard expiry) | 7 days | Force re-fetch; detect removed keys |
| Storage | In-memory (Map) + SQLite | Memory for hot path, SQLite for persistence across restarts |
| Negative cache | 5 minutes | Don't hammer DNS for keys that don't exist |

### Why Not Use DNS TTL Directly?

DKIM TXT records typically have long TTLs (3600-86400s). But the DNS TTL tells us how long the *resolver* should cache — not how long the key is valid. A key can be rotated (new selector published) while the old selector's TTL hasn't expired. Our cache strategy is based on operational needs, not DNS TTL.

## Interaction with EvidenceKeyRegistry

The on-chain registry is **append-only** (per R.1 architectural decision). Each unique `(domain, selector, publicKey)` triple gets one entry:

```
keyId = keccak256(domain, selector, publicKey)
```

**Rotation creates a new entry, not an update:**

| Time | Gmail selector | On-chain entry |
|------|---------------|---------------|
| T0 | `20230601` | `keyId_A` registered with `block.timestamp` |
| T1 (rotation) | `20250101` | `keyId_B` registered (new entry, `keyId_A` remains valid) |
| T2 (old key removed from DNS) | `20230601` gone | `keyId_A` still on-chain — proofs referencing it remain verifiable forever |

This is the core value proposition: even after a provider removes a DKIM key from DNS, the on-chain registry preserves it. Any signature made while that key was active can still be verified.

## DNS Lookup Failure at Reply Time

**Scenario:** Signer sends reply at T0. By the time the operator processes it at T1 (minutes to hours later), the provider has rotated keys and removed the old selector from DNS.

**This is rare but possible.** Mitigation:

### 1. Pre-emptive fetch (primary defense)

When the operator sends the signing-request email, immediately fetch and cache the current DKIM key for the recipient's domain. If the reply comes back signed with that selector, the cached key is already available regardless of DNS state.

**Limitation:** The reply may be signed with a *different* selector than what we pre-fetched (the provider rotated between send and reply). In practice, this window is very small (hours), and providers maintain old selectors for weeks.

### 2. Stale cache serving

If the DNS lookup for the selector fails at reply time, check the local cache. If we have a cached copy from within the last 7 days, use it. The DKIM signature in the email is the ground truth — if it verifies against the cached key, the key was correct.

### 3. Multi-resolver retry

Before giving up, query multiple resolvers (Google DoH, Cloudflare DoH, authoritative NS). DNS propagation delays mean one resolver may still have the old record cached even if another doesn't.

### 4. Graceful failure

If all lookups fail and no cache exists: mark the envelope as `verification-pending`. The operator can retry later or request the signer to re-send. This should be exceptionally rare (<0.01% of envelopes).

## Recommendation

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Cache backend | In-memory Map + SQLite | Fast hot path, survives restarts |
| Fresh TTL | 1 hour | Responsive to rotation |
| Pre-emptive fetch | Yes, at send time | Eliminates most rotation-window failures |
| On-chain model | Append-only, one entry per (domain, selector, key) | Old keys remain verifiable forever |
| Failure policy | Stale cache -> multi-resolver -> pending | Never silently drop a valid signature |

## Open Questions

- Should we proactively monitor known provider selectors for rotation (background polling)? This would let us pre-register new keys before any envelope needs them. Low priority for MVP.
- Ed25519 DKIM keys (`k=ed25519`) are emerging. The cache and registry should support them, but no major provider uses them yet.
