# expose-manifest-validation-client-surface Specification

## Purpose
Define the public SDK, CLI, MCP, OpenClaw, and documentation contract for non-mutating validation of authorization/expose manifests before they are applied to a project.

## Requirements
### Requirement: SDK Exposes Expose Manifest Validation

The SDK SHALL expose an SDK-first validation method for authorization/expose manifests, named `projects.validateExpose` or an equivalently documented method in the `projects` namespace. The method SHALL accept an expose manifest as either a JSON object or JSON string, plus optional migration SQL and optional project context. It SHALL return a typed validation result with `hasErrors: boolean`, `errors: ExposeManifestValidationIssue[]`, and `warnings: ExposeManifestValidationIssue[]`.

Each validation issue SHALL include `type`, `severity`, `detail`, and optional `fix`. Validation issue severities SHALL be `"error"` or `"warning"`.

#### Scenario: SDK validates object input
- **WHEN** a caller passes an expose manifest object to `projects.validateExpose`
- **THEN** the SDK SHALL submit the manifest for validation without requiring the caller to wrap it in a deploy `ReleaseSpec`
- **AND** the method SHALL return `{ hasErrors, errors, warnings }`

#### Scenario: SDK validates JSON string input
- **WHEN** a caller passes a JSON string manifest to `projects.validateExpose`
- **THEN** the SDK SHALL parse the string before validation
- **AND** invalid JSON SHALL be reported as a validation result with `hasErrors: true` rather than as a thrown operational error

#### Scenario: SDK includes migration SQL
- **WHEN** a caller passes `migrationSql`
- **THEN** validation SHALL evaluate manifest references against objects introduced by that SQL
- **AND** the validation result SHALL preserve any gateway warnings for inconclusive migration parsing

#### Scenario: SDK uses project context when supplied
- **WHEN** a caller validates with project context
- **THEN** validation SHALL include the project's current schema state using a server-authoritative source
- **AND** the SDK SHALL NOT infer project-aware validation from the current public table-only `get_schema` response

### Requirement: Validation Does Not Mutate Projects

Expose manifest validation SHALL be a non-mutating operation. It SHALL NOT apply the manifest, run migrations, create deploy plans, upload content, commit releases, or change project authorization state.

#### Scenario: Project validation avoids apply endpoint
- **WHEN** a caller validates an expose manifest with a project id
- **THEN** the SDK SHALL call a non-mutating validation endpoint or equivalent non-mutating gateway contract
- **AND** it SHALL NOT call `POST /projects/v1/admin/:id/expose`

#### Scenario: Migration-aware validation does not execute migration
- **WHEN** validation receives migration SQL
- **THEN** the SQL SHALL be used only for validation context
- **AND** the validation operation SHALL NOT execute the SQL against the live project

#### Scenario: Validation findings are data
- **WHEN** the manifest has missing tables, missing owner columns, invalid grants, or other validation issues
- **THEN** the SDK SHALL return those findings in `errors` and `warnings`
- **AND** it SHALL NOT throw merely because `hasErrors` is true

#### Scenario: Operational failures remain errors
- **WHEN** validation cannot read local credentials, authenticate to a project, reach the gateway, or parse an invalid options object
- **THEN** the SDK SHALL use the existing structured `Run402Error` error path

### Requirement: CLI Exposes Validate Expose Command

The CLI SHALL expose the SDK validation capability as `run402 projects validate-expose`. The command SHALL accept an expose manifest from `--file <path>`, inline JSON, or stdin. It SHALL accept optional migration SQL from `--migration-file <path>` or `--migration-sql <sql>`. It SHALL accept optional project context through the same active-project and explicit-project conventions used by other `projects` commands.

Successful validation commands SHALL print a JSON envelope to stdout containing `status: "ok"`, `hasErrors`, `errors`, and `warnings`. Validation findings SHALL NOT cause a non-zero exit code unless the command cannot complete due to usage, file, auth, network, or other operational failure.

