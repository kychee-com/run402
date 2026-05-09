## 1. Contract Surface

- [x] 1.1 Confirm whether the gateway emits `OPTIMISTIC_LOCK_CONFLICT` for deploy apply races; keep v1 allowlist to `BASE_RELEASE_CONFLICT` unless confirmed.
- [x] 1.2 Add `maxRetries?: number` to `ApplyOptions` with docs that define it as retries after the initial attempt and `0` as opt-out.
- [x] 1.3 Add the `deploy.retry` `DeployEvent` variant with attempt, nextAttempt, maxAttempts, delayMs, code, phase, resource, operationId, planId, and message fields.
- [x] 1.4 Add optional retry metadata fields to `Run402DeployError` and its structured JSON output: `attempts`, `maxRetries`, and `lastRetryCode`.
- [x] 1.5 Update CLI/MCP error translators to preserve exhausted-retry metadata as `attempts`, `max_retries`, and `last_retry_code` where applicable.

## 2. SDK Retry Implementation

- [x] 2.1 Extract the current `Deploy.apply()` body into an internal `applyOnce()` helper without changing normal event ordering or successful result shape.
- [x] 2.2 Validate `maxRetries` before planning and reject negative, non-finite, or non-integer values with a structured local/deploy validation error.
- [x] 2.3 Implement an auto-rebasable base check that returns true only when `spec.base` is omitted or `{ release: "current" }`.
- [x] 2.4 Implement the deploy-specific retry predicate requiring `Run402DeployError`, `safeToRetry === true`, allowlisted code, and auto-rebasable spec.
- [x] 2.5 Implement bounded exponential backoff with jitter before each retry and emit `deploy.retry` before sleeping.
- [x] 2.6 Ensure retry attempts restart from planning with the original release spec and options rather than replaying stale plan ids or operation ids.
- [x] 2.7 Enrich the final thrown deploy error with retry metadata when the retry budget is exhausted.

## 3. SDK Tests

- [x] 3.1 Add a `deploy.apply` test where the first commit/poll path fails with `BASE_RELEASE_CONFLICT` and `safe_to_retry: true`, the second attempt issues a fresh plan request, and the deploy succeeds.
- [x] 3.2 Add tests proving no automatic retry occurs when `safe_to_retry` is false or absent, when only `retryable: true` is present, or when the code is not allowlisted.
- [x] 3.3 Add tests proving omitted/current base specs are retried while pinned `release_id` and `empty` base specs are not.
- [x] 3.4 Add tests for default retry budget, custom `maxRetries`, `maxRetries: 0`, and invalid `maxRetries` values.
- [x] 3.5 Add tests for `deploy.retry` event payloads and for swallowed `onEvent` callback failures.
- [x] 3.6 Add tests proving exhausted retries throw the last deploy error with retry metadata.
- [x] 3.7 Add tests proving `deploy.start`, low-level `commit`, and `withRetry()` behavior remain unchanged.

## 4. CLI, MCP, and Docs

- [x] 4.1 Verify existing CLI stderr JSON-line progress output preserves `deploy.retry`; add focused tests only if the typed event change requires snapshots or fixtures.
- [x] 4.2 Verify the MCP deploy progress events block preserves `deploy.retry`; add a focused tool test if needed.
- [x] 4.3 Update SDK docs and agent guidance to explain that `deploy.apply` automatically handles safe base-release races and that callers can pass `maxRetries: 0` to opt out.
- [x] 4.4 Scan `documentation.md` and update every listed public/private doc surface whose deploy failure-recovery guidance changes.
- [x] 4.5 Update `SKILL.md`, `openclaw/SKILL.md`, and `llms*.txt` guidance so coding agents rely on `deploy.apply` safe retries instead of hand-rolling `BASE_RELEASE_CONFLICT` loops.

## 5. Validation

- [x] 5.1 Run the focused deploy SDK tests covering retry behavior.
- [x] 5.2 Run `npm run test:sync` to catch surface drift.
- [x] 5.3 Run `npm run test:skill` after guidance updates.
- [x] 5.4 Run the relevant CLI/MCP tests if event or error rendering changed.
- [x] 5.5 Run `openspec status --change add-deploy-apply-safe-retry` and confirm the change is apply-ready.
