## ADDED Requirements

### Requirement: SDK exposes `deploy.apply` as the canonical deploy primitive

The `@run402/sdk` (isomorphic) and `@run402/sdk/node` entry points SHALL expose a `deploy.apply(spec: ReleaseSpec, opts?: { onEvent?: (event: DeployEvent) => void; idempotencyKey?: string }): Promise<DeployResult>` method on the `Run402` client. The method SHALL accept structured app intent (database, secrets, functions, site, subdomains, routes, checks), normalize all byte payloads into `ContentRef` objects (`{ sha256, size, contentType? }`) before issuing the plan request, and orchestrate plan → upload missing content → commit → ready in a single call.

The method SHALL NOT POST inline bytes (base64 or otherwise) to the gateway. All bytes SHALL travel through the `cas-content` service via presigned PUTs.

The method SHALL be available on both isomorphic and Node entry points. Filesystem-dependent byte sources (`fileSetFromDir`) SHALL only be available from `@run402/sdk/node`.

#### Scenario: Agent ships a fresh full-stack deploy

- **WHEN** an agent calls `r.deploy.apply({ project, base: "empty", database: { migrations: [...] }, secrets: { set: {...} }, functions: { replace: {...} }, site: { replace: files({...}) }, subdomains: { set: ["app"] } })`
- **THEN** the SDK normalizes byte payloads into ContentRefs, calls `POST /deploy/v2/plans`, uploads only files reported as `missing`, calls `POST /deploy/v2/plans/:id/commit`, and returns `{ release_id, urls, operation_id }`
- **AND** no part of the request body to `POST /deploy/v2/plans` contains inline file bytes or function source bytes

#### Scenario: deploy.apply works in a V8 isolate

- **WHEN** code-mode MCP runs in a V8 isolate and an agent calls `r.deploy.apply({ project, site: { replace: files({ "index.html": htmlString, "data.json": new Blob([...]) }) } })`
- **THEN** the SDK uses only `globalThis.fetch` and `crypto.subtle` to hash bytes and upload them
- **AND** the deploy completes without requiring `node:fs`

### Requirement: ReleaseSpec uses explicit replace vs patch semantics per resource

The `ReleaseSpec` type SHALL support two write modes per resource: `replace` (the spec value becomes the new desired state for that resource — anything not listed is removed in the new release) and `patch` (surgical updates to listed keys only). Top-level absence of a resource SHALL leave that resource untouched in the new release.

The supported resources SHALL be: `database` (migrations + expose), `secrets`, `functions`, `site`, `subdomains`, `routes`, `checks`.

The `subdomains` resource SHALL accept at most one subdomain per project. `subdomains.set` SHALL be a one-element array; the gateway SHALL reject multi-element arrays with a structured error `{ code: "SUBDOMAIN_MULTI_NOT_SUPPORTED", message: "Multi-subdomain per project is not yet supported" }`. Multi-subdomain support is explicitly out of scope for this change and is tracked separately. The bundle-deploy shim's single-string `subdomain: string` translates to a one-element `subdomains: { set: [string] }` and preserves existing single-subdomain-per-project semantics exactly.

#### Scenario: site.replace removes files absent from the new spec

- **WHEN** an agent calls `r.deploy.apply({ project, site: { replace: files({ "index.html": "..." }) } })` against a project whose current site contains `index.html` and `old.html`
- **THEN** the new release's site contains only `index.html`
- **AND** `old.html` is no longer served from the activated release

#### Scenario: site.patch.put leaves unmentioned files untouched

- **WHEN** an agent calls `r.deploy.apply({ project, site: { patch: { put: { "index.html": "..." } } } })` against the same project
- **THEN** the new release's site contains the new `index.html` AND the unchanged `old.html`

#### Scenario: site.patch.delete removes specific files

- **WHEN** an agent calls `r.deploy.apply({ project, site: { patch: { delete: ["old.html"] } } })`
- **THEN** the new release's site no longer contains `old.html`
- **AND** all other files from the previous release are preserved

