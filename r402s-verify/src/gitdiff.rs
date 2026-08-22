//! `r402s-verify git <repo> <materialization>` — DIFFERENTIAL git validation.
//!
//! Two independent views of the same object set are compared:
//! 1. what `git` reports (refs, HEAD target, the reachable closure via
//!    `rev-list --objects`, `fsck --no-dangling` connectivity), and
//! 2. what THIS verifier rebuilds — every reachable object's content is pulled
//!    through `cat-file --batch` and its oid RECOMPUTED here as
//!    `SHA-1("<type> <size>\0" ‖ content)`; an object whose recomputed oid
//!    differs from the name git filed it under is a corruption, whatever git says.
//!
//! Then the materialization (a restore from the vault) is compared to the
//! source repository: canonical refs, HEAD target, and the reachable oid set
//! must be IDENTICAL (protocol §4.7 acceptance: "every covered ref resolves at
//! its exact oid; `git fsck --no-dangling` full connectivity"). With
//! `K_digest("objectset")` the `"objectset"` commitment is computed so it can
//! be compared bytewise to a checkpoint manifest's `object_set_hmac`.
//!
//! Git is invoked with explicit argv only, a cleared environment,
//! `GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL=/dev/null`, and hooks disabled
//! (§6.6 hardened-git posture).

use crate::codec::hex;
use crate::json::Value;
use crate::kdf::{keyed_commitment, objectset_content};
use sha1::{Digest, Sha1};
use std::collections::{BTreeMap, BTreeSet};
use std::io::Write;
use std::path::Path;
use std::process::{Command, Stdio};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HeadTarget {
    Symref(String),
    Detached(String),
}

#[derive(Debug, Default)]
pub struct GitView {
    pub refs: BTreeMap<String, String>,
    pub head: Option<HeadTarget>,
    pub reachable: BTreeSet<String>,
    pub rehash_mismatches: Vec<String>,
    pub fsck_ok: bool,
    pub fsck_output: String,
}

pub fn git_cmd(repo: &Path) -> Command {
    let mut c = Command::new("git");
    c.env_clear();
    if let Ok(p) = std::env::var("PATH") {
        c.env("PATH", p);
    }
    c.env("GIT_CONFIG_NOSYSTEM", "1");
    c.env("GIT_CONFIG_GLOBAL", "/dev/null");
    c.env("HOME", "/nonexistent");
    c.env("LC_ALL", "C");
    c.arg("-C").arg(repo);
    c.arg("-c").arg("core.hooksPath=/dev/null");
    c.arg("-c").arg("core.fsmonitor=false");
    c.arg("--no-replace-objects");
    c
}

