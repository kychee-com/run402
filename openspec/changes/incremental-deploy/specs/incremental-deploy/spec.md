## ADDED Requirements

### Requirement: Inherit files from previous deployment

When a deploy request includes `inherit: true`, the gateway SHALL copy all files from the project's most recent previous deployment into the new deployment, then overlay the uploaded files on top.

#### Scenario: Incremental deploy with changed files
- **WHEN** a deploy request includes `inherit: true` and files `[style.css]`
- **AND** the previous deployment contained `[index.html, style.css, logo.png]`
- **THEN** the new deployment contains `[index.html, style.css, logo.png]` where `style.css` is the newly uploaded version and `index.html` and `logo.png` are copied from the previous deployment

#### Scenario: Incremental deploy with no files
- **WHEN** a deploy request includes `inherit: true` and an empty `files` array
- **THEN** the new deployment is an exact copy of the previous deployment

#### Scenario: First deploy with inherit flag
- **WHEN** a deploy request includes `inherit: true` but the project has no previous deployment
- **THEN** the gateway proceeds normally with only the uploaded files (no error)

#### Scenario: Deploy without inherit flag
- **WHEN** a deploy request does not include `inherit` or sets `inherit: false`
- **THEN** the deployment contains only the uploaded files (existing full-replacement behavior)

### Requirement: Files array may be empty when inherit is true

The deploy endpoint SHALL accept an empty `files` array when `inherit: true` is set, allowing a pure re-deploy of the previous deployment's files.

#### Scenario: Empty files with inherit
- **WHEN** `inherit: true` and `files` is `[]`
- **THEN** the request is accepted (no 400 error)

#### Scenario: Empty files without inherit
- **WHEN** `inherit` is not set and `files` is `[]`
- **THEN** the request returns 400 "Missing or empty 'files' array" (existing behavior)

### Requirement: Inherited files use S3 server-side copy

Inherited files SHALL be copied using S3 CopyObject (server-side copy) to avoid transferring file content through the gateway.

#### Scenario: S3 mode
- **WHEN** the gateway is running with S3 configured
- **THEN** inherited files are copied via `CopyObject` from `sites/{prev_id}/{path}` to `sites/{new_id}/{path}`

#### Scenario: Local dev mode
- **WHEN** the gateway is running without S3 (local filesystem)
- **THEN** inherited files are copied via filesystem copy from the old deployment directory to the new one

### Requirement: Deployment record includes inherited files in counts

The deployment record in the database SHALL reflect the total file count and size including both uploaded and inherited files.

#### Scenario: Mixed deploy
- **WHEN** 2 files are uploaded and 8 files are inherited
- **THEN** `files_count` is 10 and `total_size` is the sum of all 10 files
