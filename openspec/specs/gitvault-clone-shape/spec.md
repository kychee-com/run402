# gitvault-clone-shape Specification

## Purpose
Define the local ref shape a gitvault client installs when it materializes delivered history, so every object a fetch/clone brings down is referenced and `git fsck` reports no dangling commits.
## Requirements
### Requirement: Delivered history is referenced

Every object a fetch/clone materializes SHALL be reachable from a local
ref when materialization completes: branch refs for branch history, and
`refs/r402/retain/<capture-id>` for retained deploy-capture tips not
reachable from any branch. `git fsck` on a fresh clone reports no dangling
objects from vault delivery.

#### Scenario: Fresh clone is fsck-silent

- **WHEN** a client at or above this change clones a vault whose retained
  history includes branch-unreachable capture tips
- **THEN** `git fsck` reports no dangling commits, and
  `git for-each-ref refs/r402/` lists one ref per such retained capture

#### Scenario: Ref bookkeeping failure never fails the clone

- **WHEN** writing or deleting a `refs/r402/retain/*` ref fails
- **THEN** the fetch/clone completes as it would have before this change,
  with one stderr note naming the bookkeeping failure

### Requirement: The namespace reconciles to the retained set

Each fetch SHALL reconcile `refs/r402/retain/*` to the vault's current
retained set: new retained tips gain refs, pruned captures lose them, and
refs outside `refs/r402/` are never touched.

#### Scenario: Pruned capture retracts on next fetch

- **WHEN** the vault prunes a capture whose ref exists locally and the
  client fetches
- **THEN** that ref is deleted, other `refs/r402/retain/*` refs are
  preserved, and no ref outside `refs/r402/` changes

### Requirement: The namespace is client-local

A push SHALL NOT create, update, or delete any ref under `refs/r402/` on
the remote; the helper refuses such an update with the typed error
`R402_PROTECTED_REF_NAMESPACE` and a next_action stating the namespace is
maintained by fetch.

#### Scenario: Pushing the namespace is refused

- **WHEN** a push names any ref under `refs/r402/`
- **THEN** the helper emits `R402_PROTECTED_REF_NAMESPACE` for that ref
  and publishes nothing for it, while unrelated branch updates in the same
  push proceed normally
