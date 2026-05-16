## 1. ReleaseSpec Schema And Authoring Docs

- [x] 1.1 Add a checked-in schema source/artifact for `release-spec.v1.json`, covering CLI/MCP manifest JSON and SDK-native `ReleaseSpec` differences.
- [x] 1.2 Add schema fixture tests for a complete multi-resource deploy manifest, `$schema` metadata, function schedules, site public paths, routes, subdomains, and strict typo rejection.
- [x] 1.3 Update `loadDeployManifest()` / `normalizeDeployManifest()` and raw deploy validation to accept only top-level `$schema` metadata and strip it before planning.
- [x] 1.4 Expand SDK/CLI docs for `FunctionSpec`, including `schedule`, `runtime`, `source`, `files`, `entrypoint`, `config.timeoutSeconds`, `config.memoryMb`, and the current `deps` support status.
- [x] 1.5 Document subdomain set/add/remove compatibility, known `cache_class` values, and strict-validation traps in `llms-cli.txt` and `llms-sdk.txt`.
- [x] 1.6 Document `force_owner_on_insert` overwrite/null/service-role semantics with the generated trigger SQL shape.
- [x] 1.7 Coordinate schema hosting at `https://run402.com/schemas/release-spec.v1.json` and add a release/check task that fails when the hosted schema reference drifts.

## 2. Runtime Image Generation

- [x] 2.1 Confirm or add the project-billed gateway endpoint for runtime image generation using project service credentials and project spend/rate limits.
- [x] 2.2 Add `GenerateImageOptions`, `GenerateImageResult`, image aspect typing, and `ai.generateImage()` to `functions/src/ai.ts`.
- [x] 2.3 Export the new runtime image types from `functions/src/index.ts`.
- [x] 2.4 Add function-library unit tests for request shape, aspect validation, successful result shape, and quota/error handling.
- [x] 2.5 Update functions runtime docs and agent docs with a routed-function live image-generation example and billing-limit notes.

## 3. Secret Stdin Input

- [x] 3.1 Add `--stdin` parsing to `cli/lib/secrets.mjs`, mutually exclusive with inline value and ordinary `--file`.
- [x] 3.2 Accept `--file -` and `/dev/stdin` as stdin aliases without passing them through the regular-file validator.
- [x] 3.3 Ensure stdin reads do not echo secret values in success, error, or debug output.
- [x] 3.4 Add CLI tests for `--stdin`, `/dev/stdin`, `--file -`, conflicting sources, missing stdin, and help text.
- [x] 3.5 Update deploy warning guidance that mentions `run402 secrets set` so missing-secret recovery can use `--stdin`.

## 4. Warning Acknowledgement

- [x] 4.1 Add SDK `ApplyOptions.allowWarningCodes` support while preserving `allowWarnings: true`.
- [x] 4.2 Update warning-abort logic so all blocking warnings must be covered by broad allow or by a supplied code.
- [x] 4.3 Add repeatable CLI `--allow-warning <code>` parsing and help text for `run402 deploy apply`.
- [x] 4.4 Add MCP deploy input support for `allow_warning_codes` and render unacknowledged warning codes in errors.
- [x] 4.5 Add `acknowledge_readonly: true` to route authoring types, validators, manifest adapter, and client route warning generation for valid GET/HEAD wildcard function routes.
- [x] 4.6 Add tests showing route-level acknowledgement suppresses only the matching `WILDCARD_ROUTE_EXCLUDES_MUTATION_METHODS` warning and rejects invalid acknowledgements.
- [x] 4.7 Update route warning docs to prefer route acknowledgement or `--allow-warning <code>` before blanket `--allow-warnings`.

## 5. Tier Limits And Activation Failures

- [x] 5.1 Extend tier status or quote types to expose max function timeout, max function memory, max scheduled functions, minimum cron interval, and current scheduled usage when available.
- [x] 5.2 Implement deploy preflight over normalized function specs before CAS upload, deploy plan creation, commit, migration, build, or activation.
- [x] 5.3 Return structured local `BAD_FIELD` errors for timeout, memory, cron interval, and scheduled-count violations, including field path, value, tier, limit, and limit source.
- [x] 5.4 Add CLI deploy tests proving tier violations fail before deploy planning or content upload.
- [x] 5.5 Update `run402 tier status` output/help and MCP tier status docs to show function authoring caps when returned.
- [x] 5.6 Update deploy poller classification so non-recoverable `activation_pending` static config/spec failures throw immediately with gateway error metadata preserved.
- [x] 5.7 Add SDK tests for immediate static activation failure, recoverable activation pending polling, and no safe-race retry for static activation errors.

## 6. Final-Only Deploy Output

- [x] 6.1 Add `--final-only` parsing to `run402 deploy apply` as an alias for suppressing the stderr event stream.
- [x] 6.2 Update help text and `llms-cli.txt` to state that `--quiet` and `--final-only` still preserve the final stdout JSON envelope.
- [x] 6.3 Add CLI e2e/help tests proving `--final-only` suppresses progress events and preserves success/error result behavior.

## 7. Docs, Skills, And Drift Guards

- [x] 7.1 Scan `documentation.md` and update every listed surface whose trigger is hit by schema, deploy, functions runtime, secrets, tier, or warning behavior.
- [x] 7.2 Update root `SKILL.md`, `openclaw/SKILL.md`, README/SDK README, `llms-cli.txt`, `llms-sdk.txt`, and MCP docs where applicable.
- [x] 7.3 Extend sync/drift tests so schema URL, `FunctionSpec.schedule`, secret stdin guidance, warning-code acknowledgement, final-only output, runtime image helper, and tier caps do not drift.
- [x] 7.4 Update public type export tests for any new SDK, deploy, route, tier, or functions-runtime types.

## 8. Verification

- [x] 8.1 Run focused SDK deploy tests, functions package tests, CLI secrets/deploy/tier tests, and MCP deploy tests touched by the change.
- [x] 8.2 Run `npm run build:functions`, `npm run build:sdk`, and `npm run build` after code changes.
- [x] 8.3 Run `npm run test:sync`, `npm run test:skill`, `npm run test:help`, and relevant CLI e2e tests.
- [x] 8.4 Run `openspec status --change reduce-agent-deploy-friction` and confirm the change remains apply-ready.
