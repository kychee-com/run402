# org-management-client-surface Specification

## Purpose
The client surface (SDK / CLI / MCP / docs) for managing organizations: the `org_id` vocabulary (no `billing_account_id` on the client), the `r.orgs` collection + `r.org(id)` scoped-instance split (mirroring `r.project(id)`), create / get / rename / list / whoami / members / invites / audit, provisioning into an existing org via `--org`, and the typed `FREE_ORG_OWNER_LIMIT_EXCEEDED` + authorize-before-reveal surfaces. Wraps gateway v1.82 `first-class-orgs`.
## Requirements
### Requirement: Organization vocabulary on the client surface is `org_id`

The client (SDK, CLI, MCP) SHALL use `org_id` as the organization identifier across every parameter, response field, membership field, CLI positional, and tool input. The substrate names `billing_account` and `billing_account_id` SHALL NOT appear anywhere on the client surface. `OrgMembership` SHALL be `{ org_id, display_name, role, status }`.

#### Scenario: Membership shape uses org_id and display_name
- **WHEN** a caller reads a membership from `r.orgs.list()` or `r.orgs.whoami()`
- **THEN** each membership SHALL carry `org_id` and `display_name` and SHALL NOT carry `billing_account_id`

#### Scenario: No billing_account identifier on the client surface
- **WHEN** the SDK, CLI, and MCP org surfaces are scanned
- **THEN** no public parameter, type field, CLI positional, or tool input SHALL be named `billing_account_id` or `billing_account`

### Requirement: SDK exposes orgs as a collection and a scoped instance sub-client

`r.orgs` SHALL expose collection and identity operations (`create`, `list`, `whoami`). `r.org(id)` SHALL return a resource-scoped sub-client with the org id pre-bound, exposing `get`, `rename`, `members`, `invites`, and `audit`. This mirrors the existing `r.projects` / `r.project(id)` idiom.

#### Scenario: Instance operations take no repeated id argument
- **WHEN** a caller invokes `r.org(orgId).members.list()` or `r.org(orgId).audit()`
- **THEN** the call SHALL require no separate org-id argument and SHALL address the bound `orgId` in the request path

#### Scenario: A new org-instance method is guarded against drift
- **WHEN** an org-instance (org-id-bearing) method is added to the SDK without a corresponding `r.org(id)` wrapper
- **THEN** the drift guard test SHALL fail

### Requirement: Create an organization

`r.orgs.create({ displayName? })` SHALL `POST /orgs/v1` with at most a `display_name` field and SHALL return `{ org_id, display_name, tier }`. The client SHALL NOT send a `tier` at create.

#### Scenario: Create a named organization
- **WHEN** a caller invokes `r.orgs.create({ displayName: "Kychee" })`
- **THEN** the client SHALL POST `{ display_name: "Kychee" }` and return the new `{ org_id, display_name, tier }`

#### Scenario: Tier is never sent at create
- **WHEN** a caller creates an organization
- **THEN** the request body SHALL NOT contain a `tier` field

### Requirement: Get an organization

`r.org(id).get()` SHALL `GET /orgs/v1/:org_id` and return `{ org_id, display_name, tier, role }`, where `role` is the caller's role on the org.

#### Scenario: Get returns the caller's role
- **WHEN** a member calls `r.org(orgId).get()`
- **THEN** the result SHALL include the caller's `role` alongside `org_id`, `display_name`, and `tier`

### Requirement: Rename an organization

`r.org(id).rename(name | null)` SHALL `PATCH /orgs/v1/:org_id` with `{ display_name }`. Passing `null` or an empty string SHALL clear the label.

#### Scenario: Owner renames the org
- **WHEN** an owner calls `r.org(orgId).rename("New Name")`
- **THEN** the client SHALL PATCH `{ display_name: "New Name" }` and return the updated org

#### Scenario: Clearing the label
- **WHEN** a caller calls `r.org(orgId).rename(null)` (or `""`)
- **THEN** the client SHALL send a body that clears the label to `null`

### Requirement: List organizations and resolve the principal

`r.orgs.list()` SHALL `GET /orgs/v1` and return memberships of shape `{ org_id, display_name, role, status }[]`. `r.orgs.whoami()` SHALL `GET /agent/v1/whoami` and return the control-plane principal plus its memberships.

#### Scenario: List returns org memberships with labels
- **WHEN** a caller invokes `r.orgs.list()`
- **THEN** each returned membership SHALL carry `org_id`, `display_name`, `role`, and `status`

#### Scenario: whoami returns principal and memberships
- **WHEN** a caller invokes `r.orgs.whoami()`
- **THEN** the result SHALL include the resolved `principal` and every org membership carrying `org_id`

