---
title: "Install"
description: "Native MCP reference — installation."
order: 60
---

## Install

Stdio MCP transports must keep stdout reserved for JSON-RPC. Use the package bin (`npx -y run402-mcp`) or `node dist/index.js` from a built checkout. If a host insists on `npm start`, set `npm_config_loglevel=silent`; npm's lifecycle banner is stdout and otherwise appears as non-JSON prelude. The repo `.npmrc` and Docker image set this for source/container hosts.

### `RUN402_MCP_PROFILE=buyer` — 6 tools instead of 198

The full surface is **198 tools (~43,200 tokens)** loaded into your context before the first call. If you only intend to BUY — generate an image for $0.03 — that is a fifth to a third of a context window spent on 191 tools you will never call.

```
RUN402_MCP_PROFILE=buyer npx -y run402-mcp     # 7 tools, ~740 tokens
```

Registers `generate_image` · `init` · `check_balance` · `allowance_status` · `lightning_wallet` · `allowance_export` · `request_faucet` · `redeem_voucher` — enough to bootstrap a wallet, fund it (Base Sepolia faucet, a promo code, or a mainnet address from `allowance_export`), confirm the money landed, and buy.

Use the profile when the task is a purchase. Leave it unset when you may provision, deploy, or manage a project — the other 191 tools are how you do that.

Default is unchanged when unset. An unknown profile name exits 1 listing the known profiles, rather than silently serving the full surface or nothing.

**This must be the LOCAL server.** An x402 payment is signed with a key, so the wallet-less remote (`mcp.run402.com/mcp`) cannot make one — it can only decode a challenge (`x402_price_check`).

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "run402": { "command": "npx", "args": ["-y", "run402-mcp"] }
  }
}
```

### Cursor

Add to `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "run402": { "command": "npx", "args": ["-y", "run402-mcp"] }
  }
}
```

### Cline

Add to your Cline MCP settings (same shape as above).

### Claude Code

```bash
claude mcp add run402 -- npx -y run402-mcp
```

## See also

- Wayfinder: <https://run402.com/llms.txt>
- SDK reference: <https://docs.run402.com/llms-sdk.txt>
- CLI reference: <https://docs.run402.com/llms-cli.txt>
- HTTP API reference: <https://run402.com/llms-full.txt>
- Site: <https://run402.com>

Native PostgREST permission denial is a separate boundary: an exposed table can still reject an operation with HTTP 401/403 and SQLSTATE `42501`. SDK/CLI/MCP label that `REST_PERMISSION_DENIED`, retaining `source: postgrest`, upstream status/code, requested method/relation, and the original body. It does not establish whether grants or RLS caused the denial, and it is not `TABLE_NOT_EXPOSED`.
