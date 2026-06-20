## 1. SDK discrimination

- [x] 1.1 Add `"binding_revoked"` to `CiTokenExchangeErrorCode` and export `CI_BINDING_REVOKED_ERROR` from `sdk/src/namespaces/ci.types.ts`
- [x] 1.2 Add `isCiBindingRevoked(err)` guard to `sdk/src/namespaces/ci.ts` (structural: `isRun402Error` + status 403 + `body.error === "binding_revoked"`; narrows to `Unauthorized`)
- [x] 1.3 Re-export `isCiBindingRevoked` + `CI_BINDING_REVOKED_ERROR` from `sdk/src/index.ts`
- [x] 1.4 Unit tests in `sdk/src/namespaces/ci.test.ts`: true for `binding_revoked` (stays `Unauthorized`), false for `access_denied`, false for non-Run402/non-403/unrelated

## 2. Astro uploader remediation

- [x] 2.1 Map `binding_revoked` → `CI_BINDING_REVOKED` in `astro/src/uploader.ts` `extractErrorCode` (single point; not in `RETRYABLE_CODES`, so no retry)
- [x] 2.2 Add `CI_BINDING_REVOKED` hint (re-link, not `set-asset-scopes`) in `astro/src/errors.ts`
- [x] 2.3 Test in `astro/src/uploader.test.ts`: revoked binding → `CI_BINDING_REVOKED` + re-link hint + no retry
- [x] 2.4 Document re-link-don't-re-scope in `astro/README.md`

## 3. CLI deploy guidance

- [x] 3.1 Add `binding_revoked` guidance to `CI_DEPLOY_ERROR_GUIDANCE` in `cli/lib/deploy-v2.mjs`
- [x] 3.2 Key `enhanceCiDeployError` off the OAuth `error` field (token-exchange) before `code` (plan path)
- [x] 3.3 Test in `cli-deploy-ci.test.mjs`: token-exchange `binding_revoked` 403 → re-link guidance, plan endpoint never reached
- [x] 3.4 Add `binding_revoked` to `cli/llms-cli.txt` Common CI error codes

## 4. SDK docs

- [x] 4.1 Document `isCiBindingRevoked` + `binding_revoked` in `sdk/llms-sdk.txt` (guards list + token-exchange section + error-code union)

## 5. Verification

- [x] 5.1 `npm test` (full main suite + sync + docs snippets) green
- [x] 5.2 `@run402/astro` build + test green
- _Deferred (optional, not shipped in this change):_ 5.3 `run402 ci list --include-revoked` (kychee-com/run402#473 Ask 2) — blocked on gateway `GET /ci/v1/bindings?include_revoked=1`
