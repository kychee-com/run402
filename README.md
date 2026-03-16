<p align="center">
  <img src=".github/logo.svg" width="120" alt="run402 logo">
</p>

<h1 align="center">run402 — MCP Server, CLI & OpenClaw Skill</h1>

[![Tests](https://github.com/kychee-com/run402/actions/workflows/test.yml/badge.svg)](https://github.com/kychee-com/run402/actions/workflows/test.yml)
[![CodeQL](https://github.com/kychee-com/run402/actions/workflows/codeql.yml/badge.svg)](https://github.com/kychee-com/run402/actions/workflows/codeql.yml)
[![npm: run402-mcp](https://img.shields.io/npm/v/run402-mcp?label=run402-mcp)](https://www.npmjs.com/package/run402-mcp)
[![npm: run402](https://img.shields.io/npm/v/run402?label=run402)](https://www.npmjs.com/package/run402)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

Developer tools for [Run402](https://run402.com) — provision Postgres databases, deploy static sites, serverless functions, generate images, and manage agent allowances. Available as an MCP server, an OpenClaw skill, and a CLI.

English | [简体中文](./README.zh-CN.md)

## Integrations

| Interface | Use when... |
|-----------|-------------|
| [`cli/`](./cli/) | Terminal, scripts, CI/CD |
| [`openclaw/`](./openclaw/) | OpenClaw agent (no MCP required) |
| MCP server (this package) | Claude Desktop, Cursor, Cline, Claude Code |

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
| `upload_file` | Upload text content to project storage. |
| `download_file` | Download a file from project storage. |
| `delete_file` | Delete a file from project storage. |
| `list_files` | List files in a storage bucket. |
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
| `archive_project` | Archive a project and remove from local key store. |
| `check_balance` | Check billing account balance for an agent allowance address. |
| `list_projects` | List all active projects for an agent allowance address. |
| `allowance_status` | Check local agent allowance status — address, network, funding. |
| `allowance_create` | Create a new local agent allowance (Base Sepolia testnet). |
| `allowance_export` | Export the local agent allowance address. |
| `request_faucet` | Request free testnet USDC from the Run402 faucet. |
| `generate_image` | Generate a PNG image from a text prompt. $0.03 via x402. |

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
2. **Build** — Use `run_sql` to create tables, `rest_query` to insert/query data, and `upload_file` for storage.
3. **Deploy** — Use `deploy_site` for static sites, `deploy_function` for serverless functions, or `bundle_deploy` for a full-stack app in one call.
4. **Renew** — Call `set_tier` before your lease expires.

### Payment Flow

Provisioning, renewing, site deployment, bundle deploy, and image generation require x402 micropayments. When payment is needed, tools return payment details (not errors) so the LLM can reason about them and guide the user through payment.

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

## Development

```bash
npm run build          # tsc → dist/
npm test               # all tests (SKILL + sync + unit)
npm run test:sync      # check MCP/CLI/OpenClaw stay in sync
npm run test:skill     # validate SKILL.md structure
```

## License

MIT
