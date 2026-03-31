## ADDED Requirements

### Requirement: Translate text to a target language

The `ai_translate` tool SHALL accept a project ID, text (max 10,000 characters), target language (ISO 639-1 code), optional source language, and optional context hint (max 200 characters). It SHALL send a `POST /ai/v1/translate` request with service-key Bearer auth and return the translated text along with source and target language codes.

#### Scenario: Successful translation with auto-detected source
- **WHEN** the user calls `ai_translate` with `project_id`, `text: "Hello world"`, and `to: "es"`
- **THEN** the tool sends `POST /ai/v1/translate` with `{ text: "Hello world", to: "es" }` and service-key auth
- **AND** returns the translated text, detected source language, and target language

#### Scenario: Translation with explicit source language and context
- **WHEN** the user calls `ai_translate` with `text`, `to: "ja"`, `from: "en"`, and `context: "formal business email"`
- **THEN** the tool includes `from` and `context` in the request body
- **AND** returns the translated text appropriate for the given context

#### Scenario: Project not found in keystore
- **WHEN** the user calls `ai_translate` with a `project_id` not in the local keystore
- **THEN** the tool returns the standard `projectNotFound` error

### Requirement: Handle translate-specific errors

The tool SHALL handle 400 (invalid input), 402 (no add-on or quota exceeded), and 429 (rate limited) responses from the translate endpoint.

#### Scenario: 402 no add-on or quota exceeded
- **WHEN** the translate endpoint returns HTTP 402
- **THEN** the tool returns an informational (non-error) message explaining that the AI Translation add-on must be enabled or quota has been exceeded
- **AND** does NOT present x402 payment details (this is not an x402 payment flow)

#### Scenario: 400 invalid input
- **WHEN** the translate endpoint returns HTTP 400
- **THEN** the tool returns a formatted API error via `formatApiError`

#### Scenario: 429 rate limited
- **WHEN** the translate endpoint returns HTTP 429
- **THEN** the tool returns a formatted API error via `formatApiError`

### Requirement: CLI translate subcommand

The CLI SHALL expose `ai translate <project_id> <text> --to <lang>` with optional `--from` and `--context` flags. It SHALL print the translated text to stdout.

#### Scenario: CLI translate invocation
- **WHEN** the user runs `run402 ai translate <project_id> "Hello" --to es`
- **THEN** the CLI prints the translated text to stdout

### Requirement: OpenClaw translate shim

The OpenClaw module SHALL re-export the CLI's ai module `run` function.

#### Scenario: OpenClaw ai command
- **WHEN** an OpenClaw agent calls the ai command
- **THEN** it delegates to the CLI's `ai.mjs` `run` function
