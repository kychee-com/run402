## ADDED Requirements

### Requirement: project_admin Postgres role exists

The database SHALL have a `project_admin` role with `NOLOGIN BYPASSRLS`. The role SHALL be granted to `authenticator`. Each project schema slot SHALL grant `SELECT, INSERT, UPDATE, DELETE` on tables and `USAGE, SELECT` on sequences to `project_admin`.

#### Scenario: project_admin role privileges
- **WHEN** a PostgREST request arrives with a JWT containing `role: "project_admin"` and a valid `project_id`
- **THEN** PostgREST SHALL switch to the `project_admin` Postgres role
- **THEN** all RLS policies on the project's tables SHALL be bypassed
- **THEN** the request SHALL have full SELECT, INSERT, UPDATE, DELETE access to the project's schema

#### Scenario: project_admin cannot access other projects
- **WHEN** a PostgREST request arrives with a JWT containing `role: "project_admin"` and `project_id: "prj_A"`
- **THEN** the `pre_request()` function SHALL validate that the accessed schema matches project A's schema slot
- **THEN** access to any other project's schema SHALL be rejected

### Requirement: is_admin flag on internal.users

The `internal.users` table SHALL have an `is_admin` column of type `BOOLEAN DEFAULT false`.

#### Scenario: New user default
- **WHEN** a user is created via `POST /auth/v1/signup` without the `is_admin` flag
- **THEN** the user's `is_admin` column SHALL be `false`

#### Scenario: Admin user creation with service_key
- **WHEN** a user is created via `POST /auth/v1/signup` with `{ is_admin: true }` and the request is authenticated with a `service_role` JWT (service_key)
- **THEN** the user's `is_admin` column SHALL be `true`

#### Scenario: Admin flag ignored without service_key
- **WHEN** a user is created via `POST /auth/v1/signup` with `{ is_admin: true }` and the request is authenticated with an `anon` API key
- **THEN** the `is_admin` flag SHALL be silently ignored and the user's `is_admin` column SHALL be `false`

### Requirement: JWT role reflects admin status

The gateway SHALL issue JWTs with `role: "project_admin"` for users where `internal.users.is_admin = true`. Users where `is_admin = false` SHALL continue to receive `role: "authenticated"`.

#### Scenario: Admin user logs in
- **WHEN** a user with `is_admin = true` authenticates via `POST /auth/v1/token` (password or refresh_token grant)
- **THEN** the returned `access_token` JWT SHALL contain `role: "project_admin"`

#### Scenario: Regular user logs in
- **WHEN** a user with `is_admin = false` authenticates via `POST /auth/v1/token`
- **THEN** the returned `access_token` JWT SHALL contain `role: "authenticated"`

#### Scenario: OAuth callback for admin user
- **WHEN** a user with `is_admin = true` completes an OAuth flow (authorization_code grant)
- **THEN** the returned `access_token` JWT SHALL contain `role: "project_admin"`

### Requirement: Promote and demote user endpoints

The gateway SHALL expose `POST /projects/v1/admin/:id/promote-user` and `POST /projects/v1/admin/:id/demote-user` endpoints, authenticated with `serviceKeyAuth`.

#### Scenario: Promote a user to admin
- **WHEN** an agent calls `POST /projects/v1/admin/:id/promote-user` with `{ email: "user@example.com" }` and a valid service_key
- **THEN** the user's `is_admin` column SHALL be set to `true`
- **THEN** the response SHALL be `200 { status: "promoted", email: "user@example.com" }`

#### Scenario: Promote nonexistent user
- **WHEN** an agent calls `/promote-user` with an email that does not exist in the project
- **THEN** the response SHALL be `404 { error: "User not found" }`

#### Scenario: Demote an admin to regular user
- **WHEN** an agent calls `POST /projects/v1/admin/:id/demote-user` with `{ email: "admin@example.com" }` and a valid service_key
- **THEN** the user's `is_admin` column SHALL be set to `false`
- **THEN** the response SHALL be `200 { status: "demoted", email: "admin@example.com" }`

#### Scenario: Demote nonexistent user
- **WHEN** an agent calls `/demote-user` with an email that does not exist in the project
- **THEN** the response SHALL be `404 { error: "User not found" }`

### Requirement: pre_request() validates project_admin role

The `internal.pre_request()` function SHALL treat `project_admin` JWTs the same as `authenticated` for project-schema validation: the JWT's `project_id` MUST match the accessed schema slot.

#### Scenario: project_admin JWT accesses correct schema
- **WHEN** a request with `role: "project_admin"` and `project_id: "prj_123"` accesses schema `p0042` (which belongs to `prj_123`)
- **THEN** `pre_request()` SHALL allow the request

#### Scenario: project_admin JWT accesses wrong schema
- **WHEN** a request with `role: "project_admin"` and `project_id: "prj_123"` accesses schema `p0099` (which belongs to a different project)
- **THEN** `pre_request()` SHALL raise an exception
