### Requirement: Runtime helper

The `@run402/functions` module SHALL export an `ai` object with a `moderate` method.

#### Scenario: Basic moderation

- **WHEN** a function calls `ai.moderate("some user content")`
- **THEN** it SHALL return the OpenAI Moderation API response shape: `{ flagged, categories, category_scores }`

#### Scenario: Return shape

- **WHEN** `ai.moderate(text)` resolves
- **THEN** the result SHALL contain:
  - `flagged` (boolean) — true if any category is flagged
  - `categories` (object) — boolean per category (harassment, violence, sexual, etc.)
  - `category_scores` (object) — float 0.0-1.0 per category

#### Scenario: Clean content

- **WHEN** content is benign
- **THEN** `flagged` SHALL be `false` and all category scores SHALL be low

#### Scenario: Flagged content

- **WHEN** content violates a moderation category
- **THEN** `flagged` SHALL be `true` and the relevant category SHALL be `true` with a high score

### Requirement: Gateway endpoint

The gateway SHALL expose `POST /ai/v1/moderate` for moderation requests.

#### Scenario: Request format

- **WHEN** a valid request is received
- **THEN** the request body SHALL contain `text` (string, required)

#### Scenario: Auth

- **WHEN** a request is made without a valid service key
- **THEN** the gateway SHALL return HTTP 401

#### Scenario: Successful moderation

- **WHEN** a valid request is received
- **THEN** the gateway SHALL call the OpenAI Moderation API and return the result

#### Scenario: No add-on required

- **WHEN** any project with a valid service key calls the moderate endpoint
- **THEN** the request SHALL succeed regardless of add-ons or tier — moderation is free for all projects

#### Scenario: Empty text

- **WHEN** `text` is empty or whitespace-only
- **THEN** the gateway SHALL return HTTP 400 with message "Text is required"

#### Scenario: Text too long

- **WHEN** `text` exceeds 10,000 characters
- **THEN** the gateway SHALL return HTTP 400 with message indicating text length limit

### Requirement: OpenAI Moderation API integration

Moderation requests SHALL be routed to the OpenAI Moderation API.

#### Scenario: Request to OpenAI

- **WHEN** the gateway sends a moderation request
- **THEN** it SHALL POST to `https://api.openai.com/v1/moderations` with `Authorization: Bearer ${OPENAI_API_KEY}` header and body `{ input: text }`

#### Scenario: Response mapping

- **WHEN** OpenAI returns a moderation result
- **THEN** the gateway SHALL extract `results[0]` and return `{ flagged, categories, category_scores }`

#### Scenario: OpenAI failure

- **WHEN** the OpenAI API returns an error or times out
- **THEN** the gateway SHALL return HTTP 503

#### Scenario: Timeout

- **WHEN** the OpenAI request exceeds 10 seconds
- **THEN** the gateway SHALL abort and return HTTP 504

### Requirement: Rate limiting

#### Scenario: Per-project rate limit

- **WHEN** a project exceeds 120 moderate requests per minute
- **THEN** the gateway SHALL return HTTP 429 with `Retry-After` header

### Requirement: No billing

#### Scenario: No metering

- **WHEN** a moderation request completes
- **THEN** no usage SHALL be recorded and no billing event SHALL be emitted — moderation is free
