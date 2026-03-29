## Context

The gateway invokes project functions in two existing contexts: cron schedules (scheduler.ts fires `invokeFunction()` with `X-Run402-Trigger: cron`) and bootstrap (fork/deploy invokes the `bootstrap` function with the caller's variables). Both use the same `invokeFunction()` path from `services/functions.ts`.

Auth has two signup paths: password signup in `routes/auth.ts` (INSERT into `internal.users`, return `{ id, email }`) and OAuth signup in `services/oauth.ts` (`resolveOAuthIdentity` returns `action: "signup"` after INSERT). Neither path has any extensibility point — just `console.log()` and `UPDATE last_sign_in_at`.

Projects that need post-signup logic (member record creation, role assignment, welcome email) currently do it client-side on every page load with retry logic.

## Goals / Non-Goals

**Goals:**
- Establish an `on-*` lifecycle hook convention for gateway-invoked functions
- Implement `on-signup` as the first hook: fire-and-forget invocation after first user signup
- Cover both password and OAuth signup paths
- Zero impact on projects that don't deploy an `on-signup` function

**Non-Goals:**
- Login hooks (not needed — on-signup functions should be idempotent and handle the "already exists" case)
- Sync invocation (awaiting the hook result before returning the auth response)
- Retry/dead-letter mechanisms (v1 is fire-and-forget with logging)
- Hook metadata tracking (reusing `schedule_meta` or similar — logging is sufficient for v1)
- Other lifecycle hooks beyond `on-signup` (the convention is established but only one hook is implemented)

## Decisions

### 1. Discovery: DB query per event

Check for the hook function with a SELECT on each signup event:

```sql
SELECT lambda_arn FROM internal.functions
WHERE project_id = $1 AND name = 'on-signup'
LIMIT 1
```

**Why over caching on project record:** Signup is low-frequency (once per user, not per request). A sub-millisecond indexed lookup is negligible compared to the bcrypt hash or OAuth round-trip that precedes it. No cache invalidation complexity, no schema changes, always correct.

### 2. Fire-and-forget execution

The hook is invoked without awaiting the result. The auth response returns immediately. The function's success or failure does not affect the signup response.

```typescript
// In auth route, after successful signup:
fireLifecycleHook(project.id, "on-signup", { user: { id, email, created_at } })
  .catch(err => console.error(`on-signup hook failed for ${project.id}:`, err));
```

**Why over sync:** Zero latency impact on signup. The client-side code already handles the case where the member record doesn't exist yet. Cold Lambda starts (1-3s) would be unacceptable in the signup response path.

### 3. Bare payload, no envelope

The function receives `{ user: { id, email, created_at } }` as the request body. No wrapping envelope with event type or timestamp.

**Why:** The function knows it's `on-signup` by its own name. Adding an envelope is ceremony with no consumer. If a future catch-all hook pattern emerges, the envelope can be added then.

### 4. Service-level auth context

The hook request carries no user JWT. The function uses its own `RUN402_SERVICE_KEY` (injected at deploy time) for database operations.

**Why:** The hook runs as a system-level operation, not on behalf of a user session. The function needs admin-level access (assign roles, set tiers) that RLS would block. The service key is already available in the function's environment.

### 5. Trigger header convention

All lifecycle hooks include `X-Run402-Trigger: <event-name>` (e.g., `signup`). This matches the existing `X-Run402-Trigger: cron` pattern from scheduled functions.

### 6. Shared helper function

A single `fireLifecycleHook(projectId, hookName, payload)` function in `services/functions.ts` handles: lookup, invocation, error logging. Both hook points (password signup, OAuth signup) call the same helper.

```
fireLifecycleHook(projectId, hookName, payload)
  1. SELECT lambda_arn FROM internal.functions WHERE project_id AND name = 'on-{hookName}'
  2. If not found → return (no-op)
  3. invokeFunction(projectId, `on-${hookName}`, "POST", ..., headers, body)
  4. Log result or error
```

This keeps the auth routes clean (one-liner to fire the hook) and ensures consistent behavior for future `on-*` hooks.

### 7. Metering

Hook invocations count against the project's API quota, same as cron invocations. The `fireLifecycleHook` helper increments the metering counter before invoking.

## Risks / Trade-offs

**[Risk] Hook function crashes or times out** → No impact on user. Fire-and-forget means the signup succeeds regardless. The error is logged. The function should be idempotent so the client-side fallback (if retained) can compensate.

**[Risk] Double invocation on race condition** → If two signup requests for the same email arrive simultaneously (unlikely but possible), both may trigger the hook before the unique constraint rejects the second INSERT. Mitigation: the function is responsible for idempotency (check if member record exists before creating). This is already the pattern in the existing client-side workaround.

**[Risk] Lambda cold start adds invisible latency** → The hook runs fire-and-forget, so the user doesn't see it. But the member record may not exist for 1-3s after signup. Mitigation: the client already handles this case. Over time, warm Lambdas reduce this to ~200ms.

**[Trade-off] No retry mechanism** → If the hook fails, it's not retried. For v1 this is acceptable — the client-side fallback can remain as a safety net during rollout. A retry queue can be added later if needed.

**[Trade-off] DB query on every signup** → One extra SELECT per signup. Negligible for the expected volume. Can be optimized later with a project-level hooks cache if needed.
