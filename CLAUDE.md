# CLAUDE.md

## MCP Server

The Run402 MCP server is published at https://github.com/kychee-com/run402-mcp (npm: `run402-mcp`, v0.2.0). It exposes 52 tools covering setup/billing, projects, database, deployment, subdomains, functions, storage, apps, and more. Install: `npx run402-mcp`. Config and docs are in the separate `kychee-com/run402-mcp` repo. See AGENTS.md for the full tool list.

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

The `@run402/functions` helper (`db.from()`, `db.sql()`, `getUser()`) ships as a Lambda layer, separate from the gateway Docker image. Changing `packages/functions-runtime/**` requires rebuilding and publishing the layer:

1. Build + publish: `cd packages/functions-runtime && AWS_PROFILE=kychee ./build-layer.sh --publish`
2. Update `LAMBDA_LAYER_ARN` in `infra/lib/pod-stack.ts` with the new ARN
3. Redeploy CDK: `cd infra && eval "$(aws configure export-credentials --profile kychee --format env)" && npx cdk deploy AgentDB-Pod01 --require-approval never`

Current layer: `arn:aws:lambda:us-east-1:472210437512:layer:run402-functions-runtime:2` (hardcoded in pod-stack.ts)

**Important:** The gateway CI workflow does NOT rebuild the Lambda layer. If you change `build-layer.sh` or the functions runtime and only push to main, the gateway will deploy with the old layer. Always publish the layer first.

### Custom Subdomains CDN ({name}.run402.com)

Custom subdomains use a CloudFront distribution with a KeyValueStore (KVS) for edge routing. Static assets (CSS, JS, images, fonts) are served from CloudFront edge locations with immutable caching. HTML requests fall through to the ALB gateway for fork badge injection.

**KVS sync:** The gateway automatically updates the KVS on subdomain claim/delete. A reconciliation job runs every 5 minutes to fix drift. Config: `CLOUDFRONT_KVS_ARN` env var.

**Seed script:** To populate KVS from scratch: `CLOUDFRONT_KVS_ARN=<arn> DATABASE_URL=<url> npx tsx scripts/seed-kvs.ts`

**CDK stack:** `Run402-CustomSubdomains` in `infra/lib/custom-subdomains-stack.ts`

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
2. Start PostgREST: `docker run -d --name run402-postgrest -p 3000:3000 -e PGRST_DB_URI="postgres://authenticator:authenticator@<postgres-ip>:5432/agentdb" -e PGRST_DB_SCHEMAS="p0001,p0002,p0003,p0004,p0005,p0006,p0007,p0008,p0009,p0010" -e PGRST_DB_ANON_ROLE=anon -e 'PGRST_JWT_SECRET=super-secret-jwt-key-for-agentdb-test-only-32chars!!' -e PGRST_DB_PRE_REQUEST=internal.pre_request postgrest/postgrest:v12.2.3` (get postgres IP via `docker inspect run402-postgres --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}'`)
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
| `npm run test:docs` | API docs alignment |
| `npm run test:siwx` | SIWx auth unit tests |
| `npm run test:functions` | Functions lifecycle E2E |
| `npm run test:billing` | Billing/tiers E2E |

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