fn run(repo: &Path, args: &[&str]) -> Result<String, String> {
    let out = git_cmd(repo)
        .args(args)
        .output()
        .map_err(|e| format!("git {}: {e}", args.join(" ")))?;
    if !out.status.success() {
        return Err(format!(
            "git {} failed: {}",
            args.join(" "),
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

pub fn is_canonical_ref(name: &str) -> bool {
    name.starts_with("refs/heads/")
        || name.starts_with("refs/tags/")
        || name.starts_with("refs/run402/")
}

pub fn view(repo: &Path) -> Result<GitView, String> {
    let mut v = GitView::default();
    let refs = run(repo, &["for-each-ref", "--format=%(objectname) %(refname)"])?;
    for line in refs.lines() {
        if let Some((oid, name)) = line.split_once(' ') {
            if is_canonical_ref(name) {
                v.refs.insert(name.to_string(), oid.to_string());
            }
        }
    }
    let sym = git_cmd(repo)
        .args(["symbolic-ref", "-q", "HEAD"])
        .output()
        .map_err(|e| e.to_string())?;
    if sym.status.success() {
        v.head = Some(HeadTarget::Symref(
            String::from_utf8_lossy(&sym.stdout).trim().to_string(),
        ));
    } else {
        let det = git_cmd(repo)
            .args(["rev-parse", "--verify", "-q", "HEAD"])
            .output()
            .map_err(|e| e.to_string())?;
        if det.status.success() {
            v.head = Some(HeadTarget::Detached(
                String::from_utf8_lossy(&det.stdout).trim().to_string(),
            ));
        }
    }
    // coverage = canonical refs ∪ the HEAD target (a detached commit, or a symref's branch tip)
    let mut tips: Vec<String> = v.refs.values().cloned().collect();
    if let Some(HeadTarget::Detached(o)) = &v.head {
        tips.push(o.clone());
    }
    tips.sort();
    tips.dedup();
    if !tips.is_empty() {
        let mut child = git_cmd(repo)
            .args(["rev-list", "--objects", "--no-object-names", "--stdin"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("git rev-list: {e}"))?;
        {
            let mut stdin = child.stdin.take().unwrap();
            for t in &tips {
                writeln!(stdin, "{t}").map_err(|e| e.to_string())?;
            }
        }
        let out = child.wait_with_output().map_err(|e| e.to_string())?;
        if !out.status.success() {
            return Err(format!(
                "git rev-list failed: {}",
                String::from_utf8_lossy(&out.stderr).trim()
            ));
        }
        for line in String::from_utf8_lossy(&out.stdout).lines() {
            let oid = line.trim();
            if oid.len() == 40 {
                v.reachable.insert(oid.to_string());
            }
        }
        // tag objects themselves are part of the reachable set when a tag ref names them
        for oid in v.refs.values() {
            v.reachable.insert(oid.clone());
        }
    }
    v.rehash_mismatches = rehash(repo, &v.reachable)?;
    let fsck = git_cmd(repo)
        .args(["fsck", "--no-dangling", "--connectivity-only"])
        .output()
        .map_err(|e| e.to_string())?;
    v.fsck_ok = fsck.status.success();
    v.fsck_output = format!(
        "{}{}",
        String::from_utf8_lossy(&fsck.stdout),
        String::from_utf8_lossy(&fsck.stderr)
    )
    .trim()
    .to_string();
    Ok(v)
}

/// Pull every object through `cat-file --batch` and recompute its oid independently.
fn rehash(repo: &Path, oids: &BTreeSet<String>) -> Result<Vec<String>, String> {
    if oids.is_empty() {
        return Ok(vec![]);
    }
    let mut child = git_cmd(repo)
        .args(["cat-file", "--batch"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("git cat-file: {e}"))?;
    {
        let mut stdin = child.stdin.take().unwrap();
        for o in oids {
            writeln!(stdin, "{o}").map_err(|e| e.to_string())?;
        }
    }
    let out = child.wait_with_output().map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(format!(
            "git cat-file failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    let data = out.stdout;
    let mut mismatches = Vec::new();
    let mut i = 0usize;
    while i < data.len() {
        let nl = data[i..]
            .iter()
            .position(|&b| b == b'\n')
            .ok_or("cat-file: truncated header")?
            + i;
        let header = String::from_utf8_lossy(&data[i..nl]).to_string();
        let parts: Vec<&str> = header.split(' ').collect();
        if parts.len() == 2 && parts[1] == "missing" {
            mismatches.push(format!("{}: missing", parts[0]));
            i = nl + 1;
            continue;
        }
        if parts.len() != 3 {
            return Err(format!("cat-file: bad header {header:?}"));
        }
        let size: usize = parts[2].parse().map_err(|_| "cat-file: bad size")?;
        let body = &data[nl + 1..nl + 1 + size];
        let mut h = Sha1::new();
        h.update(format!("{} {}\0", parts[1], size).as_bytes());
        h.update(body);
        let got = hex(&h.finalize());
        if got != parts[0] {
            mismatches.push(format!("{}: content re-hashes to {got}", parts[0]));
        }
        i = nl + 1 + size + 1; // trailing LF
    }
    Ok(mismatches)
}

#[derive(Debug, Default)]
pub struct DiffReport {
    pub failures: Vec<String>,
    pub repo_objects: usize,
    pub materialization_objects: usize,
    pub objectset_hmac: Option<String>,
    pub refmap_hmac: Option<String>,
}

impl DiffReport {
    pub fn ok(&self) -> bool {
        self.failures.is_empty()
    }
}

pub struct DiffOptions<'a> {
    /// A plaintext `ref_state` object (decrypted) whose `refs` + `head_target` must match the materialization.
    pub ref_state: Option<&'a Value>,
    pub k_digest_objectset: Option<[u8; 32]>,
    pub expect_object_set_hmac: Option<String>,
}

fn head_target_value(h: &Option<HeadTarget>) -> Value {
    match h {
        Some(HeadTarget::Symref(r)) => {
            Value::obj(&[("kind", Value::s("symref")), ("ref", Value::s(r))])
        }
        Some(HeadTarget::Detached(o)) => {
            Value::obj(&[("kind", Value::s("detached")), ("oid", Value::s(o))])
        }
        None => Value::Null,
    }
}

pub fn differential(
    repo: &Path,
    materialization: &Path,
    opts: &DiffOptions,
) -> Result<DiffReport, String> {
    let a = view(repo)?;
    let b = view(materialization)?;
    let mut r = DiffReport {
        repo_objects: a.reachable.len(),
        materialization_objects: b.reachable.len(),
        ..Default::default()
    };
    for (label, v) in [("repo", &a), ("materialization", &b)] {
        for m in &v.rehash_mismatches {
            r.failures.push(format!(
                "{label}: object {m} (independent SHA-1 rebuild disagrees with git)"
            ));
        }
        if !v.fsck_ok {
            r.failures.push(format!(
                "{label}: git fsck --no-dangling failed: {} (CHECKPOINT_INCOMPLETE)",
                v.fsck_output
            ));
        }
    }
    if a.refs != b.refs {
        let only_a: Vec<_> = a
            .refs
            .iter()
            .filter(|(k, v)| b.refs.get(*k) != Some(v))
            .map(|(k, v)| format!("{k}={v}"))
            .collect();
        let only_b: Vec<_> = b
            .refs
            .iter()
            .filter(|(k, v)| a.refs.get(*k) != Some(v))
            .map(|(k, v)| format!("{k}={v}"))
            .collect();
        r.failures.push(format!(
            "canonical refs differ: repo-only {only_a:?}; materialization-only {only_b:?}"
        ));
    }
    if a.head != b.head {
        r.failures.push(format!(
            "HEAD target differs: repo {:?} vs materialization {:?}",
            a.head, b.head
        ));
    }
    if a.reachable != b.reachable {
        let missing: Vec<_> = a
            .reachable
            .difference(&b.reachable)
            .take(10)
            .cloned()
            .collect();
        let extra: Vec<_> = b
            .reachable
            .difference(&a.reachable)
            .take(10)
            .cloned()
            .collect();
        r.failures.push(format!(
            "reachable object sets differ ({} vs {}): missing from materialization {missing:?}…; extra {extra:?}…",
            a.reachable.len(),
            b.reachable.len()
        ));
    }
    if let Some(rs) = opts.ref_state {
        let want: BTreeMap<String, String> = rs
            .get("refs")
            .and_then(Value::as_obj)
            .map(|o| {
                o.iter()
                    .filter_map(|(k, v)| v.as_str().map(|x| (k.clone(), x.to_string())))
                    .collect()
            })
            .unwrap_or_default();
        if want != b.refs {
            r.failures
                .push("ref_state.refs != the materialization's canonical refs".into());
        }
        let ht = rs.get("head_target").cloned().unwrap_or(Value::Null);
        if crate::json::jcs(&ht) != crate::json::jcs(&head_target_value(&b.head)) {
            r.failures
                .push("ref_state.head_target != the materialization's HEAD target".into());
        }
    }
    if let Some(k) = opts.k_digest_objectset {
        let oids: Vec<String> = b.reachable.iter().cloned().collect();
        let hm = keyed_commitment(&k, &objectset_content(&oids));
        if let Some(want) = &opts.expect_object_set_hmac {
            if *want != hm {
                r.failures.push(
                    "restored_object_set_hmac != the expected object_set_hmac (bytewise)".into(),
                );
            }
        }
        r.objectset_hmac = Some(hm);
    }
    Ok(r)
}

pub fn report_value(r: &DiffReport) -> Value {
    Value::obj(&[
        (
            "result",
            Value::s(if r.ok() {
                "restored_and_verified"
            } else {
                "failed"
            }),
        ),
        (
            "repo_reachable_objects",
            Value::s(&r.repo_objects.to_string()),
        ),
        (
            "materialization_reachable_objects",
            Value::s(&r.materialization_objects.to_string()),
        ),
        (
            "restored_object_set_hmac",
            r.objectset_hmac
                .as_deref()
                .map(Value::s)
                .unwrap_or(Value::Null),
        ),
        (
            "failures",
            Value::Arr(r.failures.iter().map(|x| Value::s(x)).collect()),
        ),
    ])
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sh(dir: &Path, args: &[&str]) {
        let st = git_cmd(dir)
            .args(args)
            .env("GIT_AUTHOR_NAME", "t")
            .env("GIT_AUTHOR_EMAIL", "t@t")
            .env("GIT_COMMITTER_NAME", "t")
            .env("GIT_COMMITTER_EMAIL", "t@t")
            .status()
            .unwrap();
        assert!(st.success(), "git {args:?}");
    }

    #[test]
    fn clone_is_identical_and_a_dropped_ref_is_not() {
        if Command::new("git").arg("--version").output().is_err() {
            eprintln!("git not installed; skipping");
            return;
        }
        let base = std::env::temp_dir().join(format!("r402s-git-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let a = base.join("a");
        let b = base.join("b");
        std::fs::create_dir_all(&a).unwrap();
        sh(&a, &["init", "-q", "-b", "main"]);
        std::fs::write(a.join("f"), "hello").unwrap();
        sh(&a, &["add", "f"]);
        sh(&a, &["commit", "-q", "-m", "one"]);
        sh(&a, &["tag", "v1"]);
        std::fs::write(a.join("f"), "world").unwrap();
        sh(&a, &["commit", "-q", "-am", "two"]);
        sh(
            &base,
            &[
                "clone",
                "-q",
                "--mirror",
                a.to_str().unwrap(),
                b.to_str().unwrap(),
            ],
        );
        let opts = DiffOptions {
            ref_state: None,
            k_digest_objectset: Some([1u8; 32]),
            expect_object_set_hmac: None,
        };
        let r = differential(&a, &b, &opts).unwrap();
        assert!(r.ok(), "{:?}", r.failures);
        assert!(r.objectset_hmac.is_some());
        assert_eq!(r.repo_objects, r.materialization_objects);
        sh(&b, &["tag", "-d", "v1"]);
        let r = differential(&a, &b, &opts).unwrap();
        assert!(r
            .failures
            .iter()
            .any(|f| f.contains("canonical refs differ")));
        let _ = std::fs::remove_dir_all(&base);
    }
}