#### Scenario: Top-level absence of a resource leaves it untouched

- **WHEN** an agent calls `r.deploy.apply({ project, functions: { patch: { set: { api: {...} } } } })` (no `site`, no `database`, no `secrets` field)
- **THEN** the new release inherits the previous release's site, secrets, and database state unchanged

### Requirement: SDK accepts polymorphic byte sources

The SDK SHALL accept the following byte source shapes anywhere a `ContentRef` is expected:

- `string` — UTF-8 text
- `Uint8Array` / `ArrayBuffer`
- `Blob` / `File` (web)
- `ReadableStream<Uint8Array>` (web streams, for streaming hash + upload)
- `fileSetFromDir(path: string)` — Node-only lazy reader from `@run402/sdk/node`

Each source SHALL be normalized into a ContentRef (sha256 + size + content_type) before the plan request. The normalization SHALL stream large sources where possible (`fileSetFromDir` and `ReadableStream` MUST hash from disk/stream, never load full bytes into memory at hash time).

#### Scenario: In-memory byte sources work in any runtime

- **WHEN** an agent passes `files({ "data.json": new Blob([JSON.stringify(data)], { type: "application/json" }) })`
- **THEN** the SDK hashes the Blob's bytes, produces a ContentRef, and uploads to CAS during the upload phase

#### Scenario: fileSetFromDir streams from disk

- **WHEN** a Node consumer passes `fileSetFromDir("dist")` for a 2 GB build directory
- **THEN** the SDK never loads the full directory contents into memory at once
- **AND** hashing reads each file from disk during normalization
- **AND** uploading reads each missing file from disk during the upload phase

### Requirement: Plan endpoint negotiates missing content, diffs, payment

The gateway SHALL expose `POST /deploy/v2/plans` accepting either an inline `ReleaseSpec` (when ≤ 5 MB) or `{ project_id, manifest_ref: ContentRef, base?: ... }` (when the SDK pre-uploaded the manifest as CAS — see manifest-ref requirement). The response SHALL include:

- `plan_id` — opaque server-generated id, used for the subsequent commit call
- `operation_id` — opaque server-generated id, addressable via `GET /deploy/v2/operations/:id` for the lifetime of the deploy
- `manifest_digest` — gateway-computed authoritative digest (see server-authoritative digest requirement)
- `base_release_id` — the active release the plan was diffed against (null if `base: "empty"`)
- `missing_content` — array of `{ sha256, size, mode: "single" | "multipart", parts: [{ part_number, url, byte_start, byte_end }], expires_at }`. Files already in CAS SHALL NOT appear in this array.
- `diff` — structured summary: which resources change, which migrations are new vs noop vs error, which routes/subdomains are added/removed
- `payment_required?` — when present, `{ amount, asset, payTo, reason }` describing what the agent must pay before commit will succeed

The gateway body limit for `POST /deploy/v2/plans` SHALL be 5 MB. Bytes SHALL NOT pass through this endpoint.

#### Scenario: Plan returns missing content for a fresh deploy

- **WHEN** an agent submits a plan for a 50-file site against a project with empty CAS
- **THEN** `missing_content` lists all 50 entries with presigned PUT URLs

#### Scenario: Plan reports zero missing content for a re-deploy of unchanged bytes

- **WHEN** an agent submits the same plan twice in succession
- **THEN** the second plan's `missing_content` is an empty array
- **AND** the SDK can call commit immediately without uploading anything

#### Scenario: Plan surfaces payment requirement before bytes move

- **WHEN** an agent submits a plan against a project whose tier lease has expired
- **THEN** the plan response includes `payment_required: { amount, asset, payTo, reason: "lease_renewal" }`
- **AND** the SDK surfaces this to the caller before any byte uploads happen

### Requirement: Manifest-ref escape hatch for large manifests

