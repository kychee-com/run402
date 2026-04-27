## ADDED Requirements

### Requirement: SDK exposes deployDir on Node entry

The `@run402/sdk/node` entry point SHALL expose a `deployDir` method on the `sites` namespace that takes `{ project: string, dir: string, target?: string }` and returns the same `SiteDeployResult` shape (`{ deployment_id, url, bytes_total?, bytes_uploaded? }`) as a successful deploy.

The isomorphic `@run402/sdk` entry point SHALL NOT expose `deployDir` — it remains a Node-only capability because directory traversal depends on `node:fs/promises`, which is unavailable in V8 isolates.

#### Scenario: Node consumer deploys a directory

- **WHEN** a Node consumer calls `r402.sites.deployDir({ project: "prj_abc", dir: "./my-site" })`
- **THEN** the SDK walks the directory, hashes each file, builds a canonical content-addressed manifest, ships it via the v1.32 plan/commit transport (`POST /deploy/v1/plan`, `PUT` to presigned S3 URLs for missing bytes only, `POST /deploy/v1/commit`), and polls `GET /deployments/v1/:id` if commit returns `copying`
- **AND** returns the `{ deployment_id, url }` from the gateway response

#### Scenario: Sandbox consumer has no deployDir

- **WHEN** a V8-isolate consumer imports `Run402` from `@run402/sdk` (the isomorphic entry)
- **THEN** the `sites` namespace does NOT expose a `deployDir` method
- **AND** only `getDeployment(deploymentId)` (the public read-only call) is available on `sites`

### Requirement: Manifest entries are content-addressed with sha256, size, and content_type

`deployDir` SHALL build the manifest entry for each file from `{ path, sha256 (hex SHA-256), size (bytes), content_type (extension-mapped MIME) }`. The content-type SHALL be derived from the file extension via a static map covering common static-site assets (HTML, CSS, JS, JSON, SVG, PNG/JPG/GIF/WebP/ICO, common font formats, TXT, MD, XML, PDF, WASM); unknown extensions SHALL fall back to `application/octet-stream`. Bytes themselves SHALL NOT be included in the manifest — they are uploaded separately to the presigned S3 URLs returned by `/deploy/v1/plan` only when missing from CAS.

#### Scenario: HTML file gets text/html content_type

- **WHEN** `deployDir` walks a directory containing `index.html`
- **THEN** the manifest entry for `index.html` has `content_type: "text/html; charset=utf-8"` and a non-zero `size` and a 64-character hex `sha256`

#### Scenario: PNG file gets image/png content_type

- **WHEN** `deployDir` walks a directory containing `assets/logo.png`
- **THEN** the manifest entry for `assets/logo.png` has `content_type: "image/png"`

#### Scenario: Unknown extension falls back to octet-stream

- **WHEN** `deployDir` walks a directory containing a file with an extension not in the static map (e.g. `data.bin`)
- **THEN** the manifest entry has `content_type: "application/octet-stream"`

### Requirement: File paths in the manifest are POSIX-style and relative to dir

`deployDir` SHALL produce manifest entries whose `path` field is a POSIX-style (forward-slash) path relative to the directory root. On Windows hosts, backslashes from `path.relative` SHALL be normalized to forward slashes before being placed in the manifest.

#### Scenario: Nested file path uses forward slashes

- **WHEN** `deployDir` walks a directory containing `./assets/images/logo.png`
- **THEN** the manifest entry's `path` field is exactly `"assets/images/logo.png"`
- **AND** does not contain `./`, a leading `/`, or backslashes

#### Scenario: Windows path separators are normalized

- **WHEN** `deployDir` is invoked on Windows and walks a file at `assets\images\logo.png`
- **THEN** the manifest entry's `path` field is `"assets/images/logo.png"`

### Requirement: Default ignore list skips .git, node_modules, and .DS_Store

`deployDir` SHALL skip files and directories whose names match `.git`, `node_modules`, or `.DS_Store` at any depth in the directory tree. These entries SHALL NOT appear in the manifest.

#### Scenario: .git directory is skipped

- **WHEN** `deployDir` walks a directory tree containing a `.git/` subdirectory
- **THEN** no files under `.git/` appear in the manifest
- **AND** the traversal does not descend into `.git/`

#### Scenario: node_modules directory is skipped

- **WHEN** `deployDir` walks a directory tree containing a `node_modules/` subdirectory
- **THEN** no files under `node_modules/` appear in the manifest

#### Scenario: .DS_Store file is skipped

- **WHEN** `deployDir` walks a directory containing a `.DS_Store` file at any depth
- **THEN** that file does not appear in the manifest

### Requirement: Empty or missing directory raises a typed error

`deployDir` SHALL throw a `Run402Error` (not `process.exit`, not an untyped throw) when the directory does not exist, is not readable, or contains no deployable files after the ignore list is applied.

#### Scenario: Directory does not exist

- **WHEN** `deployDir` is called with a `dir` path that does not exist on disk
- **THEN** a `Run402Error` is thrown with a message identifying the missing path
- **AND** no network request is issued

#### Scenario: Directory contains only ignored entries

- **WHEN** `deployDir` is called on a directory whose only contents are `.git/` and `node_modules/`
- **THEN** a `Run402Error` is thrown with a message stating the directory contains no deployable files
- **AND** no network request is issued

