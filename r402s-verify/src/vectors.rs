//! Replay of the task-1.2 vector set (`vectors.json`, `hpke-interop/golden.json`,
//! `CONTINUITY.json`) — every expected value is RECOMPUTED here from the
//! vector's inputs through this crate's own primitives, then compared.
//!
//! The per-class semantics mirror the protocol text; where the private
//! reference checker (`verify_vectors.py`) and this replay disagree, the
//! vector is reported as a disagreement — never silently skipped.
//!
//! Classes this lineage deliberately does NOT replay (reported as `skipped`):
//! `heads_listing_pagination` (an API contract, not verifier material),
//! `abnf-schema-portability` (needs an RFC 5234 interpreter — the schema side
//! alone would be half a differential), `dr-journal-precedence` (re-steps the
//! product model). `forward-integrity-fault` is replayed for its hash guard
//! only (the model step is not).

use crate::codec::{b64u, hex, unb64u, unhex};
use crate::frame::{frame_aad, open_frame, seal_frame, FrameError, FRAME_MAGIC, FRAME_SUITE_ID};
use crate::hpke_envelope as H;
use crate::json::{jcs, parse_lenient_layout, strict_parse, ParseError, Value};
use crate::kdf::{hkdf_sha256_32, k_digest_info, k_obj_info, keyed_commitment};
use crate::preimage::{
    key_fingerprint, lp, open_binding_preimage, open_id_preimage, sha256_hex, signature_preimage,
    stored_bytes, stored_bytes_sha256,
};
use crate::schema::SchemaSet;
use crate::sig::{verify_signed_object, verify_strict};
use crate::timestamp::{format_ms, parse_ms};
use serde_json::Value as S;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};

#[derive(Default, Debug, Clone)]
pub struct ClassTally {
    pub vectors: usize,
    pub checks: usize,
    pub failures: usize,
    pub status: &'static str,
}

#[derive(Default, Debug)]
pub struct Report {
    pub revision: String,
    pub vector_count: usize,
    pub classes: BTreeMap<String, ClassTally>,
    pub failures: Vec<String>,
    pub checks: usize,
    pub interop_cases: usize,
    pub notes: Vec<String>,
}

impl Report {
    pub fn ok(&self) -> bool {
        self.failures.is_empty()
    }
}

struct Ctx<'a> {
    schemas: Option<&'a SchemaSet>,
    machines: Option<&'a S>,
    error_codes: HashSet<String>,
    by_id: HashMap<String, &'a Value>,
    report: Report,
    cur_class: String,
}

impl Ctx<'_> {
    fn check(&mut self, id: &str, cond: bool, what: &str) {
        self.report.checks += 1;
        let t = self
            .report
            .classes
            .entry(self.cur_class.clone())
            .or_default();
        t.checks += 1;
        if !cond {
            t.failures += 1;
            self.report.failures.push(format!("{id}: {what}"));
        }
    }
    fn schema_ok(&mut self, id: &str, name: &str, inst: &Value) -> bool {
        match self.schemas {
            None => {
                self.check(id, false, "schema set unavailable");
                false
            }
            Some(s) => match s.is_valid(name, inst) {
                Ok(b) => b,
                Err(e) => {
                    self.check(id, false, &format!("schema evaluation error: {e}"));
                    false
                }
            },
        }
    }
    fn vec_by_id(&self, id: &str) -> Option<&Value> {
        self.by_id.get(id).copied()
    }
}

fn verdict(v: &Value) -> &'static str {
    if v.get("expect_accept").and_then(Value::as_str) == Some("true") {
        "accept"
    } else if v.get("expect_reject").and_then(Value::as_str) == Some("true") {
        "reject"
    } else {
        "deferred"
    }
}

fn s(v: &Value, k: &str) -> String {
    v.get(k).and_then(Value::as_str).unwrap_or("").to_string()
}

fn hx(v: &Value, k: &str) -> Vec<u8> {
    v.get(k)
        .and_then(Value::as_str)
        .and_then(|x| unhex(x).ok())
        .unwrap_or_default()
}

fn b64(v: &Value, k: &str) -> Vec<u8> {
    v.get(k)
        .and_then(Value::as_str)
        .and_then(|x| unb64u(x).ok())
        .unwrap_or_default()
}

fn eqv(a: &Value, b: &Value) -> bool {
    jcs(a) == jcs(b)
}