When the normalized ReleaseSpec exceeds 5 MB JSON, the SDK SHALL upload the manifest itself as a CAS object first (via the `cas-content` service with `content_type: "application/vnd.run402.deploy-manifest+json"`), then issue the plan request with `{ project_id, manifest_ref: ContentRef }` instead of inlining the manifest. The gateway SHALL fetch and process the referenced manifest as if it had been inlined.

The agent-observable result SHALL be identical regardless of whether the manifest was inlined or referenced.

#### Scenario: Site with thousands of files uses manifest-ref

- **WHEN** the normalized ReleaseSpec for a 10,000-file site exceeds 5 MB
- **THEN** the SDK uploads the manifest as a CAS object before calling `POST /deploy/v2/plans`
- **AND** the plan body contains `manifest_ref: { sha256, size, content_type: "application/vnd.run402.deploy-manifest+json" }`
- **AND** the deploy completes successfully

### Requirement: Server-authoritative manifest digest

The gateway SHALL compute the authoritative `manifest_digest` (RFC 8785 JCS canonical-JSON SHA-256) and return it in the plan response. Idempotency at the gateway SHALL be keyed on `(project_id, gateway_computed_manifest_digest, base_release_id, optional client_idempotency_key)`.

The SDK MAY compute a local digest for caching/UX purposes, but SHALL NOT depend on byte-for-byte equality with the gateway's digest for correctness. A drift between SDK-side canonicalize and gateway-side canonicalize SHALL NOT silently break idempotency.

#### Scenario: Identical plan submitted twice hits the same operation

- **WHEN** an agent calls `r.deploy.apply(spec)` twice in succession with the same spec and same `idempotencyKey`
- **THEN** both calls resolve to the same `operation_id`
- **AND** the second call does not re-trigger uploads or commit work

#### Scenario: SDK canonicalize drift does not break idempotency

- **WHEN** the SDK's local digest computation diverges from the gateway's (hypothetical bug)
- **THEN** retries still find the existing plan because idempotency keys on the gateway-computed digest, not the SDK-computed digest

### Requirement: Commit endpoint runs server-side state machine

The gateway SHALL expose `POST /deploy/v2/plans/:id/commit` accepting `{ idempotency_key? }` (reusing the existing `internal.idempotency_keys` middleware). The endpoint SHALL trigger the deploy state machine in the following phase order:

1. **validate** — manifest schema, content present, payment preflight, subdomain available, migration ids/checksums sane, base-release conflict check.
2. **stage** — build/stage Lambda function versions, stage S3 site deployment via the existing v1.32 mechanism, stage secret version set, reserve subdomain. Insert rows into `internal.staged_function_versions`, `internal.staged_deployments`, `internal.staged_secret_sets`. No public pointer changes yet.
3. **migrate-gate** — only if `database.migrations` is non-empty AND `zero_downtime: true` is NOT set: set `internal.projects.migrate_gate_until = NOW() + INTERVAL '60s'`. Edge middleware returns 503 + Retry-After for control-plane writes AND for `/rest/v1/*` traffic during the gate window. The migrate-gate is distinct from the lifecycle gate (which returns 402 for `frozen`/`dormant`); the migrate-gate is short-lived and explicitly carves out from the standing data-plane invariant.
4. **migrate** — acquire `pg_advisory_xact_lock(hashtext($project_id))`; single transaction; SET search_path; for each migration consult the registry; same id+checksum noop; same id different checksum hard error; new id apply + insert registry row; apply expose/RLS manifest in same transaction; NOTIFY pgrst; COMMIT.
5. **schema-settle** — canary `SELECT` against the new schema; retry up to 12×500ms. On success, proceed to activate. On timeout, operation enters `schema_settling`; auto-resume retries.
6. **activate** — single transaction: flip `releases.status` for old + new release, update `projects.live_release_id`, swap Lambda function alias, update subdomain mapping, flip secret version set, clear `projects.migrate_gate_until`.
7. **ready** — poll site copy status if needed (reusing existing `services/copy-resume.ts`), warm function cold-starts opportunistically, run smoke checks if defined; mark operation ready.

