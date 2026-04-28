## MODIFIED Requirements

### Requirement: SDK exposes deployDir on Node entry

The `@run402/sdk/node` entry point SHALL expose a `deployDir` method on the `sites` namespace that takes `{ project: string, dir: string, target?: string, onEvent?: (event: DeployEvent) => void }` and returns the same `SiteDeployResult` shape (`{ deployment_id, url, bytes_total?, bytes_uploaded? }`) as a successful deploy.

The implementation SHALL be a thin wrapper that delegates to the canonical `deploy.apply` primitive (defined by the `unified-deploy` capability):

```ts
async deployDir({ project, dir, target, onEvent }) {
  return r.deploy.apply(
    { project, site: { replace: fileSetFromDir(dir) } },
    { onEvent }
  ).then(shapeAsSiteDeployResult);
}
```

The isomorphic `@run402/sdk` entry point SHALL NOT expose `deployDir` — it remains a Node-only convenience because directory traversal depends on `node:fs/promises`, which is unavailable in V8 isolates. Isomorphic callers use `r.deploy.apply` directly with in-memory byte sources.

#### Scenario: Node consumer deploys a directory

- **WHEN** a Node consumer calls `r.sites.deployDir({ project: "prj_abc", dir: "./my-site" })`
- **THEN** the SDK delegates to `r.deploy.apply({ project, site: { replace: fileSetFromDir("./my-site") } })`
- **AND** all bytes travel via the unified `cas-content` transport (`POST /content/v1/plans` + presigned S3 PUTs) and the `unified-deploy` plan/commit endpoints (`POST /deploy/v2/plans` + commit)
- **AND** the agent-observable result is `{ deployment_id, url }` from the activated release

#### Scenario: Sandbox consumer has no deployDir

- **WHEN** a V8-isolate consumer imports `Run402` from `@run402/sdk` (the isomorphic entry)
- **THEN** the `sites` namespace does NOT expose a `deployDir` method
- **AND** isomorphic callers use `r.deploy.apply({ site: { replace: files({...}) } })` with in-memory byte sources

### Requirement: Plan/commit transport handles dedup, URL refresh, and copy polling

`deployDir` SHALL upload only files reported as `missing` by the unified content service (`POST /content/v1/plans`); files reported as already-present in the project's CAS SHALL NOT be re-uploaded. Within-deploy duplicate paths (same SHA, multiple paths) SHALL be uploaded once.

