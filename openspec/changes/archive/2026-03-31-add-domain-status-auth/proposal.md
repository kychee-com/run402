## Why

`GET /domains/v1/:domain` is the only domains endpoint without auth middleware. It exposes `project_id` and `dns_instructions` to anyone who knows the domain name, while all other domain routes (`POST`, `GET` list, `DELETE`) require `serviceKeyOrAdmin`. This is a security gap — project-scoped data should not be freely queryable.

## What Changes

- Add `serviceKeyOrAdmin` middleware to `GET /domains/v1/:domain`, matching the auth pattern used by all other domain routes.
- No behavior change for authenticated callers (agents polling status already have the service key).

## Capabilities

### New Capabilities

- `domain-status-auth`: Auth requirement for the domain status endpoint, scoping access to the owning project's service key or admin credentials.

### Modified Capabilities

_(none — no existing spec requirements change)_

## Impact

- **Code**: `packages/gateway/src/routes/domains.ts` — single middleware addition to the GET `:domain` route.
- **APIs**: `GET /domains/v1/:domain` becomes a 401 for unauthenticated callers. **BREAKING** for any client hitting this endpoint without a service key, though the normal MCP/agent flow already sends one.
- **Tests**: Domain E2E tests may need the service key header on status-check calls.
