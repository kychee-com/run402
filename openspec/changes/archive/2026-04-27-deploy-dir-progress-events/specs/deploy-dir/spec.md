## ADDED Requirements

### Requirement: deployDir emits progress events via onEvent callback

`NodeSites.deployDir` SHALL accept an optional `onEvent: (event: DeployEvent) => void` field on its options object. When provided, the SDK SHALL invoke the callback synchronously at four well-defined points in the deploy lifecycle:

1. After the `POST /deploy/v1/plan` response is parsed, exactly once, with `{ phase: "plan", manifest_size: number }` where `manifest_size` is the number of files in the manifest.
2. After each file's bytes are successfully PUT to S3 (single-mode or multipart, whichever applies), with `{ phase: "upload", file: string, sha256: string, done: number, total: number }`. `total` SHALL be the count of files reported as `missing` by the plan response (i.e. files that actually need uploading). `done` SHALL be the count of files completed including this one. Files reported as `present` or `satisfied_by_plan` SHALL NOT trigger an `upload` event.
3. Immediately before `POST /deploy/v1/commit` is called, exactly once, with `{ phase: "commit" }`.
4. After each `GET /deployments/v1/:id` poll response when commit returned `status: "copying"`, with `{ phase: "poll", status: string, elapsed_ms: number }`. `status` SHALL be the gateway's latest status field; `elapsed_ms` SHALL be wall time elapsed since the first poll iteration started.

Errors thrown synchronously from the callback SHALL be caught and silently dropped. A buggy `onEvent` consumer SHALL NOT abort the deploy.

The `DeployEvent` type SHALL be exported from `@run402/sdk/node` so consumers can import it for type-safe handlers.

#### Scenario: Plan event fires once with manifest size

- **WHEN** a caller invokes `deployDir({ project, dir, onEvent })` on a directory of 5 files
- **THEN** the callback is invoked exactly once with `{ phase: "plan", manifest_size: 5 }` after `/deploy/v1/plan` returns
- **AND** the callback fires before any S3 PUT is issued

#### Scenario: Upload event fires per missing file with progress counter

- **WHEN** the plan response reports 3 of the 5 files as `missing` (the other 2 already in CAS)
- **THEN** the callback receives 3 `upload` events, each with `total: 3` and `done: 1, 2, 3` in order
- **AND** each event's `file` and `sha256` correspond to the file just uploaded
- **AND** no `upload` events fire for the 2 files reported as `present` or `satisfied_by_plan`

#### Scenario: Commit event fires before commit POST

- **WHEN** all uploads complete
- **THEN** the callback receives `{ phase: "commit" }` exactly once
- **AND** this fires before `POST /deploy/v1/commit` is sent

#### Scenario: Poll event fires per poll iteration when copying

- **WHEN** the commit response is `{ status: "copying", ... }` and Stage-2 copy takes 4 poll iterations to finish
- **THEN** the callback receives 4 `poll` events with monotonically increasing `elapsed_ms`
- **AND** each event's `status` is the gateway's reported status at that poll tick (e.g. `"copying"`, then `"ready"` on the last)

#### Scenario: Callback that throws does not break the deploy

- **WHEN** a caller passes an `onEvent` callback that throws on the first invocation
- **THEN** the deploy completes successfully and returns `{ deployment_id, url }`
- **AND** subsequent events are still attempted (each invocation is independently guarded)

#### Scenario: Existing callers without onEvent are unaffected

- **WHEN** a caller invokes `deployDir({ project, dir })` without `onEvent`
- **THEN** behavior is byte-identical to the v1.44.0 implementation
- **AND** no callback is invoked

### Requirement: CLI sites deploy-dir emits JSON-line progress events on stderr

The CLI subcommand `run402 sites deploy-dir` SHALL pass an `onEvent` callback to `sdk.sites.deployDir` that writes each event as a single newline-terminated JSON object to `stderr`. The final `{ status: "ok", deployment_id, url }` envelope SHALL continue to be written to `stdout`, so a calling agent can capture stdout for the result and stderr for the trace independently.

When `--quiet` is passed, the CLI SHALL suppress event emission (stderr stays empty for events; the final result still goes to stdout). No flag is required to enable events — they are emitted by default because the CLI is agent-first and structured stderr is non-disruptive to agents that ignore stderr.

#### Scenario: Default invocation streams events to stderr

- **WHEN** an agent runs `run402 sites deploy-dir ./site --project prj_abc` and pipes stderr to a file
- **THEN** the file contains one JSON object per line, one per event in the order they were emitted
- **AND** stdout contains exactly one line: the final `{ "status": "ok", "deployment_id": "...", "url": "..." }` envelope

#### Scenario: --quiet suppresses event lines

- **WHEN** an agent runs `run402 sites deploy-dir ./site --project prj_abc --quiet`
- **THEN** stderr contains no event lines
- **AND** stdout still contains the final result envelope

### Requirement: MCP deploy_site_dir returns event log in content array

The MCP tool `deploy_site_dir` SHALL pass an `onEvent` callback to `sdk.sites.deployDir` that buffers events into an in-memory array. On success, the tool's response `content` array SHALL include the existing URL/id text content entry plus a second text content entry containing a fenced JSON code block with the buffered events array. On `Run402Error`, the buffered events SHALL still be appended to the error response so the agent can see how far the deploy progressed before failing.

The events are emitted as a JSON array (not JSON-lines) because MCP content entries are atomic strings and a JSON array round-trips cleanly through `JSON.parse`.

#### Scenario: Successful deploy includes events in content array

- **WHEN** an MCP client calls `deploy_site_dir` with a directory of 5 files where 3 are missing
- **THEN** the response `content` has 2 entries
- **AND** the first entry contains the deployment URL text
- **AND** the second entry contains a fenced ```json``` block parseable as `[{plan}, {upload×3}, {commit}, ...]`

#### Scenario: Failed deploy includes partial event log

- **WHEN** an MCP client calls `deploy_site_dir` and the deploy fails during upload
- **THEN** the response has `isError: true`
- **AND** the response `content` includes a fenced JSON block with the events that fired before the failure (e.g. `[{plan}, {upload×1}]`)