fn strs(v: &Value, k: &str) -> Vec<String> {
    v.get(k)
        .and_then(Value::as_arr)
        .map(|a| {
            a.iter()
                .filter_map(|x| x.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default()
}

fn gen_u64(g: &str) -> Option<u64> {
    if g.len() != 16 {
        return None;
    }
    u64::from_str_radix(g, 16).ok()
}

fn genesis_bindings_ok(g: &Value) -> bool {
    let sp = b64(g, "creator_signing_pubkey");
    let ep = b64(g, "creator_encryption_pubkey");
    let env0 = g
        .get("envelopes")
        .and_then(Value::as_arr)
        .and_then(|a| a.first());
    match env0 {
        None => false,
        Some(e) => {
            format!("vk_{}", key_fingerprint(&sp)) == s(g, "writer_key_id")
                && format!("ek_{}", key_fingerprint(&ep)) == s(e, "recipient_fingerprint")
                && s(e, "epoch") == s(g, "epoch")
        }
    }
}

fn envelope_binds_genesis(env: &Value, g: &Value) -> bool {
    let rc = match g
        .get("envelopes")
        .and_then(Value::as_arr)
        .and_then(|a| a.first())
    {
        Some(r) => r,
        None => return false,
    };
    let sb = stored_bytes(env);
    s(env, "repo_id") == s(g, "repo_id")
        && s(env, "epoch") == s(rc, "epoch")
        && s(env, "recipient_fingerprint") == s(rc, "recipient_fingerprint")
        && s(env, "created_by") == s(g, "writer_key_id")
        && sha256_hex(&sb) == s(rc, "stored_bytes_sha256")
        && sb.len().to_string() == s(rc, "size_bytes")
}

fn open_envelope_for_genesis(env: &Value, g: &Value, sk_raw: &[u8]) -> Option<Vec<u8>> {
    let sk = H::sk_from_bytes(sk_raw).ok()?;
    H::open_envelope_object(env, &b64(g, "creator_encryption_pubkey"), &sk)
}

fn x25519_pk(sk_raw: &[u8]) -> Vec<u8> {
    H::sk_from_bytes(sk_raw)
        .map(|sk| H::pk_bytes(&H::sk_to_pk(&sk)))
        .unwrap_or_default()
}

fn is_edge(machines: Option<&S>, machine: &str, a: &str, b: &str) -> bool {
    machines
        .and_then(|m| m.get("machines")?.get(machine)?.get("edges")?.as_array())
        .map(|edges| {
            edges.iter().any(|e| {
                e.get(0).and_then(S::as_str) == Some(a) && e.get(1).and_then(S::as_str) == Some(b)
            })
        })
        .unwrap_or(false)
}

fn machine_strs(machines: Option<&S>, machine: &str, key: &str) -> Vec<String> {
    machines
        .and_then(|m| m.get("machines")?.get(machine)?.get(key)?.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|x| x.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default()
}

fn machine_edges(machines: Option<&S>, machine: &str) -> Vec<(String, String, String)> {
    machines
        .and_then(|m| m.get("machines")?.get(machine)?.get("edges")?.as_array())
        .map(|a| {
            a.iter()
                .map(|e| {
                    (
                        e.get(0).and_then(S::as_str).unwrap_or("").to_string(),
                        e.get(1).and_then(S::as_str).unwrap_or("").to_string(),
                        e.get(2).and_then(S::as_str).unwrap_or("").to_string(),
                    )
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Where the vector set lives: `R402S_VECTORS` (a path to `vectors.json`), else
/// the sibling private checkout, else none.
pub fn locate_vectors() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("R402S_VECTORS") {
        let p = PathBuf::from(p);
        return if p.is_file() { Some(p) } else { None };
    }
    let here = Path::new(env!("CARGO_MANIFEST_DIR"));
    let candidates = [
        // the vendored, integrity-pinned set that ships WITH this repo (the
        // replay is a CI gate, not an opportunistic extra — a verifier whose
        // agreement with the frozen vectors is never executed proves nothing)
        here.join("../test-vectors/r402s-v0/vectors.json"),
        here.join("../../run402-private/docs/strategy/products/gitvault/vectors/vectors.json"),
        here.join("../../../run402-private/docs/strategy/products/gitvault/vectors/vectors.json"),
    ];
    candidates.into_iter().find(|p| p.is_file())
}

pub fn run(vectors_path: &Path) -> Result<Report, String> {
    let raw =
        std::fs::read(vectors_path).map_err(|e| format!("{}: {e}", vectors_path.display()))?;
    let vec_doc = parse_lenient_layout(&raw)
        .map_err(|e| format!("vectors.json is not strict I-JSON: {e}"))?;
    let dir = vectors_path.parent().ok_or("vectors path has no parent")?;
    // vendored layout () first,
    // then the private-repo layout ( + )
    let schemas_dir = std::env::var("R402S_SCHEMAS")
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            let vendored = dir.join("schemas");
            if vendored.is_dir() {
                vendored
            } else {
                dir.join("../schemas")
            }
        });
    let schemas = SchemaSet::load_dir(&schemas_dir).ok();
    let machines: Option<S> = std::fs::read(schemas_dir.join("state-machines.json"))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok());
    let error_codes: HashSet<String> = std::fs::read(schemas_dir.join("errors.json"))
        .ok()
        .and_then(|b| serde_json::from_slice::<S>(&b).ok())
        .and_then(|d| {
            d.get("errors")?.as_array().map(|a| {
                a.iter()
                    .filter_map(|e| e.get("code")?.as_str().map(String::from))
                    .collect()
            })
        })
        .unwrap_or_default();

    let vectors = vec_doc
        .get("vectors")
        .and_then(Value::as_arr)
        .ok_or("no `vectors` array")?;
    let mut by_id = HashMap::new();
    for v in vectors {
        by_id.insert(s(v, "id"), v);
    }
    let mut cx = Ctx {
        schemas: schemas.as_ref(),
        machines: machines.as_ref(),
        error_codes,
        by_id,
        report: Report {
            revision: s(&vec_doc, "x-r402s-revision"),
            vector_count: vectors.len(),
            ..Default::default()
        },
        cur_class: String::new(),
    };
    if schemas.is_none() {
        cx.report.notes.push(format!(
            "schema set not found at {} — schema checks will fail",
            schemas_dir.display()
        ));
    } else if let Some(rev) = schemas.as_ref().and_then(|s| s.revision("common.json")) {
        if rev != cx.report.revision {
            cx.report.failures.push(format!(
                "revision mismatch: vectors rev {} vs schemas rev {rev}",
                cx.report.revision
            ));
        }
    }
    if cx.report.revision != crate::PROTOCOL_REVISION {
        cx.report.notes.push(format!(
            "vectors are rev {} but this verifier was written against rev {}",
            cx.report.revision,
            crate::PROTOCOL_REVISION
        ));
    }

    for v in vectors {
        let cls = s(v, "class");
        cx.cur_class = cls.clone();
        let t = cx.report.classes.entry(cls.clone()).or_default();
        t.vectors += 1;
        t.status = "replayed";
        replay_one(&mut cx, v);
    }
    for skipped in [
        "heads_listing_pagination",
        "abnf-schema-portability",
        "dr-journal-precedence",
    ] {
        if let Some(t) = cx.report.classes.get_mut(skipped) {
            t.status = "skipped";
        }
    }
    if let Some(t) = cx.report.classes.get_mut("forward-integrity-fault") {
        t.status = "partial (hash guard only)";
    }

    // ---- interop golden file
    let gold_path = dir.join("hpke-interop/golden.json");
    match std::fs::read(&gold_path) {
        Ok(gb) => {
            cx.cur_class = "hpke-interop/golden.json".into();
            let gt = cx.report.classes.entry(cx.cur_class.clone()).or_default();
            gt.status = "replayed";
            match parse_lenient_layout(&gb) {
                Ok(gold) => interop(&mut cx, &gold),
                Err(e) => cx.check("golden.json", false, &format!("not strict I-JSON: {e}")),
            }
        }
        Err(e) => cx
            .report
            .notes
            .push(format!("{}: {e} (interop skipped)", gold_path.display())),
    }

    // ---- continuity manifest (whole-file digests + id presence)
    let cont_path = dir.join("CONTINUITY.json");
    if let Ok(cb) = std::fs::read(&cont_path) {
        cx.cur_class = "CONTINUITY.json".into();
        cx.report
            .classes
            .entry(cx.cur_class.clone())
            .or_default()
            .status = "replayed (file digests + ids)";
        match parse_lenient_layout(&cb) {
            Ok(man) => {
                let cur = man.get("current").cloned().unwrap_or(Value::Null);
                cx.check(
                    "CONTINUITY.json",
                    s(&man, "format") == "r402s/v0/continuity",
                    "manifest format",
                );
                cx.check(
                    "CONTINUITY.json",
                    s(&cur, "protocol_revision") == cx.report.revision,
                    "current.protocol_revision == vectors revision",
                );
                cx.check(
                    "CONTINUITY.json",
                    sha256_hex(&raw) == s(&cur, "vectors_json_sha256"),
                    "current.vectors_json_sha256 == committed vectors.json",
                );
                cx.check(
                    "CONTINUITY.json",
                    s(&cur, "vectors_json_vector_count") == vectors.len().to_string(),
                    "current vector count",
                );
                if let Ok(gb) = std::fs::read(&gold_path) {
                    cx.check(
                        "CONTINUITY.json",
                        sha256_hex(&gb) == s(&cur, "golden_json_sha256"),
                        "current.golden_json_sha256 == committed golden.json",
                    );
                }
                let ids = man
                    .get("pre_fold")
                    .map(|p| strs(p, "vector_ids"))
                    .unwrap_or_default();
                let present = ids.iter().all(|i| cx.by_id.contains_key(i));
                cx.check(
                    "CONTINUITY.json",
                    ids.len() == 127 && present,
                    "all 127 pre-fold vector ids present",
                );
            }
            Err(e) => cx.check("CONTINUITY.json", false, &format!("not strict I-JSON: {e}")),
        }
    }
    Ok(cx.report)
}

fn replay_one(cx: &mut Ctx, v: &Value) {
    let id = s(v, "id");
    let cls = s(v, "class");
    let inp = v.get("inputs").cloned().unwrap_or(Value::Null);
    let exp = v.get("expected").cloned().unwrap_or(Value::Null);
    let vd = verdict(v);
    let accept = vd == "accept";

    if let Some(code) = v.get("reject_code").and_then(Value::as_str) {
        if !cx.error_codes.is_empty() {
            let ok = cx.error_codes.contains(code);
            cx.check(&id, ok, "reject_code not in errors.json");
        }
    }
    if let (Some(schema), Some(obj)) = (v.get("schema").and_then(Value::as_str), inp.get("object"))
    {
        let schema = schema.to_string();
        let obj = obj.clone();
        match exp.get("schema_valid").and_then(Value::as_str) {
            Some(want) => {
                let got = cx.schema_ok(&id, &schema, &obj);
                cx.check(&id, got == (want == "true"), "schema verdict");
            }
            None if accept => {
                let got = cx.schema_ok(&id, &schema, &obj);
                cx.check(&id, got, "schema valid");
            }
            None => {}
        }
    }

    match cls.as_str() {
        "golden-preimage" => {
            let pre = hx(&inp, "preimage_hex");
            let recon = if inp.get("org_id").is_some() {
                open_id_preimage(
                    &s(&inp, "org_id"),
                    &s(&inp, "repo_id"),
                    &s(&inp, "client_open_id"),
                )
            } else {
                open_binding_preimage(
                    &s(&inp, "client_open_id"),
                    &s(&inp, "base_head_sha256"),
                    inp.get("prior_checkpoint_claim_set_sha256")
                        .and_then(Value::as_str),
                    &s(&inp, "requested_r2_cap_size_bytes"),
                )
            };
            cx.check(
                &id,
                recon == pre && pre.len().to_string() == s(&inp, "preimage_len"),
                "preimage reconstruction",
            );
            cx.check(&id, sha256_hex(&pre) == s(&exp, "sha256"), "digest");
        }
        "request-to-c1-binding" => {
            if let Some(c) = inp.get("c1_record") {
                let d = sha256_hex(&open_binding_preimage(
                    &s(&inp, "client_open_id"),
                    &s(c, "base_head_sha256"),
                    c.get("prior_checkpoint_claim_set_sha256")
                        .and_then(Value::as_str),
                    &s(c, "r2_cap_size_bytes"),
                ));
                cx.check(
                    &id,
                    d == s(&exp, "recomputed_open_binding_sha256"),
                    "recomputed binding",
                );
                cx.check(
                    &id,
                    (d == s(&inp, "issuance_open_binding_sha256")) == accept,
                    "equality verdict",
                );
            } else {
                let eq =
                    s(&inp, "winner_open_binding_sha256") == s(&inp, "retry_open_binding_sha256");
                cx.check(&id, eq == accept, "open-id conflict verdict");
            }
        }
        "strict-parse" => {
            if let Some(raw) = inp.get("raw_json_text").and_then(Value::as_str) {
                let mut reason: Option<&str> = None;
                let mut obj = None;
                match strict_parse(raw.as_bytes()) {
                    Ok(o) => {
                        if let Some(schema) = v.get("schema").and_then(Value::as_str) {
                            let schema = schema.to_string();
                            if !cx.schema_ok(&id, &schema, &o) {
                                reason = Some("schema");
                            }
                        }
                        obj = Some(o);
                    }
                    Err(e) => {
                        reason = Some(match e {
                            ParseError::JsonNumber => "json-number",
                            ParseError::DuplicateMember => "duplicate-member",
                            ParseError::InvalidJson(_) => "invalid-json",
                            ParseError::NoncanonicalEncoding => "noncanonical-encoding",
                        })
                    }
                }
                if accept {
                    cx.check(
                        &id,
                        reason.is_none(),
                        &format!("unexpected reject {reason:?}"),
                    );
                    if let Some(o) = obj {
                        let c = jcs(&o);
                        cx.check(
                            &id,
                            c == s(&exp, "canonical_jcs").as_bytes()
                                && sha256_hex(&c) == s(&exp, "sha256"),
                            "canonical bytes",
                        );
                    }
                } else {
                    cx.check(
                        &id,
                        reason == Some(s(&exp, "reason").as_str()),
                        &format!("reject reason {reason:?} != {}", s(&exp, "reason")),
                    );
                }
            } else {
                let b = s(&inp, "base64url");
                let can = crate::codec::b64u_is_canonical(&b);
                cx.check(
                    &id,
                    can == (s(&exp, "canonical") == "true") && can == accept,
                    "base64url canonicality",
                );
                if can {
                    cx.check(
                        &id,
                        unb64u(&b).unwrap().len().to_string() == s(&exp, "decoded_len"),
                        "decoded length",
                    );
                }
            }
        }
        "aead-frame" => {
            if accept {
                let k_repo = hx(&inp, "K_repo_hex");
                let info = k_obj_info(
                    &s(&inp, "repo_id"),
                    &s(&inp, "epoch"),
                    &s(&inp, "object_kind"),
                    &s(&inp, "object_id"),
                );
                let k_obj = hkdf_sha256_32(&k_repo, &info);
                cx.check(
                    &id,
                    hex(&info) == s(&exp, "k_obj_info_hex") && hex(&k_obj) == s(&exp, "k_obj_hex"),
                    "k_obj",
                );
                let aad = frame_aad(
                    &s(&inp, "repo_id"),
                    &s(&inp, "object_kind"),
                    &s(&inp, "object_id"),
                    &s(&inp, "epoch"),
                );
                cx.check(&id, aad == s(&exp, "aad_jcs").as_bytes(), "aad");
                let nonce = hx(&inp, "nonce_hex");
                let pt = hx(&inp, "plaintext_hex");
                let n24: [u8; 24] = match nonce.as_slice().try_into() {
                    Ok(n) => n,
                    Err(_) => {
                        cx.check(&id, false, "nonce length");
                        return;
                    }
                };
                let blob = seal_frame(&k_obj, &n24, &aad, &pt);
                cx.check(&id, hex(&blob) == s(&exp, "frame_hex"), "frame bytes");
                cx.check(
                    &id,
                    sha256_hex(&blob) == s(&exp, "ciphertext_sha256")
                        && blob.len().to_string() == s(&exp, "size_bytes"),
                    "frame hash/size",
                );
                let dec = open_frame(&k_obj, &aad, &blob);
                cx.check(
                    &id,
                    dec.as_deref() == Ok(pt.as_slice())
                        && sha256_hex(&pt) == s(&exp, "plaintext_sha256"),
                    "round-trip",
                );
            } else {
                let blob = hx(&inp, "frame_hex");
                let k_obj: [u8; 32] = match hx(&inp, "k_obj_hex").as_slice().try_into() {
                    Ok(k) => k,
                    Err(_) => {
                        cx.check(&id, false, "k_obj length");
                        return;
                    }
                };
                let aad = s(&inp, "aad_jcs").into_bytes();
                if let Some(m) = inp.get("aad_mutation") {
                    // the mutated AAD is re-derived from the recorded mutation, not trusted from aad_jcs
                    let base_keys: HashSet<&str> = [
                        "repo_id",
                        "object_kind",
                        "object_id",
                        "epoch",
                        "suite",
                        "magic",
                        "suite_id",
                    ]
                    .into();
                    let orig = parse_lenient_layout(&aad).ok();
                    let keys: HashSet<&str> = orig
                        .as_ref()
                        .and_then(Value::as_obj)
                        .map(|o| o.iter().map(|(k, _)| k.as_str()).collect())
                        .unwrap_or_default();
                    cx.check(&id, keys == base_keys, "aad field set");
                    let mutated_ok = m
                        .as_obj()
                        .map(|mm| {
                            mm.iter()
                                .all(|(k, val)| orig.as_ref().and_then(|o| o.get(k)) == Some(val))
                        })
                        .unwrap_or(false);
                    cx.check(&id, mutated_ok, "aad_jcs carries the recorded mutation");
                    cx.check(
                        &id,
                        open_frame(&k_obj, &aad, &blob) == Err(FrameError::AuthFailure),
                        "mutated AAD must not decrypt",
                    );
                } else {
                    let hdr_ok =
                        blob.len() > 7 && &blob[..6] == FRAME_MAGIC && blob[6] == FRAME_SUITE_ID;
                    let dec_ok = open_frame(&k_obj, &aad, &blob).is_ok();
                    cx.check(&id, !(hdr_ok && dec_ok), "frame mutation not refused");
                    cx.check(
                        &id,
                        sha256_hex(&blob) == s(&exp, "ciphertext_sha256")
                            && s(&exp, "ciphertext_sha256") != s(&inp, "receipt_ciphertext_sha256"),
                        "receipt mismatch",
                    );
                }
            }
        }
        "hkdf" => {
            if let Some(ders) = exp.get("derivations").and_then(Value::as_arr) {
                let k_repo = hx(&inp, "K_repo_hex");
                for d in ders {
                    let (info, out) = if let Some(label) = d.get("label").and_then(Value::as_str) {
                        (
                            k_digest_info(&s(&inp, "repo_id"), &s(&inp, "epoch"), label),
                            s(d, "k_digest_hex"),
                        )
                    } else {
                        (
                            k_obj_info(
                                &s(&inp, "repo_id"),
                                &s(&inp, "epoch"),
                                &s(d, "object_kind"),
                                &s(d, "object_id"),
                            ),
                            s(d, "k_obj_hex"),
                        )
                    };
                    cx.check(&id, hex(&info) == s(d, "info_hex"), "info");
                    cx.check(&id, hex(&hkdf_sha256_32(&k_repo, &info)) == out, "okm");
                }
            } else {
                let kd = hx(&inp, "k_digest_hex");
                let content = inp.get("content").cloned().unwrap_or(Value::Null);
                cx.check(
                    &id,
                    keyed_commitment(&kd, &content) == s(&exp, "hmac_sha256"),
                    "hmac",
                );
                if accept {
                    cx.check(
                        &id,
                        jcs(&content) == s(&exp, "content_jcs").as_bytes(),
                        "content jcs",
                    );
                    if s(&inp, "label") == "objectset" {
                        let oids = strs(&content, "oids");
                        let mut sorted = oids.clone();
                        sorted.sort();
                        sorted.dedup();
                        cx.check(&id, oids == sorted, "objectset sorted-unique");
                    }
                    if s(&inp, "label") == "gcrootset" {
                        let ids: Vec<String> = content
                            .get("receipts")
                            .and_then(Value::as_arr)
                            .map(|a| a.iter().map(|r| s(r, "object_id")).collect())
                            .unwrap_or_default();
                        let mut sorted = ids.clone();
                        sorted.sort();
                        cx.check(&id, ids == sorted, "gcrootset sorted by object_id");
                    }
                } else {
                    cx.check(
                        &id,
                        s(&exp, "hmac_sha256") != s(&inp, "canonical_hmac_sha256"),
                        "noncanonical content differs",
                    );
                }
            }
        }
        "stored-bytes-preimage" => {
            if accept {
                let obj = inp.get("object").cloned().unwrap_or(Value::Null);
                let pub_ = inp
                    .get("signer_pubkey")
                    .or_else(|| inp.get("creator_signing_pubkey"))
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                let kind = s(&obj, "object_kind");
                cx.check(
                    &id,
                    hex(&signature_preimage(&kind, &obj.without("signature")))
                        == s(&exp, "signature_preimage_hex"),
                    "preimage",
                );
                cx.check(
                    &id,
                    verify_signed_object(&obj, &pub_, None),
                    "signature (strict)",
                );
                let sb = stored_bytes(&obj);
                cx.check(
                    &id,
                    sb == s(&exp, "stored_bytes").as_bytes()
                        && sha256_hex(&sb) == s(&exp, "stored_bytes_sha256"),
                    "stored bytes",
                );
                if kind == "vault_genesis" {
                    let wk = format!(
                        "vk_{}",
                        key_fingerprint(&b64(&obj, "creator_signing_pubkey"))
                    );
                    cx.check(
                        &id,
                        wk == s(&obj, "writer_key_id") && wk == s(&exp, "writer_key_id"),
                        "writer_key_id binding",
                    );
                    let ek = format!(
                        "ek_{}",
                        key_fingerprint(&b64(&obj, "creator_encryption_pubkey"))
                    );
                    let env0 = obj
                        .get("envelopes")
                        .and_then(Value::as_arr)
                        .and_then(|a| a.first())
                        .cloned()
                        .unwrap_or(Value::Null);
                    cx.check(
                        &id,
                        ek == s(&env0, "recipient_fingerprint")
                            && ek == s(&exp, "envelope_recipient_fingerprint"),
                        "envelope fingerprint binding",
                    );
                    cx.check(
                        &id,
                        s(&env0, "epoch") == s(&obj, "epoch"),
                        "envelope epoch binding",
                    );
                }
            } else if inp.get("preimage_hex").is_some() {
                let ok = verify_strict(
                    &b64(&inp, "signer_pubkey"),
                    &hx(&inp, "preimage_hex"),
                    &b64(&inp, "signature"),
                );
                cx.check(&id, !ok, "cross-domain signature must fail");
            } else {
                let obj = inp.get("object").cloned().unwrap_or(Value::Null);
                let wo = sha256_hex(&jcs(&obj.without("signature")));
                let sb = stored_bytes_sha256(&obj);
                cx.check(
                    &id,
                    wo == s(&exp, "sha256_without_signature")
                        && wo != s(&exp, "stored_bytes_sha256")
                        && sb == s(&exp, "stored_bytes_sha256"),
                    "hash input",
                );
            }
        }
        "chain" => {
            if let Some(heads) = inp.get("heads").and_then(Value::as_arr) {
                let genesis = inp.get("genesis").cloned().unwrap_or(Value::Null);
                let pub_ = s(&genesis, "creator_signing_pubkey");
                let mut chain: Vec<&Value> = vec![&genesis];
                chain.extend(heads.iter());
                let mut ok = true;
                for i in 0..chain.len() {
                    let sig_ok = verify_signed_object(chain[i], &pub_, None);
                    cx.check(&id, sig_ok, &format!("signature {i}"));
                    if i > 0 {
                        let prev = stored_bytes_sha256(chain[i - 1]);
                        let g = gen_u64(&s(chain[i], "generation"));
                        let pg = gen_u64(&s(chain[i - 1], "generation"));
                        ok = ok
                            && s(chain[i], "prev_sha256") == prev
                            && matches!((g, pg), (Some(a), Some(b)) if a == b + 1)
                            && s(chain[i], "epoch") == s(chain[i - 1], "epoch");
                    }
                }
                if let Some(want) = exp.get("stored_bytes_sha256") {
                    let got: Vec<String> = chain.iter().map(|h| stored_bytes_sha256(h)).collect();
                    cx.check(
                        &id,
                        got == strs(&exp, "stored_bytes_sha256") && want.as_arr().is_some(),
                        "hashes",
                    );
                }
                cx.check(
                    &id,
                    ok == (s(&exp, "chain_ok") == "true") && ok == accept,
                    "chain verdict",
                );
            } else if let Some(obj) = inp.get("object") {
                cx.check(
                    &id,
                    !verify_signed_object(obj, &s(&inp, "signer_pubkey"), None),
                    "tampered object must fail",
                );
            } else {
                let below = match (
                    gen_u64(&s(&inp, "listed_newest_generation")),
                    gen_u64(&s(&inp, "pinned_generation")),
                ) {
                    (Some(a), Some(b)) => a < b,
                    _ => false,
                };
                cx.check(
                    &id,
                    below == (s(&exp, "below_pin") == "true") && below == (vd == "reject"),
                    "regression",
                );
            }
        }
        "transition-fail-closed" => {
            if let (Some(obj), Some(pk)) = (
                inp.get("object"),
                inp.get("signer_pubkey").and_then(Value::as_str),
            ) {
                let obj = obj.clone();
                let pk = pk.to_string();
                let schema_ok = cx.schema_ok(&id, "head.json", &obj);
                cx.check(
                    &id,
                    schema_ok && verify_signed_object(&obj, &pk, None),
                    "valid+signed",
                );
                let prev = inp
                    .get("prev_head")
                    .map(stored_bytes_sha256)
                    .unwrap_or_default();
                cx.check(&id, s(&obj, "prev_sha256") == prev, "chain ok");
                cx.check(
                    &id,
                    obj.get("transition").map(|t| !t.is_null()).unwrap_or(false)
                        && s(v, "reject_code") == "TRANSITION_NOT_ACTIVE",
                    "non-null transition -> TRANSITION_NOT_ACTIVE",
                );
            } else if let Some(obj) = inp.get("object") {
                let is_null = obj.get("transition").map(Value::is_null).unwrap_or(false);
                cx.check(&id, is_null == accept, "transition null iff accept");
            } else {
                cx.check(
                    &id,
                    s(v, "reject_code") == "UPGRADE_REQUIRED",
                    "client-side code",
                );
            }
        }
        "zip215" => {
            if inp.get("object").is_some() {
                return; // the exact-scalar schema rejects are the generic schema check above
            }
            let pk = b64(&inp, "pubkey");
            let msg = hx(&inp, "message_hex");
            let sig = b64(&inp, "signature");
            let strict = verify_strict(&pk, &msg, &sig);
            cx.check(
                &id,
                strict == (s(&exp, "strict_rfc8032") == "accept"),
                &format!("strict verdict {strict}"),
            );
            cx.check(&id, strict == accept, "overall verdict = strict verdict");
            if let Some(r) = inp.get("R_encoding_hex").and_then(Value::as_str) {
                let r_enc = unhex(r).unwrap_or_default();
                // p + 1 in little-endian: ee ff .. ff 7f
                let mut p1 = vec![0xffu8; 32];
                p1[0] = 0xee;
                p1[31] = 0x7f;
                cx.check(
                    &id,
                    sig.len() == 64 && sig[..32] == r_enc[..] && r_enc == p1,
                    "R is the identity in its non-canonical encoding (p+1)",
                );
                cx.check(
                    &id,
                    sig.len() == 64 && scalar_lt_l(&sig[32..]),
                    "S canonical (the discriminator is R, not S)",
                );
            }
        }
        "state-machine-table" => {
            let machine = s(&inp, "machine");
            let m = cx.machines;
            if m.is_none() {
                cx.check(&id, false, "state-machines.json unavailable");
                return;
            }
            if accept {
                let want: Vec<(String, String, String)> = exp
                    .get("edges")
                    .and_then(Value::as_arr)
                    .map(|a| {
                        a.iter()
                            .map(|e| (s(e, "from"), s(e, "to"), s(e, "guard")))
                            .collect()
                    })
                    .unwrap_or_default();
                cx.check(
                    &id,
                    want == machine_edges(m, &machine) && !want.is_empty(),
                    "edge table == state-machines.json",
                );
                cx.check(
                    &id,
                    strs(&inp, "states") == machine_strs(m, &machine, "states")
                        && strs(&inp, "terminals") == machine_strs(m, &machine, "terminals"),
                    "states/terminals",
                );
            } else {
                let states = machine_strs(m, &machine, "states");
                let edges: HashSet<(String, String)> = machine_edges(m, &machine)
                    .into_iter()
                    .map(|(a, b, _)| (a, b))
                    .collect();
                let mut non = Vec::new();
                for a in &states {
                    for b in &states {
                        if a != b && !edges.contains(&(a.clone(), b.clone())) {
                            non.push((a.clone(), b.clone()));
                        }
                    }
                }
                let want: Vec<(String, String)> = exp
                    .get("non_edges")
                    .and_then(Value::as_arr)
                    .map(|a| a.iter().map(|e| (s(e, "from"), s(e, "to"))).collect())
                    .unwrap_or_default();
                cx.check(&id, want == non, "non-edge table");
                let terminals = machine_strs(m, &machine, "terminals");
                let closed = terminals
                    .iter()
                    .all(|t| states.iter().all(|b| !is_edge(m, &machine, t, b)));
                cx.check(&id, closed, "terminals closed");
            }
        }
        "state-scenario" => {
            let machine = s(&inp, "machine");
            let m = cx.machines;
            if m.is_none() {
                cx.check(&id, false, "state-machines.json unavailable");
                return;
            }
            if let Some(steps) = exp.get("steps").and_then(Value::as_arr) {
                let mut cur = s(&inp, "start");
                let mut ok = true;
                for st in steps {
                    ok = ok && s(st, "state") == cur;
                    if s(st, "transition") == "edge" {
                        ok = ok && is_edge(m, &machine, &cur, &s(st, "next_state"));
                        cur = s(st, "next_state");
                    } else {
                        ok = ok && s(st, "next_state") == cur;
                    }
                }
                cx.check(&id, ok && cur == s(&exp, "final_state"), "scenario replay");
                if vd == "reject" {
                    let terminal = machine_strs(m, &machine, "terminals").contains(&cur);
                    cx.check(
                        &id,
                        terminal || v.get("reject_code").is_some(),
                        "reject scenario ends terminal or names a code",
                    );
                }
            } else {
                let e = is_edge(m, &machine, &s(&inp, "from"), &s(&inp, "to"));
                if exp.get("is_edge").is_some() {
                    cx.check(&id, e == (s(&exp, "is_edge") == "true") && !e, "non-edge");
                } else {
                    let guard = machine_edges(m, &machine)
                        .into_iter()
                        .find(|(a, b, _)| *a == s(&inp, "from") && *b == s(&inp, "to"))
                        .map(|(_, _, g)| g)
                        .unwrap_or_default();
                    cx.check(
                        &id,
                        e && guard.contains(&s(&exp, "guard_text_requires"))
                            && s(&inp, "cut_subfence") != "NONE",
                        "guard",
                    );
                }
            }
        }
        "activation-token" => {
            if let Some(obj) = inp.get("object") {
                let obj = obj.clone();
                cx.check(
                    &id,
                    verify_signed_object(&obj, &s(&inp, "service_pubkey"), None),
                    "service signature",
                );
                cx.check(
                    &id,
                    stored_bytes_sha256(&obj) == s(&exp, "stored_bytes_sha256"),
                    "stored hash",
                );
                let link = cx.vec_by_id("token-008").map(|t| {
                    s(
                        t.get("inputs").unwrap_or(&Value::Null),
                        "token_authorization_epoch",
                    )
                });
                cx.check(
                    &id,
                    link.as_deref() == Some(s(&obj, "authorization_epoch").as_str()),
                    "epoch links to token-008",
                );
            } else if inp.get("token_authorization_epoch").is_some() {
                let eq = s(&inp, "token_authorization_epoch")
                    == s(&inp, "installed_authorization_epoch");
                cx.check(
                    &id,
                    eq == (s(&exp, "equal") == "true") && eq == accept,
                    "bytewise epoch",
                );
            } else {
                let m = cx.machines;
                let st = s(&inp, "state");
                let ok = s(&inp, "consumed_by_operation_id") != s(&inp, "attempting_operation_id")
                    && !is_edge(m, &s(&inp, "machine"), &st, &st)
                    && machine_strs(m, "activation_token", "terminals").contains(&st);
                cx.check(&id, ok, "concurrent commit loser refused");
            }
        }
        "retention-schedule" => {
            if inp.get("admission_prepared_at").is_some() {
                let prep = parse_ms(&s(&inp, "admission_prepared_at"));
                let stor = parse_ms(&s(&inp, "admission_record_storage_created_at"));
                let cut = parse_ms(&s(&inp, "retention_cutoff_ticket_cutoff_at"));
                let days: i64 = s(&inp, "retention_days").parse().unwrap_or(-1);
                match (prep, stor, cut) {
                    (Ok(p), Ok(st), Ok(c)) if days >= 0 => {
                        let eff = p.max(st);
                        let eligible = eff + days * 86_400_000 < c;
                        cx.check(
                            &id,
                            format_ms(eff) == s(&exp, "effective_admitted_at"),
                            "effective_admitted_at",
                        );
                        cx.check(
                            &id,
                            eligible == (s(&exp, "eligible_for_removal") == "true")
                                && eligible != (s(&exp, "guaranteed_recoverable") == "true"),
                            "eligibility",
                        );
                        if vd == "reject" {
                            cx.check(&id, !eligible, "removal before expiry is the refusal");
                        }
                    }
                    _ => cx.check(&id, false, "timestamps parse"),
                }
            } else if inp
                .get("dropped_by_g_plus_1")
                .and_then(Value::as_arr)
                .map(|a| a.is_empty())
                .unwrap_or(false)
            {
                let same = inp
                    .get("roots_g")
                    .zip(exp.get("roots_g_plus_1"))
                    .map(|(a, b)| eqv(a, b))
                    .unwrap_or(false);
                cx.check(
                    &id,
                    same && inp
                        .get("g_plus_1_checkpoint")
                        .map(Value::is_null)
                        .unwrap_or(false),
                    "non-checkpoint head carries every root",
                );
            } else {
                let mut map: BTreeMap<(String, String), (String, String, String)> = BTreeMap::new();
                for r in inp.get("roots_g").and_then(Value::as_arr).unwrap_or(&[]) {
                    map.insert(
                        (s(r, "ref"), s(r, "oid")),
                        (s(r, "dropped_at_generation"), s(r, "ref"), s(r, "oid")),
                    );
                }
                for d in inp
                    .get("dropped_by_g_plus_1")
                    .and_then(Value::as_arr)
                    .unwrap_or(&[])
                {
                    map.insert(
                        (s(d, "ref"), s(d, "oid")),
                        (s(&inp, "g_plus_1"), s(d, "ref"), s(d, "oid")),
                    );
                }
                let mut out: Vec<(String, String, String)> = map.into_values().collect();
                out.sort();
                let got = Value::Arr(
                    out.into_iter()
                        .map(|(g, r, o)| {
                            Value::obj(&[
                                ("dropped_at_generation", Value::s(&g)),
                                ("oid", Value::s(&o)),
                                ("ref", Value::s(&r)),
                            ])
                        })
                        .collect(),
                );
                cx.check(
                    &id,
                    exp.get("roots_g_plus_1")
                        .map(|w| eqv(w, &got))
                        .unwrap_or(false),
                    "renewal evolution",
                );
            }
        }
        "hpke-rfc9180-a2" => {
            let (sk_e, pk_e) = H::derive_keypair(&hx(&inp, "ikmE"));
            let (sk_r, pk_r) = H::derive_keypair(&hx(&inp, "ikmR"));
            let info = hx(&inp, "info");
            let (enc, mut ctx) = match H::setup_sender_with_ikm(&pk_r, &info, &hx(&inp, "ikmE")) {
                Ok(x) => x,
                Err(e) => {
                    cx.check(&id, false, &e);
                    return;
                }
            };
            if exp.get("pkEm").is_some() {
                cx.check(
                    &id,
                    s(&inp, "kem_id") == "32"
                        && s(&inp, "kdf_id") == "1"
                        && s(&inp, "aead_id") == "3"
                        && s(&inp, "mode") == "0",
                    "suite ids",
                );
                cx.check(
                    &id,
                    hex(&H::pk_bytes(&pk_e)) == s(&exp, "pkEm")
                        && hex(&H::sk_bytes(&sk_e)) == s(&exp, "skEm"),
                    "DeriveKeyPair(ikmE)",
                );
                cx.check(
                    &id,
                    hex(&H::pk_bytes(&pk_r)) == s(&exp, "pkRm")
                        && hex(&H::sk_bytes(&sk_r)) == s(&exp, "skRm"),
                    "DeriveKeyPair(ikmR)",
                );
                cx.check(
                    &id,
                    hex(&enc) == s(&exp, "enc") && s(&exp, "enc") == s(&exp, "pkEm"),
                    "enc",
                );
            } else if let Some(encs) = exp.get("encryptions").and_then(Value::as_arr) {
                let mut rctx = match H::setup_receiver(&sk_r, &enc, &info) {
                    Ok(r) => r,
                    Err(e) => {
                        cx.check(&id, false, &e);
                        return;
                    }
                };
                let pt = hx(&inp, "pt");
                let want: HashMap<u64, &Value> = encs
                    .iter()
                    .filter_map(|x| s(x, "sequence_number").parse().ok().map(|n| (n, x)))
                    .collect();
                let max = want.keys().copied().max().unwrap_or(0);
                let mut ok = !want.is_empty();
                for i in 0..=max {
                    let aad = format!("Count-{i}");
                    let ct = match ctx.seal(&pt, aad.as_bytes()) {
                        Ok(c) => c,
                        Err(_) => {
                            ok = false;
                            break;
                        }
                    };
                    if let Some(w) = want.get(&i) {
                        ok = ok && hex(&ct) == s(w, "ct") && s(w, "aad") == hex(aad.as_bytes());
                    }
                    ok =
                        ok && rctx.open(&ct, aad.as_bytes()).ok().as_deref() == Some(pt.as_slice());
                }
                cx.check(&id, ok, "encryption sequence");
            } else {
                let exports = exp
                    .get("exports")
                    .and_then(Value::as_arr)
                    .map(|a| a.to_vec())
                    .unwrap_or_default();
                let mut ok = !exports.is_empty();
                for x in &exports {
                    let l: usize = s(x, "L").parse().unwrap_or(0);
                    let mut out = vec![0u8; l];
                    ok = ok
                        && ctx.export(&hx(x, "exporter_context"), &mut out).is_ok()
                        && hex(&out) == s(x, "exported_value");
                }
                cx.check(&id, ok, "exports");
            }
        }
        "hpke-envelope" => {
            if accept {
                let obj = inp.get("object").cloned().unwrap_or(Value::Null);
                let pk_raw = b64(&inp, "recipient_encryption_pubkey");
                let sk_raw = hx(&inp, "recipient_encryption_seed_hex");
                cx.check(&id, x25519_pk(&sk_raw) == pk_raw, "recipient keypair");
                let info = H::envelope_info(&pk_raw, &s(&inp, "sender_signing_fingerprint"));
                let aad = H::envelope_aad(
                    &s(&inp, "repo_id"),
                    &s(&inp, "epoch"),
                    &s(&inp, "recipient_fingerprint"),
                );
                let parts: Vec<u8> = strs(&exp, "info_parts")
                    .iter()
                    .flat_map(|p| lp(p))
                    .collect();
                cx.check(
                    &id,
                    hex(&info) == s(&exp, "info_hex") && parts == info,
                    "info construction",
                );
                cx.check(
                    &id,
                    aad == s(&exp, "aad_jcs").as_bytes(),
                    "aad construction",
                );
                let k_repo = hx(&inp, "K_repo_hex");
                let pk = match H::pk_from_bytes(&pk_raw) {
                    Ok(p) => p,
                    Err(e) => {
                        cx.check(&id, false, &e);
                        return;
                    }
                };
                let ikm = hx(&inp, "ikmE_hex");
                let (sk_e, _) = H::derive_keypair(&ikm);
                match H::seal_with_ikm(&pk, &info, &aad, &k_repo, &ikm) {
                    Ok((enc, ct)) => {
                        cx.check(
                            &id,
                            hex(&H::sk_bytes(&sk_e)) == s(&inp, "skE_hex")
                                && hex(&enc) == s(&exp, "enc_hex")
                                && hex(&ct) == s(&exp, "ct_hex"),
                            "deterministic seal == vector enc/ct",
                        );
                        cx.check(
                            &id,
                            b64u(&enc) == s(&exp, "enc")
                                && s(&exp, "enc") == s(&obj, "enc")
                                && b64u(&ct) == s(&exp, "ct")
                                && s(&exp, "ct") == s(&obj, "ct")
                                && ct.len() == 48,
                            "envelope carries enc/ct",
                        );
                        let sk = H::sk_from_bytes(&sk_raw).ok();
                        let opened = sk.and_then(|sk| H::open(&sk, &enc, &info, &aad, &ct));
                        cx.check(
                            &id,
                            opened.as_deref() == Some(k_repo.as_slice())
                                && s(&exp, "opened_K_repo_hex") == hex(&k_repo),
                            "open recovers K_repo",
                        );
                    }
                    Err(e) => cx.check(&id, false, &e),
                }
                let creator = cx
                    .vec_by_id("stored-001")
                    .map(|x| {
                        s(
                            x.get("inputs").unwrap_or(&Value::Null),
                            "creator_signing_pubkey",
                        )
                    })
                    .unwrap_or_default();
                cx.check(
                    &id,
                    verify_signed_object(&obj, &creator, None),
                    "envelope signature",
                );
                cx.check(
                    &id,
                    hex(&signature_preimage(
                        "key_envelope",
                        &obj.without("signature"),
                    )) == s(&exp, "signature_preimage_hex"),
                    "preimage",
                );
                let sb = stored_bytes(&obj);
                cx.check(
                    &id,
                    sb == s(&exp, "stored_bytes").as_bytes()
                        && sha256_hex(&sb) == s(&exp, "stored_bytes_sha256")
                        && sb.len().to_string() == s(&exp, "size_bytes"),
                    "stored bytes",
                );
                let rc = exp
                    .get("genesis_envelope_receipt")
                    .cloned()
                    .unwrap_or(Value::Null);
                let want_rc = Value::obj(&[
                    ("object_kind", Value::s("key_envelope")),
                    ("epoch", Value::s(&s(&obj, "epoch"))),
                    (
                        "recipient_fingerprint",
                        Value::s(&s(&obj, "recipient_fingerprint")),
                    ),
                    (
                        "stored_bytes_sha256",
                        Value::s(&s(&exp, "stored_bytes_sha256")),
                    ),
                    ("size_bytes", Value::s(&s(&exp, "size_bytes"))),
                ]);
                cx.check(&id, eqv(&rc, &want_rc), "receipt shape");
                let g = cx
                    .vec_by_id("stored-001")
                    .and_then(|x| x.get("inputs")?.get("object"))
                    .cloned()
                    .unwrap_or(Value::Null);
                let g_rc = g
                    .get("envelopes")
                    .and_then(Value::as_arr)
                    .and_then(|a| a.first())
                    .cloned()
                    .unwrap_or(Value::Null);
                cx.check(
                    &id,
                    eqv(&g_rc, &rc) && envelope_binds_genesis(&obj, &g),
                    "receipt == the genesis envelope receipt",
                );
            } else if exp.get("open").is_some() {
                let sk_raw = hx(&inp, "recipient_encryption_seed_hex");
                let (enc, ct, info, aad) = (
                    hx(&inp, "enc_hex"),
                    hx(&inp, "ct_hex"),
                    hx(&inp, "info_hex"),
                    s(&inp, "aad_jcs").into_bytes(),
                );
                let opened = H::sk_from_bytes(&sk_raw)
                    .ok()
                    .and_then(|sk| H::open(&sk, &enc, &info, &aad, &ct));
                cx.check(&id, opened.is_none(), "tampered open must fail");
                let m = inp.get("mutation").cloned().unwrap_or(Value::Null);
                if let Some(field) = m.get("aad_field").and_then(Value::as_str) {
                    let base = parse_lenient_layout(&H::envelope_aad(
                        &s(&inp, "repo_id"),
                        &s(&inp, "epoch"),
                        &s(&inp, "recipient_fingerprint"),
                    ))
                    .unwrap();
                    let val = m.get("value").cloned().unwrap_or(Value::Null);
                    let mutated = base.with(field, val.clone());
                    cx.check(
                        &id,
                        jcs(&mutated) == aad && base.get(field) != Some(&val),
                        "aad mutation is real",
                    );
                } else if m.get("info_parts").is_some() {
                    let canon = H::envelope_info(
                        &x25519_pk(&sk_raw),
                        &s(&inp, "sender_signing_fingerprint"),
                    );
                    let parts: Vec<u8> =
                        strs(&m, "info_parts").iter().flat_map(|p| lp(p)).collect();
                    cx.check(&id, parts == info && info != canon, "info mutation is real");
                } else {
                    let r = cx
                        .vec_by_id("hpke-envelope-001")
                        .cloned()
                        .unwrap_or(Value::Null);
                    let re = r.get("expected").cloned().unwrap_or(Value::Null);
                    let ri = r.get("inputs").cloned().unwrap_or(Value::Null);
                    let good = [
                        s(&re, "enc_hex"),
                        s(&re, "ct_hex"),
                        s(&ri, "recipient_encryption_seed_hex"),
                    ];
                    let got = [hex(&enc), hex(&ct), hex(&sk_raw)];
                    let diff = got.iter().zip(good.iter()).filter(|(a, b)| a != b).count();
                    cx.check(&id, diff == 1, "exactly one of enc/ct/key mutated");
                }
            } else if exp.get("open_attempted").is_some() {
                let obj = inp.get("object").cloned().unwrap_or(Value::Null);
                let sig_ok = verify_signed_object(&obj, &s(&inp, "signer_pubkey"), None);
                cx.check(
                    &id,
                    !sig_ok && s(&exp, "open_attempted") == "false",
                    "signature fails -> no open",
                );
                let g = cx
                    .vec_by_id("stored-001")
                    .and_then(|x| x.get("inputs")?.get("object"))
                    .cloned()
                    .unwrap_or(Value::Null);
                let would =
                    open_envelope_for_genesis(&obj, &g, &hx(&inp, "recipient_encryption_seed_hex"))
                        .is_some();
                cx.check(
                    &id,
                    would == (s(&exp, "ct_would_open") == "true"),
                    "ct would open (order matters)",
                );
            }
        }
        "hpke-recovery" => {
            if let Some(rr) = inp.get("recovery_receipt") {
                let g = inp.get("genesis").cloned().unwrap_or(Value::Null);
                let env = inp.get("key_envelope").cloned().unwrap_or(Value::Null);
                let sk_raw = hx(&inp, "recipient_encryption_seed_hex");
                let pub_ = s(&g, "creator_signing_pubkey");
                cx.check(
                    &id,
                    verify_signed_object(rr, &pub_, None)
                        && verify_signed_object(&g, &pub_, None)
                        && verify_signed_object(&env, &pub_, None),
                    "three signatures",
                );
                let gsha = stored_bytes_sha256(&g);
                cx.check(
                    &id,
                    s(rr, "genesis_sha256") == gsha && gsha == s(&exp, "genesis_sha256"),
                    "receipt pins genesis",
                );
                let env0 = g
                    .get("envelopes")
                    .and_then(Value::as_arr)
                    .and_then(|a| a.first())
                    .cloned()
                    .unwrap_or(Value::Null);
                cx.check(
                    &id,
                    s(rr, "creator_signing_fingerprint") == s(&g, "writer_key_id")
                        && s(rr, "creator_encryption_fingerprint")
                            == s(&env0, "recipient_fingerprint")
                        && genesis_bindings_ok(&g),
                    "fingerprints",
                );
                cx.check(
                    &id,
                    envelope_binds_genesis(&env, &g)
                        && stored_bytes_sha256(&env) == s(&exp, "envelope_stored_bytes_sha256"),
                    "envelope binds",
                );
                let k_repo = open_envelope_for_genesis(&env, &g, &sk_raw);
                cx.check(
                    &id,
                    k_repo.as_ref().map(|k| hex(k)) == Some(s(&exp, "K_repo_hex")),
                    "open -> K_repo",
                );
                let k_repo = k_repo.unwrap_or_default();
                let k_obj = hkdf_sha256_32(
                    &k_repo,
                    &k_obj_info(
                        &s(&g, "repo_id"),
                        &s(&g, "epoch"),
                        "wal_pack",
                        &s(&inp, "wal_object_id"),
                    ),
                );
                cx.check(&id, hex(&k_obj) == s(&exp, "k_obj_hex"), "k_obj");
                let blob = hx(&inp, "wal_frame_hex");
                let aad = frame_aad(
                    &s(&g, "repo_id"),
                    "wal_pack",
                    &s(&inp, "wal_object_id"),
                    &s(&g, "epoch"),
                );
                match open_frame(&k_obj, &aad, &blob) {
                    Ok(pt) => cx.check(
                        &id,
                        sha256_hex(&pt) == s(&exp, "wal_plaintext_sha256"),
                        "WAL frame decrypts",
                    ),
                    Err(e) => cx.check(&id, false, &format!("WAL frame decrypt failed: {e:?}")),
                }
            } else {
                let obj = inp.get("object").cloned().unwrap_or(Value::Null);
                let g = inp.get("genesis").cloned().unwrap_or(Value::Null);
                let sig_ok = verify_signed_object(&obj, &s(&inp, "signer_pubkey"), None);
                let want_sig = exp
                    .get("signature_valid")
                    .and_then(Value::as_str)
                    .unwrap_or("true")
                    == "true";
                cx.check(&id, sig_ok == want_sig, "signature");
                let pin = s(&obj, "genesis_sha256") == stored_bytes_sha256(&g);
                cx.check(
                    &id,
                    pin == (s(&exp, "genesis_sha256_matches") == "true"),
                    "genesis pin",
                );
                let env0 = g
                    .get("envelopes")
                    .and_then(Value::as_arr)
                    .and_then(|a| a.first())
                    .cloned()
                    .unwrap_or(Value::Null);
                let fp = s(&obj, "creator_signing_fingerprint") == s(&g, "writer_key_id")
                    && s(&obj, "creator_encryption_fingerprint")
                        == s(&env0, "recipient_fingerprint");
                let want_fp = exp
                    .get("fingerprints_match")
                    .and_then(Value::as_str)
                    .unwrap_or("true")
                    == "true";
                cx.check(&id, fp == want_fp, "fingerprints");
                cx.check(&id, (sig_ok && pin && fp) == accept, "verdict");
            }
        }
        "hpke-genesis-binding" => {
            if let (Some(env), Some(g)) = (inp.get("stored_key_envelope"), inp.get("genesis")) {
                let (env, g) = (env.clone(), g.clone());
                let sig_ok = verify_signed_object(&env, &s(&g, "creator_signing_pubkey"), None);
                cx.check(
                    &id,
                    sig_ok == (s(&exp, "envelope_signature_valid") == "true"),
                    "envelope signature",
                );
                cx.check(
                    &id,
                    (s(&env, "created_by") == s(&g, "writer_key_id"))
                        == (s(&exp, "created_by_matches") == "true"),
                    "created_by",
                );
                let opened =
                    open_envelope_for_genesis(&env, &g, &hx(&inp, "recipient_encryption_seed_hex"));
                cx.check(
                    &id,
                    opened.is_none() == (s(&exp, "open_with_genesis_info") == "fail"),
                    "open under genesis info",
                );
                let b = envelope_binds_genesis(&env, &g);
                cx.check(
                    &id,
                    b == (s(&exp, "binding_ok") == "true") && b == accept,
                    "binding verdict",
                );
            } else if let (Some(g), Some(pk)) = (
                inp.get("object"),
                inp.get("signer_pubkey").and_then(Value::as_str),
            ) {
                let g = g.clone();
                let sig_ok = verify_signed_object(&g, pk, None);
                cx.check(
                    &id,
                    sig_ok == (s(&exp, "signature_valid") == "true"),
                    "signature",
                );
                let ok;
                if let Some(env) = inp.get("stored_key_envelope") {
                    ok = envelope_binds_genesis(env, &g);
                    let env0 = g
                        .get("envelopes")
                        .and_then(Value::as_arr)
                        .and_then(|a| a.first())
                        .cloned()
                        .unwrap_or(Value::Null);
                    let sh = stored_bytes_sha256(env);
                    cx.check(
                        &id,
                        sh == s(&exp, "stored_envelope_sha256")
                            && sh != s(&env0, "stored_bytes_sha256"),
                        "receipt hash differs from stored envelope",
                    );
                } else {
                    ok = genesis_bindings_ok(&g);
                    let env0 = g
                        .get("envelopes")
                        .and_then(Value::as_arr)
                        .and_then(|a| a.first())
                        .cloned()
                        .unwrap_or(Value::Null);
                    if let Some(w) = exp
                        .get("expected_recipient_fingerprint")
                        .and_then(Value::as_str)
                    {
                        let ek = format!(
                            "ek_{}",
                            key_fingerprint(&b64(&g, "creator_encryption_pubkey"))
                        );
                        cx.check(
                            &id,
                            ek == w && w != s(&env0, "recipient_fingerprint"),
                            "foreign fingerprint",
                        );
                    }
                    if let Some(w) = exp.get("expected_writer_key_id").and_then(Value::as_str) {
                        let vk =
                            format!("vk_{}", key_fingerprint(&b64(&g, "creator_signing_pubkey")));
                        cx.check(
                            &id,
                            vk == w && w != s(&g, "writer_key_id"),
                            "unrelated writer_key_id",
                        );
                    }
                }
                cx.check(
                    &id,
                    ok == (s(&exp, "binding_ok") == "true") && ok == accept,
                    "binding verdict",
                );
            }
            // the epoch-const case is the generic schema check above
        }
        "hpke-info-near-neighbors" => {
            let pk_raw = hx(&inp, "recipient_x25519_public_key_hex");
            let sk_raw = hx(&inp, "recipient_encryption_seed_hex");
            cx.check(&id, x25519_pk(&sk_raw) == pk_raw, "recipient keypair");
            let digest_hex = sha256_hex(&pk_raw);
            let created_by = s(&inp, "created_by");
            let mut canon_info = lp("r402s/v0/envelope");
            canon_info.extend(lp("r402s-1"));
            canon_info.extend(lp(&digest_hex));
            canon_info.extend(lp(&created_by));
            let canon_aad = jcs(&Value::obj(&[
                ("repo_id", Value::s(&s(&inp, "repo_id"))),
                ("epoch", Value::s(&s(&inp, "epoch"))),
                ("recipient_kind", Value::s("principal")),
                (
                    "recipient_fingerprint",
                    Value::s(&s(&inp, "recipient_fingerprint")),
                ),
            ]));
            cx.check(
                &id,
                canon_info == H::envelope_info(&pk_raw, &created_by)
                    && canon_aad
                        == H::envelope_aad(
                            &s(&inp, "repo_id"),
                            &s(&inp, "epoch"),
                            &s(&inp, "recipient_fingerprint"),
                        ),
                "D188 formula == this crate's construction",
            );
            let k_repo = hx(&inp, "K_repo_hex");
            let sk = H::sk_from_bytes(&sk_raw).ok();
            if accept {
                let comps = strs(&exp, "info_components");
                cx.check(
                    &id,
                    comps
                        == [
                            "r402s/v0/envelope",
                            "r402s-1",
                            digest_hex.as_str(),
                            created_by.as_str(),
                        ]
                        && digest_hex.len() == 64
                        && created_by.starts_with("vk_"),
                    "components",
                );
                let lps: Vec<String> = comps.iter().map(|c| hex(&lp(c))).collect();
                let joined: Vec<u8> = comps.iter().flat_map(|c| lp(c)).collect();
                cx.check(
                    &id,
                    lps == strs(&exp, "info_components_lp_hex")
                        && hex(&joined) == s(&exp, "info_hex")
                        && joined == canon_info,
                    "info bytes",
                );
                cx.check(&id, canon_aad == s(&exp, "aad_jcs").as_bytes(), "aad bytes");
                let pk = H::pk_from_bytes(&pk_raw).ok();
                let sealed = pk.and_then(|pk| {
                    H::seal_with_ikm(&pk, &canon_info, &canon_aad, &k_repo, &hx(&inp, "ikmE_hex"))
                        .ok()
                });
                match sealed {
                    Some((enc, ct)) => {
                        cx.check(
                            &id,
                            hex(&enc) == s(&exp, "enc_hex") && hex(&ct) == s(&exp, "ct_hex"),
                            "deterministic seal == enc/ct",
                        );
                        let r = cx
                            .vec_by_id("hpke-envelope-001")
                            .and_then(|x| x.get("expected"))
                            .cloned()
                            .unwrap_or(Value::Null);
                        cx.check(
                            &id,
                            s(&exp, "enc_hex") == s(&r, "enc_hex")
                                && s(&exp, "ct_hex") == s(&r, "ct_hex"),
                            "same bytes as hpke-envelope-001",
                        );
                        let opened = sk
                            .as_ref()
                            .and_then(|sk| H::open(sk, &enc, &canon_info, &canon_aad, &ct));
                        cx.check(
                            &id,
                            opened.as_deref() == Some(k_repo.as_slice())
                                && s(&exp, "opened_K_repo_hex") == hex(&k_repo),
                            "canonical opens",
                        );
                    }
                    None => cx.check(&id, false, "seal failed"),
                }
            } else {
                let (enc, ct, info, aad) = (
                    hx(&inp, "enc_hex"),
                    hx(&inp, "ct_hex"),
                    hx(&inp, "info_hex"),
                    s(&inp, "aad_jcs").into_bytes(),
                );
                let m = inp.get("mutation").cloned().unwrap_or(Value::Null);
                if let Some(kind) = m.get("info_encoding").and_then(Value::as_str) {
                    // rebuild the WRONG encoding from its description — the vector must be the named near-neighbor
                    let want: Vec<u8> = match kind {
                        "first-component-only-lp" => {
                            let mut w = lp("r402s/v0/envelope");
                            w.extend_from_slice(b"r402s-1");
                            w.extend_from_slice(digest_hex.as_bytes());
                            w.extend_from_slice(created_by.as_bytes());
                            w
                        }
                        "raw-digest-32" => {
                            let mut w = lp("r402s/v0/envelope");
                            w.extend(lp("r402s-1"));
                            w.extend_from_slice(&32u32.to_be_bytes());
                            w.extend(unhex(&digest_hex).unwrap());
                            w.extend(lp(&created_by));
                            w
                        }
                        "bare-sender-hex" => {
                            let mut w = lp("r402s/v0/envelope");
                            w.extend(lp("r402s-1"));
                            w.extend(lp(&digest_hex));
                            w.extend(lp(created_by.get(3..).unwrap_or("")));
                            w
                        }
                        _ => Vec::new(),
                    };
                    cx.check(
                        &id,
                        !want.is_empty() && info == want && info != canon_info && aad == canon_aad,
                        "near-neighbor info is the named wrong encoding",
                    );
                } else {
                    let base = parse_lenient_layout(&canon_aad).unwrap();
                    let field = s(&m, "aad_field");
                    let val = m.get("value").cloned().unwrap_or(Value::Null);
                    cx.check(
                        &id,
                        jcs(&base.with(&field, val.clone())) == aad
                            && base.get(&field) != Some(&val)
                            && info == canon_info,
                        "aad flip is real and independent",
                    );
                }
                let control = sk
                    .as_ref()
                    .and_then(|sk| H::open(sk, &enc, &canon_info, &canon_aad, &ct));
                cx.check(
                    &id,
                    control.as_deref() == Some(k_repo.as_slice()),
                    "control: the canonical construction still opens these bytes",
                );
                let nn = sk
                    .as_ref()
                    .and_then(|sk| H::open(sk, &enc, &info, &aad, &ct));
                cx.check(&id, nn.is_none(), "near-neighbor must fail to open");
            }
        }
        "forward-integrity-fault" => {
            // hash-guard half only: the model step is the private executor's job
            let stored = inp
                .get("stored_cut_bytes_hex")
                .and_then(Value::as_str)
                .map(|h| unhex(h).unwrap_or_default());
            let guard = stored
                .as_ref()
                .map(|b| sha256_hex(b) == s(&inp, "p_cut_sha256"))
                .unwrap_or(false);
            let env_flag = inp
                .get("environment")
                .map(|e| s(e, "stored_cut_hash_match") == "true")
                .unwrap_or(false);
            cx.check(
                &id,
                env_flag == guard,
                "stored_cut_hash_match RECOMPUTED from the stored bytes vs p_cut_sha256",
            );
            cx.check(
                &id,
                s(&exp, "forward_guard") == if guard { "true" } else { "false" },
                "forward_guard verdict",
            );
            let want_sha = exp
                .get("stored_bytes_sha256")
                .cloned()
                .unwrap_or(Value::Null);
            let got_sha = stored
                .as_ref()
                .map(|b| Value::Str(sha256_hex(b)))
                .unwrap_or(Value::Null);
            cx.check(&id, eqv(&want_sha, &got_sha), "stored_bytes_sha256");
            if guard {
                cx.check(
                    &id,
                    accept && v.get("reject_code").is_none(),
                    "a true forward guard is never a fault",
                );
            } else {
                cx.check(
                    &id,
                    vd == "reject" && s(v, "reject_code") == "CUT_STORAGE_INTEGRITY_FAILURE",
                    "a false forward guard is the typed storage-integrity fault",
                );
                cx.check(
                    &id,
                    !strs(&exp, "enabled_live_transitions")
                        .iter()
                        .any(|t| t == "record_put_issued_p_credit"),
                    "no record PUT on a false forward guard",
                );
            }
        }
        "heads_listing_pagination" | "abnf-schema-portability" | "dr-journal-precedence" => {
            // deliberately not replayed by this lineage — see the module docs
        }
        other => cx.check(&id, false, &format!("unknown class {other}")),
    }
}

/// `S < L` for a 32-byte little-endian scalar (the Ed25519 group order).
fn scalar_lt_l(s: &[u8]) -> bool {
    const L: [u8; 32] = [
        0xed, 0xd3, 0xf5, 0x5c, 0x1a, 0x63, 0x12, 0x58, 0xd6, 0x9c, 0xf7, 0xa2, 0xde, 0xf9, 0xde,
        0x14, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x10,
    ];
    if s.len() != 32 {
        return false;
    }
    for i in (0..32).rev() {
        if s[i] != L[i] {
            return s[i] < L[i];
        }
    }
    false
}

fn interop(cx: &mut Ctx, gold: &Value) {
    let gid = "golden.json";
    cx.check(
        gid,
        s(gold, "x-r402s-revision") == cx.report.revision
            && s(gold, "format") == "r402s/v0/hpke-interop",
        "golden header",
    );
    let cases = gold
        .get("cases")
        .and_then(Value::as_arr)
        .map(|a| a.to_vec())
        .unwrap_or_default();
    cx.report.interop_cases = cases.len();
    for c in &cases {
        let id = format!("golden:{}", s(c, "label"));
        let rec = c.get("recipient").cloned().unwrap_or(Value::Null);
        let snd = c.get("sender").cloned().unwrap_or(Value::Null);
        let sbr = c.get("sealed_by_reference").cloned().unwrap_or(Value::Null);
        let env = sbr.get("key_envelope").cloned().unwrap_or(Value::Null);
        let sk_raw = hx(&rec, "x25519_private_key_hex");
        let pk_raw = hx(&rec, "x25519_public_key_hex");
        cx.check(
            &id,
            x25519_pk(&sk_raw) == pk_raw
                && b64u(&pk_raw) == s(&rec, "public_key_b64u")
                && format!("ek_{}", key_fingerprint(&pk_raw)) == s(&rec, "fingerprint"),
            "recipient key",
        );
        cx.check(
            &id,
            format!("vk_{}", key_fingerprint(&b64(&snd, "signing_pubkey")))
                == s(&snd, "signing_fingerprint"),
            "sender fingerprint",
        );
        let info = H::envelope_info(&pk_raw, &s(&snd, "signing_fingerprint"));
        let aad = H::envelope_aad(
            &s(&env, "repo_id"),
            &s(&env, "epoch"),
            &s(&rec, "fingerprint"),
        );
        let info_doc = c.get("info").cloned().unwrap_or(Value::Null);
        let aad_doc = c.get("aad").cloned().unwrap_or(Value::Null);
        let parts: Vec<u8> = strs(&info_doc, "parts")
            .iter()
            .flat_map(|p| lp(p))
            .collect();
        cx.check(
            &id,
            hex(&info) == s(&info_doc, "hex")
                && parts == info
                && aad == s(&aad_doc, "jcs").as_bytes()
                && hex(&aad) == s(&aad_doc, "hex"),
            "info/aad",
        );
        let k_repo = hx(c, "plaintext_K_repo_hex");
        let eph = c.get("ephemeral").cloned().unwrap_or(Value::Null);
        let ikm = hx(&eph, "ikmE_hex");
        let (sk_e, _) = H::derive_keypair(&ikm);
        let pk = match H::pk_from_bytes(&pk_raw) {
            Ok(p) => p,
            Err(e) => {
                cx.check(&id, false, &e);
                continue;
            }
        };
        let (enc, ct) = match H::seal_with_ikm(&pk, &info, &aad, &k_repo, &ikm) {
            Ok(x) => x,
            Err(e) => {
                cx.check(&id, false, &e);
                continue;
            }
        };
        cx.check(
            &id,
            hex(&enc) == s(&sbr, "enc_hex")
                && s(&sbr, "enc_hex") == s(&eph, "pkE_hex")
                && hex(&ct) == s(&sbr, "ct_hex")
                && hex(&H::sk_bytes(&sk_e)) == s(&eph, "skE_hex"),
            "reference seal reproduced byte-for-byte (rust-hpke, DeriveKeyPair(ikmE))",
        );
        let sk = H::sk_from_bytes(&sk_raw).ok();
        let opened = sk
            .as_ref()
            .and_then(|sk| H::open(sk, &enc, &info, &aad, &ct));
        cx.check(
            &id,
            opened.as_deref() == Some(k_repo.as_slice()),
            "reference envelope opens",
        );
        // INTEROP.md rule 1: signature FIRST, then open through the envelope object itself
        let schema_ok = cx.schema_ok(&id, "key_envelope.json", &env);
        let sig_ok = verify_signed_object(&env, &s(&snd, "signing_pubkey"), None);
        cx.check(
            &id,
            schema_ok
                && sig_ok
                && s(&env, "enc") == b64u(&enc)
                && s(&env, "ct") == b64u(&ct)
                && stored_bytes_sha256(&env) == s(&sbr, "stored_bytes_sha256"),
            "signed envelope object",
        );
        let via_obj = sk.as_ref().and_then(|sk| {
            if sig_ok {
                H::open_envelope_object(&env, &pk_raw, sk)
            } else {
                None
            }
        });
        cx.check(
            &id,
            via_obj.as_deref() == Some(k_repo.as_slice()),
            "signature-then-open through the envelope object",
        );
        for t in c
            .get("tamper_must_fail")
            .and_then(Value::as_arr)
            .unwrap_or(&[])
        {
            let taad = t
                .get("aad_jcs")
                .and_then(Value::as_str)
                .map(|x| x.as_bytes().to_vec())
                .unwrap_or_else(|| aad.clone());
            let r = sk
                .as_ref()
                .and_then(|sk| H::open(sk, &hx(t, "enc_hex"), &info, &taad, &hx(t, "ct_hex")));
            cx.check(&id, r.is_none(), &format!("tamper: {}", s(t, "what")));
        }
    }
}
