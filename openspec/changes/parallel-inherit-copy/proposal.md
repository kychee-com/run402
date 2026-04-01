## Why

The `inherit: true` deploy feature copies files from the previous deployment sequentially — one S3 CopyObject `await` per file. With 700+ files, this takes >60 seconds and triggers the ALB's 504 Gateway Timeout, returning an HTML error page that the CLI can't parse. Real users hit this when deploying CSS-only updates to image-heavy sites (~50MB, 500+ assets). Even when the copy succeeds, 500 files take ~47 seconds — unacceptably slow for what should be a sub-second CSS update.

## What Changes

- Parallelize the S3 CopyObject loop in `createDeployment` with a concurrency limit (~20), reducing 700 files from ~65s to ~4s
- Parallelize the initial S3 PutObject upload loop with the same concurrency pattern
- Add graceful error handling: if the inherit copy fails after partial progress (S3 error, timeout, etc.), return a clear JSON error instead of letting the ALB kill the connection with HTML
- Increase ALB idle timeout from 60s (default) to 120s as a safety net for legitimately large operations

## Capabilities

### New Capabilities
- `parallel-s3-operations`: Concurrent S3 copy/upload with bounded parallelism and error handling for deploy operations

### Modified Capabilities
- `incremental-deploy`: Add requirement that inherited file copying MUST complete within a bounded time, and MUST return a JSON error (not timeout) if it cannot

## Impact

- `packages/gateway/src/services/deployments.ts` — S3 copy loop and upload loop
- `infra/lib/pod-stack.ts` — ALB idle timeout configuration
- No API changes, no new endpoints, no breaking changes
- Existing tests continue to pass; inherited file behavior is unchanged (just faster)
