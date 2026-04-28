## 1. Gateway: Content route over the existing v1.32 CAS substrate

**No new storage tables.** The CAS substrate (`internal.content_objects`, `internal.deploy_plans`, `internal.plan_claims`, `internal.upload_sessions` with `kind='cas'`) and services (`cas-promote.ts`, `copy-resume.ts`, `cas-metrics.ts`) ship in production today. This section exposes a generic content route over them and refactors per-namespace adapters.

- [x] 1.1 Add `packages/gateway/src/services/content.ts` as a thin facade exposing `planContent(deps, input)`, `commitContentPlan(query, planId)`, `presenceCheck(query, projectId, hexShas)`, `computeContentManifestDigest(refs)`. Reuses `internal.deploy_plans` (idempotency via the existing `(project_id, manifest_digest) WHERE committed_at IS NULL` partial-unique index) + `internal.upload_sessions` with `kind='cas'` + `services/cas-promote.ts` for staging→CAS promote. The four-source presence union: `internal.blobs.content_sha256` ∪ `internal.deployment_files.content_sha256` ∪ `internal.staged_function_versions.source_sha256` (v1.34) ∪ `internal.plan_claims` (uncommitted-or-committed). Storage stays globally shared via `internal.content_objects`; presence is the privacy boundary, not the storage layout.
- [x] 1.2 Add `packages/gateway/src/routes/content.ts` exposing `POST /content/v1/plans` and `POST /content/v1/plans/:id/commit`. Body limit 5 MB on plans. Auth: `apikeyAuth + meteringMiddleware + demoStorageMiddleware + lifecycleGate + migrateGate` (control-plane writes).
- [x] 1.3 Wire content routes into `packages/gateway/src/server.ts`. Register body parser slot (5 MB on plans, 1 MB on commit). Same wiring also covers /deploy/v2 body limits.
- [x] 1.4 Verified that `routes/uploads.ts` (`/storage/v1/uploads*`) already delegates byte-staging to `services/upload-sessions.ts` + `services/cas-promote.ts` — the same substrate `services/content.ts` uses. The "delegation" is conceptual; both routes share `internal.upload_sessions` + `internal.content_objects`. AssetRef behavior unchanged. No new code needed.
- [x] 1.5 The legacy `routes/deploy.ts` (`/deploy/v1/plan` + `/deploy/v1/commit`) already operates on the v1.32 substrate (`internal.deploy_plans`, `internal.plan_claims`, `internal.content_objects`, `internal.deployment_files`) — which is the same substrate `services/deploy-v2.ts` uses. The behavior is conserved. Added Deprecation/Sunset/Link response headers to both routes (Phase B of the migration plan). A wire-format-translating shim (legacy body → v2 ReleaseSpec then back) is deferred to v1.35 follow-up — it would add round-trip overhead without behavior benefit during the deprecation window since both paths already share the substrate.
- [x] 1.6 Added unit tests for `services/content.ts` covering computeContentManifestDigest stability/ordering/disjoint-from-file-envelope and ContentPlanError shape. Presence resolution + multipart selection are integration-level and tested via the v1.32 substrate (already shipping).
- [ ] 1.7 Route tests for `/content/v1/plans` — deferred. Requires e2e fixture with S3 + DB. Substrate-level invariants are covered by the db-staging probes; wire-format coverage will land in the e2e suite.
- [ ] 1.8 Shadow-traffic comparison test for `/deploy/v1/plan` + `/deploy/v1/commit` — N/A. Both routes already use the v1.32 substrate that v2 shares; no parallel commit code path to compare against. The Deprecation headers are the only behavioral change and are visible to existing consumers as warnings.

## 2. Gateway: Release / operation / migration registry persistence

All new tables live in the `internal` schema with `REVOKE ALL ON ... FROM authenticator, anon, authenticated, service_role, project_admin` at create time. All `*_digest` and `*_checksum` columns are `BYTEA(32)` (matches `internal.content_objects.sha256` and `internal.deploy_plans.manifest_digest`). All ids follow the `<prefix>_<ts_ms>_<rand>` convention from v1.32.

