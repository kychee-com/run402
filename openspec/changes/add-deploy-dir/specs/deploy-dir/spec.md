## ADDED Requirements

### Requirement: SDK exposes deployDir on Node entry

The `@run402/sdk/node` entry point SHALL expose a `deployDir` method on the `sites` namespace that takes `{ project: string, dir: string, inherit?: boolean, target?: string }` and returns the same `SiteDeployResult` shape (`{ deployment_id, url }`) as the existing `sites.deploy` method.

The isomorphic `@run402/sdk` entry point SHALL NOT expose `deployDir` — it remains a Node-only capability because directory traversal depends on `node:fs/promises`, which is unavailable in V8 isolates.

#### Scenario: Node consumer deploys a directory

- **WHEN** a Node consumer calls `r402.sites.deployDir({ project: "prj_abc", dir: "./my-site" })`
- **THEN** the SDK walks the directory, reads every file, assembles a `SiteFile[]` manifest, and calls the existing `sites.deploy` method
- **AND** returns the `{ deployment_id, url }` from the server response

#### Scenario: Sandbox consumer has no deployDir

- **WHEN** a V8-isolate consumer imports `Run402` from `@run402/sdk` (the isomorphic entry)
- **THEN** the `sites` namespace does NOT expose a `deployDir` method
- **AND** `sites.deploy(files)` remains callable with an in-memory `SiteFile[]` array

#### Scenario: deployDir forwards inherit flag

- **WHEN** a caller passes `inherit: true` to `deployDir`
- **THEN** the flag is forwarded to the underlying `sites.deploy` call
- **AND** the server-side incremental-deploy behavior applies as if the caller had invoked `sites.deploy` directly with `inherit: true`

### Requirement: Binary content is auto-detected and base64-encoded

`deployDir` SHALL detect each file's encoding by attempting to decode its bytes as UTF-8 with `TextDecoder({ fatal: true })`. Files that decode successfully SHALL be added to the manifest with `encoding: "utf-8"` and their text contents. Files that fail decoding SHALL be added with `encoding: "base64"` and their base64-encoded contents.

#### Scenario: Text file is included as UTF-8

- **WHEN** `deployDir` encounters a file whose bytes are valid UTF-8 (e.g. `index.html`, `style.css`, `script.js`, `logo.svg`)
- **THEN** the manifest entry for that file has `encoding: "utf-8"` (or the encoding field omitted, matching the SDK default)
- **AND** `data` contains the file contents as a UTF-8 string

#### Scenario: Binary file is base64-encoded

- **WHEN** `deployDir` encounters a file whose bytes are NOT valid UTF-8 (e.g. `logo.png`, `photo.jpg`, `fonts/icons.woff2`)
- **THEN** the manifest entry for that file has `encoding: "base64"`
- **AND** `data` contains the base64-encoded bytes

### Requirement: File paths in the manifest are POSIX-style and relative to dir

`deployDir` SHALL produce manifest entries whose `file` field is a POSIX-style (forward-slash) path relative to the directory root. On Windows hosts, backslashes from `path.relative` SHALL be normalized to forward slashes before being placed in the manifest.

#### Scenario: Nested file path uses forward slashes

- **WHEN** `deployDir` walks a directory containing `./assets/images/logo.png`
- **THEN** the manifest entry's `file` field is exactly `"assets/images/logo.png"`
- **AND** does not contain `./`, a leading `/`, or backslashes

#### Scenario: Windows path separators are normalized

- **WHEN** `deployDir` is invoked on Windows and walks a file at `assets\images\logo.png`
- **THEN** the manifest entry's `file` field is `"assets/images/logo.png"`

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

### Requirement: MCP tool deploy_site_dir exposes the helper

The MCP server SHALL register a new tool named `deploy_site_dir` with input schema `{ project: string, dir: string, inherit?: boolean, target?: string }`. The handler SHALL be a thin shim over `getSdk().sites.deployDir(...)` that translates `Run402Error` via the existing `mapSdkError` helper.

The existing `deploy_site` tool SHALL remain unchanged in name, schema, and behavior.

#### Scenario: Agent invokes deploy_site_dir

- **WHEN** an MCP client calls the `deploy_site_dir` tool with `{ project, dir }`
- **THEN** the handler calls `getSdk().sites.deployDir({ project, dir })`
- **AND** returns the deployment URL in the MCP content array on success

#### Scenario: deploy_site_dir maps SDK errors

- **WHEN** `sites.deployDir` throws a `Run402Error`
- **THEN** the `deploy_site_dir` handler returns the shape produced by `mapSdkError`
- **AND** sets `isError: true` in the MCP response

### Requirement: CLI subcommand sites deploy-dir exposes the helper

The CLI SHALL accept a new subcommand invoked as `run402 sites deploy-dir <path> --project <id> [--inherit] [--target <label>]`. The subcommand SHALL be a thin shim over `sdk.sites.deployDir(...)`, emit the JSON envelope `{ status: "ok", deployment_id, url }` on success, and call `reportSdkError` with exit code 1 on failure.

The existing `run402 sites deploy` subcommand (which accepts `--manifest <path>`) SHALL remain unchanged.

#### Scenario: CLI deploys a directory

- **WHEN** a user runs `run402 sites deploy-dir ./my-site --project prj_abc`
- **THEN** the CLI calls `sdk.sites.deployDir({ project: "prj_abc", dir: "./my-site" })`
- **AND** writes `{ "status": "ok", "deployment_id": "...", "url": "..." }` to stdout
- **AND** exits with code 0

#### Scenario: CLI deploy-dir passes --inherit

- **WHEN** a user runs `run402 sites deploy-dir ./my-site --project prj_abc --inherit`
- **THEN** the CLI calls `sdk.sites.deployDir({ project: "prj_abc", dir: "./my-site", inherit: true })`

#### Scenario: CLI deploy-dir failure

- **WHEN** `sdk.sites.deployDir` throws a `Run402Error`
- **THEN** the CLI writes the standard JSON error envelope to stderr via `reportSdkError`
- **AND** exits with code 1

### Requirement: OpenClaw inherits the subcommand via CLI re-export

The OpenClaw skill SHALL expose the new subcommand via the existing `openclaw/scripts/*.mjs` re-export pattern, without duplicating implementation.

#### Scenario: OpenClaw exposes deploy-dir

- **WHEN** an OpenClaw consumer inspects the skill's available commands
- **THEN** a module under `openclaw/scripts/` corresponds to the `sites` CLI group and re-exports `run` from `cli/lib/sites.mjs`
- **AND** the behavior of `sites deploy-dir` matches the CLI exactly
