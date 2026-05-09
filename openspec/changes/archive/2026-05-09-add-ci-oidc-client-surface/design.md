## Context

Private gateway commit `b17431da` shipped CI/CD OIDC federation on the backend: five `/ci/v1/*` endpoints for binding CRUD and token exchange, plus CI-session auth on a constrained deploy/content route set. The public repo currently has no SDK namespace, CLI command group, OpenClaw command, or docs for that contract.

The existing public architecture matters:

- The SDK request kernel is the shared typed client for SDK consumers, CLI, MCP, and OpenClaw.
- The SDK deploy namespace already drives the CAS + deploy-v2 flow, but upload/polling currently prefer local project keys via `apikeyHeaders`.
- The deploy code currently calls `/storage/v1/uploads/:id/complete` while promoting CAS upload sessions; that route is not listed in the gateway handoff's seven CI-callable routes and must be audited before CI deploy can be considered end-to-end safe.
- The Node credential provider signs ordinary SIWX headers from the local allowance using `core/src/allowance-auth.ts`, with a fixed "Sign in to Run402" statement and no Resources field.
- CLI and MCP are thin shims over SDK calls, and `sync.test.ts` is the drift gate for SDK/CLI/OpenClaw parity.
- `documentation.md` is the doc update checklist and must drive the documentation work.

The KISS product shape is: **a developer or coding agent runs one local link command, commits the generated workflow, and GitHub Actions later runs the existing `run402 deploy apply` command with OIDC-derived credentials and no run402 secrets.**

## Goals / Non-Goals

**Goals:**

- Expose typed SDK support for all five `/ci/v1/*` endpoints.
- Build the canonical CI delegation Statement and Resource URI byte-for-byte with the gateway contract, with golden-vector tests.
- Provide Node signing support that uses the local allowance wallet to create the `signed_delegation` for `POST /ci/v1/bindings`.
- Provide CI-session credentials helpers that let existing `r.deploy.apply(spec)` and `run402 deploy apply` work inside GitHub Actions without public CI-mode flags.
- Reject CI-forbidden deploy spec fields client-side before uploads or gateway calls.
- Add only three CLI setup/management commands in v1: `run402 ci link github`, `run402 ci list`, and `run402 ci revoke`.
- Generate workflow YAML that invokes existing `run402 deploy apply`.
- Add OpenClaw parity for the CLI command group.
- Update docs required by `documentation.md`.

**Non-Goals:**

- No gateway/database changes; the backend contract is treated as shipped by private commit `b17431da`.
- No separate GitHub Action package/entrypoint in v1.
- No public `run402 ci workflow`, `run402 ci exchange`, `r.ci.deployApply`, `deploy --ci`, or `deploy.apply(..., { ci: true })` surface.
- No direct CI support for secrets, domains, subdomains, lifecycle, billing, contracts, faucet, or `manifest_ref`.
- No PR deploy UX in v1; allowed events stay fixed to `push` and `workflow_dispatch`.
- No raw subject/wildcard CLI UX in v1; subjects are generated from branch or environment inputs.
- No soft-binding `--no-repository-id` UX in v1; repository id is fetched or supplied explicitly.
- No broad MCP lifecycle/workflow tooling in the first slice.
- No non-GitHub OIDC provider UX in v1.
- No non-EVM wallet support in v1.
- No attempt to hide the runtime-authority/database-authority consent text.
- No remote GitHub mutation beyond writing a local workflow file; environment protection rules remain a user/GitHub configuration step.

## Decisions

### D1. SDK owns the wire contract first

Add `sdk/src/namespaces/ci.ts` and `ci.types.ts`, register `this.ci = new Ci(client)` in `Run402`, and export the related types/functions from the root SDK entrypoint. The namespace methods:

- `ci.createBinding(input)` -> `POST /ci/v1/bindings`
- `ci.listBindings({ project })` -> `GET /ci/v1/bindings?project=...`
- `ci.getBinding(id)` -> `GET /ci/v1/bindings/:id`
- `ci.revokeBinding(id)` -> `POST /ci/v1/bindings/:id/revoke`
- `ci.exchangeToken({ project_id, subject_token })` -> `POST /ci/v1/token-exchange` with `withAuth: false`

`exchangeToken` fills the RFC 8693 constants internally:

