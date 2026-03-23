## Why

Deleting (archiving) a project only drops the Postgres schema and clears users/tokens. Lambda functions, secrets, subdomains, S3 site files, deployments, and published app versions are all orphaned. This leaks AWS resources (Lambda functions, S3 objects), blocks subdomain reuse, and leaves ghost app versions forkable in the marketplace.

## What Changes

- Extend `archiveProject()` to cascade-delete all project-owned resources before marking the project archived
- Delete Lambda functions from AWS and from `internal.functions`
- Delete project secrets from `internal.secrets`
- Release subdomains from `internal.subdomains` (and Route 53)
- Delete site deployments from S3 and from `internal.deployments`
- Delete published app versions from `internal.app_versions`
- Delete OAuth transactions from `internal.oauth_transactions`

## Capabilities

### New Capabilities
- `cascade-project-delete`: Full cascade cleanup when a project is deleted — covers Lambda functions, secrets, subdomains, S3 site files, deployments, published app versions, and OAuth transactions

### Modified Capabilities

(none — no existing spec-level behavior changes)

## Impact

- **`packages/gateway/src/services/projects.ts`**: `archiveProject()` gains cascade cleanup steps
- **`packages/gateway/src/services/functions.ts`**: Need a `deleteFunctionsByProject()` helper (calls AWS `DeleteFunctionCommand` for each)
- **`packages/gateway/src/services/subdomains.ts`**: Need `deleteSubdomainsByProject()` helper (deletes Route 53 records + DB rows)
- **`packages/gateway/src/services/deployments.ts`**: Need `deleteDeploymentsByProject()` helper (deletes S3 files + DB rows)
- **`packages/gateway/src/db/init.sql`**: Consider adding `ON DELETE CASCADE` to FKs referencing `internal.projects(id)` for defense-in-depth
- **Lease checker** (`leases.ts`): Already calls `archiveProject()` — cascade applies automatically when leases expire
- **E2E tests**: Should verify cascade cleanup after project delete
