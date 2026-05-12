## ADDED Requirements

### Requirement: SDK exposes deploy result summary helper

The SDK SHALL export a pure helper named `summarizeDeployResult(result: DeployResult): DeploySummary` from the isomorphic SDK entry point. The Node SDK entry point SHALL re-export the same helper.

`DeploySummary` SHALL be an exported SDK type with `schema_version: "deploy-summary.v1"`, `release_id`, `operation_id`, `headline`, `warnings`, and optional resource summary sections derived only from fields already present on `DeployResult`.

The helper SHALL NOT call the gateway, read local credential state, access the filesystem, mutate the input result, or require Node-only APIs.

#### Scenario: SDK user summarizes a deploy result

- **WHEN** TypeScript code imports `summarizeDeployResult` from `@run402/sdk`
- **THEN** it SHALL be able to pass a `DeployResult`
- **AND** receive a `DeploySummary` with matching `release_id` and `operation_id`
- **AND** the helper SHALL make no additional HTTP requests

#### Scenario: Node SDK re-exports summary helper

- **WHEN** TypeScript code imports `summarizeDeployResult` from `@run402/sdk/node`
- **THEN** it SHALL receive the same isomorphic helper
- **AND** the helper SHALL not depend on Node manifest, filesystem, keystore, or allowance helpers

### Requirement: Deploy summary includes only reliable current fields

`DeploySummary` SHALL summarize only data the SDK can derive from the current `DeployResult.diff` and `DeployResult.warnings` contract.

The summary MAY include:

- `is_noop?: boolean` when `diff.is_noop` is a boolean
- `site.paths` when modern site or static asset diff data is present
- `site.cas` when `diff.static_assets` is present
- `functions` when modern function diff data is present
- `migrations` when modern plan migration diff data is present
- `routes` when modern route diff data is present
- `secrets` when secrets diff data is present
- `subdomains` when modern subdomain diff data is present
- `warnings` for every result

The summary SHALL NOT include phase timings, client-side duration estimates, server duration estimates, or function old/new code hashes.

If a resource bucket is missing or only present in an older legacy shape whose full modern meaning cannot be represented, the helper SHALL omit that resource summary section instead of fabricating zeros.

#### Scenario: Static asset summary uses CAS counters

- **WHEN** `DeployResult.diff.static_assets` includes path counts and CAS byte counters
- **THEN** the summary SHALL include `site.paths.added`, `changed`, `removed`, `unchanged`, and `total_changed`
- **AND** the summary SHALL include `site.cas.newly_uploaded_bytes`, `reused_bytes`, and `deployment_copy_bytes_eliminated`

#### Scenario: Site summary without static assets omits unavailable unchanged count

- **WHEN** `DeployResult.diff.site` is present but `DeployResult.diff.static_assets` is absent
- **THEN** the summary SHALL include `site.paths.added`, `changed`, `removed`, and `total_changed`
- **AND** it SHALL omit `site.paths.unchanged`
- **AND** it SHALL omit `site.cas`

#### Scenario: Function summary excludes code hash deltas

- **WHEN** `DeployResult.diff.functions.changed` contains changed function names and `fields_changed`
- **THEN** the summary SHALL include each changed function `name` and `fields_changed`
- **AND** it SHALL NOT include `code_hash_old`, `code_hash_new`, `source_sha`, or any inferred hash delta field

#### Scenario: Timing fields are absent

- **WHEN** a deploy result is summarized
- **THEN** `DeploySummary` SHALL NOT include `timings`, `duration_ms`, `phase_durations`, or any client-side timing estimate field

#### Scenario: Missing buckets are omitted

- **WHEN** a deploy result has no `routes` diff bucket
- **THEN** the summary SHALL omit `routes`
- **AND** SHALL NOT emit `{ added: 0, changed: 0, removed: 0 }` for that missing bucket

### Requirement: Deploy summary warning counts are deterministic

`DeploySummary.warnings` SHALL always be present and SHALL include:

- `count`: total number of warnings in `DeployResult.warnings`
- `blocking`: number of warnings where `requires_confirmation` is true or `code` is `MISSING_REQUIRED_SECRET`
- `codes`: unique warning codes in deterministic sorted order

Warnings SHALL be counted from `DeployResult.warnings`, not from any duplicated or compatibility `diff.warnings` bucket.

#### Scenario: Blocking warning count includes missing secrets

- **WHEN** a deploy result includes a warning with `code: "MISSING_REQUIRED_SECRET"` and `requires_confirmation: false`
- **THEN** `DeploySummary.warnings.blocking` SHALL count that warning as blocking

#### Scenario: Warning codes are unique and sorted

- **WHEN** a deploy result includes duplicate warning codes in any order
- **THEN** `DeploySummary.warnings.codes` SHALL include each code once
- **AND** SHALL return the codes in deterministic sorted order

### Requirement: Deploy summary docs and first-party surfaces stay scoped

The SDK documentation SHALL describe `summarizeDeployResult`, the `DeploySummary` shape, and the reliability boundaries: no timings, no inferred function hash deltas, no fabricated zero sections for missing buckets, and no extra gateway calls.

This change SHALL NOT require a new MCP tool, CLI subcommand, CLI flag, or HTTP API documentation update. Existing CLI and MCP deploy JSON output SHALL continue to preserve raw deploy result data unless a separate change explicitly updates those surfaces.

#### Scenario: SDK docs mention summary helper

- **WHEN** SDK documentation is updated for this change
- **THEN** `sdk/README.md` and `sdk/llms-sdk.txt` SHALL mention `summarizeDeployResult`
- **AND** SHALL document that the helper is derived from existing deploy result data

#### Scenario: CLI and MCP have no new required surface

- **WHEN** this change is implemented
- **THEN** no new CLI command, CLI flag, MCP tool, or sync-test `SURFACE` capability SHALL be required solely for deploy summaries
- **AND** any future CLI/MCP formatter adoption SHALL preserve existing raw deploy result data or be handled as a separate output-contract change