The commit response SHALL return promptly with the operation status: `running`, `schema_settling`, `activation_pending`, `ready`, or `failed`. For `running` / `schema_settling`, the SDK SHALL poll `GET /deploy/v2/operations/:id` until terminal. The auto-resume worker SHALL drive `schema_settling` and `activation_pending` operations forward without requiring SDK or human intervention.

#### Scenario: Commit returns ready synchronously for small deploys

- **WHEN** a commit's site copy and function activation complete within the request window
- **THEN** the commit response has `status: "ready"` and includes `release_id` and `urls`

#### Scenario: Commit returns running for slow deploys

- **WHEN** a commit's site copy or function warmup takes longer than the synchronous response window
- **THEN** the commit response has `status: "running"` with `operation_id`
- **AND** the SDK polls `GET /deploy/v2/operations/:id` until status becomes terminal

### Requirement: Migration registry enforces id + checksum semantics

The gateway SHALL maintain an `internal.applied_migrations` table keyed on `(project_id, migration_id)` with columns `(checksum BYTEA(32), applied_at, operation_id)`. The table SHALL be revoked from `anon`/`authenticated`/`service_role`/`project_admin` (PostgREST hidden) at create time, matching the existing dark-by-default convention for other `internal` tables. During the migrate phase of commit, for each migration in the spec:

- If `(project_id, migration_id)` is not in the registry: apply the migration, insert the row in the same transaction.
- If `(project_id, migration_id)` is in the registry AND its `checksum` matches the spec's: noop (skip; do not re-execute).
- If `(project_id, migration_id)` is in the registry AND its `checksum` differs from the spec's: fail the operation with a structured error `{ code: "MIGRATION_CHECKSUM_MISMATCH", migration_id, registry_checksum, spec_checksum }`. Do not execute the migration.

The migrate phase SHALL run inside a single Postgres transaction (advisory-locked per project via `pg_advisory_xact_lock(hashtext($project_id))`) for migrations declared `transaction: "required"` (the default). The phase SHALL `SET search_path TO <project_schema>` before executing migration SQL, and SHALL issue `NOTIFY pgrst, 'reload schema'` before COMMIT. Migrations declared `transaction: "none"` SHALL run outside the transaction; on failure the operation enters `needs_repair` and is not blindly replayable.

