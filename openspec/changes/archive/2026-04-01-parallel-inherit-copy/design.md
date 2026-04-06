## Context

The `createDeployment` function in `deployments.ts` performs all S3 operations sequentially — both the initial file upload loop and the inherit copy loop use `for...of` with individual `await` per file. With 700 files, the inherit copy alone takes ~65 seconds, exceeding the ALB's default 60-second idle timeout. The ALB returns an HTML 504 page that the CLI cannot parse, crashing the user's deploy.

Measured timings (production, sequential):
- 200 files: 18s
- 500 files: 47s
- 700 files: 65s → **504 timeout**

## Goals / Non-Goals

**Goals:**
- Inherit copy of 1000 files completes in <10 seconds
- Upload of 200 files completes in <5 seconds
- If S3 operations fail, return a clear JSON error (never let ALB timeout produce HTML)
- Safety net: ALB timeout at 120s so even degraded S3 performance doesn't produce HTML errors

**Non-Goals:**
- Streaming/chunked upload protocol (would require CLI changes)
- Background/async deploy with polling (adds complexity, not needed if copy is fast)
- Changing the S3 key structure or deployment model

## Decisions

### 1. Bounded-concurrency Promise pool for S3 operations

Use a simple concurrency-limited executor (inline, no npm dependency) that runs up to N S3 operations in parallel. Set N=20 — high enough to saturate the S3 API but low enough to avoid Lambda/ECS memory pressure.

**Why not `Promise.all` on the full array?** Unbounded parallelism with 1000+ files could spike memory and open too many concurrent HTTP connections. A bounded pool keeps resource usage predictable.

**Why not a library like `p-limit`?** Adding a dependency for ~15 lines of utility code isn't worth it. A simple `withConcurrency(items, fn, limit)` helper is trivial.

### 2. Per-file retry (2 attempts) before giving up

Each individual S3 PutObject/CopyObject is retried once on failure. The `withConcurrency` helper accepts a `retries` parameter — on failure it waits briefly (100ms) and retries. This handles the most common failure mode: a single transient S3 error out of hundreds of calls.

**Why not retry the whole batch?** A batch retry re-does all the work. Per-file retry only re-does the one call that failed, and the rest of the batch continues in parallel unaffected.

### 3. Graceful error handling with actionable message

If an S3 operation fails after exhausting retries, return a JSON 502 response with the count of files successfully copied vs total, plus an actionable message telling the user to retry or deploy without inherit. The deployment DB row is NOT inserted (it's after the copy loop), so a failed inherit leaves no dangling state.

**Why 502?** The gateway attempted to fulfill the request but an upstream service (S3) failed. This is semantically correct and distinguishes from 500 (our bug) or 504 (ALB timeout).

### 3. ALB idle timeout increase to 120s

Bump `idleTimeout` on the ALB from 60s (default) to 120s. This is a one-line CDK change. Even with parallelized copies, legitimate large operations (initial deploy of 500+ files, large SQL migrations) benefit from headroom.

**Why not higher?** 120s is generous for any API operation. If something takes >2 minutes, there's likely a real problem that should fail rather than hang.

## Risks / Trade-offs

- **[20 concurrent S3 calls may hit S3 rate limits]** → S3 supports 5,500 GET/PUT per second per prefix. 20 concurrent copies is nowhere near this. No risk.
- **[Partial copy failure leaves orphaned S3 objects]** → The new deployment prefix has some files but no DB record pointing to it. These are harmless and will be cleaned up by the existing stale deployment cleanup job. Acceptable.
- **[ALB timeout increase affects all routes]** → 120s is reasonable for all endpoints. No route should legitimately take >2 minutes. If one does, we have a separate problem.
