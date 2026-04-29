## Context

Three upload/deploy transports exist today:

1. **`apps.bundleDeploy` → `POST /deploy/v1`** — atomic multi-resource (DB + RLS + secrets + functions + site + subdomain), inline base64 in JSON body, hard 50 MB ceiling at the gateway (`express.json({ limit: "50mb" })` in `packages/gateway/src/server.ts:227`). Non-transactional under the hood: orchestrates migrations → RLS → secrets → functions (parallelized) → site → subdomain with no rollback if a later step fails.
2. **`sites.deployDir` → `POST /deploy/v1/plan` + presigned PUTs to S3 + `POST /deploy/v1/commit` + `GET /deployments/v1/:id`** — site-only, Node-only, content-addressed (gateway dedupes by SHA-256), multipart, resumable on URL expiry. Implemented in `sdk/src/node/sites-node.ts:144`.
3. **`blobs.put` → `POST /storage/v1/uploads` + presigned PUTs + `POST /storage/v1/uploads/:id/complete`** — single-asset, isomorphic, content-addressed, multipart. Implemented in `sdk/src/namespaces/blobs.ts:268`.

Two of the three are already CAS-based; the high-value atomic-multi-resource path is the laggard. Inline base64 + 50 MB cap is documented in the gateway with `// /deploy/v1 — bundle deploy (still inline-bytes; carries files inline)` — the team knows.

Constraints:

- **Isomorphic SDK** — the kernel must run in V8 isolates (`@run402/sdk` is wired for code-mode MCP / sandbox runtimes; no `node:fs`, no Node streams). Plan/commit + presigned S3 PUT works in isolates; directory walking does not.
- **Atomic multi-resource is the differentiator.** Vercel/Cloudflare/Supabase don't ship one transactional call for DB + functions + site. Losing this loses the platform's whole agent-DX story.
- **Agents generate content in memory.** A primitive that demands a filesystem rules out the most important runtime (sandboxed code-mode agent producing files in V8 memory).
- **Partial failure is a current bug.** Migrations succeeded, function deploy failed → orphaned half-state with no recovery primitive other than re-calling the same orchestration.
- **x402 payment** flows through the `Run402Client.fetch` wrapper; deploys may negotiate payment for tier-renewal mid-call. Whatever we design must surface 402 cleanly and ideally before bytes move.

Stakeholders: gateway team (state machine + new tables), SDK team (new namespace + Node helpers), MCP/CLI (rewrite tools as thin wrappers), agent-DX docs (`llms-cli.txt`).

## Goals / Non-Goals

**Goals:**

- One canonical SDK primitive `deploy.apply(ReleaseSpec)` that covers every shape today's three transports cover, plus partial-update workflows (patch one file, patch one function) that don't exist today.
- Every byte payload travels through CAS. There is no inline-bytes path in the v2 wire protocol.
- Server-owned, resumable deploy operations with structured progress events and structured errors. After-DB-commit-before-activation must be recoverable without replaying SQL.
- Replace vs patch semantics per resource, with explicit base-release conflict detection on full-replace deploys.
- Migration registry that makes redeploys noop-safe and makes "same id different checksum" a hard error.
- Backward compatibility: existing `apps.bundleDeploy` and `sites.deployDir` callers see no API break in this change. The shape they POST is preserved as a v1 shim.
- The `/deploy/v1` inline-bytes acceptance is removed in a follow-up minor (mirrors the v1.32 site-deploy cutover precedent).

**Non-Goals:**

- CAS pack uploads (single archive carrying many small objects). Worth doing — sites with 20k tiny files shouldn't issue 20k presigned PUTs — but layered after v2 lands and not on the critical path.
- Virtual `/.run402/config.json` per-site config endpoint. Solves a real agent pitfall ("provision first, embed anon_key in HTML, then deploy") but is orthogonal to the deploy primitive.
- Same-origin function routes (`routes: { "/api": { function: "api" } }`). Belongs to a release-manifest follow-up that depends on this change but isn't part of it.
- Server-side build steps (Vercel-style). Out of scope; agents pre-build and ship artifacts.
- Multi-region deploy fan-out, blue/green canaries beyond the basic activation gate.

## Decisions

### D1. One primitive at the SDK level, three layers exposed

Single canonical call:

```ts
await run.deploy.apply(spec, { onEvent });            // L1: agent happy path
const op  = await run.deploy.start(spec);             // L2: resumable op + event stream
const plan = await run.deploy.plan(spec);             // L3: low-level
await run.deploy.upload(plan, { onEvent });
await run.deploy.commit(plan.id);
await run.deploy.resume(op.id);
```

Most agents use L1. L2 exists for streaming/long-running work and progress UIs. L3 is for the CLI's debugging surface and for tests.

**Why not just expose `apply` and hide the rest?** Coding agents iterate. They want to see the diff before paying, see the missing-bytes count, debug a partial failure. Exposing plan/upload/commit individually is cheap and cuts the "magic black-box" failure mode.

**Alternatives considered:** keep `bundleDeploy` and `deployDir` as separate primitives and just swap their internal transports — rejected because it preserves the conceptual fork; agents still have to choose which path matches their case. Unifying the surface is the entire point.

### D2. Wire protocol: `/deploy/v2/plans` + `/deploy/v2/plans/:id/commit` + operation lookups

```
POST /deploy/v2/plans
  body: ReleaseSpec (with ContentRef objects, never inline bytes)
  → { plan_id, operation_id, base_release_id, manifest_digest, missing_content: [{sha256, size, parts:[{url, byte_start, byte_end, part_number}]}], diff: { ... }, payment_required?: { amount, asset, payTo } }

PUT <presigned-S3-url>      (per missing content ref, possibly per part)
  headers: { x-amz-checksum-sha256: <base64> }
  body: <bytes>

POST /deploy/v2/plans/:id/commit
  body: { idempotency_key? }
  → { operation_id, status: "running" | "activation_pending" | "ready" | "failed", release_id?, urls?, error? }

GET  /deploy/v2/operations/:id              → operation snapshot
GET  /deploy/v2/operations/:id/events       → event stream (SSE or paginated polling)
POST /deploy/v2/operations/:id/resume       → finishes activation if status === "activation_pending"
```