The registry SHALL NOT be bulk-seeded from pre-v2 deploy history. Pre-v2 migration SQL was never persisted by the gateway (v1's `runMigrations` executed the blob and discarded it), so any seed would be a sentinel that hard-errors all real callers. Each project's registry begins empty; the first v2 deploy executes whatever migrations the spec ships. Documentation for v2 cutover SHALL instruct agents to ensure first-deploy migrations are idempotent (`CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`) — this is already the agent norm.

For the rare case of recording a pre-applied migration without execution (operator escape hatch), the gateway SHALL expose `POST /deploy/v2/admin/migrations/adopt` accepting `{ project_id, migration_id, checksum }` (admin-key auth, not in `llms.txt` / `openapi.json`). This inserts the registry row without running SQL.

#### Scenario: Re-deploy of unchanged migrations is a noop

- **WHEN** an agent re-runs `deploy.apply(spec)` with the same migrations as the prior deploy
- **THEN** the migration registry shows all migrations already applied with matching checksums
- **AND** no SQL is re-executed
- **AND** the operation completes via the activation phase only (or noop if nothing else changed)

#### Scenario: Migration with same id but different SQL is rejected

- **WHEN** an agent calls `deploy.apply` with a migration `{ id: "001_init", checksum: "...", sql_ref: ... }` that conflicts with the registry's recorded checksum for that id on this project
- **THEN** the operation fails with `MIGRATION_CHECKSUM_MISMATCH`
- **AND** no schema changes are executed
- **AND** the previous active release remains active

#### Scenario: First v2 deploy on a legacy project

- **WHEN** a project that was previously deployed via v1 `bundleDeploy` ships its first v2 `deploy.apply` with idempotent migrations (`CREATE TABLE IF NOT EXISTS users (...)`)
- **AND** the project's schema already contains the `users` table from the v1 deploy
- **THEN** the migration executes (registry is empty, so the id is treated as new)
- **AND** the SQL noops at the database level because of `IF NOT EXISTS`
- **AND** the registry records `(project_id, "001_init", checksum, applied_at)`
- **AND** subsequent re-deploys with the same checksum are registry noops

#### Scenario: Re-deploy of unchanged migrations is a noop

- **WHEN** an agent re-runs `deploy.apply(spec)` with the same migrations as the prior deploy
- **THEN** the migration registry shows all migrations already applied with matching checksums
- **AND** no SQL is re-executed
- **AND** the operation completes via the activation phase only (or noop if nothing else changed)

#### Scenario: Migration with same id but different SQL is rejected

- **WHEN** an agent calls `deploy.apply` with a migration `{ id: "001_init", checksum: "...", sql_ref: ... }` that conflicts with the registry's recorded checksum for that id on this project
- **THEN** the operation fails with `MIGRATION_CHECKSUM_MISMATCH`
- **AND** no schema changes are executed
- **AND** the previous active release remains active

### Requirement: Schema-cache settle phase before activation

Between the migrate phase (transaction commits, `NOTIFY pgrst, 'reload schema'` issued) and the activate phase (pointer swap + clear gate), the gateway SHALL run a schema-cache settle phase. This phase SHALL issue a canary `SELECT` through the project's authenticator role exercising a column or table touched by the migration, with a retry budget matching the existing PostgREST forward retry budget (currently 12×500ms = 6s). The activate phase SHALL NOT proceed until the canary succeeds.

If the canary times out, the operation SHALL enter `schema_settling` status (a non-terminal state). The auto-resume worker SHALL retry the settle + activate phases on the hourly tick.

The settle phase exists to prevent the bug class where end-user `/rest/v1/*` traffic resumes against the new schema before PostgREST's schema cache has refreshed, returning 404 PGRST200 errors that surface as broken UIs. This bug class was previously mitigated at the request layer (the 6→12 retry bump in `services/postgrest-forward.ts`); pulling the settle into the deploy state machine eliminates the per-request retry surface and the thundering-herd-of-stale-cache pattern.

#### Scenario: Schema-cache settle succeeds before activation

- **WHEN** the migrate phase commits a `CREATE TABLE users (...)` migration
- **AND** the schema-cache settle phase issues a canary `SELECT 1 FROM users LIMIT 0`
- **THEN** the canary succeeds within the 6-second budget (typically <500ms)
- **AND** the activate phase runs immediately afterward
- **AND** the gate clears

#### Scenario: Schema-cache settle times out

- **WHEN** the canary fails to succeed within 6 seconds (PostgREST is wedged or under heavy load)
- **THEN** the operation enters `schema_settling` status
- **AND** the gate stays up
- **AND** the auto-resume worker retries the settle + activate phases on the next hourly tick
- **AND** the agent's polling SDK observes `schema_settling` status and continues polling

### Requirement: Activation_pending state recovers without SQL replay; auto-resume worker drives recovery

If the migrate phase commits successfully but a subsequent phase (schema-cache settle, activate, ready) fails or times out, the operation SHALL enter `schema_settling` or `activation_pending` (whichever phase was active). In these states:

- The migrations are committed to the project DB.
- The new staged resources (function versions, site deployment, secret version set) still exist server-side in the typed staging tables.
- The migrate-gate remains in place (`projects.migrate_gate_until`).
- The previous release is still the active release (`projects.live_release_id` unchanged).

The gateway SHALL drive recovery automatically via an auto-resume worker that runs on the existing hourly tick in `services/leases.ts`. The worker SHALL select operations in `schema_settling` or `activation_pending` whose `last_activate_attempt_at` is NULL or older than 5 minutes, lock them with `FOR UPDATE SKIP LOCKED`, and re-run the failed phase forward. After 10 attempts, the operation SHALL transition to `failed`, the gate SHALL clear, and the failure SHALL be operator-actionable.

`POST /deploy/v2/operations/:id/resume` SHALL be available for explicit resume by SDK / CLI / human. It SHALL re-run the failed phase forward (settle if `schema_settling`, activate if `activation_pending`, ready if both already succeeded but `ready` polling failed). It SHALL NOT re-execute migrations. The endpoint SHALL be accessible regardless of the project's lifecycle state (no lifecycle-gate carve-out is required because resume only completes already-authorized work).

#### Scenario: Auto-resume completes a stuck activation

- **WHEN** an operation is in `activation_pending` after a transient activation failure
- **AND** the agent does NOT call `deploy.resume`
- **THEN** the auto-resume worker picks up the operation on the next hourly tick
- **AND** runs the activation phase
- **AND** the new release becomes active
- **AND** the agent's next call to `GET /deploy/v2/operations/:id` returns `ready`
- **AND** no SQL is re-executed

#### Scenario: Resume by SDK completes a stuck activation immediately

- **WHEN** an operation is in `activation_pending` after a transient activation failure
- **AND** an agent calls `r.deploy.resume(operation_id)` before the auto-resume tick fires
- **THEN** the gateway runs the activation phase synchronously
- **AND** the new release becomes active
- **AND** no SQL is re-executed

#### Scenario: Resume on terminal operation is a noop

- **WHEN** an agent calls `resume` on an operation already in `ready` or `failed`
- **THEN** the gateway returns the operation snapshot without re-running any phase

#### Scenario: Auto-resume gives up after 10 attempts

- **WHEN** an operation has failed activation 10 times across ~50 minutes of auto-resume attempts
- **THEN** the operation transitions to `failed` with the structured error envelope from the last attempt
- **AND** the migrate-gate clears
- **AND** the previous release remains active
- **AND** an alarm condition exists for operator follow-up

### Requirement: SDK exposes three layers — apply, start/op, plan/upload/commit

The `deploy` namespace SHALL expose all three layers:

- `deploy.apply(spec, opts?)` — one-shot, awaits to completion or terminal failure
- `deploy.start(spec, opts?)` — returns a `DeployOperation` with `events()` async iterator and `result()` promise
- `deploy.plan(spec, opts?)`, `deploy.upload(plan, opts?)`, `deploy.commit(planId, opts?)` — low-level steps for CLI and tests
- `deploy.resume(operationId)`, `deploy.status(operationId)`, `deploy.getRelease(releaseId)`, `deploy.diff({ from, to })` — operation/release lookups

The high-level `apply` and `start` SHALL be the documented agent path. The low-level layer SHALL be exposed for debugging.

#### Scenario: Agent uses the high-level API

- **WHEN** an agent calls `await r.deploy.apply(spec)`
- **THEN** the SDK runs plan/upload/commit/poll internally and returns the final result

#### Scenario: CLI uses the low-level API

- **WHEN** the CLI implements `run402 deploy plan --spec spec.json`
- **THEN** it calls `r.deploy.plan(spec)` and emits the plan response as JSON to stdout

### Requirement: Structured event envelope

The optional `onEvent` callback (and `DeployOperation.events()` async iterator) SHALL emit events of the following discriminated-union shape:

- `{ type: "plan.started" }`
- `{ type: "plan.diff"; diff: DeployDiff }` — fired once after plan returns
- `{ type: "payment.required"; amount: string; asset: string; payTo: string; reason: string }`
- `{ type: "payment.paid"; tx?: string }`
- `{ type: "content.upload.skipped"; label: string; sha256: string; reason: "present" | "satisfied_by_plan" }`
- `{ type: "content.upload.progress"; label: string; sha256: string; done: number; total: number }`
- `{ type: "commit.phase"; phase: "validate" | "stage" | "migrate-gate" | "migrate" | "schema-settle" | "activate" | "ready"; status: "started" | "done" | "failed" }`
- `{ type: "log"; resource: string; stream: "stdout" | "stderr"; line: string }`
- `{ type: "ready"; releaseId: string; urls: Record<string, string> }`

Errors thrown synchronously from the callback SHALL be caught and silently dropped.

#### Scenario: onEvent receives the full lifecycle

- **WHEN** an agent calls `r.deploy.apply(spec, { onEvent })` for a deploy with new bytes and migrations
- **THEN** the callback receives, in order: `plan.started`, `plan.diff`, `content.upload.progress` (one per missing file), `commit.phase` (validate/stage/migrate-gate/migrate/schema-settle/activate/ready in order), `ready`

### Requirement: Structured error envelopes

All deploy failures SHALL surface as a `Run402DeployError` (extending the existing `Run402Error` hierarchy) with the following fields:

- `code` — stable string code (e.g., `MIGRATION_FAILED`, `MIGRATION_CHECKSUM_MISMATCH`, `FUNCTION_BUILD_FAILED`, `BASE_RELEASE_CONFLICT`, `PAYMENT_REQUIRED`, `CONTENT_UPLOAD_FAILED`)
- `phase` — which state-machine phase failed
- `resource` — dotted path to the offending resource (e.g., `database.migrations.001_init`, `functions.api`)
- `message` — human-readable summary
- `retryable` — boolean
- `operation_id` — for ops past plan
- `plan_id` — for ops past plan
- `fix?` — optional structured remediation hint, e.g., `{ action: "edit_and_redeploy", path: "functions.api.source" }`
- `logs?` — for build/migration errors, the relevant log lines

#### Scenario: Migration failure surfaces structured error

- **WHEN** a migration fails during the migrate phase with a Postgres error at statement offset 184
- **THEN** the SDK throws `Run402DeployError` with `code: "MIGRATION_FAILED"`, `phase: "migrate"`, `resource: "database.migrations.001_init"`, `retryable: false`, `rolled_back: true`, and the Postgres error message in `message`

### Requirement: Payment preflight during plan

When a deploy requires payment (e.g., tier lease renewal), the gateway SHALL surface the requirement in the plan response (`payment_required` field) before the SDK begins the upload phase. The SDK SHALL NOT upload bytes when `payment_required` is non-null and unresolved.

The commit phase SHALL also be authoritative for payment (an agent who paid between plan and commit succeeds), but agents who skip the plan-time check waste bandwidth.

#### Scenario: Lease renewal is detected at plan time

- **WHEN** an agent submits a plan against a project whose tier has expired
- **THEN** the plan response has `payment_required: { amount, asset, payTo, reason: "lease_renewal" }`
- **AND** the SDK does not upload missing content until payment is resolved
- **AND** the SDK's x402 fetch wrapper handles the payment if an allowance is configured

### Requirement: Backward-compat shim for `apps.bundleDeploy`

The existing `apps.bundleDeploy(projectId, opts)` SDK method SHALL remain callable with its current input shape (`{ migrations?, rls?, secrets?, functions?, files?, subdomain?, inherit? }`). The implementation SHALL:

1. Translate the v1 options into a v2 `ReleaseSpec`:
   - `migrations: string` → `database.migrations: [{ id: "bundle_<digest>", checksum: sha256(sql), sql_ref: <CAS uploaded> }]`
   - `rls: { template, tables }` → `database.expose: <translated declarative manifest using existing v1.31 translation logic>`
   - `secrets: [{key, value}]` → `secrets.set: { [key]: { value } }`
   - `functions: [{name, code, ...}]` → `functions.replace: { [name]: { runtime: "node22", source: <CAS uploaded>, config, schedule } }`
   - `files: SiteFile[]` → SDK reads bytes (decoding base64 if `encoding: "base64"`), uploads to CAS, builds `site.replace: FileSet`
   - `subdomain: string` → `subdomains.set: [string]`
   - `inherit: true` → ignored, with one-time deprecation warning
2. Delegate to `r.deploy.apply(translatedSpec)`.
3. Return the result reshaped into the legacy `BundleDeployResult` shape.

The shim SHALL NOT POST inline base64 bytes to any endpoint.

#### Scenario: Existing bundleDeploy caller works unchanged

- **WHEN** an existing caller invokes `r.apps.bundleDeploy(projectId, { migrations: "...", files: [{ file: "i.html", data: "<h1>hi</h1>" }] })`
- **THEN** the SDK translates to ReleaseSpec, uploads the file via CAS, applies migrations through the v2 state machine, and returns `{ project_id, deployment_id, site_url, ... }` in the v1 shape

#### Scenario: bundleDeploy with inherit emits deprecation warning

- **WHEN** an existing caller invokes `r.apps.bundleDeploy(projectId, { inherit: true, files: [...] })`
- **THEN** the SDK emits a one-time console warning and proceeds with patch semantics inferred from the file list
- **AND** the result is returned in the v1 shape

### Requirement: `/deploy/v1` and legacy site CAS routes are v1-shims during deprecation

Three legacy gateway routes SHALL be retained for one minor release cycle as v1-shims:

- `POST /deploy/v1` (the bundle-deploy route)
- `POST /deploy/v1/plan` (the legacy v1.32 site CAS plan route)
- `POST /deploy/v1/commit` (the legacy v1.32 site CAS commit route)

Each shim SHALL:

1. Accept its legacy request body shape unchanged (including inline `files: SiteFile[]` for `/deploy/v1`).
2. Translate the legacy body into a v2 ReleaseSpec (uploading inline bytes into CAS via the internal content service for the bundle route; constructing a `site: { replace: ... }` spec from the file list for the site CAS routes).
3. Call the v2 plan + commit flow internally.
4. Reshape the v2 result into the legacy response shape.
5. Add HTTP response headers `Deprecation: true`, `Sunset: <date>`, `Link: </deploy/v2/plans>; rel="successor-version"`.

Each shim SHALL be guarded by an environment variable kill-switch:

- `DEPLOY_V1_BUNDLE_ROUTE_THROUGH_V2` (default `true`) — `POST /deploy/v1`
- `DEPLOY_V1_SITE_ROUTE_THROUGH_V2` (default `true`) — `POST /deploy/v1/plan` + `POST /deploy/v1/commit`

When the kill-switch is `false`, the route SHALL fall back to the legacy code path. This provides per-path rollback during the canary week without requiring a code revert.

After the deprecation window, all three routes SHALL return HTTP 410 Gone with a JSON body pointing to `/deploy/v2/plans`.

The 50 MB body cap on `POST /deploy/v1` SHALL remain during the shim window. It SHALL NOT be raised; callers wanting larger deploys MUST migrate to v2.

#### Scenario: v1 bundle caller during the shim window succeeds

- **WHEN** an external caller posts a legacy bundle body to `/deploy/v1`
- **THEN** the gateway translates and runs through v2
- **AND** returns the v1 response shape with `Deprecation` headers
- **AND** the deploy is server-side identical to a v2 deploy of the equivalent spec

#### Scenario: v1 site CAS caller during the shim window succeeds

- **WHEN** an external caller posts a legacy plan body to `/deploy/v1/plan` and then commits via `/deploy/v1/commit`
- **THEN** the gateway translates each call to the v2 flow internally
- **AND** returns the legacy response shapes with `Deprecation` headers
- **AND** the deploy is server-side identical to a v2 deploy of the equivalent `site: { replace: ... }` spec

#### Scenario: v1 caller after sunset is rejected

- **WHEN** the deprecation window has elapsed and an external caller posts to `/deploy/v1` with non-empty `files` (or to `/deploy/v1/plan` or `/deploy/v1/commit`)
- **THEN** the gateway returns 410 Gone with a JSON body `{ error: "<route> has been removed; use POST /deploy/v2/plans", successor: "/deploy/v2/plans" }`
