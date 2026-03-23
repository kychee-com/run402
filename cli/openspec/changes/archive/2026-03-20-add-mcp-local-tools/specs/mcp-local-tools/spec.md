## ADDED Requirements

### Requirement: status tool returns full account snapshot
The `status` MCP tool SHALL return a markdown summary containing: allowance address and funding status, billing balance (available + held), tier subscription (name, status, expiry), project list (from server with local fallback), and active project ID.

#### Scenario: Full status with active tier and projects
- **WHEN** `status` is called with a valid allowance and active tier
- **THEN** the response includes allowance address, billing balance, tier name/status/expiry, project list, and active project ID in a markdown table

#### Scenario: No allowance configured
- **WHEN** `status` is called and no `allowance.json` exists
- **THEN** the response returns an error indicating no allowance is configured

#### Scenario: API calls fail gracefully
- **WHEN** `status` is called and one or more API calls (tier, billing, projects) fail
- **THEN** the failed sections show as "unavailable" and the tool does NOT return `isError: true`

#### Scenario: No active tier
- **WHEN** the tier API returns no active tier
- **THEN** the tier section shows "(none)" with guidance to subscribe

### Requirement: project_info tool returns local project details
The `project_info` tool SHALL read the local keystore and return project details including REST URL, anon_key, service_key, site_url, and deployed_at for the given project_id.

#### Scenario: Project exists in keystore
- **WHEN** `project_info` is called with a valid project_id
- **THEN** the response includes REST URL, anon_key, service_key, site_url, and deployed_at in a markdown table

#### Scenario: Project not in keystore
- **WHEN** `project_info` is called with a project_id not in the local keystore
- **THEN** the response returns `isError: true` with guidance to provision first

### Requirement: project_use tool sets the active project
The `project_use` tool SHALL validate the project exists in the local keystore and set it as the active project by writing `active_project_id` to `keystore.json`.

#### Scenario: Set active project
- **WHEN** `project_use` is called with a valid project_id that exists in the keystore
- **THEN** the keystore's `active_project_id` is updated and the response confirms the change

#### Scenario: Project not in keystore
- **WHEN** `project_use` is called with a project_id not in the local keystore
- **THEN** the response returns `isError: true` with guidance to provision first

### Requirement: project_keys tool returns project credentials
The `project_keys` tool SHALL read the local keystore and return the anon_key and service_key for the given project_id.

#### Scenario: Project exists in keystore
- **WHEN** `project_keys` is called with a valid project_id
- **THEN** the response includes project_id, anon_key, and service_key

#### Scenario: Project not in keystore
- **WHEN** `project_keys` is called with a project_id not in the local keystore
- **THEN** the response returns `isError: true` with guidance to provision first

### Requirement: Sync test updated for all 4 tools
The SURFACE entries in `sync.test.ts` for `status`, `project_info`, `project_use`, and `project_keys` SHALL have their `mcp` field set to the corresponding tool name instead of `null`.

#### Scenario: Sync test passes
- **WHEN** `npm run test:sync` is executed
- **THEN** all 4 capabilities pass with their MCP tool names
