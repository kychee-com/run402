# @run402/mcp

MCP server for [Run402](https://run402.com) — provision and manage AI-native Postgres databases from any MCP-compatible client.

## Quick Start

```bash
npx @run402/mcp
```

## Tools

| Tool | Description |
|------|-------------|
| `provision_postgres_project` | Provision a new Postgres database (prototype/hobby/team tier) |
| `run_sql` | Execute SQL (DDL or queries) against a project |
| `rest_query` | Query/mutate data via PostgREST REST API |
| `upload_file` | Upload text content to project storage |
| `renew_project` | Renew a project's database lease |

## Client Configuration

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "run402": {
      "command": "npx",
      "args": ["-y", "@run402/mcp"]
    }
  }
}
```

### Cursor

Add to `.cursor/mcp.json` in your project:

```json
{
  "mcpServers": {
    "run402": {
      "command": "npx",
      "args": ["-y", "@run402/mcp"]
    }
  }
}
```

### Cline

Add to Cline MCP settings:

```json
{
  "mcpServers": {
    "run402": {
      "command": "npx",
      "args": ["-y", "@run402/mcp"]
    }
  }
}
```

### Claude Code

```bash
claude mcp add run402 -- npx -y @run402/mcp
```

## How It Works

1. **Provision** — Call `provision_postgres_project` to create a database. The server handles x402 payment negotiation and stores credentials locally.
2. **Build** — Use `run_sql` to create tables, `rest_query` to insert/query data, and `upload_file` for storage.
3. **Renew** — Call `renew_project` before your lease expires.

### Payment Flow

Provisioning and renewing require x402 micropayments. When payment is needed, tools return payment details (not errors) so the LLM can reason about them and guide the user through payment.

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

## Tiers

| Tier | Price | Lease | Storage | API Calls |
|------|-------|-------|---------|-----------|
| prototype | $0.10 | 7 days | 250 MB | 500K |
| hobby | $5.00 | 30 days | 1 GB | 5M |
| team | $20.00 | 30 days | 10 GB | 50M |

## Development

```bash
# Build
npm run build -w packages/mcp

# Unit tests
npm run test:mcp

# Integration tests (needs running API)
npm run test:mcp:e2e
```

## License

MIT
