# Clone installs retained-history refs

## Why

A fresh `git clone run402::…` delivers the vault's full admitted history —
including retained deploy-capture commits that no branch references. Plain
`git fsck` then reports dangling commits. Exit status is clean, but the
security-curious user (exactly gitvault's audience) reads "dangling commit"
minutes after cloning an encrypted vault and suspects corruption. Dogfood
feedback hit this verbatim: "seeing dangling commits immediately after
cloning looks suspicious."

The documentation stopgap ("expected and harmless") treats the symptom. The
cure is git-ecosystem precedent: reference what you deliver. GitHub serves
`refs/pull/*`; gitvault clients will keep the retained deploy-capture
history under a local `refs/r402/*` namespace, so every delivered object is
referenced, `git fsck` is silent, and the refs are honest — the history
really is there and really is retained.

Decision: Tal, 2026-08-28 — option 1 ("install protocol refs at clone"),
routed through openspec.

## What changes

- During fetch/clone materialization, the client (SDK materialization layer,
  driven by `git-remote-run402` and `repos fsck`) writes local refs under
  `refs/r402/retain/<capture-id>` for every retained deploy-capture tip that
  no fetched branch ref already reaches.
- Every later fetch reconciles the namespace to the vault's current retained
  set: new tips gain refs, tips the vault has since pruned lose them.
- The namespace is client-local bookkeeping: never advertised for push, and
  a push touching `refs/r402/*` is refused with a typed error.
- Docs: the "dangling commits are expected" note becomes version-scoped
  (true for clones made by older clients); the clone teaching sites explain
  the `refs/r402/retain/*` shape instead.

## What does not change

- The wire protocol (`r402s/v0`). No new object kinds, no head changes —
  this is entirely client-side ref bookkeeping over already-delivered
  objects.
- The vault's retention semantics. Refs mirror the retained set; they do
  not extend or shorten retention.
- Old clones. They keep their dangling-but-harmless shape; nothing rewrites
  an existing checkout without a fetch.

## Impact

- `cli/git-remote-run402.mjs` (fetch path), the SDK materialization layer,
  `repos fsck` (which also materializes), docs surfaces teaching clone, and
  the copy gate corpus for the revised dangling note.
