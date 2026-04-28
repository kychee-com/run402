<p align="center">
  <img src=".github/logo.svg" width="120" alt="run402 logo">
</p>

<h1 align="center">run402 — SDK, MCP Server, CLI & OpenClaw Skill</h1>

[![Tests](https://github.com/kychee-com/run402/actions/workflows/test.yml/badge.svg)](https://github.com/kychee-com/run402/actions/workflows/test.yml)
[![CodeQL](https://github.com/kychee-com/run402/actions/workflows/codeql.yml/badge.svg)](https://github.com/kychee-com/run402/actions/workflows/codeql.yml)
[![npm: run402-mcp](https://img.shields.io/npm/v/run402-mcp?label=run402-mcp)](https://www.npmjs.com/package/run402-mcp)
[![npm: run402](https://img.shields.io/npm/v/run402?label=run402)](https://www.npmjs.com/package/run402)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

Developer tools for [Run402](https://run402.com) — provision Postgres databases, deploy static sites, serverless functions, generate images, and manage agent allowances. Available as a typed TypeScript SDK, an MCP server, an OpenClaw skill, and a CLI.

English | [简体中文](./README.zh-CN.md)

## Integrations

| Interface | Use when... |
|-----------|-------------|
| [`sdk/`](./sdk/) (`@run402/sdk`) | Calling run402 from code — inside user-deployed functions, custom agents, or future code-mode sandboxes |
| [`cli/`](./cli/) | Terminal, scripts, CI/CD |
| [`openclaw/`](./openclaw/) | OpenClaw agent (no MCP required) |
| MCP server (this package) | Claude Desktop, Cursor, Cline, Claude Code |

## SDK

```bash
npm install @run402/sdk
```

Two entry points: `@run402/sdk` (isomorphic — works in Node 22, Deno, Bun, V8 isolates) and `@run402/sdk/node` (zero-config Node defaults: keystore + allowance + x402):

```ts
import { run402 } from "@run402/sdk/node";

const r = run402();
const project = await r.projects.provision({ tier: "prototype" });
await r.blobs.put(project.project_id, "hello.txt", { content: "hi" });
await r.sites.deploy(project.project_id, {
  files: [{ file: "index.html", data: "<h1>hello</h1>" }],
});
```

17 namespaces: `projects`, `blobs`, `functions`, `secrets`, `subdomains`, `domains`, `sites`, `service`, `tier`, `allowance`, `ai`, `auth`, `senderDomain`, `billing`, `apps`, `email` (+ `webhooks`), `contracts`, `admin`.

All failures throw typed errors (`PaymentRequired`, `ProjectNotFound`, `Unauthorized`, `ApiError`, `NetworkError`). See [`sdk/README.md`](./sdk/README.md) for details.

## Quick Start

```bash
npx run402-mcp
```

## MCP Tools

| Tool | Description |
|------|-------------|
| `provision_postgres_project` | Provision a Postgres database. Handles x402 payment. Saves credentials locally. |
| `run_sql` | Execute SQL (DDL or queries). Returns markdown table. |
| `rest_query` | Query/mutate via PostgREST. GET/POST/PATCH/DELETE with query params. |
| `setup_rls` | Apply row-level security templates to tables. |
| `get_schema` | Introspect database schema — tables, columns, types, constraints, RLS policies. |
| `get_usage` | Get project usage report — API calls, storage, limits, lease expiry. |
| `deploy_function` | Deploy a serverless function (Node 22) to a project. |
| `invoke_function` | Invoke a deployed function via HTTP. |
| `get_function_logs` | Get recent logs from a deployed function. |
| `list_functions` | List all deployed functions for a project. |
| `delete_function` | Delete a deployed function. |
| `set_secret` | Set a project secret. Injected as process.env in functions. |
| `list_secrets` | List secret keys for a project (values not shown). |
| `delete_secret` | Delete a secret from a project. |
| `deploy_site` | Deploy static site. Free with active tier. Returns live URL. |
| `claim_subdomain` | Claim custom subdomain (e.g. myapp.run402.com). Free. |
| `delete_subdomain` | Release a subdomain. |
| `list_subdomains` | List all subdomains claimed by a project. |
| `bundle_deploy` | One-call full-stack deploy: database + migrations + RLS + secrets + functions + site + subdomain. |
| `browse_apps` | Browse public apps available for forking. |
| `fork_app` | Fork a published app into a new project. |
| `publish_app` | Publish a project as a forkable app. |
| `list_versions` | List published versions of a project. |
| `get_quote` | Get tier pricing. Free, no auth required. |
| `set_tier` | Subscribe, renew, or upgrade tier. Auto-detects action. Handles x402 payment. |
| `delete_project` | Immediately and irreversibly delete a project (cascade purge) and remove from local key store. |
| `check_balance` | Check billing account balance for an agent allowance address. |
| `list_projects` | List all active projects for an agent allowance address. |
| `allowance_status` | Check local agent allowance status — address, network, funding. |
| `allowance_create` | Create a new local agent allowance (Base Sepolia testnet). |
| `allowance_export` | Export the local agent allowance address. |
| `request_faucet` | Request free testnet USDC from the Run402 faucet. |
| `generate_image` | Generate a PNG image from a text prompt. $0.03 via x402. |
| `create_mailbox` | Create an email mailbox for a project (`slug@mail.run402.com`). |
| `send_email` | Send email — template or raw HTML mode. Single recipient. |
| `list_emails` | List sent emails from the project's mailbox. |
| `get_email` | Get a specific email message with replies. |
| `get_email_raw` | Get raw RFC-822 bytes of an inbound message (base64). For DKIM/zk-email verification. |
| `get_mailbox` | Get the project's mailbox info. |
| `promote_user` | Promote a project user to admin role. |
| `demote_user` | Demote a project user from admin role. |
| `ai_translate` | Translate text via AI (OpenRouter). Metered per project. |
| `ai_moderate` | Moderate text via AI (OpenAI). Free. |
| `ai_usage` | Check AI translation usage and quota. |
| `add_custom_domain` | Add a custom domain to a subdomain (Cloudflare SSL). |
| `list_custom_domains` | List custom domains for a project. |
| `check_domain_status` | Check custom domain verification status. |
| `remove_custom_domain` | Remove a custom domain. |
| `request_magic_link` | Send a passwordless login email (magic link). |
| `verify_magic_link` | Exchange a magic link token for access + refresh tokens. |
| `set_user_password` | Change, reset, or set a user's password. |
| `auth_settings` | Update project auth settings (e.g., allow_password_set). |
| `register_sender_domain` | Register a custom email sending domain (DKIM verification). |
| `sender_domain_status` | Check sender domain verification status. |
| `remove_sender_domain` | Remove a custom sender domain. |
| `create_email_billing_account` | Create a Stripe-only billing account by email (no wallet required). |
| `link_wallet_to_account` | Link a wallet to an email account for hybrid Stripe + x402 access. |
| `tier_checkout` | Subscribe/renew/upgrade to a tier via Stripe (alternative to x402). |
| `buy_email_pack` | Buy a $5 email pack (10,000 emails, never expire). |
| `set_auto_recharge` | Enable/disable auto-recharge for email packs when credits run low. |
| `provision_contract_wallet` | Provision an AWS KMS-backed Ethereum wallet ($0.04/day rental, $1.20 prepay required). |
| `get_contract_wallet` | Get a KMS contract wallet's metadata + live native balance. |
| `list_contract_wallets` | List KMS contract wallets owned by the project. |
| `set_recovery_address` | Set/clear the optional recovery address for auto-drain on day-90 deletion. |
| `set_low_balance_alert` | Set the low-balance alert threshold (in wei). |
| `contract_call` | Submit a smart-contract write call (chain gas + $0.000005 KMS sign fee). |
| `contract_read` | Read-only smart-contract call (free, no signing). |
| `get_contract_call_status` | Look up a contract call by ID — status, gas, receipt. |
| `drain_contract_wallet` | Drain native balance to a destination address (works on suspended wallets). |
| `delete_contract_wallet` | Schedule the KMS key for deletion (refused if balance ≥ dust). |

## Client Configuration

### CLI

A standalone CLI is available in the [`cli/`](./cli/) directory.

```bash
npm install -g run402

run402 allowance create
run402 allowance fund
run402 deploy --tier prototype --manifest app.json
```

See [`cli/README.md`](./cli/README.md) for full usage.

### OpenClaw

A standalone skill is available in the [`openclaw/`](./openclaw/) directory — no MCP server required. It calls the Run402 API directly via Node.js scripts.

```bash
cp -r openclaw ~/.openclaw/skills/run402
cd ~/.openclaw/skills/run402/scripts && npm install
```

See [`openclaw/README.md`](./openclaw/README.md) for details.

### MCP Clients

#### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "run402": {
      "command": "npx",
      "args": ["-y", "run402-mcp"]
    }
  }
}
```

#### Cursor

Add to `.cursor/mcp.json` in your project:

```json
{
  "mcpServers": {
    "run402": {
      "command": "npx",
      "args": ["-y", "run402-mcp"]
    }
  }
}
```

#### Cline

Add to Cline MCP settings:

```json
{
  "mcpServers": {
    "run402": {
      "command": "npx",
      "args": ["-y", "run402-mcp"]
    }
  }
}
```

#### Claude Code

```bash
claude mcp add run402 -- npx -y run402-mcp
```

## How It Works

1. **Provision** — Call `provision_postgres_project` to create a database. The server handles x402 payment negotiation and stores credentials locally.
2. **Build** — Use `run_sql` to create tables, `rest_query` to insert/query data, and `blob_put` for storage.
3. **Deploy** — Use `deploy_site` for static sites, `deploy_function` for serverless functions, or `bundle_deploy` for a full-stack app in one call.
4. **Renew** — Call `set_tier` before your lease expires.

### Payment Flow

The prototype tier is free — it uses testnet USDC to test the x402 payment flow end-to-end (no real money). Hobby and team tiers, renewals, and image generation require real x402 micropayments (USDC on Base or Stripe credits). When payment is needed, tools return payment details (not errors) so the LLM can reason about them and guide the user through payment.

### Key Storage

Project credentials are saved to `~/.config/run402/projects.json` with `0600` permissions. Each project stores:
- `anon_key` — for public-facing queries (respects RLS)
- `service_key` — for admin operations (bypasses RLS)
- `tier` — prototype, hobby, or team
- `expires_at` — lease expiration timestamp

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `RUN402_API_BASE` | `https://api.run402.com` | API base URL |
| `RUN402_CONFIG_DIR` | `~/.config/run402` | Config directory for key storage |
| `RUN402_ALLOWANCE_PATH` | `{config_dir}/allowance.json` | Custom allowance (wallet) file path |

## Development

```bash
npm run build          # tsc → dist/
npm test               # all tests (SKILL + sync + unit)
npm run test:sync      # check MCP/CLI/OpenClaw stay in sync
npm run test:skill     # validate SKILL.md structure
```

## License

MIT
