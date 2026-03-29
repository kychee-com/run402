## Why

There is no way to run server-side code when a user signs up. Projects that need post-signup logic (create member record, assign role, send welcome email) must do it client-side on every page load, which is fragile: the tab may close before init completes, there are race conditions with multiple tabs, and retry logic adds complexity. The gateway already invokes functions for cron triggers and bootstrap — extending this to auth events is a natural next step.

## What Changes

- Introduce an `on-*` lifecycle hook convention: any deployed function named `on-<event>` is a lifecycle hook invoked by the gateway, not by HTTP clients.
- After a successful **first signup** (password or OAuth), the gateway checks if the project has a function named `on-signup`. If it exists, the gateway invokes it fire-and-forget via the existing `invokeFunction()` path.
- The function receives a bare payload `{ user: { id, email, created_at } }` with header `X-Run402-Trigger: signup`. No user JWT is passed — the function uses its own service key for privileged operations.
- Hook invocations count against API quota (same as cron invocations).
- Login does not trigger the hook. Only first account creation fires it.

## Capabilities

### New Capabilities
- `lifecycle-hooks`: The `on-*` function naming convention — gateway-invoked lifecycle hooks. Covers discovery (DB lookup by name), execution contract (fire-and-forget, service-level auth, idempotency is function's responsibility), trigger header convention, and metering.
- `on-signup-hook`: The first lifecycle hook. Fired after first signup (password and OAuth). Covers the two hook points (auth.ts for password signup, oauth.ts for OAuth signup), payload shape, and the constraint that it only fires on account creation, not login.

### Modified Capabilities
- `scheduled-functions`: No requirement changes — but the design will reference the same invocation pattern (`invokeFunction()` + trigger header) for consistency.

## Impact

- **Gateway code**: Two hook points added — one in `routes/auth.ts` (password signup), one in `services/oauth.ts` (OAuth signup action). Both call `invokeFunction()` without awaiting the result.
- **No schema changes**: Uses existing `internal.functions` table. Hook discovery is a simple SELECT by project_id + name.
- **No API changes**: No new endpoints. The hook is an internal gateway behavior triggered by existing auth endpoints.
- **No client changes**: Existing client-side `ensureMemberRecord` workaround can be removed after rollout, but the hook is backwards-compatible (projects without an `on-signup` function are unaffected).
- **Functions runtime**: No changes to `@run402/functions` — the function receives a standard Request object.
