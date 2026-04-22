# rls-templates Specification

## Purpose
TBD - created by archiving change rls-template-rename. Update Purpose after archive.
## Requirements
### Requirement: MCP setup-rls tool accepts only the current gateway template names

The `setup_rls` MCP tool's `template` parameter SHALL be a Zod enum containing exactly: `user_owns_rows`, `public_read_authenticated_write`, `public_read_write_UNRESTRICTED`. No aliases for prior template names SHALL be accepted.

#### Scenario: Valid template passes schema validation

- **WHEN** an LLM calls `setup_rls({ project_id, template: "public_read_authenticated_write", tables: [{table: "notes"}] })`
- **THEN** the schema validates and the handler calls the gateway

#### Scenario: Deprecated name rejected with enum error

- **WHEN** an LLM calls `setup_rls({ project_id, template: "public_read", tables: [{table: "notes"}] })`
- **THEN** Zod returns an enum validation error listing the three valid values
- **AND** no network request is made

#### Scenario: Unknown template rejected

- **WHEN** an LLM calls `setup_rls({ project_id, template: "anything_goes", tables: [] })`
- **THEN** Zod returns an enum validation error listing the three valid values

### Requirement: MCP setup-rls tool enforces the unrestricted ACK at the schema boundary

The `setup_rls` MCP tool's schema SHALL include an optional `i_understand_this_is_unrestricted: boolean` field. When `template` equals `public_read_write_UNRESTRICTED`, the schema SHALL require `i_understand_this_is_unrestricted` to be exactly `true` (enforced via `.superRefine()`). When the flag is missing or `false` and the template is UNRESTRICTED, validation SHALL fail with a message identifying the flag.

When the template is NOT `public_read_write_UNRESTRICTED`, the flag SHALL be ignored (presence or absence has no effect on validation).

#### Scenario: UNRESTRICTED template without ACK is rejected locally

- **WHEN** an LLM calls `setup_rls({ project_id, template: "public_read_write_UNRESTRICTED", tables: [{table: "guestbook"}] })` without the ACK flag
- **THEN** the schema fails validation before any network call
- **AND** the error identifies `i_understand_this_is_unrestricted` as the missing field

#### Scenario: UNRESTRICTED template with ACK true is accepted and forwarded

- **WHEN** an LLM calls `setup_rls({ project_id, template: "public_read_write_UNRESTRICTED", tables: [{table: "guestbook"}], i_understand_this_is_unrestricted: true })`
- **THEN** the schema validates
- **AND** the handler sends `i_understand_this_is_unrestricted: true` in the POST body to `/projects/v1/admin/:id/rls`

#### Scenario: UNRESTRICTED template with ACK false is rejected locally

- **WHEN** an LLM calls `setup_rls({ project_id, template: "public_read_write_UNRESTRICTED", tables: [{table: "guestbook"}], i_understand_this_is_unrestricted: false })`
- **THEN** the schema fails validation
- **AND** no network request is made

#### Scenario: ACK flag on non-UNRESTRICTED template is ignored

- **WHEN** an LLM calls `setup_rls({ project_id, template: "user_owns_rows", tables: [{table: "todos", owner_column: "user_id"}], i_understand_this_is_unrestricted: true })`
- **THEN** the schema validates
- **AND** the handler forwards the flag in the body (server ignores it for non-UNRESTRICTED)

### Requirement: MCP bundle-deploy tool applies the same template rules inside its rls block

The `bundle_deploy` MCP tool's `rls` sub-schema SHALL enforce identical rules to `setup_rls`: the same three valid template names, the same optional `i_understand_this_is_unrestricted` field, and the same `superRefine` rule requiring ACK when template is UNRESTRICTED.

#### Scenario: Bundle deploy with valid UNRESTRICTED rls block

- **WHEN** an LLM calls `bundle_deploy({ project_id, rls: { template: "public_read_write_UNRESTRICTED", tables: [{table: "guestbook"}], i_understand_this_is_unrestricted: true }, files: [...] })`
- **THEN** the schema validates
- **AND** the rls object (including the ACK flag) is forwarded to `POST /deploy/v1`