### Requirement: Manage members and invites on the scoped instance

`r.org(id).members.{list,add,setRole,revoke}` and `r.org(id).invites.{list,create,revoke}` SHALL operate on the bound org. Mutations are owner-gated server-side; the client SHALL surface the gateway's `LAST_OWNER` error when demoting or revoking the only active owner.

#### Scenario: Add a member by wallet
- **WHEN** an owner calls `r.org(orgId).members.add({ wallet, role })`
- **THEN** the client SHALL POST the member to the bound org and return the mutation result

#### Scenario: Last-owner protection is surfaced
- **WHEN** a mutation would remove or demote the org's only active owner
- **THEN** the client SHALL surface the gateway `LAST_OWNER` error unchanged

### Requirement: Read the organization audit trail

`r.org(id).audit({ limit?, before? })` SHALL `GET /orgs/v1/:org_id/audit` (admin+), returning newest-first events paged by the opaque `before` cursor.

#### Scenario: Paged audit read
- **WHEN** a caller invokes `r.org(orgId).audit({ limit: 50, before: cursor })`
- **THEN** the client SHALL request the page and return the events array

### Requirement: Provision into an existing organization

`ProvisionOptions.orgId`, `run402 provision --org <id>`, and the MCP provision tool's `org_id` SHALL send `{ org_id }` on `POST /projects/v1`. Omitting the org target SHALL send no `org_id` and preserve the cold-start request body byte-for-byte. Caller authorization (`developer`+) is gateway-enforced; the client SHALL surface the `403`. Tier is governed by the org/billing account — the shipped gateway ignores any client-supplied `tier` — so the client SHALL NOT special-case `tier` for org-targeted provisioning; `--org` simply adds `org_id`. An empty `--org` SHALL be rejected locally.

#### Scenario: Provision into a chosen org
- **WHEN** a caller provisions with `orgId` set
- **THEN** the client SHALL include `org_id` in the `POST /projects/v1` body

#### Scenario: No org target preserves cold-start
- **WHEN** a caller provisions without an org target
- **THEN** the request body SHALL NOT contain `org_id` and SHALL match the pre-existing cold-start body

#### Scenario: Tier is org-governed, not special-cased per project
- **WHEN** a caller provisions into an org
- **THEN** the client SHALL send `org_id` and SHALL NOT require or reject a `tier` — the org/billing account governs tier and the gateway ignores a client-supplied `tier`

#### Scenario: Empty org target is rejected locally
- **WHEN** a caller passes an empty `--org`
- **THEN** the CLI SHALL reject it with a local validation error rather than sending an empty `org_id`

#### Scenario: Insufficient role is surfaced
- **WHEN** a caller with only `viewer` on the org provisions into it
- **THEN** the client SHALL surface the gateway `403` unchanged

### Requirement: Cap and authorize-before-reveal errors are surfaced faithfully

The client SHALL surface `FREE_ORG_OWNER_LIMIT_EXCEEDED` (429) as a recognizable error preserving the gateway hint. For unauthorized org-id reads or renames (including a guessed-but-real id), the client SHALL surface the gateway's non-revealing denial unchanged and SHALL NOT attempt to distinguish "not found" from "forbidden".

#### Scenario: Free-org cap error is recognizable
- **WHEN** a create (or other owner-creating path) returns `FREE_ORG_OWNER_LIMIT_EXCEEDED`
- **THEN** the client SHALL surface a recognizable error preserving the gateway code and hint

#### Scenario: Non-revealing denial is passed through
- **WHEN** an unauthorized caller reads or renames an org by id
- **THEN** the client SHALL surface the gateway denial unchanged without inferring the org's existence

### Requirement: CLI and MCP parity with JSON I/O and surface sync

The CLI `run402 org` group SHALL expose `create`, `get`, `rename`, `list`, `whoami`, `member`, `invite`, and `audit` with `<org>` positionals and JSON output. MCP SHALL expose thin `create` / `get` / `rename` org tools and an `org_id` input on the provision tool. Every new SDK method SHALL be registered in the `sync.test.ts` `SURFACE` and `SDK_BY_CAPABILITY` arrays.

#### Scenario: CLI org create emits JSON
- **WHEN** a user runs `run402 org create --name "Kychee"`
- **THEN** the CLI SHALL call `r.orgs.create` and print the created org as JSON

#### Scenario: Surface sync covers the new methods
- **WHEN** the sync test runs
- **THEN** every new org/provision method SHALL be present in `SURFACE` and mapped in `SDK_BY_CAPABILITY`, with CLI/OpenClaw parity

