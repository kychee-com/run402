## Why

Admin operations on Run402 resources (deleting a project, releasing a subdomain) currently require the resource owner's credentials. There is no way for a platform admin to perform these operations — not via the API, not via the CLI, and not via the GUI. When an orphaned subdomain needs releasing or a project needs cleanup, the only option is direct database access via ECS exec.

## What Changes

- Add a standalone `adminAuth` middleware that recognizes admin identity via four mechanisms: `ADMIN_KEY` header, SIWx with an admin wallet, Google OAuth session cookie, or service_key (existing)
- Extend ownership-gated endpoints (`DELETE /projects/v1/:id`, `DELETE /subdomains/v1/:name`) to accept admin auth and bypass ownership checks
- Add new list endpoints that return scoped results based on identity:
  - `GET /projects/v1` — admin sees all projects, wallet user sees their own
  - `GET /subdomains/v1` — admin sees all subdomains, wallet user sees their own
  - `GET /functions/v1` — admin sees all functions, wallet user sees their own
- Add GUI pages to the admin dashboard for browsing and acting on projects and subdomains

## Capabilities

### New Capabilities
- `admin-auth`: Standalone middleware that recognizes admin identity from multiple auth mechanisms and sets `req.isAdmin = true`. Covers the auth detection logic, how it composes with existing middleware, and the identity-based response scoping for list endpoints.
- `admin-operations`: Admin override behavior on existing ownership-gated endpoints (delete project, delete subdomain) and the new list/browse endpoints (projects, subdomains, functions). Covers what admins can do that regular users cannot.

### Modified Capabilities

(none — existing spec-level behavior for regular users is unchanged)

## Impact

- **`packages/gateway/src/middleware/`**: New `admin-auth.ts` middleware
- **`packages/gateway/src/routes/projects.ts`**: `DELETE /projects/v1/:id` accepts admin auth; new `GET /projects/v1` list endpoint
- **`packages/gateway/src/routes/subdomains.ts`**: `DELETE /subdomains/v1/:name` accepts admin auth; new `GET /subdomains/v1` list endpoint (currently exists but is per-project only)
- **`packages/gateway/src/routes/functions.ts`**: New `GET /functions/v1` list endpoint
- **`packages/gateway/src/routes/admin-dashboard.ts`**: New `/admin/projects` and `/admin/subdomains` pages
- **`packages/gateway/src/public/admin-dashboard.js`**: Frontend for new admin pages
- **`site/openapi.json`** and **`site/llms.txt`**: Document new list endpoints
- **MCP server** (`run402-mcp`): May want to add `list_projects`, `list_subdomains` tools in a follow-up
