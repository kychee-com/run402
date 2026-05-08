## 1. Gateway Contract Confirmation

- [x] 1.1 Re-read private commit `511b938c405dd581476998ca6fffa581c568ce36` and capture the exact `route_scopes` request/response field shape, canonical Statement text, Resource URI parameter order, and `CI_ROUTE_SCOPE_DENIED` error envelope.
- [x] 1.2 Confirm whether private gateway accepts `spec.routes: null` for CI bindings without route scopes or treats it as absent, and mirror that behavior in SDK preflight tests.
- [x] 1.3 Confirm the route-scope validation rules against private `route-state.ts` so SDK validation rejects the same syntactic mistakes without attempting gateway-only diff authorization.

## 2. SDK CI Types And Helpers

- [x] 2.1 Add `route_scopes` to `CiCreateBindingInput`, `CiBindingRow`, `CiDelegationValues`, and `NormalizedCiDelegationValues`.
- [x] 2.2 Implement route-scope normalization and validation for exact and final-wildcard route patterns.
- [x] 2.3 Update `ci.createBinding` to send normalized `route_scopes` only through the SDK request path.
- [x] 2.4 Export route-scope types/helpers from `@run402/sdk` and `@run402/sdk/node` according to the public type surface contract.
- [x] 2.5 Add SDK CI namespace tests for create/list/get/revoke rows with `route_scopes`.
- [x] 2.6 Add public type export tests for any new route-scope helper or public type.

## 3. Canonical Delegation Bytes

- [x] 3.1 Update `normalizeCiDelegationValues` so omitted or empty `route_scopes` normalizes to an empty array without changing existing unscoped canonical bytes.
- [x] 3.2 Update `buildCiDelegationStatement` to emit the scoped route disclosure only when route scopes are present.
- [x] 3.3 Update `buildCiDelegationResourceUri` to insert `route_scopes` after `allowed_events` only when route scopes are present.
- [x] 3.4 Update `signCiDelegation` tests to prove scoped delegations include exactly the scoped Statement and Resource URI.
- [x] 3.5 Add golden-vector tests for unscoped backward compatibility and scoped delegation output.

## 4. CI Deploy Preflight And Error Guidance

- [x] 4.1 Update `assertCiDeployableSpec` to allow `routes: undefined`, `routes: null`, and non-null route resources for CI-marked credentials while preserving all non-route CI restrictions.
- [x] 4.2 Keep CI rejection for non-null `manifest_ref` and for normalized specs that exceed the inline body limit.
- [x] 4.3 Add SDK deploy tests proving scoped route manifests reach `/deploy/v2/plans` instead of failing local preflight.
- [x] 4.4 Add SDK deploy tests proving secrets, subdomains, checks, unknown fields, non-current base, and oversized manifest escape hatch still fail locally.
- [x] 4.5 Add CLI and MCP error guidance for `CI_ROUTE_SCOPE_DENIED` that points to re-linking with covering route scopes or deploying locally.

## 5. CLI Thin Wrapper DX

- [x] 5.1 Add repeatable `--route-scope <pattern>` parsing to `run402 ci link github`.
- [x] 5.2 Update `run402 ci link github --help` to describe route scopes, exact/prefix examples, and no-scope default behavior.
- [x] 5.3 Pass route scopes into `signCiDelegation` and `getSdk().ci.createBinding` without duplicating SDK canonical builder logic.
- [x] 5.4 Include normalized `route_scopes` in successful link JSON output and preserve route scopes in list/revoke output.
- [x] 5.5 Update CLI tests for help text, repeatable flag parsing, scoped binding create body, no-scope default, and structured output.
- [x] 5.6 Update deploy CLI CI restriction text and common error guidance for scoped routes and `CI_ROUTE_SCOPE_DENIED`.

## 6. MCP And OpenClaw Wrappers

- [x] 6.1 Add MCP tool handlers for direct CI binding SDK methods: create, list, get, and revoke.
- [x] 6.2 Register MCP tools in `src/index.ts` with descriptions that explain optional `route_scopes` and the signed-delegation boundary.
- [x] 6.3 Add MCP tests proving each CI binding tool calls the SDK and preserves returned `route_scopes`.
- [x] 6.4 Update `sync.test.ts` SURFACE and SDK mappings for MCP CI binding tools without adding token-exchange or CI deploy wrapper tools.
- [x] 6.5 Confirm `openclaw/scripts/ci.mjs` remains a CLI re-export and update OpenClaw guidance for `--route-scope`.

## 7. Documentation And Skills

- [x] 7.1 Update `README.md` CI section to explain optional route scopes and no-scope behavior.
- [x] 7.2 Update `cli/llms-cli.txt` with `--route-scope`, scoped CI route deploy rules, and `CI_ROUTE_SCOPE_DENIED` recovery.
- [x] 7.3 Update `SKILL.md` and `openclaw/SKILL.md` so agents no longer learn that CI always forbids routes.
- [x] 7.4 Update SDK docs or llms surfaces that describe CI builders, binding rows, and CI deploy restrictions.
- [x] 7.5 Update MCP descriptions/docs if MCP CI tools are added.
- [x] 7.6 Update documentation drift tests so route docs require scoped CI route delegation language.

## 8. Validation

- [x] 8.1 Run focused SDK tests for CI builders, CI namespace, public exports, and credential-driven deploy preflight.
- [x] 8.2 Run CLI help/e2e tests covering `run402 ci` and deploy CI errors.
- [x] 8.3 Run MCP tool tests for CI wrappers if added.
- [x] 8.4 Run `npm run test:sync`.
- [x] 8.5 Run `npm run test:skill`.
- [x] 8.6 Run `npm run build`.
- [x] 8.7 Inspect `git diff` to ensure the implementation is scoped to the OpenSpec change and does not revert unrelated user work.