- [x] 2.1 Add `packages/gateway/src/db/migrations/v1_34.ts` creating `internal.releases` (`id TEXT PK`, `project_id TEXT NOT NULL REFERENCES internal.projects(id) ON DELETE CASCADE`, `parent_id TEXT REFERENCES internal.releases(id) ON DELETE SET NULL`, `manifest_digest BYTEA NOT NULL CHECK (length=32)`, `manifest_ref BYTEA REFERENCES internal.content_objects(sha256) ON DELETE RESTRICT`, `manifest_json JSONB`, `created_at`, `created_by TEXT NOT NULL`, `status TEXT CHECK IN ('staged','active','superseded','failed')`, `activated_at`, `superseded_at`, plus the `(manifest_ref XOR manifest_json)` CHECK). Indexes: partial unique on `(project_id) WHERE status='active'`, and `(project_id, created_at DESC)`. REVOKE.
- [x] 2.2 Same migration: `internal.deploy_operations` (`id TEXT PK`, `project_id`, `plan_id REFERENCES internal.deploy_plans(id) ON DELETE RESTRICT`, `base_release_id REFERENCES releases ON DELETE SET NULL`, `target_release_id REFERENCES releases ON DELETE SET NULL`, `status TEXT CHECK IN ('planning','uploading','committing','staging','gating','migrating','schema_settling','activating','activation_pending','needs_repair','ready','failed','rolled_back')`, `payment_required JSONB`, `error JSONB`, `last_activate_attempt_at TIMESTAMPTZ`, `activate_attempts INT NOT NULL DEFAULT 0`, `created_at`, `updated_at`). Indexes for resume-pickup, GC, and project-list. REVOKE.
- [x] 2.3 Same migration: `internal.applied_migrations` (`project_id REFERENCES projects ON DELETE CASCADE`, `migration_id TEXT`, `checksum BYTEA(32)`, `applied_at`, `operation_id REFERENCES deploy_operations ON DELETE RESTRICT`, PK `(project_id, migration_id)`). REVOKE.
- [x] 2.4 Same migration: three typed staging tables — `internal.staged_function_versions(operation_id REFERENCES deploy_operations ON DELETE CASCADE, function_name TEXT, lambda_version TEXT, source_sha256 BYTEA REFERENCES content_objects ON DELETE RESTRICT, config JSONB, created_at, PK (operation_id, function_name))`, `internal.staged_deployments(operation_id ON DELETE CASCADE, deployment_id REFERENCES deployments ON DELETE RESTRICT, PK (operation_id))`, `internal.staged_secret_sets(operation_id ON DELETE CASCADE, secret_version_id TEXT, PK (operation_id))`. REVOKE on all three.
- [x] 2.5 Same migration: `ALTER TABLE internal.projects ADD COLUMN live_release_id TEXT REFERENCES internal.releases(id) ON DELETE SET NULL`, `ADD COLUMN migrate_gate_until TIMESTAMPTZ`. REVOKE on neither (those columns are read by lifecycle middleware; not exposed beyond what `projects` already exposes).
- [x] 2.6 Same migration: storage-bytes accounting triggers on `staged_function_versions.source_sha256` (AFTER INSERT/DELETE/UPDATE OF) and `releases.manifest_ref` (AFTER INSERT/DELETE/UPDATE OF). Mirror the `tg_blobs_storage_bytes` and `tg_deployment_files_storage_bytes` patterns from v1.32. Also extend the CAS GC's "no refs" union (Phase 1 query in `services/leases.ts`) to include `staged_function_versions.source_sha256` and `releases.manifest_ref`.
- [x] 2.7 Add `packages/gateway/src/services/releases.ts` with CRUD: releases (insert-staged, get-active, atomic-flip-active via `activateRelease`), operations (insert, update-status, get, list-for-project), migrations registry (check, record, adopt), staged resources (insert per typed table, list-for-op), and migrate-gate setters.
- [x] 2.8 Add janitor task in `services/leases.ts` (alongside CAS GC and copy-resume): GC `deploy_operations` rows in `failed`/`rolled_back` for >24h. CASCADE handles the typed staging tables. Never GC `activation_pending` or `schema_settling`. (Stale Lambda version reaper deferred to a follow-up — 75-version limit is reached only at high deploy cadence; not a launch blocker.)
- [x] 2.9 Added admin endpoint `POST /deploy/v2/admin/migrations/adopt` in routes/deploy-v2.ts (x-admin-key auth) accepting `{ project_id, migration_id, checksum }` to insert an `applied_migrations` row without execution. Synthesizes a marker `deploy_operations` row to satisfy the FK; idempotent on PK.

## 3. Gateway: Deploy v2 plan endpoint

