# run402 CLI

Command-line interface for [Run402](https://run402.com) — provision Postgres databases, deploy static sites, run Node 22 serverless functions, host content-addressed CDN assets, send email, sign on-chain. Paid autonomously with x402 USDC on Base. **Prototype tier is free on testnet.**

For the full CLI reference (every flag, every subcommand) see **<https://docs.run402.com/llms-cli.txt>**.

## Install

```bash
npm install -g run402@latest
```

Or run without installing:

```bash
npx -y run402@latest <command>
```

## 30-second start

```bash
run402 up --name my-app -y                 # bootstrap allowance/tier/project/link, then deploy
run402 subdomains claim my-app             # → https://my-app.run402.com
```

That's a real Postgres database + a deployed static site, paid for autonomously with testnet USDC.

## Output contract

Every command prints **JSON to stdout**, **JSON errors to stderr**, and exits **0 on success / 1 on failure**. Designed for shells, scripts, and agent loops — pipe everything to `jq`.

Stale CLI notices are advisory and never pollute success stdout. When a cached npm check says a newer `run402` exists, normal commands may emit a structured `cli.update_available` JSON object on stderr, or an NDJSON event in `--json-stream`. Run `run402 doctor --refresh` for the explicit live check; it reports whether this invocation is local, global, npx/npm exec, pnpm/yarn/bun, or custom, and includes an `upgrade_client` action with both `command` and `argv`.

## Common commands

### One-command app deploy

```bash
run402 up --name my-app -y
run402 up --manifest run402.deploy.ts --check
run402 up --manifest run402.deploy.ts --plan
run402 up --manifest run402.deploy.ts --require-plan plan_...
run402 up --manifest run402.deploy.json --project prj_...
run402 up verify --project prj_...
```

`up` is a thin CLI shim over the Node SDK action runner. It discovers `run402.deploy.json` then `app.json`, validates the deploy input before any mutation, resolves the project as `--project` → `.run402/project.json` → manifest `project_id` → approved creation from `--name` → approved active-project fallback, then applies the manifest. `--name` is creation/link metadata only; it is not a manifest field and never renames an existing project. When everything is already configured, plain `run402 up` deploys. Non-interactive recursive prerequisites/local writes require `-y/--yes`.

For app manifests with `verify.http[]`, `up` runs HTTP checks after deploy. Fresh Run402 edge sentinel misses (`x-run402-edge` or sentinel JSON bodies) become `propagation_pending` with diagnostics instead of hard failure while the host binding is still converging. Use `--propagation-budget-s <seconds>` to tune the default 120 second wait, `--no-propagation-wait` to return immediately, and `run402 up verify` to rerun the same checks without upload, deploy, project creation, or resource mutation.

For typed `run402.deploy.ts` configs, pass `--manifest` explicitly because TypeScript/JavaScript configs execute local code. Use `--check` for local-only import/normalize/file validation, `--print-spec` to inspect the normalized `ReleaseSpec`, `--plan` for a gateway-reviewed non-deploying plan, and `--require-plan <plan_id>` to apply only that reviewed intent. Warning flags are not used with `--require-plan`; the reviewed plan binds the exact warning/destructive set. Run402 Core skips Cloud allowance/tier prerequisites and fails closed when no Core project is selected.

### Allowance

```bash
run402 allowance create    # generate the local allowance
run402 allowance fund      # request testnet USDC from the faucet
run402 allowance balance   # mainnet + testnet + billing balance
run402 allowance export    # print {"address":"0x..."} for funding
```

### Buy from an x402 URL

```bash
run402 pay https://seller.example/translate --method POST \
  --body '{"text":"hello"}' --max-usd 0.05 \
  --idempotency-key translation:1 --require-receipt
```

The default maximum is $0.10. `--require-receipt` requires a verified
wallet-rooted offer before payment and a matching merchant receipt afterward.
JSON output is the complete `x402-commerce-result.v1` envelope, including
settlement, movement/replay, delivery, signer relationship, policy, and
portable non-secret evidence; an unpriced URL has `payment: null`. On trusted
Run402 `PAYMENT_INTENT_PENDING`, wait for `Retry-After` and repeat the identical
command with the same payer and `--idempotency-key`; never replace the key.
Custom/arbitrary hosts and other `funds_moved: "unknown"` outcomes require
reconciliation.

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
run402 apply --manifest app.json --rehearse --json
run402 deploy verify op_... --project prj_... --wait
run402 deploy release active                  # inspect current-live release inventory
run402 deploy release diff --from empty --to active
run402 deploy diagnose --project prj_123 https://example.com/events --method GET
run402 deploy resolve --project prj_123 --url https://example.com/events?utm=x#hero --method GET
run402 subdomains claim my-app                # → my-app.run402.com (auto-reassigns on next deploy)
```

For pointer-swap recovery, verify the returned operation before declaring the public rollback complete:

```bash
run402 deploy promote RELEASE_ID --project PROJECT_ID
run402 deploy verify --operation OPERATION_ID --wait
```

Promote success means the origin pointer is active; mutable public URLs may still be converging. The result's `edge.state` reports convergence, and `edge.verify_url` is the direct operation-scoped HTTP verification endpoint.

`deploy-dir` hashes each file client-side and only uploads bytes the gateway doesn't already have. Re-deploying an unchanged tree returns immediately with `bytes_uploaded: 0`. Progress events stream to stderr.
Release inspection commands print `{ release: ... }` or `{ diff: ... }` (raw payload, no envelope — see the "Output Contract" section in [llms-cli.txt](llms-cli.txt)); use them after deploys to compare release inventory without starting another mutation. `deploy verify` prints the canonical edge-coherence report and exits 2 when the report is valid but not yet coherent. Inventories include `release_generation`, `static_manifest_sha256`, and nullable `static_manifest_metadata`; diffs include `static_assets` counters such as unchanged/changed/added/removed and CAS byte reuse. `deploy diagnose` / `deploy resolve --url` print URL-first diagnostics with `would_serve`, `diagnostic_status`, `match`, warnings, `edge_propagation`, and next steps; host misses are successful diagnostic calls with `would_serve: false`. Stable-host resolve fields can include `authorization_result`, `cas_object`, `response_variant`, `allow`, `route_pattern`, `target_type`, `target_name`, `target_file`, and `edge_propagation` (`settled`, `propagating`, or `sync_pending`).

For database-bearing changes, use `run402 apply --manifest app.json --rehearse --json` before commit. It creates a contained branch, applies the candidate plan there, runs checks, and exits nonzero on a failed rehearsal. Manual restore points live under `run402 snapshots create|list|get|restore|delete`; temporary data branches live under `run402 branches create|list|renew|delete`.

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
        run: npx --yes run402@3.7.5 deploy apply --manifest 'run402.deploy.json' --project 'prj_...'
```

CI deploys can ship `site`, `functions`, `database`, and absent/current `base` changes. Route declarations are allowed only when the binding was linked with covering `--route-scope` patterns (`/admin` exact, `/api/*` final wildcard); no scopes means no CI route authority. Keep secrets, domains, subdomains, checks, non-current base changes, and out-of-scope routes in a local `run402 deploy apply` where the full allowance-backed authority is present.

### Storage (paste-and-go CDN assets)

```bash
run402 assets put ./logo.png        # → AssetRef with cdn_url, sri, etag
run402 assets put ./asset --key assets/logo --content-type image/svg+xml
run402 assets get <key> --output /tmp/logo.png
run402 assets diagnose <url>        # exit 0 if fresh, 1 if stale
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
run402 functions invoke <id> paid-fn --body '{"text":"hi"}' --idempotency-key paid:call:123 --wait
run402 functions rebuild <id> my-fn      # refresh ONE function onto the current runtime
run402 functions rebuild <id> --all      # refresh every function in the project
```

`functions rebuild` is opt-in and never changes your source: it re-bundles the stored source against the platform's current runtime/entry-wrapper (deps pinned to the exact versions recorded at deploy), so a gateway-side wrapper fix (e.g. an SSR `auth.*` fix) reaches an already-deployed function — a plain redeploy with unchanged source does not. The source `code_hash` is unchanged and no new release is created. Functions deployed before dependency locking return `CANNOT_REBUILD_UNLOCKED_DEPS`; redeploy those from source instead. `run402 doctor` flags functions on a stale runtime.

Functions run on Node 22 with `@run402/functions` auto-bundled. Inside the handler:

```ts
import { db, adminDb, auth, email, ai } from "@run402/functions";
```

`db(req)` is the caller-context client (RLS applies); `adminDb()` bypasses RLS for platform-authored writes.

### Same-origin web routes

`run402 deploy apply` accepts `site.public_paths` for clean static browser URLs and `routes.replace` for function ingress or exact method-aware static aliases. Release asset paths such as `events.html` are distinct from public paths such as `/events`: prefer `{ "site": { "replace": { "events.html": { "data": "<h1>Events</h1>" } }, "public_paths": { "mode": "explicit", "replace": { "/events": { "asset": "events.html" } } } } }` for ordinary clean static URLs. In explicit mode `/events.html` is not public unless separately declared; `mode: "implicit"` restores filename-derived reachability and can widen access. `routes.replace` is an array of route entries, not a path-keyed map. Use exact `/admin` plus final-wildcard `/admin/*` for a routed section root, narrow `/api/*` methods such as `["GET","POST","OPTIONS"]`, POST-only `/login` function routes, and exact static route targets like `{ "pattern": "/events", "methods": ["GET","HEAD"], "target": { "type": "static", "file": "events.html" } }` only for route-table alias behavior. Static route `file` is a release asset path, not a public path, URL, CAS hash, rewrite, or redirect. Recipe — static home page + SPA shell: a root alias `{ "pattern": "/", "target": { "type": "static", "file": "home.html" } }` (with `home.html` at the site root) serves real static bytes at `GET /` (`route_static_alias`) while unmatched app routes keep the `index.html` shell (`spa_fallback`); expect non-blocking `STATIC_ALIAS_SHADOWS_STATIC_PATH` (warn) / `STATIC_ALIAS_DUPLICATE_CANONICAL_URL` (info) plan lints and verify with `run402 deploy resolve --url https://<your-site>/ --method GET`. Routed functions use Node 22 Fetch Request -> Response; `req.url` is the full public URL on managed subdomains, deployment hosts, and verified custom domains. Direct `/functions/v1/:name` remains API-key protected. Known resolve literals include `host_missing`, `manifest_missing`, `active_release_missing`, `unsupported_manifest_version`, `path_error`, `none`, `static_exact`, `static_index`, `spa_fallback`, `spa_fallback_missing`, `route_function`, `route_static_alias`, and `route_method_miss`; known `authorization_result` values include `authorized`, `not_public`, `not_applicable`, `manifest_missing`, `target_missing`, `active_release_missing`, `unsupported_manifest_version`, `path_error`, `missing_cas_object`, `unfinalized_or_deleting_cas_object`, `size_mismatch`, and `unauthorized_cas_object`. Known `fallback_state` values include `active_release_missing`, `unsupported_manifest_version`, and `negative_cache_hit`; preserve unknown future strings. Release inventories may include `static_public_paths` with `public_path`, `asset_path`, `reachability_authority`, and `direct`; resolve may return the same reachability fields plus `authorization_result`, `cas_object`, `response_variant`, and route/static fields like `allow`, `route_pattern`, `target_type`, `target_name`, and `target_file`. Static route target warnings include `STATIC_ALIAS_SHADOWS_STATIC_PATH`, `STATIC_ALIAS_RELATIVE_ASSET_RISK`, `STATIC_ALIAS_DUPLICATE_CANONICAL_URL`, `STATIC_ALIAS_EXTENSIONLESS_NON_HTML`, and `STATIC_ALIAS_TABLE_NEAR_LIMIT`; inspect active routes, `static_public_paths`, and the backing `asset_path`. Runtime route failure codes to branch on: `ROUTE_MANIFEST_LOAD_FAILED`, `ROUTED_INVOKE_WORKER_SECRET_MISSING`, `ROUTED_INVOKE_AUTH_FAILED`, `ROUTED_ROUTE_STALE`, `ROUTE_METHOD_NOT_ALLOWED`, and `ROUTED_RESPONSE_TOO_LARGE`.

### Secrets

```bash
run402 secrets set <id> OPENAI_API_KEY --file ./.secrets/openai-key
printf %s "$OPENAI_API_KEY" | run402 secrets set <id> OPENAI_API_KEY --stdin
run402 secrets list <id>
run402 deploy apply --manifest run402.deploy.json   # manifest uses secrets.require, not values
```

Secret values are write-only. `list` returns keys and timestamps only; deploy manifests should declare dependencies with `secrets.require` and never contain values.

### Jobs

```bash
run402 jobs submit --file job.json --project prj_...
run402 jobs get job_abc123 --project prj_...
run402 jobs logs job_abc123 --project prj_... --tail 100
run402 jobs cancel job_abc123 --project prj_...
run402 jobs purge --project prj_...
```

Jobs are platform-managed runners, not arbitrary Docker execution. Submit the gateway-shaped JSON request (`job_type`, `input.input_json`, `max_cost_usd_micros`) and the CLI handles the required idempotency header through the SDK.

### Email

```bash
run402 email create my-app
run402 email mailboxes
run402 email defaults --outbound my-app --auth-sender my-app
run402 email update my-app --footer-policy none
run402 email send --to user@example.com --subject "Welcome" --html "<h1>Hi</h1>"
run402 email send --to user@example.com --template notification --var project_name="My App"
```

For Run402 Core, use the same commands after `run402 init --api-base=http://my-core:4020`. The Core gateway operator must configure an outbound provider such as SES first; `run402 email mailboxes` surfaces `provider_readiness`, `can_send`, `send_blocked_reason`, and `next_actions` when setup is missing. Core's first email slice supports raw outbound mail with attachments; managed templates, inbound reply handling, sender-domain automation, and delivery operations may remain Cloud-only until the Core gateway adds those capabilities.

### Image generation

```bash
run402 image generate "a serif logo" --aspect square --output logo.png
```

$0.03 per image via x402.

### On-chain (KMS signers)

```bash
run402 contracts provision-signer --chain base-mainnet
run402 contracts call <project_id> <signer_id> --to 0x… --abi @abi.json --fn transfer --args '["0x…","1000000"]'
```

Private keys never leave AWS KMS. $0.04/day rental + $0.000005/call.

### Tier and billing

```bash
run402 tier set prototype                                    # free on testnet
run402 tier set hobby                                        # $5 / 30 days
run402 billing checkout <org_id> --product tier --tier hobby  # Stripe alternative
```

## State

Local state lives at:

- `~/.config/run402/projects.json` (`0600`) — project credentials (`anon_key`, `service_key`, `tier`, `lease_expires_at`)
- `~/.config/run402/allowance.json` (`0600`) — wallet for x402 signing
- `~/.config/run402/config.json` (`0600`) — global default wallet pointer (`active_wallet`)
- `~/.config/run402/profiles/<name>/` (`0700`) — named wallets, each with its own `allowance.json` + `projects.json` + non-secret `meta.json`

Override the base directory with `RUN402_CONFIG_DIR` or the allowance file with `RUN402_ALLOWANCE_PATH`. Override the API base with `RUN402_API_BASE`.

### Named wallets (profiles)

Hold several wallets on one machine and select between them:

- `run402 wallets list | new <name> | use <name> | rename <old> <new> | bind [<name>] | unbind | import <name> --key <path|-> | rm <name> --yes`
- Select per-command with `--wallet <name>` (alias `--profile`), the `RUN402_WALLET` env var, or a per-directory `.run402.json` (commit-safe — holds only a name) resolved by walking up the tree. Precedence: flag > env > binding > `wallets use` default > `default`. A conflicting env + binding is a hard error.
- The active wallet name shows in `run402 status` and `run402 wallets current`.

The CLI handles all x402 payment signing automatically — never ask the human for a private key or set up payment libraries by hand.

### Operator (human / email session)

The **operator** is YOU, the human, identified by email — distinct from the agent (your wallet). One browser login spans every wallet that verified your email, so the overview is a cross-wallet union. For a single wallet's account state, use `run402 status`.

- `run402 operator login` — browser-delegated sign-in (device-authorization, RFC 8628, like `aws sso login`): magic-link or passkey in the browser, no WebAuthn in the CLI. Caches an email-scoped session at the base config dir (shared across named wallets).
- `run402 operator overview` — account view across ALL wallets controlling your email (requires login; never falls back to a single wallet).
- `run402 operator whoami` — show the cached session (email, wallets, expiry); local, no network.
- `run402 operator logout` — revoke the session server-side and clear the local cache.

Not exposed as MCP tools by design — MCP authenticates as the agent (wallet), and the human session must not be handed to it.

## Active project (sticky default)

After `provision`, the new project becomes the active one. `run402 projects use <id>` switches it. Most commands that take `<id>` default to the active project when omitted.

## Help

Every command supports `--help` / `-h`:

```bash
run402 --help
run402 projects --help
run402 sites --help
run402 assets --help
run402 functions --help
```

## Full reference

The canonical, comprehensive CLI reference — every flag, every subcommand, edge cases, troubleshooting — lives at:

**<https://docs.run402.com/llms-cli.txt>**

Same content also at [`cli/llms-cli.txt`](./llms-cli.txt) in the repo. Treat that file as authoritative; this README is a quick-orientation landing page.

## Other interfaces

`run402` is one of the public Run402 surfaces:

- [`@run402/sdk`](https://www.npmjs.com/package/@run402/sdk) — typed TypeScript client (isomorphic + Node entry)
- [`run402-mcp`](https://www.npmjs.com/package/run402-mcp) — MCP server (Claude Desktop, Cursor, Cline, Claude Code)
- [`@run402/functions`](https://www.npmjs.com/package/@run402/functions) — in-function helper imported inside deployed functions
- [`@run402/astro`](https://www.npmjs.com/package/@run402/astro) — Astro SSR, ISR cache, hosted auth, and image integration
- OpenClaw skill — script-based skill for OpenClaw agents

The in-repo packages `run402`, `run402-mcp`, and `@run402/sdk` release in lockstep. `@run402/astro` and `@run402/functions` publish on their own cadences.

## License

MIT
