## 1. MCP Tools

- [x] 1.1 Add optional `inherit` boolean to `deploySiteSchema` in `src/tools/deploy-site.ts` and pass it in the request body
- [x] 1.2 Add optional `inherit` boolean to `bundleDeploySchema` in `src/tools/bundle-deploy.ts` and pass it in the request body
- [x] 1.3 Show `url` field in `upload_file` response in `src/tools/upload-file.ts` when present

## 2. Unit Tests

- [x] 2.1 Add test to `src/tools/upload-file.test.ts` for public URL in response
- [x] 2.2 Add test to `deploy-site` for passing `inherit: true` in request body (new test file or extend existing)
- [x] 2.3 Add test to `bundle-deploy` for passing `inherit: true` in request body (new test file or extend existing)

## 3. CLI

- [x] 3.1 Add `--inherit` flag to `sites deploy` in `cli/lib/sites.mjs` and pass in request body
- [x] 3.2 Update help text in `cli/lib/deploy.mjs` to document `inherit` field in manifest

## 4. Validation

- [x] 4.1 Run `npm test` and verify all tests pass
