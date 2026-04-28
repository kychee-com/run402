## REMOVED Requirements

### Requirement: Upload file shows public URL

**Reason**: The `upload_file` MCP tool that this requirement describes is being deleted from the registered surface (2026-04-28 sunset). The legacy `/storage/v1/object/{bucket}/{path}` routes return 404 from the gateway since the v1.33 cutover. The replacement `blob_put` tool is shipped via `src/tools/blob-put.ts` and the `sdk.blobs.put()` namespace; it returns CDN-fronted URLs in its response and is covered by its own implementation, not by this `incremental-deploy` spec.

**Migration**: None. Pre-revenue, no paying customers, clean-slate removal — `upload_file` is deleted with no bridge to the new tool. New consumers use `blob_put` directly, documented in its own terms.
