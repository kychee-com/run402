# release-spec-authoring-dx Specification

## Purpose
TBD - created by archiving change reduce-agent-deploy-friction. Update Purpose after archive.
## Requirements
### Requirement: ReleaseSpec JSON Schema Is Published

Run402 SHALL publish a versioned JSON Schema for the unified deploy manifest at `https://run402.com/schemas/release-spec.v1.json`.

The schema SHALL cover the complete author-facing deploy manifest accepted by `run402 deploy apply --manifest`, stdin manifests, MCP-compatible manifest JSON, and `loadDeployManifest()` / `normalizeDeployManifest()`. It SHALL include top-level `project`, `project_id`, `$schema`, `base`, `database`, `secrets`, `functions`, `site`, `subdomains`, `routes`, and `checks` where those fields are accepted by manifest adapters.

The schema SHALL distinguish authoring-only metadata from deploy state. `$schema` SHALL be accepted only as top-level metadata and SHALL NOT be sent to `/deploy/v2/plans`.

The schema SHALL document known static cache classes `html`, `immutable_versioned`, and `revalidating_asset`, while preserving the SDK contract that unknown future cache-class strings remain representable unless the gateway rejects them.

#### Scenario: Editor validates a complete deploy manifest

- **WHEN** an authoring manifest declares `$schema: "https://run402.com/schemas/release-spec.v1.json"` and includes database migrations, value-free secrets, functions, site public paths, routes, and subdomains
- **THEN** an editor using the schema SHALL provide validation and autocomplete for those fields
- **AND** the manifest adapter SHALL strip `$schema` before producing the SDK-native `ReleaseSpec`

#### Scenario: Unknown manifest typo is still rejected

- **WHEN** a manifest contains `$schema` and an unrelated typo such as `site.replcae`
- **THEN** the manifest adapter and deploy validation SHALL reject `site.replcae`
- **AND** accepting `$schema` SHALL NOT relax unknown-field validation for any other field

### Requirement: FunctionSpec Authoring Shape Is Explicit

Agent-facing SDK and CLI documentation SHALL expand the canonical `FunctionSpec` shape used under `functions.replace[name]` and `functions.patch.set[name]`.

The docs and schema SHALL show that `runtime`, `source`, `files`, `entrypoint`, `config`, and `schedule` are sibling fields of the function entry. `config.timeoutSeconds` and `config.memoryMb` SHALL live under `config`. `schedule` SHALL live directly under the function entry, not under `config`.

The docs SHALL explain that `source` accepts the same byte-source authoring shapes as site files in manifest JSON, including `{ data, encoding?, contentType? }` and Node manifest `{ path, contentType? }` entries. If `files` is used, docs SHALL explain that `entrypoint` is required.

The docs SHALL state the current unified-deploy support status for npm `deps`. If deploy-v2 supports function dependencies, `deps` SHALL be documented and schematized as a sibling of `schedule`. If deploy-v2 does not support dependencies, docs and schema SHALL explicitly reject `deps` and tell authors to bundle dependencies into source or use the non-unified function deploy surface.

#### Scenario: Scheduled function is authored atomically

- **WHEN** a manifest contains `functions.replace.digest.schedule: "0 9 * * 1"`
- **THEN** the schema and docs SHALL identify that shape as the canonical place for a scheduled function cron expression
- **AND** deploy validation SHALL NOT require a post-deploy `functions update` call merely to set the schedule

#### Scenario: Function config nesting is unambiguous

- **WHEN** a manifest contains `functions.replace.api.config.timeoutSeconds: 10` and `functions.replace.api.config.memoryMb: 256`
- **THEN** the schema and docs SHALL mark both fields as valid function config
- **AND** `functions.replace.api.config.schedule` SHALL be rejected or documented as invalid

#### Scenario: Dependency support status is explicit

- **WHEN** an agent reads `llms-cli.txt` or `llms-sdk.txt` to author a unified deploy function with npm packages
- **THEN** it SHALL learn either the exact `deps` field location if supported or a clear statement that deploy-v2 manifests do not accept `deps`
- **AND** the schema SHALL match that documented behavior

### Requirement: ReleaseSpec Docs Cover Strictness Traps

Agent-facing deploy documentation SHALL include the schema URL and shall document common strict-validation traps that cause full deploy rejection before plan/upload.

At minimum, docs SHALL cover:

- `project_id` is accepted by CLI/MCP-style manifest adapters and normalized to SDK `project`.
- Raw SDK `ReleaseSpec` uses `project`, not `project_id`.
- `subdomains.set`, `subdomains.add`, and `subdomains.remove` semantics and whether `set` can coexist with `add` or `remove`.
- `site.public_paths.replace[*].cache_class` known values and future-string handling.
- top-level absence means carry forward base state, while resource-specific replace/patch shapes change or clear resource state.
- `$schema` is authoring metadata and is stripped before planning.

#### Scenario: Agent avoids subdomain ambiguity

- **WHEN** an agent reads deploy docs before writing a manifest with `subdomains`
- **THEN** the docs SHALL state whether `subdomains.set` is mutually exclusive with `subdomains.add` and `subdomains.remove`
- **AND** examples SHALL use only valid combinations

#### Scenario: Cache class values are findable

- **WHEN** an agent writes `site.public_paths.replace["/events"].cache_class`
- **THEN** docs SHALL list the known values `html`, `immutable_versioned`, and `revalidating_asset`
- **AND** docs SHALL tell agents to preserve unknown future strings returned by observability APIs

### Requirement: Policy Trigger Semantics Are Auditable

Agent-facing auth/expose policy documentation SHALL document the exact generated trigger behavior for `force_owner_on_insert: true`.

The docs SHALL state whether the generated `BEFORE INSERT` trigger always overwrites the configured `owner_column` or sets it only when the inserted value is null. The docs SHALL state whether the trigger fires for `service_role` inserts, and what happens when `auth.uid()` is null. The docs SHALL include the generated SQL shape or a faithful SQL excerpt sufficient to audit the trigger condition and assignment.

#### Scenario: Service-role seed behavior is predictable

- **WHEN** a user plans to insert seed rows with a service key and enables `force_owner_on_insert`
- **THEN** docs SHALL explain whether the trigger runs under service-role inserts
- **AND** docs SHALL explain whether a null `auth.uid()` is skipped, written, or rejected by constraints

#### Scenario: Client-supplied owner value behavior is predictable

- **WHEN** a browser insert includes an explicit owner-column value while `force_owner_on_insert` is true
- **THEN** docs SHALL explain whether the generated trigger overwrites that value or only fills missing values
- **AND** docs SHALL show the SQL condition responsible for that behavior

### Requirement: Tier Function Caps Are Documented With Deploy Authoring

Agent-facing SDK and CLI deploy documentation SHALL list tier-specific function caps relevant to release authoring.

At minimum, docs SHALL cover max function timeout, max function memory, max scheduled functions, and minimum cron interval for the tiers returned by `run402 tier status` or the tier quote surface.

#### Scenario: Prototype timeout cap is discoverable

- **WHEN** a user on prototype tier reads deploy or tier docs before setting `functions.replace.api.config.timeoutSeconds`
- **THEN** they SHALL see the maximum timeout for that tier
- **AND** they SHALL NOT have to learn the cap only from an activation-time gateway error

