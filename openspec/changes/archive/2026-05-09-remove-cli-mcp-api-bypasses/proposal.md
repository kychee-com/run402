## Why

CLI and MCP are intended to be thin shims over `@run402/sdk`, but several commands and tools still call Run402 gateway endpoints directly. That creates duplicated auth, error handling, request shaping, and test coverage, and it lets new product surface ship without a typed SDK contract.

## What Changes

- Add SDK coverage for every Run402 API behavior currently reached directly by CLI or MCP.
- Move CLI and MCP handlers to SDK calls for SQL, PostgREST, expose manifests, auth providers, blob upload sessions, faucet/billing account reads, tier/project status aggregation, and related account/project operations.
- Preserve intentional non-Run402 network calls outside the SDK contract, including direct presigned storage PUTs, on-chain/RPC balance reads, and GitHub repository-id discovery.
- Add regression checks that fail when CLI or MCP production code introduces direct Run402 gateway `fetch` / `apiRequest` usage outside an explicit narrow allowlist.
- Keep command/tool UX and JSON/Markdown output stable unless an existing direct path had inconsistent SDK error handling that should now be normalized.

## Capabilities

### New Capabilities

- `sdk-interface-api-coverage`: Contract that all CLI and MCP Run402 API interactions are mediated by typed SDK methods, with guardrails for missing SDK surface.

### Modified Capabilities

- `sdk-public-type-surface`: New SDK methods introduced for CLI/MCP parity must export their public option/result types from root and Node entrypoints.

## Impact

- SDK: new or expanded namespaces for project SQL/REST/expose helpers, auth providers, blob upload sessions, faucet/billing reads, and account/status reads that are currently only implemented at interface edges.
- CLI: replace direct Run402 `fetch` calls with SDK methods while keeping CLI-specific parsing, filesystem, output formatting, direct-to-S3 uploads, and best-effort external discovery at the edge.
- MCP: replace direct `apiRequest` calls with SDK calls and remove production tool dependency on the legacy core client wrapper.
- Tests: add SDK unit coverage for new methods, update existing CLI/MCP tests to assert SDK-mediated behavior where practical, and add static drift checks banning direct Run402 gateway calls from CLI/MCP production code.
- Documentation: update architecture notes if new SDK methods alter the canonical surface map or sync contract.
