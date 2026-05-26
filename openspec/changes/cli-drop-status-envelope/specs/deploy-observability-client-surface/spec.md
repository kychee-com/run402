## MODIFIED Requirements

### Requirement: CLI exposes deploy release get, active, and diff commands

The CLI SHALL add release observability commands under the existing deploy command group.

The commands SHALL be:

- `run402 deploy release get <release_id> [--project <id>] [--site-limit <n>]`
- `run402 deploy release active [--project <id>] [--site-limit <n>]`
- `run402 deploy release diff --from <release_id|empty|active> --to <release_id|active> [--project <id>] [--limit <n>]`

When `--project` is omitted, the CLI SHALL use the active project id using the same local config behavior as other project-scoped commands.

Successful commands SHALL print the natural JSON payload to stdout without a top-level `status` wrapper, conforming to the `cli-output-shape` capability. Inventory commands SHALL print `{ "release": <ReleaseInventory> }`; diff commands SHALL print `{ "diff": <ReleaseToReleaseDiff> }`. Errors SHALL use the existing SDK error reporting path on stderr (which retains `status: "error"` as the sentinel).

#### Scenario: CLI gets a release by id

- **WHEN** a user runs `run402 deploy release get rel_123 --project prj_123`
- **THEN** the CLI SHALL call `r.deploy.getRelease({ project: "prj_123", releaseId: "rel_123" })`
- **AND** print a JSON object with `release.kind: "release_inventory"` and NO top-level `status` field

#### Scenario: CLI active release documents current-live semantics

- **WHEN** a user runs `run402 deploy release active --help`
- **THEN** the help text SHALL state that active release inventory is current-live state
- **AND** SHALL distinguish it from activation-time release snapshots

#### Scenario: CLI release diff accepts active and empty selectors

- **WHEN** a user runs `run402 deploy release diff --from empty --to active --project prj_123`
- **THEN** the CLI SHALL call `r.deploy.diff({ project: "prj_123", from: "empty", to: "active" })`
- **AND** print a JSON object with `diff.kind: "release_diff"` and NO top-level `status` field

#### Scenario: CLI help exposes nested release help

- **WHEN** a user runs `run402 deploy release --help`
- **THEN** the CLI SHALL list `get`, `active`, and `diff`
- **AND** SHALL mention `site-limit`, `limit`, `empty`, and `active` where relevant
