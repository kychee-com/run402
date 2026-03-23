## Context

`archiveProject()` in `packages/gateway/src/services/projects.ts` handles project deletion. It currently drops the project's Postgres schema slot (CASCADE), deletes users and refresh tokens, and marks the project as `archived`. However, several resource types are orphaned: Lambda functions (AWS + DB), secrets, subdomains (Route 53 + DB), S3 site deployments, published app versions, and OAuth transactions.

The same `archiveProject()` function is called from two paths:
1. `DELETE /projects/v1/:id` — explicit user deletion (service_key auth)
2. Lease checker (`leases.ts`) — automatic archival when a wallet's tier lease expires

Both paths must cascade-delete all resources.

## Goals / Non-Goals

**Goals:**
- Delete all project-owned AWS resources (Lambda functions, S3 site files)
- Release subdomains (Route 53 record + DB row) so they can be reclaimed
- Clean up all DB rows referencing the project (functions, secrets, deployments, app_versions, oauth_transactions)
- Make the cleanup best-effort and non-blocking — individual resource failures should log warnings, not abort the archive

**Non-Goals:**
- Adding an "undo delete" / soft-delete with restore capability
- Cleaning up billing records (billing is wallet-scoped, not project-scoped)
- Changing the external API contract of `DELETE /projects/v1/:id`
- Adding FK `ON DELETE CASCADE` constraints (migration risk on production; application-level cleanup is sufficient)

## Decisions

### 1. Cleanup order: external resources first, then DB, then schema

Delete in this order:
1. **Lambda functions** (AWS) — must happen before DB cleanup, since we need the `lambda_arn` from `internal.functions` to call `DeleteFunctionCommand`
2. **S3 site files** — need `deployment_id` from `internal.deployments` to compute S3 key prefix
3. **Route 53 subdomain records** — need subdomain name from `internal.subdomains`
4. **DB rows** (functions, secrets, subdomains, deployments, app_versions, oauth_transactions) — safe to batch-delete after external resources are gone
5. **Schema drop + user cleanup** (existing logic) — last, as today
6. **Mark project archived** — final step

**Why this order:** External resources need DB metadata to locate them. If we deleted DB rows first, we'd lose the ARNs, S3 prefixes, and subdomain names needed for cleanup.

### 2. Best-effort with logging, not transactional

Each cleanup step runs independently. If Lambda deletion fails for one function, log a warning and continue with the rest. The archive should still succeed.

**Why:** A single flaky AWS API call shouldn't block project deletion. Orphaned resources are annoying but not dangerous; they can be cleaned up by a future sweep.

### 3. Reuse existing service functions where possible

- Lambda: Add `deleteProjectFunctions(projectId)` to `functions.ts` — queries `internal.functions`, calls `DeleteFunctionCommand` for each, then deletes DB rows
- Subdomains: Add `deleteProjectSubdomains(projectId)` to `subdomains.ts` — queries `internal.subdomains`, calls existing `deleteSubdomainRecord()` for each (handles Route 53)
- Deployments: Add `deleteProjectDeployments(projectId)` to `deployments.ts` — queries `internal.deployments`, deletes S3 prefixes, then deletes DB rows
- Secrets, app_versions, oauth_transactions: Direct `DELETE FROM ... WHERE project_id = $1` in `archiveProject()` — no external resources to clean

### 4. No S3 lifecycle rule — explicit delete

S3 files under `sites/{deployment_id}/` are deleted explicitly per deployment. A lifecycle rule would be simpler but risks deleting files from active projects if misconfigured. Explicit deletion is safer and auditable.

## Risks / Trade-offs

- **[Risk] Lambda DeleteFunction rate limit (concurrent calls)** → Mitigate by serializing deletes per project (projects rarely have >10 functions). If a rate limit hits, log and continue.
- **[Risk] S3 delete of many files is slow** → Mitigate using `DeleteObjectsCommand` (batch delete up to 1000 keys per call). Most sites have <100 files.
- **[Risk] Lease checker calls archiveProject for many projects at once** → Mitigate by running cleanup sequentially per project. The lease checker already processes projects one at a time.
- **[Trade-off] Best-effort vs strict** → Choosing best-effort means some resources may survive deletion. Acceptable because they cause cost/namespace pollution, not correctness bugs.