### Requirement: Symlinks are rejected

`deployDir` SHALL throw a `Run402Error` when it encounters a symlink during traversal, identifying the offending path. Following symlinks is out of scope for this change.

#### Scenario: Symlink in the tree

- **WHEN** `deployDir` walks a directory tree that contains a symlink
- **THEN** a `Run402Error` is thrown naming the symlink path
- **AND** no network request is issued

### Requirement: Plan/commit transport handles dedup, URL refresh, and copy polling

`deployDir` SHALL upload only files reported as `missing` by `/deploy/v1/plan`; files reported as `present` (already in CAS) or `satisfied_by_plan` (covered by another entry in this same plan) SHALL NOT be re-uploaded. When a presigned URL has been held for longer than 50 minutes (under the gateway's 1-hour TTL), `deployDir` SHALL re-call `/deploy/v1/plan` to refresh URLs before continuing uploads. On HTTP 403 from S3 (expired URL), `deployDir` SHALL refresh once and retry the failed PUT. After commit, if the gateway returns `status: "copying"`, `deployDir` SHALL poll `GET /deployments/v1/:id` (initial 1 s interval, backing off to 30 s max, total cap 10 minutes) until `status` becomes `ready` or `applied`.

#### Scenario: Re-deploy of unchanged tree makes no S3 PUTs

- **WHEN** a caller invokes `deployDir` on a directory whose every file's SHA-256 already exists in CAS
- **THEN** `/deploy/v1/plan` reports every entry as `present`
- **AND** no `PUT` requests are sent to S3
- **AND** the commit returns immediately (`applied` or `noop`)

#### Scenario: Stage-2 copy polls until ready

- **WHEN** the commit response has `status: "copying"`
- **THEN** `deployDir` polls `GET /deployments/v1/:deployment_id` until `status` is `ready` or `applied`
- **AND** returns the final `{ deployment_id, url }` from the poll result

### Requirement: MCP tool deploy_site_dir exposes the helper

The MCP server SHALL register a tool named `deploy_site_dir` with input schema `{ project: string, dir: string, target?: string }`. The handler SHALL be a thin shim over `getSdk().sites.deployDir(...)` that translates `Run402Error` via the existing `mapSdkError` helper.

The existing `deploy_site` MCP tool SHALL remain registered with the same name and an inline-bytes input schema (`files: SiteFile[]`). Its handler SHALL stage the inline files into a temp directory and route through `sites.deployDir`, so all deploys ride the v1.32 plan/commit transport regardless of which entry point the agent chose.

#### Scenario: Agent invokes deploy_site_dir

- **WHEN** an MCP client calls the `deploy_site_dir` tool with `{ project, dir }`
- **THEN** the handler calls `getSdk().sites.deployDir({ project, dir })`
- **AND** returns the deployment URL in the MCP content array on success

#### Scenario: deploy_site_dir maps SDK errors

- **WHEN** `sites.deployDir` throws a `Run402Error`
- **THEN** the `deploy_site_dir` handler returns the shape produced by `mapSdkError`
- **AND** sets `isError: true` in the MCP response

### Requirement: CLI subcommand sites deploy-dir exposes the helper

The CLI SHALL accept a subcommand invoked as `run402 sites deploy-dir <path> --project <id> [--target <label>]`. The subcommand SHALL be a thin shim over `sdk.sites.deployDir(...)`, emit the JSON envelope `{ status: "ok", deployment_id, url }` on success, and call `reportSdkError` with exit code 1 on failure.

The existing `run402 sites deploy --manifest <path>` subcommand SHALL remain registered. Both `sites deploy` and `sites deploy-dir` SHALL reject `--inherit` with an explicit error message ("--inherit is removed in v1.32; the SDK now uploads only changed files automatically.") because the v1.32 plan/commit transport's CAS dedup makes the legacy `inherit` flag unnecessary.

#### Scenario: CLI deploys a directory

- **WHEN** a user runs `run402 sites deploy-dir ./my-site --project prj_abc`
- **THEN** the CLI calls `sdk.sites.deployDir({ project: "prj_abc", dir: "./my-site" })`
- **AND** writes `{ "status": "ok", "deployment_id": "...", "url": "..." }` to stdout
- **AND** exits with code 0

#### Scenario: CLI deploy-dir failure

- **WHEN** `sdk.sites.deployDir` throws a `Run402Error`
- **THEN** the CLI writes the standard JSON error envelope to stderr via `reportSdkError`
- **AND** exits with code 1

#### Scenario: CLI rejects --inherit

- **WHEN** a user runs `run402 sites deploy-dir ./my-site --project prj_abc --inherit`
- **THEN** the CLI exits with the error message "--inherit is removed in v1.32; the SDK now uploads only changed files automatically."

### Requirement: OpenClaw inherits the subcommand via CLI re-export

The OpenClaw skill SHALL expose the new subcommand via the existing `openclaw/scripts/*.mjs` re-export pattern, without duplicating implementation.

#### Scenario: OpenClaw exposes deploy-dir

- **WHEN** an OpenClaw consumer inspects the skill's available commands
- **THEN** a module under `openclaw/scripts/` corresponds to the `sites` CLI group and re-exports `run` from `cli/lib/sites.mjs`
- **AND** the behavior of `sites deploy-dir` matches the CLI exactly
