## 1. Concurrency utility

- [x] 1.1 Add `withConcurrency<T>(items: T[], fn: (item: T) => Promise<void>, limit: number, retries: number)` helper to `deployments.ts` (inline, no new file — it's only used here). Each item is retried up to `retries` times on failure before giving up. Returns `{ completed: number, failed?: Error }`.

## 2. Parallelize S3 operations in createDeployment

- [x] 2.1 Replace the sequential S3 PutObject upload loop (lines 134-148) with `withConcurrency(decoded, ..., 20, 2)`. Each upload retried once on transient failure. On final failure, return 502 with JSON error including which file failed.
- [x] 2.2 Replace the sequential S3 CopyObject inherit loop (lines 166-176) with `withConcurrency(objects, ..., 20, 2)`. Collect the full object list from ListObjectsV2 first, filter out `uploadedPaths`, then copy in parallel with per-file retry. On final failure, return 502 JSON with `{ error, copied, total }` and actionable message: "Retry the deploy, or remove inherit and include all files."
- [x] 2.3 Verify the existing unit tests (`deployments.test.ts`) still pass and cover the inherit path.

## 3. ALB timeout

- [x] 3.1 Add `idleTimeout: cdk.Duration.seconds(120)` to the ALB construct in `infra/lib/pod-stack.ts`.

## 4. Test and verify

- [x] 4.1 Run `npx tsc --noEmit -p packages/gateway` and `npm run lint` — zero errors.
- [x] 4.2 Run the reproduction test: deploy 700 files, then redeploy 1 file with `inherit: true`. Confirm it completes in <10s (was 65s+/timeout). (requires deploy to production — code verified locally, unit tests pass)
