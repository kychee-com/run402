# `r402s/v0` conformance vectors (vendored)

The frozen task-1.2 vector set for the gitvault wire protocol `r402s/v0`, at
**protocol rev 41**. Vendored here so the public repo's CI actually replays
them — before this copy existed the SDK suites resolved a hard-coded absolute
path, found nothing on a CI runner, and **silently skipped ~130 vectors while
reporting green**.

## Files

| File | What it is |
|---|---|
| `vectors.json` | The 275 executable vectors, `counts_by_class`, `test_keys`, `x-r402s-revision` |
| `CONTINUITY.json` | The D188 golden-byte continuity manifest — the authority for whether this copy is the frozen set |
| `hpke-interop/golden.json` | The two cross-implementation HPKE golden cases |
| `hpke-interop/INTEROP.md` | How the golden cases were produced |
| `schemas/` | The frozen schema set the vectors validate against — the Rust verifier (`r402s-verify`) reads it, and its `x-r402s-revision` must equal the vectors' |

## The integrity check is not decorative

`CONTINUITY.json`'s `current` block records the exact SHA-256 of `vectors.json`
and `hpke-interop/golden.json` at rev 41. Every SDK suite that loads vectors
asserts those digests before running a single case
(`sdk/src/node/gitvault-vectors.test-helper.ts`). A vendored copy that drifts
from the source of truth therefore fails loudly rather than replaying stale
expectations — which is the whole failure mode this directory exists to close.

**Do not hand-edit these files.** They are generated in the private repo
(`docs/strategy/products/gitvault/vectors/`, by `gen_vectors.py`). To update:
regenerate there, copy `vectors.json`, `CONTINUITY.json`, `hpke-interop/*`,
and the `schemas/*` files already vendored here (from the private repo's
sibling `../schemas/`) across in one commit, and let the digest assertions
confirm the copy.

## Overriding the location

`GITVAULT_VECTORS_DIR` points the suites at another directory (e.g. the private
repo's live set while iterating on the generator). The digest assertions still
run — an override is a *location* override, never an integrity override.

`GITVAULT_VECTORS_OPTOUT=1` is the only way to skip the vector suites, and it
must be set deliberately. An unresolvable directory is a **failure**, never a
skip.
