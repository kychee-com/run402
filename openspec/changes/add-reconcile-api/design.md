## Context

This document is the design for run402's **agent control plane** — the API layer that sits on top of the artifact substrate proposed in [`unify-upload-primitives`](../unify-upload-primitives/). The two changes are siblings: the substrate handles bytes; this change handles the agent loop.

It is the direct response to the consultation review at [docs/consultations/agent-first-final-api-review.md](../../../docs/consultations/agent-first-final-api-review.md), which argued that even a perfect upload protocol is insufficient if agents can't:

- describe the current state after a context reset,
- diff desired against live before applying,
- recover from partial failures with machine-actionable next steps,
- iterate against preview environments instead of production,
- detect and prune drift,
- correlate logs and traces back to the bundle they came from.

Like `unify-upload-primitives`, this is written for **cross-repo review**. The private repo (`kychee-com/run402-private`) owns the diff engine, environment isolation, observability infra, routing/CDN integration. This (public) repo owns the SDK surface, the `run402.json` schema, MCP tool shapes, CLI ergonomics. Backend AI should review this and either confirm feasibility or push back before implementation begins.

## The framing problem this fixes

A 2026 coding agent operates in a loop:

```
read → plan → mutate → observe → repair → repeat
```

The current run402 API gives the agent only `mutate`. The other four steps require the agent to:

- remember its own state (brittle: agents lose context),
- compose primitives manually (slow: many tool calls per iteration),
- parse prose error messages (lossy: missing structured fields agents need),
- treat success-of-deploy as success-of-system (wrong: deploy can succeed while the app is broken).

The reconcile API closes that loop. It is the difference between "I uploaded files and got a URL" and "I made my repo match my desired environment, here is what changed, here is what is live, and here is exactly what to do if something is off."

## Goals / Non-Goals

**Goals:**
- Make `apps.reconcile` the primary motion. 90% of agent calls. Primitives are escape hatches for the other 10%.
- First-class preview environments + atomic promotion to production.
- `describe` / `diff` / `events` / `logs` / `health` surfaces that close the agent loop.
- Resource ownership: agents can prune their own drift without disturbing manual resources.
- Typed `run402.json` schema replacing implicit conventions where they break down.
- Structured errors with typed `next_actions[]`. Build/SQL errors carry file/line/column/code.
- All success responses carry enough metadata for the agent to make the next decision without another round-trip.

**Non-Goals:**
- Replacing the artifact substrate. That's `unify-upload-primitives`. This change *uses* it; doesn't redesign it.
- Forcing every existing caller to switch. The reconcile API is additive; existing surfaces keep working.
- Solving observability across all of run402 (e.g. project-level usage analytics, billing dashboards). Scope is limited to bundle-scoped agent feedback.
- Replacing existing per-resource SDK methods. They stay. Agents will mostly stop calling them as primary, but they remain for debugging and edge cases.
- Building a full local emulator. Out of scope. Preview environments + fast disposable preview DBs are the equivalent.

## The reconcile model

```
╔══════════════════════════════════════════════════════════════════════╗
║                          THE AGENT LOOP                              ║
╚══════════════════════════════════════════════════════════════════════╝

       ┌─────────────────────────────────────────────────────────┐
       │                                                         │
       │       ┌──────────────────────────────────────────┐      │
       │       │  apps.describe({ project, environment }) │      │
       │       │  →  current head bundle, resource state  │      │
       │       └────────────────────┬─────────────────────┘      │
       │                            ▼                            │
       │       ┌──────────────────────────────────────────┐      │
       │       │  apps.reconcileDir({ mode: "preview" })  │      │
       │       │  →  diff: what would change              │      │
       │       └────────────────────┬─────────────────────┘      │
       │                            ▼                            │
       │       ┌──────────────────────────────────────────┐      │
       │       │  apps.reconcileDir({ mode: "apply",      │      │
       │       │                      waitFor: "healthy" })│     │
       │       │  →  status, phase_results, live_state,   │      │
       │       │     health, warnings, next_actions       │      │
       │       └────────────────────┬─────────────────────┘      │
       │                            ▼                            │
       │       ┌──────────────────────────────────────────┐      │
       │       │  status === "applied" && health.ok       │      │
       │       │     → done; loop closes                  │      │
       │       │  status === "partial"                    │      │
       │       │     → repair using next_actions          │      │
       │       │  status === "blocked"                    │      │
       │       │     → preflight failed, no mutation done │      │
       │       └──────────────────────────────────────────┘      │
       │                            │                            │
       └────────────────────────────┘                            │
                                                                 │
       Then promote when ready:                                  │
                                                                 │
       ┌──────────────────────────────────────────────────┐      │
       │  apps.promote({ from: "preview/...",             │      │
       │                 to: "production" })              │      │
       │  →  atomic swap; production now serves           │      │
       │     the verified preview's bundle                │      │
       └──────────────────────────────────────────────────┘      │
                                                                 │
       And iterate observability:                                │
                                                                 │
       ┌──────────────────────────────────────────────────┐      │
       │  apps.events({ bundleId })                       │      │
       │  apps.logs({ bundleId, since })                  │      │
       │  apps.health({ project, environment })           │      │
       └──────────────────────────────────────────────────┘      │
                                                                 │
       └─────────────────────────────────────────────────────────┘
```

