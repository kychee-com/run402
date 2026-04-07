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

### KMS Contract Wallets

AWS KMS-backed Ethereum wallets per project, for signing smart-contract write transactions. Private keys never leave KMS.

- **$0.04/day** ($1.20/month) per wallet, billed daily as `kms_wallet_rental` ledger entries.
- **$1.20 prepay** (30 days of rent) required at wallet creation.
- **$0.000005 per call** KMS sign fee (the only run402 markup on contract calls).
- **Chain gas at-cost** (0% markup), billed as `contract_call_gas` ledger entries on confirmation.

Wallets that stay suspended (cash balance can't cover rent) for 90 days are permanently deleted (KMS key destroyed). Funds-rescue mechanisms: drain endpoint, recovery address (auto-drain on day-90 deletion), warning emails on days 60/75/88. **Non-custodial** — see https://run402.com/humans/terms.html#non-custodial-kms-wallets.

## MCP Server (Recommended)

If you're running inside Claude Desktop, Cursor, Cline, Claude Code, or any MCP-compatible client, use the MCP server instead of raw HTTP. It handles credential storage, x402 payment negotiation, and response formatting automatically.

- npm: `run402-mcp` (https://github.com/kychee-com/run402-mcp)
- Install: `npx run402-mcp`
- Claude Code: `claude mcp add run402 -- npx -y run402-mcp`

### MCP Tools

The MCP server provides tools across these categories:

| Category | Tools |
|----------|-------|
| Setup & billing | `init`, `set_tier`, `tier_status`, `status`, `check_balance`, `allowance_create`, `allowance_status`, `allowance_export`, `request_faucet`, `create_checkout`, `billing_history`, `create_email_billing_account`, `link_wallet_to_account`, `tier_checkout`, `buy_email_pack`, `set_auto_recharge` |
| Projects | `provision_postgres_project`, `project_info`, `project_keys`, `project_use`, `list_projects`, `get_schema`, `get_usage`, `archive_project`, `pin_project` |
| Database | `run_sql`, `setup_rls`, `rest_query` |
| Deployment | `deploy_site`, `get_deployment`, `bundle_deploy` |
| Subdomains & domains | `claim_subdomain`, `delete_subdomain`, `list_subdomains`, `add_custom_domain`, `list_custom_domains`, `check_domain_status`, `remove_custom_domain` |
| Functions | `deploy_function`, `invoke_function`, `list_functions`, `delete_function`, `get_function_logs`, `update_function`, `set_secret`, `list_secrets`, `delete_secret` |
| Storage | `upload_file`, `download_file`, `list_files`, `delete_file` |
| Apps | `publish_app`, `get_app`, `browse_apps`, `fork_app`, `list_versions`, `update_version`, `delete_version` |
| Email | `create_mailbox`, `send_email`, `list_emails`, `get_email`, `get_mailbox`, `register_sender_domain`, `sender_domain_status`, `remove_sender_domain` |
| Auth (project users) | `request_magic_link`, `verify_magic_link`, `set_user_password`, `auth_settings`, `promote_user`, `demote_user` |
| AI | `ai_translate`, `ai_moderate`, `ai_usage` |
| KMS contract wallets | `provision_contract_wallet` ($0.04/day rental, $1.20 prepay), `get_contract_wallet`, `list_contract_wallets`, `set_recovery_address`, `set_low_balance_alert`, `contract_call` (gas + $0.000005 sign fee), `contract_read`, `get_contract_call_status`, `drain_contract_wallet`, `delete_contract_wallet` |
| Other | `generate_image`, `send_message`, `set_agent_contact`, `get_quote` |

See the [run402-mcp README](https://github.com/kychee-com/run402-mcp) for full tool documentation.

## OpenClaw Skill

Available on ClawHub. Wraps `run402-mcp` and teaches your agent database provisioning, data management, and x402 payments.

```
openclaw install run402
```

## Admin Dashboard (internal, `@kychee.com` only)

The gateway exposes an admin dashboard at `https://api.run402.com/admin` for Kychee operators. Gated by Google OAuth restricted to `@kychee.com`. Not exposed via MCP or CLI.

### Admin pages

| Page | URL | Purpose |
|------|-----|---------|
| Dashboard | `/admin` | Top-level stats: projects, API calls, storage, faucet balance |
| Projects | `/admin/projects` | Table of all projects |
| Subdomains | `/admin/subdomains` | Table of all custom subdomains |
| **Finance** | `/admin/finance` | **Revenue / cost / margin breakdown by project × stream, plus per-category cost with AWS Cost Explorer drift detection. Supports 24h/7d/30d/90d windows and CSV export.** |
| Project detail | `/admin/project/:id` | Per-project finance cards (revenue, direct cost, direct margin) + link to wallet activity |
| Wallet detail | `/admin/wallet/:address` | Per-wallet activity (projects owned, subdomains, topups, ledger) |
| llms.txt analytics | `/admin/llms-txt` | CloudFront access-log analytics |

### Admin Finance API endpoints

All under the existing OAuth gate. Request `Cookie: run402_admin=...` signed with `ADMIN_SESSION_SECRET`.

- `GET /admin/api/finance/summary?window=24h|7d|30d|90d` — platform KPI cards (revenue, cost, margin, cache_age)
- `GET /admin/api/finance/revenue?window=...` — per-project revenue breakdown (tier fees, email packs, KMS rental, KMS sign fees, per-call SKU) + unattributed bucket
- `GET /admin/api/finance/costs?window=...` — per-category cost breakdown with `source: "counter" | "cost_explorer"` + drift reconciliation
- `GET /admin/api/finance/project/:id?window=...` — per-project finance data for the augmented project detail page
- `GET /admin/api/finance/export?scope=platform|project&id=...&window=...&format=csv` — multi-section CSV export
- `POST /admin/api/finance/refresh-costs` — triggers immediate AWS Cost Explorer pull (rate-limited to 1/60s)
- `POST /admin/api/finance/refresh-pricing` — triggers AWS Pricing API pull to refresh the `cost_rates` table

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

### New Feature Release Checklist

When adding a new feature to run402, update ALL of these:

| What | Where | Why |
|------|-------|-----|
| **API docs (agents)** | `site/llms.txt` | Primary docs for AI agents — endpoints, parameters, examples |
| **CLI docs (agents)** | `site/llms-cli.txt` | CLI command reference for AI agents |
| **OpenAPI spec** | `site/openapi.json` | Machine-readable API schema |
| **Changelog (agents)** | `site/updates.txt` | Machine-readable changelog for agents |
| **Changelog (humans)** | `site/humans/changelog.html` | Human-readable changelog |
| **AGENTS.md tool table** | `AGENTS.md` (this file) | MCP tool category table — keep in sync with run402-mcp |
| **MCP tools** | `run402-mcp` repo: `src/tools/`, `src/index.ts` | MCP server tools for agent clients |
| **CLI commands** | `run402-mcp` repo: `cli/lib/`, `cli/cli.mjs` | CLI commands for `run402` npm package |
| **OpenClaw shim** | `run402-mcp` repo: `openclaw/scripts/` | OpenClaw skill re-exports |
| **SKILL.md** | `run402-mcp` repo: `SKILL.md` | OpenClaw tool reference — validates via SKILL.test.ts |
| **README.md** | `run402-mcp` repo: `README.md` | User-facing tool table |
| **Sync test** | `run402-mcp` repo: `sync.test.ts` | Validates MCP/CLI/OpenClaw parity — add to SURFACE array |

**After updating run402-mcp:** Run `/upgrade` to verify sync, then `/publish` to bump version + publish to npm + create GitHub release.

### Testing

| Script | What it tests |
|---|---|
| `npm run test:e2e` | Full lifecycle (tier, project, SQL, RLS, auth, storage, deploy, publish, fork) |
| `npm run test:bld402-compat` | bld402 template compatibility — 3 templates (shared-todo, paste-locker, landing-waitlist). **Run before releasing** to ensure run402 changes don't break bld402.com. |
| `npm run test:functions` | Serverless functions E2E |
| `npm run test:billing` | Billing/Stripe E2E |
| `npm run test:openclaw` | OpenClaw agent E2E |

All E2E tests require `BUYER_PRIVATE_KEY` in `.env` and `BASE_URL` (defaults to localhost).
