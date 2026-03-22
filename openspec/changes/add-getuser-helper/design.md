## Context

Run402 serverless functions import `{ db }` from `@run402/functions`. The `db` helper uses the project's `service_key` (role: `service_role`) for all PostgREST calls, bypassing RLS. The helper code exists in two places:

1. **Lambda layer** (`packages/functions-runtime/build-layer.sh`) — the HELPERJS heredoc that becomes `nodejs/node_modules/@run402/functions/index.js`
2. **Local dev inline** (`packages/gateway/src/services/functions.ts`, `writeLocalFunction()`) — a minimal version inlined into the `.mjs` file

When deploying functions to Lambda, the gateway injects env vars: `RUN402_PROJECT_ID`, `RUN402_API_BASE`, `RUN402_SERVICE_KEY`, plus any user-defined secrets. The project's JWT secret (`JWT_SECRET` in config.ts) is a single shared secret used to sign all project JWTs (anon keys, service keys, and user access tokens).

User access tokens have the payload: `{ sub: <user_id>, role: "authenticated", project_id: <project_id>, iss: "agentdb" }` with 1-hour expiry.

## Goals / Non-Goals

**Goals:**
- Add `getUser(req)` export to `@run402/functions` that verifies the caller's JWT and returns user identity
- Work identically in Lambda and local dev modes
- Zero-dependency JWT verification (use `jsonwebtoken` which is already in the Lambda layer)
- Simple API: returns user object or `null`

**Non-Goals:**
- No `invoke_as` deploy-time config
- No RLS-scoped `db` client (if you need RLS, use PostgREST directly from the frontend)
- No Python runtime support (Node-only for now)
- No role/permission framework — `getUser` returns identity, the function author writes authorization checks

## Decisions

### 1. Use `jsonwebtoken` for verification (not manual decode)

`jsonwebtoken` is already bundled in the Lambda layer as a pre-installed package. Using `jwt.verify()` handles signature verification, expiry checks, and claim extraction in one call.

**Alternative considered:** Manual base64 decode + HMAC verification. Rejected — error-prone, doesn't handle edge cases (clock skew, malformed tokens), and `jsonwebtoken` is already available.

### 2. Inject `RUN402_JWT_SECRET` as a new env var

The gateway already injects `RUN402_SERVICE_KEY`. Add `RUN402_JWT_SECRET` alongside it when deploying functions. This is the same `JWT_SECRET` from `config.ts` that the gateway uses to sign all project JWTs.

**Why not derive from service_key?** The service_key is a signed JWT itself, not the signing secret. The function needs the raw HMAC secret to verify user tokens.

### 3. Return shape: `{ id, role }` or `null`

```javascript
const user = getUser(req);
// { id: "uuid", role: "authenticated" } or null
```

Only includes fields from the JWT itself (`sub` → `id`, `role`). Does NOT include email or other app-level profile data — those aren't guaranteed to exist (e.g., wallet-auth apps, username-only apps). Functions that need profile data query for it: `db.from('profiles').select('*').eq('user_id', user.id)`.

Returns `null` for: missing Authorization header, invalid token, expired token, wrong project. Does not throw — the function decides what to do with `null` (return 401, fall back to anonymous, etc.).

**Alternative considered:** Including `email` in the return shape by adding it to JWT claims. Rejected — email isn't mandatory in all auth flows, and baking app-level fields into the platform helper creates assumptions about the data model. Keep `getUser` minimal (JWT-only), let the function query what it needs.

**Alternative considered:** Throwing on invalid token. Rejected — forcing try/catch on every function is worse DX than a null check.

### 4. Synchronous verification

`jsonwebtoken.verify()` is synchronous for HMAC secrets. `getUser` can be a plain function (not async), which is simpler for callers: `const user = getUser(req)` — no await needed.

### 5. Extract token from `Authorization: Bearer <token>` header

The gateway already forwards the caller's headers to the function. User access tokens come via `Authorization: Bearer <access_token>`. This is the same header the gateway's own auth middleware reads.

## Risks / Trade-offs

**[Single shared JWT secret]** → All projects on the same Run402 instance share the same JWT secret. A function in project A could theoretically verify a token from project B. Mitigation: `getUser` checks that the token's `project_id` claim matches `RUN402_PROJECT_ID`. This is already how the gateway's apikey middleware works.

**[Token expiry during function execution]** → A token could expire between the time the request is made and the function processes it. Mitigation: `jsonwebtoken.verify()` handles this automatically. The 1-hour expiry window is generous enough that this is not a practical issue.

**[Helper code duplication]** → The `getUser` implementation must be added in both `build-layer.sh` (Lambda) and `functions.ts` (local dev inline). Mitigation: Keep the implementation small (~15 lines). Both codepaths are already maintained in parallel for `db`.
