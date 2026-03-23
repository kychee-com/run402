## 1. Service helpers for cascade cleanup

- [x] 1.1 Add `deleteProjectFunctions(projectId)` to `packages/gateway/src/services/functions.ts` — query `internal.functions` for all functions in the project, call AWS `DeleteFunctionCommand` for each (skip if no `LAMBDA_ROLE_ARN` / local dev), delete DB rows. Log warnings on per-function failures, don't throw.
- [x] 1.2 Add `deleteProjectSubdomains(projectId)` to `packages/gateway/src/services/subdomains.ts` — query `internal.subdomains` for all subdomains in the project, call existing Route 53 cleanup for each, delete DB rows. Log warnings on per-subdomain failures, don't throw.
- [x] 1.3 Add `deleteProjectDeployments(projectId)` to `packages/gateway/src/services/deployments.ts` — query `internal.deployments` for all deployments in the project, batch-delete S3 objects under `sites/{deployment_id}/` using `DeleteObjectsCommand`, delete DB rows. Log warnings on failures, don't throw.

## 2. Extend archiveProject with cascade steps

- [x] 2.1 In `archiveProject()` in `packages/gateway/src/services/projects.ts`, add cascade cleanup steps before the existing schema drop: call `deleteProjectFunctions()`, `deleteProjectSubdomains()`, `deleteProjectDeployments()`
- [x] 2.2 Add direct DB deletes for tables without external resources: `DELETE FROM internal.secrets WHERE project_id = $1`, `DELETE FROM internal.app_versions WHERE project_id = $1`, `DELETE FROM internal.oauth_transactions WHERE project_id = $1`
- [x] 2.3 Wrap each cleanup step in try/catch with `console.error` warning — ensure a single failure doesn't abort the archive

## 3. Tests

- [x] 3.1 E2E test: create a project, deploy functions + site + subdomain, delete the project, verify Lambda functions are gone (invoke returns 404), subdomain is released (can be reclaimed), and DB rows are cleaned up
- [x] 3.2 E2E test: create a project with no resources, delete it, verify it archives cleanly (no errors from empty cleanup steps)
