## 1. Contract Alignment

- [x] 1.1 Re-read private commits `01929adf`, `59199795`, `9855a977`, `31b4848b`, and `b393d752` plus the public handoff to confirm the final gateway wire shape.
- [x] 1.2 Confirm/update the SDK `secrets.set` endpoint path/body: `POST /projects/v1/admin/{id}/secrets` with `{ key, value }`.
- [x] 1.3 Review `documentation.md` and list every public doc/help/skill surface that mentions deploy secrets, secret listing, deploy warnings, CI deploy manifests, or legacy bundle deploy.
- [x] 1.4 Record related issue context in the implementation notes: #151, #225, #10, and #198.

## 2. SDK Types and Deploy Behavior

- [x] 2.1 Update `sdk/src/namespaces/deploy.types.ts` so `SecretsSpec` contains only `require?: string[]` and `delete?: string[]`.
- [x] 2.2 Add and export gateway-exact `WarningEntry` with `severity`/`confidence` enums `low | medium | high`; add `warnings: WarningEntry[]` to `PlanResponse` and `DeployResult`.
- [x] 2.3 Add a `DeployEvent` variant `{ type: "plan.warnings"; warnings: WarningEntry[] }` and emit it when `plan.warnings` is non-empty.
- [x] 2.4 Normalize missing `plan.warnings` to `[]` in SDK internals for older fixtures while typing it as always present.
- [x] 2.5 Update SDK deploy validation to reject `secrets.set`, `secrets.replace_all`, unknown secret fields, invalid key names, duplicate keys, and require/delete conflicts before uploads or plan creation.
- [x] 2.6 Define and implement `deploy.apply` warning policy: abort before content upload/commit on `requires_confirmation` or `MISSING_REQUIRED_SECRET` unless an explicit apply option allows continuing; include warnings on the structured error.
- [x] 2.7 Update `normalizeReleaseSpec`, scoped deploy wrappers, root exports, `/node` exports, and tests to use the new secret shape.
- [x] 2.8 Update CI deploy preflight so any `spec.secrets` presence remains forbidden under CI credentials, with special messaging for old value-bearing fields.
- [x] 2.9 Update `sdk/src/namespaces/secrets.ts` for the shipped set route, 128-char key validation, 4 KiB UTF-8 value validation, raw-array/envelope list normalization, and `value_hash` stripping.
- [x] 2.10 Update `sdk/src/namespaces/apps.ts` legacy `bundleDeploy` translation so legacy in-memory `opts.secrets` pre-set via the secrets API and convert keys to `require`; legacy `replace_all` fails; warnings survive `BundleDeployResult`.

## 3. CLI, MCP, and OpenClaw Surfaces

- [x] 3.1 Update `cli/lib/deploy-v2.mjs` help, manifest examples, and manifest mapping for `secrets.require` and `secrets.delete`.
- [x] 3.2 Make CLI file/inline manifests with `secrets.set` or `secrets.replace_all` fail with migration guidance rather than silently pre-setting values.
- [x] 3.3 Update legacy CLI deploy/bundle paths so they do not emit `secrets.set` or `replace_all` in the v2 `ReleaseSpec`.
- [x] 3.4 Update `cli/lib/secrets.mjs` help, set route assumptions, 4 KiB/key validation messaging, and list output to remove `value_hash` language and hash columns.
- [x] 3.5 Update CLI deploy result stdout and error output to include structured warnings and missing-secret next actions.
- [x] 3.6 Update `src/tools/deploy.ts` MCP schema to accept only `require` and `delete` under `secrets`, abort on confirmation-required warnings, and render warnings in markdown.
- [x] 3.7 Update `src/tools/list-secrets.ts` output to show key/timestamp secret listings with no hash explanation.
- [x] 3.8 Update `src/tools/bundle-deploy.ts` and related legacy MCP handlers so secret values are pre-set out-of-band or rejected with a next-action message; `replace_all` fails.
- [x] 3.9 Update MCP tool descriptions in `src/index.ts` so agents learn the safe sequence: `set_secret`, then `deploy` with `secrets.require`.
- [x] 3.10 Update OpenClaw command guidance to match the CLI value-free deploy and CI-omits-secrets contract.

## 4. Documentation and Drift Gates

- [x] 4.1 Update `AGENTS.md`, `README.md`, `sdk/README.md`, `sdk/llms-sdk.txt`, `cli/README.md`, `cli/llms-cli.txt`, `llms.txt`, `llms-mcp.txt`, `SKILL.md`, and `openclaw/SKILL.md` with the new two-step secret workflow.
- [x] 4.2 Document gateway-exact `WarningEntry`, `MISSING_REQUIRED_SECRET`, `DeployResult.warnings`, and the default apply-abort behavior in SDK/CLI/MCP agent-facing docs.
- [x] 4.3 Document that `list_secrets` is key-only and cannot verify a value by hash.
- [x] 4.4 Document `secrets.require[]` as a dependency gate only, not an injection allowlist; document `secrets.delete[]`, unknown delete hard errors, key regex, and require/delete conflict behavior.
- [x] 4.5 Document that local deploys may use `secrets.require`, but GitHub Actions OIDC manifests must omit all `secrets`.
- [x] 4.6 Document the residual runtime exposure: deployed functions still receive secrets as environment variables.
- [x] 4.7 Update `sync.test.ts`, `SKILL.test.ts`, and help snapshots so drift tests fail on the old value-bearing deploy contract.
- [x] 4.8 Add a context-aware doc drift assertion that bans deploy-manifest `"secrets": { "set": ... }`, `replace_all`, and `value_hash`, while allowing `r.secrets.set`, `run402 secrets set`, and `set_secret`.
- [x] 4.9 Track or coordinate matching private docs/changelog updates for `site/openapi.json`, `site/llms-full.txt`, `site/updates.txt`, and `site/humans/changelog.html` if needed.

## 5. Test Coverage

- [x] 5.1 Add SDK deploy runtime tests for accepted `require`/`delete`, rejected `set`/`replace_all`, key validation, duplicate/conflict rejection, warning normalization, `plan.warnings` event emission, apply abort on confirmation-required warnings, opt-in continuation, and final `DeployResult.warnings`.
- [x] 5.2 Add SDK type tests with `@ts-expect-error` proving `ReleaseSpec.secrets.set`, `replace_all`, and `SecretSummary.value_hash` are no longer typed.
- [x] 5.3 Add SDK secrets tests for the new set route/body, 4 KiB/key validation, raw-array list responses, legacy envelope list responses, and `value_hash` stripping.
- [x] 5.4 Add `apps.bundleDeploy` tests covering legacy in-memory secret options, rejected replace-all, warnings preservation, and proof no value-bearing `ReleaseSpec` reaches `deploy.apply`.
- [x] 5.5 Add CLI help/e2e tests for value-free manifest examples, old-shape manifest failure messaging, key-only `secrets list`, warning output, and CI manifest-with-secrets rejection.
- [x] 5.6 Add MCP tests for the new deploy schema, `list_secrets` markdown, warning display/abort behavior, and legacy bundle secret handling.

## 6. Validation

- [x] 6.1 Run `npm run build`.
- [x] 6.2 Run focused SDK unit tests for deploy, secrets, apps, scoped client, and CI preflight.
- [x] 6.3 Run focused MCP tool tests for deploy and secrets.
- [x] 6.4 Run CLI help/e2e tests that cover deploy and secrets.
- [x] 6.5 Run `npm run test:sync` and `npm run test:skill`.
- [x] 6.6 Run a final context-aware repository scan for stale old-contract strings and inspect the diff to confirm no unrelated user changes were reverted.
