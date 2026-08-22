//! Ed25519 **strict RFC 8032** (`zip215:false`).
//!
//! `ed25519_dalek::VerifyingKey::verify_strict` rejects non-canonical `S`
//! (`S >= L`), small-order `R`, small-order / non-canonical `A`, and it
//! recomputes `R' = S·B − k·A` and compares the COMPRESSED encodings bytewise
//! — so a ZIP215-only signature whose `R` is a non-canonical encoding of the
//! identity (vector `zip215-002`) is refused on two independent grounds.
//! Every r402s component pins this profile; a ZIP215 verifier is never used.

use crate::codec::unb64u;
use crate::json::Value;
use crate::preimage::signature_preimage;
use ed25519_dalek::{Signature, SigningKey, VerifyingKey};

/// Strict verify over raw bytes. Wrong-length inputs are refusals, not panics.
pub fn verify_strict(pubkey: &[u8], msg: &[u8], sig: &[u8]) -> bool {
    let pk: [u8; 32] = match pubkey.try_into() {
        Ok(p) => p,
        Err(_) => return false,
    };
    let sg: [u8; 64] = match sig.try_into() {
        Ok(s) => s,
        Err(_) => return false,
    };
    let vk = match VerifyingKey::from_bytes(&pk) {
        Ok(k) => k,
        Err(_) => return false,
    };
    vk.verify_strict(msg, &Signature::from_bytes(&sg)).is_ok()
}

/// Verify a signed protocol object: the `signature` member (base64url, 64 bytes)
/// over `"r402s/v0/" + kind + "\n" + JCS(object minus signature)`.
/// `kind` defaults to the object's own `object_kind`.
pub fn verify_signed_object(obj: &Value, pubkey_b64u: &str, kind: Option<&str>) -> bool {
    let kind = match kind.or_else(|| obj.get("object_kind").and_then(Value::as_str)) {
        Some(k) => k,
        None => return false,
    };
    let sig = match obj
        .get("signature")
        .and_then(Value::as_str)
        .and_then(|s| unb64u(s).ok())
    {
        Some(s) => s,
        None => return false,
    };
    let pk = match unb64u(pubkey_b64u) {
        Ok(p) => p,
        Err(_) => return false,
    };
    let pre = signature_preimage(kind, &obj.without("signature"));
    verify_strict(&pk, &pre, &sig)
}

/// Sign an object (without `signature`) under its domain; returns the 64-byte signature.
pub fn sign_object(seed: &[u8; 32], kind: &str, obj_without_signature: &Value) -> [u8; 64] {
    let sk = SigningKey::from_bytes(seed);
    use ed25519_dalek::Signer;
    sk.sign(&signature_preimage(kind, obj_without_signature))
        .to_bytes()
}

pub fn public_key_from_seed(seed: &[u8; 32]) -> [u8; 32] {
    SigningKey::from_bytes(seed).verifying_key().to_bytes()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sign_verify_roundtrip_and_domain_separation() {
        let seed = [7u8; 32];
        let obj = Value::obj(&[
            ("format", Value::s("r402s/v0")),
            ("object_kind", Value::s("head")),
        ]);
        let sig = sign_object(&seed, "head", &obj);
        let pk = public_key_from_seed(&seed);
        let signed = obj.with("signature", Value::s(&crate::codec::b64u(&sig)));
        assert!(verify_signed_object(
            &signed,
            &crate::codec::b64u(&pk),
            None
        ));
        assert!(!verify_signed_object(
            &signed,
            &crate::codec::b64u(&pk),
            Some("vault_genesis")
        ));
    }

    #[test]
    fn noncanonical_s_is_rejected() {
        let seed = [9u8; 32];
        let msg = b"m";
        let sk = SigningKey::from_bytes(&seed);
        use ed25519_dalek::Signer;
        let mut sig = sk.sign(msg).to_bytes();
        // L = 2^252 + 27742317777372353535851937790883648493 (little-endian below)
        const L: [u8; 32] = [
            0xed, 0xd3, 0xf5, 0x5c, 0x1a, 0x63, 0x12, 0x58, 0xd6, 0x9c, 0xf7, 0xa2, 0xde, 0xf9,
            0xde, 0x14, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x10,
        ];
        // S + L (no overflow past 2^256 for a canonical S < L)
        let mut carry = 0u16;
        for i in 0..32 {
            let v = sig[32 + i] as u16 + L[i] as u16 + carry;
            sig[32 + i] = v as u8;
            carry = v >> 8;
        }
        let pk = sk.verifying_key().to_bytes();
        assert!(!verify_strict(&pk, msg, &sig));
    }
}