The SDK SHALL refresh presigned URLs before TTL expires (50 minutes under the gateway's 1-hour TTL) by re-calling `POST /content/v1/plans` for any remaining missing entries. On HTTP 403 from S3 (expired URL), the SDK SHALL refresh once and retry the failed PUT.

After commit, if the deploy operation is not immediately `ready`, the SDK SHALL poll `GET /deploy/v2/operations/:id` (initial 1 s interval, backing off to 30 s max, total cap 10 minutes) until the operation reaches a terminal state (`ready` or `failed`).

#### Scenario: Re-deploy of unchanged tree makes no S3 PUTs

- **WHEN** a caller invokes `deployDir` on a directory whose every file's SHA-256 already exists in the project's CAS
- **THEN** `POST /content/v1/plans` reports an empty `missing` list
- **AND** no `PUT` requests are sent to S3
- **AND** the commit returns immediately with the new release activated

#### Scenario: Stage-2 copy polls until ready

- **WHEN** the commit response indicates the operation is still `running` (site copy not yet complete)
- **THEN** `deployDir` polls `GET /deploy/v2/operations/:id` until `status` is `ready`
- **AND** returns the final `{ deployment_id, url }` from the activated release

### Requirement: deployDir emits progress events via onEvent callback

`NodeSites.deployDir` SHALL accept an optional `onEvent: (event: DeployEvent) => void` field on its options object. When provided, the callback SHALL receive the structured event envelope defined by the `unified-deploy` capability (`plan.started`, `plan.diff`, `content.upload.progress`, `content.upload.skipped`, `commit.phase`, `ready`, etc.).

For backward compatibility, `deployDir` SHALL also synthesize the legacy v1.32 event shapes (`{ phase: "plan", manifest_size }`, `{ phase: "upload", file, sha256, done, total }`, `{ phase: "commit" }`, `{ phase: "poll", status, elapsed_ms }`) and emit them alongside the new shapes for one minor release cycle. Existing event consumers SHALL continue to receive their expected payloads during the deprecation window.

After the deprecation window, only the unified `DeployEvent` shapes SHALL be emitted. Consumers using the legacy `phase` field SHALL migrate to the discriminated `type` field.

Errors thrown synchronously from the callback SHALL be caught and silently dropped.

#### Scenario: New event shapes fire alongside legacy shapes during compat window

- **WHEN** a caller invokes `deployDir({ project, dir, onEvent })` against a directory of 5 files where 3 are missing
- **THEN** the callback receives both the unified events (`plan.started`, `plan.diff`, `content.upload.progress` ×3, `commit.phase` series, `ready`) AND the legacy events (`{ phase: "plan", manifest_size: 5 }`, `{ phase: "upload", ... }` ×3, `{ phase: "commit" }`)

#### Scenario: Existing legacy-only consumers still work

- **WHEN** a caller's `onEvent` switches on `event.phase` only (legacy v1.32 pattern)
- **THEN** the deploy completes successfully and the legacy phase events fire as expected
- **AND** the caller is not broken by the addition of unified event shapes

### Requirement: CLI subcommand sites deploy-dir exposes the helper

The CLI SHALL accept a subcommand invoked as `run402 sites deploy-dir <path> --project <id> [--target <label>]`. The subcommand SHALL be a thin shim over `sdk.sites.deployDir(...)`, emit the JSON envelope `{ status: "ok", deployment_id, url }` on success, and call `reportSdkError` with exit code 1 on failure.

The existing `run402 sites deploy --manifest <path>` subcommand SHALL remain registered and route through the same unified path. Both `sites deploy` and `sites deploy-dir` SHALL reject `--inherit` with an explicit error message: "--inherit is removed; deploy.apply uses patch semantics — use `run402 deploy --patch` for partial updates."

#### Scenario: CLI deploys a directory

- **WHEN** a user runs `run402 sites deploy-dir ./my-site --project prj_abc`
- **THEN** the CLI calls `sdk.sites.deployDir({ project: "prj_abc", dir: "./my-site" })`
- **AND** writes `{ "status": "ok", "deployment_id": "...", "url": "..." }` to stdout
- **AND** exits with code 0

#### Scenario: CLI rejects --inherit with the new message

- **WHEN** a user runs `run402 sites deploy-dir ./my-site --project prj_abc --inherit`
- **THEN** the CLI exits with code 1 and writes the error: "--inherit is removed; deploy.apply uses patch semantics — use `run402 deploy --patch` for partial updates."

## REMOVED Requirements

### Requirement: Manifest entries are content-addressed with sha256, size, and content_type

**Reason:** Subsumed by the `unified-deploy` capability's content-ref normalization. The `deploy.apply` primitive accepts polymorphic byte sources and normalizes them into ContentRef objects internally; `deployDir` no longer constructs a deploy-specific manifest. The `cas-content` capability owns the content-ref shape (sha256 + size + content_type).

**Migration:** Implementation moves to `fileSetFromDir(path)` in `@run402/sdk/node`, which produces a `FileSet` (a `Record<string, ContentRef>`-equivalent) consumed by `deploy.apply`. The agent-observable result is identical (correct content types are still derived from extensions); the spec lives with the consumer of the helper, not the helper itself.

### Requirement: File paths in the manifest are POSIX-style and relative to dir

**Reason:** Subsumed by `unified-deploy` and `fileSetFromDir`. Path normalization is a property of the `fileSetFromDir` helper, not a deploy-dir-specific contract; the `unified-deploy` capability's `FileSet` contract defines the canonical path shape.

**Migration:** No caller-visible change. POSIX-style relative paths remain the canonical shape consumed by `deploy.apply`.

### Requirement: Default ignore list skips .git, node_modules, and .DS_Store

**Reason:** Moved into `fileSetFromDir(path)` in `@run402/sdk/node`. The ignore list is a Node-helper concern, not a deploy-protocol concern.

**Migration:** Behavior unchanged for callers using `deployDir` or `fileSetFromDir`. Direct callers of `deploy.apply` who construct their own `FileSet` are responsible for omitting unwanted entries.

### Requirement: Empty or missing directory raises a typed error

**Reason:** Moved into `fileSetFromDir(path)`.

**Migration:** Behavior unchanged.

### Requirement: Symlinks are rejected

**Reason:** Moved into `fileSetFromDir(path)`.

**Migration:** Behavior unchanged.

### Requirement: MCP tool deploy_site_dir exposes the helper

**Reason:** Folded into the broader MCP `deploy` tool surface defined by the `unified-deploy` capability. The MCP server retains a `deploy_site_dir` tool name during the deprecation window for compatibility, but its handler is a thin shim over `getSdk().deploy.apply({ project, site: { replace: fileSetFromDir(dir) } })`. After the window, the canonical tool name is `deploy` (covering all resources) and `deploy_site_dir` is removed.

**Migration:** Existing agents calling `deploy_site_dir` see no behavior change during the window. Migrate to `deploy` for new integrations.

### Requirement: OpenClaw inherits the subcommand via CLI re-export

**Reason:** OpenClaw continues to re-export from CLI per the unchanged re-export pattern. The capability statement is preserved by `unified-deploy`'s CLI requirements; restating it under `deploy-dir` is redundant.

**Migration:** None — re-export pattern continues to apply automatically to whatever CLI subcommands exist.

### Requirement: CLI sites deploy-dir emits JSON-line progress events on stderr

**Reason:** Subsumed by `unified-deploy`'s structured event surface. The CLI's `--quiet` flag and JSON-line stderr behavior are CLI conventions that apply uniformly across all deploy paths and belong with the `unified-deploy` capability's CLI requirements.

**Migration:** Behavior preserved by the unified spec.

### Requirement: MCP deploy_site_dir returns event log in content array

**Reason:** Subsumed by `unified-deploy`'s MCP tool requirements. The buffered-events-in-content-array convention applies uniformly across the unified `deploy` MCP tool.

**Migration:** Behavior preserved by the unified spec.
