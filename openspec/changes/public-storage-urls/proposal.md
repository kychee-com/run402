## Why

Storage files require an `apikey` header to access, making them unusable for browser-facing content like `<img src="...">`, user avatars, or event photos. Browsers can't send custom headers for resource tags. Additionally, the upload response only returns `{ key, size }` with no URL, forcing developers to guess the access pattern. These two issues (#27 and #25) together make the storage API impractical for any app with user-facing uploaded content.

## What Changes

- Add a **public storage route** `GET /storage/v1/public/:project_id/:bucket/*` that serves files without auth — any file uploaded to storage can be accessed via this deterministic URL.
- Return a **`url` field** in the upload response pointing to the public URL, so developers immediately know how to reference their uploaded file.
- No new "public bucket" concept or per-file ACLs — all storage files for active projects are publicly readable via the public route. Auth is still required for upload, list, and delete.

## Capabilities

### New Capabilities
- `public-storage-access`: Unauthenticated read access to storage files via a deterministic public URL, and returning the public URL from the upload endpoint.

### Modified Capabilities

_(none)_

## Impact

- **Code**: `packages/gateway/src/routes/storage.ts` (new public GET route, modify upload response)
- **APIs**: New unauthenticated route `GET /storage/v1/public/:project_id/:bucket/*`. Upload response gains a `url` field (additive, non-breaking).
- **Security**: All storage files become publicly readable by URL. This matches the Supabase model where public buckets are the default for user-facing content. Sensitive files should use the authenticated route.
- **Docs**: `site/llms.txt` and `site/openapi.json` need the new endpoint added.
