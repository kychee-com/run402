# ci-oidc-client-surface Specification

## Purpose
TBD - created by archiving change add-ci-oidc-client-surface. Update Purpose after archive.
## Requirements
### Requirement: SDK exposes CI binding lifecycle
The SDK SHALL expose a `ci` namespace covering all `/ci/v1/*` binding lifecycle and token-exchange endpoints with typed request and response shapes.

#### Scenario: Create binding
- **WHEN** a caller invokes `ci.createBinding` with `project_id`, `provider: "github-actions"`, `subject_match`, `allowed_actions: ["deploy"]`, `allowed_events`, `github_repository_id`, `expires_at`, `nonce`, and `signed_delegation`
- **THEN** the SDK MUST send `POST /ci/v1/bindings` with SIWX auth from the credential provider and return the typed binding row

#### Scenario: List bindings
- **WHEN** a caller invokes `ci.listBindings({ project })`
- **THEN** the SDK MUST send `GET /ci/v1/bindings?project=<project>` and return `{ bindings }`, including revoked rows returned by the gateway

#### Scenario: Get binding detail
- **WHEN** a caller invokes `ci.getBinding(bindingId)`
- **THEN** the SDK MUST send `GET /ci/v1/bindings/:id` and expose the parsed `created_sig` audit payload when present

#### Scenario: Revoke binding
- **WHEN** a caller invokes `ci.revokeBinding(bindingId)`
- **THEN** the SDK MUST send `POST /ci/v1/bindings/:id/revoke` and return the current revoked binding row without treating repeated revocation as a client error

#### Scenario: Exchange OIDC token ergonomically
- **WHEN** a caller invokes `ci.exchangeToken` with only `project_id` and `subject_token`
- **THEN** the SDK MUST send `POST /ci/v1/token-exchange` as JSON with `withAuth: false`, MUST fill the RFC 8693 `grant_type` and `subject_token_type` constants internally, and MUST return `access_token`, `token_type`, `expires_in`, and `scope`

### Requirement: SDK implements canonical CI delegation builders
The SDK SHALL provide pure helpers that produce the gateway-canonical CI delegation Statement and Resource URI byte-for-byte.

#### Scenario: Statement golden vector
- **WHEN** `buildCiDelegationStatement` receives `project_id: "prj_abc"`, `issuer: "https://token.actions.githubusercontent.com"`, `audience: "https://api.run402.com"`, `subject_match: "repo:tal/myapp:ref:refs/heads/main"`, `allowed_actions: ["deploy"]`, `allowed_events: ["push", "workflow_dispatch"]`, `expires_at: "2026-07-30T00:00:00Z"`, `github_repository_id: "892341"`, and `nonce: "deadbeef00112233aabbccdd44556677"`
- **THEN** it MUST return exactly:

```text
Authorize GitHub Actions workflows whose OIDC subject matches repo:tal/myapp:ref:refs/heads/main to deploy to run402 project prj_abc.

The workflows can:
  - deploy function code that runs with this project's runtime authority, including the project's service-role key, the adminDb() bypass-RLS surface, and configured runtime secrets read via process.env;
  - deploy database migrations, RLS/expose changes, and schema-altering SQL via spec.database.

The workflows cannot directly call secrets, domain, subdomain, lifecycle, billing, contracts, or faucet endpoints. They cannot ship spec.secrets, spec.subdomains, spec.routes, spec.checks, or non-current spec.base.

Audience: https://api.run402.com
Allowed events: push,workflow_dispatch
Repository ID: 892341
Expires: 2026-07-30T00:00:00Z
Nonce: deadbeef00112233aabbccdd44556677

Revoke at any time via the run402 CLI or POST /ci/v1/bindings/:id/revoke. Revocation stops future CI gateway requests but does not undo already-deployed code, stop in-flight deploy operations, rotate exfiltrated keys, or remove deployed functions. Recovery from a compromise: revoke the binding, then SIWE-deploy a known-good release that overwrites the malicious code, and rotate any service-role key the deployed code may have read.
```