The body limits stay sane:

- `/deploy/v2/plans` — 5 MB JSON (manifest only, no bytes). For huge manifests, see D5 (manifest-ref).
- `/deploy/v2/plans/:id/commit` — 1 MB.
- `/deploy/v2/operations/*` — 1 MB.

Bytes always go direct-to-S3 via presigned URLs. The gateway never carries deploy bytes.

**Alternatives considered:** put everything on `/deploy/v2` as a single endpoint (v1 style) — rejected because plan/commit separation is the only way to negotiate dedup before bytes move and the only way to do payment preflight before bytes move.

### D3. ReleaseSpec shape — explicit replace vs patch per resource

```ts
interface ReleaseSpec {
  project: string;
  base?: { release: "current" | "empty" } | { release_id: string };
  database?: { migrations?: MigrationSpec[]; expose?: ExposeManifest };
  secrets?:    { set?: Record<string, { value: string }>; delete?: string[]; replace_all?: Record<string, { value: string }> };
  functions?:  { replace?: Record<string, FunctionSpec>; patch?: { set?: Record<string, FunctionSpec>; delete?: string[] } };
  site?:       { replace?: FileSet } | { patch?: { put?: FileSet; delete?: string[] } };
  subdomains?: { set?: string[]; add?: string[]; remove?: string[] };
  routes?:     RouteSpec; // forward-compat for same-origin routing follow-up
  checks?:     SmokeCheck[];
}

type ContentRef = { sha256: string; size: number; contentType?: string; integrity?: string };
type FileSet    = Record<string, ContentRef>;
type FunctionSpec = { runtime: "node22"; entrypoint?: string; source?: ContentRef; files?: FileSet; config?: { timeoutSeconds?: number; memoryMb?: number }; schedule?: string | null };
type MigrationSpec = { id: string; checksum: string; sql_ref: ContentRef; transaction?: "required" | "none" };
```

Top-level absence = leave that resource untouched. `replace` = the spec is the new desired state for that resource (anything not listed is deleted in the new release). `patch` = surgical updates that touch only listed keys.

**Why not Kubernetes-style strategic-merge-patch?** Too clever, bad agent ergonomics. The two-mode shape (replace vs patch.put/delete) is unambiguous and easy to reason about.

**Why force migrations to have explicit ids?** Migration replay is the second-most-painful thing in deploys. Agents that can't tell whether a re-deploy is a noop or a re-execution write defensive `IF NOT EXISTS` everywhere. With ids + checksums, the gateway answers definitively.

### D4. SDK byte sources — "anything goes," normalized to ContentRef before plan

The SDK accepts:

- `string` — UTF-8 text
- `Uint8Array` / `ArrayBuffer`
- `Blob` (web) / `File`
- web `ReadableStream<Uint8Array>` (for streaming hashes)
- `fileSetFromDir(path)` — Node-only, lazy: hashes from disk, uploads from disk, never loads a 2 GB site into memory

Normalization runs locally before the plan request. Each source emits `{ contentType?: string, sha256: string, size: number }`, plus a deferred reader for the upload phase. The plan request body never contains bytes.

**Why a separate `files()` helper for the in-memory case?** Sandboxes / V8 isolates have no filesystem; agents generate HTML and JSON in memory. Forcing them to write to a temp dir to deploy is hostile DX.

**Why does `fileSetFromDir` belong in `@run402/sdk/node`?** It's the only Node-specific piece. Keeping it out of the root SDK keeps the isomorphic kernel pure.

### D5. Manifest-ref escape hatch

When the normalized ReleaseSpec exceeds the plan body cap (5 MB), the SDK uploads the JSON itself as a CAS object via the same `cas-content` service, then sends:

```json
{ "project_id": "prj_...", "manifest_ref": { "sha256": "...", "size": 9000000, "content_type": "application/vnd.run402.deploy-manifest+json" } }
```

The gateway fetches it, validates, and proceeds as if it had been inlined. No body-size cliff anywhere in v2.

**Why CAS the manifest itself?** Reuses the same content service. No new code path. Eliminates the worry that a site with hundreds of file paths might run out of headroom.

### D6. Server-authoritative manifest digest

