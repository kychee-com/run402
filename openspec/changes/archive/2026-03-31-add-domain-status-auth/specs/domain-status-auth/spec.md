## ADDED Requirements

### Requirement: Domain status endpoint requires authentication
The `GET /domains/v1/:domain` endpoint SHALL require `serviceKeyOrAdmin` authentication, consistent with all other domain routes.

#### Scenario: Authenticated request returns domain status
- **WHEN** a caller sends `GET /domains/v1/:domain` with a valid service key or admin credentials
- **THEN** the endpoint SHALL return the domain status payload (same response as before)

#### Scenario: Unauthenticated request is rejected
- **WHEN** a caller sends `GET /domains/v1/:domain` without any auth credentials
- **THEN** the endpoint SHALL respond with HTTP 401

#### Scenario: Invalid credentials are rejected
- **WHEN** a caller sends `GET /domains/v1/:domain` with an invalid service key
- **THEN** the endpoint SHALL respond with HTTP 401
