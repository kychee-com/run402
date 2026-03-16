# Run402 OpenClaw Skill

This directory contains the [OpenClaw](https://openclaw.ai) skill for Run402 — the standalone, script-based integration that works without an MCP server.

## Installation

In OpenClaw, go to **Settings → Skills → Add from path** and point it at this directory, or copy the contents to `~/.openclaw/skills/run402/`.

```bash
cp -r openclaw ~/.openclaw/skills/run402
cd ~/.openclaw/skills/run402/scripts && npm install
```

## How It Works

Unlike the MCP server (which requires an MCP-compatible client like Claude Desktop or Cursor), this skill calls the Run402 API directly via Node.js scripts — no MCP setup needed.

OpenClaw reads `SKILL.md` and uses it as instructions, then invokes the helper scripts in `scripts/` when needed.

### Scripts

| Script | Description |
|--------|-------------|
| `scripts/allowance.mjs` | Manage your agent allowance (create, fund, status) |
| `scripts/deploy.mjs` | Deploy a full-stack app bundle |
| `scripts/projects.mjs` | Manage projects (list, SQL, REST, renew, delete) |
| `scripts/image.mjs` | Generate images via Run402 |

### Dependencies

Scripts use `@x402/fetch` and `viem` for x402 micropayment handling. Install them once:

```bash
cd scripts && npm install
```

Credentials are shared with the MCP server — both use `~/.config/run402/projects.json` and `~/.config/run402/allowance.json`.

## Quick Start

```bash
# Set up allowance (once)
node scripts/allowance.mjs status
node scripts/allowance.mjs create   # if no allowance yet
node scripts/allowance.mjs fund     # get testnet USDC

# Deploy an app
echo '{"name":"my-app","migrations":"CREATE TABLE todos (id serial PRIMARY KEY, task text)","site":[{"file":"index.html","data":"<!DOCTYPE html><html><body>Hello</body></html>"}]}' \
  | node scripts/deploy.mjs --tier prototype

# Manage projects
node scripts/projects.mjs list
node scripts/projects.mjs sql <project_id> "SELECT * FROM todos"
node scripts/projects.mjs rest <project_id> todos
```

## OpenClaw vs MCP

| | OpenClaw Skill | MCP Server |
|--|----------------|------------|
| **Works with** | OpenClaw | Claude Desktop, Cursor, Cline, Claude Code |
| **Setup** | Copy skill + `npm install` | `npx run402-mcp` |
| **Credentials** | `~/.config/run402/` (shared) | `~/.config/run402/` (shared) |
| **Payment** | Script-based x402 | Built-in x402 handling |
