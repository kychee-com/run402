## Why

Run402 apps that need AI (translation, moderation) currently bring their own API keys and call providers directly. This means no usage tracking, no billing, and every app re-implements prompt engineering and provider integration. Wild Lychee has `translate-content.js` and `moderate-content.js` that duplicate this pattern — and every fork will too.

Run402 should provide `ai.translate()` and `ai.moderate()` as runtime helpers — same pattern as `db.from()` for Postgres. The platform owns the prompts, model selection, and billing. App developers just call the helper.

## What Changes

- **Functions runtime**: Add `ai.translate(text, targetLang)` and `ai.moderate(text)` helpers to `@run402/functions`. These call back to the gateway (same pattern as `db` → PostgREST).
- **Gateway**: New `/ai/v1/translate` endpoint that builds the prompt, proxies to OpenRouter, and meters usage. New `/ai/v1/moderate` endpoint that proxies to the OpenAI Moderation API (free, no tokens).
- **Billing**: Translation is a purchasable add-on (not tied to tiers). Sold as "words" to admins, metered as tokens internally via `internal.ai_usage` table. Gateway enforces quota per billing period. Packages (e.g. 10,000 words/mo) and pay-as-you-go. Future: migrate to Stripe token billing + OpenRouter partner integration when available.
- **Moderation**: Free, bundled into the platform. No metering.
- **Docs**: Update `llms.txt`, `openapi.json` with new endpoints and helpers.
- **MCP**: File a GitHub feature request on `kychee-com/run402-mcp` for new `ai_translate` / `ai_moderate` tools.
- **BREAKING**: None. Existing functions are unaffected. New opt-in helpers only.

## Non-goals

- Changes to Wild Lychee itself (it will adopt the helpers independently)
- Generic `ai.chat()` / raw LLM access (may come later)
- Per-member billing (the project admin pays, members use for free)

## Capabilities

### New Capabilities
- `ai-translate`: Runtime helper + gateway endpoint for AI translation. Supports any target language, auto-detects source. Routed via OpenRouter. Metered per project via DB-based usage tracking with quota enforcement. Sold as a word-based add-on.
- `ai-moderate`: Runtime helper + gateway endpoint for content moderation. Proxies to OpenAI Moderation API. Free, unmetered. Returns category flags and scores.

### Modified Capabilities

_(none)_

## Impact

- **Functions runtime** (`packages/functions-runtime/`): New `ai` module with `translate()` and `moderate()` that HTTP POST back to gateway. Lambda layer rebuild + publish required.
- **Gateway** (`packages/gateway/src/`): New routes (`/ai/v1/translate`, `/ai/v1/moderate`), new services (`ai.ts` or `ai-translate.ts` + `ai-moderate.ts`), OpenRouter client, OpenAI moderation client, prompt templates for translation.
- **Database**: New `internal.ai_usage` table for token metering, new `internal.ai_addons` table (or similar) for add-on config and quotas. Gateway enforces quota per billing period.
- **Stripe** (future): Migrate metering to Stripe token billing + OpenRouter partner integration when available.
- **Env vars**: `OPENROUTER_API_KEY`, `OPENAI_API_KEY` (for moderation endpoint only).
- **Tests**: Unit tests for prompt construction, response parsing, error handling. E2E test for translate + moderate round-trip through a deployed function.
- **Docs**: `site/llms.txt` gains AI helper documentation. `site/openapi.json` gains `/ai/v1/*` endpoints.
- **MCP repo**: GitHub issue on `kychee-com/run402-mcp` requesting `ai_translate` and `ai_moderate` tools.
