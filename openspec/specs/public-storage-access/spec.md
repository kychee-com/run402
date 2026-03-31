## ADDED Requirements

### Requirement: Public storage read route

The gateway SHALL expose `GET /storage/v1/public/:project_id/:bucket/*` that serves storage files without authentication.

#### Scenario: File exists for active project
- **WHEN** a GET request is made to `/storage/v1/public/{project_id}/{bucket}/{path}` and the project is active and the file exists in S3
- **THEN** the gateway returns 200 with the file body and the original Content-Type

#### Scenario: File not found
- **WHEN** a GET request is made to `/storage/v1/public/{project_id}/{bucket}/{path}` and the file does not exist in S3
- **THEN** the gateway returns 404

#### Scenario: Project not found or not active
- **WHEN** a GET request is made with a project_id that does not exist or is not active
- **THEN** the gateway returns 404

#### Scenario: No auth required
- **WHEN** a GET request is made without any `apikey` header or Authorization header
- **THEN** the gateway serves the file (no authentication required)

### Requirement: Upload response includes public URL

The storage upload endpoint (`POST /storage/v1/object/:bucket/*`) SHALL return a `url` field in the response containing the full public URL for the uploaded file.

#### Scenario: Upload returns url field
- **WHEN** a file is uploaded via `POST /storage/v1/object/{bucket}/{path}`
- **THEN** the response includes `url` with value `https://{host}/storage/v1/public/{project_id}/{bucket}/{path}` alongside the existing `key` and `size` fields

#### Scenario: Existing fields unchanged
- **WHEN** a file is uploaded
- **THEN** the response still includes `key` and `size` fields with the same values as before
