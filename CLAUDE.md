# CLAUDE.md

## Related Repositories

- **kychee-com/kysigned** (private) — KySigned public MIT-licensed core library. Blockchain-verified e-signatures on Base. Contains API handlers (`src/api/`), smart contracts (`contracts/SignatureRegistry.sol`, `contracts/EvidenceKeyRegistry.sol`), zk-email circuits (`circuits/kysigned-approval.circom`), MCP server (`mcp/`), and verification scripts. Clone: `gh repo clone kychee-com/kysigned`
- **kychee-com/kysigned-private** (private) — KySigned hosted service at kysigned.com. Wires the core library to run402 infrastructure via three Lambdas (`kysigned-api`, `kysigned-email-webhook`, `kysigned-sweep`). Contains route dispatch, email templates, deployment scripts, and brand assets. Clone: `gh repo clone kychee-com/kysigned-private`
- **kychee-com/run402** — Run402 MCP server (npm: `run402-mcp`, v0.2.0). See the MCP Server section below.

## Project lifecycle (soft-delete grace)

A project whose wallet tier lease expires no longer dies in 7 silent days. It moves through a ~104-day soft-delete state machine, and the end-user data plane (live site, PostgREST, email) keeps serving throughout. Only the owner's **control plane** (deploys, secret rotation, subdomain claims, function upload, billing-plumbing writes) gets gated.

```
 active ──lease_exp──▶ past_due ──+14d──▶ frozen ──+30d──▶ dormant ──+60d──▶ purged
   ▲                       │                  │                │
   └────────renewal / topup / tier upgrade────┴────────────────┘
```

| State | Control plane | Data plane | Scheduled (cron) fns | Subdomain |
|---|---|---|---|---|
| `active` | read+write | read+write | running | claimed by project |
| `past_due` | read+write | read+write | running | claimed by project |
| `frozen` | **402** | read+write | running | **reserved for the owner's wallet** |
| `dormant` | **402** | read+write | **paused** | reserved |
| `purged` | terminal | terminal | terminal | claimable 14 days after purge |

The legacy `archived` status is preserved for rows that died under the old 7-day regime. Legacy archived rows have no recoverable data, but `purgeProject` / `getProjectById` treat them as equivalent to `purged`.

**Emails** (three, sent from `billing@mail.run402.com` via `sendPlatformEmail`):
- `project_past_due` — fired on entry to `past_due`; says site is unaffected, names the frozen date.
- `project_frozen` — fired on entry to `frozen`; says control-plane writes are blocked, names the dormant date.
- `project_purge_final_warning` — fired 24h before `scheduled_purge_at`; final chance to renew.

Inline templates live in `packages/gateway/src/services/project-lifecycle.ts`.

**Scheduler:** `services/leases.ts` runs `advanceLifecycle()` from `services/project-lifecycle.ts` once per hour. Each transition uses `UPDATE ... WHERE status = <prev> AND <timer> < NOW() - <threshold> RETURNING id` so two concurrent ticks can't both act on the same row. The `dormant → purging → purged` path uses an intermediate `purging` status as a race guard; failure reverts to `dormant` so a later tick can retry.

**Reactivation** happens inline after tier subscribe/renew/upgrade (see `services/wallet-tiers.ts` post-commit `advanceLifecycleForWallet(wallet)` hook). An owner who just paid does not wait up to an hour to regain control-plane access.

**Pinned projects** (`pinned = true`) bypass the state machine entirely — same as before. This remains the run402-admin-only escape hatch for projects that should never auto-archive.

**Feature flag:** `LIFECYCLE_ENABLED` env var (default `true`). Flip to `false` for incident-response rollback — `advanceLifecycle`, `advanceLifecycleForProject`, and `advanceLifecycleForWallet` all early-return. The hourly tick still fires but does nothing; projects whose leases expired while the flag was off will transition on the next tick after it flips back on.

**Operator endpoints** (admin-key only, not in `llms.txt` / `openapi.json`):
- `POST /projects/v1/admin/:id/reactivate` — force-transition a grace-state project back to `active`, clearing timer columns and subdomain reservations in one transaction. Returns `409` on `purged` / `archived` (terminal, no data to restore).
- `POST /subdomains/v1/admin/:name/release` — clear a subdomain's lifecycle reservation so a different wallet can claim the name. Use for dispute resolution when the reserved owner can't be reached.