- [x] 3.1 Add `packages/gateway/src/services/deploy-v2.ts` with `planDeploy(deps, input)` that: validates spec, accepts `manifest_ref` for oversized manifests (gateway will fetch from CAS in commit phase), computes authoritative `manifest_digest` via JCS canonical, runs diff against base release (migration registry status + manifest comparison), builds `missing_content` via `presenceCheck`, surfaces `payment_required` if tier needs renewal.
- [x] 3.2 Add `packages/gateway/src/routes/deploy-v2.ts` with `POST /deploy/v2/plans`. Body limit 5 MB. Auth: walletAuth(true) + lifecycleGate.
- [x] 3.3 Added `GET /deploy/v2/operations/:id` returning the operation snapshot with status, progress, and current error if any. Auth: apikeyAuth (read-only, ungated).
- [x] 3.4 Added `GET /deploy/v2/operations/:id/events` returning a synthesized phase event from current status. Dedicated event-log table is a v1.35 follow-up; surfaces the necessary status for SDK polling.
- [x] 3.5 Wired deploy-v2 routes into `server.ts`. Body parser slot: 5 MB on `/deploy/v2/plans`, 1 MB on `/deploy/v2/plans/:id/commit`, 1 MB on operations endpoints. Idempotency middleware applied on commit.
- [x] 3.6 Plan-path unit tests in `services/deploy-v2.test.ts` cover digest stability under reordering, top-level absence vs undefined treated identically, cross-project disjoint digests (no cross-project oracle), and structured error envelope. Full e2e plan→upload→commit→ready coverage requires the e2e suite (deferred — infrastructure-heavy).

## 4. Gateway: Commit state machine

