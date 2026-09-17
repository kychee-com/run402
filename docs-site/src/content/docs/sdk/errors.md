---
title: "Errors"
description: "Native SDK reference — errors."
order: 60
---

## Errors

All failures throw subclasses of `Run402Error`. Every subclass carries a stable
`kind` string discriminator and an `isRun402Error` brand. Branch with the
exported type guards (or by comparing `e.kind`) — NOT with `instanceof X`:
identity-based checks fail silently when the consumer's runtime holds a
different copy of the SDK (duplicate npm installs, bundler chunk splits,
ESM/CJS interop, V8-isolate realms). `instanceof` continues to work for
single-copy single-realm callers as a back-compat path.

| Class | `kind` | When | Notable fields |
|---|---|---|---|
| `PaymentRequired` | `"payment_required"` | HTTP 402 | x402 payment requirements in `body` |
| `ProjectNotFound` | `"project_not_found"` | Project ID not in the credential provider | `projectId` |
| `Unauthorized` | `"unauthorized"` | HTTP 401 / 403 — authentication missing or invalid | — |
| `NotAuthorizedError` | `"not_authorized"` | HTTP 403 with `code: "NOT_AUTHORIZED"` — org-owned control-plane denial: authenticated, but the principal lacks the required org membership/role or per-project grant | `requiredRole`, `requiredCapability`, `reason`, `action` |
| `ApiError` | `"api_error"` | Other non-2xx responses | `status`, `body` |
| `NetworkError` | `"network_error"` | Fetch rejected with no HTTP response | `cause` |
| `PaymentAttemptError` | `"payment_attempt_error"` | Automatic x402 setup/signing/submission failed | `code`, `phase`, `paymentAttemptId`, `providerStarted`, `safeToRetry`, `mutationState`, `nextActions` |
| `PaymentBuyerError` | `"payment_buyer_error"` | Bounded arbitrary-URL x402 buying failed | `code`, `fundsMoved`, `details`, `safeToRetry`, `nextActions` |
| `LocalError` | `"local_error"` | Local-host issues (filesystem, signing) | `cause` |
| `X402BalanceError` (Node entry) | `"local_error"` | x402 USDC balance preflight could not be confirmed, or confirmed funds are insufficient | `code`, `safeToRetry`, `mutationState="not_started"`, `details`, `nextActions` |
| `Run402DeployError` | `"deploy_error"` | Structured envelope from the deploy state machine | `code`, `phase`, `operationId`, `safeToRetry`, `mutationState`, `nextActions` |
| `TransferFreezeError` | `"transfer_freeze"` | HTTP 409 with `code: "PROJECT_HAS_PENDING_TRANSFER"` from the transfer-freeze middleware blocking owner-side mutations during a pending transfer | `transferId`, `projectId`, `cancelPath`, `previewPath` |

The exported `Run402ErrorKind` union type (`"payment_required" | "payment_buyer_error" | "project_not_found" | "unauthorized" | "not_authorized" | "api_error" | "network_error" | "payment_attempt_error" | "local_error" | "deploy_error" | "transfer_freeze" | "step_up_required" | "operator_approval_required"`) supports exhaustive `switch` statements with TypeScript exhaustiveness checking.

```ts
import {
  run402,
  withRetry,
  isPaymentRequired,
  isDeployError,
  type ReleaseSpec,
} from "@run402/sdk/node";

declare const spec: ReleaseSpec;
const r = run402();

try {
  const release = await withRetry(
    async () => (await r.project(spec.project)).apply(spec, { idempotencyKey: "deploy-2026-05-01" }),
    {
      attempts: 3,
      onRetry: (_e, attempt, delayMs) =>
        process.stderr.write(`retry ${attempt} in ${delayMs}ms\n`),
    },
  );
  console.log(release.urls);
} catch (e) {
  if (isPaymentRequired(e)) {
    // narrowed to PaymentRequired — read e.body for the x402 quote
  } else if (isDeployError(e)) {
    // narrowed to Run402DeployError — log the structured envelope for triage
    process.stderr.write(JSON.stringify(e) + "\n");
  } else throw e;
}
```

`Run402DeployError.code` is one of `MIGRATION_FAILED`, `MIGRATION_CHECKSUM_MISMATCH`, `BASE_RELEASE_CONFLICT`, `PAYMENT_REQUIRED`, `SCHEMA_SETTLE_TIMEOUT`, `ACTIVATION_FAILED`, `STORAGE_UNAVAILABLE`, `SITE_STAGE_FAILED`, `FUNCTION_BUILD_FAILED`, `CONTENT_UPLOAD_FAILED`, `INVALID_SPEC`, `MANIFEST_EMPTY`, `OPERATION_NOT_FOUND`, `MIGRATE_GATE_ACTIVE`, `INTERNAL_ERROR`, `NETWORK_ERROR`, `PROJECT_NOT_FOUND` (or any other string the gateway emits — consumers SHALL treat unknown codes as opaque). Pair it with the structured `nextActions` advisory array carried in the error body.