#### Scenario: Bundle deploy with deprecated template name

- **WHEN** an LLM calls `bundle_deploy({ project_id, rls: { template: "public_read_write", tables: [...] } })`
- **THEN** the schema fails validation at the Zod layer before the deploy POST

#### Scenario: Bundle deploy with UNRESTRICTED but no ACK

- **WHEN** an LLM calls `bundle_deploy({ project_id, rls: { template: "public_read_write_UNRESTRICTED", tables: [...] } })` without the ACK
- **THEN** the schema fails validation with a message identifying `rls.i_understand_this_is_unrestricted`

### Requirement: CLI pass-through surfaces server errors faithfully

The `run402 projects rls` CLI command SHALL NOT validate template names client-side — it SHALL continue passing the template argument verbatim to the API and surface the gateway's response (including 400 errors for deprecated names) as its standard JSON error output.

#### Scenario: Deprecated name surfaces gateway error

- **WHEN** a user runs `run402 projects rls <id> public_read '[{"table":"notes"}]'`
- **THEN** the CLI sends the request with `template: "public_read"` to the gateway
- **AND** the CLI prints the gateway's 400 response JSON to stderr and exits non-zero

#### Scenario: Valid UNRESTRICTED invocation includes ACK

- **WHEN** a user runs `run402 projects rls <id> public_read_write_UNRESTRICTED '[{"table":"guestbook"}]'` the CLI does NOT auto-inject the ACK (the CLI takes template + tables args only)
- **THEN** the gateway returns 400 requesting the ACK
- **AND** the user sees the error and must use a manifest or MCP path to set the flag

_(Note: the CLI's 3-argument `rls` subcommand doesn't surface the ACK. Users needing UNRESTRICTED via CLI should use `run402 deploy` with a manifest JSON that includes the flag. This is intentional — discouraging UNRESTRICTED via the shortest CLI path.)_

### Requirement: CLI deploy manifest RLS block supports the ACK

The `run402 deploy` CLI command's manifest JSON parsing SHALL pass the `rls` object through to the deploy API verbatim, including any `i_understand_this_is_unrestricted` field. The CLI help text SHALL document the flag alongside the UNRESTRICTED template.

#### Scenario: Manifest with UNRESTRICTED + ACK deploys successfully

- **WHEN** a user runs `run402 deploy --manifest m.json` where `m.json` contains `"rls": { "template": "public_read_write_UNRESTRICTED", "tables": [{"table":"guestbook"}], "i_understand_this_is_unrestricted": true }`
- **THEN** the CLI forwards the rls object verbatim to `POST /deploy/v1`

#### Scenario: CLI --help lists new templates

- **WHEN** a user runs `run402 deploy --help`
- **THEN** the output lists `user_owns_rows`, `public_read_authenticated_write`, `public_read_write_UNRESTRICTED` under the manifest RLS section
- **AND** includes at least one sentence of safety context per template

### Requirement: Documentation surfaces agree on template names and safety guidance

`SKILL.md`, `openclaw/SKILL.md`, and `cli/llms-cli.txt` SHALL reference only the three current template names. The documentation SHALL include:

- A preamble recommending `user_owns_rows` for any user-scoped data.
- For `public_read_authenticated_write`: explicit note that any authenticated user can INSERT/UPDATE/DELETE any row (not just their own).
- For `public_read_write_UNRESTRICTED`: a ⚠ warning, mention of anon_key write access, and documentation of the `i_understand_this_is_unrestricted: true` body requirement.

#### Scenario: SKILL.md matches the current gateway contract

- **WHEN** an agent reads `SKILL.md` RLS section
- **THEN** it finds exactly the three current template names with the warnings described above
- **AND** it finds no reference to `public_read` or `public_read_write` (the pre-2026-04-21 names)

#### Scenario: llms-cli.txt examples are runnable against the current gateway

- **WHEN** an agent copies an RLS example from `cli/llms-cli.txt` and runs it
- **THEN** the example uses a current template name
- **AND** UNRESTRICTED examples include the `i_understand_this_is_unrestricted: true` field