- `grant_type: "urn:ietf:params:oauth:grant-type:token-exchange"`
- `subject_token_type: "urn:ietf:params:oauth:token-type:jwt"`

Alternatives considered:

- Put methods under `projects`: rejected because bindings are provider/federation resources, not project admin operations.
- Implement CLI directly against `fetch`: rejected because it would bypass the SDK kernel and create drift with OpenClaw/MCP.
- Require callers to pass the RFC constants: rejected as needless ceremony for coding agents.

### D2. Canonical builders are pure SDK exports, signing is Node-only

Implement pure isomorphic helpers in the SDK:

- `buildCiDelegationStatement(values)`
- `buildCiDelegationResourceUri(values)`
- `normalizeCiDelegationValues(values)` for sorting/deduping arrays and rendering `never` / `none-soft-bound`
- `validateCiSubjectMatch(pattern)`
- `assertCiDeployableSpec(specOrPlanBody)`

Then add Node/core signing support:

- Extend `core/src/allowance-auth.ts` with a reusable SIWX header builder that accepts `statement`, `uri`, `resources`, `chainId`, and an optional top-level SIWX nonce.
- Preserve the existing `getAllowanceAuthHeaders(path)` behavior by calling the generic builder with the current "Sign in to Run402" statement.
- Add a Node SDK helper `signCiDelegation(values, opts?)` that reads the local allowance and returns the base64 SIWX header value for the binding body.

The canonical Statement and Resource URI format are gateway-verification material. The SDK tests must include the gateway letter's golden vector for both outputs.

Alternatives considered:

- Add `@x402/extensions/sign-in-with-x` to the public SDK: acceptable only if needed, but start from the existing core signer because it is already compatible with gateway SIWX auth and avoids another runtime dependency in the isomorphic entrypoint.
- Keep builders CLI-local: rejected because external SDK consumers and future MCP tools need the same byte-stable implementation.

### D3. CI deploy is credential-driven, not a public mode

Do not expose public CI deploy flags or wrapper methods. The public APIs stay boring:

```ts
const r = new Run402({
  apiBase,
  credentials: githubActionsCredentials({ projectId }),
});

await r.deploy.apply(spec);
```

and in the generated workflow:

```bash
npx -y run402@<current-version> deploy apply --manifest run402.deploy.json --project prj_...
```

CI credentials are explicit at the credential-provider layer. `createCiSessionCredentials(...)` and `githubActionsCredentials(...)` mark the provider as CI-session credentials, for example via a non-enumerable symbol or typed optional marker on the provider. Deploy internals use that marker to:

- run `assertCiDeployableSpec` before manifest sizing, content planning, uploading, or `/deploy/v2/plans`;
- reject `spec.secrets`, `spec.subdomains`, `spec.routes`, `spec.checks`, unknown future top-level fields, non-current `spec.base`, and non-null `manifest_ref` by property presence;
- reject specs that would require the SDK's oversized-manifest `manifest_ref` escape hatch;
- send `Authorization: Bearer <ci-session>` on every CI-callable route;
- avoid local `anon_key`/`service_key` requirements and `apikey` fallback in CI;
- refuse to treat arbitrary custom Bearer providers as CI unless they use the CI credentials helper or marker.

`githubActionsCredentials({ projectId, apiBase?, audience?, refreshBeforeSeconds? })` should:

1. request a GitHub OIDC JWT from `ACTIONS_ID_TOKEN_REQUEST_URL` and `ACTIONS_ID_TOKEN_REQUEST_TOKEN` with audience `https://api.run402.com`;
2. call `ci.exchangeToken({ project_id: projectId, subject_token })` with no Authorization header;
3. cache the returned run402 session;
4. refresh from returned `expires_in` with a cushion, never assuming 900 seconds.

Alternatives considered:

- `deploy.apply(spec, { ci: true })` or `run402 deploy apply --ci`: rejected because it creates new DX users must learn even though credentials already determine auth.
- `r.ci.deployApply(...)`: rejected because it forks the deploy primitive and invites drift.
- Infer CI mode from any Bearer token: rejected because ordinary Bearer user tokens exist elsewhere. The provider must be CI-marked.
- Let the gateway reject forbidden specs: rejected because it can happen after local hashing/uploads, producing poor DX and possible presigned URL residuals.

### D4. CLI command shape is the minimum setup surface

