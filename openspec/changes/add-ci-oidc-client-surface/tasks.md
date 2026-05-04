## 1. Contract and setup

- [x] 1.1 Re-read private commit `b17431da` `LETTER_TO_PUBLIC_REPO.md` and verify endpoint paths, canonical builders, error codes, and CI deploy restrictions still match the deployed gateway.
- [x] 1.2 Confirm generated workflow will call a pinned/current published `run402` CLI version and will not depend on a separate GitHub Action package in v1.
- [x] 1.3 Decide the default delegation chain id (`eip155:84532` vs `eip155:8453`) and document the rule in SDK/CLI tests.
- [x] 1.4 Audit the unified deploy content-upload path, especially `/storage/v1/uploads/:id/complete`, against the gateway's CI-callable route list before implementing CI deploy.

## 2. SDK CI namespace

- [x] 2.1 Add `sdk/src/namespaces/ci.types.ts` with `CiBindingRow`, `ParsedDelegation`, create/list/get/revoke inputs, ergonomic token-exchange input, token-exchange response, provider/action/event types, and error-code string unions.
- [x] 2.2 Add `sdk/src/namespaces/ci.ts` with `createBinding`, `listBindings`, `getBinding`, `revokeBinding`, and `exchangeToken` methods.
- [x] 2.3 Make `exchangeToken` accept only `project_id` and `subject_token`, fill RFC 8693 constants internally, send `withAuth: false`, and never include credential-provider auth headers.
- [x] 2.4 Register `readonly ci: Ci` in `sdk/src/index.ts` and export CI types/helpers from the root SDK entrypoint.
- [x] 2.5 Keep CI unscoped unless a project-scoped wrapper proves necessary and is covered by the scoped drift-protection test.
- [x] 2.6 Add SDK unit tests for all five wire methods, including URL, method, auth/no-auth behavior, request body, and returned typed rows.
- [x] 2.7 Add SDK tests preserving gateway response bodies for CI error codes such as `nonce_replay`, `invalid_token`, `event_not_allowed`, `repository_id_mismatch`, `forbidden_spec_field`, and `forbidden_plan`.

## 3. Canonical builders and validation

- [x] 3.1 Implement `buildCiDelegationStatement(values)` as a pure isomorphic SDK helper with LF newlines and exact gateway text.
- [x] 3.2 Implement `buildCiDelegationResourceUri(values)` with the required parameter order, RFC 3986 encoding, omitted nullable parameters, and literal commas for allowed-actions/events arrays.
- [x] 3.3 Implement normalization helpers for sorting/deduping allowed arrays, rendering `never` and `none-soft-bound`, and validating `allowed_actions` is `["deploy"]` in v1.
- [x] 3.4 Implement `validateCiSubjectMatch` for empty/control-character/length/wildcard rules while accepting literal punctuation.
- [x] 3.5 Implement nonce validation for lowercase hex length 16 to 64.
- [x] 3.6 Implement `assertCiDeployableSpec(specOrPlanBody)` for the gateway CI allowlist.
- [x] 3.7 Add golden-vector tests for Statement and Resource URI outputs from the gateway handoff.
- [x] 3.8 Add tests for nullable `expires_at`/`github_repository_id`, out-of-order arrays, duplicate arrays, invalid subject patterns, accepted literal punctuation, invalid nonce values, and CI deploy spec restrictions.

## 4. Node signing and CI credentials

