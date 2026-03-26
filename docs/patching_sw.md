# Incremental Deploys (Patch Deployments)

## Context

Run402 currently re-uploads every file on every deploy — all file content is sent inline in a single `POST /deployments/v1` request. here.now supports incremental deploys via SHA-256 hash diffing, so only changed files are transferred.

## Current Architecture

Run402 has two separate systems that put files in the same S3 bucket (`agentdb-storage-{account-id}`):

**Deployments** (`/deployments/v1`, `packages/gateway/src/routes/deployments.ts`) — static site hosting.
- Files stored at `sites/{deployment_id}/{path}`
- Auth: wallet signature (EIP-4361)
- All files sent inline in one JSON POST (content in `data` field, optional `base64` encoding)
- Immutable — each deploy creates a new deployment ID, old URLs stay valid
- Served via CloudFront at `*.sites.run402.com`
- 50MB limit per deployment (hardcoded: `MAX_DEPLOYMENT_SIZE = 50 * 1024 * 1024`)
- Auto-reassigns project subdomains to new deployment on redeploy

**Storage API** (`/storage/v1/`, `packages/gateway/src/routes/storage.ts`) — general-purpose file storage for app data.
- Files stored at `{project_id}/{bucket}/{path}`
- Auth: `apikey` header (anon_key, service_key, or access_token)
- Upload, download, delete, list files
- Mutable — overwrite and delete supported
- Metered against project storage quota
- Has presigned URL generation, but **only for GET** (download): `POST /storage/v1/object/sign/{bucket}/{path}` uses `getSignedUrl` with `GetObjectCommand`

The storage API already proves the presigned URL pattern works in the codebase. To support presigned uploads, the same approach with `PutObjectCommand` is needed. The deployment system hasn't adopted presigned URLs because inline content was simpler for the initial implementation and 50MB was sufficient.

## Design

No presigned URL flow needed. Run402 already accepts file content inline through the gateway, and the gateway uploads to S3 on behalf of the client. Just extend the existing endpoint.

### Request shape

```json
POST /deployments/v1
{
  "project": "prj_...",
  "base_deployment": "dpl_123_abc",
  "files": [
    {"file": "style.css", "data": "body { color: red; }"}
  ]
}
```

Only the changed/new files are in `files`. `base_deployment` tells the server which deployment to copy unchanged files from.

### Server behavior

1. Look up `base_deployment` in S3, get the full file list under `sites/{base_deployment}/`
2. Create a new deployment ID (`dpl_{ts}_{rand}`)
3. `S3 CopyObject` every file from `sites/{base_deployment}/*` to `sites/{new_id}/*`
4. Upload/overwrite with the files provided in the request body
5. Record the new deployment in DB

The client only sends changed files. The server copies the rest. Same wallet auth, same endpoint, no new auth model.

### File deletion

Need a way to express "this file was removed." Options:

- Explicit delete list: `"delete": ["old-page.html", "unused.js"]`
- Convention: file with null data means delete: `{"file": "old.html", "data": null}`

### Why not presigned URLs (at this stage)?

Presigned URLs exist in here.now because they need to get large files to storage without routing through their API server. Run402's gateway already mediates all uploads to S3. At the current 50MB-per-deployment limit, the gateway can handle inline content fine. Presigned URLs would only matter if the limit grew to gigabytes.

### What this enables

- Agent changes one CSS file → sends ~5 KB instead of re-uploading the entire site
- Iterative build/deploy cycles (the primary agent workflow) become much faster
- Base64-encoded binary assets (images, fonts) don't need re-upload on every text change

### Immutability preserved

Each patch creates a new deployment ID with a new S3 prefix. Old deployment URLs remain valid. The `base_deployment` is just a source for server-side copies — it's never modified.

---

## Raising Size Limits: Presigned URL Uploads

The patch deploy design above solves the "one file changed" case but doesn't help with the initial deploy of a large site. To raise the 50MB limit significantly, the gateway needs to get out of the data path.

### Presigned URL flow

The gateway generates presigned S3 PUT URLs and returns them to the client. The client uploads directly to S3, bypassing the gateway entirely. Run402 already uses this pattern for storage signed URLs (`POST /storage/v1/object/sign/...`).

#### Request shape

Step 1 — manifest:
```json
POST /deployments/v1/prepare
{
  "project": "prj_...",
  "base_deployment": "dpl_123_abc",
  "files": [
    {"file": "index.html", "size": 10240, "hash": "aaa111..."},
    {"file": "style.css",  "size": 5120,  "hash": "bbb222..."},
    {"file": "video.mp4",  "size": 524288000, "hash": "ccc333..."}
  ]
}
```

Step 2 — server responds with upload instructions:
```json
{
  "deployment_id": "dpl_new_id",
  "uploads": [
    {"file": "style.css", "url": "https://s3.amazonaws.com/...presigned-put-url..."}
  ],
  "skipped": ["index.html", "video.mp4"],
  "finalize_url": "/deployments/v1/dpl_new_id/finalize"
}
```

Step 3 — client uploads changed files directly to S3 (parallel).

Step 4 — finalize:
```json
POST /deployments/v1/dpl_new_id/finalize
```

Server copies skipped files from `base_deployment` via `S3 CopyObject`, marks deployment as live.

### When to use which path

- **Inline (current + patch):** deployments under 50MB. Simple, one request for patches. Good enough for most agent-built sites.
- **Presigned:** deployments over 50MB, or sites with large binary assets (video, datasets, images). Client needs to handle multi-step flow.

Both paths can coexist. The inline path stays simple for the common case. The presigned path unlocks larger sites without bottlenecking the gateway.

---

## Future: Content-Addressable Storage

How Vercel does it — files stored by SHA hash globally across all users:

1. Client sends manifest with file paths and SHA-1 hashes
2. Vercel checks which hashes it already has (across ALL users, not just yours)
3. Response tells the client which files are missing
4. Client uploads only the missing files, each keyed by hash
5. Vercel assembles the deployment by linking hashes to paths

If you deploy a React app with the same React version as a million other users, those framework files are already stored. Your deploy only uploads custom code.

Supabase takes a different approach for their storage API — standard uploads through the API server, signed upload URLs for direct-to-storage, and TUS protocol for resumable large uploads. But Supabase Storage is for user files, not site deployments (their hosting is via Vercel).

### Applicability to Run402

Content-addressable storage is a scale optimization — maximum deduplication across all deployments and all users. Overkill until Run402 has thousands of users deploying similar stacks. The incremental/presigned approach above captures most of the benefit with much less complexity.

### Progression

| Stage | Approach | Max size | Complexity |
|-------|----------|----------|------------|
| Now | Inline, full re-upload | 50 MB | Minimal |
| Next | Inline + patch (`base_deployment`) | 50 MB | Low |
| Later | Presigned URL uploads | GBs | Medium |
| Scale | Content-addressable (Vercel model) | GBs, deduplicated | High |
