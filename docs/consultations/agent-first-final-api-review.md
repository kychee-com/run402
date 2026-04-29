# Consultation Result

**Model**: gpt-5.4-pro
**Submitted**: 2026-04-24T18:55:05.675933
**Completed**: 2026-04-24T19:17:57.704679
**Status**: completed

---

Blunt read: **good substrate, incomplete agent loop**.

You’ve mostly solved the **bytes/problem**: content addressing, dedup, `deployDir`, versioned migrations, structured errors. That part looks strong.

What’s still missing is the **agent control plane**:  
**“make this repo match environment X, show me the diff, wait until it’s healthy, and if not, tell me exactly how to self-correct.”**

Right now the design is still a bit too **deploy-centric** and **production-centric**. A 2026 coding agent cares less about “did upload succeed?” and more about:

- what changed?
- what is live now?
- is it healthy?
- what drift exists?
- what should I do next?

So my top-level recommendation is:

## Big opinion
Make **`apps.reconcile`** the primary abstraction, not `apps.deploy`.

Keep your primitives almost as-is. They’re good escape hatches.  
But the default agent motion should be:

```ts
await r402.apps.reconcileDir({
  project,
  environment: "preview/feat-auth",
  dir: "./my-app",
  mode: "apply",           // or "preview"
  prune: { functions: true, routes: true },
  concurrency: "auto-merge",
  waitFor: "healthy",
  verify: {
    http: [{ path: "/", expectStatus: 200 }],
    functions: [{ name: "webhook", expectStatus: 200 }],
  },
});
```

And the result should be:

- `status: "noop" | "blocked" | "partial" | "applied"`
- `diff`
- `phase_results`
- `live_state`
- `health`
- `warnings`
- `next_actions`

That’s the shape I’d actually want to use tomorrow.

---

## What I like as-is

These are right:

- **CAS/content-addressed idempotency**
- **artifact layer hidden by default**
- **Node `deployDir` helpers**
- **versioned SQL migrations**
- **structured errors**
- **bundle-level deploy as a concept**

So this is not “throw it out.”  
It’s more: **you’ve over-designed the upload plumbing and under-designed the reconcile/observe loop.**

---

# 1. Redeployment loop

## Short answer
**Close, but not enough. Yes, there is a dramatically better ergonomic: one `reconcile` call.**

### What I would immediately hit
In a real 50-iteration loop, I’d hit these day one:

1. **I don’t want to manually track `lastBundleId`.**
   Agents lose local memory/context all the time.  
   `base` is good as an escape hatch, bad as the happy path.

   I’d want:
   - `concurrency: "auto"` by default
   - SDK fetches current head automatically
   - server only blocks if there is a **real conflicting drift**, not just “head changed”

2. **I need a diff/preview before applying.**
   Not a separate human nicety — a real agent necessity.

   I want:
   - `mode: "preview" | "apply"`
   - `diff: { functions changed, site paths changed, migrations pending, secrets changed, orphans }`

3. **Deploy success is not enough.**
   I need `waitFor: "active" | "healthy"` and preferably built-in verify hooks.
   My real loop is:
   - edit
   - deploy
   - hit URL / invoke function
   - inspect logs
   - fix
   - redeploy

4. **I need app-level observability right after deploy.**
   Not just `functions.logs(name)`.  
   I want logs/traces scoped to the bundle/deploy I just made.

5. **I need no-op to be explicit.**
   `deployed` is too vague. Give me `status: "noop"`.

---

## The better end-state
The common loop should be:

- `apps.describe(project, environment)` → current state
- `apps.reconcileDir({ mode: "preview" })` → what would change
- `apps.reconcileDir({ mode: "apply", waitFor: "healthy" })`
- `apps.events({ bundleId })` / `apps.logs({ bundleId })`

If you only add one thing, add **preview+apply reconcile with health**.

---

# 2. Declarative vs imperative

## Short answer
**More declarative at the app level. Less ambiguous. Keep primitives imperative.**

Your current top-level posture says “declarative,” but `apps.deploy` is only **partially** declarative.

### Where it’s good
- **Sites**: good. Manifest is complete truth.
- **Functions (single function)**: okay.
- **Blobs**: okay.
- **Migrations**: imperative log, which is fine.

### Where it breaks
At the **app** level, omission semantics are unclear.

If my repo used to have:

- `functions/webhook/`
- `functions/cron/`

and now I delete `cron/`, what happens?

If my `secrets.env` no longer contains `OLD_KEY`, what happens?

