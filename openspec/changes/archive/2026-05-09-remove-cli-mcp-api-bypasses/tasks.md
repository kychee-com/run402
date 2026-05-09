## 1. SDK Coverage

- [x] 1.1 Audit current CLI/MCP direct Run402 calls and map each to an existing SDK method or a missing SDK method.
- [x] 1.2 Add SDK blob upload session primitives for init, status/resume, and complete gateway calls while keeping presigned part PUTs outside the gateway request kernel.
- [x] 1.3 Add or widen SDK billing account read/history methods so callers can pass either wallet or email identifiers.
- [x] 1.4 Add SDK unit tests for new blob session and generic billing methods, including auth headers, URL encoding, response parsing, and structured error behavior.
- [x] 1.5 Export all new public option/result types from `sdk/src/index.ts` and `sdk/src/node/index.ts`, and update type export drift tests.

## 2. MCP Refactor

- [x] 2.1 Refactor `run_sql` to call `getSdk().projects.sql` and keep the existing Markdown table formatting.
- [x] 2.2 Refactor `rest_query` to call `getSdk().projects.rest` and preserve method/status/fenced JSON output.
- [x] 2.3 Refactor `apply_expose` and `get_expose` to call `getSdk().projects.applyExpose` and `getSdk().projects.getExpose`.
- [x] 2.4 Remove production MCP tool dependency on `apiRequest` for Run402 gateway calls and update affected MCP tests.

## 3. CLI Refactor

- [x] 3.1 Refactor `cli/lib/projects.mjs` direct gateway calls to existing SDK project/auth methods.
- [x] 3.2 Refactor `cli/lib/auth.mjs` provider listing to use `getSdk().auth.providers`.
- [x] 3.3 Refactor `cli/lib/blob.mjs` gateway upload-session calls to the new SDK blob session primitives while preserving resumable state and direct presigned PUT behavior.
- [x] 3.4 Refactor `cli/lib/allowance.mjs`, `cli/lib/billing.mjs`, `cli/lib/init.mjs`, and `cli/lib/status.mjs` Run402 gateway calls to SDK methods while keeping Tempo and chain RPC calls direct.
- [x] 3.5 Review remaining CLI `fetch` calls and document or eliminate each one according to the allowed external/presigned-call boundary.

## 4. Drift Guards And Tests

- [x] 4.1 Add a static test that fails on direct Run402 gateway `fetch` or `apiRequest` usage in production CLI/MCP code outside a narrow allowlist.
- [x] 4.2 Add or update CLI tests for refactored project, auth provider, blob upload-session, allowance, billing, init, and status commands.
- [x] 4.3 Add or update MCP tool tests to assert SDK-mediated behavior and preserved output formatting.
- [x] 4.4 Run `npm run build`, targeted unit tests, `npm run test:sync`, and CLI e2e tests relevant to changed commands.

## 5. Documentation

- [x] 5.1 Scan `documentation.md` and update every required doc surface affected by new SDK methods or the interface no-bypass rule.
- [x] 5.2 Update `AGENTS.md` architecture notes if any CLI/MCP exceptions or new SDK method families need to be documented.
- [x] 5.3 Update SDK/CLI agent references so examples do not show direct Run402 gateway calls for functionality now covered by SDK methods.
