## Context

The unified deploy SDK already owns the full one-shot pipeline for `r.deploy.apply(spec)`: validate and normalize the release spec, create a plan, upload missing CAS content, commit the plan, and poll the operation to a terminal state. When the gateway reports a deploy-state-machine error, the SDK throws `Run402DeployError` with structured fields such as `code`, `phase`, `resource`, `retryable`, `safeToRetry`, `operationId`, and `planId`.

Issue #225 highlights the gap: a deploy can lose a race to another activation after planning, fail with `BASE_RELEASE_CONFLICT`, and carry `safe_to_retry: true`. A human or agent can immediately invoke the same deploy again and succeed, but every caller has to understand that this specific error needs a fresh plan rather than an HTTP replay.

There is already a generic `withRetry()` helper, but its default policy is deliberately broad and caller-controlled. Automatic mutation retries inside `deploy.apply()` need a narrower, deploy-aware policy so great agent DX does not become surprising automation.

## Goals / Non-Goals

**Goals:**

- Make `r.deploy.apply(spec)` automatically recover from known-safe release races without caller-side retry loops.
- Re-run the complete apply pipeline from planning for `BASE_RELEASE_CONFLICT`, so the retry is based on the current live release.
- Keep retries bounded, visible, and caller-disableable.
- Preserve structured error metadata when the retry budget is exhausted.
- Surface retry events through existing SDK, CLI, and MCP progress channels.

**Non-Goals:**

- Do not add automatic retries to all SDK mutations.
- Do not change `deploy.start`, low-level `plan` / `upload` / `commit`, `resume`, or the generic `withRetry()` helper.
- Do not retry policy-shaped failures such as invalid specs, warning confirmations, payment/auth failures, migration failures, or 5xx errors without a deploy-specific safe retry code.
- Do not silently reinterpret explicitly pinned or empty deploy bases.

## Decisions

### Add a deploy-specific retry loop inside `apply()`

`Deploy.apply()` should delegate its current body to an internal `applyOnce()` and wrap that with a deploy-specific retry loop. The loop catches only `Run402DeployError`, checks the retry predicate, emits a retry event, waits with bounded backoff and jitter, then calls `applyOnce()` again with the original `ReleaseSpec` and `ApplyOptions`.

This placement is intentional:

```
apply(spec)
  │
  ├─ attempt 1: plan → upload → commit → poll
  │                              │
  │                              └─ BASE_RELEASE_CONFLICT
  │
  └─ attempt 2: plan → upload → commit → poll
                                 │
                                 └─ ready
```

Retrying only `commitInternal()` or `pollUntilReady()` would keep using the stale plan/operation that caused the conflict. Retrying at the top of `apply()` rebuilds the plan against the fresh current release while preserving the caller's deploy intent.

Alternative considered: make callers use `withRetry(() => r.deploy.apply(...))`. Rejected for the default path because issue #225 is specifically about platform-owned deploy metadata leaking into every agent/operator script.

### Use an allowlist and require `safeToRetry`

The automatic predicate should require all of:

- thrown value is a `Run402DeployError`;
- `safeToRetry === true`;
- `code` is in a small allowlist;
- the spec is auto-rebasable.

The v1 allowlist should include `BASE_RELEASE_CONFLICT`. `OPTIMISTIC_LOCK_CONFLICT` should remain out of the default allowlist unless implementation confirms the gateway emits that code for the same race-shaped deploy recovery path. Broad fields like `retryable: true`, HTTP status `5xx`, or generic `isRetryableRun402Error()` are insufficient for automatic mutation retries.

Alternative considered: reuse `isRetryableRun402Error()`. Rejected because it also retries network errors, 408/425/429, 5xx, and `retryable: true`; those can be correct for caller-owned retry helpers but are too broad for invisible automatic deploy mutation retries.

### Retry only auto-rebasable specs

Automatic re-planning should apply only when `spec.base` is omitted or `{ release: "current" }`. Those shapes mean "apply this intent over whatever is currently live." The SDK must not auto-retry specs with `{ release_id: "rel_..." }` or `{ release: "empty" }` because those explicitly constrain the base:

- pinned `release_id` means "use exactly this base";
- `empty` means "fresh deploy that should fail if a release already exists."

If those specs fail with a safe race, the structured error should be returned for caller-level handling.

Alternative considered: retry every `BASE_RELEASE_CONFLICT` by replacing the base with current. Rejected because it would violate explicit caller intent and could hide meaningful conflicts.

### Expose `maxRetries` on `ApplyOptions`

Add `maxRetries?: number` to `ApplyOptions`, interpreted as the number of retries after the initial attempt:

- default: `2` retries, `3` total attempts;
- `0`: disable automatic retry;
- negative, non-finite, or non-integer values: reject locally with a structured deploy/local validation error before starting the deploy.

Keep backoff tuning internal for v1: start around 500 ms, exponential, cap to a small value, and add jitter. The public knob agents need is "how much automatic recovery budget is allowed," not a timing matrix.

Alternative considered: expose `attempts`, `baseDelayMs`, and `maxDelayMs`, mirroring `withRetry()`. Rejected for v1 because this is a deploy policy surface, not a general retry primitive.

### Emit retry events through `onEvent`

Add a `DeployEvent` variant such as:

```ts
{
  type: "deploy.retry";
  attempt: number;
  nextAttempt: number;
  maxAttempts: number;
  delayMs: number;
  code: string;
  phase: string | null;
  resource: string | null;
  operationId: string | null;
  planId: string | null;
  message: string;
}
```

The event fires synchronously before sleeping, and throws inside the caller's `onEvent` remain swallowed like other progress callbacks. Existing CLI stderr JSON-lines and MCP progress JSON will surface this event without bespoke rendering.

Alternative considered: logging to stderr inside the SDK. Rejected because the isomorphic SDK should not own process IO, and the current event stream is already the deploy progress contract.

### Preserve exhausted-retry metadata

When the SDK exhausts automatic retries, it should throw a `Run402DeployError` that preserves the last observed deploy error while adding retry metadata. Add optional retry metadata fields to the deploy error shape and structured JSON:

- `attempts`: total apply attempts made;
- `maxRetries`: configured retry budget;
- `lastRetryCode`: last error code considered retryable.

CLI/MCP error translators should surface equivalent machine-readable fields, using their existing envelope conventions (`attempts`, `max_retries`, and `last_retry_code`) while preserving the last gateway body.

Alternative considered: throw the last error unchanged. Rejected because operators need to distinguish "one conflict" from "the SDK retried and still lost contention."

## Risks / Trade-offs

- [Risk: retry hides meaningful caller intent] → Mitigation: retry only omitted/current base specs and keep pinned/empty base failures caller-owned.
- [Risk: retry policy grows too broad] → Mitigation: deploy-specific allowlist, `safeToRetry === true`, and tests proving non-allowlisted safe errors do not retry.
- [Risk: retries make logs confusing] → Mitigation: emit a structured `deploy.retry` event with attempt, delay, and original error fields before every retry.
- [Risk: repeated uploads waste time] → Mitigation: CAS dedup and existing content-present events should make second attempts cheap; tests should confirm the fresh plan path works rather than replaying stale operations.
- [Risk: CI deploys behave differently] → Mitigation: keep the logic inside `deploy.apply()` after CI preflight; CI callers get the same safe-race recovery when their specs are auto-rebasable.

## Migration Plan

1. Add the SDK type surface and deploy-specific retry implementation behind the default `maxRetries: 2` policy.
2. Add tests for success-after-replan, opt-out, predicate strictness, pinned/empty base behavior, retry events, and exhausted metadata.
3. Update CLI/MCP/docs/skills only where they describe deploy failure recovery or expose apply options.
4. Roll back by setting default retries to `0` or reverting the wrapper while leaving the event/type additions harmless until the next major cleanup.

## Open Questions

- Does the gateway currently emit `OPTIMISTIC_LOCK_CONFLICT` for deploy apply races? If not confirmed during implementation, v1 should ship with only `BASE_RELEASE_CONFLICT` in the automatic allowlist.
