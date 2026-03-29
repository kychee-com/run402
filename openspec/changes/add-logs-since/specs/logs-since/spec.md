## ADDED Requirements

### Requirement: API supports since parameter for incremental log fetching
The logs endpoint `GET /projects/v1/admin/:id/functions/:name/logs` SHALL accept an optional `since` query parameter as an integer (epoch milliseconds). When provided, the endpoint SHALL return only log entries with `timestamp >= since`. When omitted, behavior SHALL be unchanged (return last N entries by `tail`).

#### Scenario: Fetch logs since a specific timestamp
- **WHEN** client sends `GET /logs?since=1711720800000`
- **THEN** the API returns only log entries with timestamp at or after that epoch ms value

#### Scenario: Combine since with tail
- **WHEN** client sends `GET /logs?since=1711720800000&tail=10`
- **THEN** the API returns the last 10 log entries that have timestamp at or after the since value

#### Scenario: No since parameter (backwards compatible)
- **WHEN** client sends `GET /logs?tail=50` without a since parameter
- **THEN** behavior is unchanged — returns the last 50 log entries

#### Scenario: Since with no matching logs
- **WHEN** client sends `GET /logs?since=<future_timestamp>`
- **THEN** the API returns `{ logs: [] }`

### Requirement: MCP tool supports since parameter
The `get_function_logs` MCP tool SHALL accept an optional `since` parameter as an ISO 8601 timestamp string. The tool SHALL convert the ISO string to epoch milliseconds and pass it to the API.

#### Scenario: MCP incremental log fetch
- **WHEN** an LLM calls `get_function_logs({ project_id, name, since: "2026-03-29T14:00:00.001Z" })`
- **THEN** the tool returns only logs newer than or at that timestamp

#### Scenario: MCP without since (backwards compatible)
- **WHEN** an LLM calls `get_function_logs({ project_id, name })` without since
- **THEN** behavior is unchanged — returns the last N entries by tail

### Requirement: CLI supports --since flag
The `run402 functions logs` command SHALL accept an optional `--since <value>` flag. The value SHALL be an ISO 8601 timestamp string or epoch milliseconds. The CLI SHALL pass the value as epoch ms to the API.

#### Scenario: CLI fetch logs since timestamp
- **WHEN** user runs `run402 functions logs <id> <name> --since 2026-03-29T14:00:00Z`
- **THEN** the CLI outputs only log entries at or after that timestamp

### Requirement: CLI supports --follow flag for continuous log tailing
The `run402 functions logs` command SHALL accept a `--follow` flag. When set, the CLI SHALL poll the API every 3 seconds, printing only new log entries. The CLI SHALL track the most recent timestamp seen and use `since = lastTimestamp + 1ms` on each subsequent poll to avoid duplicates. The loop SHALL run until interrupted by Ctrl-C.

#### Scenario: Follow mode streams new logs
- **WHEN** user runs `run402 functions logs <id> <name> --follow`
- **THEN** the CLI continuously polls and prints new log entries as they appear, with no duplicates

#### Scenario: Follow mode with initial since
- **WHEN** user runs `run402 functions logs <id> <name> --follow --since 2026-03-29T14:00:00Z`
- **THEN** the CLI starts tailing from that timestamp forward

#### Scenario: Follow mode with no initial logs
- **WHEN** user runs `--follow` and no logs exist yet
- **THEN** the CLI waits silently, printing new entries as they appear

#### Scenario: Follow mode exits on Ctrl-C
- **WHEN** user presses Ctrl-C during follow mode
- **THEN** the CLI exits cleanly
