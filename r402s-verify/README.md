# r402s-verify

The **independent-lineage verifier** for the gitvault `r402s/v0` protocol
(openspec `add-gitvault`, task 5.9). It exists so that nothing the SDK/CLI
says about a vault has to be taken on the SDK/CLI's word:

- **Never imports the SDK.** Rust, RustCrypto primitives, a hand-written
  strict I-JSON parser — a different language, authorship, and primitive
  stack from `@run402/sdk` (`@hpke/core` / noble / WebCrypto).
- **The task-1.0 second HPKE:** [rozbb/rust-hpke](https://github.com/rozbb/rust-hpke)
  `0.14.0` (decision D182), pinned by version and checksum in `Cargo.lock`,
  default features OFF, only the `r402s-1` suite enabled
  (`x25519`, `hkdfsha2`, `chacha`, `alloc`).
- **Never assembled (D38).** Every HPKE seal/open/export goes through
  `hpke::setup_sender_with_rng` / `hpke::setup_receiver` with
  `Kem = X25519HkdfSha256`, `Kdf = HkdfSha256`, `Aead = ChaCha20Poly1305`,
  `OpMode::Base`. `src/hpke_envelope.rs` is the ONLY module that touches HPKE
  and it imports nothing but the `hpke` crate; `scripts/never-assembled-gate.sh`
  fails CI if `x25519_dalek`, `hkdf` or `chacha20poly1305` ever appear there,
  or if `hpke` stops being an unpatched registry release at the pinned version.
  (`hkdf` / `chacha20poly1305` ARE used elsewhere — for the protocol's own
  `k_obj`/`K_digest` derivations and the XChaCha20-Poly1305 frames, which are
  not HPKE.)
- **Ed25519 strict RFC 8032, `zip215:false`:** `ed25519_dalek::verify_strict`
  (rejects non-canonical `S`, small-order `R`/`A`, and compares the recomputed
  `R` bytewise). The `zip215` vector class confirms the ZIP215-only signature
  is refused.

This crate lives **outside the npm workspaces** and **outside `publish.yml`**
(see "Release" below).

## Layout

```
r402s-verify/
├── Cargo.toml / Cargo.lock        # pinned; hpke = "=0.14.0"
├── src/
│   ├── json.rs          strict I-JSON front-end (no numbers, no duplicates, no lone
│   │                    surrogates, canonical-bytes check) + RFC 8785 JCS
│   ├── codec.rs         lowercase hex, canonical base64url (no padding, zero trailing bits)
│   ├── preimage.rs      lp / lp_opt, open-id + open-binding preimages, the two hash rules,
│   │                    key fingerprints
│   ├── sig.rs           Ed25519 strict (verify_strict), signed-object verify/sign
│   ├── kdf.rs           HKDF-SHA-256 k_obj / K_digest, keyed commitments (HMAC over JCS)
│   ├── frame.rs         the §2 XChaCha20-Poly1305 frame (magic ‖ suite ‖ nonce ‖ ct‖tag, AAD = JCS)
│   ├── hpke_envelope.rs the key_envelope HPKE through rust-hpke — the ONLY HPKE module
│   ├── timestamp.rs     RFC 3339 UTC ms with calendar semantics (Feb 31 rejects)
│   ├── schema.rs        the JSON-Schema subset the protocol schema set uses (fail-closed on
│   │                    any other keyword; ECMAScript lookaheads via fancy-regex)
│   ├── vectors.rs       vector replay + per-class tally (vectors.json, golden.json, CONTINUITY.json)
│   ├── chain.rs         heads + admission records + generation continuity + transition fail-closed
│   ├── gitdiff.rs       differential git validation (independent SHA-1 rebuild vs `git`)
│   ├── receipt.rs       verifier_receipt emit / check
│   └── main.rs          the clap CLI
├── tests/vectors.rs     replays the vector set when it is reachable (skips loudly otherwise)
└── scripts/never-assembled-gate.sh
```

## Usage

```
cargo build --release            # binary at target/release/r402s-verify

# Replay the task-1.2 vector set and print a per-class tally.
r402s-verify vectors /path/to/gitvault/vectors/vectors.json
#   (schemas default to <vectors>/../schemas; override with --schemas or R402S_SCHEMAS)

# Verify a vault's head chain from a bucket export (head/<gen>, admissions/<gen>, _registry/<v>.json).
r402s-verify --schemas /path/to/schemas chain ./export \
    --pin-generation 000000000000002a \
    --registry-root-pubkey <b64u>

# Differential git validation of a snapshot materialization against the source repo.
r402s-verify git ./repo ./materialization \
    --ref-state ./ref_state.plaintext.json \
    --k-digest-objectset <64 hex> --expect-object-set-hmac <64 hex>

# Verifier receipts.
r402s-verify receipt pubkey --key verifier.seed
r402s-verify --schemas /path/to/schemas receipt emit --key verifier.seed --repo-id src_… \
    --intent-core-sha256 … --checkpoint-head-sha256 … --restored-object-set-hmac … \
    --retention-evolution-ok --candidates-outside-roots-ok > receipt.json
r402s-verify --schemas /path/to/schemas receipt check receipt.json --pubkey <b64u>
```

Exit codes: `0` verified, `1` a check failed (disagreement / refusal), `2` usage or I/O.

### `vectors` — what is replayed

Every class in `vectors.json` that is verifier material is recomputed from
its inputs and compared to the vector's expectations: `golden-preimage`,
`request-to-c1-binding`, `strict-parse`, `stored-bytes-preimage`, `chain`,
`transition-fail-closed`, `zip215`, `aead-frame`, `hkdf`, `activation-token`,
`retention-schedule`, `state-machine-table`, `state-scenario`,
`hpke-rfc9180-a2`, `hpke-envelope`, `hpke-recovery`, `hpke-genesis-binding`,
`hpke-info-near-neighbors`; plus `hpke-interop/golden.json` (both recipients,
reference seal reproduced byte-for-byte, signature-then-open, all tampers) and
the `CONTINUITY.json` whole-file digests.

Deliberately **not** replayed (reported as `skipped`): `heads_listing_pagination`
(an API contract), `abnf-schema-portability` (needs an RFC 5234 interpreter),
`dr-journal-precedence` (re-steps the product model); `forward-integrity-fault`
is replayed for its hash guard only.

**Deterministic HPKE reproduction.** rust-hpke has no public ephemeral-key
injection point, but its `Kem::gen_keypair_with_rng` is *fill `Nsk` bytes from
the RNG, then `derive_keypair(ikm)`*. The replay therefore hands the library a
one-shot "RNG" whose output is exactly the vector's `ikmE`, through the public
`setup_sender_with_rng` — the library computes `DeriveKeyPair(ikmE)` itself and
the resulting `enc`/`ct` equal the reference bytes. Nothing of HPKE is
re-implemented; the RNG is the only thing supplied (`IkmRng`, vector replay only).

### Test vectors are NOT in this repository

They live in the private repo (`docs/strategy/products/gitvault/vectors/`).
`cargo test` replays them when found via `R402S_VECTORS=/path/to/vectors.json`
or a `run402-private` checkout beside this repo, and otherwise prints
`SKIP: vectors.json not found …` and passes. The crate's own unit tests carry
the RFC 9180 A.2.1 KAT, the reviewer-pinned open-binding golden digest, the
JCS/strict-parse edge cases, and Ed25519 strictness, so CI is never vacuous.

## CI

`.github/workflows/r402s-verify.yml` runs on changes under `r402s-verify/**`:
`cargo fmt --check`, `cargo clippy --all-targets -D warnings`, `cargo test`,
and `scripts/never-assembled-gate.sh`.

## Release

This crate cannot ride `publish.yml` (that workflow lockstep-publishes the npm
packages via OIDC). A release of `r402s-verify` is:

1. bump `version` in `Cargo.toml`; `cargo test` with `R402S_VECTORS` pointing
   at the frozen vector set for the protocol revision (`PROTOCOL_REVISION` in
   `src/lib.rs` must equal the set's `x-r402s-revision`);
2. `cargo build --release --locked` on each target and attach the binaries
   (plus `sha256sum`) to a GitHub release tagged `r402s-verify-v<version>`;
3. any change to the `hpke` pin is a reviewed change that re-runs the D182
   acceptance plan (RFC 9180 A.2 KAT, the interop golden file, the
   never-assembled gate) before merge.

No crates.io publish (`publish = false`): the verifier is distributed as a
reproducible binary whose build is `--locked` against the committed lockfile.

## Judgment calls recorded here

- `chain` expects a **bucket export** laid out as the bucket keys
  (`head/<generation>`, `admissions/<generation>`, `_registry/<version>.json`;
  a trailing `.json` is tolerated). Files must be the stored bytes — a
  pretty-printed copy is refused, because every hash rule is over stored bytes.
- Without a service-key registry in the export, admission-record signatures
  are **unverifiable and that is a failure** unless
  `--allow-unverified-service-signatures` is passed (fail closed by default).
  The registry root signature is verified only when `--registry-root-pubkey`
  is given (the root key is pinned in the signed client, not in this crate).
- `git` compares the **coverage** the protocol defines (canonical refs
  `refs/heads|tags|run402/*` ∪ the HEAD target); non-canonical refs are ignored
  on both sides. Every reachable object is re-hashed here from `cat-file
  --batch` content, so a corrupt object is caught even if git's index says
  otherwise. Git runs argv-only with a cleared environment, no user/system
  config, hooks disabled, replace-objects off.
- The receipt's `implementation_version` is this crate's Cargo version.
