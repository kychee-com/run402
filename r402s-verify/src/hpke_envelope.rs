//! The `key_envelope` HPKE (suite `r402s-1`) through the task-1.0 second
//! implementation: **rozbb/rust-hpke 0.14** (D182).
//!
//! NEVER ASSEMBLED (D38 / acceptance rule 3): every seal/open/export in this
//! crate goes through `hpke::setup_sender_with_rng` / `hpke::setup_receiver`
//! with `Kem = X25519HkdfSha256`, `Kdf = HkdfSha256`, `Aead = ChaCha20Poly1305`,
//! `OpMode::Base`. This module imports NOTHING but the `hpke` crate (plus the
//! protocol's own preimage/JCS helpers); the CI gate
//! `scripts/never-assembled-gate.sh` rejects any `x25519_dalek`, `hkdf` or
//! `chacha20poly1305` import here.
//!
//! Deterministic reproduction of a vector's `enc`/`ct` from its carried `ikmE`:
//! rust-hpke exposes no ephemeral-key injection point, but its own
//! `Kem::gen_keypair_with_rng` is defined as *fill 32 bytes from the RNG, then
//! `derive_keypair(ikm)`* — so an RNG whose output is exactly the 32 `ikmE`
//! bytes makes the library compute `DeriveKeyPair(ikmE)` itself (RFC 9180
//! §7.1.3), through its public `setup_sender_with_rng`. Nothing of HPKE is
//! re-implemented; the RNG is the only thing we supply. A randomized seal
//! (`seal`) is what a production sealer would use.
//!
//! Protocol §2 exact bytes (D188):
//! ```text
//! info = lp("r402s/v0/envelope") ‖ lp("r402s-1")
//!      ‖ lp(lowerhex(SHA-256(recipient_x25519_public_key_raw_32)))   // 64 ASCII hex chars
//!      ‖ lp(created_by)                                              // the FULL "vk_…" scalar
//! aad  = JCS({repo_id, epoch, recipient_kind:"principal", recipient_fingerprint})
//! pt   = the raw 32-byte K_repo; ct = 48 bytes; enc = 32-byte ephemeral pubkey
//! ```

use crate::json::{jcs, Value};
use crate::preimage::{lp, sha256_hex, SUITE};
use hpke::aead::ChaCha20Poly1305;
use hpke::kdf::HkdfSha256;
use hpke::kem::X25519HkdfSha256;
use hpke::rand_core::{Infallible, TryCryptoRng, TryRng};
use hpke::{Deserializable, Kem as KemTrait, OpModeR, OpModeS, Serializable};

pub type Kem = X25519HkdfSha256;
pub type Kdf = HkdfSha256;
pub type Aead = ChaCha20Poly1305;
pub type PublicKey = <Kem as KemTrait>::PublicKey;
pub type PrivateKey = <Kem as KemTrait>::PrivateKey;
pub type EncappedKey = <Kem as KemTrait>::EncappedKey;
pub type SenderCtx = hpke::aead::AeadCtxS<Aead, Kdf, Kem>;
pub type ReceiverCtx = hpke::aead::AeadCtxR<Aead, Kdf, Kem>;

pub const ENVELOPE_LABEL: &str = "r402s/v0/envelope";

/// A one-shot "RNG" that hands the library exactly the keying material it
/// will feed to its own `derive_keypair` (see the module docs). It is NOT a
/// random source and must never be used outside vector reproduction.
pub struct IkmRng {
    ikm: Vec<u8>,
    pos: usize,
}

impl IkmRng {
    pub fn new(ikm: &[u8]) -> Self {
        IkmRng {
            ikm: ikm.to_vec(),
            pos: 0,
        }
    }
}

impl TryRng for IkmRng {
    type Error = Infallible;
    fn try_next_u32(&mut self) -> Result<u32, Infallible> {
        let mut b = [0u8; 4];
        self.try_fill_bytes(&mut b)?;
        Ok(u32::from_le_bytes(b))
    }
    fn try_next_u64(&mut self) -> Result<u64, Infallible> {
        let mut b = [0u8; 8];
        self.try_fill_bytes(&mut b)?;
        Ok(u64::from_le_bytes(b))
    }
    fn try_fill_bytes(&mut self, dst: &mut [u8]) -> Result<(), Infallible> {
        for d in dst.iter_mut() {
            // past the end of the supplied material, hand out zeros — the library asks
            // for exactly Nsk bytes once, so this branch is never taken in practice
            *d = self.ikm.get(self.pos).copied().unwrap_or(0);
            self.pos += 1;
        }
        Ok(())
    }
}
impl TryCryptoRng for IkmRng {}

