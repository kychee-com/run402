## ADDED Requirements

### Requirement: apps.events streams deployment lifecycle events

The platform SHALL expose `apps.events({ project, bundleId?, environment?, since?, until?, limit? })` returning deployment lifecycle events: phase transitions, individual function build/start, custom domain DNS state changes, health check results, drift detection events. Events SHALL be retrievable both as a paginated list and as a Server-Sent Events stream.

#### Scenario: Agent watches a reconcile in progress

- **WHEN** an agent calls `apps.events({ bundleId, stream: true })` immediately after a reconcile started
- **THEN** the response is an event stream emitting events like `phase.preflight.complete`, `phase.migrations.applied`, `phase.functions.item.deployed`, `phase.site.uploaded`, `phase.health.check.passed` in order

#### Scenario: Agent retrieves historical events

- **WHEN** an agent calls `apps.events({ bundleId, since, until })`
- **THEN** the response is a paginated list of events for that bundle in the time window

### Requirement: apps.logs returns bundle-scoped logs

The platform SHALL expose `apps.logs({ project, bundleId?, function_name?, request_id?, environment?, since?, until?, filter?, limit?, cursor? })` returning logs scoped to a specific bundle, function, request, or environment. When `bundleId` is specified, logs SHALL include only invocations of function versions deployed by that bundle.

#### Scenario: Logs filtered by bundle ID

- **WHEN** an agent calls `apps.logs({ bundleId: "bundle_abc" })`
- **THEN** the response includes logs only from function invocations whose `function_version` matches a function deployed in `bundle_abc`

#### Scenario: Logs filtered by request ID for tracing a specific failure

- **WHEN** a function invocation returned `request_id: "req_xyz"` in an error response
- **AND** an agent calls `apps.logs({ request_id: "req_xyz" })`
- **THEN** the response includes all log entries from that invocation across the function and any downstream calls within the same trace

#### Scenario: Logs include structured metadata

- **WHEN** logs are returned
- **THEN** each entry includes `timestamp`, `level`, `message`, `function_name`, `function_version`, `bundle_id`, `request_id`, `trace_id`, optional `attributes` map

### Requirement: apps.health runs verify probes against an environment

The platform SHALL expose `apps.health({ project, environment })` that runs the AppSpec's `verify` block (or default health checks) against the named environment and returns structured pass/fail results. The same shape SHALL appear in reconcile responses when `waitFor: "healthy"` is used.

#### Scenario: Health check for production

- **WHEN** an agent calls `apps.health({ project, environment: "production" })`
- **THEN** the response includes `status: "ok" | "degraded" | "failed"` plus a per-check array with `type`, `target`, `status`, `latency_ms`, optional `detail`

#### Scenario: Health check failure includes actionable detail

- **WHEN** a health check `{ path: "/", expectStatus: 200 }` returns 500
- **THEN** the check entry includes the actual status, response body excerpt (truncated), and `next_actions` pointing at `apps.logs` for the request

### Requirement: invoke and reconcile responses carry trace_id and request_id

All function invocation responses (`functions.invoke`) SHALL include a `request_id` and a `trace_id`. All reconcile responses SHALL include a `trace_id` correlating preflight + phase events + health checks within the same operation.

#### Scenario: Invoke response includes trace correlation

- **WHEN** a function is invoked via `functions.invoke` (or HTTP routing)
- **THEN** the response includes `request_id` (per-invocation) and `trace_id` (correlates retries, downstream invocations)

#### Scenario: Reconcile trace_id correlates events and logs

- **WHEN** a reconcile returns `trace_id: "trc_abc"`
- **AND** an agent calls `apps.events({ trace_id: "trc_abc" })` or `apps.logs({ trace_id: "trc_abc" })`
- **THEN** the response includes only events/logs from that reconcile operation

### Requirement: Function build and bundle outputs include source maps

When a function is deployed via reconcile (or direct artifact upload) with bundled code, the platform SHALL preserve source maps and SHALL surface them in error responses. Stack traces in logs SHALL be source-map-resolved when possible, pointing at the agent's source files (e.g. `functions/webhook/index.ts:41`) rather than the bundled artifact (`bundle.js:9832`).

#### Scenario: Bundled function crashes; log shows source-mapped trace

- **WHEN** a function bundled from `functions/webhook/index.ts` throws an error at line 41 of the source
- **THEN** the corresponding log entry's stack trace points at `functions/webhook/index.ts:41`, not the bundled file

### Requirement: Logs and events support cursor-based pagination

All list endpoints (`apps.events`, `apps.logs`, `apps.list`, `bundles.list`) SHALL return cursor-based pagination. SDK clients SHALL expose async iteration helpers that walk all pages transparently.

#### Scenario: Iterate all logs for a bundle

- **WHEN** an agent calls `apps.logs({ bundleId })` and there are more results than the page size
- **THEN** the response includes `next_cursor`
- **AND** the SDK exposes `for await (const entry of r402.apps.logs({ bundleId }))` semantics that walk all pages
