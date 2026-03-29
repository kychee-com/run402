## ADDED Requirements

### Requirement: Fire on-signup after password signup
After a successful password signup (`POST /auth/v1/signup`), the gateway SHALL check if the project has a deployed function named `on-signup`. If it exists, the gateway SHALL invoke it fire-and-forget with the new user's data.

#### Scenario: Password signup with on-signup function deployed
- **WHEN** a user signs up via `POST /auth/v1/signup` with email `alice@example.com` and the project has a deployed function named `on-signup`
- **THEN** the gateway SHALL return the signup response immediately AND invoke the `on-signup` function asynchronously with body `{ "user": { "id": "<uuid>", "email": "alice@example.com", "created_at": "<timestamp>" } }` and header `X-Run402-Trigger: signup`

#### Scenario: Password signup without on-signup function
- **WHEN** a user signs up via `POST /auth/v1/signup` and the project has no function named `on-signup`
- **THEN** the gateway SHALL return the signup response normally with no additional behavior

### Requirement: Fire on-signup after OAuth signup
After a successful OAuth signup (when `resolveOAuthIdentity` creates a new user, returning action `"signup"`), the gateway SHALL check if the project has a deployed function named `on-signup`. If it exists, the gateway SHALL invoke it fire-and-forget with the new user's data.

#### Scenario: OAuth signup with on-signup function deployed
- **WHEN** a user signs up via Google OAuth (new account created) and the project has a deployed function named `on-signup`
- **THEN** the gateway SHALL invoke the `on-signup` function asynchronously with body `{ "user": { "id": "<uuid>", "email": "user@gmail.com", "created_at": "<timestamp>" } }` and header `X-Run402-Trigger: signup`

#### Scenario: OAuth login does not fire hook
- **WHEN** a user logs in via Google OAuth (existing account found, action is `"signin"`)
- **THEN** the gateway SHALL NOT invoke the `on-signup` function

#### Scenario: OAuth account linking does not fire hook
- **WHEN** a user links a Google identity to an existing account (action is `"linked"`)
- **THEN** the gateway SHALL NOT invoke the `on-signup` function

### Requirement: on-signup payload shape
The `on-signup` function SHALL receive a POST request with a JSON body containing `{ "user": { "id": "<uuid>", "email": "<string>", "created_at": "<ISO timestamp>" } }`. No additional fields SHALL be included in v1.

#### Scenario: Function parses payload
- **WHEN** the `on-signup` function runs and calls `await request.json()`
- **THEN** the result SHALL be `{ "user": { "id": "550e8400-e29b-41d4-a716-446655440000", "email": "alice@example.com", "created_at": "2026-03-29T12:00:00.000Z" } }`

### Requirement: Only first signup fires hook
The `on-signup` hook SHALL only fire when a new user account is created. It SHALL NOT fire on subsequent logins, token refreshes, or password resets for existing users.

#### Scenario: Login does not fire hook
- **WHEN** an existing user logs in via `POST /auth/v1/token`
- **THEN** the `on-signup` function SHALL NOT be invoked

#### Scenario: Token refresh does not fire hook
- **WHEN** a user refreshes their token via `POST /auth/v1/token?grant_type=refresh_token`
- **THEN** the `on-signup` function SHALL NOT be invoked

### Requirement: Shared helper for lifecycle hooks
The gateway SHALL implement a `fireLifecycleHook(projectId, hookName, payload)` helper in `services/functions.ts` that encapsulates hook discovery, invocation, metering, and error logging. Both the password signup and OAuth signup hook points SHALL use this same helper.

#### Scenario: Helper handles missing function
- **WHEN** `fireLifecycleHook("prj_123", "signup", { user: {...} })` is called and no function named `on-signup` exists for `prj_123`
- **THEN** the helper SHALL return immediately with no side effects

#### Scenario: Helper logs errors
- **WHEN** `fireLifecycleHook` invokes a function that throws an error
- **THEN** the helper SHALL log the error with project ID and hook name to the gateway console

#### Scenario: Helper meters the invocation
- **WHEN** `fireLifecycleHook` finds and invokes a hook function
- **THEN** the helper SHALL increment the project's API call counter by 1 before invoking
