## Context

The deploy-v2 SDK already receives structured observability data in `DeployResult.diff`, `PlanResponse.diff`, `PlanResponse.warnings`, and the modern top-level plan buckets normalized into the legacy-compatible `diff` object. That data is reliable enough to answer "what changed?" for deploy reports, but callers currently have to traverse raw diff buckets directly.

The desired change is intentionally smaller than a new deploy observability backend feature. It does not add phase timing, server event timestamps, function old/new code hashes, or a new gateway response shape. It packages the data already available in the SDK into a stable summary object that API-first automation can attach to reports.

## Goals / Non-Goals

**Goals:**

- Provide an isomorphic SDK helper that derives a stable `DeploySummary` from an existing `DeployResult`.
- Summarize only fields the SDK can derive from the current public type surface.
- Omit unavailable sections when the underlying diff bucket is missing.
- Make the helper usable from both `@run402/sdk` and `@run402/sdk/node`.
- Document that the helper is a convenience layer over existing deploy observability, not a new backend contract.

**Non-Goals:**

- No phase timing or duration fields.
- No client-side timing estimates.
- No function `code_hash_old` / `code_hash_new` fields.
- No new MCP tool.
- No new CLI subcommand or flag.
- No extra release inventory or diff API calls.
- No budget/guardrail enforcement in this change.

## Decisions

### D1. Export a pure helper instead of changing `deploy.apply`

Add a pure SDK utility, tentatively `summarizeDeployResult(result: DeployResult): DeploySummary`, exported from the SDK root and Node entry points.

This keeps `deploy.apply` stable and avoids turning every deploy result into a larger envelope. It also lets CLI, MCP, and fleet automation opt in without changing existing raw JSON outputs.

Alternative considered: return `{ result, summary }` directly from `deploy.apply`. That would be more convenient for new callers, but it changes the core primitive's result shape and risks breaking consumers that serialize or destructure `DeployResult`.

### D2. Keep summary types in the deploy type surface

Define `DeploySummary` and related nested summary types alongside deploy observability types, or in a small deploy-summary module that is re-exported from `sdk/src/index.ts`. The helper should remain isomorphic and must not depend on Node-only manifest, filesystem, or keystore helpers.

Alternative considered: put summary logic in CLI/MCP formatter modules. That would solve presentation for first-party tools but leave SDK users and fleet automation duplicating the same logic.

### D3. Omit missing buckets rather than fabricating zeros

If `diff.site`, `diff.static_assets`, `diff.functions`, `diff.routes`, `diff.migrations`, `diff.secrets`, or `diff.subdomains` is missing, the corresponding summary section is omitted. When a bucket is present, empty arrays/counters inside that bucket summarize as zeros.

This distinction matters because older/partial gateway responses may omit a bucket even when the resource did not necessarily have zero changes.

Alternative considered: always emit every section with zero defaults. That is ergonomically nice but misleading for partial or legacy diff shapes.

### D4. The headline is derived but secondary

The helper may include a short `headline` string for convenience, but structured fields are the contract. The headline should be deterministic and built from reliable summary fields; it must not mention timings, backend cost causes, or unavailable function hashes.

Alternative considered: leave prose entirely to CLI/MCP. A small headline is useful for reports and logs, but it must be treated as display sugar over structured data.

### D5. CLI/MCP support is optional formatter adoption, not required surface

This change does not require new CLI or MCP commands because it adds no new operation. Existing CLI and MCP deploy flows already preserve raw deploy result JSON; adding a summary field to those outputs would be a separate user-facing output change and should be considered deliberately.

Implementation may use the helper internally in CLI/MCP tests or renderers only if it does not break existing output contracts. The required work is SDK API plus SDK docs.

### D6. SDK docs are required; broad docs are conditional

Because the helper is a new SDK export, update `sdk/README.md` and `sdk/llms-sdk.txt`. Update `README.md`, `SKILL.md`, CLI docs, MCP docs, and OpenClaw docs only if implementation changes deploy examples or first-party CLI/MCP output behavior.

The public docs map does not require private `openapi.json` or HTTP docs updates because there is no backend endpoint or wire response change.

## Risks / Trade-offs

- [Risk: callers mistake missing buckets for zero changes] -> Mitigation: omit sections when source buckets are absent and document the distinction.
- [Risk: headline wording becomes a hidden compatibility contract] -> Mitigation: tests should primarily assert structured fields; headline tests should cover broad deterministic behavior without overfitting exact prose unless the team wants it stable.
- [Risk: helper drifts from deploy diff types] -> Mitigation: add type-level and unit tests that exercise modern buckets and partial/legacy-compatible diff objects.
- [Risk: CLI/MCP users expect the summary immediately] -> Mitigation: state explicitly that no new CLI/MCP surface is required; follow-up formatter work can adopt the SDK helper later.