### Type guards and the canonical retry policy

The SDK exports identity-free guards plus a single canonical "should I retry this?" function:

- `isRun402Error(e)` — true for any `Run402Error` subclass instance, regardless of which SDK copy created it.
- `isPaymentRequired(e)`, `isPaymentAttemptError(e)`, `isProjectNotFound(e)`, `isUnauthorized(e)`, `isNotAuthorized(e)`, `isApiError(e)`, `isNetworkError(e)`, `isLocalError(e)`, `isDeployError(e)`, `isTransferFreezeError(e)` — narrow `unknown` to the named subclass. `isPaymentAttemptError` is the automatic x402 failure guard; branch on `safeToRetry` before doing anything. `isUnauthorized` (authentication missing/invalid) and `isNotAuthorized` (org control-plane denial — authenticated but under-privileged) are distinct: the first calls for re-auth, the second for obtaining an org membership/role or grant.
- `isRetryableRun402Error(e)` — encapsulates the retry policy: `e.retryable || kind === "network_error" || status in {408, 425, 429} || status >= 500`, unless the gateway explicitly sets `retryable: false`. `safeToRetry` alone is not a retry signal; it means a repeated mutation should not duplicate/corrupt state, not that lifecycle/payment/auth gates will become allowed without an action. Returns `false` for non-Run402 inputs so it's safe to call from any `catch` block.
- `getQuotaScope(e)` — returns `"organization"` for pooled organization quota denials, `"project"` for the orphan-project fallback when a organization row has been purged but cascade has not yet run, and `undefined` for non-quota errors or pre-v1.46 gateways. Safe to call with any `unknown`; reads `Run402Error.quotaScope`, which is lifted from `details.scope` on the gateway envelope.
- `isCiBindingRevoked(e)` — true for the CI token-exchange `binding_revoked` denial (HTTP 403): a subject-matching binding existed but was revoked (most often the project was transferred/handed off). Distinct from `access_denied` (no binding ever matched), which shares the same canonical `code: "FORBIDDEN"` — the guard reads the OAuth-style `error` field for you. The error stays an `Unauthorized` (no regression). Fix: re-run `run402 ci link github`; do NOT `set-asset-scopes` (409 on a revoked binding). Safe to call with any `unknown`.

`Run402Error.toJSON()` returns a canonical envelope (`name`, `kind`, `message`, `status`, `code`, `category`, `retryable`, `safeToRetry`, `mutationState`, `traceId`, `context`, `details`, `nextActions`, `quotaScope`, `body`). `Run402DeployError.toJSON()` extends it with `phase`, `resource`, `operationId`, `planId`, `fix`, `logs`, `rolledBack`, and, when automatic deploy retries are exhausted, `attempts`, `maxRetries`, `lastRetryCode`. `JSON.stringify(error)` produces a populated structured object — never the empty `"{}"` plain `Error` produces.

**`correlated_platform_incident` — the error might not be yours.** While a platform incident is OPEN and its subsystem correlates with the error's `code`, the gateway envelope (available raw on `error.body`) carries `correlated_platform_incident: { id: "inc_…", subsystem, status: "ongoing" | "resolved" }`, and a `poll` action is appended to `nextActions`. This is a CORRELATION, not an exoneration — the platform states that it was degraded when your call failed and lets you judge (an app can still cause its own throttling). Treat it as a strong signal to poll the events feed (`r.events.list`) before debugging your own code; when the incident resolves, the matching `platform_incident` feed event carries your project's real failed-invocation count. The field is absent on any error with no correlated open incident — never a false confession.

### `withRetry(fn, opts?)`

`withRetry` runs an async function with exponential backoff. Defaults: 3 attempts (1 + 2 retries), 250 ms base delay, 5 s cap. Uses `isRetryableRun402Error` as the default retry decision. Pair with the SDK method's own `idempotencyKey` so retried mutations dedup server-side — the closure carries the same key on every attempt.

Do not wrap lifecycle-gated writes, auth token exchanges, or passkey verification in blind retry loops because an error says `safeToRetry: true`. Use a custom `retryIf` when a caller-specific recovery action makes a retry meaningful.

For `r.project(id).apply()`, do not hand-roll the `BASE_RELEASE_CONFLICT` loop: the deploy namespace already re-plans and retries omitted/current-base specs when the gateway returns `safe_to_retry: true`. Default deploy budget is 2 retries after the initial attempt, `maxRetries: 0` opts out, each retry emits `deploy.retry`, and exhausted retries surface `attempts` / `maxRetries` / `lastRetryCode` on `Run402DeployError`.

`RetryOptions`: `attempts?: number`, `baseDelayMs?: number`, `maxDelayMs?: number`, `retryIf?: (error, attempt) => boolean`, `onRetry?: (error, attempt, delayMs) => void`.

After exhausting attempts, `withRetry` throws the LAST observed error — your catch handler sees the original structured envelope, not a wrapper. A buggy `onRetry` that throws is swallowed; the retry chain is unaffected.
