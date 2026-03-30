### Requirement: Admin identity detection from ADMIN_KEY
The `adminAuth` middleware SHALL recognize admin identity when the request contains an `Authorization: Bearer <token>` header where the token matches the configured `ADMIN_KEY`.

#### Scenario: Valid ADMIN_KEY
- **WHEN** a request includes `Authorization: Bearer <ADMIN_KEY>` with a valid admin key
- **THEN** the middleware SHALL set `req.isAdmin = true`

#### Scenario: Invalid ADMIN_KEY
- **WHEN** a request includes `Authorization: Bearer <token>` where the token does not match `ADMIN_KEY`
- **THEN** the middleware SHALL NOT set `req.isAdmin`

### Requirement: Admin identity detection from admin wallet SIWx
The `adminAuth` middleware SHALL recognize admin identity when the request contains a valid `SIGN-IN-WITH-X` header signed by a wallet address that exists in `internal.admin_wallets`.

#### Scenario: SIWx from admin wallet
- **WHEN** a request includes a valid SIWx header signed by wallet `0xABC` and `0xABC` is in `internal.admin_wallets`
- **THEN** the middleware SHALL set `req.isAdmin = true` and `req.walletAddress = "0xabc"`

#### Scenario: SIWx from non-admin wallet
- **WHEN** a request includes a valid SIWx header signed by a wallet that is NOT in `internal.admin_wallets`
- **THEN** the middleware SHALL NOT set `req.isAdmin` (but `req.walletAddress` SHALL still be set for downstream use)

### Requirement: Admin identity detection from Google OAuth session
The `adminAuth` middleware SHALL recognize admin identity when the request contains a valid `run402_admin` session cookie from a `@kychee.com` Google account.

#### Scenario: Valid session cookie
- **WHEN** a request includes a valid, non-expired `run402_admin` session cookie
- **THEN** the middleware SHALL set `req.isAdmin = true`

#### Scenario: Expired or invalid session cookie
- **WHEN** a request includes an expired or tampered session cookie
- **THEN** the middleware SHALL NOT set `req.isAdmin`

### Requirement: Admin auth composes with existing middleware
The gateway SHALL provide composed middleware functions (`serviceKeyOrAdmin`, `walletAuthOrAdmin`) that accept EITHER the original auth mechanism OR admin auth. If both fail, the request SHALL be rejected with 401.

#### Scenario: serviceKeyOrAdmin with valid service_key
- **WHEN** a request to a `serviceKeyOrAdmin`-protected endpoint includes a valid service_key JWT
- **THEN** the request SHALL be authorized as the project owner (existing behavior, `req.isAdmin` not set)

#### Scenario: serviceKeyOrAdmin with admin key
- **WHEN** a request to a `serviceKeyOrAdmin`-protected endpoint includes ADMIN_KEY instead of a service_key
- **THEN** the request SHALL be authorized with `req.isAdmin = true`

#### Scenario: serviceKeyOrAdmin with neither
- **WHEN** a request to a `serviceKeyOrAdmin`-protected endpoint includes neither a valid service_key nor admin credentials
- **THEN** the endpoint SHALL return 401

### Requirement: Admin detection order
The `adminAuth` middleware SHALL check credentials in order: ADMIN_KEY header, then SIWx header, then session cookie. It SHALL use the first mechanism that succeeds.

#### Scenario: Request with both ADMIN_KEY and session cookie
- **WHEN** a request includes both a valid ADMIN_KEY and a valid session cookie
- **THEN** the middleware SHALL use ADMIN_KEY (first match) and set `req.isAdmin = true`

### Requirement: projectAdminAuth middleware

The gateway SHALL provide a `projectAdminAuth` middleware that validates a JWT with `role: "project_admin"`. It SHALL verify the JWT signature, check expiration, and confirm `project_id` matches the `:id` URL parameter. On success, it SHALL set `req.isProjectAdmin = true` and `req.projectAdminUserId` to the JWT's `sub` claim.

#### Scenario: Valid project_admin JWT
- **WHEN** a request includes `Authorization: Bearer <token>` with a valid JWT containing `role: "project_admin"` and `project_id` matching the URL `:id`
- **THEN** the middleware SHALL set `req.isProjectAdmin = true` and call `next()`

#### Scenario: Expired project_admin JWT
- **WHEN** a request includes a `project_admin` JWT that has expired
- **THEN** the middleware SHALL reject with `401 { error: "Token expired" }`

#### Scenario: project_id mismatch
- **WHEN** a request includes a valid `project_admin` JWT but its `project_id` does not match the URL `:id` parameter
- **THEN** the middleware SHALL reject with `401`

#### Scenario: Regular authenticated JWT
- **WHEN** a request includes a JWT with `role: "authenticated"` (not project_admin)
- **THEN** the middleware SHALL reject with `401`

### Requirement: serviceKeyOrProjectAdmin composed middleware

The gateway SHALL provide a `serviceKeyOrProjectAdmin` composed middleware that accepts EITHER a valid service_key JWT OR a valid `project_admin` JWT. It SHALL try `serviceKeyAuth` first, then `projectAdminAuth`. If both fail, it SHALL return `401`.

#### Scenario: service_key auth succeeds
- **WHEN** a request to a `serviceKeyOrProjectAdmin`-protected endpoint includes a valid service_key JWT
- **THEN** the request SHALL be authorized (existing behavior)

#### Scenario: project_admin auth succeeds
- **WHEN** a request to a `serviceKeyOrProjectAdmin`-protected endpoint includes a valid `project_admin` JWT with matching `project_id`
- **THEN** the request SHALL be authorized with `req.isProjectAdmin = true`

#### Scenario: Neither auth succeeds
- **WHEN** a request includes neither a valid service_key nor a valid `project_admin` JWT
- **THEN** the endpoint SHALL return `401`
