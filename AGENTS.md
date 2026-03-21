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

1. **Get testnet USDC:** `POST /faucet/v1` (free, 0.25 USDC per 24h)
2. **Subscribe to a tier:** `POST /tiers/v1/prototype` (x402 payment, $0.10)
3. **Create projects:** `POST /projects/v1` with EIP-4361 wallet auth (free with tier)
4. **Deploy apps:** `POST /deploy/v1` with wallet auth (free with tier)

### SIWX (CAIP-122) Wallet Auth

After subscribing, authenticate with a SIWX (Sign-In-With-X) header:
- `SIGN-IN-WITH-X`: base64-encoded CAIP-122 payload signed by your wallet

See https://run402.com/llms.txt for the full SIWX auth specification and examples.

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

### MCP Tools (52 tools)

The MCP server provides 52 tools across these categories:

| Category | Tools |
|----------|-------|
| Setup & billing | `init`, `set_tier`, `tier_status`, `status`, `check_balance`, `allowance_create`, `allowance_status`, `allowance_export`, `request_faucet`, `create_checkout`, `billing_history` |
| Projects | `provision_postgres_project`, `project_info`, `project_keys`, `project_use`, `list_projects`, `get_schema`, `get_usage`, `archive_project`, `pin_project` |
| Database | `run_sql`, `setup_rls`, `rest_query` |
| Deployment | `deploy_site`, `get_deployment`, `bundle_deploy` |
| Subdomains | `claim_subdomain`, `delete_subdomain`, `list_subdomains` |
| Functions | `deploy_function`, `invoke_function`, `list_functions`, `delete_function`, `get_function_logs`, `set_secret`, `list_secrets`, `delete_secret` |
| Storage | `upload_file`, `download_file`, `list_files`, `delete_file` |
| Apps | `publish_app`, `get_app`, `browse_apps`, `fork_app`, `list_versions`, `update_version`, `delete_version` |
| Other | `generate_image`, `send_message`, `set_agent_contact`, `get_quote` |

See the [run402-mcp README](https://github.com/kychee-com/run402-mcp) for full tool documentation.

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
