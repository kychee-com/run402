### Requirement: getUser export from @run402/functions
The `@run402/functions` module SHALL export a `getUser` function alongside the existing `db` export. Functions import it as `import { db, getUser } from '@run402/functions'`.

#### Scenario: Successful user identification
- **WHEN** a function calls `getUser(req)` with a request containing a valid `Authorization: Bearer <access_token>` header
- **THEN** it SHALL return `{ id: string, role: string, email: string }` where `id` is the user's UUID (from the JWT `sub` claim), `role` is the JWT role claim (typically `"authenticated"`), and `email` is the user's email address

#### Scenario: Missing authorization header
- **WHEN** a function calls `getUser(req)` with a request that has no `Authorization` header
- **THEN** it SHALL return `null`

#### Scenario: Invalid or expired token
- **WHEN** a function calls `getUser(req)` with a request containing an invalid, expired, or malformed JWT in the `Authorization: Bearer` header
- **THEN** it SHALL return `null`

#### Scenario: Token from wrong project
- **WHEN** a function calls `getUser(req)` with a request containing a valid JWT whose `project_id` claim does not match `RUN402_PROJECT_ID`
- **THEN** it SHALL return `null`

#### Scenario: Non-Bearer authorization
- **WHEN** a function calls `getUser(req)` with a request containing an `Authorization` header that does not start with `Bearer `
- **THEN** it SHALL return `null`

### Requirement: getUser is synchronous
The `getUser` function SHALL be synchronous (not async). It uses HMAC-based JWT verification which is a CPU-only operation. Callers SHALL use `const user = getUser(req)` without `await`.

#### Scenario: No await required
- **WHEN** a function calls `const user = getUser(req)`
- **THEN** `user` SHALL be the resolved value (not a Promise)

### Requirement: JWT secret injected as environment variable
The gateway SHALL inject `RUN402_JWT_SECRET` as an environment variable when deploying functions to Lambda, alongside the existing `RUN402_PROJECT_ID`, `RUN402_API_BASE`, and `RUN402_SERVICE_KEY` variables. The value SHALL be the same `JWT_SECRET` used by the gateway to sign all project JWTs.

#### Scenario: Lambda function deployment includes JWT secret
- **WHEN** a function is deployed via `POST /admin/v1/projects/:id/functions`
- **THEN** the Lambda environment variables SHALL include `RUN402_JWT_SECRET` set to the gateway's JWT signing secret

#### Scenario: Local dev function includes JWT secret
- **WHEN** a function is executed in local dev mode (no `LAMBDA_ROLE_ARN`)
- **THEN** the inlined helper code SHALL have access to the JWT secret via `RUN402_JWT_SECRET` environment variable or equivalent inline constant

### Requirement: getUser uses jsonwebtoken for verification
The `getUser` function SHALL use the `jsonwebtoken` package (already bundled in the Lambda layer) to verify the token signature, check expiry, and extract claims. It SHALL NOT use manual base64 decoding or custom verification logic.

#### Scenario: Token signature verification
- **WHEN** a function calls `getUser(req)` with a JWT signed by a different secret
- **THEN** it SHALL return `null` (signature mismatch)

### Requirement: getUser extracts user identity from JWT claims
The `getUser` function SHALL return the identity fields present in the JWT: `sub` (mapped to `id`), `role`, and `email`. Functions that need additional user data beyond these fields (e.g., display_name, avatar_url) SHALL query for it via `db`.

#### Scenario: Claim mapping
- **WHEN** a function calls `getUser(req)` with a valid token containing `{ sub: "abc-123", role: "authenticated", email: "user@example.com", project_id: "prj_001" }`
- **THEN** it SHALL return `{ id: "abc-123", role: "authenticated", email: "user@example.com" }`

#### Scenario: Function needs profile data beyond email
- **WHEN** a function needs the user's display_name, avatar_url, or other profile fields
- **THEN** it SHALL use `getUser(req)` to obtain the user ID, then query via `db.from('profiles').select('*').eq('user_id', user.id)` or equivalent

### Requirement: JWT claims include email
The gateway SHALL include the `email` claim in all user JWTs (password login, OAuth login, token refresh). The value SHALL be the user's email address from `internal.users`.

#### Scenario: Password login JWT contains email
- **WHEN** a user authenticates via `POST /auth/v1/token` with `grant_type: "password"`
- **THEN** the issued JWT SHALL contain the `email` claim set to the user's email address

#### Scenario: OAuth login JWT contains email
- **WHEN** a user authenticates via `POST /auth/v1/token` with `grant_type: "authorization_code"`
- **THEN** the issued JWT SHALL contain the `email` claim set to the user's email address

#### Scenario: Token refresh JWT contains email
- **WHEN** a user refreshes via `POST /auth/v1/token` with `grant_type: "refresh_token"`
- **THEN** the refreshed JWT SHALL contain the `email` claim set to the user's current email address

### Requirement: getUser available in both Lambda and local dev modes
The `getUser` implementation SHALL exist in both:
1. The Lambda layer helper (`packages/functions-runtime/build-layer.sh` HELPERJS heredoc)
2. The local dev inline helper (`packages/gateway/src/services/functions.ts` `writeLocalFunction()`)

Both implementations SHALL behave identically.

#### Scenario: Lambda mode
- **WHEN** a function deployed to Lambda calls `getUser(req)`
- **THEN** it SHALL work using the `jsonwebtoken` package from the Lambda layer and the `RUN402_JWT_SECRET` env var

#### Scenario: Local dev mode
- **WHEN** a function running in local dev mode calls `getUser(req)`
- **THEN** it SHALL work using `jsonwebtoken` imported in the inlined code and the JWT secret from the gateway's environment
