## 1. Fork endpoint: accept and invoke bootstrap

- [x] 1.1 Add `bootstrap` field to fork request body validation in `publish.ts` (optional JSON object, pass through to `forkApp`)
- [x] 1.2 After `forkApp` completes, check if the new project has a function named `bootstrap` — if so, invoke it with the bootstrap variables as JSON body using the project's `service_key`
- [x] 1.3 Include `bootstrap_result` (parsed JSON response) or `bootstrap_error` (error message string) in the fork response
- [x] 1.4 If no bootstrap function exists, include `"bootstrap_result": null` in the response

## 2. Deploy endpoint: accept and invoke bootstrap

- [x] 2.1 Add `bootstrap` field to bundle deploy request body validation in `bundle.ts` (optional JSON object)
- [x] 2.2 After `deployBundle` completes, check if the new project has a function named `bootstrap` — if so, invoke it with the bootstrap variables
- [x] 2.3 Include `bootstrap_result` or `bootstrap_error` in the deploy response

## 3. Bootstrap invocation helper

- [x] 3.1 Create a shared helper `invokeBootstrap(projectId, serviceKey, anonKey, variables, apiBase)` in `packages/gateway/src/services/functions.ts` that invokes the `bootstrap` function, handles errors/timeouts, and returns `{ result, error }`
- [x] 3.2 Handle non-200 responses: capture status + body as `bootstrap_error` string
- [x] 3.3 Handle timeouts and exceptions: capture as `bootstrap_error` string

## 4. Bootstrap variables in publish flow

- [x] 4.1 Parse `bootstrap.variables` from `run402.yaml` during publish and store on the `app_versions` row (new `bootstrap_variables` JSONB column)
- [x] 4.2 Add `bootstrap_variables` column to `internal.app_versions` table
- [x] 4.3 Include `bootstrap_variables` in `GET /v1/apps/:versionId` response

## 5. Tests

- [x] 5.1 E2E test: deploy a bundle with a bootstrap function, pass bootstrap variables, verify `bootstrap_result` in response
- [x] 5.2 E2E test: deploy a bundle without a bootstrap function, pass bootstrap variables, verify `bootstrap_result: null`
- [x] 5.3 E2E test: deploy a bundle with a bootstrap function that throws, verify fork succeeds with `bootstrap_error`
- [x] 5.4 E2E test: manually invoke `/functions/v1/bootstrap` after deploy, verify it works

## 6. Documentation

- [x] 6.1 Update `docs/marketplace-spec.md` with bootstrap convention
- [x] 6.2 Update `docs/functions_spec.md` with bootstrap function convention and example
- [x] 6.3 Update `site/llms.txt` fork/deploy docs with `bootstrap` field
- [x] 6.4 Add bootstrap example to fork prompt suggestions in SkMeld spec
