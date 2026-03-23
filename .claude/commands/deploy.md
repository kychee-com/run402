# /deploy — Test, Commit, Push, Deploy, Verify

Full deployment pipeline: run all pre-flight checks, commit, push to main, deploy ALL affected components, and verify production.

## Deployment surfaces

Run402 has four independently deployable components. Each has its own trigger:

| Component | Trigger files | How it deploys |
|-----------|--------------|----------------|
| **Gateway** (API on ECS) | `packages/shared/**`, `packages/gateway/**` | CI: push to main → GitHub Actions builds Docker, pushes to ECR, redeploys ECS |
| **Lambda layer** (functions runtime) | `packages/functions-runtime/**` | Manual: `build-layer.sh --publish` → new layer version → update `LAMBDA_LAYER_ARN` in CDK + redeploy ECS task def |
| **Site** (run402.com) | `site/**` | CI: push to main → GitHub Actions syncs S3, invalidates CloudFront |
| **Infra** (CDK stacks) | `infra/**` | Manual: `cdk deploy` |

A single commit can touch multiple components. The deploy command MUST handle ALL of them.

## Instructions

Execute the following steps in order. Stop and report if any step fails. Do NOT ask the user for confirmation at any point — run the entire pipeline autonomously.

### Step 1: Pre-flight checks (run in parallel)

Run all of these simultaneously:

1. **Lint**: `npm run lint`
2. **Type-check**: `npx tsc --noEmit -p packages/gateway`
3. **Docs alignment**: `npm run test:docs`
4. **Unit tests**: `node --experimental-test-module-mocks --test --import tsx packages/gateway/src/services/subdomains.test.ts`
5. **Style guide check**: Read `docs/style.md` and validate that route files (`packages/gateway/src/routes/*.ts`, `server.ts`, `middleware/x402.ts`) comply with every rule in that doc. Flag and fix any violations.

If any fail, stop and fix the issues before proceeding. Do NOT skip failures.

### Step 2: Commit and push

1. Run `git status` and `git diff --stat` to review what changed
2. Stage the relevant files (NOT `.env`, credentials, or large binaries)
3. Commit with a descriptive message
4. Push to `main`

### Step 3: Determine what needs deploying

Examine ALL files in the commit (use `git diff --name-only HEAD~1`). Set these flags:

- **deploy_gateway** = true if any file matches `packages/shared/**` or `packages/gateway/**`
- **deploy_lambda_layer** = true if any file matches `packages/functions-runtime/**`
- **deploy_site** = true if any file matches `site/**`
- **deploy_infra** = true if any file matches `infra/**`

Report which components will be deployed. If nothing needs deploying, skip to Step 7 and report "No deployment needed — push complete."

### Step 4a: Deploy Lambda layer (if deploy_lambda_layer)

The Lambda layer is a separate artifact from the gateway Docker image. It must be rebuilt and published BEFORE the gateway deploys, so the new gateway can reference the new layer version.

1. **Build and publish the layer**:
```bash
cd packages/functions-runtime && AWS_PROFILE=kychee ./build-layer.sh --publish
```
This outputs a new layer ARN like `arn:aws:lambda:us-east-1:472210437512:layer:run402-functions-runtime:3`.

2. **Update the layer ARN in CDK** — edit `infra/lib/pod-stack.ts` and replace the old `LAMBDA_LAYER_ARN` value with the new ARN.

3. **Deploy the CDK stack** to update the ECS task definition with the new layer ARN:
```bash
cd infra && eval "$(aws configure export-credentials --profile kychee --format env)" && npx cdk deploy AgentDB-Pod01 --require-approval never
```

4. Set **deploy_infra** = false (already handled) and **deploy_gateway** = true (CDK deploy updates the task def, but a gateway deploy will force a new ECS deployment with the latest image too).

### Step 4b: Deploy infra (if deploy_infra and not already done in 4a)

```bash
cd infra && eval "$(aws configure export-credentials --profile kychee --format env)" && npx cdk deploy AgentDB-Pod01 --require-approval never
```

### Step 4c: Monitor CI/CD (if deploy_gateway or deploy_site)

CI workflows are triggered automatically by the push to main:

1. If **deploy_gateway**: use `gh run list --workflow=deploy-gateway.yml --limit=1` to find the run
2. If **deploy_site**: use `gh run list --workflow=deploy-site.yml --limit=1` to find the run
3. Poll each with `gh run view <run-id>` until it completes (check every 30 seconds, max 10 minutes)
4. If a workflow fails, run `gh run view <run-id> --log-failed` to get the failure logs and report them

### Step 5: Health check

After the gateway deploys (via CI or CDK), verify the deployment is live:

```bash
curl -s https://api.run402.com/health
```

Confirm the response shows `"status": "healthy"`. If not, wait 30 seconds and retry once.

### Step 6: Production E2E tests

If gateway or Lambda layer was deployed, run these production tests sequentially:

1. **E2E test**:
```bash
BASE_URL=https://api.run402.com npm run test:e2e
```
This runs the full 23-step workout tracker lifecycle test against production. It takes ~2 minutes and costs ~$0.30 in testnet USDC.

2. **bld402 compatibility test**:
```bash
BASE_URL=https://api.run402.com npm run test:bld402-compat
```
This tests 3 bld402 templates (shared-todo, paste-locker, landing-waitlist) against the run402 API. It takes ~1 minute and verifies that run402 changes don't break bld402.com.

3. **Functions test** (if Lambda layer was deployed):
```bash
BASE_URL=https://api.run402.com npm run test:functions
```
This tests the full functions lifecycle including `db.sql()` and `db.from()`.

Report the results of all tests. If any step fails, provide the specific failure details.

### Step 7: Summary

Report a final summary:
- Pre-flight: pass/fail
- Commit: hash and message
- Components deployed: list which of [Gateway, Lambda layer, Site, Infra] were deployed
- CI/CD: workflow name(s), status, duration
- Lambda layer: new ARN (if published)
- Health: healthy/unhealthy
- E2E: pass/fail (with step count)
- bld402 compat: pass/fail (with step count)
- Functions: pass/fail (if run)
