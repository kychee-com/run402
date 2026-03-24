## Context

The gateway has four auth mechanisms that evolved independently:

1. **`serviceKeyAuth`** — per-project JWT, used by project owners for admin operations on their project
2. **`walletAuth`** — SIWx signature, used for tier subscription, project creation, bundle deploy
3. **`ADMIN_KEY`** — static secret checked inline in a few routes (billing, faucet, publish)
4. **Google OAuth session** — cookie-based, `@kychee.com` only, used exclusively by the admin dashboard GUI

Admin wallets exist in `internal.admin_wallets` (managed via the dashboard GUI) but are only checked in `walletAuth` for x402 payment bypass — they don't grant admin privileges on other endpoints.

Ownership-gated endpoints (delete project, delete subdomain) only accept `serviceKeyAuth`, meaning they require the project's own service_key. There is no admin override path.

## Goals / Non-Goals

**Goals:**
- A single `adminAuth` middleware that detects admin identity from any of the four mechanisms
- Compose `adminAuth` with existing middleware so endpoints accept either owner auth OR admin auth
- New list endpoints that return identity-scoped results (admin sees all, wallet sees own)
- Admin GUI pages for browsing projects and subdomains with action buttons

**Non-Goals:**
- Replacing existing auth middleware (they stay as-is for non-admin paths)
- Role-based access control beyond admin/non-admin (no "read-only admin" etc.)
- Audit logging of admin actions (useful but separate concern)
- Changes to the `run402-mcp` CLI (follow-up — it already signs with wallet, so admin wallet holders get admin access automatically once the gateway recognizes it)

## Decisions

### 1. Standalone `adminAuth` middleware, composed via `serviceKeyOrAdmin` / `walletAuthOrAdmin`

Create `adminAuth()` middleware that checks in order:
1. `Authorization: Bearer <ADMIN_KEY>` header → admin
2. SIWx header → extract wallet → check `internal.admin_wallets` → admin
3. `run402_admin` session cookie → verify HMAC → admin

If admin, set `req.isAdmin = true` and call `next()`. If not admin, call `next()` without setting the flag (don't reject — let the next middleware try owner auth).

Compose with existing middleware as helper functions:
- `serviceKeyOrAdmin` = try `serviceKeyAuth`, if it fails try `adminAuth`, if both fail → 401
- `walletAuthOrAdmin` = try `walletAuth`, if it fails try `adminAuth`, if both fail → 401

**Why not extend existing middleware:** Each auth mechanism is clean and well-tested. Mixing admin detection into `serviceKeyAuth` would make it harder to reason about. Composition keeps each piece simple.

**Why check in that order:** ADMIN_KEY is cheapest (string compare). SIWx is next (signature verify + DB lookup). Session cookie is last (HMAC verify).

### 2. List endpoints return identity-scoped results

`GET /projects/v1`:
- Admin: returns all projects (with pagination)
- Wallet (via SIWx): returns projects owned by that wallet
- No auth: 401

Same pattern for `GET /subdomains/v1` and `GET /functions/v1`.

**Why not separate admin endpoints:** Keeps the API surface simple. The CLI command `run402 projects list` works for both owners and admins — the gateway decides what to show based on who's asking.

**Why not use existing `GET /wallets/v1/:address/projects`:** That endpoint is address-in-URL, which works for looking up a specific wallet. The new `GET /projects/v1` is "show me what I have access to" — cleaner for CLIs and the admin dashboard.

### 3. Ownership bypass in handlers, not middleware

When `req.isAdmin = true`, the route handler skips ownership checks:

```
// DELETE /subdomains/v1/:name
if (!req.isAdmin) {
  // existing ownership check
}
```

**Why in handlers not middleware:** The ownership logic varies per endpoint (project_id match, wallet match, service_key match). A generic middleware can't know what "ownership" means for each resource. The handler already has this logic — it just needs a bypass gate.

### 4. GUI pages as new routes in admin-dashboard.ts

Add `/admin/projects` and `/admin/subdomains` as server-rendered pages (same pattern as existing `/admin`). They call the new list API endpoints with the session cookie for auth.

Action buttons (delete project, release subdomain) use `fetch()` from the browser calling the same API endpoints with the session cookie.

**Why not a separate SPA:** The existing admin dashboard is server-rendered with a single JS file. Keeping the same pattern avoids a build step and keeps deployment simple (no separate frontend artifact).

### 5. Pagination for list endpoints

All list endpoints use cursor-based pagination with `?limit=` and `?after=` parameters. Default limit: 50, max: 200. Response includes `has_more: boolean` and `next_cursor: string | null`.

**Why cursor not offset:** Projects and subdomains are created/deleted frequently. Offset pagination breaks when rows are inserted/deleted between pages. Cursor (based on `created_at` + `id`) is stable.

## Risks / Trade-offs

- **[Risk] Admin cookie accepted on public API endpoints** → The session cookie is HMAC-signed, `@kychee.com`-restricted, and 7-day expiry. It's as secure as `ADMIN_KEY`. The risk is CSRF — mitigate by requiring `Content-Type: application/json` on mutating requests (browsers don't send JSON bodies in CSRF attacks).
- **[Risk] Admin wallet compromise grants full admin access** → Same risk as today (admin wallets already bypass x402 payments). Mitigate by keeping the admin wallet list small and monitoring it via the dashboard.
- **[Trade-off] No audit log** → Admin actions are logged to CloudWatch (the structured error logging we just added) but there's no dedicated admin audit trail. Acceptable for a 2-person team; revisit if admin access expands.
