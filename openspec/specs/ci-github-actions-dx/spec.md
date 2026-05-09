# ci-github-actions-dx Specification

## Purpose
TBD - created by archiving change add-ci-oidc-client-surface. Update Purpose after archive.
## Requirements
### Requirement: CLI links GitHub Actions to a project
The CLI SHALL provide a `run402 ci link github` flow that creates a GitHub Actions OIDC binding and writes a deploy workflow that runs the existing deploy command without run402 secrets.

#### Scenario: Link with inferred repository and branch
- **WHEN** the user runs `run402 ci link github --project <id>` inside a git checkout with an `origin` remote and a current branch
- **THEN** the CLI MUST infer `owner/repo` and branch, create a branch-specific subject pattern, sign the canonical delegation with the local allowance wallet, call the SDK to create the binding, and write a GitHub workflow file

#### Scenario: Link with environment subject
- **WHEN** the user runs `run402 ci link github --environment production`
- **THEN** the CLI MUST create a subject pattern for `repo:<owner>/<repo>:environment:production` and the generated workflow MUST include `environment: production`

#### Scenario: Repository id is required by default
- **WHEN** the CLI can fetch `GET https://api.github.com/repos/{owner}/{repo}` successfully
- **THEN** it MUST include the stable numeric `github_repository_id` in the binding request

#### Scenario: Repository id lookup failure
- **WHEN** the CLI cannot fetch the stable GitHub repository id
- **THEN** it MUST fail with an actionable message instructing the user to rerun with `--repository-id <id>` and MUST NOT silently create a soft-bound binding

#### Scenario: Link output states authority and residuals
- **WHEN** binding creation succeeds
- **THEN** the CLI MUST print the binding id, project id, subject pattern, fixed allowed events, repository-id binding status, workflow path, bootstrap caveat, runtime/database authority consent summary, and the residuals that revoke does not undo already-deployed code, stop in-flight operations, rotate exfiltrated keys, or remove deployed functions

### Requirement: CLI manages CI bindings minimally
The CLI SHALL provide list and revoke commands for CI bindings.

#### Scenario: List bindings
- **WHEN** the user runs `run402 ci list --project <id>`
- **THEN** the CLI MUST call the SDK list method and print active and revoked bindings with id, subject, allowed events, repository id, use count, last used time, creation time, expiry, and revocation time

#### Scenario: Revoke binding
- **WHEN** the user runs `run402 ci revoke <binding_id>`
- **THEN** the CLI MUST call the SDK revoke method, print that gateway-side revocation is immediate for future CI gateway requests, and print the compromise recovery steps: revoke, SIWE-deploy a known-good release, and rotate any service-role key deployed code may have read

### Requirement: CLI generates safe GitHub workflow files
The CLI SHALL generate a GitHub Actions workflow that invokes existing `run402 deploy apply` and does not store run402 wallet, allowance, anon, or service keys as GitHub secrets.

#### Scenario: Workflow declares OIDC permission
- **WHEN** the CLI writes a GitHub workflow
- **THEN** the workflow MUST include `permissions: id-token: write` and `contents: read`

#### Scenario: Workflow invokes existing deploy command
- **WHEN** the generated workflow deploys
- **THEN** it MUST invoke `run402 deploy apply --manifest <manifest> --project <project>` through the published CLI and MUST NOT require a separate GitHub Action package or new deploy command

#### Scenario: Workflow path protection
- **WHEN** a workflow file already exists at the target path
- **THEN** the CLI MUST refuse to overwrite it unless the user passes `--force`

#### Scenario: Bootstrap caveat
- **WHEN** the workflow is generated or link succeeds
- **THEN** the CLI MUST state that CI cannot bootstrap secrets, domains, subdomains, or other forbidden project setup and that those must be configured through wallet/SIWE flows before CI deploys

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

### Requirement: CLI keeps high-risk CI options out of v1
The v1 CLI SHALL avoid exposing high-risk or low-level controls that are unnecessary for the common coding-agent path.

#### Scenario: No PR event flags
- **WHEN** a user links GitHub Actions in v1
- **THEN** the CLI MUST use fixed allowed events `push` and `workflow_dispatch` and MUST NOT expose PR deploy flags

