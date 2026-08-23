//! `r402s-verify` — the INDEPENDENT-lineage verifier for the gitvault
//! `r402s/v0` protocol (task 5.9). It never imports the SDK; its HPKE is the
//! task-1.0 second implementation (rozbb/rust-hpke 0.14, D182).
//!
//! Module map (each one is a protocol section made executable):
//! - `json`        — strict I-JSON front-end + JCS (§1)
//! - `codec`       — lowercase hex + canonical base64url (§1)
//! - `preimage`    — `lp`/`lp_opt`, open-id/open-binding preimages, the two hash rules (§1)
//! - `sig`         — Ed25519 strict RFC 8032, `zip215:false` (§1/§2)
//! - `kdf`         — `k_obj` / `K_digest` / keyed commitments (§1/§2)
//! - `frame`       — XChaCha20-Poly1305 framing (§2)
//! - `hpke_envelope` — the `key_envelope` HPKE through rust-hpke, never assembled (§2/§4.8)
//! - `timestamp`   — calendar-semantic RFC 3339 (§1, D187)
//! - `schema`      — the JSON-Schema subset the protocol's schema set uses
//! - `vectors`     — replay of `vectors.json` + `hpke-interop/golden.json` (§12)
//! - `chain`       — heads + admission records + generation continuity + transition fail-closed (§4/§5A)
//! - `gitdiff`     — differential git validation (§4.7 acceptance, §6.6)
//! - `receipt`     — `verifier_receipt` emission + check (§4.10)

pub mod chain;
pub mod codec;
pub mod frame;
pub mod gitdiff;
pub mod hpke_envelope;
pub mod json;
pub mod kdf;
pub mod preimage;
pub mod receipt;
pub mod schema;
pub mod sig;
pub mod timestamp;
pub mod vectors;

pub const IMPLEMENTATION_ID: &str = "r402s-verify";
pub const IMPLEMENTATION_VERSION: &str = env!("CARGO_PKG_VERSION");
/// The protocol revision this verifier was written against.
pub const PROTOCOL_REVISION: &str = "41";
