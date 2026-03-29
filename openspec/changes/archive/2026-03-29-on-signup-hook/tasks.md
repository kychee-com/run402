## 1. Core helper

- [x] 1.1 Add `fireLifecycleHook(projectId, hookName, payload)` to `packages/gateway/src/services/functions.ts` — looks up function by `(project_id, 'on-' + hookName)`, checks API quota, invokes fire-and-forget via `invokeFunction()`, logs result/error
- [x] 1.2 Unit-verify: call `fireLifecycleHook` when no matching function exists — should return silently with no invocation

## 2. Password signup hook point

- [x] 2.1 In `packages/gateway/src/routes/auth.ts`, after successful INSERT in the signup handler, call `fireLifecycleHook(project.id, "signup", { user: { id, email, created_at } })` — fire-and-forget (no await in response path)
- [x] 2.2 Verify: password signup still returns immediately (no latency change)

## 3. OAuth signup hook point

- [x] 3.1 In `packages/gateway/src/services/oauth.ts`, after `resolveOAuthIdentity` returns action `"signup"`, call `fireLifecycleHook(project.id, "signup", { user: { id, email, created_at } })` — same fire-and-forget pattern
- [x] 3.2 Verify: OAuth signin (existing user) and account linking do NOT fire the hook

## 4. E2E verification

- [x] 4.1 Deploy a test `on-signup` function that inserts a row into a known table (e.g., `members`) with the user's ID *(verified against production)*
- [x] 4.2 Sign up a new user via password, confirm the `on-signup` function was invoked (member row exists within a few seconds) *(verified against production)*
- [ ] 4.3 Sign up a new user via OAuth, confirm the `on-signup` function was invoked *(requires Google OAuth flow — manual test)*
- [x] 4.4 Log in an existing user, confirm the `on-signup` function was NOT invoked *(verified against production)*