pub fn envelope_info(recipient_pk_raw: &[u8], created_by: &str) -> Vec<u8> {
    let mut out = lp(ENVELOPE_LABEL);
    out.extend(lp(SUITE));
    out.extend(lp(&sha256_hex(recipient_pk_raw)));
    out.extend(lp(created_by));
    out
}

pub fn envelope_aad(repo_id: &str, epoch: &str, recipient_fingerprint: &str) -> Vec<u8> {
    jcs(&Value::obj(&[
        ("repo_id", Value::s(repo_id)),
        ("epoch", Value::s(epoch)),
        ("recipient_kind", Value::s("principal")),
        ("recipient_fingerprint", Value::s(recipient_fingerprint)),
    ]))
}

/// RFC 9180 §7.1.3 `DeriveKeyPair(ikm)` for DHKEM(X25519, HKDF-SHA256), via the library.
pub fn derive_keypair(ikm: &[u8]) -> (PrivateKey, PublicKey) {
    Kem::derive_keypair(ikm)
}

pub fn pk_from_bytes(b: &[u8]) -> Result<PublicKey, String> {
    PublicKey::from_bytes(b).map_err(|e| format!("X25519 public key: {e:?}"))
}

pub fn sk_from_bytes(b: &[u8]) -> Result<PrivateKey, String> {
    PrivateKey::from_bytes(b).map_err(|e| format!("X25519 private key: {e:?}"))
}

pub fn sk_to_pk(sk: &PrivateKey) -> PublicKey {
    Kem::sk_to_pk(sk)
}

pub fn pk_bytes(pk: &PublicKey) -> Vec<u8> {
    pk.to_bytes().to_vec()
}

pub fn sk_bytes(sk: &PrivateKey) -> Vec<u8> {
    sk.to_bytes().to_vec()
}

/// Deterministic sender setup reproducing `DeriveKeyPair(ikmE)` (vector replay only).
pub fn setup_sender_with_ikm(
    pk_recip: &PublicKey,
    info: &[u8],
    ikm_e: &[u8],
) -> Result<(Vec<u8>, SenderCtx), String> {
    let mut rng = IkmRng::new(ikm_e);
    let (enc, ctx) =
        hpke::setup_sender_with_rng::<Aead, Kdf, Kem>(&OpModeS::Base, pk_recip, info, &mut rng)
            .map_err(|e| format!("setup_sender: {e:?}"))?;
    Ok((enc.to_bytes().to_vec(), ctx))
}

pub fn setup_receiver(
    sk_recip: &PrivateKey,
    enc: &[u8],
    info: &[u8],
) -> Result<ReceiverCtx, String> {
    let enc = EncappedKey::from_bytes(enc).map_err(|e| format!("enc: {e:?}"))?;
    hpke::setup_receiver::<Aead, Kdf, Kem>(&OpModeR::Base, sk_recip, &enc, info)
        .map_err(|e| format!("setup_receiver: {e:?}"))
}

/// Seal `K_repo` for a recipient, deterministically from `ikmE`. Returns `(enc, ct)`.
pub fn seal_with_ikm(
    pk_recip: &PublicKey,
    info: &[u8],
    aad: &[u8],
    k_repo: &[u8],
    ikm_e: &[u8],
) -> Result<(Vec<u8>, Vec<u8>), String> {
    let (enc, mut ctx) = setup_sender_with_ikm(pk_recip, info, ikm_e)?;
    let ct = ctx.seal(k_repo, aad).map_err(|e| format!("seal: {e:?}"))?;
    Ok((enc, ct))
}

/// Randomized seal (what a production sealer does): ephemeral from the OS CSPRNG.
pub fn seal(
    pk_recip: &PublicKey,
    info: &[u8],
    aad: &[u8],
    k_repo: &[u8],
) -> Result<(Vec<u8>, Vec<u8>), String> {
    let mut ikm = [0u8; 32];
    getrandom::fill(&mut ikm).map_err(|e| format!("csprng: {e}"))?;
    seal_with_ikm(pk_recip, info, aad, k_repo, &ikm)
}

/// Single-shot open. `None` on ANY failure (never a garbage plaintext).
pub fn open(
    sk_recip: &PrivateKey,
    enc: &[u8],
    info: &[u8],
    aad: &[u8],
    ct: &[u8],
) -> Option<Vec<u8>> {
    let mut ctx = setup_receiver(sk_recip, enc, info).ok()?;
    ctx.open(ct, aad).ok()
}