Add `cli/lib/ci.mjs` and dispatch it from `cli/cli.mjs` as `run402 ci ...`. V1 subcommands:

```txt
run402 ci link github [--project <id>] [--repo <owner/name>] [--branch <branch>] [--environment <name>] [--repository-id <id>] [--workflow <path>] [--manifest <path>] [--expires-at <iso>] [--force]
run402 ci list [--project <id>]
run402 ci revoke <binding_id>
```

Defaults:

- `--project`: active project
- `--repo`: inferred from `git remote get-url origin`
- `--branch`: current branch from `git branch --show-current`
- subject: `repo:<owner>/<repo>:ref:refs/heads/<branch>`
- if `--environment production`: subject becomes `repo:<owner>/<repo>:environment:production`, and workflow job includes `environment: production`
- `allowed_events`: fixed `["push","workflow_dispatch"]`
- `allowed_actions`: fixed `["deploy"]`
- `--workflow`: `.github/workflows/run402-deploy.yml`
- `--manifest`: `run402.deploy.json`
- `--expires-at`: omitted/null
- repository id: fetched from GitHub API, or supplied explicitly via `--repository-id`
- overwrite workflow: refuse unless `--force`

`link github` should:

1. resolve the project from `--project` or active project;
2. infer `owner/repo` and current branch unless provided;
3. choose branch or environment subject from those structured inputs;
4. fetch `github_repository_id` from `GET https://api.github.com/repos/{owner}/{repo}` using `GITHUB_TOKEN`/`GH_TOKEN` when present; if lookup fails, fail with instructions to pass `--repository-id <id>`;
5. generate a lowercase hex nonce, build canonical values, sign the delegation with the local allowance wallet, and create the binding through the SDK;
6. write workflow YAML that invokes existing `run402 deploy apply`;
7. print binding id, subject, allowed events, repository-id status, workflow path, bootstrap limits, runtime/database authority consent summary, and revocation residuals.

Alternatives considered:

- `deploy ci link`: rejected because binding lifecycle needs list/revoke siblings.
- `ci show`: deferred because list can include the operational fields agents need; raw audit payloads are SDK-accessible.
- `ci workflow`: rejected because workflow generation without binding creates too many half-configured states.
- `ci exchange`: rejected because token exchange is runtime plumbing for GitHub Actions and tests, not agent DX.
- Raw `--subject`, wildcard, PR event, and soft-binding flags: rejected for v1 because they are high-risk footguns and unnecessary for the common agent path.

### D5. Generated workflow uses the existing CLI

Do not ship a separate GitHub Action package in v1. The generated workflow installs/runs the published CLI and relies on `run402 deploy apply` auto-detecting GitHub Actions OIDC:

```yaml
name: run402 deploy

on:
  push:
    branches: ["main"]
  workflow_dispatch:

permissions:
  id-token: write
  contents: read

jobs:
  deploy:
    runs-on: ubuntu-latest
    # environment: production  # only when --environment was used
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "22"
      - name: Deploy to run402
        run: npx -y run402@<current-version> deploy apply --manifest run402.deploy.json --project prj_...
        env:
          RUN402_PROJECT_ID: prj_...
```

The deploy CLI path should:

- detect GitHub Actions by checking `GITHUB_ACTIONS`, `RUN402_PROJECT_ID` or `--project`, and `ACTIONS_ID_TOKEN_REQUEST_URL/TOKEN`;
- use `githubActionsCredentials({ projectId })`;
- skip local allowance preflight in CI;
- keep ordinary local deploy behavior unchanged outside GitHub Actions.

Alternatives considered:

- A separate `action.yml`/JS action: deferred. It adds packaging, docs, versioning, and another runtime surface before the CLI path is proven.
- Handwritten workflow token exchange: rejected because coding agents should not copy token-exchange plumbing into user repos.

### D6. OpenClaw mirrors CLI; MCP is deferred or high-level only

OpenClaw gets `openclaw/scripts/ci.mjs` re-exporting the CLI module and matching skill docs. This is cheap because OpenClaw is CLI-shaped.

MCP is not part of the first critical path. Repo inference, workflow writing, and consent signing are CLI-native and coding agents with shell can run `run402 ci link github`. If MCP parity becomes mandatory after SDK/CLI stabilize, expose only:

- `ci_link_github`
- `ci_list_bindings`
- `ci_revoke_binding`

