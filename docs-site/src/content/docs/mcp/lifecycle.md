---
title: "Portable project archives"
description: "Native MCP reference — lifecycle."
order: 20
---

## Portable project archives

Portable archives let an agent export the supported Run402 Core runtime slice of a Cloud project, verify it locally, and import it into a new local Core project. This is the vendor-lock-in trust claim: Cloud is the easiest place to start, not the only place the supported application can run. It is separate from allowance/spend-cap financial-risk controls.

From MCP the happy path is one `run` snippet per step (`r.archives` on the Node SDK), or the CLI's `run402 archives create|download|inspect|verify|import` when the archive should land in a directory the person chooses:

```ts
const exported = await r.archives.export("prj_…", { scope: "portable-runtime-v1", auth: "stubs", consistency: "pause-writes" });
exported.created.archive_id
```

1. Export with `r.archives.export(projectId, { scope, auth, consistency })`; it waits for readiness and downloads.
2. Inspect with `r.archives.inspect(archivePath)`.
3. Verify with `r.archives.verify(archivePath)`.
4. Fill the required secret values from the archive's `secrets/required.env.template` or the `required_secrets` list.
5. Import with `r.archives.importToCore({ archivePath, name, envFile })` (or `secretValues`), with `requireRunnable: true` to insist on a runnable result.

Results carry the same agent fields as the CLI: `code`, `severity`, `resource_type`, `resource_id`, `message`, `next_action`, `retryable`, and safe `context`. Verification is offline and checks integrity and compatibility only; archives remain untrusted input. Import verifies before mutation, creates a new Core project only, and never imports secret values, auth credentials, logs, billing/allowance state, or managed Cloud operations from Cloud export.

## Project credentials

When `up` (or `run402 projects provision`) creates a project, two keys are saved to the local key cache and reused by every later call; the SDK never hands them to a `run` snippet:

- `anon_key` — read-only by default; safe in browser HTML. RLS policies apply.
- `service_key` — server-side admin. Never embed in browser code. CORS is intentionally open for x402 clients, so a leaked service_key is exploitable from any origin. Use only inside functions; the SDK attaches it for you.

Neither key expires. `await r.credentials.projectKeys.status(projectId)` reports what the cache holds without revealing it; `await r.projects.use(projectId)` sets the active project. Exporting a key is `run402 credentials project-keys export --project <project_id> --reveal`, in the CLI only.

## Error envelopes and safe retry

Run402 JSON errors carry a canonical envelope. Branch on `code`, not English `message`.

Important fields:
- `code` — stable machine-readable reason: `PROJECT_FROZEN`, `PAYMENT_REQUIRED`, `MIGRATION_FAILED`, `MIGRATE_GATE_ACTIVE`, `RATE_LIMITED`, `INSUFFICIENT_FUNDS`, `CI_ROUTE_SCOPE_DENIED`
- `retryable` — the same request may succeed later
- `safe_to_retry` — repeating the same request will not duplicate or corrupt a mutation
- `mutation_state` — `none` / `not_started` / `committed` / `rolled_back` / `partial` / `unknown`
- `trace_id` — include this when reporting an issue
- `request_id` — routed/function failure handle. `await r.functions.logsByRequestId(projectId, requestId)` in a `run` snippet reads the matching log lines across the project's functions; it is distinct from gateway `trace_id`.
- `details` — structured route-specific context
- `next_actions` — `authenticate`, `submit_payment`, `renew_tier`, `check_usage`, `retry`, `resume_deploy`, `edit_request`, `edit_migration`, `poll`
- `correlated_platform_incident` — present ONLY while an OPEN platform incident correlates with this error's `code`: `{ id: "inc_…", subsystem, status: "ongoing" | "resolved" }`, with a `poll` appended to `next_actions`. A CORRELATION, not an exoneration — the platform states it was degraded when the call failed and leaves the judgment to you (an app can still cause its own throttling). Poll the events feed (`await r.events.list(projectId)`) and check `platform_status` before debugging your own code; the follow-up `platform_incident` feed event carries the project's real failed-invocation count once the incident resolves. Absent when no open incident correlates.

Safe retry policy:
- `retryable: true` + `safe_to_retry: true` → retry, ideally with the same idempotency key for mutations
- `safe_to_retry: true` alone is not a retry signal; it means duplicate-safe, not likely-to-succeed. Lifecycle-gated writes, auth token exchanges, and passkey verifies need the indicated action before retrying.
- The `deploy` tool uses SDK `apply`, which already re-plans and retries safe `BASE_RELEASE_CONFLICT` races for omitted/current-base specs. A handled retry appears as a `deploy.retry` progress event; exhausted retries include `attempts`, `max_retries`, and `last_retry_code`. Static activation/config failures reported from `activation_pending` throw promptly with gateway metadata instead of polling until timeout. Do not hand-roll this specific deploy race loop around MCP calls.
- 5xx with `safe_to_retry: false`, or `mutation_state` is `committed` / `partial` / `unknown` → inspect or poll state before retrying. For deploys, resume with `await r.project(projectId).apply.resume(operationId)` in a `run` snippet.
- Lifecycle / payment errors → take the action, don't blind-retry. `PROJECT_FROZEN` → `await r.tier.set("<tier>")`; `PAYMENT_REQUIRED` → submit payment, then retry.
- A snippet's `run` result reports an SDK error with the SDK's own `code`, `message`, and `next_actions`, and marks the failing call in `calls[]`; branch on those, exactly as above.
- Every tool's error result carries the same fields under `structuredContent.error` (see the Structured results section of the reference); a host reads them there instead of parsing text.