If the remote project has a stale function from a previous agent run, what happens?

If the answer is “nothing unless you separately delete it,” then `apps.deploy` is **not** really reconcile. It’s a patch API wearing declarative clothes.

---

## What I’d want
### A full vs patch mode
Something like:

- `mode: "full"` → desired state for managed resources
- `mode: "patch"` → only touch listed resources

Or simpler:

- `prune: { functions: true, secrets: false, routes: true }`

### Resource ownership
This is the safest agent-first model.

`apps.reconcileDir` should manage/prune only resources tagged as:
- created by this app
- or previously managed by bundle deploys from this project/app spec

That lets you be declarative **without** deleting unrelated manual resources.

### Important nuance
For SQL, I would **not** try to make schema itself declarative.  
Migrations as append-only are fine.

But I **would** add:

- `sql.schema()` / schema introspection
- migration preflight warnings
- destructive change warnings
- maybe preview DB/reset/clone support

So: **declarative app/environment state**, **imperative debug primitives**, **append-only DB migrations**.

That balance feels right.

---

# 3. Discoverability

## Short answer
Current discoverability is not enough for autonomous use.

A modern agent needs **three things**:

1. **Capabilities**
2. **Current state**
3. **Machine-actionable next steps**

Prose `hint` is good for humans.  
For agents, I want typed metadata.

---

## I would add these endpoints immediately

### `projects.capabilities(...)`
Tell me what this project/environment supports:

- runtimes
- limits
- quotas
- max artifact sizes
- max timeout/memory
- whether preview envs exist
- whether custom domains exist
- whether scheduled functions exist
- current tier
- feature flags

Without this, I’m guessing.

---

### `apps.describe(...)`
I need a current snapshot:

- current bundle/head
- current site deployment + URL
- current functions + versions + hashes
- current subdomain/custom domains
- current secrets keys + fingerprints
- applied migrations
- drift/orphans
- environment metadata

This is what I call after context reset.

---

### `apps.diff(...)` / preview mode
Tell me:

- what would change
- what is already converged
- what is blocked
- what is orphaned
- what quota/tier issues will happen
- what missing secret refs exist
- what subdomain/domain conflicts exist

This should be first-class.

---

## Errors: yes, add `next_action`, but typed
I would not stop at `hint`.

I want:

```json
{
  "error": {
    "type": "concurrency_conflict",
    "message": "...",
    "hint": "...",
    "retryable": false,
    "next_actions": [
      { "type": "refresh_head", "sdk_call": "r402.apps.describe", "args": { "project": "prj_abc" } },
      { "type": "retry_with_base", "sdk_call": "r402.apps.reconcileDir", "args": { "base": "bun_new" } }
    ]
  }
}
```

Even better: include conflict detail:

- which resource changed remotely
- whether the conflict is mergeable
- whether my desired state still matches current head

---

## Success responses should also carry more metadata
Today stats are too thin.

I want on success:

- `diff`
- `warnings`
- `live_state`
- `health`
- `trace_id`
- `next_actions` when useful

Examples:
- `warning: destructive_migration`
- `warning: missing_custom_domain_dns_verification`
- `warning: orphaned_function_remote`
- `warning: function deployed but health check failed`

---

## One very specific improvement
`secrets.list()` returning only keys is too weak.

Return at least:

- `key`
- `fingerprint`
- `updated_at`

I do **not** need the value.  
But I do need to know whether my desired secret probably differs.

---

## Build/migration errors need to be structured, not prose blobs
Especially for self-correction:

- function build errors: `file`, `line`, `column`, `code`, `message`
- SQL errors: Postgres `code`, `position`, `table`, `column`, `constraint`, failing statement index

This is huge for agents.

---

# 4. Granularity

## Short answer
**`apps.deploy` is the right default granularity — but only if you make it a real reconcile API.**

Agents should **not** always compose primitives manually.  
That’s too much tool orchestration and too much state tracking.

### My actual preference
- **90%** of the time: one app-level call
- **10%** of the time: primitives for targeted debug/fixes

That’s the right split.

---

## What I’d change
### Rename/reframe it
I’d strongly consider:

- `apps.reconcile`
- `apps.sync`

more than `apps.deploy`

Because the job is not “deploy some things.”  
The job is “make remote state match local desired state.”

---

### Add narrowing controls
I still want one top-level API, but with scope control:

- `only: ["site"]`
- `only: ["functions:webhook"]`
- `exclude: ["migrations"]`