/// Open a signed, ALREADY-VERIFIED `key_envelope` object for the recipient
/// whose raw X25519 public key is `recipient_pk_raw`. The caller MUST verify
/// the envelope signature first (protocol §4.8: signature-before-open).
pub fn open_envelope_object(
    env: &Value,
    recipient_pk_raw: &[u8],
    sk: &PrivateKey,
) -> Option<Vec<u8>> {
    let info = envelope_info(recipient_pk_raw, env.get("created_by")?.as_str()?);
    let aad = envelope_aad(
        env.get("repo_id")?.as_str()?,
        env.get("epoch")?.as_str()?,
        env.get("recipient_fingerprint")?.as_str()?,
    );
    let enc = crate::codec::unb64u(env.get("enc")?.as_str()?).ok()?;
    let ct = crate::codec::unb64u(env.get("ct")?.as_str()?).ok()?;
    open(sk, &enc, &info, &aad, &ct)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::codec::{hex, unhex};

    /// RFC 9180 Appendix A.2.1 (Base, DHKEM(X25519), HKDF-SHA256, ChaCha20-Poly1305):
    /// DeriveKeyPair + enc + the first encryption + the three exports, transcribed from the RFC.
    #[test]
    fn rfc9180_a2_1_base() {
        let ikm_e =
            unhex("909a9b35d3dc4713a5e72a4da274b55d3d3821a37e5d099e74a647db583a904b").unwrap();
        let ikm_r =
            unhex("1ac01f181fdf9f352797655161c58b75c656a6cc2716dcb66372da835542e1df").unwrap();
        let info = unhex("4f6465206f6e2061204772656369616e2055726e").unwrap();
        let (sk_e, pk_e) = derive_keypair(&ikm_e);
        let (sk_r, pk_r) = derive_keypair(&ikm_r);
        assert_eq!(
            hex(&pk_bytes(&pk_e)),
            "1afa08d3dec047a643885163f1180476fa7ddb54c6a8029ea33f95796bf2ac4a"
        );
        assert_eq!(
            hex(&sk_bytes(&sk_e)),
            "f4ec9b33b792c372c1d2c2063507b684ef925b8c75a42dbcbf57d63ccd381600"
        );
        assert_eq!(
            hex(&pk_bytes(&pk_r)),
            "4310ee97d88cc1f088a5576c77ab0cf5c3ac797f3d95139c6c84b5429c59662a"
        );
        assert_eq!(
            hex(&sk_bytes(&sk_r)),
            "8057991eef8f1f1af18f4a9491d16a1ce333f695d4db8e38da75975c4478e0fb"
        );
        let (enc, mut ctx) = setup_sender_with_ikm(&pk_r, &info, &ikm_e).unwrap();
        assert_eq!(
            hex(&enc),
            "1afa08d3dec047a643885163f1180476fa7ddb54c6a8029ea33f95796bf2ac4a"
        );
        let pt = unhex("4265617574792069732074727574682c20747275746820626561757479").unwrap();
        let ct0 = ctx.seal(&pt, b"Count-0").unwrap();
        assert_eq!(
            hex(&ct0),
            "1c5250d8034ec2b784ba2cfd69dbdb8af406cfe3ff938e131f0def8c8b60b4db21993c62ce81883d2dd1b51a28"
        );
        let mut ex = [0u8; 32];
        ctx.export(b"", &mut ex).unwrap();
        assert_eq!(
            hex(&ex),
            "4bbd6243b8bb54cec311fac9df81841b6fd61f56538a775e7c80a9f40160606e"
        );
        ctx.export(b"TestContext", &mut ex).unwrap();
        assert_eq!(
            hex(&ex),
            "5acb09211139c43b3090489a9da433e8a30ee7188ba8b0a9a1ccf0c229283e53"
        );
        let mut rctx = setup_receiver(&sk_r, &enc, &info).unwrap();
        assert_eq!(rctx.open(&ct0, b"Count-0").unwrap(), pt);
    }

    #[test]
    fn tamper_fails_closed() {
        let (sk_r, pk_r) = derive_keypair(&[5u8; 32]);
        let info = envelope_info(&pk_bytes(&pk_r), "vk_00000000000000000000000000000000");
        let aad = envelope_aad("src_0", "0000000000000001", "ek_0");
        let k = [9u8; 32];
        let (enc, ct) = seal(&pk_r, &info, &aad, &k).unwrap();
        assert_eq!(ct.len(), 48);
        assert_eq!(open(&sk_r, &enc, &info, &aad, &ct).unwrap(), k);
        let mut bad = ct.clone();
        bad[0] ^= 1;
        assert!(open(&sk_r, &enc, &info, &aad, &bad).is_none());
        assert!(open(&sk_r, &enc, &info, b"{}", &ct).is_none());
    }
}
