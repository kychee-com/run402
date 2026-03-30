## Why

App-level admins (e.g., a community manager set up by an AI agent) cannot manage platform operations like secrets or access all project data from the browser. Today, the only credentials that grant these powers are the `service_key` (server-only) and the provisioning wallet (agent-only). The admin's PostgREST JWT has `role=authenticated`, which is identical to every other user — no elevated data access, no secrets management. This forces apps to either show "run this CLI command" instructions (Wild Lychee #12) or build custom proxy edge functions for every privileged operation.

## What Changes

- Add a `project_admin` Postgres role with `BYPASSRLS` — sits between `authenticated` (RLS-enforced) and `service_role` (god mode). Grants full CRUD on project data but no deploy/SQL powers.
- Add `is_admin BOOLEAN DEFAULT false` column to `internal.users`.
- Extend `POST /auth/v1/signup` to accept `is_admin: true` when called with service_key auth. Ignored when called with anon_key. One API call to create an admin user.
- Issue JWTs with `role: "project_admin"` for admin users instead of `role: "authenticated"`.
- Accept `project_admin` JWTs on the secrets endpoints (`POST/GET/DELETE /projects/v1/admin/:id/secrets`), alongside existing `service_key` auth.
- Add `POST /projects/v1/admin/:id/promote-user` and `/demote-user` endpoints (service_key auth) for post-creation role changes.

## Capabilities

### New Capabilities
- `project-admin-role`: The `project_admin` Postgres role, `is_admin` flag, JWT issuance with admin role, and the promote/demote endpoints.
- `project-admin-secrets`: Accepting `project_admin` JWTs on the secrets management endpoints.

### Modified Capabilities
- `admin-auth`: The `serviceKeyOrProjectAdmin` composed middleware — a new auth gate that accepts either service_key or project_admin JWT.

## Impact

- **Database**: New Postgres role creation in `init.sql`, new column on `internal.users`, updated default privileges per schema slot, updated `pre_request()` function. Existing production DB needs a migration.
- **Auth routes**: `POST /auth/v1/signup` and `POST /auth/v1/token` modified to check `is_admin` and issue correct role.
- **Secrets routes**: Auth middleware swapped from `serviceKeyAuth` to `serviceKeyOrProjectAdmin`.
- **Middleware**: New `projectAdminAuth` middleware and `serviceKeyOrProjectAdmin` composed middleware in `admin-auth.ts` or `apikey.ts`.
- **MCP/llms.txt**: Documentation updated to describe admin user creation flow.
- **Tests**: New tests for admin signup, JWT role, BYPASSRLS behavior, secrets access with admin JWT, promote/demote.
