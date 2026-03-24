## Context

The gateway has 211 passing unit tests but coverage sits at 38% lines. Nine service files are below 30%. Tests use Node.js built-in `node:test` with `mock.module()` for dependency isolation. The existing test pattern is well-established: mock `../db/pool.js` and external SDK clients, import the module under test, exercise exported functions.

Coverage is measured by c8 and only reports on files that are actually imported during tests. Files like `server.ts` (1145 lines, the Express app entrypoint) and most route handlers are never imported, so they don't factor into the current 38%.

## Goals / Non-Goals

**Goals:**
- Raise overall c8-reported line coverage to ≥80%
- Add unit tests for all service files currently below 80%
- Add unit tests for `middleware/x402.ts` and `routes/admin.ts` (largest uncovered route/middleware files in the current report)
- Raise CI threshold to 75%

**Non-Goals:**
- Testing `server.ts` (Express bootstrap, no testable business logic — tested by E2E)
- Testing route files not currently in the c8 report (they're thin wrappers around services — covered by E2E)
- Achieving 100% — some code paths require real AWS/Stripe/Lambda connections
- Refactoring production code to improve testability

## Decisions

### Test only exported functions, mock all I/O
**Rationale:** Every file under test follows the same pattern: it imports `pool` from `../db/pool.js` and optionally AWS SDK clients, Stripe, etc. We mock those at the module level, then test the exported business logic functions. This is the established pattern in the codebase (see `subdomains.test.ts`, `faucet.test.ts`).

### One test file per source file, colocated
**Rationale:** Existing convention: `foo.ts` → `foo.test.ts` in the same directory. The `test:unit` glob (`src/**/*.test.ts`) discovers them automatically.

### Order by coverage gap × file size (biggest impact first)
**Rationale:** `functions.ts` (1155 lines, 13%) and `billing.ts` (495 lines, 7%) deliver the most coverage gain per test file. Smaller files like `slots.ts` (70 lines) and `admin-wallets.ts` (55 lines) are quick wins for the tail.

### Skip untestable branches, document why
**Rationale:** Some branches guard against real AWS errors or Stripe webhook signatures that can't be meaningfully mocked. Leave those uncovered rather than writing tests that just exercise mock plumbing. The 80% target leaves room.

## Risks / Trade-offs

- **[Risk] Over-mocking hides real bugs** → Tests validate logic flow and argument passing, not integration. E2E tests cover the integration layer. This is the accepted trade-off for unit test speed.
- **[Risk] Tests become fragile if service internals change** → Test public API (exported functions), not internal helpers. Mock at module boundaries only.
- **[Trade-off] Some files won't reach 80% individually** → That's fine as long as the overall average hits 80%. Files like `x402.ts` have large chunks of x402 protocol plumbing that are better tested at integration level.