#### Scenario: No raw subject or wildcard flag
- **WHEN** a user links GitHub Actions in v1
- **THEN** the CLI MUST generate the subject from branch or environment inputs and MUST NOT expose a raw subject/wildcard flag

#### Scenario: No public token exchange command
- **WHEN** the CLI ships the v1 CI command group
- **THEN** it MUST NOT expose a public `ci exchange` debug command

#### Scenario: No workflow-only command
- **WHEN** the CLI ships the v1 CI command group
- **THEN** it MUST NOT expose a public workflow-only command that can create unbound half-configured CI state

### Requirement: OpenClaw mirrors CLI CI commands
OpenClaw SHALL expose the same CI command set as the CLI through script re-exports and skill documentation.

#### Scenario: OpenClaw script parity
- **WHEN** the CLI adds `run402 ci` subcommands
- **THEN** `openclaw/scripts/ci.mjs` MUST re-export the CLI module and `sync.test.ts` MUST include matching CLI and OpenClaw SURFACE entries

#### Scenario: OpenClaw skill guidance
- **WHEN** an OpenClaw agent reads `openclaw/SKILL.md`
- **THEN** the skill MUST describe `run402 ci link github`, `run402 ci list`, `run402 ci revoke`, generated workflow behavior, OIDC permissions, and the same bootstrap and revocation caveats

### Requirement: MCP is deferred or high-level only
MCP SHALL NOT be part of the v1 critical path for GitHub Actions setup; if MCP parity is required later, it SHALL expose only high-level tools.

#### Scenario: No low-level MCP sprawl in v1
- **WHEN** the v1 SDK and CLI CI surface ships
- **THEN** the implementation MUST NOT require separate MCP tools for raw create binding, workflow-only generation, token exchange, PR deploy enablement, or raw subject/wildcard setup

#### Scenario: Optional future high-level MCP
- **WHEN** a follow-up adds MCP parity after the CLI path is stable
- **THEN** it MUST prefer only `ci_link_github`, `ci_list_bindings`, and `ci_revoke_binding` as thin SDK/CLI-shaped helpers

### Requirement: Documentation covers CI/OIDC federation public surface
All public and required private documentation surfaces SHALL be updated according to `documentation.md`.

#### Scenario: SDK documentation updated
- **WHEN** the SDK `ci` namespace, canonical builders, CI credentials provider, or credential-driven deploy behavior ships
- **THEN** `sdk/README.md` and `sdk/llms-sdk.txt` MUST document signatures, examples, builder golden-vector expectations, token refresh semantics, and deploy preflight restrictions

#### Scenario: CLI documentation updated
- **WHEN** `run402 ci` commands ship
- **THEN** `cli/README.md`, `cli/llms-cli.txt`, and `openclaw/SKILL.md` MUST document each subcommand and flag, repository-id lookup, subject generation, workflow output, fixed allowed-event defaults, and omitted high-risk controls

#### Scenario: Repo documentation updated
- **WHEN** the new namespace, command group, OpenClaw surface, or credential-driven deploy behavior ships
- **THEN** `AGENTS.md`, `README.md`, `llms.txt` if appropriate, and `documentation.md` MUST be updated for architecture, package/interface counts, new doc triggers, and the GitHub Actions OIDC pattern

#### Scenario: Private docs coordinated
- **WHEN** the user-visible public CI surface ships
- **THEN** private-repo `site/llms-full.txt`, `site/openapi.json`, `site/updates.txt`, and `site/humans/changelog.md` MUST be updated or explicitly verified as already covering the final released behavior

### Requirement: Drift tests include CI surface
The repository drift tests SHALL treat the CI/OIDC client surface as part of the canonical API/interface matrix.

#### Scenario: sync test covers new interface entries
- **WHEN** SDK, CLI, or OpenClaw CI capabilities are implemented
- **THEN** `sync.test.ts` MUST include SURFACE entries for every public CLI/OpenClaw command and `SDK_BY_CAPABILITY` mappings for every SDK-backed method

#### Scenario: help and skill tests cover new commands
- **WHEN** `run402 ci` commands are documented
- **THEN** CLI help tests and `SKILL.test.ts` MUST be updated so stale command names fail CI