#### Scenario: Resource URI golden vector
- **WHEN** `buildCiDelegationResourceUri` receives the same values as the Statement golden vector
- **THEN** it MUST return exactly `run402-ci-delegation:v1?project_id=prj_abc&issuer=https%3A%2F%2Ftoken.actions.githubusercontent.com&audience=https%3A%2F%2Fapi.run402.com&subject_match=repo%3Atal%2Fmyapp%3Aref%3Arefs%2Fheads%2Fmain&allowed_actions=deploy&allowed_events=push,workflow_dispatch&expires_at=2026-07-30T00%3A00%3A00Z&github_repository_id=892341&nonce=deadbeef00112233aabbccdd44556677`

#### Scenario: Nullable canonical values
- **WHEN** `expires_at` is null and `github_repository_id` is null
- **THEN** the Statement MUST render `Expires: never` and `Repository ID: none-soft-bound`, and the Resource URI MUST omit the `expires_at` and `github_repository_id` query parameters entirely

#### Scenario: Array canonicalization
- **WHEN** allowed actions or events are provided out of order or with duplicates
- **THEN** the builders MUST sort and dedupe them before rendering comma-joined values without spaces, and commas in those array values MUST remain literal rather than `%2C`

### Requirement: SDK validates CI delegation inputs
The SDK SHALL validate CI delegation inputs before signing or submitting a binding request.

#### Scenario: Reject invalid subject patterns
- **WHEN** a caller provides an empty subject, a bare `*`, a subject longer than 256 characters, a subject containing control characters, a subject with more than one `*`, or a subject with `*` anywhere except the final character
- **THEN** the SDK MUST throw a typed local validation error before making a network request

#### Scenario: Accept literal special characters
- **WHEN** a caller provides a subject containing literal `.`, `+`, `[`, `]`, or `?` characters without violating wildcard rules
- **THEN** the SDK MUST accept the subject and encode those characters only according to the canonical Resource URI rules

#### Scenario: Validate nonce
- **WHEN** a caller provides a nonce that is not lowercase hex or whose length is outside 16 to 64 characters
- **THEN** the SDK MUST throw a typed local validation error before signing or creating a binding

### Requirement: Node SDK signs CI delegations from the local allowance
The Node SDK SHALL provide a helper that creates the `signed_delegation` SIWX header value using the local allowance wallet without exposing the private key to callers.

#### Scenario: Sign delegation with Resources
- **WHEN** the local allowance exists and a caller asks the Node SDK to sign CI delegation values
- **THEN** the helper MUST build an EIP-191 SIWX payload whose Statement equals `buildCiDelegationStatement(values)`, whose Resources list contains exactly `buildCiDelegationResourceUri(values)`, whose URI is the binding endpoint, and whose encoded result can be used as the `signed_delegation` request body field

#### Scenario: Preserve ordinary allowance auth
- **WHEN** existing SDK, CLI, or MCP code calls the ordinary allowance auth helper for non-CI API paths
- **THEN** it MUST continue to produce the same "Sign in to Run402" SIWX auth behavior as before this change

#### Scenario: Missing allowance
- **WHEN** no local allowance is configured
- **THEN** the Node signing helper MUST fail with an actionable local error instructing the caller to run `run402 init` or `run402 allowance create`

### Requirement: SDK supports CI-session credentials
The SDK SHALL provide credentials-provider helpers for CI sessions, including a GitHub Actions helper, that authenticate CI-callable routes with `Authorization: Bearer <run402-session-jwt>`.

#### Scenario: Bearer auth on CI paths
- **WHEN** a Run402 client is constructed with CI-session credentials
- **THEN** `credentials.getAuth(path)` MUST return the CI Bearer header for content plan, content commit, deploy plan, deploy commit, operation status, operation events, and operation resume paths

#### Scenario: GitHub Actions OIDC exchange
- **WHEN** `githubActionsCredentials({ projectId })` is used inside GitHub Actions
- **THEN** it MUST request a GitHub OIDC JWT from `ACTIONS_ID_TOKEN_REQUEST_URL` and `ACTIONS_ID_TOKEN_REQUEST_TOKEN`, call `ci.exchangeToken({ project_id: projectId, subject_token })` with no Authorization header, and cache the returned session

