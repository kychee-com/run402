//! HKDF-SHA-256 derivations of protocol §1/§2 (`k_obj`, `K_digest`) and the
//! keyed commitments `HMAC-SHA-256(K_digest(label), JCS(content))`.
//!
//! These are protocol-level KDF uses, NOT the HPKE KDF — HPKE is never
//! assembled here (D38); see `hpke_envelope.rs`.

use crate::codec::hex;
use crate::json::{jcs, Value};
use crate::preimage::{lp, PROTO, SUITE};
use hkdf::Hkdf;
use hmac::{Hmac, Mac};
use sha2::Sha256;

/// RFC 5869 HKDF-SHA-256 with an EMPTY salt (= 32 zero bytes), 32-byte output.
pub fn hkdf_sha256_32(ikm: &[u8], info: &[u8]) -> [u8; 32] {
    let hk = Hkdf::<Sha256>::new(None, ikm);
    let mut okm = [0u8; 32];
    hk.expand(info, &mut okm)
        .expect("32 bytes is a legal HKDF length");
    okm
}

/// `k_obj` info: `lp("r402s/v0") ‖ lp(suite) ‖ lp(repo_id) ‖ lp(epoch) ‖ lp(object_kind) ‖ lp(object_id) ‖ lp("L=32")`.
pub fn k_obj_info(repo_id: &str, epoch: &str, object_kind: &str, object_id: &str) -> Vec<u8> {
    [PROTO, SUITE, repo_id, epoch, object_kind, object_id, "L=32"]
        .iter()
        .flat_map(|s| lp(s))
        .collect()
}

/// `K_digest` info: `lp("r402s/v0") ‖ lp("r402s-1") ‖ lp(repo_id) ‖ lp(epoch) ‖ lp("digest") ‖ lp(label) ‖ lp("L=32")`.
pub fn k_digest_info(repo_id: &str, epoch: &str, label: &str) -> Vec<u8> {
    [PROTO, SUITE, repo_id, epoch, "digest", label, "L=32"]
        .iter()
        .flat_map(|s| lp(s))
        .collect()
}

pub fn k_obj(
    k_repo: &[u8],
    repo_id: &str,
    epoch: &str,
    object_kind: &str,
    object_id: &str,
) -> [u8; 32] {
    hkdf_sha256_32(k_repo, &k_obj_info(repo_id, epoch, object_kind, object_id))
}

pub fn k_digest(k_repo: &[u8], repo_id: &str, epoch: &str, label: &str) -> [u8; 32] {
    hkdf_sha256_32(k_repo, &k_digest_info(repo_id, epoch, label))
}

pub fn hmac_sha256(key: &[u8], msg: &[u8]) -> [u8; 32] {
    let mut m = Hmac::<Sha256>::new_from_slice(key).expect("HMAC accepts any key length");
    m.update(msg);
    m.finalize().into_bytes().into()
}

/// Commitment = `HMAC-SHA-256(K_digest(label), JCS(content))`, lowercase hex.
pub fn keyed_commitment(k_digest: &[u8], content: &Value) -> String {
    hex(&hmac_sha256(k_digest, &jcs(content)))
}

/// The `"objectset"` content shape: `{"oids":[sorted unique lowercase 40-hex]}`.
pub fn objectset_content(oids: &[String]) -> Value {
    let mut v: Vec<String> = oids.to_vec();
    v.sort();
    v.dedup();
    Value::obj(&[("oids", Value::Arr(v.into_iter().map(Value::Str).collect()))])
}

#[cfg(test)]
mod tests {
    use super::*;

    /// RFC 5869 A.1 test case 1 (sanity for the HKDF crate wiring, with a real salt).
    #[test]
    fn rfc5869_a1() {
        let ikm = [0x0b; 22];
        let salt: Vec<u8> = (0u8..13).collect();
        let info: Vec<u8> = (0xf0u8..=0xf9).collect();
        let hk = Hkdf::<Sha256>::new(Some(&salt), &ikm);
        let mut okm = [0u8; 42];
        hk.expand(&info, &mut okm).unwrap();
        assert_eq!(
            hex(&okm),
            "3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865"
        );
    }

    #[test]
    fn empty_salt_is_zero_salt() {
        let a = hkdf_sha256_32(b"k", b"i");
        let hk = Hkdf::<Sha256>::new(Some(&[0u8; 32]), b"k");
        let mut b = [0u8; 32];
        hk.expand(b"i", &mut b).unwrap();
        assert_eq!(a, b);
    }
}
