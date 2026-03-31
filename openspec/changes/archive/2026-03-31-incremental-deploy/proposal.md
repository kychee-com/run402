## Why

Every deploy uploads all files, even if only one CSS file changed. For small apps this is fine, but sites with many images or large assets waste bandwidth re-uploading unchanged files. A 500 MB site with a 10 KB CSS fix uploads 500 MB.

## What Changes

- Add an `inherit` flag to the deploy request. When `true`, the server copies all files from the project's current deployment into the new deployment, then overlays the uploaded files on top.
- The client only sends changed files. Unchanged files are carried forward via S3 CopyObject (server-side copy, no data transfer).
- Fully backwards compatible — existing deploys without `inherit` work as before (full replacement).
- Works on both `POST /deployments/v1` and `POST /deploy/v1` (bundle deploy).

## Capabilities

### New Capabilities
- `incremental-deploy`: Support for `inherit: true` flag on deploy requests to carry forward unchanged files from the previous deployment via S3 server-side copy.

### Modified Capabilities

_(none)_

## Impact

- **Code**: `packages/gateway/src/services/deployments.ts` (inherit logic + S3 CopyObject), `packages/gateway/src/routes/deployments.ts` (accept `inherit` field), `packages/gateway/src/services/bundle.ts` (pass `inherit` through)
- **APIs**: `POST /deployments/v1` and `POST /deploy/v1` accept optional `inherit: true` in request body. Additive, non-breaking.
- **AWS SDK**: Needs `CopyObjectCommand` import from `@aws-sdk/client-s3`.
- **Docs**: `site/llms.txt` should document the `inherit` option.
