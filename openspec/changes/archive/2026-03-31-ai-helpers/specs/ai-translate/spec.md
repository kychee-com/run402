### Requirement: Runtime helper

The `@run402/functions` module SHALL export an `ai` object with a `translate` method.

#### Scenario: Basic translation

- **WHEN** a function calls `ai.translate("Hello world", "es")`
- **THEN** it SHALL return `{ text: "Hola mundo", from: "en", to: "es" }`

#### Scenario: Return shape

- **WHEN** `ai.translate(text, targetLang)` resolves
- **THEN** the result SHALL contain `text` (string), `from` (ISO 639-1 language code), and `to` (ISO 639-1 language code)

#### Scenario: Source language auto-detection

- **WHEN** a function calls `ai.translate(text, targetLang)` without specifying a source language
- **THEN** the gateway SHALL auto-detect the source language and return it in the `from` field

#### Scenario: Explicit source language

- **WHEN** a function calls `ai.translate(text, targetLang, { from: "fr" })`
- **THEN** the gateway SHALL use `"fr"` as the source language and skip detection

#### Scenario: Context hint

- **WHEN** a function calls `ai.translate(text, targetLang, { context: "comment on a south LA community center events post" })`
- **THEN** the gateway SHALL include the context string in the system prompt to guide tone, terminology, and register of the translation

#### Scenario: Same source and target language

- **WHEN** `targetLang` matches the detected (or explicit) source language
- **THEN** the helper SHALL return the original text unchanged without calling the LLM

### Requirement: Gateway endpoint

The gateway SHALL expose `POST /ai/v1/translate` for translation requests.

#### Scenario: Request format

- **WHEN** a valid request is received
- **THEN** the request body SHALL contain `text` (string, required) and `to` (string, required ISO 639-1 code), and optionally `from` (string, ISO 639-1 code) and `context` (string, max 200 chars)

#### Scenario: Auth

- **WHEN** a request is made without a valid service key
- **THEN** the gateway SHALL return HTTP 401

#### Scenario: Successful translation

- **WHEN** a valid request is received with an active translation add-on
- **THEN** the gateway SHALL build a translation prompt, call OpenRouter, parse the response, and return `{ text, from, to }`

#### Scenario: Missing add-on

- **WHEN** the project does not have an active AI Translation add-on
- **THEN** the gateway SHALL return HTTP 402 with message indicating a translation add-on is required

#### Scenario: Empty text

- **WHEN** `text` is empty or whitespace-only
- **THEN** the gateway SHALL return HTTP 400 with message "Text is required"

#### Scenario: Invalid target language

- **WHEN** `to` is not a valid ISO 639-1 code
- **THEN** the gateway SHALL return HTTP 400 with message indicating invalid language code

#### Scenario: Text too long

- **WHEN** `text` exceeds 10,000 characters
- **THEN** the gateway SHALL return HTTP 400 with message indicating text length limit

### Requirement: Prompt construction

The gateway SHALL own the translation prompt template.

#### Scenario: System prompt

- **WHEN** building the OpenRouter request
- **THEN** the system prompt SHALL instruct the model to translate the user message to the target language, preserve formatting (markdown, HTML tags, newlines), and return only the translated text with no commentary

#### Scenario: User message isolation

- **WHEN** building the OpenRouter request
- **THEN** the user text SHALL be the `user` message content only, never interpolated into the system prompt

### Requirement: OpenRouter integration

Translation requests SHALL be routed through OpenRouter.

#### Scenario: Request to OpenRouter

- **WHEN** the gateway sends a translation request
- **THEN** it SHALL POST to `https://openrouter.ai/api/v1/chat/completions` with the `Authorization: Bearer ${OPENROUTER_API_KEY}` header

#### Scenario: Model selection

- **WHEN** building the OpenRouter request
- **THEN** the gateway SHALL specify the model (initially `google/gemini-2.0-flash` or equivalent cost-effective model)

#### Scenario: OpenRouter failure

- **WHEN** OpenRouter returns an error or times out
- **THEN** the gateway SHALL return HTTP 503 with a retry-friendly error message

#### Scenario: Timeout

- **WHEN** the OpenRouter request exceeds 30 seconds
- **THEN** the gateway SHALL abort and return HTTP 504

### Requirement: Rate limiting

#### Scenario: Per-project rate limit

- **WHEN** a project exceeds 60 translate requests per minute
- **THEN** the gateway SHALL return HTTP 429 with `Retry-After` header

### Requirement: Usage tracking and quota enforcement

Translation usage SHALL be tracked in the database and enforced against the project's add-on quota.

#### Scenario: Usage logging

- **WHEN** a translation request completes successfully
- **THEN** the gateway SHALL insert a row into `internal.ai_usage` with project_id, operation ("translate"), input_tokens, output_tokens, model, and timestamp

#### Scenario: No logging for errors

- **WHEN** a translation request fails (LLM error, timeout, validation error)
- **THEN** no usage row SHALL be inserted

#### Scenario: Quota check before request

- **WHEN** a translation request passes validation and add-on check
- **THEN** the gateway SHALL sum token usage for the project in the current billing period from `internal.ai_usage`
- **AND** if cumulative usage exceeds the add-on's included token quota, the gateway SHALL return HTTP 402 with message "Translation word limit reached"

#### Scenario: Usage displayed as words

- **WHEN** usage is exposed to the admin (via API or dashboard)
- **THEN** token counts SHALL be converted to "words" using the ratio tokens / 1.3 (rounded)

#### Scenario: Billing period reset

- **WHEN** a new billing period starts (based on the add-on subscription's billing cycle)
- **THEN** the quota check SHALL only sum usage rows within the current period — previous periods do not count against the quota
