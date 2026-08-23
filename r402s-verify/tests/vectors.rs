//! Replays the task-1.2 vector set. The frozen set is VENDORED at
//! `test-vectors/r402s-v0/` and integrity-pinned by its `CONTINUITY.json`, so
//! the replay is a real gate here — not an opportunistic extra that runs only
//! on a machine with the private docs checked out.
//!
//! Resolution order (`vectors::locate_vectors`): `R402S_VECTORS=/path/to/
//! vectors.json`, else the vendored copy, else a `run402-private` checkout
//! beside this repo. An unreachable set is a FAILURE, never a skip.

use r402s_verify::vectors;

#[test]
fn replay_vector_set() {
    // NOT a skip: the frozen set is vendored at `test-vectors/r402s-v0/`, so
    // an unreachable path is a broken checkout, not an absent optional input. A
    // silently-skipped replay would let this lineage drift from the vectors it
    // exists to disagree with.
    let path = vectors::locate_vectors().expect(
        "vectors.json not found — expected the vendored test-vectors/r402s-v0/vectors.json (override with R402S_VECTORS)",
    );
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
