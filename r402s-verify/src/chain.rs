//! `r402s-verify chain <dir>` — verify a vault's head chain from a bucket
//! export: `vault_genesis` + every `head/<generation>`, the
//! `admissions/<generation>` records, generation continuity, the V0 epoch
//! pin, and the transition fail-closed rule (protocol §4.2, §4.3, §5A).
//!
//! Expected layout (a mirror of the bucket keys; a trailing `.json` is
//! tolerated on every object):
//! ```text
//! <dir>/head/0000000000000000          # the vault_genesis (stored bytes = JCS)
//! <dir>/head/0000000000000001 …        # heads
//! <dir>/admissions/<generation>        # admission records (service-signed)
//! <dir>/_registry/<version>.json       # service-key registry versions (optional)
//! ```
//! Every file MUST be its stored bytes — strict I-JSON, canonical JCS; a
//! re-serialized or pretty-printed copy is a refusal, because the hash rules
//! are defined over stored bytes.

use crate::codec::unb64u;
use crate::json::{strict_parse, Value};
#[cfg(test)]
use crate::preimage::stored_bytes;
use crate::preimage::{key_fingerprint, stored_bytes_sha256};
use crate::schema::SchemaSet;
use crate::sig::verify_signed_object;
use crate::timestamp::parse_ms;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

pub const V0_EPOCH: &str = "0000000000000001";

#[derive(Debug, Default)]
pub struct ChainReport {
    pub repo_id: String,
    pub newest_generation: Option<String>,
    pub heads_verified: usize,
    pub admissions_verified: usize,
    pub failures: Vec<String>,
    pub warnings: Vec<String>,
}

impl ChainReport {
    pub fn ok(&self) -> bool {
        self.failures.is_empty()
    }
    fn fail(&mut self, m: impl Into<String>) {
        self.failures.push(m.into());
    }
    fn warn(&mut self, m: impl Into<String>) {
        self.warnings.push(m.into());
    }
}

pub struct ChainOptions<'a> {
    pub schemas: Option<&'a SchemaSet>,
    /// The pinned generation a client already materialized (`GENERATION_REGRESSION` below it).
    pub pin_generation: Option<String>,
    /// The registry ROOT key (base64url) pinned in the signed client; verifies each registry version.
    pub registry_root_pubkey: Option<String>,
    /// Downgrade "no registry → admission signatures unverifiable" from failure to warning.
    pub allow_unverified_service_signatures: bool,
}

fn list_generation_files(dir: &Path) -> BTreeMap<u64, PathBuf> {
    let mut out = BTreeMap::new();
    if let Ok(rd) = std::fs::read_dir(dir) {
        for e in rd.flatten() {
            let p = e.path();
            let name = p
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("")
                .to_string();
            let stem = name.strip_suffix(".json").unwrap_or(&name);
            if stem.len() == 16
                && stem
                    .bytes()
                    .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
            {
                if let Ok(g) = u64::from_str_radix(stem, 16) {
                    out.insert(g, p);
                }
            }
        }
    }
    out
}

fn load_stored(path: &Path) -> Result<(Value, Vec<u8>), String> {
    let bytes = std::fs::read(path).map_err(|e| format!("{}: {e}", path.display()))?;
    let v =
        strict_parse(&bytes).map_err(|e| format!("{}: not stored bytes ({e})", path.display()))?;
    Ok((v, bytes))
}

fn sv(v: &Value, k: &str) -> String {
    v.get(k).and_then(Value::as_str).unwrap_or("").to_string()
}

struct Registry {
    version: String,
    entries: Vec<Value>,
}

