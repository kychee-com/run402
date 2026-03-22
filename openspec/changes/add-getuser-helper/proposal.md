## Why

Run402 serverless functions currently only export `db` (a PostgREST client using the project's service_key). Functions have no standard way to identify the authenticated caller. Every app that needs user-scoped logic (authorization checks, ownership enforcement, audit logging) must manually parse and verify JWTs — duplicating auth logic that the platform already handles. This blocks marketplace apps like SkMeld where functions enforce rules like "residents can only submit requests for their own spaces."

## What Changes

- Add a `getUser(req)` export to the `@run402/functions` helper module
- `getUser(req)` verifies the caller's JWT (from `Authorization: Bearer <token>` header) using the project's JWT secret
- Returns `{ id, email, role }` on success, `null` if no token or invalid token
- Available in both Lambda (production) and local dev execution modes
- The project's JWT secret is injected as an environment variable alongside existing `RUN402_SERVICE_KEY`

## Capabilities

### New Capabilities
- `function-getuser`: A helper function exported from `@run402/functions` that verifies the caller's JWT and returns user identity. Covers the API contract, JWT verification logic, env var requirements, and behavior in both Lambda and local execution modes.

### Modified Capabilities

(none — no existing spec-level behavior changes)

## Impact

- **`packages/functions-runtime/build-layer.sh`**: Add `getUser` implementation to the HELPERJS heredoc that builds the Lambda layer
- **`packages/gateway/src/services/functions.ts`**: Add `getUser` to the inline helper for local dev mode; inject `RUN402_JWT_SECRET` env var when deploying functions to Lambda
- **`packages/gateway/src/routes/functions.ts`** (or equivalent): Ensure the JWT secret is passed to the Lambda environment
- **`docs/functions_spec.md`**: Document the new export
- **`site/llms.txt`** (or equivalent): Update agent-facing docs
- **E2E tests**: Add test coverage for authenticated function calls
