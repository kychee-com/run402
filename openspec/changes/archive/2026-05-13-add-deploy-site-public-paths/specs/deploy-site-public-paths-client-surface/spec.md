## ADDED Requirements

### Requirement: SDK models site public path authoring

The SDK SHALL model `ReleaseSpec.site.public_paths` as the canonical client-facing authoring surface for static browser URLs.

`SitePublicPathsSpec` SHALL support `mode: "implicit" | "explicit"`. `mode: "explicit"` SHALL require a complete `replace` table keyed by public browser paths such as `/events`, where each value is `PublicStaticPathSpec` with `asset: string` and optional `cache_class?: StaticCacheClass`. `mode: "implicit"` SHALL restore filename-derived public reachability and SHALL NOT accept a `replace` table.

`SiteSpec` SHALL allow `public_paths` alongside `replace`, alongside `patch`, or as the only site field. `site.replace` and `site.patch` SHALL remain mutually exclusive.

#### Scenario: Explicit public path table is typeable

- **WHEN** TypeScript code constructs a `ReleaseSpec` with `site.replace` containing `events.html`
- **AND** `site.public_paths` is `{ mode: "explicit", replace: { "/events": { asset: "events.html", cache_class: "html" } } }`
- **THEN** the code SHALL compile using public SDK types
- **AND** `cache_class` SHALL use the SDK's existing static cache class type

#### Scenario: Implicit mode is typeable

- **WHEN** TypeScript code constructs a `ReleaseSpec` with `site.public_paths: { mode: "implicit" }`
- **THEN** the code SHALL compile using public SDK types
- **AND** the type SHALL NOT require `site.replace` or `site.patch`

#### Scenario: Public path only site spec is deployable

- **WHEN** a caller passes `ReleaseSpec` with only `project` and `site.public_paths`
- **THEN** SDK no-op validation SHALL treat the spec as deployable content
- **AND** no gateway request SHALL be skipped merely because no site file bytes changed

### Requirement: SDK validates public path shape before deploy planning

The SDK SHALL reject malformed `site.public_paths` object shapes before hashing, upload planning, or calling `/deploy/v2/plans`.

Local validation SHALL reject unknown `site` fields, unknown `public_paths` fields, unsupported `mode` values, explicit mode without a `replace` object, implicit mode with a `replace` object, non-object public path entries, missing or non-string `asset`, and unknown public path entry fields.

Public path string canonicalization, duplicate canonical paths, internal namespace rejection, asset existence, sticky explicit-mode inheritance, widened-reachability warnings, and route/static conflicts SHALL remain gateway-authoritative.

#### Scenario: Unknown public path fields fail locally

- **WHEN** a caller deploys `site.public_paths` with an unknown field such as `patch`
- **THEN** the SDK SHALL throw `Run402DeployError` with `code: "INVALID_SPEC"` before network calls
- **AND** the error resource SHALL identify the offending public-path field

#### Scenario: Explicit mode requires replace map

- **WHEN** a caller deploys `site.public_paths: { mode: "explicit" }`
- **THEN** the SDK SHALL reject the spec before upload or planning
- **AND** the error SHALL tell the caller to provide a complete `public_paths.replace` map

#### Scenario: Semantic path errors remain gateway errors

- **WHEN** a caller deploys a syntactically valid public path table whose keys later fail gateway canonicalization
- **THEN** the SDK SHALL preserve the gateway `Run402DeployError` body and code
- **AND** the SDK SHALL NOT rewrite the error into a client-only validation code

### Requirement: SDK normalization preserves public path declarations

The SDK deploy normalizer SHALL preserve `site.public_paths` in the normalized release spec while converting `site.replace` and `site.patch.put` byte sources into `ContentRef` objects.

`public_paths.replace` entries SHALL NOT enter CAS upload planning because they reference release static asset paths rather than byte sources. The normalized plan body SHALL include `public_paths` exactly under `site`.

#### Scenario: Replace files normalize while public paths pass through