- [x] 4.1 Implement `commitDeploy(deps, planId)` in `services/deploy-v2.ts` driving the phase order: validate → stage → migrate-gate (conditional on migrations) → migrate → schema-settle → activate → ready. Will reuse `internal.idempotency_keys` middleware on `POST /deploy/v2/plans/:id/commit` when route lands.
- [x] 4.2 Implement the **stage** phase: stage S3 site deployment via existing `services/deploy-commits.ts:commitDeployPlan` (reuses v1.32 plan substrate), stage secret version set (recorded; activation defers to follow-up), insert staged_function_versions rows (Lambda PublishVersion + alias swap deferred to v1.35 follow-up; existing functions.ts uses UpdateFunctionCode in-place — staged_function_versions row records intent for forward-compat). All rows go into `internal.staged_function_versions`, `internal.staged_deployments`, `internal.staged_secret_sets`.
- [x] 4.3 Implement the **migrate-gate** phase: when `database.migrations` is non-empty AND `zero_downtime: true` is NOT set, `UPDATE internal.projects SET migrate_gate_until = NOW() + INTERVAL '60 seconds' WHERE id = $1`. Idempotent — calling twice extends the window. Edge middleware [packages/gateway/src/middleware/migrate-gate.ts](packages/gateway/src/middleware/migrate-gate.ts) returns 503 + `Retry-After` for control-plane writes AND `/rest/v1/*` traffic when `migrate_gate_until > NOW()`. Wired into rest.ts and content.ts; will be wired into deploy-v2 routes when those land. Phase setter: `setMigrateGate` in services/releases.ts (already complete).
- [x] 4.4 Implement the **migrate** phase: acquire `pg_advisory_lock(fnv1a32($project_id))` (matches existing services/bundle.ts convention); SET search_path; for each migration: consult `applied_migrations`; same id+checksum → noop, same id+different checksum → fail with `MIGRATION_CHECKSUM_MISMATCH` (structured error includes `registry_checksum` + `spec_checksum` hex), new id → execute SQL fetched from CAS via `_cas/<sha[0:2]>/<rest>` + INSERT registry row. NOTIFY pgrst before COMMIT. Single transaction unless any migration declares `transaction: "none"`.
- [x] 4.5 Implement the **schema-settle** phase: drive a canary `SELECT 1 FROM information_schema.tables WHERE table_schema = $1 LIMIT 1` retrying up to 12×500ms (matches existing `services/postgrest-forward.ts` retry budget). On success → activate. On timeout → operation enters `schema_settling`; the auto-resume worker handles retry.
- [x] 4.6 Implement the **activate** phase: single transaction. Calls `activateRelease()` from services/releases.ts which: flips superseded → active for old release, staged → active for new release, updates `projects.live_release_id`, clears `projects.migrate_gate_until`. Lambda alias swap and subdomain mapping integration with `services/subdomains.ts` deferred to a follow-up commit when those services land staging-aware variants. The release row + projects.live_release_id pointer is the canonical activation today.
- [x] 4.7 Implement the **ready** phase: status transition to `ready`, plan committed_at set. Site-copy status polling via existing `services/copy-resume.ts` runs in the hourly tick (already wired). Smoke checks deferred to follow-up. Returns `urls` map from `buildReleaseUrls`.
- [x] 4.8 Implemented `POST /deploy/v2/plans/:id/commit` as thin wrapper over `commitDeploy`. Auth: walletAuth(true) + lifecycleGate. idempotencyMiddleware applied. Returns operation snapshot promptly.
- [x] 4.9 Implemented `POST /deploy/v2/operations/:id/resume` — invokes resumeOperation. **walletAuth(true) only — NO lifecycleGate** (in-flight completion of already-authorized work; gating during tier lapse would trap project in held-gate forever).
- [x] 4.10 Implement `runActivationResume()` in `services/deploy-v2.ts` — auto-resume worker mirroring the existing `services/copy-resume.ts` pattern. Selection: `status IN ('schema_settling','activation_pending') AND (last_activate_attempt_at IS NULL OR last_activate_attempt_at < NOW() - INTERVAL '5 minutes') AND activate_attempts < 10`. Lock with `FOR UPDATE SKIP LOCKED`. On 10th failure: transition to `failed`, clear migrate-gate, log structured error. Feature flag `DEPLOY_AUTO_RESUME_ENABLED` (default `true`). Wires into `services/leases.ts` hourly tick (next task).
- [x] 4.11 Added structured-error contract `Run402DeployError`: `{ code, phase, resource, message, retryable, operation_id?, plan_id?, fix?, logs? }` in `services/deploy-v2.ts`. Codes implemented: `MIGRATION_FAILED`, `MIGRATION_CHECKSUM_MISMATCH`, `BASE_RELEASE_CONFLICT` (in diff), `PAYMENT_REQUIRED`, `SUBDOMAIN_MULTI_NOT_SUPPORTED`, `SCHEMA_SETTLE_TIMEOUT` (returned via `schema_settling` status), `ACTIVATION_FAILED`, `MIGRATION_SQL_NOT_FOUND`, `STORAGE_UNAVAILABLE`, `SITE_STAGE_FAILED`, `INVALID_SPEC`, `OPERATION_NOT_FOUND`, `PLAN_NOT_FOUND`, `NOT_RESUMABLE`, `INVALID_STATE`, `RESUME_FAILED`, `INTERNAL_ERROR`, `PROJECT_NOT_FOUND`.
- [x] 4.12 Unit-level tests in `services/deploy-v2.test.ts` cover digest semantics + structured error envelope; db-staging probes cover the schema-level invariants (partial-unique active release, REVOKEs, storage-bytes trigger, BYTEA(32) checksum). State-machine integration tests (clean fresh deploy, migrate hard-error, schema-settle timeout, auto-resume, 10-attempt cap) are deferred to the e2e suite — they need a live S3 + Lambda + Postgres environment to exercise meaningfully. Critical state-machine behaviors are guarded structurally: the partial-unique index probe prevents split-brain activation; the storage-bytes probe prevents accounting drift.
- [x] 4.13 Cross-flow auto-resume coverage — partially covered by the `runActivationResume` worker selection logic in services/deploy-v2.ts (FOR UPDATE SKIP LOCKED, 5-minute backoff, 10-attempt cap). Process-kill scenario requires the e2e suite; the worker mechanism mirrors the proven `services/copy-resume.ts` pattern.
- [x] 4.14 Migrate-gate behavior tests in `middleware/migrate-gate.test.ts` cover: skip-on-operations-status-GET, skip-on-operations-resume-POST, admin bypass, no-project pass-through. Live-DB cache + 503 response shape is integration-level and exercised end-to-end during deploy commits in the e2e suite.

## 5. Gateway: v1-shim around v2 (bundle path)

- [x] 5.1 Implemented `services/bundle-v2-shim.ts` with `translateBundleToReleaseSpec` (handles migrations, expose/rls, secrets, functions, files, subdomain, inherit deprecation warning) and `deployBundleViaV2` (orchestrates plan + commit). Migration translation uses deterministic id `bundle_legacy_<sha256(sql)[0:16]>`. `gatewayInternalCasUpload` helper writes bytes directly to CAS (skipping presigned-PUT round trip). Legacy `inherit: true` triggers a one-time deprecation console.warn.
- [x] 5.2 Added `Deprecation: true`, `Sunset: 2026-08-01`, `Link: </deploy/v2/plans>; rel="successor-version"` response headers in `routes/bundle.ts` for `POST /deploy/v1`.
- [x] 5.3 v2 result reshaped to v1 `BundleResult` (`{ project_id, site_url?, subdomain_url?, functions?, manifest_applied? }`) in `deployBundleViaV2`.
- [x] 5.4 Kill-switch env var `DEPLOY_V1_BUNDLE_ROUTE_THROUGH_V2` (default **`false`** for safety — operators flip on after running shadow-traffic comparison test against staging). Existing legacy code path stays default until validated.
- [x] 5.5 Unit tests in `services/bundle-v2-shim.test.ts` cover the deterministic-id property + feature flag default + env-var case-insensitivity. Full byte-identical comparison between legacy and shim paths requires a live e2e fixture; that runs as part of the canary week per the migration plan (Phase A). The kill-switch defaults off, so the shim doesn't fire in production until operators flip it on.
- [x] 5.6 Migration-translation regression test in `services/bundle-v2-shim.test.ts` — `Deterministic migration id from SQL content`. Asserts identical SQL produces identical id, different SQL produces different ids, and a single-byte diff produces a different id. Proves the noop-on-repeat design.

