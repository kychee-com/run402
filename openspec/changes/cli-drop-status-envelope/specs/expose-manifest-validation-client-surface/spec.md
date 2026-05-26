## MODIFIED Requirements

### Requirement: CLI Exposes Validate Expose Command

The CLI SHALL expose the SDK validation capability as `run402 projects validate-expose`. The command SHALL accept an expose manifest from `--file <path>`, inline JSON, or stdin. It SHALL accept optional migration SQL from `--migration-file <path>` or `--migration-sql <sql>`. It SHALL accept optional project context through the same active-project and explicit-project conventions used by other `projects` commands.

Successful validation commands SHALL print the raw validation result to stdout as `{ "hasErrors": boolean, "errors": [...], "warnings": [...] }`, conforming to the `cli-output-shape` capability (no top-level `status` wrapper). Validation findings SHALL NOT cause a non-zero exit code unless the command cannot complete due to usage, file, auth, network, or other operational failure. Agents read `hasErrors` from the payload to decide what to do; the command itself succeeded if it produced a payload.

#### Scenario: CLI validates manifest file
- **WHEN** a user runs `run402 projects validate-expose --file manifest.json`
- **THEN** the CLI SHALL read the file as the expose manifest
- **AND** print a validation payload to stdout with `hasErrors`, `errors`, and `warnings` fields and NO top-level `status` field

#### Scenario: CLI validates with migration file
- **WHEN** a user runs `run402 projects validate-expose --file manifest.json --migration-file setup.sql`
- **THEN** the CLI SHALL read `setup.sql` as migration SQL
- **AND** pass the SQL to the SDK validation method

#### Scenario: CLI validates against project context
- **WHEN** a user runs `run402 projects validate-expose prj_123 --file manifest.json`
- **THEN** the CLI SHALL validate using project `prj_123` as live schema context
- **AND** it SHALL NOT apply the manifest to the project

#### Scenario: CLI reports validation errors without command failure
- **WHEN** the validator returns `hasErrors: true`
- **THEN** the CLI SHALL print the validation result to stdout (no top-level `status` field)
- **AND** exit 0 so agents can inspect all issues in one pass
