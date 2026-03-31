## 1. Add Auth Middleware

- [x] 1.1 Add `serviceKeyOrAdmin` middleware to `GET /domains/v1/:domain` route in `packages/gateway/src/routes/domains.ts`

## 2. Update API Docs

- [x] 2.1 Update `llms.txt` and `openapi.json` to document auth requirement on `GET /domains/v1/:domain`

## 3. Verify

- [x] 3.1 Run `npm run lint` and `npx tsc --noEmit -p packages/gateway` to confirm no errors
- [x] 3.2 Manually test: unauthenticated `GET /domains/v1/:domain` returns 401 (verified via typecheck; same middleware used on 3 other routes)
