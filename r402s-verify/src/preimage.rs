//! Protocol §1 byte-level rules: `lp` / `lp_opt`, the open-id and open-binding
//! preimages, the two hash rules (stored bytes, signature preimage), and key
//! fingerprints.

use crate::codec::hex;
use crate::json::{jcs, Value};
use sha2::{Digest, Sha256};

pub const PROTO: &str = "r402s/v0";
pub const SUITE: &str = "r402s-1";

/// `lp(x)` = 4-byte big-endian byte length ‖ UTF-8 bytes.
pub fn lp(x: &str) -> Vec<u8> {
    let b = x.as_bytes();
    let mut out = Vec::with_capacity(4 + b.len());
    out.extend_from_slice(&(b.len() as u32).to_be_bytes());
    out.extend_from_slice(b);
    out
}

/// `lp_opt(null)` = `0x00`; `lp_opt(x)` = `0x01 ‖ lp(x)`.
pub fn lp_opt(x: Option<&str>) -> Vec<u8> {
    match x {
        None => vec![0u8],
        Some(s) => {
            let mut out = vec![1u8];
            out.extend_from_slice(&lp(s));
            out
        }
    }
}

pub fn sha256(b: &[u8]) -> [u8; 32] {
    Sha256::digest(b).into()
}

pub fn sha256_hex(b: &[u8]) -> String {
    hex(&sha256(b))
}

pub fn open_id_preimage(org_id: &str, repo_id: &str, client_open_id: &str) -> Vec<u8> {
    let mut out = b"r402s/v0/open-id".to_vec();
    out.extend(lp(org_id));
    out.extend(lp(repo_id));
    out.extend(lp(client_open_id));
    out
}

pub fn open_binding_preimage(
    client_open_id: &str,
    base_head_sha256: &str,
    prior_checkpoint_claim_set_sha256: Option<&str>,
    requested_r2_cap_size_bytes: &str,
) -> Vec<u8> {
    let mut out = b"r402s/v0/open-binding".to_vec();
    out.extend(lp(client_open_id));
    out.extend(lp(base_head_sha256));
    out.extend(lp_opt(prior_checkpoint_claim_set_sha256));
    out.extend(lp(requested_r2_cap_size_bytes));
    out
}

/// Signature preimage = `"r402s/v0/" + object_kind + "\n" + JCS(object without signature)`.
pub fn signature_preimage(object_kind: &str, obj_without_signature: &Value) -> Vec<u8> {
    let mut out = format!("r402s/v0/{object_kind}\n").into_bytes();
    out.extend(jcs(obj_without_signature));
    out
}

/// Stored bytes of a signed object = JCS of the COMPLETE object including `signature`.
pub fn stored_bytes(obj: &Value) -> Vec<u8> {
    jcs(obj)
}

pub fn stored_bytes_sha256(obj: &Value) -> String {
    sha256_hex(&stored_bytes(obj))
}

/// Key fingerprint body = first 16 bytes of SHA-256(raw pubkey), lowercase hex.
pub fn key_fingerprint(raw_pubkey: &[u8]) -> String {
    hex(&sha256(raw_pubkey)[..16])
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::codec::unhex;

    #[test]
    fn lp_shapes() {
        assert_eq!(lp("o"), vec![0, 0, 0, 1, b'o']);
        assert_eq!(lp_opt(None), vec![0]);
        assert_eq!(lp_opt(Some("a")), vec![1, 0, 0, 0, 1, b'a']);
    }

    /// The reviewer-pinned golden digest (vectors `gold-002`): null prior, 134-byte preimage.
    #[test]
    fn golden_open_binding_null_prior() {
        let pre = open_binding_preimage(
            "cccccccccccccccccccccccccccccccc",
            &"a".repeat(64),
            None,
            "1000",
        );
        assert_eq!(pre.len(), 134);
        assert_eq!(
            sha256_hex(&pre),
            "d69b05c783720b1164e9e838a23a8ac39358daf41d5928648c7d961ec14bc786"
        );
        let _ = unhex(&sha256_hex(&pre)).unwrap();
    }
}
