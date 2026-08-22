//! `verifier_receipt` (protocol §4.10; schema `verifier_receipt.json`):
//! the signed record a verifier emits after a restore-and-verify run.
//! `implementation_id` is the CLOSED V0 identity set — this crate is
//! `"r402s-verify"`. `restored_object_set_hmac` MUST equal the checkpoint
//! manifest's `object_set_hmac` (same `"objectset"` label, same content).

use crate::codec::{b64u, hex, unb64u, unhex};
use crate::json::{strict_parse, Value};
use crate::preimage::{stored_bytes, stored_bytes_sha256};
use crate::schema::SchemaSet;
use crate::sig::{public_key_from_seed, sign_object, verify_signed_object};

pub struct ReceiptInput {
    pub repo_id: String,
    pub intent_core_sha256: String,
    pub checkpoint_head_sha256: String,
    pub cutoff_ticket_sha256: Option<String>,
    pub restored_object_set_hmac: String,
    pub retention_evolution_ok: bool,
    pub candidates_outside_roots_ok: bool,
    pub result: String,
    /// Caller-supplied `vr_` id; if None a CSPRNG id is minted.
    pub object_id: Option<String>,
}

/// Load a 32-byte Ed25519 seed from a file holding lowercase hex or base64url (whitespace-trimmed).
pub fn load_seed(path: &std::path::Path) -> Result<[u8; 32], String> {
    let t = std::fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))?;
    let t = t.trim();
    let raw = if t.len() == 64 { unhex(t)? } else { unb64u(t)? };
    raw.as_slice()
        .try_into()
        .map_err(|_| "seed must be 32 bytes".to_string())
}

pub fn mint_object_id() -> Result<String, String> {
    let mut b = [0u8; 16];
    getrandom::fill(&mut b).map_err(|e| format!("csprng: {e}"))?;
    Ok(format!("vr_{}", hex(&b)))
}

/// Build + sign the receipt; returns the complete object (stored bytes = `jcs(obj)`).
pub fn emit(
    inp: &ReceiptInput,
    seed: &[u8; 32],
    schemas: Option<&SchemaSet>,
) -> Result<Value, String> {
    let object_id = match &inp.object_id {
        Some(x) => x.clone(),
        None => mint_object_id()?,
    };
    let body = Value::obj(&[
        ("format", Value::s("r402s/v0")),
        ("object_kind", Value::s("verifier_receipt")),
        ("suite", Value::s("r402s-1")),
        ("repo_id", Value::s(&inp.repo_id)),
        ("object_id", Value::s(&object_id)),
        ("intent_core_sha256", Value::s(&inp.intent_core_sha256)),
        (
            "checkpoint_head_sha256",
            Value::s(&inp.checkpoint_head_sha256),
        ),
        (
            "cutoff_ticket_sha256",
            inp.cutoff_ticket_sha256
                .as_deref()
                .map(Value::s)
                .unwrap_or(Value::Null),
        ),
        (
            "restored_object_set_hmac",
            Value::s(&inp.restored_object_set_hmac),
        ),
        (
            "retention_evolution_ok",
            Value::Bool(inp.retention_evolution_ok),
        ),
        (
            "candidates_outside_roots_ok",
            Value::Bool(inp.candidates_outside_roots_ok),
        ),
        ("implementation_id", Value::s(crate::IMPLEMENTATION_ID)),
        (
            "implementation_version",
            Value::s(crate::IMPLEMENTATION_VERSION),
        ),
        ("result", Value::s(&inp.result)),
    ]);
    let sig = sign_object(seed, "verifier_receipt", &body);
    let obj = body.with("signature", Value::s(&b64u(&sig)));
    if let Some(s) = schemas {
        match s.is_valid("verifier_receipt.json", &obj) {
            Ok(true) => {}
            Ok(false) => {
                return Err(
                    "the emitted receipt does not validate against verifier_receipt.json".into(),
                )
            }
            Err(e) => return Err(format!("schema error: {e}")),
        }
    }
    // self-check before handing the bytes out
    if !verify_signed_object(&obj, &b64u(&public_key_from_seed(seed)), None) {
        return Err("self-verification of the emitted receipt failed".into());
    }
    Ok(obj)
}

pub struct CheckReport {
    pub stored_bytes_sha256: String,
    pub failures: Vec<String>,
}

/// Check a receipt's stored bytes: strict parse, schema, signature under `pubkey_b64u`.
pub fn check(bytes: &[u8], pubkey_b64u: &str, schemas: Option<&SchemaSet>) -> CheckReport {
    let mut failures = Vec::new();
    let obj = match strict_parse(bytes) {
        Ok(o) => o,
        Err(e) => {
            return CheckReport {
                stored_bytes_sha256: crate::preimage::sha256_hex(bytes),
                failures: vec![format!("not stored bytes: {e}")],
            };
        }
    };
    if obj.get("object_kind").and_then(Value::as_str) != Some("verifier_receipt") {
        failures.push("object_kind is not verifier_receipt".into());
    }
    if let Some(s) = schemas {
        match s.is_valid("verifier_receipt.json", &obj) {
            Ok(true) => {}
            Ok(false) => failures.push("schema reject".into()),
            Err(e) => failures.push(format!("schema error: {e}")),
        }
    }
    if !verify_signed_object(&obj, pubkey_b64u, None) {
        failures.push("signature does not verify (strict Ed25519, domain verifier_receipt)".into());
    }
    if obj.get("implementation_id").and_then(Value::as_str) != Some(crate::IMPLEMENTATION_ID)
        && obj.get("implementation_id").and_then(Value::as_str) != Some("run402-cli")
    {
        failures.push("implementation_id outside the closed V0 set".into());
    }
    debug_assert_eq!(stored_bytes(&obj), bytes);
    CheckReport {
        stored_bytes_sha256: stored_bytes_sha256(&obj),
        failures,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn emit_then_check() {
        let seed = [11u8; 32];
        let inp = ReceiptInput {
            repo_id: "src_00000000000000000000000000000000".into(),
            intent_core_sha256: "0".repeat(64),
            checkpoint_head_sha256: "1".repeat(64),
            cutoff_ticket_sha256: None,
            restored_object_set_hmac: "2".repeat(64),
            retention_evolution_ok: true,
            candidates_outside_roots_ok: true,
            result: "restored_and_verified".into(),
            object_id: Some("vr_00000000000000000000000000000000".into()),
        };
        let obj = emit(&inp, &seed, None).unwrap();
        let bytes = stored_bytes(&obj);
        let pk = b64u(&public_key_from_seed(&seed));
        assert!(check(&bytes, &pk, None).failures.is_empty());
        let mut tampered = bytes.clone();
        let i = tampered.iter().position(|&b| b == b'2').unwrap();
        tampered[i] = b'3';
        assert!(!check(&tampered, &pk, None).failures.is_empty());
        assert!(mint_object_id().unwrap().starts_with("vr_"));
    }
}
