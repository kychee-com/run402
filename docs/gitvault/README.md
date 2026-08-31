# gitvault protocol docs (vendored)

The gitvault protocol specification, threat model, and second-HPKE decision
record for the wire protocol `r402s/v0`, published here per the product's
open-components commitment: the encryption client, the Git remote helper, the
object formats, the threat model, the independent verifier, and the test
vectors are open; the hosted coordination control plane is not.

| File | What it is |
|---|---|
| [`protocol-v0.md`](protocol-v0.md) | The full wire-protocol specification, **rev 41** — objects, machines, admission fences, retention, maintenance, the decision log |
| [`threat-model.md`](threat-model.md) | What the platform can and cannot do to your source — the normative claims vocabulary, trust boundary, observer matrix, terminal-loss table |
| [`hpke-second-implementation.md`](hpke-second-implementation.md) | The task-1.0 decision selecting rozbb/rust-hpke as the independent second HPKE for [`r402s-verify`](../../r402s-verify/README.md) |

These are **byte-identical mirrors of a frozen snapshot** — the checkpoint
revision named in each file's own title (protocol rev 41; the threat model's
own header names its revision), NOT a live tail of the private working drafts.
The working drafts live in the private `run402-private` repo
(`docs/strategy/products/gitvault/`), where the freeze program's alignment
gate hash-pins the protocol text, and they advance ahead of this copy between
checkpoints. **Snapshot policy (deliberate, recorded 2026-08-31):** this
vendored set — docs, schemas, AND vectors together, per the re-sync
discipline — is re-cut wholesale only when the private canonical set cuts a
new `CONTINUITY.json` checkpoint, which requires the cross-implementation
vector generator/verifier run (`gen_vectors.py` + `verify_vectors.py`,
against BOTH reference implementations) to have cleared the entire pending
vector backlog for every revision since this snapshot. Vectors are never
hand-authored and the continuity manifest is write-once, so a docs-only
"catch-up" that outran the frozen vectors would break both disciplines —
the drift you may observe against the private revision number is therefore
intentional, bounded, and internally consistent here. Do not hand-edit any
file in this set; the next checkpoint replaces it whole. The same policy
governs the vendored [`test-vectors/r402s-v0/`](../../test-vectors/r402s-v0/README.md)
set, whose schemas these documents are normative for.

Because they are verbatim mirrors of internal working drafts:

- The "Draft for internal review" status line and the task/ledger ids
  (task 1.3, ledger row 0.71, …) refer to the private freeze program's
  tracking; they are not resolvable from this repo.
- The 34 design-review links on the protocol's status line
  (`docs/consultations/source-vault-design-review-round-*.md`) point at
  internal adversarial-review transcripts that are not published; those links
  dangle here.
- Sibling references such as `schemas/`, `validate.py`, `constants.json`, and
  `errors.json` resolve to the frozen public copies under
  [`test-vectors/r402s-v0/schemas/`](../../test-vectors/r402s-v0/schemas/);
  the drafts they name live next to the private working copy.
- The threat model's links to `strategy-synthesis.md` and `docs/vision.md`
  point at internal strategy documents that remain private.

The claims vocabulary in `threat-model.md` §1 is normative for every public
doc surface in this repo; `src/tools/gitvault-copy.test.ts` pins the shipped
copy against it, and pins this vendored mirror against the same constants so
the two cannot drift apart silently.
