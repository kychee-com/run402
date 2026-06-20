## MODIFIED Requirements

### Requirement: SDK surfaces CI errors clearly
The SDK SHALL preserve gateway CI error codes in thrown `Run402Error` bodies, discriminate the `binding_revoked` token-exchange denial via a typed guard, and add local error contexts for client-side CI validation.

#### Scenario: Gateway error code preserved
- **WHEN** the gateway returns CI errors such as `nonce_replay`, `delegation_statement_mismatch`, `delegation_resource_uri_mismatch`, `invalid_token`, `access_denied`, `binding_revoked`, `event_not_allowed`, `repository_id_mismatch`, `forbidden_spec_field`, or `forbidden_plan`
- **THEN** the SDK error body MUST expose the gateway response so CLI and future MCP tools can branch on the code

#### Scenario: Revoked binding is discriminable
- **WHEN** `ci.exchangeToken` receives an HTTP 403 whose body `error` field is `"binding_revoked"` (a subject-matching binding existed but was revoked, e.g. the project was transferred)
- **THEN** the SDK MUST throw an `Unauthorized` (so `isUnauthorized` remains true and existing generic-403 handling is unaffected)
- **AND** `isCiBindingRevoked(err)` MUST return `true` for that error and `false` for `access_denied` (no binding ever matched), even though both share the generic canonical `code: "FORBIDDEN"`
- **AND** the SDK MUST export `CI_BINDING_REVOKED_ERROR` (`"binding_revoked"`) and include it in the `CiTokenExchangeErrorCode` union

#### Scenario: Local preflight identifies field
- **WHEN** local CI deploy preflight rejects a forbidden field
- **THEN** the thrown error MUST identify the offending field and the CI restriction that was violated
