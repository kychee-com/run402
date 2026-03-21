# Consultation Result

**Model**: gpt-5.4-pro
**Submitted**: 2026-03-14T23:11:52.659963
**Completed**: 2026-03-14T23:26:30.987871
**Status**: completed

---

**Implementation status:** [FUTURE] — The optimized llms-cli.txt has not been adopted yet. The current llms-cli.txt works but hasn't been replaced with this token-optimized version.

Below is a drop-in replacement for `site/llms-cli.txt`, optimized for agent use while keeping full CLI coverage.

````markdown
# Run402 CLI for AI agents

Install: `npm install -g run402`  
Docs: https://run402.com/llms-cli.txt  
API docs: https://run402.com/llms.txt  
Operator: Kychee LLC  
Terms: https://run402.com/humans/terms.html  
Contact: `run402 message send "your message"`

Run402 CLI manages a local EVM wallet and x402 USDC billing automatically. It provisions Postgres + PostgREST, auth, RLS, storage, static sites, Node 22 functions, subdomains, app forks, and image generation. No signup, dashboard, API keys, or manual signing.

## Default workflow

Requires Node.js >= 20. Prefer bundle deploy unless you need manual control.

1. `npm install -g run402`
2. `run402 init`
3. `run402 tier set prototype`
4. `run402 deploy --manifest app.json`

`run402 init` creates a wallet if needed, checks balance, requests free Base Sepolia USDC from the faucet if empty, and shows tier/projects.  
`run402 tier set <prototype|hobby|team>` subscribes, renews, upgrades, or downgrades automatically from wallet state; proration is applied when relevant, and downgrades require usage to fit.

Minimal `app.json`:

```json
{
  "name": "my-app",
  "migrations": "CREATE TABLE items (id serial PRIMARY KEY, title text NOT NULL, done boolean DEFAULT false); INSERT INTO items (title) VALUES ('Buy groceries'), ('Read a book');",
  "site": [
    { "file": "index.html", "data": "<!DOCTYPE html><html>...</html>" },
    { "file": "style.css", "data": "body{margin:0}" }
  ],
  "subdomain": "my-app"
}
```

`run402 deploy --manifest app.json` provisions a project, runs `migrations`, deploys `site`, claims `subdomain`, returns `project_id` / `anon_key` / `service_key`, and saves credentials locally.

## Core facts

- Wallet: `~/.config/run402/wallet.json` (`0600`)
- Project creds: `~/.config/run402/projects.json` (`0600`)
- Creds are saved automatically after provision, deploy, or fork
- `<id>` means `project_id` from `run402 projects list`
- Parse stdout JSON; errors are JSON on stderr; exit `0` on success, `1` on error
- CLI handles x402 signing automatically; do not request private keys or manual payment libraries
- Projects, sites, subdomains, forks, functions, secrets, and storage are free with an active tier; image generation is per-call

## Common manual flow

- Provision: `run402 projects provision --tier prototype --name my-app`
- Schema/data: `run402 projects sql <id> "<sql>"`
- RLS: `run402 projects rls <id> public_read_write '[{"table":"items"}]'`
- Site: `run402 sites deploy --name my-app --manifest site.json --project <id>`
- Subdomain: `run402 subdomains claim <deployment_id> my-app --project <id>`
- REST test: `run402 projects rest <id> items "select=id,title&limit=10"`
- `rest` uses PostgREST query syntax (`select=`, `eq.`, `order=`, `limit=`)

## Commands

### init
- `run402 init`

### wallet
- `run402 wallet <create|status|fund|balance|export>`
- `run402 wallet checkout --amount 5000000`
- `run402 wallet history --limit 10`

### tier
- `run402 tier status`
- `run402 tier set <prototype|hobby|team>`

### projects
- `run402 projects <quote|list>`
- `run402 projects provision --tier <prototype|hobby|team> --name <name>`
- `run402 projects sql <id> "<sql>"`
- `run402 projects rest <id> <table> "<query>"`
- `run402 projects <usage|schema|delete> <id>`
- `run402 projects rls <id> <user_owns_rows|public_read|public_read_write> '[{"table":"posts"}]'`

### deploy
- `run402 deploy --manifest app.json`
- `cat app.json | run402 deploy`