That avoids forcing me down into primitives when I’m doing a focused edit.

---

## One thing it currently hides too much
**Deletion/orphan behavior.**

If `apps.deployDir` doesn’t tell me what remote resources are now stale, it hides the wrong thing.

So yes: keep the high-level call.  
But expose a rich per-resource result.

---

# 5. Bundle-deploy failure semantics

## Short answer
`partial_failure` is the right idea, but the current shape is too shallow.

Also: **do not claim atomicity you do not have.**

“Migrations succeeded, function deploy failed” is not atomic from my point of view.  
It’s a partially mutated system, and I need the exact live state.

---

## What I want instead

### A status model like this
- `blocked` → preflight failed, **no side effects**
- `partial` → some phases applied
- `applied` → everything applied
- `noop` → no changes

That is much more useful than success/error ambiguity.

---

### A per-phase ledger, not one `partial_failure` blob
I want:

```json
{
  "status": "partial",
  "phases": {
    "preflight": { "status": "ok" },
    "migrations": { "status": "applied", "applied": ["003_users_idx"] },
    "secrets": { "status": "ok", "set": ["STRIPE_KEY"] },
    "functions": {
      "status": "partial",
      "items": [
        { "name": "webhook", "status": "failed", "error": { "...": "..." } },
        { "name": "cron", "status": "unchanged" }
      ]
    },
    "site": { "status": "skipped_due_to_prior_failure" }
  },
  "live_state": {
    "db_head": "003_users_idx",
    "functions": { "webhook": "old_v3", "cron": "v2" },
    "site": "dpl_prev"
  }
}
```

That is what an agent can repair from.

---

## Rollback?
### DB migrations: **no automatic rollback**
That’s the honest answer.

Do not imply rollback for DB unless you have actual snapshot/restore semantics.

### Non-DB resources: optional
If you can safely keep site/functions/subdomain activation staged until preflight succeeds, great.

But from the agent perspective, the most important thing is:

- preflight as much as possible
- only mutate after validation
- if partial, tell me exact live state

That matters more than magical rollback.

---

## Strong recommendation: add preflight before any mutation
Catch these **before** applying migrations:

- missing secret refs
- invalid schedule/runtime/config
- subdomain/domain unavailable
- quota/tier blockers
- checksum/history conflicts
- artifact-size blockers

This reduces the nasty class of “DB changed, then obvious non-DB thing failed.”

---

## Also: fixed phase order is too rigid
`migrations -> secrets -> functions -> site -> subdomain` is defensible, but not universally safe.

At minimum:
- make the order explicit
- preflight everything first
- consider a configurable strategy later

If you keep one default order, document that migrations should be backward-compatible.

---

# 6. What’s missing entirely

## The truly load-bearing missing primitives

### 1. Preview environments + promotion
This is the biggest missing concept.

A 2026 agent should default to:
- deploy to preview
- verify
- promote to production

Not:
- redeploy production 50 times

Your current `target?: "production"` framing is too narrow.

I want an `environment` dimension across app/site/functions/secrets, plus:
- `apps.promote(...)`
- stable preview URLs
- preview-scoped secrets
- ideally preview DB/project clone

---

### 2. App diff / preview
Must-have.

- `apps.diffDir`
- `apps.reconcileDir({ mode: "preview" })`

Without this I’ll build my own wrapper immediately.

---

### 3. App state snapshot
Must-have.

- `apps.describe`
- `apps.get(bundleId)`
- list current head + resource versions

Right now HTTP shows `POST /v2/apps/.../deployments` but not clear GETs for bundle detail/history. I need those.

---

### 4. App-level observability
Also must-have.

I want:
- deployment event stream
- app logs by `bundle_id`
- function logs filterable by `version`, `request_id`, `bundle_id`
- health/readiness checks
- traces/request IDs surfaced from invoke + deploy

`functions.logs(name)` alone is not enough.

---

### 5. SQL schema introspection + dev reset/clone
For real iteration, especially with migrations, I need:

- `sql.schema()`
- migration preflight warnings
- ideally `project.clone` / `db.branch`
- or at least `sql.resetToMigrations()` for preview/dev

A local emulator is less important to me than a **fast disposable remote preview DB/project**.

---

### 6. Routing / rewrites / headers / redirects
This is a big one.

As written, you have:
- static site
- functions with separate URLs

But a real app usually needs:
- `/api/*` → function
- SPA fallback
- headers
- redirects
- cache control

