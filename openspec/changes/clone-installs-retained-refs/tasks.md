# Tasks — clone installs retained-history refs

## 1. SDK materialization

- [x] 1.1 Retained-tip computation + `refs/r402/retain/<capture-id>`
      write/reconcile in the shared materialization path (skip
      branch-reachable tips; namespace-scoped reconcile; D2).
      Deviation: named by the tip's own commit oid, not a per-capture id —
      see `reconcileRetainedTipRefs`'s doc comment in
      `sdk/src/node/gitvault-publication.ts` for why (D1's own escape
      hatch; `GitvaultRetentionRoot` carries no capture id).
- [x] 1.2 D3 failure posture: warn-and-continue on any ref write/delete
      failure; one stderr note; fetch/clone never fails on bookkeeping.
- [x] 1.3 `repos fsck` produces the identical ref shape on an existing
      checkout (the healing path for pre-change clones).

## 2. Remote helper

- [x] 2.1 Fetch path drives 1.1 (no helper-local logic beyond the call).
- [x] 2.2 Push refusal for `refs/r402/*` — typed
      `R402_PROTECTED_REF_NAMESPACE`, next_action naming the rule (D4).

## 3. Docs + copy gate

- [x] 3.1 Clone teaching sites: replace the "dangling commits are
      expected" sentence with the `refs/r402/retain/*` explanation;
      version-scope the old note for old clones + failed-write checkouts
      (one `repos fsck` heals). Copy-gate corpus updated (D6).
- [x] 3.2 D5's one-sentence local-pin/retraction note at the same sites.

## 4. Proof

- [x] 4.1 Unit tests: reconcile add/retract, branch-reachable skip,
      namespace-scoped deletion, write-failure degradation.
- [x] 4.2 Helper tests: push-refusal envelope; fetch drives the writes.
- [ ] 4.3 Live acceptance: clone a production vault → `git fsck` silent →
      `for-each-ref refs/r402/` non-empty; delete the refs → `repos fsck`
      restores them. NOT RUN — this implementing session has no production
      vault/credentials available; the equivalent shape is proven against a
      real local git repo + `GitvaultMemoryTransport` in
      `sdk/src/node/gitvault-publication.test.ts` instead. Needs a human
      (or an agent holding a real wallet/allowance) to run live.