The SDK computes a local manifest digest (RFC 8785 JCS canonicalize SHA-256, same algorithm as today's `sdk/src/node/canonicalize.ts:65`) for caching and progress UX. Idempotency at the gateway is keyed on:

```
(project_id, gateway_computed_manifest_digest, base_release_id, optional client_idempotency_key)
```

**Why not depend on byte-for-byte client/server canonicalize match?** That's the current fragility — one drift between SDK canonicalize and gateway canonicalize and the SDK's hash silently doesn't match, so retries create new plans instead of finding existing ones. Letting the gateway own the authoritative digest removes the failure mode entirely; the SDK's local digest becomes a UX nicety.

### D7. CAS content service — expose the existing v1.32 substrate

The gateway already ships the CAS substrate end-to-end as of v1.32 (see CLAUDE.md "Content-addressed storage (CAS) — v1.32"):

- `internal.content_objects (sha256 BYTEA(32) PK, s3_key, size_bytes, orphaned_at, deleting_at)` — the global storage row. One S3 object per SHA, ever, across the whole platform. Storage-shared by design.
- `internal.deploy_plans (id, project_id, manifest, manifest_digest BYTEA, expires_at, committed_at)` with unique index `(project_id, manifest_digest) WHERE committed_at IS NULL` — the plan substrate, already idempotent.
- `internal.plan_claims (plan_id, project_id, sha256, completed_at)` — the cross-project commit-existence oracle closure. A SHA is "satisfied" for a project only if that project's prior plan completed an upload referencing it (or the project already references the SHA via `blobs`/`deployment_files`). This is how presence is project-scoped without re-storing bytes.
- `internal.upload_sessions` extended in v1.32 with `kind` (`'blob'` | `'cas'`), `staging_key`, and FK `plan_id` → `deploy_plans` for `kind='cas'` sessions.
- `services/cas-promote.ts` — the staging→CAS promote flow with size + SHA verify, S3 CopyObject (≤5 GiB) / UploadPartCopy (>5 GiB), idempotent identity INSERT, concurrent-same-hash safety.
- `services/copy-resume.ts` — durable Stage-2 resume worker (5-minute lock window, 10-attempt cap, hourly tick from `services/leases.ts`).
- `services/cas-metrics.ts` + CDK metric filters → `Run402/CAS` namespace + alarms.
- AFTER INSERT/DELETE/UPDATE-OF-content_sha256 triggers on `blobs` and `deployment_files` are the **sole** writers of `internal.projects.storage_bytes`.

This change does **not** add a new `cas_objects` table or a parallel storage layer. It exposes the existing substrate over a generic content route:

- `POST /content/v1/plans` — accepts `{ project_id, content: ContentRef[] }`, returns missing-with-presigned-PUTs. Internally creates an `upload_sessions` row per missing entry with `kind='cas'` and the supplied `plan_id`. Reuses `services/deploy-plans.ts` for the plan-row primitive.
- `POST /content/v1/plans/:id/commit` — finalizes by promoting any not-yet-promoted staging objects via `services/cas-promote.ts`, marks the plan `committed_at`. Equivalent to today's `/storage/v1/uploads/:id/complete` for blobs, generalized.

Project-scoped *presence* is the spec contract; project-scoped *storage* is not. The privacy guarantee ("project B cannot infer that project A has uploaded SHA X") is enforced by `plan_claims` + the per-project ref join, not by re-storing bytes per project. Client-observable behavior matches the spec scenarios; the implementation is the v1.32 design we already operate in production.

**Adapters, not duplicates.** `/storage/v1/uploads` and `/deploy/v1/plan` (the existing site CAS route) become thin adapters over `/content/v1/plans`. Public route shapes unchanged for the deprecation window. One internal substrate; three public routes during transition; one route after sunset.

**Why not a new project-scoped table?** Two reasons. (1) v1.32's per-reference billing (storage_bytes triggers) is already correct; reintroducing per-project rows would split the trigger story. (2) S3 storage doubles for every cross-project shared SHA (logos, common bundles, the same `react.production.min.js`), hitting our cost line for no privacy gain — the privacy guarantee is already met without it.

### D8. Release model — immutable releases, typed staging tables, atomic activation

All schema below lives in the `internal` schema, with `REVOKE ALL ON ... FROM authenticator, anon, authenticated, service_role, project_admin` at create time (matches the dark-by-default convention for `internal.content_objects` / `internal.deploy_plans` / `internal.plan_claims`). All `*_digest` and `*_checksum` columns are `BYTEA(32)` to match the rest of the SHA-256 surface in the schema. All ids follow the existing `<prefix>_<ts_ms>_<rand>` convention from v1.32 deployment ids.

```sql
CREATE TABLE internal.releases (
  id              TEXT PRIMARY KEY,                                  -- rel_<ts_ms>_<rand>
  project_id      TEXT NOT NULL REFERENCES internal.projects(id) ON DELETE CASCADE,
  parent_id       TEXT REFERENCES internal.releases(id) ON DELETE SET NULL,
  manifest_digest BYTEA NOT NULL CHECK (length(manifest_digest) = 32),
  manifest_ref    BYTEA REFERENCES internal.content_objects(sha256) ON DELETE RESTRICT,  -- if manifest was uploaded via /content/v1/plans
  manifest_json   JSONB,                                              -- small manifests stored inline; null if manifest_ref is set
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by      TEXT NOT NULL,                                      -- wallet address or service principal
  status          TEXT NOT NULL CHECK (status IN ('staged','active','superseded','failed')),
  activated_at    TIMESTAMPTZ,
  superseded_at   TIMESTAMPTZ,
  CHECK ((manifest_ref IS NULL) <> (manifest_json IS NULL))
);
CREATE INDEX releases_project_active_idx ON internal.releases (project_id) WHERE status = 'active';
CREATE INDEX releases_project_created_idx ON internal.releases (project_id, created_at DESC);

CREATE TABLE internal.deploy_operations (
  id                       TEXT PRIMARY KEY,                          -- op_<ts_ms>_<rand>
  project_id               TEXT NOT NULL REFERENCES internal.projects(id) ON DELETE CASCADE,
  plan_id                  TEXT NOT NULL REFERENCES internal.deploy_plans(id) ON DELETE RESTRICT,
  base_release_id          TEXT REFERENCES internal.releases(id) ON DELETE SET NULL,
  target_release_id        TEXT REFERENCES internal.releases(id) ON DELETE SET NULL,
  status                   TEXT NOT NULL CHECK (status IN (
                              'planning','uploading','committing',
                              'staging','gating','migrating','schema_settling',
                              'activating','activation_pending','needs_repair',
                              'ready','failed','rolled_back')),
  payment_required         JSONB,
  error                    JSONB,
  last_activate_attempt_at TIMESTAMPTZ,                                -- driven by auto-resume worker (D12)
  activate_attempts        INT NOT NULL DEFAULT 0,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX deploy_operations_project_idx ON internal.deploy_operations (project_id, created_at DESC);
CREATE INDEX deploy_operations_resume_idx ON internal.deploy_operations (last_activate_attempt_at)
  WHERE status = 'activation_pending';
CREATE INDEX deploy_operations_gc_idx ON internal.deploy_operations (updated_at)
  WHERE status IN ('failed','rolled_back');

CREATE TABLE internal.applied_migrations (
  project_id   TEXT NOT NULL REFERENCES internal.projects(id) ON DELETE CASCADE,
  migration_id TEXT NOT NULL,
  checksum     BYTEA NOT NULL CHECK (length(checksum) = 32),
  applied_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  operation_id TEXT NOT NULL REFERENCES internal.deploy_operations(id) ON DELETE RESTRICT,
  PRIMARY KEY (project_id, migration_id)
);
```

**Typed staging tables instead of one JSONB blob.** A single `staged_resources(kind, ref, config JSONB)` blob would be a query and observability hazard the moment we need to GC stale Lambda versions (AWS limits 75 versions/function — easy to exhaust at agent-deploy cadence) or audit a stuck operation. Three typed tables with proper FKs:

```sql
CREATE TABLE internal.staged_function_versions (
  operation_id      TEXT NOT NULL REFERENCES internal.deploy_operations(id) ON DELETE CASCADE,
  function_name     TEXT NOT NULL,
  lambda_version    TEXT NOT NULL,                     -- AWS Lambda version (e.g. "42")
  source_sha256     BYTEA NOT NULL REFERENCES internal.content_objects(sha256) ON DELETE RESTRICT,
  config            JSONB NOT NULL,                    -- runtime, timeoutSeconds, memoryMb, schedule
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (operation_id, function_name)
);

CREATE TABLE internal.staged_deployments (
  operation_id   TEXT NOT NULL REFERENCES internal.deploy_operations(id) ON DELETE CASCADE,
  deployment_id  TEXT NOT NULL REFERENCES internal.deployments(id) ON DELETE RESTRICT,
  PRIMARY KEY (operation_id)
);

CREATE TABLE internal.staged_secret_sets (
  operation_id      TEXT NOT NULL REFERENCES internal.deploy_operations(id) ON DELETE CASCADE,
  secret_version_id TEXT NOT NULL,                     -- opaque id from secrets layer
  PRIMARY KEY (operation_id)
);
```

**Activation pointer.** Today no `live_deployment_id` column exists; the implicit live deployment is the newest `status='ready'` row per project. The activate phase introduces explicit pointers in a single transaction:

- `internal.releases.status = 'active'` for the new release; previous flips to `'superseded'` (use the partial unique constraint `... WHERE status = 'active'` enforced by index, with the swap done in one UPDATE that flips both rows).
- `internal.projects.live_release_id` (new column, FK to `releases.id`) — denormalized for hot-path lookup.
- Function alias swaps at AWS (UpdateAlias to point at the staged Lambda version).
- Subdomain mapping update (existing subdomain row → new deployment_id).
- Secret version-set pointer flip.

**Rollback** = create a new release whose `manifest_json` (or `manifest_ref`) is the parent's, then run activate on it. Cheap, no actual byte move; one new `releases` row marks the rollback in history.

**Storage-bytes accounting on release-only refs.** Two new triggers (matching the v1.32 pattern in `tg_blobs_storage_bytes` / `tg_deployment_files_storage_bytes`) on `staged_function_versions` and `releases.manifest_ref`. CAS GC's "no refs" union extends to count `staged_function_versions.source_sha256`, `releases.manifest_ref`, and any future release-retained CAS reference. Without this, function-source CAS objects retained by a `superseded` release are billed at $0 and reaped by GC after 30 days, breaking historical rollback.

### D9. Commit state machine — transactional, with an explicit schema-cache settle

Phase order:

```
1. validate           (manifest schema, content present, payment preflight, subdomain available,
                       migration ids/checksums sane, base-release conflict check)
2. stage              (build/stage Lambda function versions; stage site deployment via existing
                       `services/deploy-commits.ts` mechanism; stage secret version set;
                       reserve subdomain; insert rows into staged_function_versions /
                       staged_deployments / staged_secret_sets — no public pointer changes)
3. migrate-gate       (only if database.migrations is non-empty: set
                       `internal.projects.migrate_gate_until = NOW() + INTERVAL '60s'`;
                       edge middleware returns 503 + Retry-After for control plane AND for
                       /rest/v1/* — see "Gate scoping" below)
4. migrate            (acquire pg_advisory_xact_lock per project; single transaction;
                       SET search_path TO <project_schema>; for each migration in spec order:
                       check applied_migrations row; same id+checksum noop; same id different
                       checksum hard error; new id apply + INSERT applied_migrations row;
                       apply expose/RLS manifest in same transaction;
                       NOTIFY pgrst, 'reload schema'; COMMIT)
5. schema-settle      (wait for PostgREST to pick up the schema reload — see D11 for mechanism)
6. activate           (single control-plane transaction: flip releases.status; update
                       projects.live_release_id; flip Lambda alias to staged versions;
                       update subdomain → deployment_id mapping; flip secret version set;
                       clear migrate_gate_until)
7. ready              (poll site copy if `copying` via existing `services/copy-resume.ts`;
                       warm function cold-starts opportunistically; run smoke checks if defined;
                       mark operation ready)
```

**Why a separate migrate-gate, not the lifecycle gate?** The lifecycle gate (`packages/gateway/src/middleware/lifecycle-gate.ts`) returns 402 for control-plane writes during `frozen`/`dormant`. The migrate-gate is a different beast: short-lived (typically <30s, capped at 60s), 503 + Retry-After, and **explicitly carves out from the standing data-plane invariant** (CLAUDE.md: "data plane is never gated"). The carve-out is justified because the schema is mid-flight — PostgREST cache is stale, RLS policies are being rewritten, the data plane returning stale results during this window would be worse than returning 503. The carve-out applies only while `migrate_gate_until > NOW()`; it cannot be set by lifecycle.

**Why the schema-settle phase?** PostgREST picks up DDL via the `NOTIFY pgrst, 'reload schema'` channel and reloads asynchronously. Production observed reloads taking 1–6 seconds under back-to-back DDL load — this is the bug fixed in commit 4c65102b ([packages/gateway/src/services/postgrest-forward.ts](packages/gateway/src/services/postgrest-forward.ts)) by bumping the retry budget to 12×500ms. If we clear the migrate-gate immediately after migrate-COMMIT, the thundering herd of `/rest/v1/*` requests hits stale schema and re-introduces the bug. The schema-settle phase issues a canary `SELECT` that exercises the new schema (an information_schema lookup of one of the tables touched by the migration) with a short retry loop bounded by the same 6s budget. Once the canary succeeds, schema cache is warm; only then do we activate and clear the gate.

**Idempotency-Key on commit.** Reuse the existing `internal.idempotency_keys` middleware ([packages/gateway/src/middleware/idempotency.ts](packages/gateway/src/middleware/idempotency.ts)) on `POST /deploy/v2/plans/:id/commit` — the response cache makes the "agent retried because the network blipped" case naturally safe.

Failure handling:

- Phases 1–2: safe to retry. `deploy.apply(spec)` with the same digest hits the same plan via the existing `(project_id, manifest_digest) WHERE committed_at IS NULL` unique index on `internal.deploy_plans`; uploads dedup; staging restages only what's missing.
- Phase 3 (set gate): idempotent UPDATE; no rollback needed.
- Phase 4 SQL error: transaction rolls back; in finally block, clear `migrate_gate_until = NULL`; structured error carries `migration_id` + statement offset; active release unchanged.
- Phase 4 succeeds, phase 5 (schema-settle) times out: gate stays up; operation enters `schema_settling`; auto-resume worker (D12) retries the settle + activate phases. Schema-settle is replayable — it doesn't write.
- Phase 6 (activate) fails: operation enters `activation_pending`; migrations remain committed; staging resources remain; gate stays up; auto-resume worker completes activation without SQL replay.
- Non-transactional migrations (`transaction: "none"`): explicit opt-in. On failure, operation enters `needs_repair` with structured repair instructions. No blind replay.

**Why advisory lock and not a status guard?** Two concurrent commits for the same project would both try to migrate. `pg_advisory_xact_lock(hashtext($project_id))` matches the existing convention in `services/bundle.ts:344` and is held for the full transaction (auto-released at COMMIT). The lock key collision space is 32 bits; FNV-1a or hashtext both work — match the existing call site for consistency.

### D10. Backward-compat shims — three v1 routes folded onto v2

Three existing public routes get shimmed; all three keep their request/response shapes for the deprecation window.

**`apps.bundleDeploy` (SDK) → `POST /deploy/v1` (gateway).**

```ts
async bundleDeploy(projectId, opts) {
  const spec = translateBundleOptsToReleaseSpec(projectId, opts);
  const result = await this.client.deploy.apply(spec);
  return shapeAsBundleDeployResult(result);
}
```

Translation:

- `migrations: string` → `database.migrations: [{ id: "bundle_legacy_<sha256(sql).slice(0,16)>", checksum: sha256(sql), sql_ref: <CAS upload>, transaction: "required" }]`. **Deterministic id from the SQL content**, not a timestamp — so re-shipping identical SQL collapses to a noop via the registry. Behavior change vs. v1 (`runMigrations` re-executes on every call): documented release note. Idempotent SQL (`CREATE TABLE IF NOT EXISTS`) is unaffected; non-idempotent SQL gets safer (no accidental re-execution).
- `rls: { template, tables }` → `database.expose: <translated declarative manifest>` via the existing translator at [packages/gateway/src/services/bundle.ts:682](packages/gateway/src/services/bundle.ts:682) (`translateRlsToManifest`).
- `secrets: [{key, value}]` → `secrets.set: { [key]: { value } }`.
- `functions: [{name, code, ...}]` → `functions.replace: { [name]: { runtime: "node22", source: <CAS upload of code>, config, schedule } }`.
- `files: SiteFile[]` → SDK reads bytes (decoding base64 if needed), uploads to CAS via `/content/v1/plans`, builds `site.replace: FileSet`. **Empty/missing `files` with no `inherit` flag stays empty/missing in the spec → `site` is omitted → site is left untouched** (matches today's bundleDeploy semantics; v1 only wipes the site when explicitly given empty `files: []` with `inherit: false`).
- `subdomain: string` → `subdomains.set: [string]` (single-element; multi-subdomain is out of scope, see D13).
- `inherit: true` → ignored + deprecation warning. v2 patch semantics from per-resource omission already cover the use case.

**`sites.deployDir` (SDK) → `POST /deploy/v1/plan` + `POST /deploy/v1/commit` (gateway).** Today these are the existing site-CAS plan/commit routes ([packages/gateway/src/routes/deploy.ts](packages/gateway/src/routes/deploy.ts), [packages/gateway/src/services/deploy-plans.ts](packages/gateway/src/services/deploy-plans.ts), [packages/gateway/src/services/deploy-commits.ts](packages/gateway/src/services/deploy-commits.ts)) — they already use the same `internal.deploy_plans` / `internal.upload_sessions` / `internal.deployment_files` substrate. Folding them into v2:

- `POST /deploy/v1/plan` → translates the legacy `{ project, files: [{ path, sha256, size, content_type }] }` body into a v2 ReleaseSpec with `site: { replace: <FileSet from files[]> }`, calls `services/deploy-v2.ts:planDeploy`, reshapes the response to the legacy `{ plan_id, missing: [...] }` shape.
- `POST /deploy/v1/commit` → finds the operation linked to the plan_id, runs `services/deploy-v2.ts:commitDeploy`, reshapes to legacy `{ deployment_id, url }` on success.

Kill-switch env vars `DEPLOY_V1_BUNDLE_ROUTE_THROUGH_V2` and `DEPLOY_V1_SITE_ROUTE_THROUGH_V2` (both default `true`) so each path can fall back to legacy code if the shim has bugs in production. Phase B sets the deprecation headers on all three legacy routes. Phase C returns 410 Gone on `/deploy/v1` with non-empty `files` AND on the legacy `/deploy/v1/plan` + `/deploy/v1/commit` site CAS routes — at that point `/deploy/v2/plans` is the only public surface.

**Why fold all three at the same time?** Two parallel commit paths against the same `internal.deploy_plans` substrate is a divergence trap. The migration to v2 is cheaper to do once than twice; the kill-switch vars give us per-path rollback during the canary week.

**One-minor cycle.** Outside callers (forks of the project, integrators not using our SDK, the existing demos under `demos/`) keep working without code changes. SDK consumers get `Deprecation` headers; behavior is byte-identical modulo headers and the migration-noop semantic.

### D11. Schema-cache settle — how the gateway knows PostgREST is ready

PostgREST listens on the `pgrst` LISTEN/NOTIFY channel and reloads schema asynchronously. The gateway never gets an ack; the established workaround is the bounded retry loop in `services/postgrest-forward.ts` (12×500ms = 6s budget, post-v1.33). The schema-settle phase converts that workaround from a per-request reaction into a deploy-state-machine step:

```
async function schemaSettlePhase(operation, expectedTables: string[]) {
  // 1. NOTIFY was issued at COMMIT in the migrate phase.
  // 2. Issue a canary SELECT through the project's authenticator role
  //    that exercises a column added/touched by the migration.
  for (let i = 0; i < 12; i++) {
    const ok = await canarySelect(operation.project_id, expectedTables);
    if (ok) return;
    await sleep(500);
  }
  // 3. Timeout = leave operation in `schema_settling`; auto-resume tick retries.
  throw new SchemaSettleTimeoutError(operation.id);
}
```

The `expectedTables` list comes from diffing the schema snapshot before/after migrate (the existing `snapshotSchema` helper in `services/bundle.ts` already produces this — reuse). The canary SELECT runs through the same forward path PostgREST uses, so a successful canary proves the cache is warm for end-user traffic.

Cost of the settle phase under nominal conditions: 0–500ms (cache typically warm after the first poll cycle). Cost on cold/loaded: up to 6s. Cost when PostgREST is wedged: 6s timeout → `schema_settling` → auto-resume retries on the hourly tick (which is fine; the gate stays up but the operation isn't lost).

### D12. Auto-resume worker — `services/activation-resume.ts`

The proposal as originally drafted required SDK or human intervention to recover an `activation_pending` operation. That is wrong for run402's operational posture: the gateway already runs an hourly tick from `services/leases.ts` that drives `advanceLifecycle`, the daily cost fetcher, the CAS GC (three phases), and `runCopyResume` for `status='copying'` site deployments. Activation is structurally identical — finite work, replayable, externally-observable terminal state.

`services/activation-resume.ts` mirrors `services/copy-resume.ts`:

```ts
export async function runActivationResume(deps) {
  const rows = await deps.query(`
    SELECT id, project_id, plan_id, target_release_id
    FROM internal.deploy_operations
    WHERE status IN ('activation_pending', 'schema_settling')
      AND (last_activate_attempt_at IS NULL
           OR last_activate_attempt_at < NOW() - INTERVAL '5 minutes')
      AND activate_attempts < 10
    FOR UPDATE SKIP LOCKED
    LIMIT 32
  `);
  for (const op of rows) {
    await runWithLease(op.project_id, async () => {
      await deps.query(
        `UPDATE internal.deploy_operations
         SET last_activate_attempt_at = NOW(), activate_attempts = activate_attempts + 1
         WHERE id = $1`, [op.id]);
      try {
        if (op.status === 'schema_settling') await schemaSettlePhase(op, ...);
        await activatePhase(op);
        await readyPhase(op);
      } catch (err) {
        if (op.activate_attempts + 1 >= 10) {
          await markFailed(op, err); // operator-actionable
        }
      }
    });
  }
}
```

Wired into `services/leases.ts` alongside `runCopyResume`. Feature flag `DEPLOY_AUTO_RESUME_ENABLED` (default `true`) for emergency disable. After 10 attempts, operation transitions to `failed` with the error envelope — the gate clears (because operating with the gate up forever is worse than a failed deploy), staged resources GC after 24h.

**Why max 10 attempts?** Same number as `services/copy-resume.ts`. If activation has truly failed 10× over ~50 minutes, the issue is structural and an alarm should fire; auto-retry stops being useful past that point.

### D13. Gate scoping — which v2 endpoints are lifecycle-gated, which aren't

CLAUDE.md's three-category rule applies to the v2 surface. Explicit enumeration so the implementation doesn't drift:

| Route | lifecycle gate | Rationale |
|---|---|---|
| `POST /deploy/v2/plans` | yes | Control-plane write |
| `POST /deploy/v2/plans/:id/commit` | yes | Control-plane write |
| `POST /content/v1/plans` | yes | Control-plane write (initiates upload) |
| `POST /content/v1/plans/:id/commit` | yes | Control-plane write |
| `GET /deploy/v2/operations/:id` | no | Read-only |
| `GET /deploy/v2/operations/:id/events` | no | Read-only |
| `POST /deploy/v2/operations/:id/resume` | **no** | In-flight completion of an already-authorized commit |

The `resume` carve-out is critical: an `activation_pending` operation may sit in that state across a tier-lease expiry. Gating resume on `frozen`/`dormant` would trap the project in held-gate forever. Resume only completes work the project has already paid for — there is no x402 settlement on resume.

**Which endpoints respect the migrate-gate (`projects.migrate_gate_until`)?** During the gate window, `/rest/v1/*` returns 503 + Retry-After (data-plane carve-out, see D9), `/storage/v1/blob-internal` (CDN origin) returns 503 too, and all control-plane writes return 503 for that project. Read-only operations endpoints (`GET /deploy/v2/operations/*`) stay open so the SDK can poll for status during the migrate window. Resume stays open.

## Risks / Trade-offs

**Risk** — One CAS substrate exposed via three public routes (`/content/v1/plans`, `/storage/v1/uploads`, `/deploy/v1/plan`) during the deprecation window. → **Mitigation:** all three are thin adapters over `services/cas-promote.ts` + `services/deploy-plans.ts`. The internal substrate (`internal.content_objects`, `internal.deploy_plans`, `internal.plan_claims`) is single-owner; public routes are wire-format adapters. Existing `Run402/CAS` CloudWatch metrics dashboard already covers the substrate; alarms (`Run402CasCommitCopyFailedHigh`, `Run402CasStuckCopyingHigh`, `Run402CasDedupHitRateLow`) apply uniformly.

**Risk** — Schema-cache settle phase adds latency to every migrate-bearing commit. Nominal 0–500ms, p99 6s, worst-case 6s timeout into `schema_settling` state. → **Mitigation:** mandatory for the default path — this is the cost of fixing the bug we hit in commit 4c65102b. Auto-resume catches the timeout case so the operation isn't lost. The settle phase is itself non-blocking for the agent: the SDK polls `schema_settling` like any other non-terminal status, and the auto-resume worker drives the operation forward without manual intervention.

**Risk** — Migrate-gate carves out `/rest/v1/*` from the standing "data plane is never gated" invariant. → **Mitigation:** the carve-out is short (≤60s), narrowly scoped (only when `projects.migrate_gate_until > NOW()`), explicitly documented in CLAUDE.md, and surfaced as a deployment-correctness primitive rather than a billing primitive. End users see Retry-After during a deploy; this is acceptable because the alternative (returning stale rows / RLS-policy-mismatched data during DDL) is worse. Zero-downtime opt-in (`migrations: { zero_downtime: true }`) is available for callers who declare their migrations strictly backward-compatible.

**Risk** — Base-release conflict detection on full-replace deploys is a new agent-facing failure mode (two agents racing to redeploy). → **Mitigation:** default behavior on `apply()` is to auto-rebase if the patch's touched paths/keys are disjoint from concurrent changes; surface conflicts as structured `{conflict: { paths, keys }}` errors with a clear retry path. Document.

**Risk** — Five new tables (`releases`, `deploy_operations`, `applied_migrations`, `staged_function_versions`, `staged_deployments`, `staged_secret_sets`) plus two new columns on `internal.projects` (`live_release_id`, `migrate_gate_until`) plus one column flag (`migrations_adopted_at`, optional — see Migration Plan). All require explicit `REVOKE ALL` from `authenticator/anon/authenticated/service_role/project_admin` and corresponding db-staging probes. → **Mitigation:** Codified as a task; the db-staging-gate CI catches missing REVOKEs before merge (see CLAUDE.md "Migration staging gate"). Five new probes added to [test/db-staging/probes.ts](test/db-staging/probes.ts).

**Risk** — Storage-bytes accounting drift: function-source CAS objects retained only via `staged_function_versions` or via a `superseded` `releases.manifest_ref` are invisible to the v1.32 storage_bytes triggers. → **Mitigation:** new AFTER triggers on `staged_function_versions.source_sha256` and `releases.manifest_ref` mirror the v1.32 trigger pattern. CAS GC's "no refs" union extends to these tables. Storage-bytes invariant audit added to db-staging probes.

**Risk** — Migration registry hard errors on long-running projects when an agent's `deploy.apply` ships SQL that conflicts with a pre-v2 schema state. → **Mitigation:** **no bulk seed**. Registry starts empty; first v2 deploy per project executes whatever the spec ships. Agents migrating to v2 are documented to ensure their first migration block is idempotent (`CREATE TABLE IF NOT EXISTS`) — this is already the agent norm. For the rare case where an operator wants to record a migration as "already applied" without executing it, an admin endpoint `POST /deploy/v2/admin/migrations/adopt` accepts `{ project_id, migration_id, checksum }` and inserts the row. No cross-project bulk backfill — that path always lies, see "applied_migrations seed risk" tabled.

**Risk** — Server-authoritative digest changes the round-trip shape (SDK now learns the digest from the plan response). Tests that rely on the SDK-computed digest matching the gateway's are no longer meaningful. → **Mitigation:** the existing JCS canonicalize at [packages/gateway/src/services/deploy-plans.ts:286](packages/gateway/src/services/deploy-plans.ts:286) (`computeManifestDigest`) is reused as the gateway's digest function. The SDK keeps `sdk/src/node/canonicalize.ts` as a UX helper but no longer required to byte-match. Replace the cross-repo fixture test with a contract test that asserts the gateway accepts whatever the SDK posts (the SDK can verify the gateway's reply digest locally for sanity, but mismatch is no longer fatal).

**Trade-off** — Patch semantics + base-release conflict detection are more complex than today's "post the whole thing every time." The cost lands on the gateway (release model + diff logic). The win lands on agents (fast iteration, partial-failure recovery, structured progress).

**Trade-off** — `deploy.apply` becomes the only blessed primitive. Agents that today reach for `bundleDeploy` because it's "the atomic one" or `deployDir` because it's "the fast one" lose that mental shortcut. → **Mitigation:** docs explicitly cover the transition; the shims keep both old names working; the SDK exports `deploy` prominently in the README's first example.

**Trade-off** — Bundle-shim translates `migrations: string` to a deterministic `bundle_legacy_<sha256[0:16]>` id. Re-shipping identical SQL via the shim becomes a registry noop instead of v1's re-execution. Idempotent SQL (the agent norm) sees no change; non-idempotent SQL gets safer. Documented release note.

## Migration Plan

1. **Phase A — Build v2 alongside v1**
   - Ship gateway migration adding `internal.releases`, `internal.deploy_operations`, `internal.applied_migrations`, `internal.staged_function_versions`, `internal.staged_deployments`, `internal.staged_secret_sets`. Add `internal.projects.live_release_id`, `internal.projects.migrate_gate_until`. All with `REVOKE ALL` to anon/authenticated/service_role/project_admin (matches existing dark-by-default convention). Add five db-staging probes asserting the REVOKEs hold under all auth shapes. CODEOWNER review by `@MajorTal` per `.github/CODEOWNERS`.
   - Ship `services/content.ts` (the thin facade over existing `services/cas-promote.ts` + `services/deploy-plans.ts`) and `routes/content.ts`.
   - Ship `services/deploy-v2.ts` (plan + commit + state machine) and `routes/deploy-v2.ts`. Wire `services/activation-resume.ts` into the existing `services/leases.ts` hourly tick.
   - Ship the SDK `deploy` namespace + new types + Node helpers.
   - Ship the three v1 shims: `POST /deploy/v1` (bundle), `POST /deploy/v1/plan` + `POST /deploy/v1/commit` (site CAS). Each behind a kill-switch env var (`DEPLOY_V1_BUNDLE_ROUTE_THROUGH_V2`, `DEPLOY_V1_SITE_ROUTE_THROUGH_V2`, default `true`). `apps.bundleDeploy` and `sites.deployDir` SDK methods become thin wrappers over `deploy.apply`.
   - MCP `bundle_deploy`, `deploy_site`, `deploy_site_dir`, `deploy_function` keep their input schemas; new MCP tools `deploy` and `deploy_resume`.
   - **Risk window:** any divergence between v1-shim and v2 logic produces silent behavior changes. Mitigation: shadow-traffic comparison test (`bundle-v1-shim.test.ts`) asserts byte-identical responses modulo deprecation headers; one-week canary on staging via `BASE_URL=https://api.staging.run402.com npm run test:e2e` + `npm run test:bld402-compat`; full sync test in `sync.test.ts` extended; full `db-staging-gate` CI run on the migration before merge.

2. **Phase B — Deprecate (one minor)**
   - Add `Deprecation: true; Sunset: <date>; Link: </deploy/v2/plans>; rel="successor-version"` headers on all three v1 routes.
   - SDK emits a one-time console warning when callers pass legacy `files: SiteFile[]` with `inherit: true`, or when the inline-bytes `/deploy/v1` path is hit (the bundle shim CAS's bytes internally; only direct HTTP callers see the warning).
   - `cli/llms-cli.txt` updated to lead with `deploy.apply` examples; legacy section moved to a "compat" appendix.

3. **Phase C — Remove (next minor)**
   - `/deploy/v1` returns 410 Gone for requests with non-empty `files`. The route stays for callers using only `migrations`/`secrets`/`functions` without site files.
   - `/deploy/v1/plan` + `/deploy/v1/commit` return 410 Gone with a pointer to `/deploy/v2/plans`.
   - `bundleDeploy` SDK shim continues working — it CAS's bytes internally.
   - `inherit: true` becomes a hard error in the shim.

4. **Rollback strategy**
   - Phase A schema migration is **forward-only** (mirrors v1.32 cutover constraint). The five new tables and two `projects` columns cannot be dropped after they ship without an RDS snapshot restore.
   - Phase A code rollback: kill-switch env vars revert v1 routes to legacy code paths; `DEPLOY_AUTO_RESUME_ENABLED=false` disables the auto-resume worker. Schema persists harmlessly.
   - Phase B is purely additive (headers + warnings).
   - Phase C is the only real cutover. Mitigation: snapshot of pre-cutover gateway, traffic mirror to staging for one week before flipping, customer email + dashboard banner two weeks ahead.

## Open Questions — resolved

- **Q1. Payment timing.** Surface `payment_required` in the **plan** response body (HTTP 200) so the SDK can show the agent before bytes move. Settle the x402 charge at **commit** via the existing `Run402Client.fetch` 402 handshake. The plan-time surface is informational; commit is authoritative. Rationale: pre-revenue, settlement-on-plan would add a billing surface we don't have today, and the plan is cheap enough that an agent who pays at commit hasn't lost much. The lifecycle gate at `/deploy/v2/plans` already returns 402 if the project is `frozen`/`dormant`, which covers the "agent doesn't realize they're past-due" case at the expected layer.
- **Q2. Staging GC.** Three typed tables (`staged_function_versions`, `staged_deployments`, `staged_secret_sets`) all CASCADE-delete from `internal.deploy_operations`. Janitor task in the existing `services/leases.ts` hourly tick (alongside CAS GC and `runCopyResume`) deletes operations in `failed`/`rolled_back` older than 24h, which CASCADEs the staging rows. Never GC `activation_pending` or `schema_settling` — those are the auto-resume worker's domain. Stale Lambda versions (>75 per function, AWS limit) get a separate per-function reaper tick that drops the oldest non-active version.
- **Q3. v1→v2 translation locus.** Per-request, in the route handler. The shim does not persist a v2 plan for v1 callers — they don't have the operation_id surface anyway, so persisting wouldn't help them. The shim still uses `internal.idempotency_keys` (the existing middleware) for retry safety on `Idempotency-Key` headers.
- **Q4. Payment-required surfacing.** HTTP 200 with `payment_required` in the body. No discrete pricing endpoint — `POST /deploy/v2/plans` with an empty/minimal spec already serves that purpose (returns the diff against base + payment_required if any), at the cost of one plan-row insert.
- **Q5. Subdomain semantics.** **Single subdomain only**. `subdomains.set` accepts a one-element array; the gateway rejects multi-element arrays with a structured error pointing at the future multi-subdomain change. Multi-subdomain per project is a significant feature (KVS routing, billing, custom-domain interaction) and is explicitly **out of scope** for unify-deployments. The bundle shim's `subdomain: string` translates to `subdomains: { set: [string] }`; existing one-subdomain-per-project semantics are preserved exactly.