Without routing, frontend↔backend integration is clumsy.  
I’d hit this immediately.

---

### 7. Build-step integration
`apps.deployDir` is still too “dist-folder-centric.”

Real repos have source trees, not prebuilt `site/` outputs.

`run402.json` should grow into a real app spec with:
- build commands
- output directories
- function entries
- route config
- health checks
- prune policy

Conventions are nice defaults; they are not enough as the final control plane.

---

### 8. Custom domains as first-class
You mention custom domains in the product, but the proposed final shape only really shows subdomain.

I would want:
- attach domain
- list domains
- verify DNS
- cert status
- promote/swap

If custom domains are part of the product, they need to be in the app model.

---

### 9. Resource ownership / pruning
Without this, stale functions and drift will accumulate forever.

This is essential for autonomous agents.

---

### 10. Source maps
If a bundled function crashes, I need logs that point to:
`functions/webhook/index.ts:41`

not:
`bundle.js:9832`

Source maps are agent-grade debugging infrastructure.

---

# 7. What this gets wrong about how coding agents actually work in 2026

A few framing issues:

## 1. Agents are repo-centric, not resource-centric
The main motion is not:
- deploy site
- deploy function
- run migration

The main motion is:
- **reconcile repo to environment**
- **observe**
- **repair**

Your primitives support that, but the top-level API should reflect it directly.

---

## 2. Agents are preview-first, not production-first
Autonomous agents should not treat “production deploy” as the default edit loop.

Make preview environments and promotion first-class.

---

## 3. Agents have partial memory
Requiring the caller to remember `lastBundleId` is brittle.

Good API for agents assumes:
- context can reset
- another agent may have mutated state
- the SDK should recover by describing current head and diffing

---

## 4. Agents need machine actions, not prose hints
`hint` is nice.  
`next_actions[]` is what gets used.

---

## 5. Deploy is only half the loop
A deploy API without:
- health
- logs
- traces
- diff
- current state

is not agent-complete.

---

## 6. Multi-agent concurrency is real
A single coarse `base` conflict at bundle scope is probably too blunt.

If another agent changed a secret and I changed only the site, I want:
- auto-merge if safe
- or at least conflict detail by resource

---

## 7. Convention-only control planes break at scale
Agents are actually very good at editing machine-readable config files.

So don’t be afraid to make `run402.json` a real, typed, versioned schema.

That will be more reliable than implicit directory conventions once apps get nontrivial.

---

# If I were forcing a concrete end-state

I’d keep most primitives and add these as the real top-level surface:

- `apps.reconcile({ ..., mode: "preview" | "apply" })`
- `apps.reconcileDir(...)`
- `apps.describe({ project, environment })`
- `apps.diff({ ... })`
- `apps.events({ bundleId? })`
- `apps.logs({ bundleId? })`
- `apps.promote({ fromEnvironment, toEnvironment })`
- `projects.capabilities({ project })`
- `sql.schema({ project })`
- `projects.clone(...)` or `db.branch(...)`

And I’d make the reconcile result always include:

- `status`
- `bundleId`
- `diff`
- `phase_results`
- `live_state`
- `health`
- `warnings`
- `next_actions`

---

# Small API nits

A few smaller things I’d fix:

- add explicit `apps.get(bundleId)` HTTP + SDK
- SDK list methods should expose pagination/async iteration, not just arrays
- `sites.deploy` should support `status: "noop"` / `unchanged`
- `functions.logs` should stream and filter by `version` / `request_id` / `bundle_id`
- `invoke` should return `request_id` / `trace_id`
- `secrets.list` should return fingerprints
- `target?: "production"` should become a broader `environment` concept
- `apps.deployDir` needs explicit prune behavior
- `apps.deployDir` should support metadata/tags (`revision`, `branch`, `actor`, `session`)

---

## Bottom line

**I would use this.**  
But I would immediately start wishing it had:

1. **`reconcile` instead of `deploy` as the main mental model**
2. **preview/diff**
3. **preview environments + promotion**
4. **app-level observability/health**
5. **honest partial/live-state semantics**
6. **prune/ownership**
7. **routing + build config**

If you ship exactly what’s written, I can work with it.  
If you ship the reconcile/preview/observe/environment model on top of it, **I’d trust an autonomous agent to live in it all day**.

---
**Wall time**: 22m 52s
**Tokens**: 7,074 input, 40,374 output (35,864 reasoning), 47,448 total
**Estimated cost**: $7.4795
