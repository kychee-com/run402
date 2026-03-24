## 1. Admin auth middleware

- [x] 1.1 Create `packages/gateway/src/middleware/admin-auth.ts` with `adminAuth()` middleware — checks ADMIN_KEY header, then SIWx with admin wallet lookup, then session cookie. Sets `req.isAdmin = true` on success, calls `next()` regardless (non-blocking).
- [x] 1.2 Add `serviceKeyOrAdmin` composed middleware — tries `serviceKeyAuth`, on failure tries `adminAuth`, rejects with 401 if neither succeeds
- [x] 1.3 Add `walletAuthOrAdmin` composed middleware — tries `walletAuth`, on failure tries `adminAuth`, rejects with 401 if neither succeeds
- [x] 1.4 Add TypeScript declaration for `req.isAdmin` on the Express Request type

## 2. Admin override on existing endpoints

- [x] 2.1 Update `DELETE /projects/v1/:id` in `routes/projects.ts` — use `serviceKeyOrAdmin` middleware, skip project_id ownership check when `req.isAdmin`
- [x] 2.2 Update `DELETE /subdomains/v1/:name` in `routes/subdomains.ts` — use `serviceKeyOrAdmin` middleware, skip project ownership check when `req.isAdmin`

## 3. List endpoints

- [x] 3.1 Add `GET /projects/v1` in `routes/projects.ts` — `walletAuthOrAdmin` middleware, admin returns all projects, wallet user returns own projects. Cursor pagination with `?limit=&after=`. Include id, name, tier, status, wallet_address, created_at.
- [x] 3.2 Add `GET /subdomains/v1` (list all) in `routes/subdomains.ts` — `walletAuthOrAdmin` middleware, admin returns all, wallet user returns subdomains for their projects. Include name, project_id, deployment_id, created_at, url.
- [x] 3.3 Add `GET /functions/v1` (list all) in `routes/functions.ts` — `walletAuthOrAdmin` middleware, admin returns all, wallet user returns functions for their projects. Include name, project_id, url, created_at.

## 4. Admin GUI pages

- [x] 4.1 Add `/admin/projects` page in `routes/admin-dashboard.ts` — server-rendered table, fetches `GET /projects/v1` with session cookie, delete button per row
- [x] 4.2 Add `/admin/subdomains` page in `routes/admin-dashboard.ts` — server-rendered table, fetches `GET /subdomains/v1` with session cookie, release button per row
- [x] 4.3 Add navigation links to existing `/admin` dashboard for the new pages

## 5. Docs

- [x] 5.1 Update `site/openapi.json` with `GET /projects/v1`, `GET /subdomains/v1`, `GET /functions/v1` and admin auth on `DELETE /projects/v1/:id`, `DELETE /subdomains/v1/:name`
- [x] 5.2 Update `site/llms.txt` with the new list endpoints and admin auth documentation
- [x] 5.3 Update `docs/style.md` auth section to document the admin auth pattern (`serviceKeyOrAdmin`, `walletAuthOrAdmin`)
- [x] 5.4 Run `npm run test:docs` to verify openapi.json ↔ llms.txt ↔ gateway alignment

## 6. Tests

- [x] 6.1 Unit test `adminAuth` middleware — test ADMIN_KEY detection, admin wallet SIWx detection, session cookie detection, non-admin passthrough, detection order (ADMIN_KEY wins over cookie)
- [x] 6.2 Unit test `serviceKeyOrAdmin` — valid service_key works (owner path), ADMIN_KEY works (admin path), neither → 401
- [x] 6.3 Unit test `walletAuthOrAdmin` — valid wallet SIWx works (owner path), ADMIN_KEY works (admin path), neither → 401
- [x] 6.4 E2E test: admin deletes a project they don't own (using ADMIN_KEY), verify 200 and project archived
- [x] 6.5 E2E test: owner deletes their own project with service_key (unchanged behavior), verify still works
- [x] 6.6 E2E test: admin releases a subdomain (using ADMIN_KEY), verify 200 and subdomain gone
- [x] 6.7 E2E test: admin lists all projects, wallet user lists only their own
- [x] 6.8 E2E test: list pagination — create 3 projects, list with `?limit=2`, verify `has_more=true` and `next_cursor`, fetch second page, verify remaining project
- [x] 6.9 E2E test: session cookie auth on `GET /projects/v1` — verify the admin dashboard can call list endpoints with cookie auth (not just ADMIN_KEY)
