## 1. Core: Branded type + typed pool

- [x] 1.1 Create `packages/gateway/src/db/sql.ts` with `SQL` branded type and `sql()` helper function
- [x] 1.2 Update `packages/gateway/src/db/pool.ts` to export a typed wrapper that accepts `SQL` for `query()` and narrows `connect()` return type

## 2. Refactor: Wrap all SQL strings

- [x] 2.1 Refactor `packages/gateway/src/services/projects.ts` — wrap all `pool.query()` / `client.query()` calls with `sql()`
- [x] 2.2 Refactor `packages/gateway/src/services/mailbox.ts` — wrap all `pool.query()` calls
- [x] 2.3 Refactor `packages/gateway/src/services/email-send.ts` — wrap all `pool.query()` calls
- [x] 2.4 Refactor `packages/gateway/src/services/subdomains.ts` — wrap all `pool.query()` calls
- [x] 2.5 Refactor `packages/gateway/src/services/functions.ts` — wrap all `pool.query()` calls
- [x] 2.6 Refactor `packages/gateway/src/services/publish.ts` — wrap all `pool.query()` calls
- [x] 2.7 Refactor `packages/gateway/src/services/deployments.ts` — wrap all `pool.query()` calls
- [x] 2.8 Refactor `packages/gateway/src/services/oauth.ts` — wrap all `pool.query()` calls
- [x] 2.9 Refactor `packages/gateway/src/services/billing.ts` — wrap all `pool.query()` / `client.query()` calls
- [x] 2.10 Refactor `packages/gateway/src/services/wallet-tiers.ts` — wrap all `pool.query()` / `client.query()` calls
- [x] 2.11 Refactor `packages/gateway/src/services/bundle.ts` — wrap all `client.query()` calls
- [x] 2.12 Refactor `packages/gateway/src/services/fork.ts` — wrap all `pool.query()` / `client.query()` calls
- [x] 2.13 Refactor `packages/gateway/src/services/demo.ts` — wrap all `pool.query()` / `client.query()` calls
- [x] 2.14 Refactor `packages/gateway/src/services/slots.ts` — wrap all `pool.query()` / `client.query()` calls
- [x] 2.15 Refactor `packages/gateway/src/services/leases.ts` — wrap all `pool.query()` calls
- [x] 2.16 Refactor `packages/gateway/src/services/faucet.ts` — wrap all `pool.query()` calls
- [x] 2.17 Refactor `packages/gateway/src/services/admin-wallets.ts` — wrap all `pool.query()` calls
- [x] 2.18 Refactor `packages/gateway/src/services/stripe-billing.ts` — wrap all `pool.query()` calls
- [x] 2.19 Refactor `packages/gateway/src/services/budget.ts` — wrap all `pool.query()` calls
- [x] 2.20 Refactor `packages/gateway/src/routes/admin.ts` — wrap all `pool.query()` / `client.query()` calls
- [x] 2.21 Refactor `packages/gateway/src/routes/auth.ts` — wrap all `pool.query()` calls
- [x] 2.22 Refactor `packages/gateway/src/routes/admin-dashboard.ts` — wrap all `pool.query()` calls
- [x] 2.23 Refactor `packages/gateway/src/routes/admin-wallet.ts` — wrap all `pool.query()` calls
- [x] 2.24 Refactor remaining routes (`attribution.ts`, `contact.ts`, `billing.ts`, `functions.ts`, `mailboxes.ts`, `projects.ts`, `subdomains.ts`, `publish.ts`) — wrap all `pool.query()` calls
- [x] 2.25 Refactor `packages/gateway/src/server.ts` — wrap all `pool.query()` calls
- [x] 2.26 Refactor `packages/gateway/src/middleware/idempotency.ts` — wrap all `pool.query()` calls
- [x] 2.27 Refactor `packages/gateway/src/middleware/metering.ts` — wrap all `client.query()` calls
- [x] 2.28 Refactor `packages/gateway/src/middleware/x402.ts` — wrap all `pool.query()` calls
- [x] 2.29 Refactor `packages/gateway/src/utils/wallet.ts` and `packages/gateway/src/utils/fork-badge.ts` — wrap all `pool.query()` calls

## 3. Verify: Type-check + lint

- [x] 3.1 Run `npx tsc --noEmit -p packages/gateway` — zero errors
- [x] 3.2 Run `npm run lint` — zero errors
- [x] 3.3 Verify no raw `pool.query(` or `client.query(` calls remain without `sql()` (grep check)

## 4. Test: SQL syntax validation

- [x] 4.1 Add `libpg-query` as devDependency to gateway
- [x] 4.2 Create SQL validation test: extract all `sql()` calls, replace `$N` with `NULL`, parse via `libpg-query`
- [x] 4.3 Add `test:sql` script to `package.json`
- [x] 4.4 Run test — all SQL passes validation
