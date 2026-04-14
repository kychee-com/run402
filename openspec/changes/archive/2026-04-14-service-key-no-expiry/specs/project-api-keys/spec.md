# Spec: project-api-keys

This spec captures the authority model for the two JWTs handed to project owners: `anon_key` and `service_key`. Both are stateless, non-expiring, project-scoped credentials whose runtime authority is bounded by server-side project status, tier lease state, and lifecycle gate checks — **not** by a JWT `exp` claim.

## ADDED Requirements

### Requirement: Project `service_key` JWT SHALL NOT include an `exp` claim

The `service_key` returned by `POST /projects/v1`, `POST /fork/v1`, and any internal re-derivation (bundle deploy, publish, bootstrap invocation) SHALL be a JWT signed with `{ role: "service_role", project_id, iss: "agentdb" }` and no `exp` claim. The JWT SHALL remain valid as long as:
- the signing `JWT_SECRET` is unchanged, AND
- the project referenced by `project_id` is in a status accepted by `isServingStatus` (currently `active`, `past_due`, `frozen`, or `dormant`).

Lease expiration, tier downgrade, lifecycle grace-state transitions, and control-plane gating SHALL be enforced by `apikeyAuth` / `serviceKeyAuth` middleware (via `projectCache` + `isServingStatus`) and by `lifecycleGate`, not by the JWT `exp` claim.

#### Scenario: `POST /projects/v1` returns a `service_key` with no `exp`
- **WHEN** a wallet with an active tier subscription calls `POST /projects/v1`
- **THEN** the response `service_key` SHALL be a valid JWT that decodes with `role === "service_role"`, `project_id === <new project id>`, `iss === "agentdb"`, and **no `exp` field**

#### Scenario: `service_key` remains valid across lease renewals
- **WHEN** a project's wallet tier lease expires and is subsequently renewed (e.g. 40 days after project creation with a 30-day lease)
- **THEN** the `service_key` issued at project creation SHALL continue to authenticate against `serviceKeyAuth` without requiring rotation or redeploy

#### Scenario: `service_key` is rejected for a terminal-status project
- **WHEN** a `service_key` is presented for a project whose status is `purged`, `archived`, or `purging`
- **THEN** `serviceKeyAuth` SHALL return `404 { error: "Project not found or inactive" }` — the rejection comes from the status check, not from JWT verification

#### Scenario: `service_key` is accepted for a grace-state project on data-plane routes
- **WHEN** a `service_key` is presented for a project in `past_due`, `frozen`, or `dormant` status on a data-plane route (e.g. `GET /rest/v1/*`)
- **THEN** `serviceKeyAuth` SHALL accept the key and the request SHALL proceed (no `exp`-based rejection)

#### Scenario: `service_key` is rejected on control-plane writes to a `frozen` project
- **WHEN** a `service_key` is presented for a `frozen` project on a control-plane mutating route (e.g. `POST /functions/v1`)
- **THEN** `lifecycleGate` (running after `serviceKeyAuth`) SHALL reject with `402`, regardless of JWT `exp` state

### Requirement: Project `anon_key` JWT SHALL NOT include an `exp` claim

The `anon_key` returned by project-creating endpoints SHALL be a JWT signed with `{ role: "anon", project_id, iss: "agentdb" }` and no `exp` claim. This requirement codifies the behavior already in place since commit `54379423` (2026-03-17).

#### Scenario: `POST /projects/v1` returns an `anon_key` with no `exp`
- **WHEN** a wallet calls `POST /projects/v1`
- **THEN** the returned `anon_key` SHALL decode with no `exp` field

### Requirement: `service_key` revocation is the operator's responsibility

The platform SHALL NOT auto-revoke `service_key` JWTs via time-based expiration. Leaked or otherwise-compromised keys SHALL be handled out-of-band by the owner (via project deletion or — future — a dedicated rotation endpoint). The shared `JWT_SECRET` SHALL remain the only platform-wide revocation mechanism until per-project `kid`-based revocation is introduced in a future change.

#### Scenario: Operator suspects a leaked key
- **WHEN** a project owner reports a leaked `service_key`
- **THEN** the operator's mitigations are: (a) delete the project (terminal, destroys data), (b) wait for a future rotation endpoint, or (c) request platform-wide `JWT_SECRET` rotation (breaks every project on the platform)
- **AND** the JWT `exp` claim SHALL NOT be relied upon as a revocation mechanism
