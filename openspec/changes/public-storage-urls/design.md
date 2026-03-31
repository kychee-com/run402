## Context

Storage files are stored in S3 at `{project_id}/{bucket}/{path}`. The existing authenticated route (`GET /storage/v1/object/:bucket/*`) reads `project_id` from the JWT in the `apikey` header. For a public route, `project_id` must come from the URL path instead.

The existing signed URL endpoint (`POST /storage/v1/object/sign/:bucket/*`) generates 1-hour S3 pre-signed URLs. This is too short-lived and per-request for persistent `<img src>` references.

## Goals / Non-Goals

**Goals:**
- Serve storage files without auth via a deterministic URL
- Return the public URL from the upload response
- Keep it simple — no per-file ACLs, no public/private bucket toggle

**Non-Goals:**
- Per-file or per-bucket access control (all files are publicly readable)
- CDN caching for public storage (future optimization)
- Removing the authenticated GET route (it stays for backward compatibility)

## Decisions

### 1. URL shape: `/storage/v1/public/:project_id/:bucket/*`

Include `project_id` in the path since there's no JWT to derive it from. This is the same pattern S3 uses (bucket + key = full path).

**Alternative considered:** `/storage/public/:bucket/*` with project_id as a query param — rejected because it's less RESTful and harder to use in `<img src>`.

### 2. All storage files are publicly readable

No per-file or per-bucket visibility flag. Every file uploaded to storage is readable via the public URL. This matches the most common use case (user-facing content) and avoids schema migration complexity.

**Alternative considered:** `public` flag per upload — rejected as over-engineering for current needs. Apps needing private files can use the authenticated route + signed URLs.

### 3. Upload response returns `url` field

The upload response changes from `{ key, size }` to `{ key, size, url }` where `url` is the full public URL. This is additive and non-breaking.

### 4. Validate project exists and is active

The public route should verify the project exists and is active (not archived/deleted) before serving files. This prevents serving files from deleted projects and avoids leaking data.

## Risks / Trade-offs

- **[All files public]** → Apps storing sensitive files (API keys, private documents) in storage would expose them. → This is acceptable — storage is documented as a content hosting layer, not a secrets store. Secrets have their own endpoint.
- **[No caching]** → Every public request hits the gateway → S3. → Acceptable for now; add CDN caching later if traffic warrants it.
- **[Enumeration]** → Project IDs in URLs allow probing for files. → S3 returns 404 for nonexistent keys, so no information leak beyond "project exists". List endpoint still requires auth.