fn load_registry(dir: &Path, rep: &mut ChainReport, opts: &ChainOptions) -> Option<Registry> {
    let reg_dir = if dir.join("_registry").is_dir() {
        dir.join("_registry")
    } else {
        dir.join("source/_registry")
    };
    let files = list_generation_files(&reg_dir);
    let (version_num, path) = files.iter().next_back()?;
    let (obj, _) = match load_stored(path) {
        Ok(x) => x,
        Err(e) => {
            rep.fail(e);
            return None;
        }
    };
    let version = format!("{version_num:016x}");
    if sv(&obj, "version") != version {
        rep.fail(format!(
            "registry {}: version member {} != file name",
            path.display(),
            sv(&obj, "version")
        ));
    }
    if let Some(s) = opts.schemas {
        if s.has("service_key_registry.json")
            && !s
                .is_valid("service_key_registry.json", &obj)
                .unwrap_or(false)
        {
            rep.fail(format!("registry {}: schema reject", path.display()));
        }
    }
    match &opts.registry_root_pubkey {
        Some(root) => {
            let ok = verify_signed_object(
                &obj.without("registry_root_signature").with(
                    "signature",
                    obj.get("registry_root_signature")
                        .cloned()
                        .unwrap_or(Value::Null),
                ),
                root,
                Some("service_key_registry"),
            );
            if !ok {
                rep.fail(format!("registry {}: registry_root_signature does not verify under the pinned root key", path.display()));
            }
        }
        None => rep.warn("registry root signature NOT verified (no --registry-root-pubkey)"),
    }
    let entries = obj
        .get("entries")
        .and_then(Value::as_arr)
        .map(|a| a.to_vec())
        .unwrap_or_default();
    Some(Registry { version, entries })
}

/// Validity at the frozen admission point: `not_before <= authority_time < not_after`
/// (half-open), evaluated against the entry for `service_key_id`.
fn service_key_for(
    reg: &Registry,
    service_key_id: &str,
    authority_time: &str,
) -> Result<String, String> {
    let e = reg
        .entries
        .iter()
        .find(|e| sv(e, "service_key_id") == service_key_id)
        .ok_or_else(|| {
            format!(
                "service key {service_key_id} not in registry {}",
                reg.version
            )
        })?;
    let t = parse_ms(authority_time).map_err(|e| format!("authority time: {e}"))?;
    let nb = parse_ms(&sv(e, "not_before")).map_err(|e| format!("not_before: {e}"))?;
    if t < nb {
        return Err(format!(
            "{service_key_id}: authority time before not_before"
        ));
    }
    if let Some(na) = e.get("not_after").and_then(Value::as_str) {
        let na = parse_ms(na).map_err(|e| format!("not_after: {e}"))?;
        if t >= na {
            return Err(format!(
                "{service_key_id}: authority time at/after not_after"
            ));
        }
    }
    Ok(sv(e, "public_key"))
}

