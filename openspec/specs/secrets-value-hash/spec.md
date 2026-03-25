## ADDED Requirements

### Requirement: Secrets list includes value hash
The `GET /projects/v1/admin/:id/secrets` endpoint SHALL return a `value_hash` field for each secret, containing the first 8 hexadecimal characters of the SHA-256 hash of the secret's value.

#### Scenario: List secrets returns value_hash
- **WHEN** an agent calls `GET /projects/v1/admin/:id/secrets` with a valid `service_key`
- **THEN** each secret object in the response SHALL include `value_hash` as a lowercase 8-character hex string alongside `key`, `created_at`, and `updated_at`

#### Scenario: Hash matches the stored value
- **WHEN** an agent sets a secret with key `MY_KEY` and value `sk-test-12345`
- **AND** then calls `GET /projects/v1/admin/:id/secrets`
- **THEN** the `value_hash` for `MY_KEY` SHALL equal the first 8 characters of `sha256("sk-test-12345")` encoded as lowercase hex

#### Scenario: Hash changes when secret is updated
- **WHEN** an agent updates an existing secret to a new value
- **AND** then calls `GET /projects/v1/admin/:id/secrets`
- **THEN** the `value_hash` SHALL reflect the new value, not the old one
