## Context

The domains API (`packages/gateway/src/routes/domains.ts`) has four routes. Three require `serviceKeyOrAdmin` middleware; the fourth — `GET /domains/v1/:domain` (status check) — is unauthenticated. This exposes `project_id` and `dns_instructions` to any caller who knows the domain name.

## Goals / Non-Goals

**Goals:**
- Close the auth gap on `GET /domains/v1/:domain` so project-scoped data is only returned to authorized callers.
- Keep the auth pattern consistent across all domain routes.

**Non-Goals:**
- Changing the response shape or adding new fields.
- Adding per-project scoping (verifying the service key belongs to the project that owns the domain). The existing `serviceKeyOrAdmin` middleware is sufficient — it validates the caller has a valid service key or admin credentials, matching the other routes.

## Decisions

**Use `serviceKeyOrAdmin` (not `serviceKeyAuth`).**
The issue suggests `serviceKeyAuth`, but the other three routes use `serviceKeyOrAdmin`. Using the same middleware keeps the auth surface consistent and allows admin callers (dashboard, scripts) to check status without a project service key.

## Risks / Trade-offs

- **[Breaking change for unauthenticated callers]** → Any client polling this endpoint without auth will get 401. Mitigation: the normal flow (MCP server, deploy scripts) already sends the service key. This is intentional — the whole point is to stop unauthenticated access.
- **[No per-project scoping]** → A valid service key from project A can check the domain status of project B. This matches the existing behavior of `GET /domains/v1` (list) and is acceptable for now. Per-project scoping could be added later if needed.
