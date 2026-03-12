# /deploy — Test, Commit, Push, Deploy, Verify

Full deployment pipeline: run all pre-flight checks, commit, push to main, monitor CI/CD, and verify production.

## Instructions

Execute the following steps in order. Stop and report if any step fails. Do NOT ask the user for confirmation at any point — run the entire pipeline autonomously.

### Step 1: Pre-flight checks (run in parallel)

Run all of these simultaneously:

1. **Lint**: `npm run lint`
2. **Type-check**: `npx tsc --noEmit -p packages/gateway`
3. **Docs alignment**: `npm run test:docs`
4. **Unit tests**: `node --experimental-test-module-mocks --test --import tsx packages/gateway/src/services/subdomains.test.ts`

If any fail, stop and fix the issues before proceeding. Do NOT skip failures.

### Step 2: Commit and push

1. Run `git status` and `git diff --stat` to review what changed
2. Stage the relevant files (NOT `.env`, credentials, or large binaries)
3. Commit with a descriptive message
4. Push to `main`

### Step 3: Determine which CI workflows will trigger

Based on the files changed, tell the user which workflows will run:
- Changes in `packages/shared/**` or `packages/gateway/**` → **Deploy Gateway** workflow
- Changes in `site/**` → **Deploy Site** workflow
- Changes elsewhere → no deployment (tests-only push)

If no deployment workflow will trigger, skip to Step 6 and report "No deployment needed — push complete."

### Step 4: Monitor CI/CD

1. Use `gh run list --workflow=deploy-gateway.yml --limit=1` or `gh run list --workflow=deploy-site.yml --limit=1` (whichever is relevant) to find the run
2. Poll with `gh run view <run-id>` until it completes (check every 30 seconds, max 10 minutes)
3. If the workflow fails, run `gh run view <run-id> --log-failed` to get the failure logs and report them

### Step 5: Health check

After the gateway workflow succeeds, verify the deployment is live:

```bash
curl -s https://api.run402.com/health
```

Confirm the response shows `"status": "healthy"`. If not, wait 30 seconds and retry once.

### Step 6: Production E2E test

If gateway was deployed, run the production end-to-end test:

```bash
BASE_URL=https://api.run402.com npm run test:e2e
```

This runs the full 23-step workout tracker lifecycle test against production. It takes ~2 minutes and costs ~$0.30 in testnet USDC.

Report the results. If any step fails, provide the specific failure details.

### Step 7: Summary

Report a final summary:
- Pre-flight: pass/fail
- Commit: hash and message
- CI/CD: workflow name, status, duration
- Health: healthy/unhealthy
- E2E: pass/fail (with step count)
