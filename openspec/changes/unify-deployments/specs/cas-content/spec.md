## ADDED Requirements

### Requirement: Gateway exposes a content-addressed content service

The gateway SHALL expose a content-addressed storage service used internally by `unified-deploy`, the `blobs` storage namespace, and the manifest-ref escape hatch. The service SHALL provide:

- `POST /content/v1/plans` — accepts `{ project_id, content: [{ sha256: hex, size: int, content_type?: string }] }` and returns `{ plan_id, missing: [{ sha256, mode: "single" | "multipart", parts: [{ part_number, url, byte_start, byte_end }], expires_at }] }`. Entries already present-for-this-project (per the project-scoped presence rule below) SHALL be omitted from `missing`.
- Presigned PUTs to S3 staging for missing content. Each PUT SHALL carry the per-part SHA-256 in the `x-amz-checksum-sha256` header; the gateway-issued URL SHALL pin the expected checksum so a corrupted upload fails at S3.
- `POST /content/v1/plans/:id/commit` — finalizes a plan by promoting staged objects from the project's staging area to the shared CAS, and recording per-project reference proofs (`internal.plan_claims`). Multipart uploads complete here.

The body limit on `POST /content/v1/plans` SHALL be 5 MB.

The implementation SHALL reuse the existing v1.32 substrate (`internal.content_objects`, `internal.deploy_plans`, `internal.plan_claims`, `internal.upload_sessions` with `kind='cas'`, `services/cas-promote.ts`, `services/copy-resume.ts`). This route is a generic content-route surface over already-shipping infrastructure; it SHALL NOT introduce a parallel storage layer or per-project storage rows.

#### Scenario: Plan reports presence-only for already-uploaded SHAs

- **WHEN** the SDK calls `POST /content/v1/plans` listing 10 SHAs of which 7 are already in the project's CAS
- **THEN** the response `missing` contains exactly 3 entries
- **AND** the project's CAS state is unchanged at this point (no DB writes for entries already present)

#### Scenario: Multipart mode chosen by the gateway for large objects

- **WHEN** the SDK lists a missing entry whose `size` exceeds the gateway's single-PUT threshold
- **THEN** the plan response sets `mode: "multipart"` for that entry with multiple parts and per-part presigned URLs
- **AND** each part covers a contiguous byte range without gaps or overlap

#### Scenario: Bytes upload via presigned PUT, never through the gateway

- **WHEN** the SDK uploads a missing object's bytes
- **THEN** the PUT request goes directly to the presigned S3 URL
- **AND** the gateway is not in the request path for the bytes themselves

### Requirement: CAS content presence is project-scoped

CAS content **presence** SHALL be scoped per project. A SHA present in project A's references SHALL NOT count as present for project B; project B's plan response SHALL list that SHA in `missing` until project B has either (a) uploaded the bytes itself within a plan, or (b) accumulated a reference to the SHA via its own `blobs` / `deployment_files` / staged-function rows. The presence answer SHALL NOT leak whether any other project has uploaded the same SHA.

This is a privacy and isolation guarantee — projects MUST NOT learn about each other's content presence via cross-project dedup.

The implementation SHALL enforce this via the existing v1.32 substrate: `internal.plan_claims` (per-project proof of upload completion within a plan) joined with the project's own ref tables. Storage SHALL remain globally shared in S3 (one object per SHA across the platform) — this is a cost optimization that does not weaken the presence guarantee, because presence is decided by joins, not by storage layout.

#### Scenario: Same SHA in two projects requires two uploads

- **WHEN** project A has uploaded a file with SHA X
- **AND** project B issues a plan listing SHA X as content it wants to ship
- **THEN** project B's plan response includes that SHA in `missing`
- **AND** project B uploads the bytes itself
- **AND** the second upload is observable as a fresh presigned PUT — project B cannot infer from latency, response shape, or any other side channel that project A previously uploaded the same bytes

### Requirement: CAS content service is reused by `blobs.put` internally

The `blobs.put` SDK method SHALL use the same internal CAS content service for byte transport. The public `POST /storage/v1/uploads` and `POST /storage/v1/uploads/:id/complete` routes SHALL continue to exist (no breaking change for blob callers), but their handlers SHALL delegate to the CAS content service for the byte staging step.

The agent-observable behavior of `blobs.put` SHALL be unchanged — the response shape (`AssetRef` with `cdnUrl`, `scriptTag()`, `linkTag()`, `imgTag()`, etc.) is preserved.

#### Scenario: blobs.put is byte-identical from the caller's perspective

- **WHEN** an agent calls `r.blobs.put(projectId, "logo.png", { bytes: imageBytes })` against the new gateway
- **THEN** the returned `AssetRef` is shape-identical to the pre-change result (same `cdnUrl`, `sri`, `contentDigest`, etc.)
- **AND** the SDK uses the gateway's `/storage/v1/uploads` route as before

#### Scenario: Internal CAS dedup applies to blobs

- **WHEN** an agent uploads an `AssetRef` for `logo.png` and then later calls `blobs.put` with the same bytes under a different key
- **THEN** the second upload's plan reports the SHA as already present
- **AND** no S3 PUT is issued for the bytes

### Requirement: Manifest-ref pre-upload uses the CAS content service

When a deploy spec exceeds the inline plan body cap (5 MB), the SDK SHALL upload the manifest JSON itself as a CAS object via this content service, with `content_type: "application/vnd.run402.deploy-manifest+json"`. The deploy plan request SHALL then reference the manifest via its ContentRef.

The gateway SHALL fetch the manifest from CAS as the first step of plan processing when `manifest_ref` is present.

#### Scenario: Large manifest is uploaded as CAS first

- **WHEN** the SDK normalizes a ReleaseSpec whose JSON serialization is 9 MB
- **THEN** the SDK calls `POST /content/v1/plans` listing the manifest's SHA, uploads the missing manifest bytes, and calls `POST /deploy/v2/plans` with `manifest_ref: { sha256, size, content_type: "application/vnd.run402.deploy-manifest+json" }`

#### Scenario: Gateway reads manifest from CAS

- **WHEN** the gateway receives a deploy plan request with `manifest_ref`
- **THEN** the gateway fetches the manifest bytes from the project's CAS namespace
- **AND** processes the deploy plan as if the manifest had been inlined

### Requirement: Presigned URL TTL and refresh semantics

Presigned PUT URLs returned by `POST /content/v1/plans` SHALL have a TTL of at least 1 hour. The plan response SHALL surface the URL `expires_at` so SDKs can refresh proactively before TTL.

Re-issuing a plan for the same `(project_id, content list)` SHALL return fresh presigned URLs without altering CAS presence state — re-planning is safe and free of side effects on bytes.

#### Scenario: SDK refreshes URLs before TTL expires

- **WHEN** the SDK has held a plan for more than 50 minutes (under the 1-hour TTL) and still has uploads remaining
- **THEN** the SDK re-calls `POST /content/v1/plans` with the same content list to obtain fresh URLs
- **AND** the second call's `missing` list excludes objects already uploaded in the first plan window

#### Scenario: Expired URL retry succeeds after refresh

- **WHEN** an S3 PUT returns 403 (URL expired) during upload
- **THEN** the SDK re-plans once and retries the failed PUT against the new URL
- **AND** the upload succeeds without surfacing the transient failure to the caller
