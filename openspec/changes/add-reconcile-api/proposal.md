## Why

A consultation review of the [`unify-upload-primitives`](../unify-upload-primitives/) design (captured at [docs/consultations/agent-first-final-api-review.md](../../../docs/consultations/agent-first-final-api-review.md)) returned a sharp critique: the artifact/CAS work is right, but it's still a **bytes-level** solution. It leaves the **agent control loop** unsolved.

A 2026 coding agent's primary motion is not "deploy these files." It is:

1. **Reconcile** local desired state with the live remote environment.
2. **Observe** the resulting state — health, logs, traces, drift.
3. **Repair** when partial or failed, using machine-actionable next steps.

The current proposed surface (`apps.deploy`, individual resource calls) makes the agent compose all of that manually. It also assumes:

- The agent always has `lastBundleId` in memory (agents lose context).
- The agent always wants production (preview environments are afterthoughts).
- Errors are read by humans (so prose hints suffice).
- Conventions in directory layout substitute for a typed app schema (they don't, at scale).
- A successful upload equals a healthy deployment (it doesn't).

This change introduces the **agent control plane** that sits on top of the artifact substrate from `unify-upload-primitives`. The two changes are siblings:

- `unify-upload-primitives` — content-addressed bytes, idempotent uploads, deploys/blobs/functions as artifact-backed views. **Substrate.**
- `add-reconcile-api` (this change) — `apps.reconcile`, preview environments, `describe`/`diff`/`promote`/`events`/`health`, resource ownership, typed `run402.json` schema. **Control plane.**

Both can be designed independently and reviewed in parallel. Implementation depends on the substrate landing first, but design review and architectural commitment do not.

## What Changes

The agent's primary motion becomes:

```ts
await r402.apps.reconcileDir({
  project,
  environment: "preview/feat-auth",
  dir: "./my-app",
  mode: "apply",                      // or "preview" for a dry-run diff
  prune: { functions: true, routes: true },
  concurrency: "auto-merge",
  waitFor: "healthy",
  verify: { http: [{ path: "/", expectStatus: 200 }] },
});
```

The result is always:

```ts
{
  status: "noop" | "blocked" | "partial" | "applied",
  bundleId,
  environment,
  diff,                  // what would change / did change
  phase_results,         // per-phase ledger
  live_state,            // current truth (functions/site/db_head/secrets fingerprints)
  health,                // verification results
  warnings,              // destructive migrations, orphans, DNS pending, etc.
  next_actions,          // typed, machine-actionable
}
```

### New top-level surface

- **`apps.reconcile` / `apps.reconcileDir`** — the primary motion. Replaces `apps.deploy` as the recommended call.
- **`apps.describe({ project, environment })`** — current snapshot: head bundle, site URL, function versions, applied migrations, secrets fingerprints, drift, environment metadata. The "I just reset context, what's live?" call.
- **`apps.diff({ project, environment, ... })`** — what would change vs. current. First-class, not a side-effect of `mode: "preview"`.
- **`apps.get(bundleId)`** — bundle history detail.
- **`apps.list({ project, environment? })`** — pagination + async iteration.
- **`apps.promote({ from: "preview/feat-auth", to: "production" })`** — atomic environment promotion.
- **`apps.events({ project, bundleId? })`** — deployment event stream.
- **`apps.logs({ project, bundleId?, ... })`** — bundle-scoped logs filterable by version, request ID, function.
- **`apps.health({ project, environment })`** — readiness/health checks across the bundle.
- **`projects.capabilities({ project })`** — runtimes, limits, tier features, feature flags. The "what does this project support" introspection call.

### Environment dimension

Every resource API gains an optional `environment` parameter (default `"production"`). Environments are first-class: `production`, `preview/<branch>`, `preview/<id>`, etc. Preview environments have isolated state (separate function instances, isolated subdomain space, optionally separate DB schema or branch).

Preview lifecycle:
- `apps.reconcileDir({ environment: "preview/feat-auth" })` creates the preview if it doesn't exist.
- `apps.promote({ from: "preview/feat-auth", to: "production" })` atomically swaps the production bundle to the preview's bundle.
- `apps.retire({ environment: "preview/feat-auth" })` tears down the preview.

### `run402.json` as a typed app spec

Conventions are kept as defaults but `run402.json` becomes a real, versioned, typed schema:

```json
{
  "$schema": "https://run402.com/schemas/app/v1.json",
  "version": 1,
  "project": "prj_abc",
  "environment_defaults": {
    "subdomain": "myapp"
  },
  "build": {
    "site": { "command": "npm run build", "output": "./dist" },
    "functions": [
      { "name": "webhook", "entry": "./functions/webhook.ts" }
    ]
  },
  "routes": [
    { "src": "/api/*", "dest": "function:webhook" },
    { "src": "/(.*)", "dest": "site:$1", "fallback": "site:/index.html" }
  ],
  "headers": [
    { "src": "/static/*", "headers": { "Cache-Control": "public, max-age=31536000" } }
  ],
  "redirects": [
    { "from": "/old-path", "to": "/new-path", "status": 301 }
  ],
  "health": {
    "http": [{ "path": "/", "expectStatus": 200 }]
  },
  "prune": { "functions": true, "secrets": false, "routes": true }
}
```

### Resource ownership and pruning

Every reconcile-managed resource is tagged with `(project, environment, app_spec_version, owner: "reconcile")`. The reconcile API can prune resources tagged as owned-by-this-app that are no longer in the desired state, but **never** prune resources created by other paths (e.g. ad-hoc `functions.deploy`, manual blob uploads). Drift between desired state and live state is surfaced in `diff` and `live_state`.

### Structured errors with `next_actions`

Errors carry typed `next_actions[]` arrays alongside the prose `hint`:

```json
{
  "error": {
    "type": "concurrency_conflict",
    "message": "Bundle was updated since base.",
    "hint": "Refresh and retry.",
    "retryable": true,
    "next_actions": [
      { "type": "describe", "sdk_call": "r402.apps.describe", "args": { "project": "prj_abc", "environment": "production" } },
      { "type": "retry_auto", "sdk_call": "r402.apps.reconcileDir", "args": { "concurrency": "auto-merge" } }
    ]
  }
}
```

Build / SQL / migration errors include structured detail (`file`, `line`, `column`, `code`, `position`, failing statement index) — never prose blobs.

### App-level observability

Logs, events, traces, and health are scoped to the app and the bundle, not just per-function:

- `apps.events({ bundleId })` — deployment lifecycle events, replayable.
- `apps.logs({ project, bundleId?, since?, filter? })` — bundle-scoped logs across all functions in the bundle, filterable by version/request_id.
- `apps.health({ project, environment })` — runs the spec's verify hooks and returns pass/fail with detail.
- All `invoke` / deploy responses carry `request_id` / `trace_id` for correlation.

### Per-resource success-result improvements

- `secrets.list` returns `{ key, fingerprint, updated_at }` (still no values) so agents can detect drift.
- `sites.deploy` gains explicit `status: "noop" | "unchanged"`.
- `functions.deploy` gains `status: "unchanged"` and `code_sha256`.
- All list endpoints support cursor pagination + SDK async iteration.
- Bundles carry user metadata: `revision`, `branch`, `actor`, `session`.

### Sunset

- `apps.deploy` as a top-level surface — replaced by `apps.reconcile`. (The verb is wrong for what agents actually do.)
- `target` parameter — replaced by broader `environment`.
- Prose-only error hints — replaced by `hint` + `next_actions[]`.
- Implicit directory conventions as the only spec — superseded by typed `run402.json`. Conventions remain as defaults *under* the schema.

## Capabilities

### New Capabilities

- `reconcile-api` — The `apps.reconcile` motion + the supporting `describe`/`diff`/`get`/`list`/`promote`/`retire` surface. Includes the typed `run402.json` schema and the per-phase result ledger.
- `preview-environments` — Environment as a first-class dimension across all resource APIs. Preview lifecycle (create on first reconcile, promote, retire). Environment-scoped subdomains, secrets, function instances, optional DB branching.
- `app-observability` — Bundle-scoped events / logs / health / traces. The agent control-loop second half: not just "did upload succeed?" but "is the deployed system healthy?".
- `resource-ownership` — Ownership tags, drift detection, prune policy. Distinguishes reconcile-managed resources from ad-hoc ones; surfaces orphans without auto-deleting unmanaged resources.

### Modified Capabilities

_None._ This change is additive on top of the substrate from `unify-upload-primitives`. The existing `incremental-deploy` capability is being modified by that sibling change; this change does not touch it further.

## Impact

- **Private repo (infra)**:
  - Bundle / app spec storage with environment dimension.
  - Preview environment infrastructure: subdomain prefixing, function instance isolation, optional DB schema branching or scratch projects.
  - Resource ownership table (or columns on existing tables): `owner`, `app_spec_version`, `environment`, tag set.
  - Bundle event store + log aggregator (logs filterable by `bundle_id`).
  - Health check executor: runs `verify` HTTP/function probes after reconcile.
  - Diff engine: compares desired bundle to current live state, produces structured diff.
  - Promotion machinery: atomic swap of the head bundle for an environment.
  - Routing config: applied at deployment time to the gateway/CDN.

- **Public repo (SDK / MCP / CLI)**:
  - SDK: new `apps.reconcile` / `apps.reconcileDir` / `apps.describe` / `apps.diff` / `apps.promote` / `apps.events` / `apps.logs` / `apps.health` methods. Plus `projects.capabilities`.
  - SDK: typed schemas for `run402.json`, environments, ownership tags, phase ledger, next-action types.
  - MCP: new tools for the reconcile motion + describe + diff + promote + observability. Existing `bundle_deploy` keeps working but is no longer the recommended primary tool.
  - CLI: new subcommands mirroring the SDK surface.
  - Documentation: workflows centered on reconcile + preview-promote, not on imperative resource calls.

- **Cross-cutting**:
  - This change is **design-first**. Like `unify-upload-primitives`, no implementation lands until the design is reviewed and locked.
  - Cross-repo coordination required: backend owns the diff engine, environment isolation, and observability infra; public repo owns the SDK contracts and `run402.json` schema.

- **Backwards compatibility**:
  - `apps.bundleDeploy` (current name) keeps working. New callers use `apps.reconcile`.
  - `target: "production"` keeps working. New callers use `environment: "production"` (semantically equivalent default).
  - All existing per-resource APIs (`sites.deploy`, `functions.deploy`, etc.) remain available.

- **This change is design-only. No code changes.** Implementation lands in per-phase changes once reviewed.
