---
title: "Portable project archives"
description: "Native MCP reference — lifecycle."
order: 20
---

## Portable project archives

Portable archives let an agent export the supported Run402 Core runtime slice of a Cloud project, verify it locally, and import it into a new local Core project. This is the vendor-lock-in trust claim: Cloud is the easiest place to start, not the only place the supported application can run. It is separate from allowance/spend-cap financial-risk controls.

MCP happy path:

1. `export_project_archive` with `project_id`, optional `output_path`, `scope: "portable-runtime-v1"`, `auth: "stubs"`, `consistency: "pause-writes"`, and `wait: true`.
2. `inspect_project_archive` with `archive_path`.
3. `verify_project_archive` with `archive_path`.
4. Fill the required secret values from the archive's `secrets/required.env.template` or the `required_secrets` list.
5. `import_project_archive` with `archive_path`, `name`, `env_file` or `secret_values`, and optional `require_runnable: true`.

Tool outputs use the same agent fields as CLI/SDK: `code`, `severity`, `resource_type`, `resource_id`, `message`, `next_action`, `retryable`, and safe `context`. `verify_project_archive` is offline and checks integrity and compatibility only; archives remain untrusted input. Import verifies before mutation, creates a new Core project only, and never imports secret values, auth credentials, logs, billing/allowance state, or managed Cloud operations from Cloud export.

## Project credentials

After `provision_postgres_project`, two keys are saved automatically and reused by every subsequent tool call:

- `anon_key` — read-only by default; safe in browser HTML. RLS policies apply.
- `service_key` — server-side admin. Never embed in browser code. CORS is intentionally open for x402 clients, so a leaked service_key is exploitable from any origin. Use only inside functions or when calling tools as the agent.

Neither key expires. To inspect, call `project_keys`; to switch the active project for sticky-default tools, call `project_use`.

## Error envelopes and safe retry

Run402 JSON errors carry a canonical envelope. Branch on `code`, not English `message`.

Important fields:
- `code` — stable machine-readable reason: `PROJECT_FROZEN`, `PAYMENT_REQUIRED`, `MIGRATION_FAILED`, `MIGRATE_GATE_ACTIVE`, `RATE_LIMITED`, `INSUFFICIENT_FUNDS`, `CI_ROUTE_SCOPE_DENIED`
- `retryable` — the same request may succeed later
- `safe_to_retry` — repeating the same request will not duplicate or corrupt a mutation
- `mutation_state` — `none` / `not_started` / `committed` / `rolled_back` / `partial` / `unknown`
- `trace_id` — include this when reporting an issue
- `request_id` — routed/function failure handle. Use `get_function_logs` with `request_id` for function diagnostics; it is distinct from gateway `trace_id`.
- `details` — structured route-specific context
- `next_actions` — `authenticate`, `submit_payment`, `renew_tier`, `check_usage`, `retry`, `resume_deploy`, `edit_request`, `edit_migration`, `poll`
- `correlated_platform_incident` — present ONLY while an OPEN platform incident correlates with this error's `code`: `{ id: "inc_…", subsystem, status: "ongoing" | "resolved" }`, with a `poll` appended to `next_actions`. A CORRELATION, not an exoneration — the platform states it was degraded when the call failed and leaves the judgment to you (an app can still cause its own throttling). Poll the events feed (`list_project_events`) and check `platform_status` before debugging your own code; the follow-up `platform_incident` feed event carries the project's real failed-invocation count once the incident resolves. Absent when no open incident correlates.

Safe retry policy:
- `retryable: true` + `safe_to_retry: true` → retry, ideally with the same idempotency key for mutations
- `safe_to_retry: true` alone is not a retry signal; it means duplicate-safe, not likely-to-succeed. Lifecycle-gated writes, auth token exchanges, and passkey verifies need the indicated action before retrying.
- The `deploy` tool uses SDK `apply`, which already re-plans and retries safe `BASE_RELEASE_CONFLICT` races for omitted/current-base specs. A handled retry appears as a `deploy.retry` progress event; exhausted retries include `attempts`, `max_retries`, and `last_retry_code`. Static activation/config failures reported from `activation_pending` throw promptly with gateway metadata instead of polling until timeout. Do not hand-roll this specific deploy race loop around MCP calls.
- 5xx with `safe_to_retry: false`, or `mutation_state` is `committed` / `partial` / `unknown` → inspect or poll state before retrying. For deploys, use `deploy_resume` / event polling.
- Lifecycle / payment errors → take the action, don't blind-retry. `PROJECT_FROZEN` → `tier_set`; `PAYMENT_REQUIRED` → submit payment, then retry.
