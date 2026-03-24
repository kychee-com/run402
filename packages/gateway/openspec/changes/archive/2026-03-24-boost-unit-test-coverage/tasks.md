## 1. Quick wins (small files, big % gain)

- [x] 1.1 Add `services/slots.test.ts` — test `allocateSlot`, `releaseSlot`, `getUsedSlots` (70 lines, 23% → 87%)
- [x] 1.2 Add `services/admin-wallets.test.ts` — test exported wallet CRUD functions (55 lines, 25% → 95%)
- [x] 1.3 Extend `utils/errors.test.ts` — cover `HttpError`, `NotFoundError`, `ForbiddenError` constructors (15 lines, 53% → 100%)

## 2. Core services (high impact)

- [x] 2.1 Add `services/billing.test.ts` — test `getBillingAccount`, `createBillingAccount`, `setTier`, tier expiry logic (495 lines, 7% → 89%)
- [x] 2.2 Add `services/wallet-tiers.test.ts` — test `isWalletTierActive`, `getWalletTier`, `setWalletTier`, tier validation (398 lines, 13% → 99%)
- [x] 2.3 Add `services/projects.test.ts` — test `createProject`, `getProject`, `archiveProject`, slot allocation (280 lines, 15% → 96%)

## 3. Deployment & publishing services

- [x] 3.1 Add `services/publish.test.ts` + `publish-publish.test.ts` — test all publish functions including publishAppVersion (619 lines, 24% → 99%)
- [x] 3.2 Add `services/fork.test.ts` — test `forkProject`, validation, tier ordering (305 lines, 24% → 53%)
- [x] 3.3 Extend `services/bundle.test.ts` — cover deployBundle, runMigrations, applyRls (367 lines, 55% → 98%)

## 4. Communication & function services

- [x] 4.1 Add `services/functions.test.ts` — test `deployFunction`, `invokeFunction`, `deleteFunction`, zip builder, validation (1155 lines, 13% → 61%)
- [x] 4.2 Extend `services/mailbox.test.ts` — cover all CRUD + initMailboxTables (331 lines, 29% → 95%)

## 5. Middleware & routes

- [x] 5.1 Add `middleware/x402.test.ts` — test payment middleware, allowance rail, admin bypass, writeHead interception (596 lines, 18% → 73%)
- [x] 5.2 Extend `routes/admin-sql.test.ts` — cover pin/unpin/usage/schema handlers (478 lines, 48% → 77%)

## 6. Finalize

- [x] 6.1 Run `test:unit:coverage` and verify overall line coverage ≥80% — **83.47%**
- [x] 6.2 Bump CI threshold in `deploy-gateway.yml` from 30% to 75%