pub fn verify_chain(dir: &Path, opts: &ChainOptions) -> ChainReport {
    let mut rep = ChainReport::default();
    let heads = list_generation_files(&dir.join("head"));
    if heads.is_empty() {
        rep.fail(format!(
            "no head/<generation> objects under {}",
            dir.display()
        ));
        return rep;
    }
    let registry = load_registry(dir, &mut rep, opts);

    // ---- genesis
    let (g_path, genesis, genesis_bytes) = match heads.get(&0) {
        Some(p) => match load_stored(p) {
            Ok((v, b)) => (p.clone(), v, b),
            Err(e) => {
                rep.fail(e);
                return rep;
            }
        },
        None => {
            rep.fail("no vault_genesis at head/0000000000000000");
            return rep;
        }
    };
    if sv(&genesis, "object_kind") != "vault_genesis" {
        rep.fail(format!(
            "{}: object_kind is not vault_genesis",
            g_path.display()
        ));
    }
    if let Some(s) = opts.schemas {
        match s.is_valid("vault_genesis.json", &genesis) {
            Ok(true) => {}
            Ok(false) => rep.fail("vault_genesis: schema reject"),
            Err(e) => rep.fail(format!("vault_genesis: schema error {e}")),
        }
    }
    let writer_pub = sv(&genesis, "creator_signing_pubkey");
    if !verify_signed_object(&genesis, &writer_pub, None) {
        rep.fail("vault_genesis: self-signature does not verify (strict Ed25519)");
    }
    let writer_key_id = sv(&genesis, "writer_key_id");
    let expect_wk = unb64u(&writer_pub)
        .map(|b| format!("vk_{}", key_fingerprint(&b)))
        .unwrap_or_default();
    if expect_wk != writer_key_id {
        rep.fail(format!("vault_genesis: writer_key_id {writer_key_id} != vk_fingerprint(creator_signing_pubkey) {expect_wk}"));
    }
    let env0 = genesis
        .get("envelopes")
        .and_then(Value::as_arr)
        .and_then(|a| a.first())
        .cloned()
        .unwrap_or(Value::Null);
    let expect_ek = unb64u(&sv(&genesis, "creator_encryption_pubkey"))
        .map(|b| format!("ek_{}", key_fingerprint(&b)))
        .unwrap_or_default();
    if sv(&env0, "recipient_fingerprint") != expect_ek
        || sv(&env0, "epoch") != sv(&genesis, "epoch")
    {
        rep.fail("vault_genesis: envelope receipt does not bind the creator encryption key / genesis epoch (genesis-key-bindings)");
    }
    if sv(&genesis, "epoch") != V0_EPOCH || sv(&genesis, "generation") != "0000000000000000" {
        rep.fail("vault_genesis: epoch/generation pins");
    }
    rep.repo_id = sv(&genesis, "repo_id");
    rep.heads_verified += 1;

    // ---- heads
    let mut prev_sha = stored_bytes_sha256(&genesis);
    let mut prev_gen = 0u64;
    let mut stored_by_gen: BTreeMap<u64, Vec<u8>> = BTreeMap::new();
    stored_by_gen.insert(0, genesis_bytes);
    for (g, p) in heads.iter().filter(|(g, _)| **g > 0) {
        let (h, bytes) = match load_stored(p) {
            Ok(x) => x,
            Err(e) => {
                rep.fail(e);
                continue;
            }
        };
        let label = format!("head/{g:016x}");
        if *g != prev_gen + 1 {
            rep.fail(format!(
                "{label}: generation gap after {prev_gen:016x} (CHAIN_BROKEN)"
            ));
        }
        if sv(&h, "object_kind") != "head" {
            rep.fail(format!("{label}: object_kind is not head"));
        }
        if let Some(s) = opts.schemas {
            match s.is_valid("head.json", &h) {
                Ok(true) => {}
                Ok(false) => rep.fail(format!("{label}: schema reject")),
                Err(e) => rep.fail(format!("{label}: schema error {e}")),
            }
        }
        if !verify_signed_object(&h, &writer_pub, None) {
            rep.fail(format!(
                "{label}: signature does not verify under the vault's writer key (strict Ed25519)"
            ));
        }
        if sv(&h, "writer_key_id") != writer_key_id {
            rep.fail(format!(
                "{label}: writer_key_id != the genesis writer (add_writer_key is post-V0)"
            ));
        }
        if sv(&h, "repo_id") != rep.repo_id {
            rep.fail(format!("{label}: repo_id differs from the genesis"));
        }
        if sv(&h, "generation") != format!("{g:016x}") {
            rep.fail(format!("{label}: generation member != path"));
        }
        if sv(&h, "prev_sha256") != prev_sha {
            rep.fail(format!("{label}: prev_sha256 != stored-bytes hash of generation {prev_gen:016x} (CHAIN_BROKEN)"));
        }
        if sv(&h, "epoch") != V0_EPOCH {
            rep.fail(format!(
                "{label}: epoch != {V0_EPOCH} (V0 epoch continuity; rotate_epoch is post-V0)"
            ));
        }
        if h.get("transition").map(|t| !t.is_null()).unwrap_or(false) {
            rep.fail(format!(
                "{label}: carries a non-null transition — a V0 gateway refuses it (TRANSITION_NOT_ACTIVE); a V0 client that finds it admitted fails closed (UPGRADE_REQUIRED)"
            ));
        }
        let cp_null = h.get("checkpoint").map(Value::is_null).unwrap_or(true);
        let purpose_null = h
            .get("checkpoint_purpose")
            .map(Value::is_null)
            .unwrap_or(true);
        if cp_null != purpose_null {
            rep.fail(format!(
                "{label}: checkpoint/checkpoint_purpose IFF violated"
            ));
        }
        if !cp_null
            && h.get("wal_entries")
                .and_then(Value::as_arr)
                .map(|a| !a.is_empty())
                .unwrap_or(false)
        {
            rep.fail(format!(
                "{label}: checkpoint-bearing head with non-empty wal_entries"
            ));
        }
        prev_sha = stored_bytes_sha256(&h);
        prev_gen = *g;
        stored_by_gen.insert(*g, bytes);
        rep.heads_verified += 1;
    }
    rep.newest_generation = Some(format!("{prev_gen:016x}"));
    if let Some(pin) = &opts.pin_generation {
        if let Ok(pg) = u64::from_str_radix(pin, 16) {
            if prev_gen < pg {
                rep.fail(format!("newest generation {prev_gen:016x} is below the pinned {pin} (GENERATION_REGRESSION)"));
            }
        }
    }

    // ---- admission records
    let adms = list_generation_files(&dir.join("admissions"));
    if adms.is_empty() {
        rep.warn("no admissions/<generation> records found");
    }
    for (g, p) in &adms {
        let label = format!("admissions/{g:016x}");
        let (a, _) = match load_stored(p) {
            Ok(x) => x,
            Err(e) => {
                rep.fail(e);
                continue;
            }
        };
        if let Some(s) = opts.schemas {
            match s.is_valid("admission_record.json", &a) {
                Ok(true) => {}
                Ok(false) => rep.fail(format!("{label}: schema reject")),
                Err(e) => rep.fail(format!("{label}: schema error {e}")),
            }
        }
        let want_kind = if *g == 0 { "vault_genesis" } else { "head" };
        if sv(&a, "admitted_object_kind") != want_kind {
            rep.fail(format!("{label}: admitted_object_kind != {want_kind}"));
        }
        if sv(&a, "generation") != format!("{g:016x}") || sv(&a, "repo_id") != rep.repo_id {
            rep.fail(format!("{label}: generation/repo_id do not match"));
        }
        if sv(&a, "writer_key_id") != writer_key_id {
            rep.fail(format!("{label}: writer_key_id != the vault writer"));
        }
        match stored_by_gen.get(g) {
            None => rep.fail(format!("{label}: no head at this generation to bind")),
            Some(head_bytes) => {
                let want_sha = crate::preimage::sha256_hex(head_bytes);
                if sv(&a, "admitted_sha256") != want_sha {
                    rep.fail(format!(
                        "{label}: admitted_sha256 != the stored-bytes hash of head/{g:016x}"
                    ));
                }
                match unb64u(&sv(&a, "admitted_stored_bytes")) {
                    Ok(b) if b == *head_bytes => {}
                    Ok(_) => rep.fail(format!(
                        "{label}: admitted_stored_bytes != the stored head bytes"
                    )),
                    Err(e) => rep.fail(format!("{label}: admitted_stored_bytes: {e}")),
                }
            }
        }
        match &registry {
            Some(reg) => {
                match service_key_for(reg, &sv(&a, "service_key_id"), &sv(&a, "prepared_at")) {
                    Ok(pk) => {
                        if !verify_signed_object(&a, &pk, None) {
                            rep.fail(format!(
                                "{label}: service signature does not verify under {}",
                                sv(&a, "service_key_id")
                            ));
                        } else {
                            rep.admissions_verified += 1;
                        }
                    }
                    Err(e) => rep.fail(format!("{label}: {e}")),
                }
            }
            None => {
                let m = format!("{label}: service signature unverifiable (no service-key registry in the export)");
                if opts.allow_unverified_service_signatures {
                    rep.warn(m);
                } else {
                    rep.fail(m);
                }
            }
        }
    }
    rep
}