- **WHEN** `r.deploy.plan` receives `site.replace` with inline file bytes and `site.public_paths.replace` mapping `/events` to `events.html`
- **THEN** the plan request body SHALL contain `site.replace["events.html"]` as a `ContentRef`
- **AND** it SHALL contain `site.public_paths.replace["/events"].asset === "events.html"`
- **AND** the inline file bytes SHALL NOT appear inside the deploy plan body

#### Scenario: Public path entries do not create content uploads

- **WHEN** a deploy spec changes only `site.public_paths`
- **THEN** the SDK SHALL call deploy planning with no additional content readers caused by `public_paths`
- **AND** any missing asset validation SHALL be left to gateway planning

### Requirement: Node manifest adapter accepts site public paths

The Node SDK manifest adapter SHALL accept `site.public_paths` in `loadDeployManifest()` and `normalizeDeployManifest()` input and return an SDK-native `ReleaseSpec` with the same public path declaration.

Manifest adapter strictness SHALL match the SDK shape: unknown public path fields and malformed entry objects SHALL fail before `deploy.apply()`.

#### Scenario: Manifest normalizes explicit public paths

- **WHEN** a manifest contains `project_id`, `site.replace`, and `site.public_paths.mode: "explicit"` with `replace["/events"].asset: "events.html"`
- **THEN** `normalizeDeployManifest()` SHALL return `spec.project` from `project_id`
- **AND** `spec.site.public_paths` SHALL preserve the explicit table

#### Scenario: Manifest rejects malformed public path declarations

- **WHEN** a manifest contains `site.public_paths: { mode: "implicit", replace: { "/events": { "asset": "events.html" } } }`
- **THEN** `normalizeDeployManifest()` SHALL reject the manifest locally
- **AND** the error SHALL identify `site.public_paths.replace` as invalid for implicit mode

### Requirement: CLI and MCP remain thin public path wrappers

The CLI and MCP deploy surfaces SHALL accept `site.public_paths` only as edge input and SHALL delegate typed normalization, validation, and deploy behavior to the SDK.

The CLI SHALL route `run402 deploy apply --manifest`, `--spec`, and stdin manifests through `normalizeDeployManifest()` before calling `deploy.apply()`. The MCP `deploy` tool SHALL build input compatible with the same SDK manifest adapter and call `getSdk().deploy.apply(...)`.

Neither CLI nor MCP SHALL duplicate public path canonicalization, sticky-mode inheritance, asset existence validation, or reachability authorization logic.

#### Scenario: CLI deploy apply forwards public paths through SDK

- **WHEN** a user runs `run402 deploy apply --manifest app.json` and the manifest contains `site.public_paths`
- **THEN** the CLI SHALL call the SDK manifest adapter
- **AND** the resulting deploy request SHALL be produced by SDK normalization

#### Scenario: MCP deploy schema accepts public paths

- **WHEN** the MCP `deploy` tool receives `site.public_paths.mode: "explicit"` with a replace table
- **THEN** the handler SHALL validate only the schema edge shape
- **AND** the handler SHALL delegate final deploy validation and planning to the SDK

### Requirement: Public docs teach explicit and implicit static reachability

Public SDK, CLI, MCP, README, root skill, OpenClaw skill, and OpenClaw README documentation SHALL explain the distinction between release static asset paths and public browser paths.

Docs SHALL include an example where `events.html` is deployed as a release static asset and `/events` is declared through `site.public_paths`. Docs SHALL state that in explicit mode `/events.html` is not publicly reachable unless separately declared. Docs SHALL state that `mode: "implicit"` restores filename-derived reachability and can widen access.

#### Scenario: Agent learns clean static URL authoring

- **WHEN** an agent reads public deploy documentation
- **THEN** it SHALL see a `site.public_paths` example mapping `/events` to asset `events.html`
- **AND** it SHALL learn that `events.html` is an asset path, not automatically a public URL in explicit mode

#### Scenario: Sync detects public path documentation drift

- **WHEN** SDK types expose `SitePublicPathsSpec`
- **THEN** `npm run test:sync` SHALL fail if required public docs omit `site.public_paths`
- **AND** the failure SHALL identify the missing documentation surface when practical
