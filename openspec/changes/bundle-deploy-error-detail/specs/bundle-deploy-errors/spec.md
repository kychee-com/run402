## ADDED Requirements

### Requirement: Bundle deploy surfaces errors from all phases
When any deploy phase (migrations, RLS, secrets, functions, files, subdomain) fails, `POST /deploy/v1` SHALL return the error's status code and message in the response body as `{ "error": "<message>" }`, instead of a generic 500.

#### Scenario: Function deploy fails with validation error
- **WHEN** a bundle deploy includes a function with an invalid name (e.g., `"name": "UPPER_CASE"`)
- **THEN** the response SHALL be 400 with `{ "error": "Invalid function name..." }` (not 500 "Internal server error")

#### Scenario: Function deploy fails with tier limit
- **WHEN** a bundle deploy includes more functions than the project's tier allows
- **THEN** the response SHALL be 403 with the tier limit message

#### Scenario: Site deploy fails
- **WHEN** a bundle deploy includes files that fail to upload (e.g., storage error)
- **THEN** the response SHALL include the actual error message and appropriate status code

#### Scenario: Unknown error preserves message
- **WHEN** an unexpected error without a `statusCode` property is thrown during bundle deploy
- **THEN** the response SHALL be 500 with the error's message in the body (not "Internal server error")
