## MODIFIED Requirements

### Requirement: Bundle deploy with inherit

The `bundle_deploy` tool SHALL accept an optional `inherit` boolean parameter, passed through to the deploy API.

#### Scenario: Bundle deploy with inherit enabled
- **WHEN** the user calls `bundle_deploy` with `inherit: true` and a partial file list
- **THEN** the tool sends `inherit: true` in the POST body to `/deploy/v1`

#### Scenario: Bundle deploy without inherit (default)
- **WHEN** the user calls `bundle_deploy` without the `inherit` parameter
- **THEN** the tool does NOT include `inherit` in the POST body

### Requirement: CLI deploy manifest supports inherit

The CLI `deploy` command SHALL pass through `inherit` from the manifest JSON to the API.

#### Scenario: Manifest includes inherit
- **WHEN** the manifest JSON contains `"inherit": true`
- **THEN** the CLI passes it through in the POST body (already works, documentation only)
