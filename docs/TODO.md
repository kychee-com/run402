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

**App visibility model — two states:**
- **Private** (default) — deployed, works at its URL, not in gallery, not forkable. Nobody knows about it unless you share the link.
- **Public** (= published) — calling `POST /admin/v1/projects/:id/publish` makes an app public. This takes a snapshot (pg_dump, function source, site files) and lists it in the gallery at `run402.com/apps`. Public apps are automatically forkable. There is no "public but not forkable" state — publishing IS the action that makes an app both visible and forkable.

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

#### Prerequisites [SHIPPED]
- [x] Add `source` column to `internal.functions` — dual-write at deploy time
- [x] Add `ref_count` to `internal.deployments` — site deployment pinning
- [x] Add `postgresql16-client` to Dockerfile — for pg_dump/psql
- [x] v1 support matrix: views, triggers, DB functions, enums, extensions rejected at publish time with clear error
- [ ] Frontend runtime config convention — `window.__RUN402_CONFIG__` injected into `index.html` on fork deploy. Optional for publishers, auto-injected for forkers.

#### Schema export (pg_dump) [SHIPPED]
- [x] `pg_dump` wrapper: pre-data + post-data sections dumped separately
- [x] Schema-name canonicalization: global replace with `__SCHEMA__` placeholder, strip CREATE SCHEMA and GRANT USAGE ON SCHEMA
- [x] Table/sequence grants re-applied after restore (compensates for pg_dump --no-privileges on pre-data)
- [x] Schema restore via `psql` (handles multi-statement pg_dump output correctly)
- [x] Seed data (opt-in): `pg_dump --data-only` for specified tables
- [ ] Round-trip schema fidelity test: create diverse schema → publish → fork → introspect both → compare semantically (tested manually, not yet automated)

#### DB tables [SHIPPED]
- [x] `internal.app_versions` — full metadata + S3 bundle reference + SHA-256
- [x] `internal.app_version_functions` — PRIMARY KEY (version_id, name), CASCADE delete
- [x] `source_version_id` column on `internal.projects` for fork provenance

#### Publish service [SHIPPED]
- [x] `packages/gateway/src/services/publish.ts` — advisory lock, unsupported object validation, pg_dump pre/post, S3 bundle upload with SHA-256, site ref_count pinning, derived min_tier computation
- [x] `POST /admin/v1/projects/:id/publish` (service_key auth)
- [x] `GET /admin/v1/projects/:id/versions` (service_key auth)
- [x] `GET /v1/apps/:versionId` (free, no auth) with fork pricing

#### Fork service [SHIPPED]
- [x] `packages/gateway/src/services/fork.ts` — loads S3 bundle, verifies SHA-256, validates forkability/tier, calls deployBundle(), applies pre/post/seed SQL via psql, re-applies table+sequence grants, records provenance, returns readiness status
- [x] `POST /v1/fork/:tier` (x402-gated, tier-priced)
- [x] x402 config with Bazaar discovery metadata for all tiers
- [x] Derived min_tier from artifact stats
- [x] Idempotency on fork endpoint

#### Tests [SHIPPED]
- [x] `publish.test.ts` — 7 tests: schema canonicalization, derived min_tier
- [x] `fork.test.ts` — 11 tests: request validation, tier ordering
- [x] E2E Step 21: publish workout tracker as public/forkable, verify stats, verify GET /v1/apps
- [x] E2E Step 22: fork via x402 payment, verify schema restored with tables + RLS, verify independence, cleanup
- [x] **Full E2E: 135 passed, 0 failed** on production with real x402 payments

#### Docs [SHIPPED]
- [x] llms.txt: "Publish & Fork" section with publish, inspect, fork examples + readiness statuses + pricing
- [ ] Website: "Fork & Remix" card in feature grid
- [ ] MCP tools: publish_app, list_versions, inspect_app, fork_app (run402-mcp repo)

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

### Agent Allowance — follow-ups

#### Designed but not yet implemented
- [x] Response headers: return `X-Run402-Settlement-Rail` and `X-Run402-Allowance-Remaining` on x402-gated responses. For `allowance_only` accounts with insufficient balance, return 402 with structured `insufficient_allowance` error body including `topup_url` pointing to `https://run402.com/billing?wallet=<address>`
- [ ] Low-balance email alerts: schema fields exist (`low_balance_threshold_usd_micros`, `primary_contact_email` on `billing_accounts`) but no scheduled job to send notifications
- [~] ~~Funding policy UI~~ — removed. The gateway can only debit the allowance; it never touches the user's wallet. On-chain x402 is a separate payment the agent makes independently. The `funding_policy` column is vestigial
- [x] Dashboard/frontend: two-box balance (allowance + on-chain USDC via RPC), fieldset/legend layout, click-to-copy wallet, QR code overlay, humanized ledger labels. Remaining: settings section (email, threshold), ledger pagination, auto-refresh
- [ ] Hold/capture semantics: current implementation does immediate debit — no explicit hold → release/capture phase. Fine for launch since all paid operations are deterministic, but needed for long-running or variable-cost operations

#### Not started
- [ ] Recurring auto-top-ups: Stripe subscriptions as pure funding (not entitlements), auto-credit on renewal
- [ ] Saved payment methods / threshold auto-top-up: save card, define a low-balance threshold, auto-charge when balance drops below it
- [ ] Management tokens: human access to billing account without needing the agent's wallet key (`billing_access_tokens` table)
- [ ] Marketing pages: `/agent-allowance` landing page, wallet vs. allowance comparison page, SEO/AEO content cluster
- [ ] Google Ads campaigns: keyword strategy and RSAs fully designed in `docs/consultations/google-ads-strategy-v2.md`, not yet live
- [ ] MCP tools: `top_up_allowance`, `check_allowance`, `allowance_history` in run402-mcp repo

---

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