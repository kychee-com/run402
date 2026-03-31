## 1. Public Read Route

- [x] 1.1 Add `GET /storage/v1/public/:project_id/:bucket/*` route in `storage.ts` — no auth middleware, validate project exists and is active, fetch file from S3 using `{project_id}/{bucket}/{path}` key, return with Content-Type
- [x] 1.2 Return 404 for missing projects, inactive projects, and missing files

## 2. Upload Response URL

- [x] 2.1 Modify the POST upload handler to include a `url` field in the response: `https://{req.host}/storage/v1/public/{project_id}/{bucket}/{path}`

## 3. Docs

- [x] 3.1 Add the new `GET /storage/v1/public/:project_id/:bucket/*` endpoint to `site/llms.txt`

## 4. Verification

- [x] 4.1 Test: upload a file, verify response includes `url` field (added to e2e.ts step 12c)
- [x] 4.2 Test: fetch the public URL without auth, verify 200 with correct content (added to e2e.ts step 12c)
- [x] 4.3 Test: fetch a nonexistent file via public URL, verify 404 (added to e2e.ts step 12c)