#### Scenario: CLI validates manifest file
- **WHEN** a user runs `run402 projects validate-expose --file manifest.json`
- **THEN** the CLI SHALL read the file as the expose manifest
- **AND** print a validation JSON envelope to stdout

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
- **THEN** the CLI SHALL print the validation result to stdout
- **AND** exit successfully so agents can inspect all issues in one pass

### Requirement: MCP Exposes Validate Manifest Tool

The MCP server SHALL expose a validation tool for auth/expose manifests. If the tool is named `validate_manifest`, its description SHALL explicitly say it validates the authorization/expose manifest used by `manifest.json`, `database.expose`, and `apply_expose`; it SHALL NOT describe itself as validating deploy manifests generally.

The MCP tool SHALL accept `manifest` as an object or JSON string, optional `migration_sql`, and optional `project_id`. It SHALL call the SDK validation method and return the same structured result envelope. Successful responses SHALL include a fenced JSON block preserving the full result for agents.

#### Scenario: MCP validates object manifest
- **WHEN** `validate_manifest` receives a manifest object
- **THEN** it SHALL pass that manifest to the SDK validation method
- **AND** return the SDK validation result without applying the manifest

#### Scenario: MCP validates string manifest
- **WHEN** `validate_manifest` receives a manifest JSON string
- **THEN** invalid JSON SHALL be reported in the validation result
- **AND** the tool response SHALL preserve `hasErrors: true`

#### Scenario: MCP validates with project context
- **WHEN** `validate_manifest` receives `project_id`
- **THEN** validation SHALL use that project as current-schema context
- **AND** missing local credentials for that project SHALL use the shared MCP SDK error mapping

#### Scenario: MCP avoids deploy-manifest ambiguity
- **WHEN** agents inspect the MCP tool description
- **THEN** the description SHALL distinguish expose manifests from deploy manifests
- **AND** it SHALL direct deploy-manifest validation questions to deploy planning or future deploy validation surfaces

### Requirement: Apply Expose Schema Aligns With Validation

The public client schemas for applying and validating expose manifests SHALL accept the same manifest shape wherever possible. They SHALL allow the `$schema` editor-hint field and omitted `tables`, `views`, or `rpcs` arrays when the gateway accepts those forms.

#### Scenario: Schema field is accepted
- **WHEN** an expose manifest includes `$schema: "https://run402.com/schemas/manifest.v1.json"`
- **THEN** validation SHALL accept the field as metadata
- **AND** `apply_expose` client-side schemas SHALL NOT reject it before the gateway can process it

#### Scenario: Omitted arrays are accepted
- **WHEN** an expose manifest omits `views` or `rpcs`
- **THEN** validation SHALL treat the omitted section consistently with the gateway manifest parser
- **AND** applying the same manifest through public clients SHALL not fail solely because the section was omitted

### Requirement: Agent Documentation Describes The Validation Boundary

Agent-facing docs and skills SHALL describe expose manifest validation as a non-mutating auth/expose manifest feedback loop. They SHALL distinguish it from deploy manifest normalization and from SQL/migration execution dry-run validation.

#### Scenario: Docs name the auth manifest scope
- **WHEN** docs mention `validate_manifest` or `validate-expose`
- **THEN** they SHALL state that the command validates auth/expose manifests used by `manifest.json`, `database.expose`, and `apply_expose`

#### Scenario: Docs avoid SQL dry-run claims
- **WHEN** docs describe migration SQL support for expose manifest validation
- **THEN** they SHALL say the SQL is used for manifest reference checks
- **AND** they SHALL NOT claim full PostgreSQL execution dry-run coverage

#### Scenario: Sync surface includes new shims
- **WHEN** the public repo sync tests inspect SDK, CLI, MCP, and OpenClaw surfaces
- **THEN** the new validation capability SHALL be represented consistently across those surfaces
