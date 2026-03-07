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

### Bundle deploy endpoint [SHIPPED]
Single-call atomic deploy: `POST /v1/deploy/:tier` (x402-gated) that accepts site files, functions, secrets, and migrations in one request. One payment, everything deploys atomically. MCP tool: `deploy_app` (pending — MCP repo). 31 unit tests + E2E Step 20. Live on production.
- [ ] MCP tool `deploy_app` in run402-mcp repo

---

### Publish & Fork — Implementation Plan

**Vision:** Agents publish app versions as forkable artifacts. Other agents fork them in one x402 call to get their own independent copy with fresh backend, budget, and URL.

**Use cases:**
- "Make me a version of that" — agent finds a live app, forks it, customizes for the user
- Agent-to-agent tool sharing — Agent A builds a Stripe checkout handler, Agent B forks it for their own app
- Live templates — curated starter apps (todo, CRM, SaaS starter, RAG chat) that are already running. Fork = instant working app, no setup
- "Fix/extend this app" — fork a public app, add features, deploy as a new version
- A/B testing — fork an app, change the copy/CTA, deploy both at $0.10 each
- Client work at scale — build a base app once, fork per client, each with isolated DB/auth/billing
- Paid forks (later) — `run402.yaml` declares a `forkFee` and creator wallet, x402 splits payment

**Architecture:**
```
Agent builds app → POST /admin/v1/projects/:id/publish → snapshots state via pg_dump
  → Bundles pre/post schema SQL + seed + function source + site manifest into S3
  → Stores metadata in internal.app_versions → returns version ID

Other agent → POST /v1/fork/:tier { version_id, name }
  → Loads bundle from S3 → converts to bundle deploy request
  → Calls existing deployBundle() orchestrator (same code path as POST /v1/deploy)
  → Applies post_schema_sql (indexes, RLS) → injects runtime config → returns credentials
```

Key principle: **fork reuses the bundle deploy orchestrator**. No second deploy engine.

#### Prerequisites
- [ ] Add `source` column to `internal.functions` — store raw source at deploy time, dual-write alongside Lambda deploy. Legacy functions without source are not publishable.
- [ ] Add `ref_count` to `internal.deployments` — site deployment pinning. Increment on publish, decrement on version deletion. GC skips pinned deployments.
- [ ] Add `postgresql16-client` to Dockerfile — for `pg_dump` (schema export)
- [ ] Define v1 support matrix — what's publishable and what's rejected (tables, FKs, indexes, RLS, SERIAL/IDENTITY = yes; views, triggers, DB functions, enums, extensions = no, reject at publish with clear error)
- [ ] Frontend runtime config convention — `window.__RUN402_CONFIG__` injected into `index.html` on fork deploy with apiUrl, anonKey, projectId. Optional for publishers, auto-injected for forkers.

#### Schema export (pg_dump)
- [ ] `pg_dump` wrapper: dump `--section=pre-data` and `--section=post-data` separately
- [ ] Schema-name canonicalization: replace `p0042` with `__SCHEMA__` placeholder, restore replaces with target schema
- [ ] Seed data (opt-in): `pg_dump --data-only` for specified tables + `setval()` for sequences
- [ ] Round-trip fidelity test: create diverse schema → publish → fork → introspect both → compare semantically

#### DB tables
- [ ] `internal.app_versions` — metadata: id, project_id, version, name, description, visibility (private/unlisted/public), fork_allowed, status (published/disabled), min_tier, derived_min_tier, format_version, bundle_uri (S3), bundle_sha256, publisher_wallet, required_secrets (JSONB), required_actions (JSONB), capabilities (JSONB), stats (table/function/site counts + sizes), site_deployment_id, created_at
- [ ] `internal.app_version_functions` — PRIMARY KEY (version_id, name), source, runtime, timeout, memory, deps, code_hash. CASCADE delete on version removal.
- [ ] Add `source_version_id` column to `internal.projects` for fork provenance tracking

#### Publish service
- [ ] `packages/gateway/src/services/publish.ts` — acquire project-level advisory lock, validate (active project, all functions have source, no unsupported objects), run pg_dump pre/post, build bundle.json, upload to S3 with SHA-256, insert DB rows, increment site ref_count, return version + compatibility report
- [ ] `POST /admin/v1/projects/:id/publish` (service_key auth) — body: { visibility?, fork_allowed?, description?, include_seed?: { tables: string[] }, required_secrets?: [...], required_actions?: [...] }
- [ ] `GET /admin/v1/projects/:id/versions` (service_key auth) — list versions
- [ ] `GET /v1/apps/:versionId` (free, no auth) — public app info: name, description, stats, required secrets/actions, effective_min_tier, fork price by tier

