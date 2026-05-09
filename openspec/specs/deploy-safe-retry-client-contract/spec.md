# deploy-safe-retry-client-contract Specification

## Purpose
TBD - created by archiving change add-deploy-apply-safe-retry. Update Purpose after archive.
## Requirements
### Requirement: Deploy Apply Safe Race Retry
`r.deploy.apply(spec)` SHALL automatically retry deploy races only when the gateway error is a deploy error with `safe_to_retry: true`, the error code is in the SDK's deploy safe-retry allowlist, and the release spec is auto-rebasable.

#### Scenario: Base release conflict replans and succeeds
- **WHEN** `r.deploy.apply(spec)` is called with `spec.base` omitted or `{ release: "current" }`, the first attempt fails with `Run402DeployError` code `BASE_RELEASE_CONFLICT` and `safe_to_retry: true`, and a later attempt succeeds
- **THEN** the SDK SHALL start a fresh deploy attempt from planning with the original release spec and SHALL return the successful deploy result

#### Scenario: Retry restarts from planning
- **WHEN** a safe `BASE_RELEASE_CONFLICT` is observed after the first attempt has created a plan or operation
- **THEN** the SDK SHALL NOT replay the stale plan commit or resume the stale operation, and SHALL issue a new plan request for the next attempt

#### Scenario: Retry requires safe to retry
- **WHEN** `r.deploy.apply(spec)` observes `BASE_RELEASE_CONFLICT` with `safe_to_retry: false` or without `safe_to_retry: true`
- **THEN** the SDK SHALL throw the deploy error without an automatic retry

#### Scenario: Retry requires allowlisted code
- **WHEN** `r.deploy.apply(spec)` observes a deploy error with `safe_to_retry: true` but a code outside the deploy safe-retry allowlist
- **THEN** the SDK SHALL throw the deploy error without an automatic retry

#### Scenario: Retry ignores generic retryable signal
- **WHEN** `r.deploy.apply(spec)` observes a deploy error with `retryable: true` but without `safe_to_retry: true`
- **THEN** the SDK SHALL throw the deploy error without an automatic retry

### Requirement: Auto-Rebasable Base Policy
Automatic deploy retries SHALL only re-plan specs whose base means "current live release" and SHALL preserve explicit base semantics for pinned and empty deploys.

#### Scenario: Omitted base is auto-rebasable
- **WHEN** `r.deploy.apply(spec)` is called without `spec.base` and an otherwise retryable `BASE_RELEASE_CONFLICT` occurs
- **THEN** the SDK SHALL treat the spec as eligible for automatic retry

#### Scenario: Current base is auto-rebasable
- **WHEN** `r.deploy.apply(spec)` is called with `spec.base` equal to `{ release: "current" }` and an otherwise retryable `BASE_RELEASE_CONFLICT` occurs
- **THEN** the SDK SHALL treat the spec as eligible for automatic retry

#### Scenario: Pinned release base is not auto-rebasable
- **WHEN** `r.deploy.apply(spec)` is called with `spec.base` equal to `{ release_id: "rel_..." }` and a deploy error has `safe_to_retry: true`
- **THEN** the SDK SHALL throw the deploy error without automatically re-planning against a different base

#### Scenario: Empty base is not auto-rebasable
- **WHEN** `r.deploy.apply(spec)` is called with `spec.base` equal to `{ release: "empty" }` and a deploy error has `safe_to_retry: true`
- **THEN** the SDK SHALL throw the deploy error without automatically re-planning against the current release

### Requirement: Apply Retry Budget
`ApplyOptions` SHALL expose a retry budget that controls automatic deploy safe-race retries and includes an explicit opt-out.

#### Scenario: Default retry budget
- **WHEN** `r.deploy.apply(spec)` is called without a retry budget override
- **THEN** the SDK SHALL allow up to two automatic retries after the initial attempt, for three total apply attempts