**Where to apply `lifecycleGate`** (add to new mutating routes using the three-category rule):
- **Control plane** → add the gate. Deploys, subdomain claims, secrets, function upload, custom domain bind, mailbox create, publish-new-version, etc.
- **Payment path** → **never** gate. An owner in grace must pay their way out; gating these blocks the x402/Stripe payment handshake. Off-limits: `POST /tiers/v1/:tier`, all of `/billing/v1/*`, `/webhooks/v1/*`, `/faucet/v1`.
- **Data plane** → never gate. End users keep working during grace. Covers `/rest/v1/*` (PostgREST), `/storage/v1/*`, `/functions/v1/:name` invocation, `/auth/v1/*` tenant user auth, email send/receive.

## KMS contract wallets

The `/contracts/v1/*` feature signs Ethereum transactions via AWS KMS-backed keys (one KMS key per wallet, ECC_SECG_P256K1, SIGN_VERIFY). Private keys never leave KMS — there is intentionally no `kms:Decrypt` or `kms:GetParametersForImport` in the gateway role.

**RPC URL secrets:** `run402/base-mainnet-rpc-url` and `run402/base-sepolia-rpc-url` in AWS Secrets Manager (us-east-1, profile `kychee`). Both default to the public Base RPCs (`https://mainnet.base.org`, `https://sepolia.base.org`). To rotate to a paid provider:

```
AWS_PROFILE=kychee aws secretsmanager update-secret \
  --secret-id run402/base-mainnet-rpc-url \
  --secret-string "https://base-mainnet.g.alchemy.com/v2/<KEY>" \
  --region us-east-1
# Then force a task restart so the new value is picked up:
AWS_PROFILE=kychee aws ecs update-service --cluster <cluster> --service <svc> --force-new-deployment --region us-east-1
```

**IAM verification:** the gateway role `AgentDB-Pod01-TaskDefTaskRole1EDB4A67-XTUia2at8urw` should have the `Run402KmsContractWallets` policy statement granting `kms:CreateKey`, `kms:GetPublicKey`, `kms:Sign`, `kms:DescribeKey`, `kms:TagResource`, `kms:ListResourceTags`, `kms:ScheduleKeyDeletion`, `kms:CancelKeyDeletion` — and **NOT** `kms:Decrypt` or `kms:GetParametersForImport`. Verify via `aws iam simulate-principal-policy`.

**Pricing knobs (do not change without updating ALL pricing surfaces — see Phase 16 of openspec/changes/kms-wallet-contracts):** $0.04/day rental (`KMS_WALLET_RENT_USD_MICROS_PER_DAY = 40_000` in `packages/gateway/src/services/contract-wallets.ts`), $0.000005/call sign fee (`KMS_SIGN_FEE_USD_MICROS = 5` in `services/contract-call-reconciler.ts`), 30-day prepay = $1.20 (`PREPAY_REQUIRED_USD_MICROS` in `routes/contracts.ts`).

## Admin Finance dashboard

The `/admin/finance` tab is an internal reporting view for `@kychee.com` operators. It shows platform revenue, cost, and margin, plus per-project breakdowns and per-category cost with drift detection.

**Tables:**
- `internal.cost_rates` — pricing constants used for counter-derived direct cost (SES, Lambda, S3, KMS). Seeded by v1.21 migration from hardcoded defaults.
- `internal.aws_cost_cache` — daily-refreshed AWS Cost Explorer response cache, keyed by `(day, service_category)`.

**Background job:**
The `runDailyCostFetcher()` function pulls from AWS Cost Explorer once per 24 hours. It runs on the same scheduler tick as the KMS contract-call reconciler. Guarded by `latestFetchedAt < NOW() - 24h`; earlier runs are no-ops. Calls `ce:GetCostAndUsage` with `DAILY` granularity grouped by `SERVICE`, maps each AWS service name to a run402 category via the hardcoded map in `packages/gateway/src/services/aws-cost-fetcher.ts`.

**Manual operator actions (from the Finance tab UI):**
- **Refresh now** — hits `POST /admin/api/finance/refresh-costs`, bypasses the 24h guard, rate-limited to 1 call per 60 seconds per gateway instance. Use after a deploy to populate an empty cache.
- **Update pricing from AWS** — hits `POST /admin/api/finance/refresh-pricing`, calls the AWS Pricing API for each cost category (SES, Lambda request, Lambda GB-sec, S3, KMS monthly, KMS sign), writes changes back to `internal.cost_rates`. Use when AWS raises a rate and the drift warning banner appears.

**Drift warning:**
When counter-derived direct cost (computed from our usage counters × `cost_rates`) differs from AWS Cost Explorer's billed total for the same categories (KMS, SES, Lambda, S3) by more than 5%, a yellow warning banner appears on the Finance tab. The fix is usually to click "Update pricing from AWS". If the drift persists after refreshing, investigate usage counter accuracy (the metering middleware in `packages/gateway/src/middleware/metering.ts`).

