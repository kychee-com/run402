## MODIFIED Requirements

### Requirement: Deploy CLI auto-uses GitHub OIDC in Actions
The existing `run402 deploy apply` command SHALL automatically use GitHub Actions OIDC when it is running in GitHub Actions with the required OIDC environment and project id.

#### Scenario: GitHub Actions runtime detection
- **WHEN** `run402 deploy apply` runs with `GITHUB_ACTIONS=true`, GitHub OIDC request environment variables, and a project id from `--project` or `RUN402_PROJECT_ID`
- **THEN** it MUST construct GitHub Actions CI credentials and run the existing SDK deploy flow without requiring a local allowance or project key store

#### Scenario: Local deploy remains unchanged
- **WHEN** `run402 deploy apply` runs outside GitHub Actions
- **THEN** it MUST preserve existing local allowance preflight, project key behavior, output shape, and error handling

#### Scenario: CI errors are actionable
- **WHEN** CI deploy receives `invalid_token`, `access_denied`, `event_not_allowed`, `repository_id_mismatch`, `forbidden_spec_field`, `forbidden_plan`, or 402 payment/tier errors
- **THEN** the CLI MUST print an actionable explanation that references the binding, event, repository id, deploy spec restriction, same-binding-only guard, or tier requirement as appropriate

#### Scenario: Revoked binding points at re-link
- **WHEN** CI deploy token-exchange fails with `binding_revoked` (a matching binding existed but was revoked, e.g. the project was transferred)
- **THEN** the CLI MUST print guidance to re-create the binding with `run402 ci link github`
- **AND** the guidance MUST steer away from `run402 ci set-asset-scopes`, which returns 409 on a revoked binding