## API shape

### `POST /v2/apps/{project}/reconcile`

```
Request:
  {
    environment: "production" | "preview/feat-auth" | ...,   // default "production"
    spec: AppSpec,                                           // typed run402.json
    bundle: {
      migrations?: [{ version, sql }],
      secrets?: { KEY: "value" },
      functions?: [{ name, sha256, size, config?, schedule?, env_refs? }],
      site?: { manifest: [{ path, sha256, size, content_type? }] },
      subdomain?: { name },
      custom_domains?: [{ domain }]
    },
    mode: "preview" | "apply",
    prune?: { functions: bool, secrets: bool, routes: bool, custom_domains: bool },
    concurrency?: "auto-merge" | "fail-on-drift" | "force",
    base?: bundleId,                                         // explicit head expectation
    waitFor?: "active" | "healthy" | "none",
    verify?: {
      http?: [{ path, expectStatus?, expectBody? }],
      functions?: [{ name, method?, body?, expectStatus? }]
    },
    metadata?: { revision?, branch?, actor?, session? }
  }

Response (200 always; status field carries result):
  {
    status: "noop" | "blocked" | "preview" | "applied" | "partial",
    bundleId,                                                // null when mode=preview
    environment,
    spec_version,
    diff: {
      migrations: { pending: [versions], skipped: [versions], destructive: [versions] },
      secrets:    { adding: [keys], updating: [keys], unchanged: [keys], removing: [keys] },
      functions:  [{ name, change: "create"|"update"|"unchanged"|"remove" }],
      site:       { uploaded: count, reused: count, deleted_from_base: count, total_files: count },
      routes:     { adding: [...], updating: [...], unchanged: [...], removing: [...] },
      subdomain:  { change: "claim"|"update"|"unchanged"|"release", name },
      custom_domains: [{ domain, change }]
    },
    phase_results: {
      preflight:  { status: "ok"|"failed", checks: [{type, status, detail}] },
      migrations: { status: "applied"|"failed"|"skipped", applied: [versions], failed?: {...} },
      secrets:    { status: "ok"|"failed", set: [keys], unchanged: [keys], removed: [keys] },
      functions:  { status: "ok"|"partial"|"failed", items: [{ name, status, version, error? }] },
      site:       { status: "ok"|"failed", deployment_id, url, stats: {...} },
      subdomain:  { status: "ok"|"failed", url },
      custom_domains: [{ domain, status, dns_status?, cert_status? }]
    },
    live_state: {                                            // current truth after this call
      head_bundle_id,
      db_head_version,
      site_deployment_id, site_url,
      functions: { name: { version, code_sha256, status, schedule? } },
      secrets: { KEY: { fingerprint, updated_at } },
      subdomain: { name, url, owner_bundle_id },
      custom_domains: [{ domain, dns_status, cert_status }]
    },
    health: {
      status: "ok"|"degraded"|"failed"|"not_run",
      checks: [{ type, target, status, detail, latency_ms? }]
    },
    warnings: [
      { type: "destructive_migration", version, detail },
      { type: "orphaned_function_remote", name },
      { type: "missing_dns_verification", domain, instructions },
      ...
    ],
    next_actions: [{
      type, sdk_call, args, why
    }],
    trace_id
  }
```

### `GET /v2/apps/{project}/describe?environment=...`

Returns the full `live_state` block as defined above, plus:

- `head_bundle: { id, created_at, metadata, spec_version }`
- `recent_bundles: [{ id, created_at, status }]`
- `drift: [{ resource_type, resource_id, drift_type, detail }]` — anything live but not owned by the current head bundle.

This is the "I just reset context" call.

### `POST /v2/apps/{project}/diff`

