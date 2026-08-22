//! Replays the task-1.2 vector set when it is reachable
//! (`R402S_VECTORS=/path/to/vectors.json`, or the private checkout beside this
//! repo). The vectors are NOT in this repository; without them the test
//! reports that it skipped and passes — the replay itself is the 5.9 gate and
//! runs wherever the private docs are checked out.

use r402s_verify::vectors;

#[test]
fn replay_vector_set() {
    let Some(path) = vectors::locate_vectors() else {
        eprintln!("SKIP: vectors.json not found (set R402S_VECTORS or check out run402-private beside this repo)");
        return;
    };
    let r = vectors::run(&path).expect("vector set loads");
    for f in &r.failures {
        eprintln!("DISAGREEMENT {f}");
    }
    assert!(r.ok(), "{} disagreements", r.failures.len());
    // the classes this lineage must reproduce byte-for-byte
    for cls in [
        "golden-preimage",
        "hpke-rfc9180-a2",
        "hpke-envelope",
        "hpke-info-near-neighbors",
        "hpke-recovery",
        "hpke-genesis-binding",
        "hpke-interop/golden.json",
        "zip215",
        "chain",
        "transition-fail-closed",
        "aead-frame",
        "hkdf",
        "strict-parse",
        "stored-bytes-preimage",
    ] {
        let t = r
            .classes
            .get(cls)
            .unwrap_or_else(|| panic!("class {cls} absent"));
        assert!(t.status.starts_with("replayed"), "{cls}: {}", t.status);
        assert!(t.checks > 0, "{cls}: no checks ran");
        assert_eq!(t.failures, 0, "{cls}");
    }
    assert_eq!(r.interop_cases, 2, "golden.json carries two recipients");
    assert_eq!(r.classes["golden-preimage"].vectors, 3);
    assert_eq!(r.classes["hpke-rfc9180-a2"].vectors, 3);
}
