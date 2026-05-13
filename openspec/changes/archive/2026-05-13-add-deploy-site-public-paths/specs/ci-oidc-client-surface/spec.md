## ADDED Requirements

### Requirement: CI deploy preflight allows complete site resources

The SDK CI deploy preflight SHALL allow the complete `ReleaseSpec.site` resource whenever CI-session credentials are active. This includes `site.replace`, `site.patch`, and `site.public_paths`.

The SDK SHALL NOT add nested CI preflight restrictions for `site.public_paths`. Gateway planning SHALL remain authoritative for public path validation, reachability policy, and any CI authorization errors related to nested site content.

The SDK CI preflight SHALL continue to reject forbidden top-level fields, non-current `base`, and non-null `manifest_ref` according to the existing CI deploy contract.

#### Scenario: CI forwards site public paths

- **WHEN** CI-session credentials are active
- **AND** `r.deploy.apply()` receives a `ReleaseSpec` with `site.public_paths`
- **THEN** SDK CI preflight SHALL allow the spec to proceed
- **AND** the deploy plan request SHALL include the complete normalized `site` resource

#### Scenario: CI still rejects forbidden top-level resources

- **WHEN** CI-session credentials are active
- **AND** a `ReleaseSpec` contains `secrets`, `subdomains`, `checks`, an unknown top-level field, non-current `base`, or a non-null `manifest_ref`
- **THEN** SDK CI preflight SHALL reject before upload, content planning, or deploy planning

#### Scenario: Gateway CI public path errors are preserved

- **WHEN** the gateway rejects a CI deploy because of nested `site.public_paths` validation or authorization
- **THEN** the SDK SHALL preserve the gateway error code and body
- **AND** CLI and MCP error reporting SHALL receive the canonical gateway envelope