### functions
- `run402 functions deploy <id> <name> --code handler.ts [--deps "openai"] [--timeout 30] [--memory 256]`
- `run402 functions invoke <id> <name> [--body '{"key":"value"}' | --method GET]`
- `run402 functions logs <id> <name> --tail 100`
- `run402 functions list <id>`
- `run402 functions delete <id> <name>`

Function runtime: Node 22. File must export a default async handler:

```ts
export default async (req: Request) =>
  new Response(JSON.stringify({ hello: "world" }), {
    headers: { "Content-Type": "application/json" }
  });
```

### secrets
- `run402 secrets set <id> <KEY> <VALUE>`
- `run402 secrets list <id>`
- `run402 secrets delete <id> <KEY>`

Secrets are exposed as `process.env` in functions.

### storage
- `run402 storage upload <id> <bucket> <path> [--file ./file] [--content-type mime]`
- `run402 storage download <id> <bucket> <path>`
- `run402 storage list <id> <bucket>`
- `run402 storage delete <id> <bucket> <path>`

### sites
- `run402 sites deploy --name <name> --manifest site.json [--project <id>]`
- `run402 sites status <deployment_id>`

`site.json`:

```json
{"files":[{"file":"index.html","data":"<!DOCTYPE html>..."},{"file":"style.css","data":"body{margin:0}"}]}
```

Must include `index.html`.

### subdomains
- `run402 subdomains claim <deployment_id> <name> [--project <id>]`
- `run402 subdomains list <id>`
- `run402 subdomains delete <name>`

Names: 3-63 chars, lowercase alphanumeric or `-`.

### apps
- `run402 apps browse [--tag <tag>]`
- `run402 apps fork <version_id> <name> --tier <prototype|hobby|team> --subdomain <subdomain>`
- `run402 apps inspect <version_id>`
- `run402 apps publish <id> --description "..." --tags a,b --visibility public --fork-allowed`
- `run402 apps versions <id>`
- `run402 apps update <id> <version_id> --description "..."`
- `run402 apps delete <id> <version_id>`

Forking creates a new project with copied schema, site, and functions.

### image
- `run402 image generate "<prompt>" [--aspect <square|landscape|portrait>] [--output file.png]`

Without `--output`, stdout JSON is:

```json
{"status":"ok","aspect":"square","content_type":"image/png","image":"<base64>"}
```

### message
- `run402 message send "<text>"`

### agent
- `run402 agent contact --name <name> [--email ops@example.com] [--webhook https://example.com/hook]`

## Environment

- `RUN402_API_BASE=https://api.run402.com`
- `RUN402_CONFIG_DIR=~/.config/run402`

## Pricing

- Prototype: `$0.10 / 7 days`
- Hobby: `$5 / 30 days`
- Team: `$20 / 30 days`
- Image generation: `$0.03 / image`
- Projects, site deploys, bundle deploys, subdomains, app forks, functions, secrets, storage: free with active tier
- Messages and agent contact: free

Payments use x402 on Base Sepolia (testnet) or Base Mainnet.
````

## Change report

- Removed human-oriented sections:
  - `TL;DR` duplication
  - “Try It” app ideas
  - “Make It Great” design advice
  - feedback CTA prose
- Front-loaded the canonical agent path:
  - install
  - `run402 init`
  - `run402 tier set ...`
  - `run402 deploy --manifest ...`
- Consolidated repeated explanations:
  - automatic wallet/payment handling now stated once
  - deploy behavior now stated once
  - pricing/free-with-tier repeated less
- Switched most command docs to compact syntax patterns:
  - uses `<...>` for alternatives/placeholders
  - uses `[...]` for optional args
  - keeps exact command names while cutting prose
- Kept machine-critical details:
  - Node version
  - config paths + permissions
  - JSON stdout/stderr contract
  - manifest formats
  - function export shape
  - RLS templates
  - subdomain rules
  - pricing
- Added an explicit agent guardrail:
  - do not ask for private keys or manual signing
- Reordered content for retrieval:
  - default workflow first
  - core facts second
  - manual flow third
  - full reference after that

Net effect: much less narrative, much less duplication, and a layout that makes the “happy path” obvious while preserving full command coverage. Roughly, this should be around 40–50% fewer tokens than the current version.

If you want, I can also produce an even tighter **build/deploy-only** variant that drops secondary commands and shrinks this further.

---
**Wall time**: 14m 38s
**Tokens**: 3,779 input, 23,133 output (21,002 reasoning), 26,912 total
**Estimated cost**: $4.2773
