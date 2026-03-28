### Requirement: MCP run_sql accepts optional params array
The MCP `run_sql` tool schema SHALL accept an optional `params` field of type array. When `params` is provided and non-empty, the tool SHALL send the request as `Content-Type: application/json` with body `{ "sql": "<sql>", "params": [...] }`. When `params` is omitted or empty, the tool SHALL send `Content-Type: text/plain` with the raw SQL string as body (existing behavior).

#### Scenario: Parameterized query via MCP
- **WHEN** `run_sql` is called with `sql: "SELECT * FROM users WHERE id = $1"` and `params: [42]`
- **THEN** the tool sends a POST to `/projects/v1/admin/:id/sql` with `Content-Type: application/json` and body `{"sql":"SELECT * FROM users WHERE id = $1","params":[42]}`

#### Scenario: Plain SQL via MCP (backward compat)
- **WHEN** `run_sql` is called with `sql: "SELECT 1"` and no `params`
- **THEN** the tool sends a POST with `Content-Type: text/plain` and body `SELECT 1`

#### Scenario: Empty params array treated as no params
- **WHEN** `run_sql` is called with `sql: "SELECT 1"` and `params: []`
- **THEN** the tool sends a POST with `Content-Type: text/plain` and body `SELECT 1`

### Requirement: CLI projects sql accepts --params flag
The CLI `projects sql` command SHALL accept an optional `--params` flag whose value is a JSON array string. When provided, the CLI SHALL parse the JSON and send the request as `application/json` with `{ sql, params }`. Invalid JSON SHALL cause the command to exit with an error message.

#### Scenario: Parameterized query via CLI
- **WHEN** user runs `run402 projects sql <id> "SELECT * FROM t WHERE id = $1" --params '[42]'`
- **THEN** the CLI sends a JSON body with sql and params to the API

#### Scenario: Invalid params JSON
- **WHEN** user runs `run402 projects sql <id> "SELECT 1" --params 'not-json'`
- **THEN** the CLI exits with an error message about invalid JSON params

#### Scenario: CLI without params (backward compat)
- **WHEN** user runs `run402 projects sql <id> "SELECT 1"` without `--params`
- **THEN** the CLI sends `text/plain` with the raw SQL string
