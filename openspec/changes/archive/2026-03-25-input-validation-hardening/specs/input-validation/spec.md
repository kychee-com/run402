## ADDED Requirements

### Requirement: UUID validation
The gateway SHALL validate all user-supplied UUID values against RFC 4122 format (`xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`, lowercase hex) before using them in database queries. Invalid UUIDs SHALL be rejected with HTTP 400 and a message identifying the invalid field.

#### Scenario: Valid UUID accepted
- **WHEN** a request provides a valid UUID (e.g. `"550e8400-e29b-41d4-a716-446655440000"`) for a UUID parameter
- **THEN** the request proceeds to the service/DB layer normally

#### Scenario: Non-UUID string rejected
- **WHEN** a request provides a non-UUID string (e.g. `"also_invalid"`) for a UUID parameter
- **THEN** the gateway returns HTTP 400 with body `{"error": "Invalid <field>: must be a valid UUID"}`
- **AND** no database query is executed for that value

#### Scenario: Empty or missing UUID rejected
- **WHEN** a request provides an empty string or omits a required UUID parameter
- **THEN** the gateway returns HTTP 400

### Requirement: Ethereum wallet address validation
The gateway SHALL validate wallet address parameters as 42-character hex strings starting with `0x`. Invalid addresses SHALL be rejected with HTTP 400.

#### Scenario: Valid address accepted
- **WHEN** a request provides `"0x059D091D51a0f011c9872EaA63Df538F5cE15945"` as a wallet address
- **THEN** the request proceeds normally

#### Scenario: Short address rejected
- **WHEN** a request provides `"0x1234"` as a wallet address
- **THEN** the gateway returns HTTP 400 with body `{"error": "Invalid wallet: must be a 42-character hex address"}`

#### Scenario: Non-hex address rejected
- **WHEN** a request provides `"0xZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ"` as a wallet address
- **THEN** the gateway returns HTTP 400

### Requirement: Email validation
The gateway SHALL validate email parameters for format (contains `@`, has a domain with at least one dot) and length (max 254 characters per RFC 5321). Invalid emails SHALL be rejected with HTTP 400.

#### Scenario: Valid email accepted
- **WHEN** a request provides `"user@example.com"` as an email
- **THEN** the request proceeds normally

#### Scenario: Missing domain rejected
- **WHEN** a request provides `"user@"` as an email
- **THEN** the gateway returns HTTP 400

#### Scenario: Oversized email rejected
- **WHEN** a request provides an email longer than 254 characters
- **THEN** the gateway returns HTTP 400

### Requirement: Pagination parameter validation
The gateway SHALL parse pagination parameters (`limit`, `offset`, `tail`) as non-negative integers. Non-numeric values SHALL be rejected with HTTP 400 rather than silently defaulting.

#### Scenario: Valid integer accepted
- **WHEN** a request provides `limit=50` as a query parameter
- **THEN** the value is parsed as integer 50

#### Scenario: Non-numeric value rejected
- **WHEN** a request provides `limit=abc` as a query parameter
- **THEN** the gateway returns HTTP 400 with body `{"error": "Invalid limit: must be a positive integer"}`

#### Scenario: Negative value rejected
- **WHEN** a request provides `limit=-5` as a query parameter
- **THEN** the gateway returns HTTP 400

### Requirement: URL validation
The gateway SHALL validate URL parameters (e.g. webhook URLs, redirect URIs) using the URL constructor. Only `https://` URLs with a valid hostname SHALL be accepted. Invalid URLs SHALL be rejected with HTTP 400.

#### Scenario: Valid HTTPS URL accepted
- **WHEN** a request provides `"https://example.com/webhook"` as a URL parameter
- **THEN** the request proceeds normally

#### Scenario: HTTP URL rejected
- **WHEN** a request provides `"http://example.com/webhook"` as a URL parameter
- **THEN** the gateway returns HTTP 400

#### Scenario: Malformed URL rejected
- **WHEN** a request provides `"not-a-url"` as a URL parameter
- **THEN** the gateway returns HTTP 400

### Requirement: Consistent error response format
All validation errors SHALL return HTTP 400 with a JSON body containing an `error` field that names the invalid parameter and describes the expected format.

#### Scenario: Error response structure
- **WHEN** any validation check fails
- **THEN** the response has status 400, content-type `application/json`, and body matching `{"error": "<descriptive message>"}`

### Requirement: Validation module
The gateway SHALL provide a shared validation utility at `utils/validate.ts` exporting individual validator functions. Each function SHALL accept the value and a field name, return the validated value on success, and throw `HttpError(400, ...)` on failure.

#### Scenario: Validator function signature
- **WHEN** a route handler calls `validateUUID(value, "project_id")`
- **THEN** it returns `value` if valid, or throws `HttpError(400, "Invalid project_id: must be a valid UUID")` if invalid
