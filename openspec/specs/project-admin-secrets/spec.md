### Requirement: Secrets endpoints accept project_admin JWT

The secrets management endpoints SHALL accept requests authenticated with a `project_admin` JWT, in addition to the existing `service_key` auth. The JWT's `project_id` claim MUST match the `:id` URL parameter.

#### Scenario: Set secret with project_admin JWT
- **WHEN** a project admin calls `POST /projects/v1/admin/:id/secrets` with `{ key: "AI_API_KEY", value: "sk-..." }` and a valid `project_admin` JWT for that project
- **THEN** the secret SHALL be set and the response SHALL be `201 { status: "set", key: "AI_API_KEY" }`

#### Scenario: List secrets with project_admin JWT
- **WHEN** a project admin calls `GET /projects/v1/admin/:id/secrets` with a valid `project_admin` JWT for that project
- **THEN** the response SHALL include the list of secret keys and hashes (same format as service_key auth)

#### Scenario: Delete secret with project_admin JWT
- **WHEN** a project admin calls `DELETE /projects/v1/admin/:id/secrets/:key` with a valid `project_admin` JWT for that project
- **THEN** the secret SHALL be deleted and the response SHALL be `200 { status: "deleted", key: "..." }`

#### Scenario: project_admin JWT for wrong project
- **WHEN** a project admin calls a secrets endpoint with a `project_admin` JWT whose `project_id` does not match the `:id` URL parameter
- **THEN** the request SHALL be rejected with `401`

#### Scenario: Regular authenticated JWT rejected
- **WHEN** a regular user calls a secrets endpoint with a JWT containing `role: "authenticated"`
- **THEN** the request SHALL be rejected with `401`

#### Scenario: Demo mode still blocks project_admin
- **WHEN** a project admin calls `POST /projects/v1/admin/:id/secrets` on a demo project
- **THEN** the request SHALL be rejected with `403` (demo mode restriction still applies)
