//! Lowercase hex and canonical base64url (no padding) — the two scalar
//! encodings of protocol §1. Both decoders are STRICT: non-lowercase hex and
//! any non-canonical base64url (padding, length mod 4 == 1, nonzero trailing
//! bits) are refusals, never silent normalization.

pub fn hex(b: &[u8]) -> String {
    const T: &[u8; 16] = b"0123456789abcdef";
    let mut s = String::with_capacity(b.len() * 2);
    for &x in b {
        s.push(T[(x >> 4) as usize] as char);
        s.push(T[(x & 15) as usize] as char);
    }
    s
}

/// Decode LOWERCASE hex only (protocol §1: non-lowercase hex is a reject).
pub fn unhex(s: &str) -> Result<Vec<u8>, String> {
    if s.len() % 2 != 0 {
        return Err("odd-length hex".into());
    }
    let mut out = Vec::with_capacity(s.len() / 2);
    let b = s.as_bytes();
    for i in (0..b.len()).step_by(2) {
        let nib = |c: u8| -> Result<u8, String> {
            match c {
                b'0'..=b'9' => Ok(c - b'0'),
                b'a'..=b'f' => Ok(c - b'a' + 10),
                _ => Err(format!("non-lowercase-hex byte {c:#x}")),
            }
        };
        out.push((nib(b[i])? << 4) | nib(b[i + 1])?);
    }
    Ok(out)
}

const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

pub fn b64u(b: &[u8]) -> String {
    let mut s = String::with_capacity(b.len().div_ceil(3) * 4);
    for chunk in b.chunks(3) {
        let n = match chunk.len() {
            3 => ((chunk[0] as u32) << 16) | ((chunk[1] as u32) << 8) | chunk[2] as u32,
            2 => ((chunk[0] as u32) << 16) | ((chunk[1] as u32) << 8),
            _ => (chunk[0] as u32) << 16,
        };
        s.push(B64[(n >> 18) as usize & 63] as char);
        s.push(B64[(n >> 12) as usize & 63] as char);
        if chunk.len() > 1 {
            s.push(B64[(n >> 6) as usize & 63] as char);
        }
        if chunk.len() > 2 {
            s.push(B64[n as usize & 63] as char);
        }
    }
    s
}

fn b64_val(c: u8) -> Option<u32> {
    match c {
        b'A'..=b'Z' => Some((c - b'A') as u32),
        b'a'..=b'z' => Some((c - b'a') as u32 + 26),
        b'0'..=b'9' => Some((c - b'0') as u32 + 52),
        b'-' => Some(62),
        b'_' => Some(63),
        _ => None,
    }
}

/// Canonical base64url decode: alphabet only, no padding, length mod 4 != 1,
/// and decode->encode round-trips byte-for-byte (zero trailing bits).
pub fn unb64u(s: &str) -> Result<Vec<u8>, String> {
    if s.len() % 4 == 1 {
        return Err("base64url length mod 4 == 1".into());
    }
    let mut out = Vec::with_capacity(s.len() * 3 / 4);
    let b = s.as_bytes();
    let mut i = 0;
    while i < b.len() {
        let take = (b.len() - i).min(4);
        let mut n: u32 = 0;
        for k in 0..4 {
            n <<= 6;
            if k < take {
                n |= b64_val(b[i + k]).ok_or_else(|| "base64url alphabet".to_string())?;
            }
        }
        out.push((n >> 16) as u8);
        if take > 2 {
            out.push((n >> 8) as u8);
        }
        if take > 3 {
            out.push(n as u8);
        }
        i += take;
    }
    if b64u(&out) != s {
        return Err("noncanonical base64url (padding or nonzero trailing bits)".into());
    }
    Ok(out)
}

pub fn b64u_is_canonical(s: &str) -> bool {
    unb64u(s).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip() {
        for n in 0..40usize {
            let v: Vec<u8> = (0..n as u8).map(|i| i.wrapping_mul(37)).collect();
            assert_eq!(unb64u(&b64u(&v)).unwrap(), v);
            assert_eq!(unhex(&hex(&v)).unwrap(), v);
        }
    }

    #[test]
    fn strictness() {
        assert!(unb64u("AA==").is_err());
        assert!(unb64u("A").is_err());
        assert!(unb64u("AB").is_err()); // trailing bits nonzero
        assert!(unb64u("AA").is_ok());
        assert!(unhex("AB").is_err());
        assert!(unhex("ab").is_ok());
    }
}