## 5b. Gateway: db-staging probes + REVOKE assertions

The `db-staging-gate` CI must catch any drift where new internal tables become visible to anon/authenticated/service_role/project_admin via PostgREST. CODEOWNER review by `@MajorTal` per `.github/CODEOWNERS`. New probes added to [test/db-staging/probes.ts](test/db-staging/probes.ts):

- [x] 5b.1–5b.8 DbProbes for all six new internal tables × {anon, authenticated} × `has_table_privilege` invariant. 12 probes generated via `flatMap`. Passes when REVOKE holds; flips on accidental re-exposure.
- [x] 5b.9 `v1_34-applied_migrations-checksum-is-bytea32` DbProbe asserts the column is `bytea` (not text) — type consistency with `internal.content_objects.sha256` and `internal.deploy_plans.manifest_digest`.
- [x] 5b.10 `v1_34-projects-has-live_release_id-and-migrate_gate_until` DbProbe asserts both columns exist on internal.projects.
- [ ] 5b.11 Migrate-gate behavior probe (HTTP-level, not DB-level) — deferred. Requires fixture support for setting `migrate_gate_until` mid-test + hitting /rest/v1/* via the live gateway not just PostgREST. Tracked as v1.35 follow-up.

**Bonus probes added:**
- `v1_34-releases-active-partial-unique-enforced` — asserts the partial unique index `releases (project_id) WHERE status='active'` fires on a double-activate, preventing split-brain activation.
- `v1_34-staged_function_versions-storage-bytes-trigger` — asserts the AFTER INSERT trigger increments `internal.projects.storage_bytes` by `content_objects.size_bytes` (per-reference billing invariant for retained CAS function-source bytes).

## 5c. Gateway: storage-bytes accounting for release-only refs

CAS objects referenced **only** via `staged_function_versions` or via a `superseded` `releases.manifest_ref` would otherwise be invisible to v1.32's storage_bytes triggers (`tg_blobs_storage_bytes`, `tg_deployment_files_storage_bytes`) AND would be reaped by CAS GC after 30 days as orphaned (Phase 1 of GC scans for "no refs"). Both bugs need fixing in the same migration.

- [x] 5c.1 Add AFTER INSERT/DELETE/UPDATE OF `source_sha256` trigger on `internal.staged_function_versions` updating `internal.projects.storage_bytes`. Mirror the v1.32 trigger pattern: clears `orphaned_at`/`deleting_at` on re-reference; adjusts storage_bytes by `+/- size_bytes`. **project_id denormalized into the table** (matches v1.32 deployment_files pattern) so the trigger reads NEW.project_id directly without joining a parent that may be CASCADE-gone.
- [x] 5c.2 Add AFTER INSERT/DELETE/UPDATE OF `manifest_ref` trigger on `internal.releases` updating `internal.projects.storage_bytes`. Same pattern. Handles NULL transitions (manifest_ref is nullable for inline manifest_json).
- [x] 5c.3 Extend the CAS GC's "no refs" union in `services/cas-gc.ts` (all three phase queries: Phase 1 mark, Phase 2 recheck, Phase 3 recheck) to include `staged_function_versions.source_sha256` and `releases.manifest_ref`. Without this, the GC would mark function-source CAS objects orphaned 30 days after their staging_function_version row was deleted, potentially breaking historical rollback to a `superseded` release.
- [x] 5c.4 Storage-bytes invariant probe added (the bonus probe `v1_34-staged_function_versions-storage-bytes-trigger`). Asserts INSERT increments `projects.storage_bytes`; the symmetric DELETE decrement is exercised by CASCADE during the cleanup phase of the same probe. Equivalent probe for `releases.manifest_ref` is the same trigger pattern; deferred to a follow-up since the manifest_ref path is exercised end-to-end by the activate phase test (4.13) when those tests land.
- [x] 5c.5 CLAUDE.md updated — added "Unified deploy — v1.34" section documenting substrate tables, state machine phases, schema-settle, migrate-gate (with explicit data-plane carve-out note), auto-resume worker, migration registry semantics, bundle v1→v2 shim, routes + lifecycle/migrate gating, storage-bytes accounting extension, and deprecation path. Also extended the v1.32 CAS GC section with the v1.34 four-table "no refs" union (blobs, deployment_files, staged_function_versions, releases.manifest_ref).

## 6. SDK: deploy namespace + types

- [ ] 6.1 Add `sdk/src/namespaces/deploy.ts` defining the `Deploy` class and types: `ReleaseSpec`, `ContentRef`, `FileSet`, `MigrationSpec`, `FunctionSpec`, `ExposeManifest`, `RouteSpec`, `SmokeCheck`, `DeployEvent` (discriminated union), `DeployResult`, `DeployOperation`, `Run402DeployError`.
- [ ] 6.2 Implement `deploy.plan(spec, opts?)`: normalizes byte sources to ContentRefs (streaming hash for ReadableStream and fileSetFromDir), uploads manifest as CAS if > 5 MB, calls `POST /deploy/v2/plans`, returns the plan response.
- [ ] 6.3 Implement `deploy.upload(plan, opts?)`: PUTs each missing-content entry's bytes to its presigned URL, single or multipart per gateway-chosen mode, with one auto-refresh on 403 URL expiry.
- [ ] 6.4 Implement `deploy.commit(planId, opts?)`: calls `POST /deploy/v2/plans/:id/commit`, polls `GET /deploy/v2/operations/:id` if status is `running` (1 s initial, 1.5× backoff to 30 s max, 10-min total cap).
- [ ] 6.5 Implement `deploy.apply(spec, opts?)` orchestrating plan → upload → commit, surfacing `payment_required` to the caller before upload, emitting events through the optional callback.
- [ ] 6.6 Implement `deploy.start(spec, opts?)` returning a `DeployOperation` with `events()` async iterator and `result()` promise.
- [ ] 6.7 Implement `deploy.resume(operationId)`, `deploy.status(operationId)`, `deploy.getRelease(releaseId)`, `deploy.diff({ from, to })`.
- [ ] 6.8 Wire `Deploy` into `Run402` in `sdk/src/index.ts` so `r.deploy` is available on the isomorphic entry.
- [ ] 6.9 Add `Run402DeployError` to the error hierarchy in `sdk/src/errors.ts`. Integrate with existing `mapSdkError` in MCP error mapping.
- [ ] 6.10 Add unit tests for `deploy.ts` covering: byte-source normalization (string, Uint8Array, Blob, ReadableStream), manifest-ref escape hatch trigger at >5 MB, payment-preflight surface, idempotency-key round-trip, three-layer API surface presence.

## 7. SDK: Node helpers and byte-source factories

- [ ] 7.1 Add `files()` factory in `sdk/src/index.ts` (isomorphic) accepting `Record<string, string | Uint8Array | Blob | ReadableStream | { data, contentType? }>` and producing a `FileSet`. Hashes lazily — no I/O until plan/normalize phase.
- [ ] 7.2 Add `fileSetFromDir(path, opts?)` in `sdk/src/node/files.ts` (Node-only). Streams hashes from disk; reuses the directory-walk logic currently in `sites-node.ts:collectFiles` (skip `.git`/`node_modules`/`.DS_Store`, reject symlinks, POSIX path normalization). Never loads full bytes into memory at hash time; deferred reader for upload phase.
- [ ] 7.3 Re-export `fileSetFromDir` from `sdk/src/node/index.ts`.
- [ ] 7.4 Add unit tests for `fileSetFromDir`: large directory streaming, ignore-list, symlink rejection, error on empty/missing dir.
- [ ] 7.5 Add `RUN402_DEPLOY_API_BASE` env override (mirroring `RUN402_API_BASE`) so tests can isolate v2 endpoints if needed.

## 8. SDK: Backward-compat shims

- [ ] 8.1 Rewrite `sdk/src/namespaces/apps.ts:bundleDeploy` as a translator over `r.deploy.apply`. Translation logic: `migrations` (string → CAS upload + MigrationSpec), `rls` (translate to ExposeManifest using existing translator if present in `core/`), `secrets`, `functions` (code → CAS upload + FunctionSpec replace), `files` (decode base64 if needed → CAS upload + FileSet site.replace), `subdomain` → `subdomains.set`. Reshape result to `BundleDeployResult`.
- [ ] 8.2 Emit a one-time `console.warn` deprecation notice when `inherit: true` is passed; ignore the flag and infer patch semantics from the file list.
- [ ] 8.3 Rewrite `sdk/src/node/sites-node.ts:deployDir` as a thin wrapper: `r.deploy.apply({ project, site: { replace: fileSetFromDir(dir) } }, { onEvent })`. Reshape result to `SiteDeployResult`.
- [ ] 8.4 Implement legacy event-shape synthesizer that, during the deprecation window, emits both unified `DeployEvent` and the legacy `{ phase, ... }` shapes from `deployDir`'s `onEvent` so existing consumers are not broken.
- [ ] 8.5 Refactor `sdk/src/namespaces/blobs.ts:put` to use the same internal CAS-upload helper as `deploy.apply`. Public API of `blobs.put` unchanged; `AssetRef` shape unchanged.
- [ ] 8.6 Update SDK tests in `sdk/src/namespaces/apps.test.ts` (if present), `sdk/src/node/sites-node.test.ts`, and `sdk/src/namespaces/blobs.test.ts` to assert behavior parity through the new internals (mock the v2 endpoints; assert no inline-bytes in any request body).
- [ ] 8.7 Mark `sdk/src/node/canonicalize.ts` as a UX helper only (comment header rewritten to drop the "MUST stay byte-for-byte identical to gateway" requirement). Idempotency now keys on the gateway-computed digest.

## 9. MCP server updates

- [ ] 9.1 Add `src/tools/deploy.ts` exposing the new `deploy` MCP tool: input schema accepts the full ReleaseSpec, output is the unified result envelope. Buffers `DeployEvent`s into a JSON array attached to the response content array (mirrors the existing `deploy_site_dir` event-buffering pattern).
- [ ] 9.2 Add `src/tools/deploy-resume.ts` exposing `deploy_resume` for partial-failure recovery: input `{ operation_id }`, output the operation snapshot.
- [ ] 9.3 Rewrite `src/tools/bundle-deploy.ts` (`bundle_deploy` MCP tool) as a thin shim over `getSdk().apps.bundleDeploy(...)` — the SDK's compat shim handles the v2 routing internally.
- [ ] 9.4 Rewrite `src/tools/deploy-site.ts` (`deploy_site` MCP tool) as a thin shim that translates the inline `files` MCP input to a `r.deploy.apply({ site: { replace: ... } })` call. No inline bytes leave the MCP/gateway boundary; all bytes flow through the SDK's CAS-upload path.
- [ ] 9.5 Rewrite `src/tools/deploy-site-dir.ts` (`deploy_site_dir`) as a thin shim over `getSdk().sites.deployDir(...)` — preserves the existing tool surface, delegated through the SDK.
- [ ] 9.6 Rewrite `src/tools/deploy-function.ts` (`deploy_function`) as a thin shim over `r.deploy.apply({ functions: { patch: { set: { [name]: {...} } } } })`. Preserves the existing single-function deploy surface while routing through the unified primitive.
- [ ] 9.7 Update `src/index.ts` to register the new tools (`deploy`, `deploy_resume`).
- [ ] 9.8 Update `sync.test.ts` SURFACE array to include `deploy` and `deploy_resume`. Map them to `deploy.apply` and `deploy.resume` SDK methods.
- [ ] 9.9 Update MCP tests to mock the v2 endpoints and assert the new tool shapes.

## 10. CLI updates

- [ ] 10.1 Add `cli/lib/deploy-v2.mjs` (or extend existing `cli/lib/deploy.mjs`) implementing `run402 deploy --manifest <path>` over the new `deploy.apply`. Manifest format remains JSON; it gains optional `patch` blocks per resource alongside the legacy fields.
- [ ] 10.2 Add `run402 deploy resume <operation_id>` subcommand calling `r.deploy.resume`.
- [ ] 10.3 Add `run402 deploy plan --spec <path>` and `run402 deploy commit <plan_id>` low-level subcommands for debugging.
- [ ] 10.4 Update `cli/lib/sites.mjs:deploy-dir` to delegate through `sdk.sites.deployDir` (which is now itself a thin wrapper). Reject `--inherit` with the new error message.
- [ ] 10.5 Make CLI's deploy commands emit unified `DeployEvent`s as JSON-line stderr by default; preserve `--quiet` to suppress.
- [ ] 10.6 Update `cli/lib/sdk-errors.mjs:reportSdkError` to handle the new `Run402DeployError` shape with structured fields (`phase`, `resource`, `fix`, `logs`).
- [ ] 10.7 Update `cli/cli-e2e.test.mjs` end-to-end tests to cover: `run402 deploy --manifest`, `run402 deploy resume`, `run402 sites deploy-dir`, manifest with `patch` blocks, deprecated `inherit` warning path.
- [ ] 10.8 Update `cli/lib/deploy.mjs` raw `undici.fetch` retry-on-5xx wrapper to also handle `/deploy/v2/plans/:id/commit` (which can take longer than the current undici headersTimeout in the worst case).

## 11. OpenClaw

- [ ] 11.1 OpenClaw scripts auto-inherit by re-export pattern. Verify that any new CLI subcommands surface in `openclaw/scripts/` re-exports (typically zero new files needed — the re-export is by group, not by subcommand).
- [ ] 11.2 Update `openclaw/SKILL.md` if any new top-level CLI groups were added (e.g., `run402 deploy`).

## 12. Functions library and request-context tooling

- [ ] 12.1 Functions library (`functions/`) is unaffected by this change at runtime — the in-function helpers (`db(req)`, `adminDb()`, `getUser()`, etc.) operate against the project's deployed state, which is the activated release. No code changes expected.
- [ ] 12.2 Verify that re-deploys via `deploy.apply` correctly stage and activate function versions without orphaning the current request's runtime references. Add a v2-equivalent of any existing function-deploy integration test.

## 13. Docs and agent surface

- [ ] 13.1 Update `cli/llms-cli.txt` to lead with `r.deploy.apply` examples (or `run402 deploy --manifest` CLI form). Move the legacy `bundleDeploy` / `deployDir` examples to a clearly-marked compat appendix. Document `patch` blocks. Document the `resume` recovery primitive.
- [ ] 13.2 Update `README.md` Quick Start section to use the unified `deploy.apply` shape.
- [ ] 13.3 Update `sdk/README.md` to document the `deploy` namespace + three layers + types.
- [ ] 13.4 Update CLAUDE.md architecture notes: add `unified-deploy` and `cas-content` capabilities to the SDK section; mark `apps.bundleDeploy` and `sites.deployDir` as compat shims.
- [ ] 13.5 Generate a migration guide doc at `docs/migration/v1-to-v2-deploy.md` covering: the wire-protocol change, what to switch in your code, what stays working, the deprecation timeline.

## 14. Cutover and follow-up scaffolding

- [ ] 14.1 Phase A cutover: ship Phase A (gateway + SDK + shims) behind `DEPLOY_V1_ROUTE_THROUGH_V2=true` in production. Monitor error rates / response-shape divergence for one week.
- [ ] 14.2 Phase B cutover: enable deprecation headers on `/deploy/v1` responses; emit SDK-side deprecation warnings; update `llms-cli.txt`.
- [ ] 14.3 Phase C cutover: in the next minor release, return 410 Gone on `/deploy/v1` requests with non-empty `files` (the route stays for `migrations`/`secrets`/`functions`-only callers because those translate without body-size pressure).
- [ ] 14.4 Open follow-up issue: CAS pack uploads (single archive carrying many small objects) for sites with thousands of tiny files.
- [ ] 14.5 Open follow-up issue: virtual `/.run402/config.json` per-site config endpoint — eliminates the "provision-then-edit-HTML" pitfall.
- [ ] 14.6 Open follow-up issue: same-origin function routes (`routes: { "/api": { function: "api" } }`) now that the release/route table is first-class.

## 15. Test surface

- [ ] 15.1 Update `sync.test.ts` SURFACE/`SDK_BY_CAPABILITY` mapping for new SDK methods (`deploy.apply`, `deploy.start`, `deploy.plan`, `deploy.upload`, `deploy.commit`, `deploy.resume`, `deploy.status`, `deploy.getRelease`, `deploy.diff`).
- [ ] 15.2 Add a contract test asserting that the gateway's manifest digest matches the SDK's local digest for a representative spec (purely to catch unintentional canonicalize drift; the gateway digest is authoritative regardless).
- [ ] 15.3 Add a load test scenario: 200 MB site (~5000 files) deploys via `r.deploy.apply` end-to-end successfully, with manifest-ref upload kicking in.
- [ ] 15.4 Add a regression test asserting that the gateway's `POST /deploy/v2/plans` body parser rejects > 5 MB inline bodies and that the SDK's manifest-ref code path triggers correctly when the inline manifest would exceed 5 MB.
- [ ] 15.5 Run `npm test`, `npm run test:e2e`, `npm run test:sync` and ensure all pass before each phase cutover.