#### Scenario: Retry disabled
- **WHEN** `r.deploy.apply(spec, { maxRetries: 0 })` observes an otherwise retryable deploy race
- **THEN** the SDK SHALL throw the first deploy error without issuing another plan request

#### Scenario: Custom retry budget
- **WHEN** `r.deploy.apply(spec, { maxRetries: N })` is called with a positive integer `N`
- **THEN** the SDK SHALL allow at most `N` automatic retries after the initial attempt

#### Scenario: Invalid retry budget
- **WHEN** `r.deploy.apply(spec, { maxRetries })` is called with a negative, non-finite, or non-integer retry budget
- **THEN** the SDK SHALL reject the call locally before planning, with a structured error that identifies `maxRetries` as invalid

### Requirement: Retry Events
The deploy SDK SHALL emit a structured retry event before each automatic retry, and existing CLI/MCP deploy progress streams SHALL preserve that event.

#### Scenario: SDK retry event
- **WHEN** `r.deploy.apply(spec, { onEvent })` schedules an automatic retry
- **THEN** the SDK SHALL call `onEvent` with a `DeployEvent` containing `type: "deploy.retry"`, the failed attempt number, the next attempt number, the maximum attempts, the delay in milliseconds, and the original deploy error's code, phase, resource, operation id, plan id, and message

#### Scenario: Retry event callback errors are swallowed
- **WHEN** the caller's `onEvent` callback throws while handling a `deploy.retry` event
- **THEN** the SDK SHALL swallow the callback error and continue the retry path

#### Scenario: CLI retry event visibility
- **WHEN** `run402 deploy apply` uses the SDK default retry policy and the SDK emits `deploy.retry`
- **THEN** the CLI SHALL preserve the retry event in its existing stderr JSON-line event stream unless quiet mode suppresses progress events

#### Scenario: MCP retry event visibility
- **WHEN** the MCP `deploy` tool uses the SDK default retry policy and the SDK emits `deploy.retry`
- **THEN** the MCP response SHALL preserve the retry event in its existing progress events block

### Requirement: Exhausted Retry Metadata
When automatic retries are exhausted, the SDK SHALL throw a structured deploy error that preserves the last observed deploy failure and records retry-attempt metadata for operators and agents.

#### Scenario: Exhausted retries preserve last deploy error
- **WHEN** every allowed `r.deploy.apply(spec)` attempt fails with an automatically retryable deploy error
- **THEN** the SDK SHALL throw a `Run402DeployError` whose code, phase, resource, operation id, plan id, logs, fix, retryable flag, safe-to-retry flag, and gateway body are preserved from the last observed deploy error unless explicitly enriched with retry metadata

#### Scenario: Exhausted retries expose attempt count
- **WHEN** `r.deploy.apply(spec)` exhausts its automatic retry budget
- **THEN** the thrown structured error JSON SHALL expose the total number of apply attempts made and the configured maximum retry count

### Requirement: Retry Scope Boundaries
Automatic safe-race retries SHALL be scoped to the one-shot deploy apply surface and SHALL NOT change low-level deploy primitives or the generic SDK retry helper.

#### Scenario: Start is not auto-retried
- **WHEN** `r.deploy.start(spec)` observes a deploy error that would be eligible under the `deploy.apply` safe-race retry policy
- **THEN** `r.deploy.start(spec)` SHALL preserve its existing behavior and throw or reject without the new automatic apply retry loop

#### Scenario: Low-level commit is not auto-retried
- **WHEN** `r.deploy.commit(planId)` observes `BASE_RELEASE_CONFLICT` with `safe_to_retry: true`
- **THEN** the SDK SHALL preserve low-level behavior and throw the deploy error without automatically creating a fresh plan

#### Scenario: Generic retry helper unchanged
- **WHEN** callers use `withRetry()` directly
- **THEN** its default retry predicate and option semantics SHALL remain unchanged by the deploy apply safe-retry feature
