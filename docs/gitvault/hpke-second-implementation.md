# gitvault — second HPKE implementation (task 1.0 decision)

**Status:** DECIDED 2026-08-22 (task 1.0; protocol D182). Scope: the HPKE used by the independent second verifier `r402s-verify`. The SDK/CLI keep `@hpke/core` (design D5).

## Suite (read from protocol §1 / `schemas/common.json`)

`suite = "r402s-1"` ⇒ HPKE **Base mode**, KEM `DHKEM(X25519, HKDF-SHA256)` (0x0020), KDF `HKDF-SHA256` (0x0001), AEAD `ChaCha20-Poly1305` (0x0003), per RFC 9180. Used for `key_envelope.ct` (HPKE-sealed 32-byte `K_repo`, `enc` = 32-byte X25519 ephemeral public key). Unambiguous — no PSK/Auth modes, no AES-GCM, no export-only. D38: "HPKE is a named implementation, never assembled; the second verifier uses a different HPKE."

## Shortlist (surveyed 2026-08-22)

| Impl | Lang | RFC 9180 vectors | r402s-1 suite | Maintenance | License | Independent of hpke-js |
|---|---|---|---|---|---|---|
| **`hpke` (rozbb/rust-hpke) 0.14.0** | Rust | Yes — official RFC 9180 KATs in CI | Yes (Base, X25519, HKDF-SHA256, ChaCha20-Poly1305) | Released 2026-07-09; MSRV 1.85; ~2.3M recent downloads; Cloudflare internal review of 0.8 (no findings); no paid audit | MIT OR Apache-2.0 | Yes — pure Rust on RustCrypto primitives (`x25519-dalek`, `hkdf`, `chacha20poly1305`) |
| `hpke-rs` 0.7.0 (cryspen/libcrux) | Rust | Yes | Yes | Released 2026-07-15; backend-pluggable (libcrux / RustCrypto) | MPL-2.0 | Yes |
| `hpke-ng` 0.1.0-rc.3 (Symbolic Software) | Rust | Yes + differential vs hpke-rs; 4 fuzz targets | Yes | Pre-1.0 RC (May 2026); MSRV 1.95 | MIT OR Apache-2.0 | Yes |
| `cloudflare/circl` hpke v1.6.5 | Go | Vectors present, but package doc still cites **draft-irtf-cfrg-hpke-07** | Yes | Released 2026-08-05; no ExportOnly | BSD-3-Clause | Yes |
| Go `crypto/hpke` | Go | (stdlib tests) | Yes | **Not GA** — pkg.go.dev lists it under go1.27.0 but the Go 1.27 release notes (Aug 2026) do not mention it | BSD-3-Clause | Yes |
| `pyhpke` 0.6.5 | Python | Yes | Yes | Released 2026-07-16; wraps `cryptography` | MIT | Yes |
| OpenSSL 3.2+ `OSSL_HPKE_*` | C | Yes | Yes (all 4 modes) | Mainstream; heavy runtime dep for a small verifier | Apache-2.0 | Yes |
| Zig `std.crypto` | Zig | n/a | **No HPKE composition in std** — would require assembling KEM/KDF/AEAD (forbidden by D38) | — | MIT | — |

## Selection: `hpke` (rozbb/rust-hpke) — Rust; `r402s-verify` is written in Rust

Rationale: (1) an independent lineage from `@hpke/core` in language, authorship, and primitive stack (RustCrypto vs. WebCrypto/noble), which is the whole point of a second verifier; (2) the longest production track record of the Rust options (2020→, 2.3M downloads, a Cloudflare review on record), whereas `hpke-ng` is still an RC and Go `crypto/hpke` is not yet in a released Go; (3) the protocol's exact suite is a first-class ciphersuite, `Base` mode only — selected by type parameters, so the suite is pinned at compile time (no runtime agility to misconfigure); (4) permissive dual license compatible with shipping `r402s-verify` from the open-source repo; (5) circl's draft-07 labelling is a documentation lag, not a defect, but it leaves an ambiguity the freeze should not carry. Designated **differential third** (CI only, not shipped): `hpke-rs`, for a three-way vector comparison on the same inputs.

## Acceptance test plan (gates task 1.2 vectors and task 5.9)

1. **RFC 9180 Appendix A KATs, both implementations.** The A.2 vector set (DHKEM(X25519), HKDF-SHA256, ChaCha20-Poly1305, Base mode) MUST pass in `@hpke/core` (SDK CI) AND in `r402s-verify` (Rust CI) — `enc`, every `ct`, and every `exported_value` byte-equal; a failure in either is a freeze blocker. Wycheproof X25519 + ChaCha20-Poly1305 vectors run in both as the primitive-level check (protocol §1 row "CI runs RFC 9180 + Wycheproof vectors on both").
2. **Interop, both directions.** A `key_envelope` sealed by `@hpke/core` (info/AAD per the frozen schema) opens in `r402s-verify` and recovers `K_repo`; an envelope sealed by the Rust impl opens in `@hpke/core`. Both directions live in the committed task-1.2 vector set as golden files; a tamper of any `ct`/`enc`/AAD byte MUST fail to open in both.
3. **"Never assembled" check.** `r402s-verify` MUST obtain seal/open only through the `hpke` crate's `single_shot_seal`/`single_shot_open` (or `setup_sender`/`setup_receiver`) with `Kem = X25519HkdfSha256`, `Kdf = HkdfSha256`, `Aead = ChaCha20Poly1305`, `OpModeR::Base`. A CI grep-gate over the verifier's crypto module rejects any direct import of `x25519_dalek`, `hkdf`, or `chacha20poly1305` outside the `hpke` dependency, and `cargo tree` asserts the crate is an unpatched registry release with the pinned version + checksum. The SDK side has the same rule against composing noble primitives into an HPKE.
4. **Pin + review.** `Cargo.lock` pins `hpke = 0.14.x` with default-features off and only `x25519`, `chacha20poly1305`/`std` enabled; a version bump is a reviewed change that re-runs 1–3.

## Residual risks

- **No formal audit** of rust-hpke (Cloudflare's review covered 0.8 only). Mitigation: vector + interop + differential-third gates above; the verifier only *opens* envelopes, so the sealing side (SDK) never depends on it.
- Single maintainer. Mitigation: `hpke-rs` is suite-compatible and license-acceptable as a swap; the grammar of the acceptance plan is implementation-neutral.
- Go `crypto/hpke` may become the most conservative choice once it ships in a GA Go; revisit only via a superseding decision — not silently.
- Pure-Rust X25519/ChaCha20 are constant-time by design but not formally verified; acceptable for a verifier that holds a recipient private key only in the operator's own process.
