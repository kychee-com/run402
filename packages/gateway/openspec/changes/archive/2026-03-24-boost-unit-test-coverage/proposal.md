## Why

Unit test line coverage is 38% across the gateway's imported source files. Nine service files sit below 30%, including critical business logic (billing at 7%, functions at 13%, wallet-tiers at 13%). Without adequate coverage, regressions in payment, deployment, and project management code go undetected until production.

## What Changes

- Add unit tests for 12 under-covered source files in `packages/gateway/src/`
- Target: raise overall reported line coverage from 38% to ≥80%
- Priority order by impact (lines × gap):
  1. `services/billing.ts` (7% → 80%+)
  2. `services/wallet-tiers.ts` (13% → 80%+)
  3. `services/projects.ts` (15% → 80%+)
  4. `services/slots.ts` (23% → 80%+)
  5. `services/functions.ts` (13% → 80%+)
  6. `services/publish.ts` (24% → 80%+)
  7. `services/fork.ts` (24% → 80%+)
  8. `services/mailbox.ts` (29% → 80%+)
  9. `services/admin-wallets.ts` (25% → 80%+)
  10. `middleware/x402.ts` (18% → 80%+)
  11. `routes/admin.ts` (48% → 80%+)
  12. `services/bundle.ts` (55% → 80%+)
- Raise CI threshold from 30% to 75%

## Capabilities

### New Capabilities
- `unit-test-coverage-targets`: Per-file coverage targets and the test patterns used to achieve them

### Modified Capabilities
- `test-coverage`: Raise CI threshold from 30% to 75%

## Impact

- **Code**: New `*.test.ts` files alongside each service/middleware under test
- **CI**: Threshold bump in `deploy-gateway.yml`
- **No runtime changes** — tests only, no production code modified
