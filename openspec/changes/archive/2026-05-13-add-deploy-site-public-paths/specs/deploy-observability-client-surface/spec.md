## ADDED Requirements

### Requirement: SDK exposes static public path inventory and diagnostics

The SDK SHALL expose typed deploy observability fields for materialized static public paths when returned by the gateway.

`StaticReachabilityAuthority` SHALL include at least `"implicit_file_path"`, `"explicit_public_path"`, and `"route_static_alias"`. `StaticPublicPathInventoryEntry` SHALL expose `public_path`, `asset_path`, `reachability_authority`, `direct`, `cache_class`, `content_type`, optional `route_id`, and optional `methods`.

`ReleaseInventory` SHALL expose `static_public_paths` as the gateway's materialized static public-path inventory. `DeployResolveResponse` SHALL expose optional `asset_path`, `reachability_authority`, and `direct` fields for authenticated diagnostics. These fields SHALL preserve gateway values without client-side reinterpretation.

#### Scenario: Release inventory includes static public paths

- **WHEN** TypeScript code handles `ReleaseInventory`
- **THEN** it SHALL be able to read `release.static_public_paths`
- **AND** each entry SHALL distinguish `public_path` from `asset_path`
- **AND** each entry SHALL expose whether it is `direct`

#### Scenario: Resolve diagnostics include reachability authority

- **WHEN** TypeScript code handles `DeployResolveResponse`
- **THEN** it SHALL be able to read optional `asset_path`, `reachability_authority`, and `direct`
- **AND** sparse gateway responses that omit those fields SHALL still compile and parse

### Requirement: CLI and MCP preserve static public path observability

CLI and MCP release/resolve observability surfaces SHALL preserve `static_public_paths`, `asset_path`, `reachability_authority`, and `direct` in raw JSON output.

Human-readable summaries MAY count or mention static public paths, but machine-readable JSON SHALL remain the source of truth and SHALL NOT collapse `public_path` and `asset_path` into one field.

#### Scenario: CLI release inventory preserves static public paths

- **WHEN** `run402 deploy release active` receives a release inventory with `static_public_paths`
- **THEN** stdout JSON SHALL include the complete `static_public_paths` array unchanged
- **AND** entries SHALL retain both `public_path` and `asset_path`

#### Scenario: MCP resolve diagnostics preserve reachability fields

- **WHEN** `deploy_diagnose_url` receives resolve diagnostics with `asset_path`, `reachability_authority`, and `direct`
- **THEN** the fenced JSON block SHALL include those fields unchanged
- **AND** the human-readable summary SHALL NOT imply that `asset_path` is itself publicly reachable

### Requirement: Documentation and drift guards cover static public path observability

Public docs and sync drift tests SHALL describe authenticated static public path observability separately from ordinary site asset inventory.

Documentation SHALL state that `static_public_paths[]` explains browser reachability, while `site.paths` describes release static assets. Documentation SHALL state that `reachability_authority` identifies whether reachability came from implicit file-path mode, explicit public path declaration, or a route-only static alias.

#### Scenario: Docs distinguish site paths from public paths

- **WHEN** an agent reads release inventory documentation
- **THEN** it SHALL learn that `site.paths` and `static_public_paths` are different inventories
- **AND** it SHALL learn what `reachability_authority` means

#### Scenario: Sync detects missing observability docs

- **WHEN** SDK types include `StaticPublicPathInventoryEntry`
- **THEN** the sync/docs guard SHALL fail if public docs omit `static_public_paths`
- **AND** it SHALL require at least one public surface to mention `reachability_authority`
