# run402 CLI

Command-line interface for [Run402](https://run402.com) — provision Postgres databases, deploy static sites, generate images, and manage agent allowances via x402 micropayments.

## Installation

```bash
npm install -g run402
```

Or run without installing:

```bash
npx run402 <command>
```

## Getting Started

```bash
# 1. Create a local agent allowance
run402 allowance create

# 2. Fund it with test USDC (Base Sepolia faucet)
run402 allowance fund

# 3. Deploy your app
run402 deploy --tier prototype --manifest app.json
```

## Commands

### `run402 allowance`

Manage your local agent allowance.

```bash
run402 allowance create    # Generate a new allowance
run402 allowance status    # Show address, network, funding status
run402 allowance fund      # Request test USDC from the faucet
run402 allowance export    # Print allowance address (for scripting)
```

### `run402 deploy`

Deploy a full-stack app or static site.

```bash
run402 deploy --tier prototype --manifest app.json
run402 deploy --tier hobby --manifest app.json
cat app.json | run402 deploy --tier team
```

**Tiers:** `prototype` | `hobby` | `team`

**Manifest format:**
```json
{
  "name": "my-app",
  "files": {
    "index.html": "<html>...</html>",
    "style.css": "body { margin: 0; }"
  },
  "env": {
    "MY_VAR": "value"
  }
}
```

### `run402 projects`

Manage your deployed projects.

```bash
run402 projects list                              # List all projects
run402 projects sql <id> "SELECT * FROM users"   # Run SQL query
run402 projects rest <id> users "limit=10"       # REST API query
run402 projects usage <id>                        # Compute/storage usage
run402 projects schema <id>                       # Database schema
run402 projects renew <id>                        # Extend lease (pays via x402)
run402 projects delete <id>                       # Delete project
```

### `run402 image`

Generate AI images via x402 micropayments.

```bash
run402 image generate "a startup mascot, pixel art"
run402 image generate "futuristic city at night" --aspect landscape
run402 image generate "portrait of a cat CEO" --aspect portrait --output cat.png
```

**Options:** `--aspect square|landscape|portrait` · `--output <file>`

## Help

Every command supports `--help` / `-h`:

```bash
run402 --help
run402 allowance --help
run402 deploy --help
run402 projects --help
run402 image --help
```

## Notes

- Agent allowance stored at `~/.run402/allowance.json`
- Project credentials stored at `~/.run402/projects.json`
- Network: Base Sepolia (testnet) — USDC for x402 payments
- Payments are handled automatically — no manual signing required

## License

MIT
