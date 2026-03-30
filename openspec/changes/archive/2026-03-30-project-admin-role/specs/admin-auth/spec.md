## ADDED Requirements

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
