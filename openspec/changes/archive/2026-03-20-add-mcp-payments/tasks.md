## 1. Paid Fetch Module

- [x] 1.1 Create `src/paid-fetch.ts` with `setupPaidFetch()` — reads allowance, branches on rail (x402 vs mpp), returns wrapped fetch or null. Mirror logic from `cli/lib/paid-fetch.mjs` but return null instead of process.exit on missing allowance, and catch dynamic import failures gracefully.
- [x] 1.2 Create `paidApiRequest()` in `src/paid-fetch.ts` (or `src/paid-client.ts`) — lazy-inits paid fetch on first call, caches it, patches `globalThis.fetch` for the duration of the `apiRequest` call when paid fetch is available, falls back to bare `apiRequest` when not.
- [x] 1.3 Write unit tests for `src/paid-fetch.ts` — test x402 path, mpp path, missing allowance (returns null), import failure (returns null), caching behavior.

## 2. Update Tools to Use Paid Fetch

- [x] 2.1 Update `src/tools/set-tier.ts` — replace `apiRequest` with `paidApiRequest`. Keep the `is402` informational fallback for when paid fetch is unavailable.
- [x] 2.2 Update `src/tools/generate-image.ts` — replace `apiRequest` with `paidApiRequest`. Keep the `is402` informational fallback.
- [x] 2.3 Update `src/tools/deploy-function.ts` — replace `apiRequest` with `paidApiRequest`. Keep the `is402` informational fallback.
- [x] 2.4 Update `src/tools/invoke-function.ts` — replace `apiRequest` with `paidApiRequest`. Keep the `is402` informational fallback.
- [x] 2.5 Update `src/tools/provision.ts` — replace `apiRequest` with `paidApiRequest`. Add `is402` informational response (currently treated as generic error via formatApiError).
- [x] 2.6 Update `src/tools/bundle-deploy.ts` — replace `apiRequest` with `paidApiRequest`. Add `is402` informational response (currently treated as generic error via formatApiError).

## 3. Tests and Validation

- [x] 3.1 Update existing tool tests to verify paid fetch integration — mock `setupPaidFetch` to confirm tools call `paidApiRequest`, and verify fallback behavior when paid fetch returns null.
- [x] 3.2 Run `npm test` — all existing tests pass (sync test, skill test, unit tests).
- [x] 3.3 Run `npm run build` — TypeScript compiles without errors.
