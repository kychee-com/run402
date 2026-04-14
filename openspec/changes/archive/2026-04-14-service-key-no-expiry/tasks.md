# Tasks: service-key-no-expiry

## 1. Gateway code change

- [x] 1.1 In `packages/gateway/src/services/projects.ts:144-148`, remove the `expiresIn` option from the `deriveProjectKeys` `serviceKey` signing call. Drop the now-unused `leaseMs` / `getLeaseDuration` reference in that function if no other code path needs it. [code]
- [x] 1.2 In `packages/gateway/src/services/projects.ts:194-198`, remove the `expiresIn` option from the `createProject` `serviceKey` signing call. Keep `leaseMs` if it's still referenced elsewhere (e.g. for response shape) — check before deleting. [code]
- [x] 1.3 Add an inline comment above each sign call mirroring the existing anon_key comment: `// Service key has no expiry — lease enforcement happens in apikeyAuth middleware via projectCache + lifecycleGate, not in the JWT.` [code]

## 2. Gateway unit tests

- [x] 2.1 In `packages/gateway/src/services/projects.test.ts:388-395`, rename the test `returns valid JWT serviceKey with expiry` → `returns valid JWT serviceKey without expiry`. Invert the assertion: `assert.equal(decoded.exp, undefined, "service key should have no expiration")`. [code]
- [x] 2.2 In `packages/gateway/src/services/projects.test.ts:460-463`, update the `generates valid JWT keys` test to assert `serviceDecoded.exp === undefined` instead of `assert.ok(serviceDecoded.exp, ...)`. [code]
- [x] 2.3 In `packages/gateway/src/services/projects.test.ts:410-417`, the test `produces different service keys for different tiers (different expiry)` no longer holds — with no `exp` and deterministic payload, service keys for the same project across tiers are now **identical** (like anon keys). Either delete this test or flip it to assert equality, matching the adjacent anon_key invariant. Recommend delete (the invariant is already covered by the anon_key test on the line above). [code]
- [x] 2.4 Run `npm run test:unit` and confirm all suites still pass. [code]

## 3. Docs

- [x] 3.1 In `site/llms.txt:784`, change `Expires with lease.` → drop the sentence. Full line becomes: `- service_key (role: service_role) -- **full admin**. Bypasses RLS. For SQL migrations, RLS setup, seeding, usage checks. Keep server-side only.` [code]
- [x] 3.2 In `site/llms-cli.txt:514`, change `service_key → full admin (bypasses RLS). Server-side only. Expires with lease.` → drop the `Expires with lease.` clause. [code]

## 4. Test comment fix

- [x] 4.1 In `test/email-e2e.ts:453`, replace the misleading comment `// After project deletion, the service_key is expired so we need admin` with an accurate one: `// After project deletion, the project status is terminal so serviceKeyAuth returns 404 — admin path bypasses project status check`. [code]

## 5. Self-heal for legacy exp'd keys in Lambda env vars

Covers population (B) from design.md — projects that don't redeploy on their own.

- [x] 5.1 In `packages/gateway/src/services/functions.ts`, add `jwt` import. (It wasn't present — added `import jwt from "jsonwebtoken"`.) [code]
- [x] 5.2 In `refreshFunctionEnvVars` (around `services/functions.ts:913`), after reading `existingServiceKey` from the Lambda configuration, decode it and check for an `exp` claim. If present, re-sign inline (no `exp`) and assign. Log `Self-healed legacy exp'd service_key for <projectId>`. Healthy no-exp keys pass through unchanged. [code]
- [ ] 5.3 Unit test for the self-heal path: deferred. `refreshFunctionEnvVars` is unexported and the existing test suite stubs `LAMBDA_ROLE_ARN = undefined`, so the lambda-branch is never exercised in the current mock setup. Adding a focused test would require either a new mock flavor (LAMBDA_ROLE_ARN set + `GetFunctionCommand` returning a fixture) or extracting the 4-line self-heal into its own pure helper. The logic is small enough to review by eye; production signal is the `Self-healed legacy exp'd service_key for <projectId>` log line on the next secret update per project. Revisit if we ever see unexpected behavior. [deferred]
- [ ] 5.4 No task for population (A) (normal redeploy drain) — already covered by the existing `deployFunction` path. No task for population (C) (third-party stragglers) — resolved out-of-band by the platform operator using a one-liner documented in design.md.

## 6. Lint + typecheck

- [x] 6.1 `npm run lint` clean. [code]
- [x] 6.2 `npx tsc --noEmit -p packages/gateway` clean. [code]

## 7. Deploy + verify

- [ ] 7.1 Push to `main` — GitHub Actions `.github/workflows/deploy-gateway.yml` builds and redeploys ECS automatically. [ship]
- [ ] 7.2 Against production: `curl -s -X POST https://api.run402.com/projects/v1 -H "Authorization: Bearer <admin>" ... | jq .service_key` — decode the returned JWT and confirm no `exp` claim. [manual]
- [ ] 7.3 Against production: use the new service_key to hit a couple of admin endpoints (`GET /mailboxes/v1`, `POST /functions/v1`) — confirm 200. [manual]
- [ ] 7.4 `BASE_URL=https://api.run402.com npm run test:e2e` + `npm run test:functions` + `npm run test:email` — all green. [manual]

## 8. Archive

- [ ] 8.1 Move change to `openspec/changes/archive/` with date suffix (`YYYY-MM-DD-service-key-no-expiry`). [manual]

## Implementation Log

### 2026-04-14 — Core implementation (§1-§6)

**Code changes:**
- `packages/gateway/src/services/projects.ts` — dropped `expiresIn` from both `jwt.sign` calls (`deriveProjectKeys` and `createProject`), removed unused `getLeaseDuration` import, renamed `tier` param to `_tier` in `deriveProjectKeys` (still accepted for signature stability; no longer used in signing). Added comments mirroring the existing anon_key rationale.
- `packages/gateway/src/services/functions.ts` — added `jwt` import; inserted 7-line self-heal block in `refreshFunctionEnvVars` after the existing `existingServiceKey` read. Logs `Self-healed legacy exp'd service_key for <projectId>` on each fix.

**Test changes:**
- `projects.test.ts` — flipped `returns valid JWT serviceKey with expiry` → `...without expiry` (asserts `exp === undefined`). Updated `generates valid JWT keys` to assert no `exp`. Replaced `produces different service keys for different tiers` with `produces identical keys for the same project across tiers` (post-fix both keys are deterministic).
- `test/email-e2e.ts:453` — replaced misleading "service_key is expired" comment with accurate "project status is terminal so serviceKeyAuth returns 404".

**Docs:**
- `site/llms.txt:784` — `Expires with lease.` → `**No expiry** -- lease enforcement happens server-side, same as anon_key.`
- `site/llms-cli.txt:514` — `Expires with lease.` → `**No expiry** -- lease enforcement server-side.`

**Verification:**
- `npx tsc --noEmit -p packages/gateway` — clean.
- `npm run lint` — clean.
- `npm run test:unit` — 1130/1130 pass.

**Deferred:**
- §5.3 unit test for self-heal (see task note). Logic is 7 lines, verifiable by production log signal.

**Ready to ship:** §7 (deploy + verify) pending operator action.
