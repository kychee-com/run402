# Run402 — Remaining TODOs

From GPT-5.2 Pro consultation (2026-02-27) on improving agent trust and adoption.

## Completed

- [x] Fix "No API keys" messaging → "No signup / no dashboards; project keys generated after payment"
- [x] Add "Durability & Ops" and "Project Lifecycle" sections to homepage
- [x] Front-load trust info in llms.txt (IMPORTANT block with infra, backups, lifecycle, key model)
- [x] Add idempotency key support on paid endpoints (Idempotency-Key header, 24h TTL)
- [x] Fix lifecycle mismatch: LEASE_DELETE_PERIOD 30d → 37d (7d grace + 30d archive)
- [x] Require service_key auth on DELETE /v1/projects/:id
- [x] Static site hosting: Vercel-compatible POST /v1/deployments, CloudFront + S3 serving, SPA fallback, deploy_site MCP tool
- [x] MCP server: published as `run402-mcp` on npm (provision, run_sql, rest_query, upload_file, renew_project). Works with Claude Desktop, Cursor, Cline, Claude Code. https://github.com/kychee-com/run402-mcp
- [x] Directory listings: listed on npm, GitHub MCP registry

## Pending

### Static site hosting — follow-ups
- [ ] Production aliases: `prj-xxx.sites.run402.com` pointing to latest `target: "production"` deployment
- [ ] Custom domains: let agents CNAME their own domain to a deployment
- [ ] Deployment listing: `GET /v1/deployments?project=prj_xxx` for listing project deployments

### Self-serve export endpoint
Add `POST /admin/v1/projects/:id/export` that returns a signed URL to a SQL dump of the project's schema and data. This is the biggest trust unlock for agents considering Run402 for non-ephemeral work.

### Project ownership via wallet address
Bind project ownership to payer wallet address. Allow key recovery/rotation via wallet signature challenge. Optional: list projects by wallet (`GET /v1/projects?owner=...` with signature). Makes the no-account model feel safer.

### Split wallet setup into separate doc
Move "Wallet Setup (OpenClaw)" and "Ask Your Human for an Allowance" sections from llms.txt into a separate document (e.g. `/wallets.txt`). Keep llms.txt focused on evaluation, integration, and security.

### Ship OpenAPI spec
Publish an OpenAPI spec at `/openapi.json` for machine-readable API discovery.

### Publish a real status page
Set up status.run402.com (or similar) with uptime tracking over 30/90 days, incident log, and planned maintenance. `/health` is not a status page. Agents evaluate "battle-tested" by looking for measurable uptime artifacts.


Have a Run402 agent that does pre-sale, post-sale, CS, customer success, proactive monitoring...
OpenClaw Skill
Have Claude TRY the different apps
CI CD for everything (add --manual flag to deployment scripts, as the main deployment needs to happen via push)
Offer generous subdomains (cool-name.run402.com)