## MODIFIED Requirements

### Requirement: Bundle deploy with inherit

The `bundle_deploy` tool SHALL accept an optional `inherit` boolean parameter, passed through to the deploy API.

#### Scenario: Bundle deploy with inherit enabled
- **WHEN** the user calls `bundle_deploy` with `inherit: true` and a partial file list
- **THEN** the tool sends `inherit: true` in the POST body to `/deploy/v1`

#### Scenario: Bundle deploy without inherit (default)
- **WHEN** the user calls `bundle_deploy` without the `inherit` parameter
- **THEN** the tool does NOT include `inherit` in the POST body

### Requirement: Upload file shows public URL

The `upload_file` tool SHALL display the `url` field from the API response when present.

#### Scenario: Upload response includes public URL
- **WHEN** the upload API returns a response with a `url` field
- **THEN** the tool displays the public URL in the output

#### Scenario: Upload response without URL (backward compat)
- **WHEN** the upload API returns a response without a `url` field
- **THEN** the tool displays the response without the URL (no error)

### Requirement: CLI deploy manifest supports inherit

The CLI `deploy` command SHALL pass through `inherit` from the manifest JSON to the API.

#### Scenario: Manifest includes inherit
- **WHEN** the manifest JSON contains `"inherit": true`
- **THEN** the CLI passes it through in the POST body (already works, documentation only)
