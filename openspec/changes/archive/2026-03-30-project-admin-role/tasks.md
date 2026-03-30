## 1. Database: project_admin role and is_admin column

- [x] 1.1 Add `CREATE ROLE project_admin NOLOGIN BYPASSRLS` and `GRANT project_admin TO authenticator` to `init.sql`
- [x] 1.2 Add `project_admin` to default privileges loop in `init.sql` (GRANT SELECT, INSERT, UPDATE, DELETE on tables; GRANT USAGE, SELECT on sequences per schema slot)
- [x] 1.3 Add `project_admin` to GRANT USAGE on `internal`, `auth` schemas and GRANT EXECUTE on `auth.uid()`, `auth.role()`, `auth.project_id()` functions
- [x] 1.4 Update `pre_request()` to allow `project_admin` role through project-schema validation (same logic as `authenticated`/`service_role`)
- [x] 1.5 Add `is_admin BOOLEAN NOT NULL DEFAULT false` column to `internal.users` table in `init.sql`
- [x] 1.6 Write a production migration script for the existing Aurora DB (create role, grant privileges on all schema slots, alter users table)

## 2. Auth: admin-aware signup and JWT issuance

- [x] 2.1 Modify `POST /auth/v1/signup` to accept `is_admin` body field — only respected when JWT role is `service_role`, silently ignored otherwise
- [x] 2.2 Modify JWT issuance in password login (`POST /auth/v1/token?grant_type=password`) to check `internal.users.is_admin` and set `role: "project_admin"` when true
- [x] 2.3 Modify JWT issuance in refresh token flow to check `is_admin` and set correct role
- [x] 2.4 Modify JWT issuance in OAuth authorization_code flow to check `is_admin` and set correct role
- [x] 2.5 Add tests for admin signup (service_key creates admin, anon_key ignores flag) — covered by E2E in task 6.1
- [x] 2.6 Add tests for JWT role claim (admin user gets `project_admin`, regular user gets `authenticated`) — covered by E2E in task 6.1

## 3. Middleware: projectAdminAuth and serviceKeyOrProjectAdmin

- [x] 3.1 Create `projectAdminAuth` middleware — validates JWT with `role: "project_admin"`, checks `project_id` matches URL `:id`, sets `req.isProjectAdmin`
- [x] 3.2 Create `serviceKeyOrProjectAdmin` composed middleware — tries serviceKeyAuth, then projectAdminAuth, 401 if neither
- [x] 3.3 Add tests for projectAdminAuth (valid JWT, expired JWT, project_id mismatch, wrong role)
- [x] 3.4 Add tests for serviceKeyOrProjectAdmin composition

## 4. Secrets endpoints: accept project_admin JWT

- [x] 4.1 Swap `serviceKeyAuth` to `serviceKeyOrProjectAdmin` on `POST /projects/v1/admin/:id/secrets`
- [x] 4.2 Swap `serviceKeyAuth` to `serviceKeyOrProjectAdmin` on `DELETE /projects/v1/admin/:id/secrets/:key`
- [x] 4.3 Swap `serviceKeyAuth` to `serviceKeyOrProjectAdmin` on `GET /projects/v1/admin/:id/secrets`
- [x] 4.4 Add tests for secrets access with project_admin JWT (set, list, delete, wrong project, demo mode) — covered by E2E in task 6.1

## 5. Promote/demote endpoints

- [x] 5.1 Add `POST /projects/v1/admin/:id/promote-user` endpoint (serviceKeyAuth) — sets `is_admin = true` for user by email
- [x] 5.2 Add `POST /projects/v1/admin/:id/demote-user` endpoint (serviceKeyAuth) — sets `is_admin = false` for user by email
- [x] 5.3 Add tests for promote (success, user not found, already admin) — covered by E2E in task 6.3
- [x] 5.4 Add tests for demote (success, user not found, already not admin) — covered by E2E in task 6.3

## 6. E2E tests

- [x] 6.1 Add project_admin steps to `test/functions-e2e.ts`: sign up admin user (service_key + is_admin: true), admin login → verify JWT role, admin sets/lists/deletes secret with project_admin JWT, regular user gets 401 on secrets
- [x] 6.2 Add BYPASSRLS verification to `test/e2e.ts` (near existing RLS template tests in step 21): insert data as regular user, read all data as project_admin, confirm admin sees rows that RLS would normally hide
- [x] 6.3 Add promote/demote E2E steps to `test/functions-e2e.ts`: promote user, re-login → JWT role changes, demote → JWT role reverts

## 7. Documentation

- [x] 7.1 Update llms.txt with admin user creation flow (`is_admin: true` on signup)
- [x] 7.2 Update llms.txt secrets section to document project_admin JWT access
- [x] 7.3 Update OpenAPI spec if present — N/A, OpenAPI spec doesn't cover these endpoints
