## 1. Service Layer

- [x] 1.1 Add `inherit?: boolean` to `DeploymentRequest` interface in `deployments.ts`
- [x] 1.2 Add `CopyObjectCommand` import from `@aws-sdk/client-s3`
- [x] 1.3 Add `getPreviousDeploymentId(projectId: string)` helper — queries `internal.deployments` for the most recent deployment for a project, returns deployment_id or null
- [x] 1.4 In `createDeployment()`, when `inherit` is true and a previous deployment exists: list all S3 objects under `sites/{prev_id}/`, then for each file NOT in the uploaded set, CopyObject to `sites/{new_id}/`. Track inherited file count and size in totals.
- [x] 1.5 Local dev fallback: when no S3, copy files from old deployment directory using `copyFileSync`

## 2. Route Layer

- [x] 2.1 In `routes/deployments.ts`, accept `inherit` from request body and pass to `createDeployment()`. Allow empty `files` array when `inherit` is true.
- [x] 2.2 In `services/bundle.ts`, pass `inherit` from bundle request through to `createDeployment()`

## 3. Docs

- [x] 3.1 Add `inherit` option to `site/llms.txt` deploy documentation

## 4. Tests

- [x] 4.1 Add E2E test: deploy a site, then redeploy with `inherit: true` and only one changed file — verify the unchanged files are still served from the new deployment
