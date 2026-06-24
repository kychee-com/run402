## ADDED Requirements

### Requirement: Cold-Start Chain Is Traversable Using Only Returned Actions

An agent that knows only the canonical act-verb `run402 deploy apply` SHALL be able to reach a deployed result from a cold machine (no allowance, no tier, no project) by repeatedly reading the returned `next_actions[]` and running the named action. No step SHALL require knowledge the platform did not hand back, and no new top-level verb (such as `up`) SHALL be introduced.

Each unmet precondition on this path SHALL surface as a `next_actions[]` entry whose `type` names the remedy and whose `command` carries the literal CLI invocation: absent allowance → `initialize_wallet` (`run402 init`); no resolvable tier → `renew_tier` (`run402 tier set <tier>`); no project → `create_project` (`run402 projects provision`).

#### Scenario: Cold agent reaches a deployed result by following actions
- **WHEN** an agent on a machine with no allowance, tier, or project runs `run402 deploy apply --manifest app.json` and at each failure runs the command in the returned `next_actions[0].command`
- **THEN** the sequence init → tier set → provision → deploy apply SHALL complete to a release
- **AND** the agent SHALL NOT have needed any command name that was not present in a returned `next_actions[].command`

#### Scenario: No new top-level verb is introduced
- **WHEN** the CLI command surface is enumerated after this change
- **THEN** there SHALL be no `run402 up` (or equivalent new bootstrap mega-verb)
- **AND** the canonical act-verb SHALL remain `run402 deploy apply`

### Requirement: Paid Bootstrap Verbs Are Retry-Safe

`projects.provision` and `tier.set` SHALL accept an optional caller-supplied idempotency key and send it as the platform's `Idempotency-Key` header so a re-run (the agent's natural mode after a crash or fresh session) cannot duplicate-create a project or double-charge a tier renewal.

The SDK SHALL expose `idempotencyKey` on both methods and send it as the `Idempotency-Key` header when present. The key is **caller-supplied**: the SDK SHALL NOT auto-derive one, because a key represents a single payment/creation intent — a boundary only the caller knows (a deliberate second renewal needs a fresh key, which an SDK-side derivation cannot distinguish from a retry). The CLI SHALL expose `--idempotency-key` on both verbs, and for `provision` SHALL auto-derive `provision:<name>` from `--name` when no key is supplied (an explicit key wins; an unnamed provision stays un-keyed).

#### Scenario: Provision sends a caller-supplied key
- **WHEN** `projects.provision({ idempotencyKey: "k1" })` is called
- **THEN** the request SHALL include the header `Idempotency-Key: k1`
- **AND** a second call with the same key and identical payload SHALL send the same header so the gateway can collapse the retry

#### Scenario: Tier set forwards a caller-supplied key only
- **WHEN** `tier.set("prototype", { idempotencyKey: "k1" })` is invoked
- **THEN** the request SHALL include the header `Idempotency-Key: k1`
- **AND** **WHEN** `tier.set("prototype")` is invoked with no key, the SDK SHALL NOT synthesize or auto-derive an `Idempotency-Key` header

#### Scenario: CLI provision auto-derives from name
- **WHEN** a user runs `run402 projects provision --name my-app` with no `--idempotency-key`
- **THEN** the CLI SHALL pass `idempotencyKey: "provision:my-app"` to the SDK
- **AND** **WHEN** `--idempotency-key k2` is also passed, the explicit key SHALL win

### Requirement: SDK Synthesizes Missing Relay Actions

When a gateway response is a non-2xx with a known machine-readable code but an empty `next_actions[]`, the SDK SHALL synthesize the canonical action for that code rather than relaying an empty array, mirroring the existing `WRITE_AUTH` synthesis.

#### Scenario: Empty AUTH_REQUIRED relay is healed
- **WHEN** the gateway returns `401`/`402` with `code: "AUTH_REQUIRED"` and `next_actions: []`
- **THEN** the `Run402Error` surfaced by the SDK SHALL expose a non-empty `nextActions` containing an `authenticate` action
- **AND** the CLI error reporter SHALL emit that action in the stderr envelope's `next_actions[]`

#### Scenario: Populated relay is passed through unchanged
- **WHEN** the gateway returns a non-2xx that already carries a non-empty `next_actions[]`
- **THEN** the SDK SHALL preserve the gateway-authored actions without overwriting them