#### Fork service
- [ ] `packages/gateway/src/services/fork.ts` — load version metadata + S3 bundle, verify SHA-256, validate (fork_allowed, visibility, tier >= effective_min_tier), build bundle deploy request, call deployBundle(), apply post_schema_sql, apply seed_sql, inject __RUN402_CONFIG__ into index.html, record source_version_id, return credentials + missing_secrets + required_actions + readiness status (ready / configuration_required / manual_setup_required)
- [ ] `POST /v1/fork/:tier` (x402-gated, tier-priced) — body: { version_id, name, subdomain? }
- [ ] x402 config: same pricing as project creation per tier, Bazaar discovery metadata
- [ ] Derived min_tier: compute from artifact stats (function count, site size) — `effective_min_tier = max(derived, publisher)`
- [ ] Idempotency on fork endpoint

#### Tests
- [ ] `publish.test.ts` — unsupported object rejection, required_secrets explicit not auto-snapshotted, derived_min_tier computation, schema placeholder replacement, bundle SHA-256 verification
- [ ] `fork.test.ts` — reject private version, reject below min_tier, reject disabled version, request shape validation, readiness status logic
- [ ] E2E Step 22: publish workout tracker project as public/forkable, verify version returned with correct stats, verify GET /v1/apps/:versionId
- [ ] E2E Step 23: fork via x402 payment, verify new project with tables + RLS, insert data, verify independence, cleanup
- [ ] Round-trip schema fidelity: create → publish → fork → introspect both → compare

#### Docs & website
- [ ] llms.txt: "Publish & Fork" section with publish, inspect, fork examples
- [ ] Website: "Fork & Remix" card in feature grid, fork flow in "How it works"
- [ ] MCP tools: publish_app, list_versions, inspect_app, fork_app (run402-mcp repo)

#### Implementation order
1. Define v1 support matrix
2. Add `source` column to `internal.functions` + dual-write
3. Add `ref_count` to `internal.deployments`
4. Add `postgresql16-client` to Dockerfile
5. Create `internal.app_versions` + `internal.app_version_functions` tables (init on startup)
6. Build schema export (pg_dump wrapper + pre/post split + placeholder replacement)
7. Build publish service + route + unit tests
8. Build fork service (converts bundle → calls deployBundle()) + route + unit tests
9. x402 config + idempotency + server.ts wiring
10. E2E tests (publish + fork + round-trip fidelity)
11. llms.txt + website
12. Deploy to ECS

#### NOT in v1
- Paid creator fees / revenue split
- Fork graph visualization
- Public search/browse API
- `/.well-known/run402-app.json` auto-generation
- Bazaar listing integration for published apps
- Storage file copying (site files only, no object storage)
- Upstream update notifications ("new version available")
- Views, triggers, DB functions/procedures, enums, extensions support
- Async fork (202 + operation ID) — keep sync, add async when needed
- `run402.yaml` manifest file convention
- Content-addressed site blobs / deduplication

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


### Storytelling & Narrative
The value of software has moved up the chain. Code is cheap — agents write it in minutes. The hard part is deployment, infrastructure, and getting a complete app live. We need new language for this:

1. **"Agents need an allowance"** — the core human story. Your agent can build anything, but it needs permission to spend. The allowance model (fund a wallet, set a cap) is the unlock. This is the bridge between human trust and agent autonomy.

2. **"InfraFork"** — forking code is old (GitHub). We fork *complete running applications* — code + database + auth + storage + functions + budget. This is a new primitive. GitHub forks copy source. InfraFork copies infrastructure. Maybe we need new verbs: `infrafork`, `appfork`, or just own "fork" in the agent context.

3. **Software is cheap, infrastructure is the product** — agents commoditized code. The value moved to: can you deploy it? can you run it? can you pay for it? can you fork a live app and have your own copy in seconds? That's the run402 story.

Explore: do we need new vocabulary? "InfraFork" vs "fork" vs "clone" vs "remix". What resonates with the agent ecosystem? What do humans understand?

Have a Run402 agent that does pre-sale, post-sale, CS, customer success, proactive monitoring...
OpenClaw Skill
Have Claude TRY the different apps
CI CD for everything (add --manual flag to deployment scripts, as the main deployment needs to happen via push)
Offer generous subdomains (cool-name.run402.com)