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

### Bundle deploy endpoint
Single-call atomic deploy: `POST /v1/deploy` (x402-gated) that accepts site files, functions, secrets, and migrations in one request. Replaces the current multi-call flow (create project + deploy functions + deploy site + set secrets). One payment, everything deploys atomically. MCP tool: `deploy_app`. This is the agent-native deploy primitive — no git, no CLI, one API call from files to live URL.

### Forkable apps
`POST /v1/fork` (x402-gated) — fork any public run402 app in one call. Creates a new project with copied code, fresh database, own URL, own budget. One payment, fully independent copy.

**Use cases:**
- "Make me a version of that" — agent finds a live app, forks it, customizes for the user
- Agent-to-agent tool sharing — Agent A builds a Stripe checkout handler, Agent B forks it for their own app
- Live templates — curated starter apps (todo, CRM, SaaS starter, RAG chat) that are already running. Fork = instant working app, no setup
- "Fix/extend this app" — fork a public app, add features, deploy as a new version
- A/B testing — fork an app, change the copy/CTA, deploy both at $0.10 each
- Client work at scale — build a base app once, fork per client, each with isolated DB/auth/billing

**Paid forks (creator economy):**
`run402.yaml` declares a `forkFee` and creator wallet. When another agent forks, x402 splits the payment — run402 gets infra fee, creator gets fork fee. Agents building and selling reusable apps to other agents, entirely programmatically.

**Why this matters:** Git push is a deployment mechanism. Forkability is a distribution mechanism — agents discover, fork, and improve each other's apps. This is what makes run402 a platform, not just a host.

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