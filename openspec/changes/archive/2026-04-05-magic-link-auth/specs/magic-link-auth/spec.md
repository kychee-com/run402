### Requirement: Magic link request

The gateway SHALL expose `POST /auth/v1/magic-link` for requesting a passwordless login link.

#### Scenario: Successful request

- **WHEN** `POST /auth/v1/magic-link` is called with `{ "email": "user@example.com", "redirect_url": "https://myapp.run402.com/auth/callback" }` and a valid `anon_key`
- **THEN** the gateway SHALL return HTTP 200 with `{ "message": "If this email is valid, a magic link has been sent." }`
- **AND** an email SHALL be sent to the address using the `magic_link` template
- **AND** the link in the email SHALL point to `<redirect_url>?token=<token>` (the project's own frontend)
- **AND** `redirect_url` SHALL be validated against the project's allowed origins (same as OAuth `validateRedirectUrl`)

#### Scenario: Missing or invalid redirect_url

- **WHEN** `POST /auth/v1/magic-link` is called without `redirect_url` or with a URL not in the project's allowed origins
- **THEN** the gateway SHALL return HTTP 400

#### Scenario: Token entropy

- **WHEN** a magic link token is generated
- **THEN** the token SHALL contain at least 32 bytes of cryptographic randomness (URL-safe base64 encoded)
- **AND** the token SHALL be stored as a SHA-256 hash (raw token never persisted)

#### Scenario: Token TTL

- **WHEN** a magic link token is created
- **THEN** it SHALL expire after 15 minutes (default)
- **AND** an expired token SHALL NOT be usable for verification

#### Scenario: Single active token

- **WHEN** a magic link is requested for an email that already has an active (unexpired, unused) token in the same project
- **THEN** the previous token SHALL be invalidated
- **AND** only the new token SHALL be accepted for verification

#### Scenario: Invalid email format

- **WHEN** `POST /auth/v1/magic-link` is called with an invalid email format
- **THEN** the gateway SHALL return HTTP 400

#### Scenario: No account enumeration

- **WHEN** a magic link is requested for an email that exists in the project
- **THEN** the response body and status code SHALL be identical to a request for a non-existent email
- **AND** no information SHALL be leaked about which emails have accounts

### Requirement: Rate limiting

The magic link request endpoint SHALL enforce two tiers of rate limiting.

#### Scenario: Per-email rate limit

- **WHEN** more than 5 magic link requests are made for the same email in the same project within one hour
- **THEN** the 6th request SHALL return HTTP 429 Too Many Requests

#### Scenario: Per-project rate limit

- **WHEN** the total magic link requests for a project exceed the tier-based hourly limit (prototype: 50, hobby: 200, team: 1000)
- **THEN** subsequent requests SHALL return HTTP 429 Too Many Requests

### Requirement: Magic link verification

The existing `POST /auth/v1/token` endpoint SHALL accept `grant_type=magic_link` for token verification.

#### Scenario: Successful verification (existing user)

- **WHEN** `POST /auth/v1/token?grant_type=magic_link` is called with `{ "token": "<valid_token>" }` for an email with an existing user
- **THEN** the gateway SHALL return HTTP 200 with `{ access_token, token_type: "bearer", expires_in: 3600, refresh_token, user: { id, email } }`
- **AND** the response shape SHALL be identical to password and OAuth login responses

#### Scenario: Successful verification (new user — auto sign-up)

- **WHEN** `POST /auth/v1/token?grant_type=magic_link` is called with a valid token for an email with no existing user in the project
- **THEN** a new user SHALL be created with `password_hash = NULL`
- **AND** `email_verified_at` SHALL be set to the current timestamp
- **AND** the `on-signup` lifecycle hook SHALL fire for the new user
- **AND** an access token and refresh token SHALL be returned

#### Scenario: Demo mode signup limit

- **WHEN** auto sign-up is triggered in a demo mode project that has reached its signup limit
- **THEN** the gateway SHALL return HTTP 403

#### Scenario: Consumed token

- **WHEN** a magic link token that has already been used is submitted for verification
- **THEN** the gateway SHALL return HTTP 401

#### Scenario: Expired token

- **WHEN** an expired magic link token is submitted for verification
- **THEN** the gateway SHALL return HTTP 401

#### Scenario: Invalid token

- **WHEN** a malformed or nonexistent token is submitted for verification
- **THEN** the gateway SHALL return HTTP 401

### Requirement: Email verification side effect

#### Scenario: First magic link verification

- **WHEN** a user completes magic link verification and `email_verified_at` is NULL
- **THEN** `email_verified_at` SHALL be set to the current timestamp

#### Scenario: Already verified email

- **WHEN** a user completes magic link verification and `email_verified_at` is already set
- **THEN** `email_verified_at` SHALL NOT be overwritten

### Requirement: Multi-method identity model

The user identity system SHALL support any combination of authentication methods.

#### Scenario: Nullable password hash

- **WHEN** a user is created via OAuth or magic link
- **THEN** `password_hash` SHALL be NULL
- **AND** the `internal.users` schema SHALL officially declare `password_hash` as nullable

#### Scenario: Password login for passwordless user

- **WHEN** a user with `password_hash = NULL` attempts password login
- **THEN** the gateway SHALL return HTTP 401 with a message indicating the account uses social login or magic link

#### Scenario: Magic link for password user

- **WHEN** an existing password-based user requests a magic link
- **THEN** a magic link SHALL be sent and work for authentication without any prior setup

#### Scenario: Magic link for OAuth user

- **WHEN** an existing OAuth-only user requests a magic link
- **THEN** a magic link SHALL be sent and work for authentication

#### Scenario: Providers endpoint

- **WHEN** `GET /auth/v1/providers` is called
- **THEN** the response SHALL include `magic_link: { enabled: true }` alongside password and OAuth providers

### Requirement: Password management

The gateway SHALL expose `PUT /auth/v1/user/password` for password change, reset, and initial set.

#### Scenario: Password change (existing password)

- **WHEN** an authenticated user with an existing password calls `PUT /auth/v1/user/password` with `{ "current_password": "old", "new_password": "new" }`
- **THEN** the password SHALL be updated
- **AND** the gateway SHALL return HTTP 200

#### Scenario: Wrong current password

- **WHEN** an authenticated user provides an incorrect `current_password`
- **THEN** the gateway SHALL return HTTP 401

#### Scenario: Password reset via magic link

- **WHEN** a user with an existing password logs in via magic link and calls `PUT /auth/v1/user/password` with `{ "new_password": "new" }` (no `current_password`)
- **THEN** the password SHALL be updated (the magic link login proves identity)
- **AND** the gateway SHALL return HTTP 200
- **NOTE** this works because the user already had a password — they are resetting it, not setting one for the first time

#### Scenario: Password set for passwordless user (allowed)

- **WHEN** a passwordless user (magic-link-only or OAuth-only) calls `PUT /auth/v1/user/password` with `{ "new_password": "new" }`
- **AND** the project has `allow_password_set` enabled
- **THEN** `password_hash` SHALL be set
- **AND** the user SHALL be able to log in with both password and their original auth method

#### Scenario: Password set for passwordless user (not allowed)

- **WHEN** a passwordless user calls `PUT /auth/v1/user/password` with `{ "new_password": "new" }`
- **AND** the project has `allow_password_set` disabled (default)
- **THEN** the gateway SHALL return HTTP 403 with a message indicating password set is not enabled for this project

#### Scenario: Unauthenticated request

- **WHEN** `PUT /auth/v1/user/password` is called without a valid Bearer token
- **THEN** the gateway SHALL return HTTP 401

### Requirement: Project auth settings

Project owners SHALL be able to configure auth behavior for their project.

#### Scenario: allow_password_set setting

- **WHEN** a project is created
- **THEN** `allow_password_set` SHALL default to `false`
- **AND** the setting SHALL be changeable via the project admin API (service_key auth)

#### Scenario: Settings reflected in providers

- **WHEN** `GET /auth/v1/providers` is called
- **THEN** the response SHALL include `password_set: { enabled: true/false }` reflecting the project's `allow_password_set` setting