- [x] 4.1 Refactor `core/src/allowance-auth.ts` to expose a generic SIWX header builder that accepts custom statement, URI, chain id, resources, issued/expiration times, and nonce.
- [x] 4.2 Preserve the existing `getAllowanceAuthHeaders(path)` behavior and tests for ordinary Run402 auth.
- [x] 4.3 Add `signCiDelegation(values, opts?)` in the Node SDK that reads the local allowance and signs a CI delegation using the canonical Statement and Resource URI builders.
- [x] 4.4 Add tests that the signed CI delegation payload includes exactly one Resource URI, uses the canonical Statement, targets `/ci/v1/bindings`, and fails actionably when no allowance exists.
- [x] 4.5 Add `createCiSessionCredentials` with an explicit CI marker and `Authorization: Bearer <session>` auth.
- [x] 4.6 Add `githubActionsCredentials({ projectId, apiBase?, audience?, refreshBeforeSeconds? })` that requests GitHub OIDC, exchanges it through `ci.exchangeToken`, caches the session, and refreshes from `expires_in`.
- [x] 4.7 Add tests proving CI credentials do not require real local `anon_key` or `service_key` for CI-callable routes and that unmarked custom Bearer providers are not treated as CI.

## 5. SDK deploy credential-driven CI support

- [x] 5.1 Add deploy internals that detect the CI credentials marker rather than public `ci` options or `r.ci.deployApply`.
- [x] 5.2 Run `assertCiDeployableSpec` before manifest sizing, CAS manifest upload, content planning, or deploy planning when CI credentials are active.
- [x] 5.3 Reject `spec.secrets`, `spec.subdomains`, `spec.routes`, `spec.checks`, and unknown future top-level fields by property presence, including empty objects/arrays.
- [x] 5.4 Reject `spec.base` values other than absent or exactly `{ release: "current" }`.
- [x] 5.5 Reject CI specs that would require non-null `manifest_ref` because the normalized plan body exceeds the inline body limit.
- [x] 5.6 Ensure content plan, content commit, deploy plan, deploy commit, operation status, operation events, and resume calls all use CI Bearer auth and never `apikey` when CI credentials are active.
- [x] 5.7 Fix or explicitly gate the `/storage/v1/uploads/:id/complete` path so CI deploy never calls a route that the gateway does not accept for CI sessions.
- [x] 5.8 Preserve non-CI deploy behavior for secrets, subdomains, current oversized-manifest upload, local apikey operation polling, and custom unmarked Bearer providers.
- [x] 5.9 Add deploy SDK unit tests for accepted CI specs, every forbidden field, non-current base, oversized manifest, no-key/no-apikey CI headers, non-CI preservation, and the storage-complete route audit.

## 6. CLI deploy runtime integration

- [x] 6.1 Update `run402 deploy apply` to detect GitHub Actions using `GITHUB_ACTIONS`, `ACTIONS_ID_TOKEN_REQUEST_URL`, `ACTIONS_ID_TOKEN_REQUEST_TOKEN`, and a project id from `--project`, manifest, active project, or `RUN402_PROJECT_ID`.
- [x] 6.2 In GitHub Actions, construct `githubActionsCredentials({ projectId })` and skip local allowance preflight.
- [x] 6.3 Preserve existing local deploy behavior and errors outside GitHub Actions.
- [x] 6.4 Map common CI errors to actionable CLI messages for invalid token, access denied, event mismatch, repository-id mismatch, forbidden spec fields, forbidden plan, and 402 tier/payment requirements.
- [x] 6.5 Add CLI tests proving GitHub Actions deploy uses OIDC credentials, sends no local keys, does not require an allowance file, and keeps local deploy behavior unchanged.

## 7. CLI CI setup command group

