## MODIFIED Requirements

### Requirement: getUser extracts user identity from JWT claims only
The `getUser` function SHALL return the identity fields present in the JWT: `sub` (mapped to `id`), `role`, and `email`. Functions that need additional user data beyond these three fields SHALL query for it via `db`.

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
