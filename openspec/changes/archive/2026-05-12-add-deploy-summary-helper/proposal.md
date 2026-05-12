## Why

CAS-heavy deploys already return enough structured diff data for callers to understand what changed, but every consumer has to hand-roll its own summary over the raw deploy diff. This makes fleet upgrade reports noisier than they need to be and makes it harder for agents to present a clear, reliable deploy result without inventing unsupported timing or hash details.

## What Changes

- Add an SDK-owned deploy summary helper that derives a concise, stable `DeploySummary` from an existing `DeployResult` or deploy diff/warnings payload.
- The helper will summarize only fields the SDK can reliably derive today: static path counts, CAS byte counters, function add/remove/change names and changed fields, migration new/noop ids, route counts, secret/subdomain counts, warning counts, blocking warning counts, and warning codes.
- The helper will omit sections when the gateway did not return the underlying diff bucket instead of fabricating zeros.
- The helper will not include phase timings, client-side duration estimates, or old/new function code hashes.
- No new MCP tool or CLI subcommand is required. CLI/MCP may use the helper internally in existing deploy result rendering later, but this change introduces no new user-facing command/tool surface.
- Update SDK-facing docs so API users and agents know the helper exists and understand its reliability boundaries.

## Capabilities

### New Capabilities

- None.

### Modified Capabilities

- `deploy-observability-client-surface`: add a reliable SDK summary helper over the existing deploy result/diff observability contract.

## Impact

- SDK public API: new exported `DeploySummary` type and summary helper function from the SDK root entry point.
- SDK internals/tests: helper implementation and focused unit tests for modern diff buckets, missing buckets, warning summaries, and legacy/partial diff compatibility.
- CLI/MCP: no required new surface. Existing deploy outputs keep preserving raw JSON. Optional future formatter use is allowed but not necessary for this change.
- Documentation: update `sdk/llms-sdk.txt` and `sdk/README.md`; update broader docs only if implementation changes examples or public deploy narrative beyond the SDK helper.
