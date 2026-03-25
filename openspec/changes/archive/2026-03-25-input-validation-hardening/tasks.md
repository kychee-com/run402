## 1. Validation Module

- [x] 1.1 Create `packages/gateway/src/utils/validate.ts` with validators: `validateUUID`, `validateWalletAddress`, `validateEmail`, `validatePaginationInt`, `validateURL` — each throws `HttpError(400, ...)` with field name in message
- [x] 1.2 Add unit tests in `packages/gateway/src/utils/validate.test.ts` covering valid input, invalid input, and edge cases for each validator

## 2. Auth Routes

- [x] 2.1 Add UUID validation for `refresh_token` in `POST /auth/v1/token?grant_type=refresh_token` (auth.ts)
- [x] 2.2 Add UUID validation for `refresh_token` in `POST /auth/v1/logout` (auth.ts)
- [x] 2.3 Add email validation in signup and magic-link flows (auth.ts)

## 3. Project & Admin Routes

- [x] 3.1 Add UUID validation for `:id` param in project routes (projects.ts)
- [x] 3.2 Add UUID validation for `:id` param in admin routes (admin.ts)
- [x] 3.3 Add pagination validation for `limit`/`offset` query params in project list (projects.ts)

## 4. Billing Routes

- [x] 4.1 Add wallet address validation (42-char hex) for `:wallet` param in billing routes (billing.ts)
- [x] 4.2 Add pagination validation for `limit` query param in billing list (billing.ts)

## 5. Functions & Deployments Routes

- [x] 5.1 Add UUID validation for project/function ID params in functions routes (functions.ts)
- [x] 5.2 Add pagination validation for `tail` query param in function logs (functions.ts)
- [x] 5.3 Add UUID validation for `:id` param in deployments routes (deployments.ts)

## 6. Storage, Subdomains & Other Routes

- [x] 6.1 Add validation for bucket/path params in storage routes (storage.ts)
- [x] 6.2 Add validation for subdomain name params in subdomains routes (subdomains.ts)
- [x] 6.3 Add email and URL validation in contact route (contact.ts)
- [x] 6.4 Add UUID validation in mailbox routes (mailboxes.ts)
- [x] 6.5 Add wallet address validation in faucet route (faucet.ts)

## 7. Verify

- [x] 7.1 Run `npm run lint` and `npx tsc --noEmit -p packages/gateway` — fix any issues
- [x] 7.2 Run `npm run test:e2e` and `npm run test:bld402-compat` against local to verify no regressions