Same input shape as reconcile (without `mode`/`waitFor`/`verify`). Returns the `diff` block only — no mutation. Equivalent to `reconcile({ mode: "preview" })` but cheaper and explicitly read-only.

### `GET /v2/apps/{project}/bundles/{bundleId}`

Detailed history record for a specific bundle: spec, manifest, phase_results, live_state at the time of deploy, metadata.

### `GET /v2/apps/{project}/bundles?environment=&limit=&cursor=`

Paginated bundle history.

### `POST /v2/apps/{project}/promote`

```
Request:
  { from: "preview/feat-auth", to: "production", verify?: {...}, waitFor?: "healthy" }

Response: same shape as reconcile (status, phase_results, live_state, health, warnings, next_actions).
```

Atomic: production's `head_bundle_id` is updated to the preview's bundle in a single transaction. Site/function/subdomain/custom-domain pointers swap together. Migrations are NOT replayed — production must already be at a compatible DB head, or the promote fails preflight with `next_actions` pointing to running migrations directly.

### `POST /v2/apps/{project}/retire`

```
Request: { environment: "preview/feat-auth" }

Response: { retired: { functions: [...], site: ..., subdomain: ..., custom_domains: [...] } }
```

Tears down a preview environment. Resources tagged with that environment + `owner: "reconcile"` are deleted. Migrations are NOT rolled back (DB schema is shared across environments unless preview-DB-branching is enabled).

### `GET /v2/apps/{project}/events?bundle_id=&since=&limit=`

Server-Sent Events (or paginated polling). Deploy lifecycle events: phase transitions, individual function build/start, custom-domain DNS changes, etc.

### `GET /v2/apps/{project}/logs?bundle_id=&function_name=&request_id=&since=&until=&filter=`

Bundle-scoped logs. When `bundle_id` is specified, returns logs only from invocations of that bundle's function versions. Supports filter expressions and pagination.

### `GET /v2/apps/{project}/health?environment=...`

Runs the spec's `verify` block (or default health checks). Returns the same `health` shape as `reconcile`'s response.

### `GET /v2/projects/{project}/capabilities`

```
Response:
  {
    runtimes: ["node22", "node24"],
    function_limits: { max_timeout_seconds, max_memory_mb, max_bundle_bytes, ... },
    site_limits: { max_files, max_total_bytes },
    blob_limits: { max_size_bytes },
    quotas: { api_calls_per_day, storage_bytes, ... },
    tier: { current, available, current_features: [...] },
    features: {
      preview_environments: bool,
      preview_db_branching: bool,
      custom_domains: bool,
      scheduled_functions: bool,
      ...
    }
  }
```

The "what does this project support" introspection. Agents call this on first contact with a project.

## The `run402.json` schema (v1)

```json
{
  "$schema": "https://run402.com/schemas/app/v1.json",
  "version": 1,
  "project": "prj_abc",
  "environment_defaults": {
    "subdomain": "myapp",
    "custom_domains": ["myapp.com"]
  },
  "build": {
    "site": {
      "command": "npm run build",
      "output": "./dist",
      "env": { "NODE_ENV": "production" }
    },
    "functions": [
      {
        "name": "webhook",
        "entry": "./functions/webhook.ts",
        "config": { "timeout": 30, "memory": 512 },
        "schedule": null,
        "env_refs": ["STRIPE_KEY"]
      },
      {
        "name": "cron",
        "entry": "./functions/cron.ts",
        "schedule": "0 */6 * * *"
      }
    ]
  },
  "migrations_dir": "./migrations",
  "secrets_file": "./secrets.env",
  "routes": [
    { "src": "/api/webhook", "dest": "function:webhook" },
    { "src": "/api/*", "status": 404 },
    { "src": "/(.*)", "dest": "site:$1", "fallback": "site:/index.html" }
  ],
  "headers": [
    {
      "src": "/static/*",
      "headers": { "Cache-Control": "public, max-age=31536000, immutable" }
    }
  ],
  "redirects": [
    { "from": "/old-path", "to": "/new-path", "status": 301 }
  ],
  "health": {
    "http": [{ "path": "/", "expectStatus": 200 }],
    "functions": [{ "name": "webhook", "method": "POST", "body": "{\"ping\":true}", "expectStatus": 200 }]
  },
  "prune": {
    "functions": true,
    "secrets": false,
    "routes": true,
    "custom_domains": false
  }
}
```

The schema is published, versioned, and JSON-Schema-described so agents (and humans) can validate locally before submitting to reconcile.

## Design decisions

### D1. `apps.reconcile` replaces `apps.deploy` as the primary surface

