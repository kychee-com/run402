# project-read-client-surface Specification

## Purpose
TBD - created by archiving change add-project-read-client-surface. Update Purpose after archive.
## Requirements
### Requirement: SDK exposes an authoritative single-project read

`r.projects.get(id)` SHALL issue `GET /projects/v1/:project_id` using the default credential (wallet SIWX or control-plane session) and SHALL return a typed `ProjectDetail`. The call SHALL NOT require the project to be present in the local keystore and SHALL NOT send or require project keys.

#### Scenario: Get returns the authoritative server detail
- **WHEN** a caller invokes `r.projects.get("prj_123")`
- **THEN** the client SHALL `GET /projects/v1/prj_123` and return a `ProjectDetail` parsed from the response body

#### Scenario: Works for a project absent from the local keystore
- **WHEN** a caller invokes `r.projects.get(id)` for a project the credential is authorized to read but which is not stored locally
- **THEN** the call SHALL succeed without a prior `getProject(id)` lookup and SHALL NOT throw `ProjectNotFound` for the local miss

### Requirement: ProjectDetail names the full server view and carries no secrets

`ProjectDetail` SHALL expose the wire fields with faithful snake_case names: `project_id`, `public_id`, `name`, `org_id`, `tier`, `effective_status`, `organization_lifecycle_state`, `site_url` (`string | null`), `custom_domains` (`string[]`), `last_deploy` (`{ release_id, activated_at } | null`), `mailbox` (`string[]`), `usage` (`{ api_calls, storage_bytes, api_calls_limit, storage_bytes_limit }`), and `created_at`. The type SHALL NOT contain `anon_key`, `service_key`, or any other secret, and the client SHALL NOT synthesize key material into it.

#### Scenario: All authoritative fields are surfaced
- **WHEN** a caller reads a `ProjectDetail`
- **THEN** it SHALL carry `effective_status`, `organization_lifecycle_state`, `org_id`, `tier`, `last_deploy`, `mailbox`, and `usage` with its four counter/limit numbers

#### Scenario: No key material in the detail
- **WHEN** the `ProjectDetail` type and the value returned by `r.projects.get(id)` are inspected
- **THEN** neither SHALL contain `anon_key`, `service_key`, or any secret field

#### Scenario: Explicit null is preserved, not dropped
- **WHEN** the server returns `site_url: null` or `last_deploy: null`
- **THEN** the parsed `ProjectDetail` SHALL carry those keys as `null` rather than omitting them

### Requirement: The read is authorize-before-reveal with no existence oracle

When the gateway returns `403` for `GET /projects/v1/:project_id` — whether the caller is unauthorized or the project was deleted/archived after authorization — the SDK SHALL surface `Unauthorized` and SHALL NOT translate the response into `ProjectNotFound`. A caller without authority SHALL NOT be able to distinguish "exists but not yours" from "absent".

#### Scenario: Unauthorized caller receives Unauthorized
- **WHEN** `r.projects.get(id)` is called for a project the credential is not authorized to read
- **THEN** the SDK SHALL throw `Unauthorized` (carrying the gateway envelope) and SHALL NOT throw `ProjectNotFound`

#### Scenario: 403 is never rewritten to not-found
- **WHEN** the gateway responds `403` to the authoritative read
- **THEN** the client SHALL NOT convert it to a `404`/`ProjectNotFound` shape in any surface (SDK, MCP, CLI)

### Requirement: Scoped client exposes `get()` and is drift-guarded

`(await r.project(id)).projects.get()` SHALL return the authoritative `ProjectDetail` for the bound id, addressing it without a separate id argument, mirroring the existing scoped `.projects.info()` / `.projects.rename()` shape (the project-scoped methods live on the `ScopedProjects` sub-namespace). The `scoped.test.ts` drift guard SHALL require a wrapper for this method.

#### Scenario: Scoped get takes no id argument
- **WHEN** a caller invokes `(await r.project("prj_123")).projects.get()`
- **THEN** the call SHALL `GET /projects/v1/prj_123` with no separately supplied id

#### Scenario: A project-id-bearing method without a wrapper fails the drift guard
- **WHEN** a project-id-bearing namespace method is added to the SDK without a corresponding `r.project(id)` wrapper
- **THEN** the drift guard test SHALL fail

### Requirement: Local `info` and `keys` remain offline and unchanged

`r.projects.info(id)` and `r.projects.keys(id)` — and their MCP (`project_info`, `project_keys`) and CLI (`projects info`, `projects keys`) surfaces — SHALL continue to read local keystore state with no API call. The new authoritative `get` SHALL NOT replace, rewire, or remove them.

#### Scenario: info and keys make no API call
- **WHEN** `r.projects.info(id)` or `r.projects.keys(id)` is invoked
- **THEN** no HTTP request SHALL be issued and the result SHALL be assembled from local keystore state

#### Scenario: Local key access is unaffected by the new read
- **WHEN** the project-read change ships
- **THEN** `project_keys` / `projects keys` SHALL still return `{ anon_key, service_key }` from local state

### Requirement: Agent surfaces expose the authoritative read

A `project_get` MCP tool and a `run402 projects get <id>` CLI subcommand SHALL surface the authoritative read; OpenClaw SHALL inherit it via the existing `projects` re-export. The CLI subcommand SHALL emit JSON. The `SURFACE` mapping SHALL include `project_get` → `projects.get` at endpoint `GET /projects/v1/:project_id`, with a `SDK_BY_CAPABILITY` entry and no orphaned SDK method.

#### Scenario: MCP project_get renders the detail
- **WHEN** the `project_get` MCP tool is invoked with `{ project_id }`
- **THEN** it SHALL call `r.projects.get(project_id)` and render the `ProjectDetail`, mapping SDK errors through the shared error helper

#### Scenario: CLI projects get emits JSON
- **WHEN** `run402 projects get prj_123` runs
- **THEN** it SHALL print the `ProjectDetail` as JSON to stdout and exit non-zero with an error envelope on failure

#### Scenario: Surface mapping is complete and parity holds
- **WHEN** `sync.test.ts` runs
- **THEN** `project_get` SHALL appear in `SURFACE` mapped to `projects.get`, the CLI and OpenClaw command sets SHALL both include `projects:get`, and the orphan check SHALL pass

