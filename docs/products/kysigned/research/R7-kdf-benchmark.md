# R.7 — Slow-KDF Benchmark Results

**Date:** 2026-04-10
**Phase:** R (zk-email & KDF Research Spike)
**Status:** Complete

## Recommendation

**argon2id — 256 MiB memory, 4 iterations, parallelism 1, 32-byte output**

These parameters are **committed forever** — changing them breaks all existing `searchKey` lookups.

## Committed Parameters

```typescript
// IMMUTABLE — these parameters define the searchKey protocol.
// Changing any value invalidates all existing on-chain records.
export const SEARCH_KEY_PARAMS = {
  algorithm: 'argon2id',
  memorySizeKiB: 262144,   // 256 MiB
  iterations: 4,
  parallelism: 1,
  hashLength: 32,           // 256 bits output
  // Salt is deterministic: SHA-256("kysigned-searchkey-v1")
  // This means the same (email, docHash) pair always produces the same searchKey.
  salt: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
} as const;
```

**Salt strategy:** The salt is a fixed protocol constant (`SHA-256("kysigned-searchkey-v1")`), NOT a random per-user salt. This is intentional — `searchKey` must be deterministic so that a verifier can recompute it from `(email, docHash)` and look it up on-chain. The slow KDF provides the brute-force resistance; the salt just prevents rainbow tables (which are irrelevant when the input space is email addresses, not passwords).

## Benchmark Results

**Platform:** Windows 11, x64, Node.js v22.15.0 (consumer desktop)

### argon2id (via `hash-wasm` WASM)

| Config | Memory | Iterations | Avg (ms) | Target (500-2000ms)? |
|--------|--------|------------|----------|---------------------|
| argon2id-64M-3i | 64 MiB | 3 | 147 | Too fast |
| argon2id-128M-3i | 128 MiB | 3 | 306 | Too fast |
| argon2id-256M-3i | 256 MiB | 3 | 631 | Yes |
| **argon2id-256M-4i** | **256 MiB** | **4** | **811** | **Yes (chosen)** |
| argon2id-384M-3i | 384 MiB | 3 | 904 | Yes |
| argon2id-512M-2i | 512 MiB | 2 | 910 | Yes |
| argon2id-512M-3i | 512 MiB | 3 | 1246 | Yes |

### scrypt (via `hash-wasm` WASM)

| Config | N | r | Avg (ms) | Target? |
|--------|---|---|----------|---------|
| scrypt-N2^15-r8-p1 | 32768 | 8 | 58 | Too fast |
| scrypt-N2^16-r8-p1 | 65536 | 8 | 104 | Too fast |
| scrypt-N2^17-r8-p1 | 131072 | 8 | 209 | Too fast |
| scrypt-N2^18-r8-p1 | 262144 | 8 | 428 | Too fast |

### Why argon2id over scrypt

1. **Memory-hard with time-hard:** argon2id combines memory-hardness (resists GPU) with time-hardness (resists ASIC). scrypt is memory-hard only.
2. **OWASP 2026 recommended:** argon2id is the current OWASP recommendation.
3. **Better tuning range:** argon2id's separate memory/iterations knobs give finer control than scrypt's coupled N/r parameters.
4. **Quantum resistance:** argon2id resists Grover's speedup due to memory-hardness (DD-20).

### Estimated performance on other platforms

| Platform | Estimated multiplier | Expected time |
|----------|---------------------|---------------|
| Server (64-core, Linux) | 0.5-0.7x | ~400-570ms |
| Consumer desktop (this benchmark) | 1x | ~811ms |
| Chrome desktop (WASM) | 1.5-2x | ~1.2-1.6s |
| Chrome mobile (Android) | 2-4x | ~1.6-3.2s |
| Safari mobile (iOS) | 2-3x | ~1.6-2.4s |

Mobile performance is acceptable — `searchKey` computation happens once during verification (not during signing). The verifier enters their email + uploads the PDF, waits 2-3 seconds, gets results. This is a deliberate UX choice: the delay communicates "real cryptographic work is happening."

## Implementation Notes

- **Library:** `hash-wasm` (pure WASM, works in Node.js + all browsers)
- **Browser integration:** `hash-wasm` ships as ESM with WASM inlined. No special bundler config needed.
- **Deterministic output:** Same `(email, docHash)` → same `searchKey` on all platforms (WASM is deterministic).
- **searchKey formula:** `searchKey = argon2id(email + "||" + docHash, PROTOCOL_SALT, params)`

## Dependency

```
hash-wasm  ^4.x  (devDependency for benchmark; production dependency added in Phase 2R.12)
```