**Chosen.** "Deploy" implies imperative mutation. "Reconcile" implies "make remote match desired" — which is what agents actually do. Agents iterating dozens of times per session benefit from the latter framing more than humans benefit from the former.

`apps.deploy` (and `apps.bundleDeploy` as it exists today) remain as aliases / legacy entry points. Documentation steers new callers to reconcile.

### D2. Preview environments are a first-class dimension, not a label

**Chosen.** Every resource API gains an optional `environment` parameter. Preview environments have isolated state where it matters:

- **Subdomains**: preview environments get prefixed subdomains (`<branch>.<myapp>.run402.com`).
- **Function instances**: separate routes; production traffic never hits preview functions.
- **Secrets**: optionally environment-scoped (preview can override production secrets).
- **Database**: shared by default. Optional preview DB branching (cloned schema, isolated data) is a tier feature surfaced via `projects.capabilities`.
- **Custom domains**: production-only by default; preview environments can attach test domains via configuration.

`apps.promote({ from, to })` atomically copies the preview's bundle pointer to production. No re-running migrations (production must already be at the right DB head — preflight catches mismatches).

### D3. Preflight is mandatory before mutation

**Chosen.** Every reconcile call runs preflight first:

- AppSpec schema validation
- Capability check against `projects.capabilities`
- Quota / tier check
- Custom domain DNS verification status
- Migration history checksum check
- Subdomain availability
- Artifact size limits
- Concurrency check (current head vs. `base`)

Preflight failures produce `status: "blocked"` with `phase_results.preflight.checks` populated. **No mutations occur.** The agent gets a clean "fix these, then retry" response.

This reduces the most painful failure class: "DB migrated, then site deploy failed because subdomain was taken."

### D4. Phase ledger replaces opaque "partial failure"

**Chosen.** Every reconcile result carries a `phase_results` block keyed by phase name. Each phase has its own status and per-resource items. Agents can read it programmatically:

```ts
if (result.status === "partial") {
  for (const fn of result.phase_results.functions.items) {
    if (fn.status === "failed") {
      console.log(`Fix ${fn.name}: ${fn.error.message} at ${fn.error.file}:${fn.error.line}`);
    }
  }
}
```

No more parsing prose. The shape is consistent across all error classes.

### D5. No automatic rollback for DB; staged activation for non-DB

**Chosen.** Honest semantics:

- **Migrations**: append-only, no automatic rollback. Documented expectation: write backward-compatible migrations.
- **Functions / site / subdomain / routes**: staged. Build → upload → activation. If preflight fails or any pre-activation phase fails, no live pointers move. Activation is the last step and is best-effort atomic.

The result reports `live_state` as truth. If migrations succeeded but function activation failed, `live_state` shows the new DB head and the previous function versions. Agent knows exactly what to repair.

### D6. Resource ownership: tag everything, prune only owned

**Chosen.** Every resource created via reconcile is tagged:

```
{ owner: "reconcile", project, environment, app_spec_version, bundle_id }
```

Resources created via primitive APIs (`functions.deploy`, `blobs.put`, etc.) are tagged with `owner: "manual"`.

`prune: { functions: true }` deletes only `owner: "reconcile"` functions tagged with the current `(project, environment)` that aren't in the new desired state. Manual resources are untouched. Drift between what reconcile created and what's currently live (e.g. a function added manually after the last reconcile) is reported in `live_state.drift` but never auto-deleted.

### D7. `next_actions[]` are typed and machine-actionable

**Chosen.** Errors carry both `hint` (human-readable) and `next_actions[]` (machine-readable):

```json
{
  "type": "concurrency_conflict",
  "next_actions": [
    {
      "type": "describe",
      "sdk_call": "r402.apps.describe",
      "args": { "project": "prj_abc", "environment": "production" },
      "why": "Fetch current head before retrying"
    },
    {
      "type": "retry_auto",
      "sdk_call": "r402.apps.reconcileDir",
      "args": { "concurrency": "auto-merge", "dir": "./my-app" },
      "why": "Merge automatically if no resource conflicts"
    }
  ]
}
```

Agents can either follow the suggestions blindly or use them as hints. SDK consumers can type-check the action shapes against generated types.

### D8. Build / SQL / migration errors are structured

**Chosen.** No prose-only errors:

```json
{
  "type": "function_build_failed",
  "function_name": "webhook",
  "errors": [
    {
      "file": "functions/webhook.ts",
      "line": 41,
      "column": 12,
      "code": "TS2304",
      "message": "Cannot find name 'foo'",
      "snippet": "    const result = foo(...)",
      "severity": "error"
    }
  ]
}
```

