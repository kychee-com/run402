# AGENTS.md

## What is Run402?

Run402 is full-stack infrastructure for AI agents: Postgres databases, REST API, auth, file storage, row-level security, static site hosting, serverless functions, and image generation. Pay with x402 USDC micropayments on Base -- no signups, no dashboards, no human approval.

- API: https://api.run402.com
- Docs: https://run402.com/llms.txt
- OpenAPI spec: https://run402.com/openapi.json
- Status: https://run402.com/status/v1.json

## Pay-Per-Tier Model

Run402 uses a tier subscription model. Subscribe once via x402, then create unlimited projects within your tier's limits.

### Quick Start (Agent Onboarding)

1. **Get testnet USDC:** `POST /faucet/v1/drip` (free, 0.25 USDC per 24h)
2. **Subscribe to a tier:** `POST /tiers/v1/prototype` (x402 payment, $0.10)
3. **Create projects:** `POST /projects/v1` with EIP-4361 wallet auth (free with tier)
4. **Deploy apps:** `POST /deploy/v1` with wallet auth (free with tier)

### EIP-4361 Wallet Auth

After subscribing, authenticate with wallet signature headers:
- `X-Run402-Wallet`: your wallet address
- `X-Run402-Signature`: signature of `run402:{unix_timestamp}`
- `X-Run402-Timestamp`: current unix timestamp (seconds)

### Tiers

| Tier | Price | Lease | Storage | API Calls |
|------|-------|-------|---------|-----------|
| prototype | $0.10 | 7 days | 250MB | 500K |
| hobby | $5.00 | 30 days | 1GB | 5M |
| team | $20.00 | 30 days | 10GB | 50M |

### Free Endpoints (with active tier)

Projects, bundle deploy, fork, static sites, messages, ping, contact -- all free once you have an active tier subscription.

### Per-Call Paid Endpoints

Image generation: $0.03/image (always x402, independent of tier).

## MCP Server (Recommended)

If you're running inside Claude Desktop, Cursor, Cline, Claude Code, or any MCP-compatible client, use the MCP server instead of raw HTTP. It handles credential storage, x402 payment negotiation, and response formatting automatically.

- npm: `run402-mcp` (https://github.com/kychee-com/run402-mcp)
- Install: `npx run402-mcp`
- Claude Code: `claude mcp add run402 -- npx -y run402-mcp`

### MCP Tools

| Tool | Description |
|------|-------------|
| `provision_postgres_project` | Create a new Postgres database (prototype/hobby/team tiers) |
| `run_sql` | Execute SQL (DDL/DML) against a project |
| `rest_query` | CRUD via PostgREST (GET/POST/PATCH/DELETE) |
| `upload_file` | Upload files to project storage |
| `set_tier` | Subscribe, renew, or upgrade tier |
| `deploy_site` | Deploy a static site (HTML/CSS/JS) |
| `claim_subdomain` | Claim a custom subdomain (e.g. myapp.run402.com) |
| `delete_subdomain` | Release a subdomain |

## OpenClaw Skill

Available on ClawHub. Wraps `run402-mcp` and teaches your agent database provisioning, data management, and x402 payments.

```
openclaw install run402
```

## Development (Contributing to This Repo)

### Lint & Type Check

Run `npm run lint` and `npx tsc --noEmit -p packages/gateway` before committing gateway changes. ESLint catches style issues but not missing imports or type errors -- only `tsc` catches those.

### Shell Commands

Never use `$()` command substitution or heredocs with `$(cat <<...)` in Bash calls. Instead:
- Run commands separately and use the literal output values in subsequent calls.
- For git commits, use a simple single-line `-m` flag or multiple `-m` flags for multi-line messages.

### Deployment

**Gateway (API):** Push to `main`. The GitHub Action `.github/workflows/deploy-gateway.yml` builds the Docker image, pushes to ECR, and redeploys ECS automatically.

**Site (run402.com):** Push changes under `site/` to `main`. The GitHub Action `.github/workflows/deploy-site.yml` syncs to S3 and invalidates CloudFront.

**Demos:** Each demo under `demos/` has its own `deploy.ts`. Run with `npx tsx demos/<name>/deploy.ts`.

### Testing

| Script | What it tests |
|---|---|
| `npm run test:e2e` | Full lifecycle (tier, project, SQL, RLS, auth, storage, deploy, publish, fork) |
| `npm run test:bld402-compat` | bld402 template compatibility — 3 templates (shared-todo, paste-locker, landing-waitlist). **Run before releasing** to ensure run402 changes don't break bld402.com. |
| `npm run test:functions` | Serverless functions E2E |
| `npm run test:billing` | Billing/Stripe E2E |
| `npm run test:openclaw` | OpenClaw agent E2E |

All E2E tests require `BUYER_PRIVATE_KEY` in `.env` and `BASE_URL` (defaults to localhost).
