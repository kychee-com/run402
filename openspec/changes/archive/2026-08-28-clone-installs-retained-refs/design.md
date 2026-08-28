# Design — clone installs retained-history refs

## D1. Namespace: `refs/r402/retain/<capture-id>`

One flat namespace, one ref per retained deploy-capture tip, named by the
capture's stable protocol identity (the capture id the vault already
records — never a generation ordinal, which compaction can re-anchor). The
`refs/r402/` prefix follows the `refs/pull/*` precedent: obviously
non-branch, obviously tool-owned, sorts together in `for-each-ref`. No
umbrella ref: an umbrella (one ref pointing at an octopus or the newest
tip) would leave older tips dangling again the moment the newest is pruned.

## D2. Written by the materialization layer, once, for both consumers

The ref writes live in the SDK materialization path (the same code
`git-remote-run402` fetch and `repos fsck` both drive), not in the remote
helper — the helper is a thin adapter (AGENTS.md law), and `repos fsck`
must produce the identical shape on an existing checkout so a pre-change
clone can be healed by one `repos fsck` run.

Write rule per fetch/materialization:
- Compute the retained tips from the vault's admitted history (already
  known to the materializer — no new reads).
- Skip any tip already reachable from a ref git is about to write anyway
  (branch tips): no redundant refs.
- Write `refs/r402/retain/<capture-id>` for the rest; delete any existing
  `refs/r402/retain/*` whose capture id is no longer in the retained set.
  Reconciliation is namespace-scoped: refs outside `refs/r402/` are never
  touched.

## D3. Failure posture: warn, never fail the fetch

A ref write/delete failure (permissions, exotic filesystems) degrades to
exactly today's behavior — delivered-but-unreferenced objects — plus one
stderr `note(...)` naming the failure. A clone must never fail because
bookkeeping refs could not be written. The helper's existing "never
`process.exit()` mid-stream" rule applies.

## D4. Push refusal

`refs/r402/*` is client-local. The helper's push path refuses any update
touching the namespace with a typed error (`R402_PROTECTED_REF_NAMESPACE`,
next_action: push branches; the retained namespace is maintained by fetch).
Without this, `git push origin 'refs/r402/*'` would try to publish
bookkeeping as history.

## D5. Retention interaction (the deliberate local-pin)

While a ref exists, local `git gc` cannot collect that history — your
clone keeps your history, deliberately. After the vault prunes a capture,
the NEXT fetch retracts its ref and local gc may collect. A user who wants
to keep pruned history locally can copy the ref out of the namespace
before fetching; the docs say so in one sentence. Reconciliation-on-fetch
is what keeps the local pin honest rather than unbounded.

## D6. fsck outcome and the doc note

With refs installed, `git fsck` on a fresh clone is silent. The existing
"dangling commits are expected" doc note becomes version-scoped: clones
made by clients older than this change (or checkouts that failed D3's
write) may still show dangling retained history — harmless, and one
`repos fsck` run installs the refs. The copy gate corpus is updated with
the revised sentence; the old sentence is removed from teaching sites.

## Agent DX benchmark

- Happy path: clone → `git fsck` silent → `git for-each-ref refs/r402/`
  lists retained captures with self-explanatory names → agent proceeds.
- Mistake 1: agent deletes `refs/r402/retain/*` (tidying). Harmless;
  restored by the next fetch or `repos fsck`. Nothing in the vault moved.
- Mistake 2: agent pushes the namespace. Typed `R402_PROTECTED_REF_
  NAMESPACE` refusal names the rule and the fix; nothing published.
- Mistake 3: agent expects a pruned capture to stay ref'd. The fetch
  retraction plus D5's one-sentence doc answers it; `repos view` warnings
  already carry retention state.
