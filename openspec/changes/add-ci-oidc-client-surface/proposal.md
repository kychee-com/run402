## Why

The gateway now supports GitHub Actions OIDC federation for push-to-deploy, but the public SDK and CLI do not expose the new `/ci/v1/*` contract. Without a small client surface, users still have to put long-lived wallet, allowance, anon, or service credentials in CI, which defeats the security goal of the backend feature.

The product goal is deliberately narrow: **link once locally, then GitHub Actions runs the existing `run402 deploy apply` flow using OIDC and no run402 secrets.**

## What Changes

- Add an SDK `ci` namespace for binding CRUD and ergonomic token exchange.
- Add SDK canonical delegation Statement and Resource URI builders with gateway golden-vector tests.
- Add a Node signing helper that signs the canonical CI delegation with the local allowance wallet during local setup.
- Add CI-session credentials helpers, including a GitHub Actions helper that requests GitHub OIDC, exchanges it for a run402 session, refreshes from `expires_in`, and never sends token-exchange auth headers.
- Make the existing deploy SDK work with CI-session credentials automatically: `r.deploy.apply(spec)` remains the public API, but CI-marked credentials trigger preflight restrictions, Bearer auth, and no local project-key fallback.
- Add `run402 ci link github`, `run402 ci list`, and `run402 ci revoke`; generated workflow YAML runs the existing `run402 deploy apply` command.
- Add OpenClaw parity for the CLI command group.
- Update documentation surfaces flagged by `documentation.md` for the new SDK/CLI/OpenClaw behavior, security caveats, and generated workflow expectations.
- Defer broad MCP tooling, a separate GitHub Action package, PR deploy flags, raw subject/wildcard UX, soft-binding UX, token-exchange debug commands, and workflow-only commands.
- No breaking changes to existing deploy, project, or payment flows.

## Capabilities

### New Capabilities

- `ci-oidc-client-surface`: Typed client support for `/ci/v1/*`, canonical delegation construction, token exchange, CI-session credentials, credential-driven deploy preflight restrictions, and deploy-kernel behavior needed to run without long-lived local credentials.
- `ci-github-actions-dx`: User-facing GitHub Actions DX across the minimal CLI flow, OpenClaw parity, generated workflow behavior, revoke messaging, and documentation.

### Modified Capabilities

- None.

## Impact

- **SDK**: new namespace/types/tests, root and `/node` exports, canonical builder golden-vector tests, Node signing helper, CI credentials helpers, deploy-kernel credential marker and preflight tests.
- **CLI/OpenClaw**: new `ci` command group with `link github`, `list`, `revoke`; dispatch/help/e2e updates; workflow YAML generation; GitHub repository detection; required stable repository-id lookup or explicit `--repository-id`.
- **MCP**: not in the v1 critical path. If parity is required later, add only high-level `ci_link_github`, `ci_list_bindings`, and `ci_revoke_binding`.
- **Docs**: update `documentation.md` checklist surfaces: `README.md`, `AGENTS.md`, `openclaw/SKILL.md`, `cli/README.md`, `cli/llms-cli.txt`, `sdk/README.md`, `sdk/llms-sdk.txt`, `llms.txt` if this becomes a wayfinder pattern, and private-repo docs/changelog if final released behavior differs from the backend handoff.
- **Tests**: `npm run build`, SDK unit tests, deploy CI-route tests, CLI help/e2e tests, OpenClaw/sync coverage, docs checks, and a fixture or real GitHub Actions OIDC smoke path.
- **Dependencies**: prefer existing core EIP-191/SIWX signing code. Add new dependencies only if the existing signer cannot produce the required Resources-bearing delegation shape safely.