```json
{
  "type": "migration_failed",
  "version": "003_add_users_idx",
  "statement_index": 2,
  "postgres_code": "23505",
  "message": "duplicate key value violates unique constraint",
  "constraint": "users_email_key",
  "table": "users",
  "column": "email"
}
```

### D9. Bundle metadata is first-class

**Chosen.** Every reconcile call accepts and stores:

- `revision` (git SHA),
- `branch`,
- `actor` (the agent or human that initiated),
- `session` (correlates multi-step agent runs),
- arbitrary `tags`.

These flow into `events`, `logs`, and `describe` so debugging across sessions becomes possible.

## Risks / Trade-offs

- **[Risk] API surface area grows significantly.** Reconcile + describe + diff + promote + retire + events + logs + health + capabilities = ~9 new top-level methods on top of the existing ~90. **Mitigation:** these are mostly read-only and follow consistent shapes; SDK type generation keeps cognitive load low.

- **[Risk] Preview environments add infrastructure complexity.** Subdomain prefixing, function isolation, optional DB branching — significant backend work. **Mitigation:** ship without DB branching first (shared DB, environment-scoped functions/sites); add branching when tier / feature flag justifies the cost.

- **[Risk] Diff engine is non-trivial.** Comparing arbitrary AppSpecs against live state across all resource types requires a coherent canonical form. **Mitigation:** build incrementally; surface partial diffs as warnings before guaranteeing complete diffs.

- **[Risk] Resource ownership tags require migration of existing resources.** **Mitigation:** legacy resources default to `owner: "manual"`; reconcile never touches them. New resources get the reconcile tag.

- **[Risk] Reconcile becomes the *only* recommended path; primitives feel deprecated.** That's actually the goal, but some agent workflows (one-off function deploy, one-off blob upload) genuinely don't need reconcile. **Mitigation:** keep primitives prominent in docs as "for the 10% targeted case." Don't deprecate.

- **[Risk] `run402.json` schema versioning will break callers across SDK versions.** **Mitigation:** schema is `version: 1` from day one; future versions add fields, never remove. Reconcile validates by `$schema` URL.

- **[Trade-off] Health checks add deploy latency.** A reconcile with `waitFor: "healthy"` waits for verify probes to succeed. **Tradeoff:** caller can pass `waitFor: "active"` or `"none"` to skip; agents that want safe iteration accept the latency.

- **[Trade-off] `next_actions[]` adds payload weight.** **Tradeoff:** worth it. Most are emitted only on error or when there's something useful to suggest.

## Open Questions for Private-Repo Review

1. **Preview environment infrastructure:** how much isolation is feasible? Per-environment function instances vs. shared instances with environment-aware routing? DB branching feasibility?
2. **Diff engine:** is computing the full structured diff per reconcile call practical at scale, or do we need to materialize it server-side?
3. **Health/verify execution:** does the gateway run HTTP checks against preview URLs synchronously (blocking the reconcile response), or async with status polling?
4. **Resource ownership migration:** are existing resources retroactively tagged, or do we treat the migration boundary as "everything before this is `manual`"?
5. **Promotion atomicity:** is a single-transaction swap of head_bundle_id for an environment achievable, or do we need a two-phase commit pattern across services (subdomain CDN, function router, etc.)?
6. **Logs/events at scale:** is bundle-scoped log filtering achievable with the current log infra, or does it need a new aggregation layer?
7. **Custom domain DNS verification:** how does verify check DNS state inline during preflight? Is there a status cache?

## Review Asks (for the private-repo AI)

Please respond with:

- **Yes/no/push-back** on each of the seven questions above.
- **What in the agent control plane is infeasible** in current infra, and why.
- **Alternative architectures** that achieve the same agent-DX outcomes with less infra change.
- **Sequencing** preferences: which of (reconcile, describe, diff, preview environments, observability, promotion, capabilities) is cheapest first? Which is load-bearing for the others?
- **T-shirt sizing** per top-level capability (S/M/L/XL).

Once locked, implementation will split into per-capability changes — most likely:

1. `add-app-describe-and-diff` (read-only, safest first)
2. `add-reconcile-engine` (core mutation flow + preflight + phase ledger)
3. `add-preview-environments`
4. `add-app-observability` (events + logs + health)
5. `add-resource-ownership-and-pruning`
6. `add-app-promotion`
7. `add-app-spec-schema` (`run402.json` typing + validation)

Each per-capability change will get its own design lock and per-repo task split.