**Cost Explorer unavailable:**
The Finance tab gracefully degrades — the cost and margin KPI cards show "—" with a "Cost Explorer cache empty — refresh below" hint. Revenue is still displayed (it comes from our own ledger, not AWS). Common causes: missing IAM permission (`ce:GetCostAndUsage`), Cost Explorer API outage, or freshly-deployed gateway with no cached data yet (the 24h cron hasn't fired).

**Adding a new cost category to the service-to-category mapping:**
Edit `SERVICE_TO_CATEGORY` in `packages/gateway/src/services/aws-cost-fetcher.ts`. Add the AWS service name (exactly as it appears in Cost Explorer's `SERVICE` dimension — use the AWS console to confirm) as a key, and the run402 display category as the value. Redeploy. The next daily cron will pick up the new category automatically; old "Other shared" entries for that service will be reclassified on the next upsert for the same `(day, service_category)` key.

**Adding a new revenue stream column to the breakdown table:**
Edit the `topup_type` discriminator in `packages/gateway/src/services/finance-rollup.ts` → `getRevenueBreakdownByProject()`. Add a new `SUM(CASE WHEN ...) AS <col>` clause, then add the matching column to the frontend render in `admin-finance-html.ts`. Backward-compat note: existing rows use `topup_type IN ('cash', 'tier', 'email_pack')`; new discriminators need a value in the `billing_topups.topup_type` CHECK constraint allowlist (see v1.19 migration in `server.ts`).

**IAM:**
Gateway task role needs `ce:GetCostAndUsage` and `pricing:GetProducts` (both account-level, no resource ARN). Added in the `Run402AdminFinanceReadOnly` policy statement in `infra/lib/pod-stack.ts`. Verify deployed perms: `aws iam simulate-principal-policy --policy-source-arn <role-arn> --action-names ce:GetCostAndUsage pricing:GetProducts`.

## MCP Server

The Run402 MCP server is published at https://github.com/kychee-com/run402 (npm: `run402-mcp`, v0.2.0). It exposes 52 tools covering setup/billing, projects, database, deployment, subdomains, functions, storage, apps, and more. Install: `npx run402-mcp`. Config and docs are in the separate `kychee-com/run402-mcp` repo. See AGENTS.md for the full tool list.

## Lint & Type Check

Run `npm run lint` and `npx tsc --noEmit -p packages/gateway` before committing gateway changes. ESLint catches style issues but not missing imports or type errors — only `tsc` catches those.

## Shell Commands

Never use `$()` command substitution or heredocs with `$(cat <<...)` in Bash calls. Instead:
- Run commands separately and use the literal output values in subsequent calls.
- For git commits, use a simple single-line `-m` flag or multiple `-m` flags for multi-line messages.
This avoids permission prompts from the harness.

## Deployment

### Gateway (API)

**Normal path:** Push to `main`. The GitHub Action `.github/workflows/deploy-gateway.yml` builds the Docker image, pushes to ECR, and redeploys ECS automatically.

**Manual/emergency:** `./scripts/deploy.sh` does the same thing locally via colima/buildx. Prompts for confirmation (pass `-y` to skip). Only use when CI is broken or you need a hotfix without pushing.

### Lambda Layer (functions runtime)

The `@run402/functions` helper (`db.from()`, `db.sql()`, `getUser()`, `email.send()`, `ai.translate()`, `ai.moderate()`) ships as a Lambda layer, separate from the gateway Docker image. Changing `packages/functions-runtime/**` requires rebuilding and publishing the layer:

1. Build + publish: `cd packages/functions-runtime && AWS_PROFILE=kychee ./build-layer.sh --publish`
2. Update `LAMBDA_LAYER_ARN` in `infra/lib/pod-stack.ts` with the new ARN
3. Redeploy CDK: `cd infra && eval "$(aws configure export-credentials --profile kychee --format env)" && npx cdk deploy AgentDB-Pod01 --require-approval never`

Current layer: `arn:aws:lambda:us-east-1:472210437512:layer:run402-functions-runtime:8` (hardcoded in pod-stack.ts)

**Important:** The gateway CI workflow does NOT rebuild the Lambda layer. If you change `build-layer.sh` or the functions runtime and only push to main, the gateway will deploy with the old layer. Always publish the layer first.

### Custom Subdomains CDN ({name}.run402.com)

Custom subdomains use a CloudFront distribution with a KeyValueStore (KVS) for edge routing. Static assets (CSS, JS, images, fonts) are served from CloudFront edge locations with immutable caching. HTML requests fall through to the ALB gateway for fork badge injection.

**KVS sync:** The gateway automatically updates the KVS on subdomain claim/delete. A reconciliation job runs every 5 minutes to fix drift. Config: `CLOUDFRONT_KVS_ARN` env var.

**Cache invalidation:** On subdomain reassignment (redeploy), the gateway calls `CreateInvalidation` to purge the edge cache so new assets are served immediately. Config: `CLOUDFRONT_CUSTOM_DISTRIBUTION_ID` env var.

**Seed script:** To populate KVS from scratch: `CLOUDFRONT_KVS_ARN=<arn> DATABASE_URL=<url> npx tsx scripts/seed-kvs.ts`

**CDK stack:** `Run402-CustomSubdomains` in `infra/lib/custom-subdomains-stack.ts`

**Testing:** `BASE_URL=https://api.run402.com npx tsx test/cdn-e2e.ts` — tests asset caching, HTML routing, redeploy freshness, and subdomain delete. Takes ~2 min (KVS propagation polling).

### Site (run402.com landing page)

**Content updates:** Push changes under `site/` to `main`. The GitHub Action `.github/workflows/deploy-site.yml` syncs to S3 and invalidates CloudFront.

**Infra changes (S3 bucket, CloudFront distribution):** `./scripts/cdk-deploy.sh` runs `cdk deploy` for the Site stack. Rarely needed.

### Demos

Each demo under `demos/` has its own `deploy.ts` that provisions a Run402 project, sets secrets, deploys the function + site, and claims a subdomain:

- `demos/evilme/deploy.ts` → evilme.run402.com
- `demos/cosmicforge/deploy.ts` → cosmic.run402.com

Run with `npx tsx demos/<name>/deploy.ts`. Requires `BUYER_PRIVATE_KEY`, `OPENAI_API_KEY`, and `ADMIN_KEY` in `.env`.

## Local Development

### Starting the local server

1. Start Postgres: `docker run -d --name run402-postgres -p 5432:5432 -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=agentdb -v ./packages/gateway/src/db/init.sql:/docker-entrypoint-initdb.d/init-db.sql postgres:16`
2. Start PostgREST: `docker run -d --name run402-postgrest -p 3000:3000 -e PGRST_DB_URI="postgres://authenticator:authenticator@<postgres-ip>:5432/agentdb" -e MAX_SCHEMA_SLOTS=2000 -e PGRST_DB_ANON_ROLE=anon -e 'PGRST_JWT_SECRET=super-secret-jwt-key-for-agentdb-test-only-32chars!!' -e PGRST_DB_PRE_REQUEST=internal.pre_request --entrypoint /bin/sh postgrest/postgrest:v12.2.3 -ec 'schema_list=""; i=1; while [ "$i" -le "${MAX_SCHEMA_SLOTS:-2000}" ]; do schema="$(printf "p%04d" "$i")"; if [ -n "$schema_list" ]; then schema_list="$schema_list,$schema"; else schema_list="$schema"; fi; i=$((i + 1)); done; export PGRST_DB_SCHEMAS="$schema_list"; exec postgrest'` (get postgres IP via `docker inspect run402-postgres --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}'`)
3. Start gateway: `npm run dev`

### ESM dotenv loading

The dev script uses `tsx --env-file=../../.env` (in `packages/gateway/package.json`) to load `.env` from the repo root. This is necessary because ESM hoists static `import` statements before top-level `await`, so `config.ts` reads `process.env.*` before `await import("dotenv/config")` runs. The `--env-file` flag loads env vars at the Node.js level before any module evaluation.

### Local function execution

When `LAMBDA_ROLE_ARN` is not set (local dev), the gateway runs edge functions in-process instead of deploying to AWS Lambda. User code is written to disk as `.mjs` files with the `@run402/functions` helper (db client) inlined, then executed via dynamic `import()`. The `db.from()` calls route back to `localhost:4022/rest/v1/...` via PostgREST. This covers most logic but won't catch Lambda runtime/permissions issues.

### Required `.env` vars for full local testing

- `SELLER_ADDRESS` — x402 seller wallet (fetch from `agentdb/seller-wallet` in Secrets Manager)
- `CDP_API_KEY_ID` / `CDP_API_KEY_SECRET` — x402 facilitator auth (fetch from `agentdb/cdp-api-key` in Secrets Manager)
- `BUYER_PRIVATE_KEY` — test buyer wallet (already in `.env`)
- `ADMIN_KEY` — admin operations (already in `.env`)

Without `SELLER_ADDRESS` + CDP keys, x402 payment middleware won't initialize and payment-gated endpoints (tiers, projects) will fail.

## Testing

### Test commands

| Command | What it tests |
|---------|--------------|
| `npm run test:e2e` | Full 23-step lifecycle test (workout tracker). Needs `BASE_URL`. |
| `npm run test:bld402-compat` | bld402 template compatibility — 3 templates (shared-todo, paste-locker, landing-waitlist). Needs `BASE_URL`. |
| `npm run test:openclaw` | OpenClaw integration E2E |
| `npm run test:docs` | API docs alignment |
| `npm run test:siwx` | SIWx auth unit tests |
| `npm run test:functions` | Functions lifecycle E2E |
| `npm run test:ai` | AI helpers E2E |
| `npm run test:billing` | Billing/tiers E2E |
| `npm run test:email` | Email helpers E2E |
| `npm run test:mailbox` | Mailbox service unit tests |
| `npm run test:subdomains` | Subdomains service unit tests |
| `npm run test:contact` | Contact route unit tests |
| `npm run test:admin-sql` | Admin SQL route unit tests |
| `npm run test:sql` | SQL module unit tests |
| `npm run test:unit` | Gateway unit tests |
| `npm run test:unit:coverage` | Gateway unit tests with coverage |
| `npx tsx test/cdn-e2e.ts` | CDN edge caching for custom subdomains. Needs `BASE_URL`. ~2 min. |

### Running tests locally vs production

- **Local:** `npm run test:bld402-compat` (uses `BASE_URL=http://localhost:4022` default)
- **Production:** `BASE_URL=https://api.run402.com npm run test:bld402-compat`

The `/deploy` skill runs both `test:e2e` and `test:bld402-compat` against production after deployment.

## Bugsnag

Error monitoring is integrated in the Express gateway (`packages/gateway/src/server.ts`).

- **Project:** Run402 (project ID: `69ac52c4c1424e001a97f2c5`)
- **API key** (notifier): `0751ea52d07c1449d7cd2f7724de0ede` (also in `BUGSNAG_API_KEY` env var)
- **Auth token** (REST API): stored in AWS Secrets Manager as `eleanor/bugsnag-api-token`

### Querying errors via the API

Fetch the auth token:
```
AWS_PROFILE=kychee aws secretsmanager get-secret-value --secret-id eleanor/bugsnag-api-token --region us-east-1 --query SecretString --output text
```

List errors:
```
curl -s -H "Authorization: token <AUTH_TOKEN>" "https://api.bugsnag.com/projects/69ac52c4c1424e001a97f2c5/errors"
```

List events for a specific error:
```
curl -s -H "Authorization: token <AUTH_TOKEN>" "https://api.bugsnag.com/projects/69ac52c4c1424e001a97f2c5/errors/<ERROR_ID>/events"
```

## External alarms (CloudWatch → Telegram)

Four CloudWatch alarms fire when the gateway exhibits a liveness failure. Each alarm publishes to the `run402-alarms` SNS topic, which invokes the `Run402-AlarmRelay` Lambda, which posts to the same Telegram chat used by the gateway's own notifications.

**Alarms (all `period=1min`, `evaluationPeriods=2`, `datapointsToAlarm=2`, `treatMissingData=NOT_BREACHING`):**

| Alarm | Metric | Threshold | Catches |
|---|---|---|---|
| `Run402GatewayMemoryHigh` | ECS `MemoryUtilization` (Max) | `> 80%` | memory pressure before OOM |
| `Run402GatewayTaskCountLow` | ECS `RunningTaskCount` (Max) | `< 1` | gateway is down |
| `Run402AlbTargetUnhealthy` | ALB `UnHealthyHostCount` (Max) | `>= 1` | ALB can't reach gateway |
| `Run402Alb5xxBurst` | ALB `HTTPCode_Target_5XX_Count` (Sum) | `> 10` | app-level 5xx waves |

**Telegram credentials:** The `Run402-AlarmRelay` Lambda reads `agentdb/telegram-bot` from Secrets Manager (same secret the gateway uses). Rotating the bot token updates both consumers on their next invocation — no Lambda redeploy required.

**Console:** https://console.aws.amazon.com/cloudwatch/home?region=us-east-1#alarmsV2:

**Manual test (flip alarm state to verify Telegram delivery):**
```
AWS_PROFILE=kychee aws cloudwatch set-alarm-state \
  --alarm-name Run402GatewayMemoryHigh \
  --state-value ALARM --state-reason "manual test" --region us-east-1
```
Telegram message should arrive within ~10 seconds. Flip back to `OK` to test the recovery message (✅ prefix).

**Infra:** CDK definitions live in `infra/lib/pod-stack.ts` alongside the ECS service. Lambda source: `infra/alarm-relay/`.