- [x] 7.1 Add `cli/lib/ci.mjs` and dispatch `run402 ci` from `cli/cli.mjs` help and switch logic.
- [x] 7.2 Implement argument parsing and help text for `run402 ci link github`.
- [x] 7.3 Infer GitHub `owner/repo` from `git remote get-url origin` and current branch from `git branch --show-current`, with `--repo`, `--branch`, and `--environment` overrides.
- [x] 7.4 Generate subject patterns only from branch or environment inputs; do not expose raw subject or wildcard flags in v1.
- [x] 7.5 Keep allowed events fixed to `push,workflow_dispatch`; do not expose PR deploy flags in v1.
- [x] 7.6 Fetch GitHub repository id from the GitHub API using `GITHUB_TOKEN` or `GH_TOKEN` when available, and fail with `--repository-id <id>` instructions if lookup fails.
- [x] 7.7 Generate nonce, canonical delegation values, signed delegation, and binding create request through the SDK/Node helper.
- [x] 7.8 Write `.github/workflows/run402-deploy.yml` or the requested workflow path, refusing to overwrite unless `--force` is passed.
- [x] 7.9 Generate workflow YAML that invokes `run402 deploy apply --manifest <manifest> --project <project>` and includes `permissions: id-token: write` and `contents: read`.
- [x] 7.10 Print successful link output with binding id, project id, subject, fixed events, repository-id status, workflow path, bootstrap caveat, consent summary, and revocation residuals.
- [x] 7.11 Implement `run402 ci list` and `run402 ci revoke` using SDK methods.
- [x] 7.12 Add CLI unit/e2e tests for help text, repo inference, subject generation, repository-id success/failure, workflow overwrite protection, generated workflow snapshots, list/revoke output, and structured SDK error reporting.

## 8. OpenClaw, sync coverage, and deferred MCP

- [x] 8.1 Add `openclaw/scripts/ci.mjs` re-exporting the CLI CI module.
- [x] 8.2 Update `sync.test.ts` SURFACE entries and `SDK_BY_CAPABILITY` mappings for every new SDK/CLI/OpenClaw capability.
- [x] 8.3 Update `SKILL.test.ts` required command checks and banned-regression coverage as needed.
- [x] 8.4 Update OpenClaw skill guidance for `run402 ci link github`, `run402 ci list`, and `run402 ci revoke`.
- [x] 8.5 Leave MCP tooling out of the v1 critical path, or create a follow-up proposal limited to high-level `ci_link_github`, `ci_list_bindings`, and `ci_revoke_binding`.

## 9. Documentation

- [x] 9.1 Update `sdk/README.md` with the `ci` namespace, canonical builders, Node signing helper, CI credentials provider, and credential-driven deploy behavior.
- [x] 9.2 Update `sdk/llms-sdk.txt` with full signatures, request/response shapes, token refresh semantics, golden-vector warnings, and CI deploy restrictions.
- [x] 9.3 Update `cli/README.md` with `run402 ci` quickstart and generated workflow example.
- [x] 9.4 Update `cli/llms-cli.txt` with every `run402 ci` subcommand, flag, output shape, omitted high-risk controls, and error/caveat.
- [x] 9.5 Update root `README.md` with a short GitHub Actions OIDC pattern and any tools/interface table changes.
- [x] 9.6 Update `openclaw/SKILL.md` with CLI CI command guidance and caveats.
- [x] 9.7 Update `AGENTS.md` for the new SDK namespace count and CI/OIDC architecture notes.
- [x] 9.8 Update `llms.txt` if CI/GitHub Actions becomes a wayfinder-level integration pattern.
- [x] 9.9 Update `documentation.md` for generated workflow docs and CI/OIDC update triggers if needed.
- [x] 9.10 Coordinate or make matching private-repo updates for `site/llms-full.txt`, `site/openapi.json`, `site/updates.txt`, and `site/humans/changelog.md`, or record that the private commit already covers the final released behavior.

## 10. Final validation

- [x] 10.1 Run `npm run build`.
- [x] 10.2 Run SDK unit tests covering the new CI namespace, builders, signing helper, credentials, and credential-driven deploy restrictions.
- [x] 10.3 Run CLI help/e2e tests, including new `run402 ci` snapshots and generated workflow snapshots.
- [x] 10.4 Run `npm run test:sync`.
- [x] 10.5 Run `npm run test:skill`.
- [x] 10.6 Run docs snippet/check tests, including `npm run test:docs` if relevant files changed.
- [ ] 10.7 Perform a fixture or real GitHub Actions smoke test: link binding, run `run402 deploy apply` in CI with OIDC, revoke binding, and confirm the next CI gateway request fails.
- [x] 10.8 Inspect `git diff` to ensure no unrelated user changes were reverted or folded into the CI/OIDC work.
