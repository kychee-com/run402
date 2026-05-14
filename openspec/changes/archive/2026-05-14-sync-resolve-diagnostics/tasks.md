## 1. SDK Type Contract

- [x] 1.1 Add future-safe deploy resolve authorization result types, CAS object health type, and response variant type in `sdk/src/namespaces/deploy.types.ts`.
- [x] 1.2 Add optional `authorization_result`, `cas_object`, `response_variant`, `allow`, `route_pattern`, `target_type`, `target_name`, and `target_file` fields to `DeployResolveResponse`.
- [x] 1.3 Update `KnownDeployResolveMatch` and related result typing for `active_release_missing`, `route_function`, `route_static_alias`, `route_method_miss`, and any method-miss status returned by the gateway contract.
- [x] 1.4 Export all new public resolve diagnostic types from `sdk/src/index.ts` and `sdk/src/node/index.ts`.

## 2. Summary Behavior

- [x] 2.1 Update `buildDeployResolveSummary` so `would_serve` is false for CAS authorization or health failures even when the raw match is static-like.
- [x] 2.2 Add category, summary text, and next-step handling for `route_method_miss`, including the `allow` methods when returned.
- [x] 2.3 Add category, summary text, and next-step handling for CAS failures: missing object, unfinalized/deleting object, size mismatch, and unauthorized object.
- [x] 2.4 Ensure unknown future resolve fields and literals still fall back to generic inspect-payload guidance without dropping raw JSON.

## 3. Tests

- [x] 3.1 Add SDK `deploy.resolve()` fixture coverage for a static CAS failure with `authorization_result` and `cas_object`.
- [x] 3.2 Add SDK fixture coverage for an HTML `response_variant` payload.
- [x] 3.3 Add SDK fixture coverage for route/static diagnostics, including `route_static_alias` and `route_method_miss`.
- [x] 3.4 Extend `sdk/src/type-contract.ts` and public type export tests for new stable-host response fields, exported named types, and future-safe literal unions.
- [x] 3.5 Extend CLI and MCP diagnose tests to assert route method miss and CAS failure summaries while preserving full `resolution` JSON.

## 4. Documentation And Sync

- [x] 4.1 Update `README.md`, `SKILL.md`, `llms-mcp.txt`, and `cli/llms-cli.txt` with the new resolve fields, known match literals, authorization results, and guidance to branch on structured JSON.
- [x] 4.2 Update SDK documentation surfaces for the new public types and response fields.
- [x] 4.3 Update `sync.test.ts` drift checks so docs must mention `authorization_result`, `cas_object`, `response_variant`, `active_release_missing`, `route_function`, `route_static_alias`, and `route_method_miss`.
- [x] 4.4 Scan `documentation.md` and update its deploy diagnostics/doc-surface guidance if the existing checklist does not cover these stable-host fields.

## 5. Validation

- [x] 5.1 Run focused SDK, MCP, and CLI tests that cover deploy resolve and diagnose behavior.
- [x] 5.2 Run `npm run test:sync` and `npm run test:skill`.
- [x] 5.3 Run `npm test` or the repo's broader equivalent before marking implementation complete.
- [x] 5.4 Record the patch/minor publish follow-up for the release workflow after tests pass and the change is ready to ship.

## Release Follow-Up

- After merge and green CI, publish the SDK/CLI/MCP/OpenClaw package set through the existing `/publish` workflow as a patch or minor release so the new stable-host resolve diagnostic fields and public types reach npm together.
