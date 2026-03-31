## ADDED Requirements

### Requirement: Get AI translation usage

The `ai_usage` tool SHALL accept a project ID. It SHALL send a `GET /ai/v1/usage` request with service-key Bearer auth and return the translation usage for the current billing period.

#### Scenario: Active add-on with usage
- **WHEN** the user calls `ai_usage` with a valid `project_id`
- **THEN** the tool sends `GET /ai/v1/usage` with service-key auth
- **AND** returns active status, used words, included words, remaining words, and billing cycle start date

#### Scenario: Project not found in keystore
- **WHEN** the user calls `ai_usage` with a `project_id` not in the local keystore
- **THEN** the tool returns the standard `projectNotFound` error

### Requirement: Display usage as formatted summary

The tool SHALL format the usage response as a readable summary with key metrics.

#### Scenario: Formatted usage output
- **WHEN** the API returns usage data
- **THEN** the tool displays a summary with active status, a usage table showing used/included/remaining words, and the billing cycle start date

### Requirement: Handle usage errors

The tool SHALL handle non-OK responses from the usage endpoint.

#### Scenario: API error
- **WHEN** the usage endpoint returns a non-OK response
- **THEN** the tool returns a formatted API error via `formatApiError`

### Requirement: CLI usage subcommand

The CLI SHALL expose `ai usage <project_id>`. It SHALL print the usage summary to stdout.

#### Scenario: CLI usage invocation
- **WHEN** the user runs `run402 ai usage <project_id>`
- **THEN** the CLI prints the translation usage summary

### Requirement: OpenClaw usage shim

The OpenClaw module SHALL re-export the CLI's ai module.

#### Scenario: OpenClaw usage command
- **WHEN** an OpenClaw agent calls the ai usage command
- **THEN** it delegates to the CLI's `ai.mjs` `run` function
