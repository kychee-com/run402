# Changelog

All notable changes to `@run402/sdk`, `run402` (CLI), `run402-mcp`, and `@run402/functions`. Versions are kept in lockstep across the four packages.

## 2.2.0 — 2026-05-18

Closes the v1.48 unified-apply asset pipeline end-to-end. v2.0.0/v2.0.1 shipped the deploy hero (`r.project(id).apply(spec)`) but left three structural gaps in the asset slice: the normalizer didn't read `spec.assets`, `NodeAssets.uploadDir/syncDir/prepareDir/putMany` never uploaded bytes, and `Assets.put` still called the removed `/storage/v1/uploads*` substrate (404 in production). This release closes all three.

### Added

- **`@run402/functions` `assets` namespace.** `import { assets } from "@run402/functions"` exposes `assets.put(key, source, opts)` for in-function blob uploads. Routes through the new gateway `POST /apply/v1/service-asset-put` (service-key auth) so per-key visibility flips inside the same activation sub-transaction the wallet-auth apply hero uses. Quota enforcement, per-unique-hash storage billing, and immutable URL retention behave identically to deploy-time `r.project(id).apply({ assets: { put: [...] } })`.
- **Wire-shaped `assets` slice in the unified apply spec.** `ReleaseSpec.assets?: AssetSpec` carries `put?: (AssetPutEntry | AssetPutEntryInput)[]`, `delete?: string[]`, and `sync?: { prefix, prune: true, confirm? }`. The SDK input form (`AssetPutEntryInput` with `source: ContentSource`) and the wire form (`AssetPutEntry` with `sha256` + `size_bytes`) can be mixed in the same array.
- **`r.assets.uploadDir(path, opts)` / `syncDir` / `prepareDir` / `putMany`.** Node-only directory ergonomics that walk filesystem, hash, register byte readers, and submit through the single `apply` hero. `entriesFromLocalDir` now returns `AssetPutEntryInput[]` (with `source` retained) instead of pre-hashed wire entries, so the SDK normalizer registers byte readers and bytes flow through `/content/v1/plans`.
- **`DeployResult.assets`** is populated from the plan response's `asset_entries[]`. Carries `list` / `byKey` with the gateway-authoritative `AssetRef` envelope (resolved URLs + SRI + etag + content_digest) plus `totals.bytes_uploaded` / `bytes_reused` (derived from per-entry `status: "upload_pending" | "present" | "satisfied_by_plan"`).
- **`slice_kind` discriminator on observability events.** `content.upload.skipped` / `content.upload.progress` events carry `slice_kind: "release" | "asset" | "mixed"` per SHA; `commit.phase` and `ready` events carry `slice_kinds: ("release" | "asset")[]` summarizing which slice categories the apply's spec carried. Cross-kind CAS dedup (same SHA in `site` + `assets`) escalates the per-SHA value to `"mixed"`.
- **CLI/MCP unified deploy tool now accepts `assets`.** `deploy.apply` (`run402 deploy apply --manifest run402.json`, MCP `deploy` tool) accepts `assets: { put: [{ key, source: { data, encoding? } | { path } }], delete?, sync? }` via the manifest normalizer.
- **Run402 ReleaseSpec JSON schema** (`schemas/release-spec.v1.json`, hosted at `https://run402.com/schemas/release-spec.v1.json`) now describes the `assets` slice with full `$defs/assetPutEntry`, `$defs/assetSync`.

### Changed

- **`r.assets.put` routes through the apply hero.** Single-key upload calls `r.project(id).apply({ assets: { put: [{ key, source: bytes }] } })` and reads the resolved `AssetRef` from `result.assets.byKey[key]`. Behavior matches v2.0.1 from the caller's perspective; the wire path moved to `/apply/v1/plans` + `/content/v1/plans`.
- **CLI `run402 assets put <file>`** delegates to `sdk.assets.put`. The pre-v2.x multipart S3 PUT + resumable session machinery (`~/.run402/uploads/<upload_id>.json`) is gone; resume semantics live at the apply-plan level (24h TTL). The `--concurrency` and `--no-resume` flags are accepted for backward compatibility but ignored.
- **`@run402/functions` runtime helper bundle.** Added `assets` to the export list alongside `db` / `adminDb` / `getUser` / `email` / `ai` / `routedHttp`. No change to the existing exports.

### Removed / deprecated

- **`Assets.initUploadSession` / `getUploadSession` / `completeUploadSession`** throw `LocalError` with an actionable migration message pointing to `r.project(id).apply({ assets: { put: [...] } })` / `r.assets.uploadDir`. Gateway v1.48 dropped the `/storage/v1/uploads*` substrate. The method shapes (and the `BlobUploadInit*` / `BlobUploadStatus*` / `BlobUploadComplete*` types they reference) are kept in the TypeScript surface for source-compat with downstream code that imports them; surface removal is a v3 candidate.

### Gateway changes (shipped to production alongside this release)

- **`POST /apply/v1/service-asset-put`** (service-key auth). In-function blob upload endpoint. Hashes raw body, PutObject to `_cas/<sha[0:2]>/<sha[2:]>`, upserts `internal.content_objects`, calls the shared `applyOneAssetPut` primitive in a short transaction, returns the resolved `AssetRef`. 25 MB inline cap.
- **`applyOneAssetPut`** extracted from `promoteStagedAssetSlice` as the shared per-put primitive. The wallet apply hero and the service-key route both call it; INSERTs into `internal.blobs` / `internal.asset_versions` (skipped when `operationId === null` for service uploads) / `internal.blob_url_refs` are byte-identical between the two paths.
- **`promoteStagedAssetSlice` now inserts `internal.blob_url_refs`** for every immutable put. Without this row the immutable URL form (`pr-<id>.run402.com/_blob/<key-with-sha-suffix>`) returned 404 for assets uploaded via the unified-apply hero; the legacy `/storage/v1/uploads*` cas-promote path always inserted it.

### Migration notes

If you were using v2.0.x and relied on `r.assets.initUploadSession` for low-level resumable uploads, migrate to `r.project(id).apply({ assets: { put: [...] } })` — the apply engine handles retries and large-file streaming through the unified content plan. For single-key uploads, `r.assets.put(projectId, key, source, opts)` is now the recommended surface and routes through the same hero.

If you were running an older gateway (pre-v1.48), this SDK release won't compile against it because the `/storage/v1/uploads*` routes return 404. Upgrade the gateway first.
