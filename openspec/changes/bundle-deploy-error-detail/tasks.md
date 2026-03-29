## 1. Fix error handling

- [x] 1.1 In `packages/gateway/src/routes/bundle.ts`, replace the catch block to handle any error with a `statusCode` property via `HttpError`, and wrap unknown errors with their message instead of falling through to Express default handler
- [x] 1.2 Verify: `npx tsc --noEmit -p packages/gateway` passes
- [x] 1.3 Verify: `npm run lint` passes

## 2. Close issue

- [x] 2.1 Close GitHub issue #1 with a reference to the fix commit