#### Scenario: Token refresh uses expires_in
- **WHEN** token exchange returns `expires_in` less than 900 seconds
- **THEN** the CI credentials helper MUST use the returned value as authoritative and refresh before the configured cushion rather than hard-coding a 900 second lifetime

#### Scenario: No local project keys in CI
- **WHEN** the CI credentials provider is used for a project
- **THEN** deploy operations MUST NOT require a real local `anon_key` or `service_key` for CI-callable routes

#### Scenario: Custom Bearer providers are not CI by default
- **WHEN** a caller supplies a custom credential provider that returns an `Authorization: Bearer` header but does not use the CI credentials helper or marker
- **THEN** the deploy SDK MUST NOT automatically apply CI deploy restrictions or CI no-key behavior

### Requirement: Deploy SDK enforces CI restrictions when using CI-session credentials
The deploy SDK SHALL keep `r.deploy.apply(spec)` as the public API while automatically preflighting release specs against the gateway's CI allowlist whenever the credential provider is CI-marked.

#### Scenario: CI credentials trigger preflight automatically
- **WHEN** `r.deploy.apply(spec)` is called with CI-session credentials
- **THEN** the SDK MUST run CI deploy preflight before hashing, manifest sizing, content planning, uploading, or calling `/deploy/v2/plans`

#### Scenario: Reject forbidden spec fields
- **WHEN** CI-session credentials are active and a ReleaseSpec contains `secrets`, `subdomains`, `routes`, `checks`, or any unknown future top-level spec field
- **THEN** the SDK MUST throw a typed local validation error before any upload or gateway mutation

#### Scenario: Reject non-current base
- **WHEN** CI-session credentials are active and `spec.base` is present with anything other than exactly `{ release: "current" }`
- **THEN** the SDK MUST throw a typed local validation error before calling the gateway

#### Scenario: Reject manifest_ref path
- **WHEN** CI-session credentials are active and the normalized plan body would exceed the inline body limit and require a non-null `manifest_ref`
- **THEN** the SDK MUST fail locally with a message that CI deploys must use inline specs under the gateway body cap

#### Scenario: Allow CI deployable fields through existing deploy API
- **WHEN** CI-session credentials are active and the ReleaseSpec contains only `project`, `database`, `functions`, `site`, and absent or current `base`
- **THEN** `r.deploy.apply(spec)` MUST drive the existing deploy flow with CI Bearer auth and no public CI-mode flag

#### Scenario: CI deploy sends Bearer and not apikey
- **WHEN** CI-session credentials are active and deploy needs content planning, content commit, operation status, operation events, or resume calls
- **THEN** the SDK MUST send `Authorization: Bearer <ci-session>` and MUST NOT send `apikey`

#### Scenario: CI deploy avoids non-CI-callable gateway routes
- **WHEN** CI-session credentials are active and deploy uploads CAS content
- **THEN** the SDK MUST either use only routes confirmed CI-callable by the gateway contract or fail locally with an implementation error before beginning the deploy

#### Scenario: Preserve wallet deploy behavior
- **WHEN** CI-session credentials are not active
- **THEN** existing wallet/key-backed deploy behavior, including secrets, subdomains, oversized manifest upload through `manifest_ref`, and apikey operation polling, MUST continue to work as before

### Requirement: SDK surfaces CI errors clearly
The SDK SHALL preserve gateway CI error codes in thrown `Run402Error` bodies and add local error contexts for client-side CI validation.

#### Scenario: Gateway error code preserved
- **WHEN** the gateway returns CI errors such as `nonce_replay`, `delegation_statement_mismatch`, `delegation_resource_uri_mismatch`, `invalid_token`, `event_not_allowed`, `repository_id_mismatch`, `forbidden_spec_field`, or `forbidden_plan`
- **THEN** the SDK error body MUST expose the gateway response so CLI and future MCP tools can branch on the code

#### Scenario: Local preflight identifies field
- **WHEN** local CI deploy preflight rejects a forbidden field
- **THEN** the thrown error MUST identify the offending field and the CI restriction that was violated
