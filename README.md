<p align="center">
  <img src=".github/logo.svg" width="120" alt="run402 logo">
</p>

<h1 align="center">run402 — Postgres, storage & deploys for AI agents</h1>

[![Tests](https://github.com/kychee-com/run402/actions/workflows/test.yml/badge.svg)](https://github.com/kychee-com/run402/actions/workflows/test.yml)
[![CodeQL](https://github.com/kychee-com/run402/actions/workflows/codeql.yml/badge.svg)](https://github.com/kychee-com/run402/actions/workflows/codeql.yml)
[![npm: @run402/sdk](https://img.shields.io/npm/v/@run402/sdk?label=%40run402%2Fsdk)](https://www.npmjs.com/package/@run402/sdk)
[![npm: run402](https://img.shields.io/npm/v/run402?label=run402)](https://www.npmjs.com/package/run402)
[![npm: run402-mcp](https://img.shields.io/npm/v/run402-mcp?label=run402-mcp)](https://www.npmjs.com/package/run402-mcp)
[![npm: @run402/functions](https://img.shields.io/npm/v/@run402/functions?label=%40run402%2Ffunctions)](https://www.npmjs.com/package/@run402/functions)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

[Run402](https://run402.com) gives an agent a full Postgres database, REST API, user auth, content-addressed file storage, static site hosting, serverless functions, and image generation — provisioned with one call, paid with x402 USDC on Base (or Stripe credits). The prototype tier is free on testnet.

This monorepo ships every surface an agent can pick up:

| Package | Use when… |
|---------|-----------|
| [`@run402/sdk`](./sdk/) | Calling Run402 from TypeScript — typed kernel, isomorphic (Node 22 / Deno / Bun / V8 isolates) with a Node entry that auto-loads the local keystore + allowance + x402 fetch |
| [`run402` CLI](./cli/) | Terminal, scripts, CI, agent-controlled shells — JSON in, JSON out, exit code on failure |
| [`run402-mcp`](./src/) | Claude Desktop, Cursor, Cline, Claude Code — core Run402 operations as MCP tools |
| [OpenClaw skill](./openclaw/) | OpenClaw agents (no MCP server required) |
| [`@run402/functions`](./functions/) | Imported _inside_ deployed functions (`db(req)`, `adminDb()`, `getUser()`, `email`, `ai`) and for TypeScript autocomplete in your editor |

All five interfaces release in lockstep at the same version and share a single typed kernel where appropriate: `@run402/sdk`. MCP tools, CLI subcommands, and OpenClaw scripts are thin shims over SDK calls; `@run402/functions` is the in-function helper that runs inside deployed code. Pick whichever interface fits your runtime.

## 30-second start

```bash
npm install -g run402
run402 init                                          # creates allowance, requests testnet faucet
run402 tier set prototype                            # free on testnet (verifies x402 setup)
run402 projects provision --name my-app              # → anon_key, service_key, project_id
run402 sites deploy-dir ./dist                       # incremental deploy of a directory → live URL
run402 subdomains claim my-app                       # → https://my-app.run402.com
```

That's a real Postgres database + a deployed static site, paid for autonomously with testnet USDC.

## The patterns

### Paste-and-go assets — content-addressed URLs with SRI

`blobs.put()` returns an `AssetRef` whose `scriptTag()` / `linkTag()` / `imgTag()` emitters produce HTML with the URL, the SRI integrity hash, and modern best-practice attributes (`defer`, `loading="lazy"`, `decoding="async"`, `crossorigin`) already wired. The URL is content-addressed (`pr-<public_id>.run402.com/_blob/<key>-<8hex>.<ext>`), served through the v1.33 CDN, and never needs invalidation:

```ts
import { run402 } from "@run402/sdk/node";
const r = run402();

const logo  = await r.blobs.put(projectId, "logo.png", { bytes: pngBytes });
const app   = await r.blobs.put(projectId, "app.js",   { content: jsSource });
const style = await r.blobs.put(projectId, "app.css",  { content: css });

const html = `
<!doctype html>
<html>
  <head>${style.linkTag()}${app.scriptTag({ type: "module" })}</head>
  <body>${logo.imgTag("Company logo")}</body>
</html>
`;
```

`immutable: true` is the default — the SDK computes the SHA-256 client-side, the gateway returns a content-hashed URL, and the browser refuses execution on byte mismatch. No cache-invalidation choreography, no waiting, no integrity-attribute construction.

### Dark-by-default tables + the expose manifest

Tables you create are unreachable via `/rest/v1/*` until you declare them in a manifest. That closes the "agent created a table, forgot to set RLS, data leaked" footgun. The manifest is convergent — applying it twice is a no-op; items removed between applies have their policies, grants, triggers, and views dropped.

```bash
cat > manifest.json <<'EOF'
{
  "$schema": "https://run402.com/schemas/manifest.v1.json",
  "version": "1",
  "tables": [
    { "name": "items",  "expose": true,  "policy": "user_owns_rows",
      "owner_column": "user_id", "force_owner_on_insert": true },
    { "name": "audit",  "expose": false }
  ],
  "views": [
    { "name": "leaderboard", "base": "items", "select": ["user_id", "score"], "expose": true }
  ],
  "rpcs": [
    { "name": "compute_streak", "signature": "(user_id uuid)", "grant_to": ["authenticated"] }
  ]
}
EOF

run402 projects apply-expose <project_id> --file manifest.json
run402 projects get-expose   <project_id>
```

Built-in policies: `user_owns_rows` (rows where `owner_column = auth.uid()`; with `force_owner_on_insert: true` a BEFORE INSERT trigger sets it), `public_read_authenticated_write` (anyone reads, any authenticated user writes), `public_read_write_UNRESTRICTED` (fully open; requires `i_understand_this_is_unrestricted: true`), and `custom` (escape hatch — your own `CREATE POLICY` SQL).

**Auth-as-SDLC alternative:** drop the same JSON as `manifest.json` into your bundle's `files[]` and the gateway reads it, validates it against your migration SQL, applies it, and strips it before serving the site — so authorization travels with your code and never gets publicly served. The deploy returns `manifest_applied: true`; if a table referenced by the manifest isn't in the migration, the deploy is rejected with a structured `errors` array listing every violation.

### Slick deploys — `deployDir` + plan/commit + progress

`deployDir` walks a local directory, hashes every file client-side, asks the gateway _which_ bytes it doesn't already have, and PUTs only those. Re-deploying an unchanged tree returns immediately with `bytes_uploaded: 0`.

```ts
import { run402 } from "@run402/sdk/node";

const r = run402();
const { url, bytes_uploaded, bytes_total } = await r.sites.deployDir({
  project: projectId,
  dir: "./dist",
  onEvent: (e) => process.stderr.write(JSON.stringify(e) + "\n"),
});
```

Progress events stream over `onEvent` (or stderr from the CLI). Both the
unified `DeployEvent` shapes (from the v2 deploy primitive) and the legacy
phase events below are emitted for back-compat:

| phase | Fires | Extra |
|-------|-------|-------|
| `plan`   | After the plan response is parsed | `manifest_size` (file count) |
| `upload` | After each missing file's bytes finish PUTing | `file`, `sha256`, `done`, `total` |
| `commit` | Just before the commit POST | — |
| `poll`   | Per server-side copy poll tick | `status`, `elapsed_ms` |

CLI:

```bash
run402 sites deploy-dir ./dist --project prj_… > result.json 2> events.log
```

### Same-origin web routes — static site + function ingress

Deploy-v2 routes are release resources: they activate atomically with the site, functions, migrations, secrets, and subdomains in the same `deploy apply`. The route resource shape is an ordered replace list, not a path-keyed map:

```json
{
  "project_id": "prj_...",
  "site": {
    "replace": {
      "index.html": { "data": "<!doctype html><main id='app'></main><script>fetch('/api/hello')</script>" }
    }
  },
  "functions": {
    "replace": {
      "api": {
        "runtime": "node22",
        "source": {
          "data": "import { routedHttp } from '@run402/functions'; export default async (event) => routedHttp.json({ ok: true, path: event.path });"
        }
      }
    }
  },
  "routes": {
    "replace": [
      { "pattern": "/api/*", "methods": ["GET", "POST"], "target": { "type": "function", "name": "api" } }
    ]
  }
}
```

Omit `routes` or pass `routes: null` to carry forward base routes. Use `routes: { "replace": [] }` to clear dynamic routes. Direct `/functions/v1/:name` calls remain API-key protected; browser-routed paths are public same-origin ingress, so the function owns app auth, CSRF for cookie-authenticated unsafe methods, and CORS/`OPTIONS`.

Matching is exact or final-prefix-wildcard only. `/admin` and `/admin/` are exact trailing-slash equivalents; `/admin/*` matches children but not `/admin`, `/admin/`, `/admin.css`, or `/administrator`, so deploy both `/admin` and `/admin/*` for a routed section root. Query strings are ignored for matching and forwarded as `rawQuery`. Exact routes beat prefix routes; longest prefix wins; method-compatible dynamic routes beat static assets. A `POST /login` route can coexist with static `GET /login` HTML. Unsafe method mismatch returns `405`, and matched dynamic route failures fail closed instead of falling back to static files.

### GitHub Actions OIDC deploys — link once, deploy with the same CLI

For repo-driven deploys, Run402 does not need service keys or allowance files in GitHub secrets. Run a local link command once:

```bash
run402 ci link github --project prj_... --manifest run402.deploy.json
# Optional route authority for CI route declarations:
run402 ci link github --project prj_... --manifest run402.deploy.json --route-scope /admin --route-scope /api/*
```

That creates a deploy-scoped `/ci/v1/*` binding and writes a workflow that grants `id-token: write`, checks out the repo, and runs the existing deploy primitive:

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

CI deploys are intentionally narrow: `site`, `functions`, `database`, absent/current `base`, and route declarations only when the binding has covering `--route-scope` patterns. Without route scopes, CI cannot ship `routes`. Keep secrets, domains, subdomains, checks, non-current base, and broader trust changes in a local allowance-backed deploy. If the gateway returns `CI_ROUTE_SCOPE_DENIED`, re-link with exact scopes like `/admin` or final-wildcard scopes like `/api/*`, or deploy locally. Manage bindings with `run402 ci list` and `run402 ci revoke`.

### In-function helpers — caller-context vs BYPASSRLS

Inside a deployed function, import from `@run402/functions`. Two distinct DB clients keep RLS clean:

```ts
import { db, adminDb, getUser, email, ai } from "@run402/functions";

export default async (req: Request) => {
  const user = await getUser(req);
  if (!user) return new Response("unauthorized", { status: 401 });

  // Caller-context — Authorization header is forwarded; RLS evaluates against the caller's role.
  const mine = await db(req).from("items").select("*").eq("user_id", user.id);

  // BYPASSRLS — for platform-authored writes (audit logs, cron cleanup, webhook handlers).
  await adminDb().from("audit").insert({ event: "items_read", user_id: user.id });

  // Send mail from the project's mailbox — discovers it automatically.
  if (mine.length === 0) {
    await email.send({ to: user.email, subject: "Welcome", html: "<h1>hi</h1>" });
  }

  return Response.json(mine);
};
```

`adminDb().sql(query, params?)` runs raw parameterized SQL and always bypasses RLS. It returns a flat `Promise<Record<string, unknown>[]>` (just the rows — no envelope):

```ts
import { adminDb, getUser } from "@run402/functions";

export default async (req: Request) => {
  const user = await getUser(req);
  if (!user) return new Response("unauthorized", { status: 401 });

  const rows = await adminDb().sql(
    "SELECT count(*)::int AS n FROM items WHERE user_id = $1",
    [user.id],
  );
  const n = (rows[0]?.n as number | undefined) ?? 0;
  return Response.json({ count: n });
};
```

`@run402/functions` is auto-bundled into deployed code; install it in your editor for full TypeScript autocomplete (also works at build time for static-site generation with `RUN402_SERVICE_KEY` + `RUN402_PROJECT_ID` set).

**Calling from outside a function entirely** (raw `curl`/`fetch` from CI scripts, bash bootstrappers, non-TS runtimes) — service-key writes go to `/admin/v1/rest/<table>`, not `/rest/v1/*`. The gateway 403s service-role tokens on `/rest/v1/*` so a leaked key can't silently bypass RLS, which means `curl ... > /dev/null` against the wrong path looks like success but writes nothing. SQL-shaped admin work uses `POST /projects/v1/admin/:id/sql` (or `run402 projects sql`).

```bash
curl -X POST https://api.run402.com/admin/v1/rest/audit \
  -H "Authorization: Bearer $RUN402_SERVICE_KEY" \
  -H "Content-Type: application/json" \
  -d '{"event":"seed","ts":"2026-04-30"}'
```

## SDK — `@run402/sdk`

```bash
npm install @run402/sdk
```

Two entry points:

- **`@run402/sdk`** — isomorphic. Bring your own `CredentialsProvider` (a session-token shim, a remote vault, anything that resolves project keys + auth headers). Works in Node 22, Deno, Bun, V8 isolates.
- **`@run402/sdk/node`** — Node-only convenience. Reads `~/.config/run402/projects.json`, signs x402 payments from the local allowance, exposes `sites.deployDir(...)`, `fileSetFromDir(...)`, and typed deploy-manifest helpers (`loadDeployManifest`, `normalizeDeployManifest`).

```ts
import { run402 } from "@run402/sdk/node";

const r = run402();
const project = await r.projects.provision({ tier: "prototype" });
await r.blobs.put(project.project_id, "hello.txt", { content: "hi" });
```

20 namespaces: `projects`, `deploy`, `ci`, `sites`, `blobs`, `functions`, `secrets`, `subdomains`, `domains`, `email` (+ `webhooks`), `senderDomain`, `auth`, `apps`, `tier`, `billing`, `contracts`, `ai`, `allowance`, `service`, `admin`. Every operation throws a typed `Run402Error` subclass on failure: `PaymentRequired`, `ProjectNotFound`, `Unauthorized`, `ApiError`, `NetworkError`, `LocalError`, `Run402DeployError`. `deploy.apply()` automatically re-plans safe current-base `BASE_RELEASE_CONFLICT` races and emits `deploy.retry` progress events. See [`sdk/README.md`](./sdk/README.md).

## CLI — `run402`

```bash
npm install -g run402
```

Every subcommand prints JSON to stdout, JSON errors to stderr, exits 0 on success and 1 on failure — designed for an agent shell, not a human. Full reference: [`cli/llms-cli.txt`](./cli/llms-cli.txt) (also at <https://run402.com/llms-cli.txt>).

```bash
run402 init                              # one-shot allowance + faucet + tier check
run402 status                            # account snapshot (allowance, balance, tier, projects)
run402 projects provision --name my-app
run402 projects sql <id> "CREATE TABLE …"
run402 projects apply-expose <id> --file manifest.json
run402 sites deploy-dir ./dist
run402 deploy release active --project <id>  # inspect current-live release inventory
run402 functions deploy <id> <name> --file fn.ts
run402 ci link github --project <id>       # GitHub Actions OIDC deploy binding (--route-scope for CI routes)
run402 blob put ./asset.png --immutable
run402 blob diagnose <url>               # inspect live CDN state for a public URL
run402 cdn wait-fresh <url> --sha <hex>  # poll until a mutable URL serves the new SHA
```

The active project is sticky: `run402 projects use <id>` makes `<id>` the default for every subsequent `<id>`-taking subcommand, so most commands work without it.

## MCP server — `run402-mcp`

```bash
npx -y run402-mcp                        # standalone test
```

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

Add to your Cline MCP settings:

```json
{
  "mcpServers": {
    "run402": { "command": "npx", "args": ["-y", "run402-mcp"] }
  }
}
```

### Claude Code

```bash
claude mcp add run402 -- npx -y run402-mcp
```

## OpenClaw skill

```bash
cp -r openclaw ~/.openclaw/skills/run402
cd ~/.openclaw/skills/run402/scripts && npm install
```

Each script re-exports from `cli/lib/*.mjs` — the OpenClaw command surface is identical to the CLI command surface by construction. See [`openclaw/README.md`](./openclaw/README.md).

## MCP tools

The full MCP surface — every tool is a thin shim over an SDK call.

### Database

| Tool | Description |
|------|-------------|
| `provision_postgres_project` | Provision a new database. Auto-handles x402 payment. |
| `run_sql` | Execute SQL (DDL or queries). Returns a markdown table. |
| `rest_query` | Query/mutate via PostgREST. |
| `apply_expose` | Apply the declarative authorization manifest (tables, views, RPCs). Convergent — drops items removed between applies. |
| `get_expose` | Return the current manifest. `source` is either `applied` (from the tracking table) or `introspected` (regenerated from live DB state). |
| `get_schema` | Introspect tables, columns, types, constraints, RLS policies. |
| `get_usage` | Per-project usage report (API calls, storage, lease expiry). |
| `promote_user` / `demote_user` | Manage `project_admin` role on a project user. |
| `delete_project` | Cascade purge — schema, Lambdas, S3 site files, deployments, secrets, published versions. Irreversible. |

### Blob storage (content-addressed CDN)

| Tool | Description |
|------|-------------|
| `blob_put` | Upload a blob (any size, up to 5 TiB) via direct-to-S3 presigned URLs. Returns an `AssetRef` with `scriptTag()` / `linkTag()` / `imgTag()` emitters. |
| `blob_get` | Download a blob to a local file. |
| `blob_ls` | Keyset-paginated list with prefix filter. |
| `blob_rm` | Delete a blob. |
| `blob_sign` | Time-boxed presigned GET URL for a private blob. |
| `diagnose_public_url` | Live CDN state for a public URL — expected vs observed SHA, cache headers, invalidation status. |
| `wait_for_cdn_freshness` | Poll a mutable URL until it serves the expected SHA-256. |

### Sites & subdomains

| Tool | Description |
|------|-------------|
| `deploy_site` | Deploy a static site from inline file bytes. |
| `deploy_site_dir` | Deploy a static site from a local directory. Routes through the unified deploy primitive (CAS-backed) — only uploads bytes the gateway doesn't have. |
| `claim_subdomain` | Claim `<name>.run402.com` (idempotent; reassigns to latest deployment on subsequent deploys). |
| `list_subdomains` / `delete_subdomain` | Manage subdomains. |
| `add_custom_domain` / `list_custom_domains` / `check_domain_status` / `remove_custom_domain` | Point your own domain at a Run402 subdomain. |
| `bundle_deploy` | Legacy one-call full-stack deploy: database + migrations + authorization manifest (`manifest.json` in `files[]` — gateway validates it, applies it, then strips it before serving the site) + optional legacy in-memory secrets + functions + site + subdomain. For new secret-bearing deploys, use `set_secret` first, then `deploy` with `secrets.require`. |
| `deploy` / `deploy_resume` / `deploy_list` / `deploy_events` | Apply, resume, list, and inspect deploy operations. |
| `deploy_release_get` / `deploy_release_active` / `deploy_release_diff` | Inspect release inventory and release-to-release diffs without starting a new deploy mutation. |

### CI/OIDC bindings

| Tool | Description |
|------|-------------|
| `ci_create_binding` | Create a GitHub Actions CI deploy binding from a locally signed delegation. Optional `route_scopes` delegate exact paths like `/admin` or final wildcards like `/api/*`; omitted means no CI route authority. |
| `ci_list_bindings` / `ci_get_binding` / `ci_revoke_binding` | Inspect and revoke CI bindings, including returned `route_scopes`. |

### Functions & secrets

| Tool | Description |
|------|-------------|
| `deploy_function` | Deploy a Node 22 serverless function. Cron-schedulable. |
| `invoke_function` | Invoke a deployed function over the direct API-key-protected test path. |
| `get_function_logs` | Recent logs (CloudWatch). |
| `update_function` | Update schedule / timeout / memory without redeploying code. |
| `list_functions` / `delete_function` | List / remove functions. |
| `set_secret` / `list_secrets` / `delete_secret` | Manage `process.env` secrets injected into all functions. Values are write-only; list returns keys and timestamps only. |

### Auth & email

| Tool | Description |
|------|-------------|
| `request_magic_link` | Send a passwordless login email. |
| `verify_magic_link` | Exchange the magic link token for `access_token` + `refresh_token`. |
| `create_auth_user` / `invite_auth_user` | Create/update auth users and send trusted service-key invites. |
| `set_user_password` | Change, reset, or set a user's password. |
| `auth_settings` | Configure password set, preferred sign-in method, public signup policy, and project-admin passkey enforcement. |
| `passkey_register_options` / `passkey_register_verify` | Create and verify WebAuthn passkey registration ceremonies. |
| `passkey_login_options` / `passkey_login_verify` | Create and verify WebAuthn passkey login ceremonies. |
| `list_passkeys` / `delete_passkey` | List or delete the authenticated user's passkeys. |
| `create_mailbox` / `get_mailbox` / `delete_mailbox` | Per-project mailbox at `<slug>@mail.run402.com`. |
| `send_email` | Template (`project_invite`, `magic_link`, `notification`) or raw HTML. Single recipient. |
| `list_emails` / `get_email` / `get_email_raw` | Read messages. `get_email_raw` returns RFC-822 bytes for DKIM / zk-email verification. |
| `register_mailbox_webhook` / `list_mailbox_webhooks` / `get_mailbox_webhook` / `update_mailbox_webhook` / `delete_mailbox_webhook` | Email-event webhooks (delivery, bounced, complained, reply_received). |
| `register_sender_domain` / `sender_domain_status` / `remove_sender_domain` | Send from your own domain (DKIM verified). |
| `enable_sender_domain_inbound` / `disable_sender_domain_inbound` | Receive replies on your custom sender domain. |

### AI helpers

| Tool | Description |
|------|-------------|
| `generate_image` | Text-to-PNG via x402 ($0.03 / image). |
| `ai_translate` | Translate text. Metered per project. |
| `ai_moderate` | Moderate text (free). |
| `ai_usage` | Translation quota (used / included / remaining). |

### Apps marketplace

| Tool | Description |
|------|-------------|
| `browse_apps` | Browse public forkable apps. |
| `get_app` | Inspect an app, including expected `bootstrap_variables`. |
| `fork_app` | Clone schema + site + functions into a new project. Runs the app's `bootstrap` function with provided variables. |
| `publish_app` | Publish a project as a forkable app. |
| `list_versions` / `update_version` / `delete_version` | Manage published versions. |

### Tier & billing

| Tool | Description |
|------|-------------|
| `set_tier` | Subscribe / renew / upgrade a tier (auto-detects action). x402 payment. |
| `tier_status` | Current tier and lease expiry. |
| `get_quote` | Tier pricing (free, no auth). |
| `tier_checkout` | Stripe checkout for a tier (alternative to x402). |
| `create_email_billing_account` / `link_wallet_to_account` | Email-based billing accounts; hybrid Stripe + x402. |
| `billing_history` | Ledger history. |
| `buy_email_pack` | $5 for 10,000 emails (never expire). |
| `set_auto_recharge` | Auto-buy email packs when credits run low. |

### KMS contract wallets (on-chain signing)

| Tool | Description |
|------|-------------|
| `provision_contract_wallet` | AWS KMS-backed Ethereum wallet. $0.04/day rental + $0.000005 per call. Private keys never leave KMS. |
| `get_contract_wallet` / `list_contract_wallets` | Metadata + live native balance. |
| `set_recovery_address` / `set_low_balance_alert` | Optional safety nets. |
| `contract_call` | Submit a write call (chain gas at-cost + KMS sign fee). |
| `contract_read` | Read-only call (free). |
| `get_contract_call_status` | Lifecycle, gas, receipt. |
| `drain_contract_wallet` | Drain native balance (works on suspended wallets — the safety valve). |
| `delete_contract_wallet` | Schedule KMS key deletion (refused if balance ≥ dust). |

### Allowance & account

| Tool | Description |
|------|-------------|
| `init` | One-shot setup: allowance + faucet + tier check + project list. |
| `status` | Full account snapshot (allowance, balance, tier, projects). |
| `allowance_status` / `allowance_create` / `allowance_export` | Local allowance management. |
| `request_faucet` | Request testnet USDC. |
| `check_balance` | USDC balance for an allowance address. |
| `list_projects` | Active projects for a wallet. |
| `pin_project` | Pin a project (admin only — uses the configured admin allowance wallet). |
| `project_info` / `project_keys` / `project_use` | Inspect / set the active project. |
| `create_checkout` | Stripe checkout to add cash credit. |
| `send_message` | Send feedback to the Run402 team. |
| `set_agent_contact` / `get_agent_contact_status` / `verify_agent_contact_email` | Register agent contact info, read assurance status, and start the operator email reply challenge. |
| `start_operator_passkey_enrollment` | Email a Run402 operator passkey enrollment link to the verified contact email. |

### Service status (no auth)

| Tool | Description |
|------|-------------|
| `service_status` | Public availability report — 24h/7d/30d uptime per capability, operator, deployment topology. |
| `service_health` | Liveness probe with per-dependency results. |

## Configuration

| Variable | Default | Purpose |
|----------|---------|---------|
| `RUN402_API_BASE`        | `https://api.run402.com`         | API base URL (override for staging) |
| `RUN402_CONFIG_DIR`      | `~/.config/run402`               | Local credential storage directory |
| `RUN402_ALLOWANCE_PATH`  | `{config_dir}/allowance.json`    | Custom allowance file path |

Local state lives at:

- `~/.config/run402/projects.json` (`0600`) — `{ projects: { <id>: { anon_key, service_key, tier, lease_expires_at } } }`
- `~/.config/run402/allowance.json` (`0600`) — wallet for x402 signing

`anon_key` and `service_key` have no expiry — lease enforcement happens server-side. Rotate them by deleting the project and re-provisioning.

## Development

```bash
npm run build           # builds core/, sdk/, functions/, then the MCP server
npm test                # SKILL + sync + unit tests
npm run test:e2e        # 47 CLI end-to-end tests
npm run test:sync       # checks MCP/CLI/OpenClaw/SDK stay in sync
npm run test:skill      # validates SKILL.md frontmatter + body
```

Architecture: every tool / subcommand / skill script is a thin shim over an `@run402/sdk` call. `core/` holds Node-only filesystem primitives (keystore, allowance, SIWE signing) wrapped by the SDK's Node provider. See [`CLAUDE.md`](./CLAUDE.md) for the full layout.

## Links

- Web: <https://run402.com>
- API docs (HTTP): <https://run402.com/llms.txt> · <https://run402.com/openapi.json>
- CLI docs: <https://run402.com/llms-cli.txt>
- Status: <https://api.run402.com/status>
- Health: <https://api.run402.com/health>

[简体中文](./README.zh-CN.md)

## License

MIT