/// Render a report as a JSON object (strings/arrays only — the profile's own shape).
pub fn report_value(r: &ChainReport) -> Value {
    Value::obj(&[
        (
            "result",
            Value::s(if r.ok() { "verified" } else { "failed" }),
        ),
        ("repo_id", Value::s(&r.repo_id)),
        (
            "newest_generation",
            r.newest_generation
                .as_deref()
                .map(Value::s)
                .unwrap_or(Value::Null),
        ),
        ("heads_verified", Value::s(&r.heads_verified.to_string())),
        (
            "admissions_verified",
            Value::s(&r.admissions_verified.to_string()),
        ),
        (
            "failures",
            Value::Arr(r.failures.iter().map(|x| Value::s(x)).collect()),
        ),
        (
            "warnings",
            Value::Arr(r.warnings.iter().map(|x| Value::s(x)).collect()),
        ),
    ])
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::codec::b64u;
    use crate::sig::{public_key_from_seed, sign_object};

    fn write(dir: &Path, rel: &str, v: &Value) {
        let p = dir.join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, stored_bytes(v)).unwrap();
    }

    fn signed(seed: &[u8; 32], kind: &str, v: Value) -> Value {
        let sig = sign_object(seed, kind, &v);
        v.with("signature", Value::s(&b64u(&sig)))
    }

    /// Build a 3-generation chain in a temp dir, verify it, then break it two ways.
    #[test]
    fn chain_roundtrip_and_breaks() {
        let seed = [3u8; 32];
        let pk = public_key_from_seed(&seed);
        let vk = format!("vk_{}", key_fingerprint(&pk));
        let enc_pk = [4u8; 32];
        let ek = format!("ek_{}", key_fingerprint(&enc_pk));
        let dir = std::env::temp_dir().join(format!("r402s-chain-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let genesis = signed(
            &seed,
            "vault_genesis",
            Value::obj(&[
                ("format", Value::s("r402s/v0")),
                ("object_kind", Value::s("vault_genesis")),
                ("suite", Value::s("r402s-1")),
                ("repo_id", Value::s("src_00000000000000000000000000000000")),
                ("org_id", Value::s("o")),
                ("project_id", Value::s("p")),
                (
                    "allocation_nonce",
                    Value::s("00000000000000000000000000000000"),
                ),
                ("generation", Value::s("0000000000000000")),
                ("epoch", Value::s(V0_EPOCH)),
                ("git_object_format", Value::s("sha1")),
                ("creator_signing_pubkey", Value::s(&b64u(&pk))),
                ("creator_encryption_pubkey", Value::s(&b64u(&enc_pk))),
                (
                    "envelopes",
                    Value::Arr(vec![Value::obj(&[
                        ("object_kind", Value::s("key_envelope")),
                        ("epoch", Value::s(V0_EPOCH)),
                        ("recipient_fingerprint", Value::s(&ek)),
                        ("stored_bytes_sha256", Value::s(&"0".repeat(64))),
                        ("size_bytes", Value::s("1")),
                    ])]),
                ),
                ("writer_key_id", Value::s(&vk)),
                ("created_at", Value::s("2026-01-01T00:00:00.000Z")),
            ]),
        );
        write(&dir, "head/0000000000000000", &genesis);
        let mut prev = stored_bytes_sha256(&genesis);
        let mut h2 = Value::Null;
        for g in 1..=2u64 {
            let h = signed(
                &seed,
                "head",
                Value::obj(&[
                    ("format", Value::s("r402s/v0")),
                    ("object_kind", Value::s("head")),
                    ("suite", Value::s("r402s-1")),
                    ("repo_id", Value::s("src_00000000000000000000000000000000")),
                    ("generation", Value::s(&format!("{g:016x}"))),
                    ("prev_sha256", Value::s(&prev)),
                    ("epoch", Value::s(V0_EPOCH)),
                    ("wal_entries", Value::Arr(vec![])),
                    ("ref_state", Value::Null),
                    ("retention_roots", Value::Null),
                    ("checkpoint", Value::Null),
                    ("checkpoint_purpose", Value::Null),
                    ("capture_binding", Value::Null),
                    ("repair", Value::Null),
                    ("transition", Value::Null),
                    ("writer_key_id", Value::s(&vk)),
                    ("created_at", Value::s("2026-01-01T00:00:00.000Z")),
                ]),
            );
            prev = stored_bytes_sha256(&h);
            write(&dir, &format!("head/{g:016x}"), &h);
            h2 = h;
        }
        let opts = ChainOptions {
            schemas: None,
            pin_generation: None,
            registry_root_pubkey: None,
            allow_unverified_service_signatures: true,
        };
        let r = verify_chain(&dir, &opts);
        assert!(r.ok(), "{:?}", r.failures);
        assert_eq!(r.heads_verified, 3);
        // a transition on the newest head fails closed
        let bad = signed(
            &seed,
            "head",
            h2.without("signature").with(
                "transition",
                Value::obj(&[("kind", Value::s("rotate_epoch"))]),
            ),
        );
        write(&dir, "head/0000000000000002", &bad);
        let r = verify_chain(&dir, &opts);
        assert!(r
            .failures
            .iter()
            .any(|f| f.contains("TRANSITION_NOT_ACTIVE")));
        // a pretty-printed copy is not stored bytes
        std::fs::write(dir.join("head/0000000000000002"), crate::json::pretty(&h2)).unwrap();
        let r = verify_chain(&dir, &opts);
        assert!(r.failures.iter().any(|f| f.contains("not stored bytes")));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
