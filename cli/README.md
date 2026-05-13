# run402 CLI

Command-line interface for [Run402](https://run402.com) — provision Postgres databases, deploy static sites, run Node 22 serverless functions, host content-addressed CDN assets, send email, sign on-chain. Paid autonomously with x402 USDC on Base. **Prototype tier is free on testnet.**

For the full CLI reference (every flag, every subcommand) see **<https://run402.com/llms-cli.txt>**.

## Install

```bash
npm install -g run402
```

Or run without installing:

```bash
npx run402 <command>
```

## 30-second start

```bash
run402 init                                # one-shot: allowance + faucet + tier check
run402 tier set prototype                  # FREE on testnet (verifies x402 setup)
run402 projects provision --name my-app    # → anon_key, service_key, project_id
run402 sites deploy-dir ./dist             # incremental upload
run402 subdomains claim my-app             # → https://my-app.run402.com
```

That's a real Postgres database + a deployed static site, paid for autonomously with testnet USDC.

## Output contract

Every command prints **JSON to stdout**, **JSON errors to stderr**, and exits **0 on success / 1 on failure**. Designed for shells, scripts, and agent loops — pipe everything to `jq`.

## Common commands

### Allowance

```bash
run402 allowance create    # generate the local allowance
run402 allowance fund      # request testnet USDC from the faucet
run402 allowance balance   # mainnet + testnet + billing balance
run402 allowance export    # print address (for funding)
```

### Database

```bash
run402 projects sql <id> "CREATE TABLE items (id serial PRIMARY KEY, …)"
run402 projects validate-expose <id> --file manifest.json # check auth manifest, no mutation
run402 projects apply-expose <id> --file manifest.json   # declare what's reachable
run402 projects rest <id> items "select=*&order=id.desc&limit=10"
run402 projects schema <id>                              # introspect tables + RLS
```

### Static sites

```bash
run402 sites deploy-dir ./dist                # incremental upload (plan/commit transport)
run402 deploy apply --manifest app.json       # one-call full stack deploy
run402 deploy release active                  # inspect current-live release inventory
run402 deploy release diff --from empty --to active
run402 deploy diagnose --project prj_123 https://example.com/events --method GET
run402 deploy resolve --project prj_123 --url https://example.com/events?utm=x#hero --method GET
run402 subdomains claim my-app                # → my-app.run402.com (auto-reassigns on next deploy)
```

`deploy-dir` hashes each file client-side and only uploads bytes the gateway doesn't already have. Re-deploying an unchanged tree returns immediately with `bytes_uploaded: 0`. Progress events stream to stderr.
Release inspection commands print `{ status: "ok", release: ... }` or `{ status: "ok", diff: ... }`; use them after deploys to compare release inventory without starting another mutation. Inventories include `release_generation`, `static_manifest_sha256`, and nullable `static_manifest_metadata`; diffs include `static_assets` counters such as unchanged/changed/added/removed and CAS byte reuse. `deploy diagnose` / `deploy resolve --url` print URL-first diagnostics with `would_serve`, `diagnostic_status`, `match`, warnings, and next steps; host misses are successful diagnostic calls with `would_serve: false`.

### GitHub Actions OIDC deploys

Link once from a local shell that has your Run402 allowance, then commit the generated workflow and manifest:

```bash
run402 ci link github --project prj_... --manifest run402.deploy.json
run402 ci link github --project prj_... --manifest run402.deploy.json --route-scope /admin --route-scope /api/*
run402 ci list --project prj_...
run402 ci revoke cib_...
```

`link github` infers `owner/repo` and the current branch, verifies the numeric GitHub repository id, creates a deploy-scoped CI binding, and writes `.github/workflows/run402-deploy.yml` unless you pass `--workflow`. The generated workflow is intentionally just the existing deploy command with OIDC enabled:

```yaml
permissions:
  contents: read
  id-token: write

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Deploy to run402
        run: npx --yes run402@1.60.0 deploy apply --manifest 'run402.deploy.json' --project 'prj_...'
```

CI deploys can ship `site`, `functions`, `database`, and absent/current `base` changes. Route declarations are allowed only when the binding was linked with covering `--route-scope` patterns (`/admin` exact, `/api/*` final wildcard); no scopes means no CI route authority. Keep secrets, domains, subdomains, checks, non-current base changes, and out-of-scope routes in a local `run402 deploy apply` where the full allowance-backed authority is present.

### Storage (paste-and-go CDN assets)

```bash
run402 blob put ./logo.png        # → AssetRef with cdn_url, sri, etag
run402 blob put ./asset --key assets/logo --content-type image/svg+xml
run402 blob get <key> --output /tmp/logo.png
run402 blob diagnose <url>        # exit 0 if fresh, 1 if stale
```

The returned `cdn_url` is content-addressed (`pr-<public_id>.run402.com/_blob/<key>-<8hex>.<ext>`) — paste it straight into HTML. SRI is bundled in `sri`.
`blob put` infers MIME type from the destination key; use `--content-type <mime>` when the key has no useful extension or needs an explicit override.

### Functions

```bash
run402 functions deploy <id> my-fn --file fn.ts \
  --timeout 30 --memory 256 \
  --schedule "*/15 * * * *" \
  --deps "stripe,zod@^3"
run402 functions logs <id> my-fn --tail 100 --request-id req_abc123 --follow
run402 functions invoke <id> my-fn --body '{"hello":"world"}'
```

Functions run on Node 22 with `@run402/functions` auto-bundled. Inside the handler:

```ts
import { db, adminDb, getUser, email, ai } from "@run402/functions";
```

`db(req)` is the caller-context client (RLS applies); `adminDb()` bypasses RLS for platform-authored writes.

### Same-origin web routes

`run402 deploy apply` accepts `site.public_paths` for clean static browser URLs and `routes.replace` for function ingress or exact method-aware static aliases. Release asset paths such as `events.html` are distinct from public paths such as `/events`: prefer `{ "site": { "replace": { "events.html": { "data": "<h1>Events</h1>" } }, "public_paths": { "mode": "explicit", "replace": { "/events": { "asset": "events.html" } } } } }` for ordinary clean static URLs. In explicit mode `/events.html` is not public unless separately declared; `mode: "implicit"` restores filename-derived reachability and can widen access. `routes.replace` is an array of route entries, not a path-keyed map. Use exact `/admin` plus final-wildcard `/admin/*` for a routed section root, narrow `/api/*` methods such as `["GET","POST","OPTIONS"]`, POST-only `/login` function routes, and exact static route targets like `{ "pattern": "/events", "methods": ["GET","HEAD"], "target": { "type": "static", "file": "events.html" } }` only for route-table alias behavior. Static route `file` is a release asset path, not a public path, URL, CAS hash, rewrite, or redirect. Routed functions use Node 22 Fetch Request -> Response; `req.url` is the full public URL on managed subdomains, deployment hosts, and verified custom domains. Direct `/functions/v1/:name` remains API-key protected. Known resolve literals include `host_missing`, `manifest_missing`, `path_error`, `none`, `static_exact`, `static_index`, `spa_fallback`, and `spa_fallback_missing`; current resolve is authoritative for host/static/SPAfallback diagnostics, not complete route introspection. Release inventories may include `static_public_paths` with `public_path`, `asset_path`, `reachability_authority`, and `direct`; resolve may return the same reachability fields. Static route target warnings include `STATIC_ALIAS_SHADOWS_STATIC_PATH`, `STATIC_ALIAS_RELATIVE_ASSET_RISK`, `STATIC_ALIAS_DUPLICATE_CANONICAL_URL`, `STATIC_ALIAS_EXTENSIONLESS_NON_HTML`, and `STATIC_ALIAS_TABLE_NEAR_LIMIT`; inspect active routes, `static_public_paths`, and the backing `asset_path`. Runtime route failure codes to branch on: `ROUTE_MANIFEST_LOAD_FAILED`, `ROUTED_INVOKE_WORKER_SECRET_MISSING`, `ROUTED_INVOKE_AUTH_FAILED`, `ROUTED_ROUTE_STALE`, `ROUTE_METHOD_NOT_ALLOWED`, and `ROUTED_RESPONSE_TOO_LARGE`.

### Secrets

```bash
run402 secrets set <id> OPENAI_API_KEY --file ./.secrets/openai-key
run402 secrets list <id>
run402 deploy apply --manifest run402.deploy.json   # manifest uses secrets.require, not values
```

Secret values are write-only. `list` returns keys and timestamps only; deploy manifests should declare dependencies with `secrets.require` and never contain values.

### Email

```bash
run402 email create my-app
run402 email send --to user@example.com --subject "Welcome" --html "<h1>Hi</h1>"
run402 email send --to user@example.com --template notification --var project_name="My App"
```

### Image generation

```bash
run402 image generate "a serif logo" --aspect square --output logo.png
```

$0.03 per image via x402.

### On-chain (KMS contract wallets)

```bash
run402 contracts provision-wallet --chain base-mainnet
run402 contracts call --wallet <id> --to 0x… --abi @abi.json --fn transfer --args '["0x…","1000000"]'
```

Private keys never leave AWS KMS. $0.04/day rental + $0.000005/call.

### Tier and billing

```bash
run402 tier set prototype                                    # free on testnet
run402 tier set hobby                                        # $5 / 30 days
run402 billing tier-checkout hobby --email me@example.com    # Stripe alternative
```

## State

Local state lives at:

- `~/.config/run402/projects.json` (`0600`) — project credentials (`anon_key`, `service_key`, `tier`, `lease_expires_at`)
- `~/.config/run402/allowance.json` (`0600`) — wallet for x402 signing

Override with `RUN402_CONFIG_DIR` or `RUN402_ALLOWANCE_PATH`. Override the API base with `RUN402_API_BASE`.

The CLI handles all x402 payment signing automatically — never ask the human for a private key or set up payment libraries by hand.

## Active project (sticky default)

After `provision`, the new project becomes the active one. `run402 projects use <id>` switches it. Most commands that take `<id>` default to the active project when omitted.

## Help

Every command supports `--help` / `-h`:

```bash
run402 --help
run402 projects --help
run402 sites --help
run402 blob --help
run402 functions --help
```

## Full reference

The canonical, comprehensive CLI reference — every flag, every subcommand, edge cases, troubleshooting — lives at:

**<https://run402.com/llms-cli.txt>**

Same content also at [`cli/llms-cli.txt`](./llms-cli.txt) in the repo. Treat that file as authoritative; this README is a quick-orientation landing page.

## Other interfaces

`run402` is one of five surfaces:

- [`@run402/sdk`](https://www.npmjs.com/package/@run402/sdk) — typed TypeScript client (isomorphic + Node entry)
- [`run402-mcp`](https://www.npmjs.com/package/run402-mcp) — MCP server (Claude Desktop, Cursor, Cline, Claude Code)
- [`@run402/functions`](https://www.npmjs.com/package/@run402/functions) — in-function helper imported inside deployed functions
- OpenClaw skill — script-based skill for OpenClaw agents

All five release in lockstep at the same version and share `@run402/sdk` as the kernel.

## License

MIT
