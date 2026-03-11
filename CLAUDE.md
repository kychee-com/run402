# CLAUDE.md

## MCP Server

The Run402 MCP server is published at https://github.com/kychee-com/run402-mcp (npm: `run402-mcp`, v0.2.0). It exposes `provision_postgres_project`, `run_sql`, `rest_query`, `upload_file`, `renew_project`, `deploy_site`, `claim_subdomain`, `delete_subdomain` as MCP tools. Install: `npx run402-mcp`. Config and docs are in the separate `kychee-com/run402-mcp` repo.

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

### Site (run402.com landing page)

**Content updates:** Push changes under `site/` to `main`. The GitHub Action `.github/workflows/deploy-site.yml` syncs to S3 and invalidates CloudFront.

**Infra changes (S3 bucket, CloudFront distribution):** `./scripts/cdk-deploy.sh` runs `cdk deploy` for the Site stack. Rarely needed.

### Demos

Each demo under `demos/` has its own `deploy.ts` that provisions a Run402 project, sets secrets, deploys the function + site, and claims a subdomain:

- `demos/evilme/deploy.ts` → evilme.run402.com
- `demos/cosmicforge/deploy.ts` → cosmic.run402.com

Run with `npx tsx demos/<name>/deploy.ts`. Requires `BUYER_PRIVATE_KEY`, `OPENAI_API_KEY`, and `ADMIN_KEY` in `.env`.

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
