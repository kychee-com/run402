---
title: "Install"
description: "Native MCP reference — installation."
order: 60
---

## Install

Stdio MCP transports must keep stdout reserved for JSON-RPC. Use the package bin (`npx -y run402-mcp`) or `node dist/index.js` from a built checkout. If a host insists on `npm start`, set `npm_config_loglevel=silent`; npm's lifecycle banner is stdout and otherwise appears as non-JSON prelude. The repo `.npmrc` and Docker image set this for source/container hosts.

The server needs Node.js 22.13 or later (the `run` tool strips TypeScript types with Node's own `stripTypeScriptTypes`). It installs as plain JavaScript and WebAssembly: no compiler, no native addon.

**Paying needs the LOCAL server.** An x402 payment is signed with a key, so the wallet-less remote (`mcp.run402.com/mcp`) cannot make one; it can only decode a challenge (`x402_price_check`).

The server acts as the wallet the CLI would pick in its working directory (`RUN402_WALLET`, else the nearest `.run402.json` binding, else the global default). Set `RUN402_WALLET` in the host's server config to pin one.

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
