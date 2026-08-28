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
- [x] 4.3 Live acceptance: run against the production run402-private vault
      (prj_1787728095934_0044, 2026-08-28) — clone installed 2 retained refs
      (one displaced tip, one live refs/run402 protocol tip), `git fsck`
      reported 0 dangling, deleting the refs and running `repos fsck`
      restored both. The first run caught a real gap: live protocol-ref tips
      dangled because the reachability basis wrongly included refs git never
      writes locally — fixed, with a unit test.
