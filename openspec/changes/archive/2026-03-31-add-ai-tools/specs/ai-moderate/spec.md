## ADDED Requirements

### Requirement: Moderate text content

The `ai_moderate` tool SHALL accept a project ID and text string. It SHALL send a `POST /ai/v1/moderate` request with service-key Bearer auth and return the moderation result including flagged status, categories, and category scores.

#### Scenario: Content not flagged
- **WHEN** the user calls `ai_moderate` with `project_id` and `text: "This is a friendly message"`
- **THEN** the tool sends `POST /ai/v1/moderate` with `{ text }` and service-key auth
- **AND** returns `flagged: false` with all category scores

#### Scenario: Content flagged
- **WHEN** the moderation API flags the content
- **THEN** the tool returns `flagged: true` with the flagged categories highlighted

#### Scenario: Project not found in keystore
- **WHEN** the user calls `ai_moderate` with a `project_id` not in the local keystore
- **THEN** the tool returns the standard `projectNotFound` error

### Requirement: Handle moderate-specific errors

The tool SHALL handle 400 (invalid input) and 429 (rate limited) responses.

#### Scenario: 400 invalid input
- **WHEN** the moderate endpoint returns HTTP 400
- **THEN** the tool returns a formatted API error via `formatApiError`

#### Scenario: 429 rate limited
- **WHEN** the moderate endpoint returns HTTP 429
- **THEN** the tool returns a formatted API error via `formatApiError`

### Requirement: Display moderation results clearly

The tool SHALL format the moderation response as a readable summary showing the flagged status prominently, followed by a table of categories and their scores.

#### Scenario: Formatted output
- **WHEN** the moderation API returns a result
- **THEN** the tool displays a summary header with flagged status
- **AND** shows categories and scores in a markdown table
- **AND** dynamically includes all categories from the response (not a hardcoded list)

### Requirement: CLI moderate subcommand

The CLI SHALL expose `ai moderate <project_id> <text>`. It SHALL print the moderation result to stdout.

#### Scenario: CLI moderate invocation
- **WHEN** the user runs `run402 ai moderate <project_id> "some text"`
- **THEN** the CLI prints the flagged status and category breakdown

### Requirement: OpenClaw moderate shim

The OpenClaw module SHALL re-export the CLI's ai module.

#### Scenario: OpenClaw moderate command
- **WHEN** an OpenClaw agent calls the ai moderate command
- **THEN** it delegates to the CLI's `ai.mjs` `run` function
