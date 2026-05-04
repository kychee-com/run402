## 1. Contract Alignment

- [ ] 1.1 Re-read private commits `01929adf`, `59199795`, `9855a977`, `31b4848b`, and `b393d752` plus any public handoff notes to confirm the final gateway wire shape.
- [ ] 1.2 Review `documentation.md` and list every public doc/help/skill surface that mentions deploy secrets, secret listing, or deploy warnings.
- [ ] 1.3 Record related issue context in the implementation notes: #151, #225, #10, and #198.

## 2. SDK Types and Deploy Behavior

- [ ] 2.1 Update `sdk/src/namespaces/deploy.types.ts` so `SecretsSpec` contains only `require?: string[]` and `delete?: string[]`.
- [ ] 2.2 Add and export `WarningEntry`; add `warnings: WarningEntry[]` to `PlanResponse` and carry warnings onto `DeployResult`.
- [ ] 2.3 Add a `DeployEvent` variant for plan warnings and emit it when `plan.warnings` is non-empty.
- [ ] 2.4 Update SDK deploy validation to reject `secrets.set` and `secrets.replace_all` locally with structured `INVALID_SPEC` errors before uploads or plan creation.
- [ ] 2.5 Validate `require` and `delete` key arrays with the same uppercase secret-key rules used by the public secrets API, including a clear error for the same key in both arrays.
- [ ] 2.6 Update `normalizeReleaseSpec`, scoped deploy wrappers, root exports, `/node` exports, and tests to use the new secret shape.
- [ ] 2.7 Update CI deploy preflight so any `spec.secrets` presence is still rejected by CI credentials, but the rejection references the new value-free shape accurately.
- [ ] 2.8 Remove `value_hash` from `sdk/src/namespaces/secrets.ts` and update SDK secrets tests for key-only listing.
- [ ] 2.9 Update `sdk/src/namespaces/apps.ts` legacy `bundleDeploy` translation so legacy `opts.secrets` never becomes `ReleaseSpec.secrets.set`; pre-set via the secrets API and convert keys to `require`, or return an actionable structured error.

## 3. CLI, MCP, and OpenClaw Surfaces

- [ ] 3.1 Update `cli/lib/deploy-v2.mjs` help, manifest examples, and manifest mapping for `secrets.require` and `secrets.delete`.
- [ ] 3.2 Update legacy CLI deploy/bundle paths that accept secret values so they do not emit `secrets.set` or `replace_all` in the v2 `ReleaseSpec`.
- [ ] 3.3 Update `cli/lib/secrets.mjs` help and list output to remove `value_hash` language and hash columns.
- [ ] 3.4 Update `src/tools/deploy.ts` MCP schema to accept only `require` and `delete` under `secrets`.
- [ ] 3.5 Update `src/tools/list-secrets.ts` output to show key-only secret listings with no hash explanation.
- [ ] 3.6 Update `src/tools/bundle-deploy.ts` and related legacy MCP handlers so secret values are pre-set out-of-band or rejected with a next-action message.
- [ ] 3.7 Update MCP tool descriptions in `src/index.ts` so agents learn the safe sequence: `set_secret`, then `deploy` with `secrets.require`.
- [ ] 3.8 Update OpenClaw command guidance to match the CLI value-free deploy contract.

## 4. Documentation and Drift Gates

- [ ] 4.1 Update `README.md`, `sdk/README.md`, `sdk/llms-sdk.txt`, `cli/README.md`, `cli/llms-cli.txt`, `llms.txt`, `SKILL.md`, and `openclaw/SKILL.md` with the new two-step secret workflow.
- [ ] 4.2 Document `WarningEntry` and `MISSING_REQUIRED_SECRET` in SDK/CLI/MCP agent-facing docs.
- [ ] 4.3 Document that `list_secrets` is key-only and cannot verify a value by hash.
- [ ] 4.4 Document the residual runtime exposure: deployed functions still receive secrets as environment variables.
- [ ] 4.5 Update `sync.test.ts`, `SKILL.test.ts`, and help snapshots so drift tests fail on the old value-bearing contract.
- [ ] 4.6 Add a targeted `rg`-style test or assertion that agent-facing docs no longer present `secrets.set`, `secrets.replace_all`, or `value_hash` as supported deploy/listing behavior.

## 5. Test Coverage

- [ ] 5.1 Add SDK deploy tests for accepted `require`/`delete`, rejected `set`/`replace_all`, key validation, require/delete conflicts, warning propagation, and final `DeployResult.warnings`.
- [ ] 5.2 Add SDK secrets tests for key-only list responses and tolerance of extra gateway fields without typing or displaying `value_hash`.
- [ ] 5.3 Add `apps.bundleDeploy` tests covering legacy secret options and proving no value-bearing `ReleaseSpec` reaches `deploy.apply`.
- [ ] 5.4 Add CLI help/e2e tests for value-free manifest examples, key-only `secrets list`, and old-shape manifest failure messaging.
- [ ] 5.5 Add MCP tests for the new deploy schema, `list_secrets` markdown, warning display, and legacy bundle secret handling.

## 6. Validation

- [ ] 6.1 Run `npm run build`.
- [ ] 6.2 Run focused SDK unit tests for deploy, secrets, apps, scoped client, and CI preflight.
- [ ] 6.3 Run focused MCP tool tests for deploy and secrets.
- [ ] 6.4 Run CLI help/e2e tests that cover deploy and secrets.
- [ ] 6.5 Run `npm run test:sync` and `npm run test:skill`.
- [ ] 6.6 Run a final repository scan for stale old-contract strings and inspect the diff to confirm no unrelated user changes were reverted.
