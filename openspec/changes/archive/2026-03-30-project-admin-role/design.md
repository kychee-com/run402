## Context

Run402 projects are provisioned by AI agents (Claude Code) using a wallet (SIWx) and managed via a `service_key` JWT. The agent deploys apps and creates end users via `POST /auth/v1/signup`. Today, all end users get JWTs with `role: "authenticated"` — there is no way to distinguish an app admin from a regular user at the platform level.

This means app admins (e.g., a community manager given credentials by the agent) have no elevated access: they can't manage secrets from the browser, and their data access is identical to every other authenticated user. Apps work around this with client-side role checks (easily bypassed) or CLI instructions.

Three Postgres roles exist today:
- `anon` — SELECT only, no auth required
- `authenticated` — full CRUD, RLS enforced
- `service_role` — full CRUD, BYPASSRLS, used by service_key and edge functions

The secrets endpoints (`/projects/v1/admin/:id/secrets`) require `serviceKeyAuth`.

## Goals / Non-Goals

**Goals:**
- App-level admins get elevated data access (BYPASSRLS) via their regular login JWT
- App-level admins can manage secrets from the browser without proxy functions
- Agent creates an admin user in a single API call
- The mechanism works for all Run402 apps, not just Wild Lychee

**Non-Goals:**
- Fine-grained permissions (e.g., "can manage secrets but not delete members") — out of scope, one role fits all for now
- Per-table BYPASSRLS control — Postgres doesn't support this; it's all-or-nothing per role
- Admin dashboard UI — this change is API-only; apps build their own admin UIs
- Multi-admin hierarchies or delegation chains
- Admin access to deploy functions or run arbitrary SQL — those remain service_key only

## Decisions

### 1. New Postgres role: `project_admin` with BYPASSRLS

**Decision:** Create a fourth PostgREST role `project_admin` with NOLOGIN BYPASSRLS, granted SELECT/INSERT/UPDATE/DELETE on all project schema tables.

**Why:** BYPASSRLS is the simplest way to give admins elevated data access without requiring every app to write admin-aware RLS policies. The alternative — a non-BYPASSRLS role with explicit RLS grants — pushes complexity to every app developer and agent.

**Why BYPASSRLS is acceptable:** The service_key (which already lives in every Lambda function's env vars and can be invoked by anyone with the anon_key) has BYPASSRLS. The admin JWT is actually more restricted — it's tied to a specific user, can't deploy code, and can't run SQL. The security ceiling is already set by edge functions.

### 2. `is_admin` flag on `internal.users`, not app-level tables

**Decision:** Store admin status in `internal.users.is_admin` (platform level), not in app tables like `members.role`.

**Why:** The platform issues JWTs. If admin status lived in an app table, the JWT issuance code would need to query arbitrary app schemas to determine the role — coupling the platform to app-specific schema designs. Keeping it in `internal.users` means JWT issuance is a single-table lookup.

### 3. `is_admin` flag on signup with service_key auth gate

**Decision:** Allow `is_admin: true` in the signup body only when the request is authenticated with a service_key. Anon_key requests silently ignore the flag.

**Why not a separate endpoint?** The agent's flow is "create user" — admin or not is just an attribute. A separate `/create-admin` endpoint adds API surface for no benefit. The auth gate (service_key required) prevents privilege escalation from the browser.

**Detection:** The signup endpoint today uses `apikeyAuth` middleware which sets `req.project` but doesn't distinguish anon vs service_role. We need to check the JWT's `role` claim — if `role === "service_role"`, the `is_admin` field is respected.

### 4. Promote/demote as separate endpoints

**Decision:** Add `POST /projects/v1/admin/:id/promote-user` and `/demote-user` for post-creation role changes. Service_key auth only.

**Why:** The agent may need to change admin status after initial setup (revoke a compromised admin, promote a second admin). These are rare operations that don't need to be part of the signup flow.

### 5. Secrets endpoints accept `project_admin` JWT via composed middleware

**Decision:** Create a `serviceKeyOrProjectAdmin` composed middleware. Swap it in on the three secrets endpoints. The project_admin JWT must contain a `project_id` matching the `:id` URL parameter.

**Why not `serviceKeyOrAdmin`?** The existing `serviceKeyOrAdmin` checks for platform admin (ADMIN_KEY / admin wallet / session cookie). `project_admin` is a project-scoped concept — a different auth path. Keeping them separate avoids confusion.

### 6. JWT claim: `role: "project_admin"`

**Decision:** Admin users get `role: "project_admin"` in their JWT. PostgREST uses this to switch to the `project_admin` Postgres role. All other claims (`sub`, `project_id`, `email`) remain the same.

**Alternative considered:** Adding a separate `is_admin: true` claim while keeping `role: "authenticated"`. Rejected because PostgREST role switching is driven by the `role` claim — we'd need custom `pre_request()` logic to override the role based on a secondary claim, which is fragile.

## Risks / Trade-offs

**[BYPASSRLS in browser-held JWT]** → Acceptable because edge functions with service_key already set a higher ceiling. Document in llms.txt that `project_admin` bypasses all RLS policies.

**[XSS amplification]** → An XSS exploit in an admin's session gets BYPASSRLS data access. Mitigation: this is the same risk as any admin session in any web app. Apps should sanitize user content. The JWT still expires in 1 hour.

**[Token validity after demotion]** → A demoted admin's JWT still says `project_admin` until it expires (1 hour). Mitigation: acceptable for v1. Future improvement: add a revocation check in `pre_request()` or shorten admin token TTL.

**[Production DB migration]** → The existing Aurora cluster needs `CREATE ROLE project_admin` and updated default privileges. Mitigation: Run migration SQL via the gateway's init-time migration path or a one-time script. The role creation is additive and non-destructive.

## Migration Plan

1. Add `project_admin` role and grants to `init.sql` (for new DBs)
2. Write a migration script for the existing production DB: create role, grant privileges on all 2000 schema slots, add `is_admin` column
3. Deploy gateway with new auth/JWT logic
4. Update llms.txt and MCP tool descriptions
5. **Rollback:** Drop the `project_admin` role and `is_admin` column. JWTs issued with `role: "project_admin"` will fail PostgREST auth (role doesn't exist) — affected admins need to re-login to get a fresh `authenticated` JWT.

## Open Questions

- Should admin JWT TTL be shorter than 1 hour (the current default for all users)?
- Should `project_admin` be able to call `/promote-user` (allow admins to create other admins), or is that strictly agent-only?
