## 1. SDK Helper

- [x] 1.1 Add exported `DeploySummary` types for the reliable summary shape, including optional resource sections and required warning summary fields.
- [x] 1.2 Implement `summarizeDeployResult(result: DeployResult): DeploySummary` as a pure isomorphic helper with no network, filesystem, credential, or mutation side effects.
- [x] 1.3 Derive site path counts and CAS byte counters from modern `site` / `static_assets` diff buckets, omitting unavailable sections instead of fabricating zeros.
- [x] 1.4 Derive function, migration, route, secret, subdomain, and warning summaries only from reliable modern buckets.
- [x] 1.5 Ensure the helper does not expose timings, client-side duration estimates, server phase estimates, or old/new function code hash fields.
- [x] 1.6 Re-export the helper and types from `@run402/sdk` and `@run402/sdk/node`.

## 2. Tests

- [x] 2.1 Add unit tests for a modern static deploy diff with path counts, CAS byte counters, and warning summary output.
- [x] 2.2 Add unit tests for site diffs without `static_assets`, verifying `unchanged` and `site.cas` are omitted.
- [x] 2.3 Add unit tests for missing and legacy-shaped resource buckets, verifying unavailable sections are omitted rather than zero-filled.
- [x] 2.4 Add unit tests for function summaries, verifying only `name` and `fields_changed` are emitted for changed functions.
- [x] 2.5 Add unit tests for warning counts, blocking warning rules, and deterministic unique sorted warning codes.
- [x] 2.6 Add type/export coverage so both SDK entry points expose `summarizeDeployResult` and `DeploySummary`.

## 3. Documentation

- [x] 3.1 Update `sdk/README.md` with a short SDK example showing `summarizeDeployResult(await r.deploy.apply(spec))`.
- [x] 3.2 Update `sdk/llms-sdk.txt` with the helper signature, summary shape, and reliability boundaries.
- [x] 3.3 Confirm no CLI, MCP, OpenClaw, HTTP, or private OpenAPI docs need updates because this change adds no new command, tool, flag, endpoint, or wire response.

## 4. Validation

- [x] 4.1 Run focused SDK deploy summary tests.
- [x] 4.2 Run the SDK build or type-check path that verifies public exports.
- [x] 4.3 Run `npm run test:sync` only if implementation touches CLI, MCP, OpenClaw, or surface mapping files.
