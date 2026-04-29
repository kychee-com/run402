## 1. Design review (gate before any implementation)

- [ ] 1.1 Circulate this change's proposal + design + four spec files to the private-repo AI for review (`kychee-com/run402-private`)
- [ ] 1.2 Cross-link with `unify-upload-primitives` review — both designs should be locked together since reconcile depends on artifact substrate
- [ ] 1.3 Collect structured answers to the seven open questions in design.md
- [ ] 1.4 T-shirt sizing per capability from backend (S/M/L/XL each for: reconcile core, describe/diff, preview environments, observability, ownership/prune, promotion, AppSpec schema)
- [ ] 1.5 Decide sequencing: which capability ships first; which are load-bearing for the others
- [ ] 1.6 Lock the AppSpec v1 schema before any SDK or backend implementation begins
- [ ] 1.7 Lock the `phase_results` / `diff` / `live_state` / `next_actions` shapes — these are agent-facing contracts that downstream tooling will couple to

## 2. Implementation phasing (becomes per-capability changes)

Each item below becomes its own `add-*` change with full proposal/design/specs/tasks once this design is reviewed and locked. The order reflects the recommended sequencing from "cheapest+safest first" to "biggest infra commitment last."

### 2a. add-app-describe-and-diff (read-only, no mutation, lowest risk)
- [ ] 2.1 `GET /v2/apps/{project}/describe?environment=...` endpoint
- [ ] 2.2 `POST /v2/apps/{project}/diff` endpoint (computes desired-vs-live diff without mutation)
- [ ] 2.3 SDK: `apps.describe`, `apps.diff`
- [ ] 2.4 MCP tools + CLI subcommands

### 2b. add-app-spec-schema (typed run402.json)
- [ ] 2.5 Publish JSON Schema for AppSpec v1 at a stable URL
- [ ] 2.6 SDK: typed `AppSpec` interface; client-side validation before network calls
- [ ] 2.7 MCP tool `validate_app_spec` for agent self-checks

### 2c. add-reconcile-engine (core mutation flow)
- [ ] 2.8 Backend: preflight engine (capability check, quota check, DNS verify, subdomain availability, checksum check)
- [ ] 2.9 Backend: phase executor with structured per-phase result ledger
- [ ] 2.10 Backend: `POST /v2/apps/{project}/reconcile` endpoint with `mode: "preview" | "apply"`
- [ ] 2.11 Backend: structured error mapper (build errors, SQL errors, etc. with file/line/column)
- [ ] 2.12 SDK: `apps.reconcile`, `apps.reconcileDir` (Node)
- [ ] 2.13 MCP tool `reconcile_app` + CLI `apps reconcile`

### 2d. add-resource-ownership-and-pruning
- [ ] 2.14 Backend: tag every resource with ownership metadata (owner, project, environment, app_spec_version, bundle_id)
- [ ] 2.15 Backend: drift detection (compare live state to head bundle's desired state)
- [ ] 2.16 Backend: prune executor — only deletes `owner: "reconcile"` resources
- [ ] 2.17 SDK + MCP + CLI: surface `drift` in describe / reconcile responses

### 2e. add-preview-environments
- [ ] 2.18 Backend: environment dimension on resource tables
- [ ] 2.19 Backend: subdomain prefix scheme for previews
- [ ] 2.20 Backend: function instance isolation per environment
- [ ] 2.21 Backend: environment-scoped secrets (override project-level)
- [ ] 2.22 Backend: `apps.retire({ environment })` endpoint
- [ ] 2.23 (Optional / tier-gated) preview DB branching infrastructure
- [ ] 2.24 SDK + MCP + CLI: `environment` parameter on all relevant calls

### 2f. add-app-observability
- [ ] 2.25 Backend: bundle-scoped log aggregation (filterable by bundle_id, function_version, request_id, trace_id)
- [ ] 2.26 Backend: deployment event store + SSE streaming
- [ ] 2.27 Backend: source-map preservation in function bundling
- [ ] 2.28 Backend: health-check executor for `verify` block
- [ ] 2.29 SDK: `apps.events`, `apps.logs`, `apps.health` with async iteration
- [ ] 2.30 MCP + CLI: corresponding tools

### 2g. add-app-promotion
- [ ] 2.31 Backend: atomic environment-head swap with multi-resource transaction
- [ ] 2.32 Backend: promotion preflight (DB head compatibility, subdomain conflicts, custom domain conflicts)
- [ ] 2.33 SDK: `apps.promote`
- [ ] 2.34 MCP + CLI: `promote_app` tool / `apps promote` subcommand

### 2h. add-projects-capabilities
- [ ] 2.35 Backend: `GET /v2/projects/{project}/capabilities` endpoint
- [ ] 2.36 SDK: `projects.capabilities` returning typed feature flags + limits
- [ ] 2.37 MCP + CLI: corresponding tool/subcommand

## 3. Cross-cutting work

- [ ] 3.1 SDK: typed schemas for `AppSpec`, `EnvironmentName`, `OwnershipTag`, `PhaseResults`, `Diff`, `LiveState`, `NextAction`
- [ ] 3.2 SDK: type-generation pipeline so backend schema changes flow into SDK types
- [ ] 3.3 Documentation: SKILL.md + CLAUDE.md restructured around the reconcile motion
- [ ] 3.4 Documentation: agent recipe book — preview→verify→promote, partial-failure repair, drift inspection, etc.
- [ ] 3.5 Documentation: AppSpec v1 reference page + JSON Schema viewer

## 4. Validation and measurement

- [ ] 4.1 E2E: agent reconciles a preview, verifies, promotes to production. Full loop in <30 seconds for a typical app.
- [ ] 4.2 E2E: partial-failure recovery — migration succeeds, function build fails. Agent reads `phase_results`, fixes the function, reconciles again, succeeds. No DB rollback needed.
- [ ] 4.3 E2E: drift detection — manual `functions.deploy` followed by reconcile shows the drift in `live_state.drift`, doesn't delete it.
- [ ] 4.4 Measure: agent iteration latency (edit → reconcile → healthy) for typical app size. Target < 5 seconds for noop redeploys.
- [ ] 4.5 Measure: % of reconcile calls that result in `noop`, `applied`, `partial`, `blocked`. Track over time.
- [ ] 4.6 Measure: agent self-correction success rate after `partial` or `blocked` (does the agent recover using `next_actions`?).
- [ ] 4.7 Publish post-hoc retrospective: did the reconcile-first design hold up vs. the original deploy-first surface?
