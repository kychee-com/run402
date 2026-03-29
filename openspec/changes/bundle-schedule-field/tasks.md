## 1. Interface and validation

- [x] 1.1 Add `schedule?: string | null` to `BundleFunction` interface in `packages/gateway/src/services/bundle.ts`
- [x] 1.2 In `validateBundle`, validate cron syntax for each function's `schedule` field using `isValidCron` — fail with 400 including function name

## 2. Deploy logic

- [x] 2.1 In `deployBundle`, after each `deployFunction` call, add schedule logic: check tier limits (max count, min interval), persist schedule to DB, register/cancel cron timer — mirroring `routes/functions.ts` lines 91-152
- [x] 2.2 Pass `fn.schedule` through correctly: `string` = set schedule, `null` = remove, `undefined` = no change

## 3. Verify and close

- [x] 3.1 Type-check: `npx tsc --noEmit -p packages/gateway`
- [ ] 3.2 Lint: `npm run lint`
- [ ] 3.3 Docs alignment: `npm run test:docs`
- [ ] 3.4 Close GitHub issue #3
