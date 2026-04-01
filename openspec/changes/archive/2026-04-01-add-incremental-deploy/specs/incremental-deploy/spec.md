## MODIFIED Requirements

### Requirement: Deploy a static site

The `deploy_site` tool SHALL accept an optional `inherit` boolean parameter. When `true`, the server copies unchanged files from the previous deployment. Only changed/new files need to be included in the `files` array.

#### Scenario: Deploy with inherit enabled
- **WHEN** the user calls `deploy_site` with `inherit: true` and a partial file list
- **THEN** the tool sends `inherit: true` in the POST body to `/deployments/v1`
- **AND** the server copies missing files from the previous deployment

#### Scenario: Deploy without inherit (default)
- **WHEN** the user calls `deploy_site` without the `inherit` parameter
- **THEN** the tool does NOT include `inherit` in the POST body
- **AND** behavior is unchanged from before

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

### Requirement: CLI sites deploy with --inherit flag

The CLI `sites deploy` command SHALL accept an optional `--inherit` flag that sends `inherit: true` in the request body.

#### Scenario: CLI deploy with --inherit
- **WHEN** the user runs `run402 sites deploy --manifest site.json --inherit`
- **THEN** the CLI includes `inherit: true` in the POST body

### Requirement: CLI deploy manifest supports inherit

The CLI `deploy` command SHALL pass through `inherit` from the manifest JSON to the API.

#### Scenario: Manifest includes inherit
- **WHEN** the manifest JSON contains `"inherit": true`
- **THEN** the CLI passes it through in the POST body (already works, documentation only)
