## 1. Inject JWT secret into function environment

- [x] 1.1 Add `RUN402_JWT_SECRET` to Lambda env vars in `deployFunction()` (`packages/gateway/src/services/functions.ts`), alongside existing `RUN402_SERVICE_KEY`
- [x] 1.2 Add `RUN402_JWT_SECRET` to the local dev inline helper in `writeLocalFunction()` so it's available as an env var or inline constant
- [x] 1.3 Add `RUN402_JWT_SECRET` to the env vars update path in `updateFunctionSecrets()` (when secrets change, functions are redeployed with updated env)

## 2. Implement getUser in Lambda layer helper

- [x] 2.1 Add `getUser(req)` implementation to the HELPERJS heredoc in `packages/functions-runtime/build-layer.sh` — uses `jsonwebtoken.verify()` with `RUN402_JWT_SECRET`, checks `project_id` matches `RUN402_PROJECT_ID`, returns `{ id, role }` or `null`
- [x] 2.2 Export `getUser` alongside `db` from the module
- [x] 2.3 Update the module's JSDoc comment to document `getUser`

## 3. Implement getUser in local dev inline helper

- [x] 3.1 Add `getUser(req)` to the inline helper code in `writeLocalFunction()` in `packages/gateway/src/services/functions.ts` — same logic as Lambda layer version
- [x] 3.2 Ensure `jsonwebtoken` import is available in local dev mode (it's already a gateway dependency)

## 4. Tests

- [x] 4.1 Add E2E test: deploy a function that uses `getUser(req)`, call it with a valid user access token, verify it returns the correct user identity (`{ id, role }`)
- [x] 4.2 Add E2E test: call the same function without auth header, verify `getUser` returns `null`
- [x] 4.3 Add E2E test: call the function with an expired or invalid token, verify `getUser` returns `null`

## 5. Documentation

- [x] 5.1 Update `docs/functions_spec.md` to document `getUser` export, its signature, and return shape (`{ id, role }`)
- [x] 5.2 Update the llms.txt Functions section to mention `getUser`
