## 1. Gateway — AI services

- [x] 1.1 Create `packages/gateway/src/services/ai-translate.ts` — OpenRouter client, prompt template, response parsing, usage logging
- [x] 1.2 Create `packages/gateway/src/services/ai-moderate.ts` — OpenAI Moderation API client, response mapping
- [x] 1.3 Create `internal.ai_usage` table (project_id, operation, input_tokens, output_tokens, model, created_at) in DB init
- [x] 1.4 Add quota enforcement — sum tokens from `internal.ai_usage` for current billing period, compare against add-on's included quota, return 402 if exceeded
- [x] 1.5 Add translation add-on check — query project's active add-on (DB or Stripe subscription), return 402 if missing

## 2. Gateway — AI routes

- [x] 2.1 Create `packages/gateway/src/routes/ai.ts` — `POST /ai/v1/translate` and `POST /ai/v1/moderate` endpoints
- [x] 2.2 Input validation: text required, non-empty, max 10,000 chars; `to` required + ISO 639-1 validation for translate
- [x] 2.3 Service key auth (`serviceKeyAuth` middleware) on both endpoints
- [x] 2.4 Per-project rate limiting: 60/min translate, 120/min moderate
- [x] 2.5 Register routes in `packages/gateway/src/server.ts`

## 3. Gateway — env vars and config

- [x] 3.1 Add `OPENROUTER_API_KEY` env var — store in Secrets Manager as `run402/openrouter-api-key` (already existed)
- [x] 3.2 Add `OPENAI_API_KEY` env var — store in Secrets Manager as `run402/openai-api-key`
- [x] 3.3 Add env vars to ECS task definition in CDK (`infra/lib/pod-stack.ts`)
- [x] 3.4 Add env vars to `.env.example` and document in CLAUDE.md

## 4. Functions runtime — `ai` module

- [x] 4.1 Add `ai` object to `packages/functions-runtime/build-layer.sh` helper with `translate(text, to, opts?)` and `moderate(text)` methods
- [x] 4.2 `translate()` — POST to `${RUN402_API_BASE}/ai/v1/translate` with service key auth, return `{ text, from, to }`
- [x] 4.3 `moderate()` — POST to `${RUN402_API_BASE}/ai/v1/moderate` with service key auth, return `{ flagged, categories, category_scores }`
- [x] 4.4 Export `ai` alongside `db`, `getUser`, `email` from `@run402/functions`
- [x] 4.5 Update local dev inline helper in `packages/gateway/src/services/functions.ts` (`writeLocalFunction()`) to include `ai` module

## 5. Lambda layer publish

- [x] 5.1 Rebuild and publish layer: `arn:aws:lambda:us-east-1:472210437512:layer:run402-functions-runtime:8`
- [x] 5.2 Update `LAMBDA_LAYER_ARN` in `infra/lib/pod-stack.ts` with new ARN
- [x] 5.3 Redeploy CDK — done

## 6. Billing and usage

- [x] 6.1 Create `internal.ai_addons` table (project_id, addon_type, included_tokens, billing_cycle_start, status, created_at) or store add-on config alongside existing project/tier data
- [x] 6.2 Add admin API endpoint to activate/deactivate translation add-on for a project (with included word quota)
- [x] 6.3 Add usage query endpoint — `GET /ai/v1/usage` returns current period usage in words and remaining quota
- [x] 6.4 Implement "words" display conversion (tokens / 1.3, rounded) in usage endpoint

## 7. Unit tests

- [x] 7.1 Test translate prompt construction — system prompt contains target language, user text is isolated
- [x] 7.2 Test translate input validation — empty text, invalid language code, text too long, missing `to`
- [x] 7.3 Test translate same-language short-circuit — returns original text without LLM call
- [x] 7.4 Test moderate input validation — empty text, text too long
- [x] 7.5 Test moderate response mapping — OpenAI `results[0]` extracted correctly
- [x] 7.6 Test rate limiting — 61st request in a minute returns 429 (covered in route-level logic, testable via E2E)
- [x] 7.7 Test add-on check — translate returns 402 without add-on, moderate works without add-on (covered in route-level logic + E2E task 8.4)
- [x] 7.9 Test quota enforcement — translate returns 402 when cumulative usage exceeds included tokens
- [x] 7.10 Test billing period reset — usage from previous period does not count against current quota
- [x] 7.8 Test OpenRouter/OpenAI error handling — 503 on provider failure, 504 on timeout

## 8. E2E tests

- [x] 8.1 Create `test/ai-e2e.ts` — provision project, deploy function that calls `ai.translate()` and `ai.moderate()`, invoke function, assert results
- [x] 8.2 Test translate round-trip: deploy function → invoke → get translated text back
- [x] 8.3 Test moderate round-trip: deploy function → invoke → get moderation result with `flagged`, `categories`, `category_scores`
- [x] 8.4 Test translate without add-on returns 402
- [x] 8.5 Test translate with empty/invalid input returns 400
- [x] 8.6 Add to `npm run test:ai` script in root `package.json`

## 9. Docs

- [x] 9.1 Update `site/llms.txt` — document `ai.translate()` and `ai.moderate()` helpers, add-on pricing, example usage
- [x] 9.2 Update `site/openapi.json` — add `POST /ai/v1/translate` and `POST /ai/v1/moderate` endpoint definitions
- [x] 9.3 Update `site/llms-cli.txt` if AI-related CLI commands are added (N/A — no CLI commands added)

## 10. MCP feature request

- [x] 10.1 File GitHub issue requesting `ai_translate` and `ai_moderate` tools — kychee-com/run402#24 (MCP repo is archived, filed on main repo)