Do not expose separate MCP tools for raw create binding, workflow-only generation, token exchange, PR deploy enablement, or raw subject/wildcard setup.

Alternatives considered:

- Full MCP lifecycle/workflow tools: rejected for v1 as interface sprawl that duplicates CLI setup and increases docs/sync burden.

### D7. Documentation is part of the implementation

Use `documentation.md` as the checklist. Minimum public updates:

- `cli/README.md` and `cli/llms-cli.txt`: complete `run402 ci` command/flag reference and generated workflow behavior.
- `openclaw/SKILL.md`: CLI command guidance.
- `sdk/README.md` and `sdk/llms-sdk.txt`: `ci` namespace, builders, Node signing helper, CI credentials providers, deploy credential-marker behavior, and preflight restrictions.
- `README.md`: short GitHub Actions OIDC pattern.
- `AGENTS.md`: SDK namespace count and CI/OIDC architecture note.
- `llms.txt`: mention GitHub Actions OIDC if it becomes a recommended integration pattern.
- `documentation.md`: add/update triggers for generated workflow docs if needed.

Private repo coordination remains necessary for `site/llms-full.txt`, `site/openapi.json`, `site/updates.txt`, and `site/humans/changelog.md` if final released behavior differs from the backend handoff.

## Risks / Trade-offs

[Risk: builder drift causes production binding creation to fail] -> Mitigation: golden-vector tests copied from the gateway handoff; keep one exported SDK builder used by CLI and docs snippets.

[Risk: generated workflow grants more than the user understands] -> Mitigation: print and document runtime-authority/database-authority consent; default to branch or explicit environment subjects; keep events fixed to `push,workflow_dispatch`.

[Risk: repository slug reuse if repository id lookup fails] -> Mitigation: require stable `github_repository_id` by default; fail with `--repository-id` instructions when lookup fails.

[Risk: CI deploy uploads content before failing on forbidden fields] -> Mitigation: run CI deploy preflight before manifest sizing, content planning, or uploads.

[Risk: deploy kernel uses a non-CI-callable route] -> Mitigation: audit and fix `/storage/v1/uploads/:id/complete` in unified deploy before CI deploy ships, either by confirming gateway CI auth support or routing CAS promotion through CI-callable content endpoints only.

[Risk: deploy kernel accidentally falls back to local keys in CI] -> Mitigation: CI credentials provider returns Bearer auth for every CI path; tests assert CI deploy sends no `apikey` and does not require anon/service keys.

[Risk: token expiry during long deploys] -> Mitigation: token provider tracks `expires_in` and refreshes with a cushion; never assume 900 seconds.

[Risk: arbitrary Bearer providers trigger CI restrictions unexpectedly] -> Mitigation: only CI credentials helpers set the CI marker; custom Bearer providers behave like ordinary providers unless explicitly wrapped.

## Migration Plan

1. Implement SDK namespace, pure builders, and token-exchange ergonomics with unit tests.
2. Implement Node signing helper in core/Node SDK while preserving existing allowance auth behavior.
3. Implement CI credentials helpers and GitHub Actions OIDC token retrieval.
4. Implement deploy credential-marker support, CI preflight, no-key/no-apikey CI behavior, and the `/storage/v1/uploads/:id/complete` audit/fix.
5. Make `run402 deploy apply` auto-use GitHub Actions credentials when running in GitHub Actions with a project id.
6. Implement CLI `ci link github`, `ci list`, and `ci revoke`, plus generated workflow tests.
7. Add OpenClaw re-export and skill updates.
8. Update public docs from `documentation.md`, then coordinate private docs/changelog updates if needed.
9. Run `npm run build`, SDK tests, `npm run test:sync`, CLI help/e2e tests, OpenClaw/skill tests, docs checks, and a fixture or real GitHub Actions smoke path.

Rollback is normal package rollback: no database migration is introduced in this repo. Existing deploy/payment/project flows remain unchanged if the new `ci` surface is unused.

## Open Questions

- Should the default delegation chain id remain the current Base Sepolia SIWX default (`eip155:84532`) or switch based on API base/payment rail to `eip155:8453` for production?
- Should MCP remain fully deferred for v1, or should a follow-up add only `ci_link_github`, `ci_list_bindings`, and `ci_revoke_binding` after the CLI path is stable?
