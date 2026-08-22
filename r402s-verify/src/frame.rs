//! Protocol §2 framing for the encrypted stored kinds (`wal_pack`, `ref_state`,
//! `retention_roots`, `checkpoint_manifest`, `checkpoint_pack`):
//!
//! ```text
//! bytes 0–5  "R402S0"   (magic)
//! byte  6    0x01       (suite id)
//! bytes 7–30 nonce      (24 bytes, XChaCha20-Poly1305 IETF)
//! then       ct ‖ tag   (16-byte tag)
//! AAD = JCS({repo_id, object_kind, object_id, epoch, suite, magic:"R402S0", suite_id:"01"})
//! ```
//!
//! XChaCha20-Poly1305 is the bulk AEAD — it is not part of HPKE and is never
//! composed into one (D38).

use crate::json::{jcs, Value};
use crate::preimage::SUITE;
use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};

pub const FRAME_MAGIC: &[u8; 6] = b"R402S0";
pub const FRAME_SUITE_ID: u8 = 0x01;
pub const HEADER_LEN: usize = 31;

pub fn frame_aad(repo_id: &str, object_kind: &str, object_id: &str, epoch: &str) -> Vec<u8> {
    jcs(&Value::obj(&[
        ("repo_id", Value::s(repo_id)),
        ("object_kind", Value::s(object_kind)),
        ("object_id", Value::s(object_id)),
        ("epoch", Value::s(epoch)),
        ("suite", Value::s(SUITE)),
        ("magic", Value::s("R402S0")),
        ("suite_id", Value::s("01")),
    ]))
}

/// Build a complete frame from its parts (used to reproduce vectors and for tests).
pub fn seal_frame(k_obj: &[u8; 32], nonce: &[u8; 24], aad: &[u8], plaintext: &[u8]) -> Vec<u8> {
    let cipher = XChaCha20Poly1305::new(k_obj.into());
    let ct = cipher
        .encrypt(
            XNonce::from_slice(nonce),
            Payload {
                msg: plaintext,
                aad,
            },
        )
        .expect("XChaCha20-Poly1305 seal cannot fail on in-memory input");
    let mut out = Vec::with_capacity(HEADER_LEN + ct.len());
    out.extend_from_slice(FRAME_MAGIC);
    out.push(FRAME_SUITE_ID);
    out.extend_from_slice(nonce);
    out.extend_from_slice(&ct);
    out
}

#[derive(Debug, PartialEq, Eq)]
pub enum FrameError {
    TooShort,
    BadMagic,
    BadSuiteId,
    AuthFailure,
}

/// Open a complete frame: header check (magic, suite id) THEN AEAD open under
/// the given AAD. Any failure is a refusal with no plaintext released.
pub fn open_frame(k_obj: &[u8; 32], aad: &[u8], frame: &[u8]) -> Result<Vec<u8>, FrameError> {
    if frame.len() < HEADER_LEN + 16 {
        return Err(FrameError::TooShort);
    }
    if &frame[..6] != FRAME_MAGIC {
        return Err(FrameError::BadMagic);
    }
    if frame[6] != FRAME_SUITE_ID {
        return Err(FrameError::BadSuiteId);
    }
    let nonce = XNonce::from_slice(&frame[7..31]);
    let cipher = XChaCha20Poly1305::new(k_obj.into());
    cipher
        .decrypt(
            nonce,
            Payload {
                msg: &frame[31..],
                aad,
            },
        )
        .map_err(|_| FrameError::AuthFailure)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_and_aad_binding() {
        let k = [1u8; 32];
        let n = [2u8; 24];
        let aad = frame_aad("src_x", "wal_pack", "wal_y", "0000000000000001");
        let f = seal_frame(&k, &n, &aad, b"hello");
        assert_eq!(open_frame(&k, &aad, &f).unwrap(), b"hello");
        let aad2 = frame_aad("src_x", "wal_pack", "wal_y", "0000000000000002");
        assert_eq!(open_frame(&k, &aad2, &f), Err(FrameError::AuthFailure));
        let mut g = f.clone();
        g[0] ^= 1;
        assert_eq!(open_frame(&k, &aad, &g), Err(FrameError::BadMagic));
    }
}
