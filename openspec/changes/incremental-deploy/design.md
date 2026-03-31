## Context

Deployments are stored in S3 at `sites/{deployment_id}/{file_path}`. Each deploy creates a new deployment ID and uploads all files under that prefix. Subdomains and custom domains are then pointed to the new deployment ID. The CloudFront Function and Cloudflare Worker resolve the subdomain/domain to a deployment_id, then fetch `sites/{deployment_id}/{path}` from S3.

The project's current deployment can be found by querying the subdomain table — the most recently assigned deployment_id for that project.

## Goals / Non-Goals

**Goals:**
- Allow deploys that only upload changed files, inheriting the rest from the previous deployment
- Zero client-side complexity — just add `inherit: true`, send only changed files
- Server-side S3 CopyObject for inherited files (no data transfer, instant)

**Non-Goals:**
- Content-addressable / hash-based dedup across deployments or projects
- Client-side diffing protocol (hash negotiation, "which files do you need?")
- File deletion semantics (if you want to remove a file, do a full deploy without `inherit`)

## Decisions

### 1. Find previous deployment from the deployments table

Query `internal.deployments` for the most recent deployment for this project (by `created_at DESC`). This is more reliable than querying the subdomain table, which requires knowing the subdomain name.

**Alternative considered:** Look up via subdomain — rejected because the deploy request doesn't always include a subdomain, and bundle deploys claim subdomains after creating the deployment.

### 2. List + CopyObject for inherited files

When `inherit: true`:
1. Find the previous deployment ID for this project
2. List all objects under `sites/{prev_id}/`
3. For each file NOT in the new upload set, copy it: `CopyObject(sites/{prev_id}/{path} → sites/{new_id}/{path})`
4. Upload new/changed files normally

S3 CopyObject is server-side (no data transfer through the gateway), supports objects up to 5 GB, and preserves ContentType and metadata.

### 3. Local dev fallback uses filesystem copy

In local mode (no S3), copy files from the old deployment directory to the new one using `fs.copyFileSync`. Same semantics, different transport.

### 4. DeploymentRequest gets optional `inherit` field

```typescript
export interface DeploymentRequest {
  project: string;
  target?: string;
  files: DeploymentFile[];
  inherit?: boolean;
}
```

The route validation allows `files` to be empty when `inherit: true` (pure carry-forward with no changes). Without `inherit`, at least one file is required (existing behavior).

## Risks / Trade-offs

- **[S3 API calls]** → A previous deployment with 1000 files means 1000 CopyObject calls. Each is fast (~50ms) but sequential adds up. → Could batch with parallel promises. For v1, sequential is fine — still faster than re-uploading.
- **[No file deletion]** → `inherit: true` carries forward ALL previous files. To remove a file, deploy without `inherit`. → Document this clearly. Could add a `delete` array in the future if needed.
- **[Previous deployment not found]** → First deploy for a project with `inherit: true` has nothing to inherit. → Treat as a normal full deploy (no error, just no files to copy). Log a warning.
