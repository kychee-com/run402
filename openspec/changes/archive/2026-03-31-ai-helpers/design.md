## Context

Run402 edge functions already have `db` (PostgREST client) and `getUser()` (JWT extraction) as runtime helpers. Both follow the same pattern: thin client in the Lambda layer that calls back to the gateway over HTTP. The gateway handles auth, routing, and external service integration.

AI capabilities (translation, moderation) are the next runtime helpers. Wild Lychee already implements both by calling OpenAI/Anthropic directly with user-supplied API keys. This works but means no usage tracking, no billing, and every fork re-implements prompt engineering. Run402 should own the AI layer — same pattern as `db`.

## Goals

- Add `ai.translate(text, targetLang)` and `ai.moderate(text)` to `@run402/functions`
- Route translation through OpenRouter (Stripe partner integration for token metering)
- Route moderation through OpenAI Moderation API (free, no tokens)
- Bill translation as an add-on package sold in "words", metered as tokens internally
- Moderation is free, bundled into the platform

## Non-Goals

- Generic `ai.chat()` or raw LLM access
- Per-member billing (admin pays, members use for free)
- Changes to Wild Lychee (adopts helpers independently)
- Custom model selection per project (Run402 picks the model)

## Decisions

### 1. Gateway as AI proxy (not direct from Lambda)

**Choice:** Functions call `POST ${RUN402_API_BASE}/ai/v1/translate` and `POST ${RUN402_API_BASE}/ai/v1/moderate` via the gateway, same as `db.from()` calls PostgREST through the gateway.

**Alternatives considered:**
- *Direct from Lambda:* Function calls OpenRouter directly with a per-project API key. Simpler but means Lambda needs network egress to OpenRouter, Run402 can't enforce tier limits or rate limits, and billing metadata must be embedded in the API key or request headers.

**Rationale:** The gateway already authenticates service keys, knows the project's Stripe customer ID, and can enforce limits. Adding two routes is cheaper than building a per-project API key system. Consistent with existing architecture.

### 2. OpenRouter for translation, OpenAI for moderation

**Choice:** Translation goes through OpenRouter. Moderation goes directly to OpenAI's `/v1/moderations` endpoint (free, no token cost).

**Alternatives considered:**
- *OpenRouter for both:* Would cost tokens for moderation. OpenAI moderation is free and purpose-built.
- *OpenAI for both:* OpenRouter gives us multi-provider flexibility and future Stripe partner integration when available.

**Rationale:** Use the best tool for each job. OpenRouter for the billable LLM operation (with future Stripe partner integration path). OpenAI for free, high-quality moderation.

### 3. Gateway owns prompt templates

**Choice:** The translation system prompt lives in the gateway, not in the function runtime or user code. The function sends raw text + target language; the gateway wraps it in the appropriate prompt and sends to OpenRouter.

**Rationale:** Centralizing prompts means Run402 can improve translation quality for all apps without a Lambda layer rebuild. It also prevents prompt injection — user text is always the user message, never part of the system prompt construction on the client side.

### 4. Translation model selection

**Choice:** Gateway picks the model based on cost/quality. Start with a fast, cheap model (e.g., `google/gemini-2.0-flash`) via OpenRouter. Model choice is an internal detail — not exposed to function authors.

**Rationale:** Run402 controls margins. If a cheaper model achieves adequate translation quality, use it. Can A/B test or upgrade models without any app-side changes.

### 5. Billing as "words" add-on with DB-based metering

**Choice:** Translation is a separate Stripe add-on product, not tied to project tiers. Sold as "words/month" packages. Metered internally via `internal.ai_usage` table (DB-based), not Stripe token billing (private preview, not yet available).

**How it works:**
- Stripe product: "AI Translation" with price tiers (e.g., 10k words/mo, 50k words/mo, pay-as-you-go)
- Gateway logs every translation to `internal.ai_usage` with input_tokens, output_tokens, model, timestamp
- Gateway computes cumulative usage per project per billing cycle from `internal.ai_usage`
- Admin-facing usage is displayed as "words" (tokens / ~1.3 as rough conversion)
- Projects without an active translation add-on get HTTP 402 from the translate endpoint
- **Quota enforcement:** Gateway sums token usage for the current billing period before each request. If cumulative usage exceeds the add-on's included words (converted to tokens), returns HTTP 402 "Translation word limit reached" (or bills overage if pay-as-you-go)
- **Future:** When Stripe token billing exits private preview, migrate to OpenRouter → Stripe partner integration for automatic metering. The `internal.ai_usage` table remains as an audit log.

**Alternatives considered:**
- *Stripe token billing via OpenRouter partner:* Ideal but in private preview. Planned migration path when available.
- *Tier-based:* "Pro tier includes 5000 translations." Couples AI pricing to infrastructure pricing — changes to one affect the other.
- *Raw token billing:* Confusing for non-technical community admins.

### 6. Auth for AI endpoints

**Choice:** Service key auth (`serviceKeyAuth` middleware), same as all other project API calls. The service key identifies the project; the gateway resolves project → Stripe customer for billing.

**Rationale:** No new auth mechanism needed. Functions already have `RUN402_SERVICE_KEY` injected.

### 7. Rate limiting

**Choice:** Per-project rate limit on AI endpoints. Start with 60 requests/minute for translate, 120 requests/minute for moderate. Enforced at the gateway with in-memory counters (same pattern as existing rate limits).

**Rationale:** Prevents runaway costs from buggy functions. Moderation is free so the limit is just for API protection.

## Risks / Trade-offs

**"Words" ≠ tokens exactly** → Admin might feel overcharged if a 100-word post costs 200 tokens (prompt overhead).
*Mitigation:* Set the words→tokens ratio conservatively (1 word ≈ 1.3 tokens). Include prompt overhead in the ratio. Be transparent in docs.

**OpenRouter downtime** → Translate calls fail.
*Mitigation:* Return clear error (503) with retry-after header. Functions can catch and degrade gracefully. Moderation is unaffected (different provider).

**DB-based metering has race conditions under high concurrency** → Two concurrent requests could both pass the quota check before either writes usage.
*Mitigation:* Acceptable for v1 — translation is not a high-QPS operation (community posts, not real-time chat). If it becomes a problem, add a `SELECT ... FOR UPDATE` lock on a per-project usage counter row, or migrate to Stripe token billing.

**Prompt injection in translation** → Malicious UGC could try to hijack the translation prompt.
*Mitigation:* User text is always the `user` message, never interpolated into the system prompt. The system prompt instructs the model to translate only. Output is treated as untrusted (app should still sanitize for XSS etc.).

## Migration Plan

Additive change. No migration needed.

1. Deploy gateway with new `/ai/v1/*` routes (behind feature check — projects need active translation add-on)
2. Publish new Lambda layer with `ai` module
3. Update `LAMBDA_LAYER_ARN` in CDK
4. Redeploy CDK
5. Existing functions are unaffected — `ai` is opt-in

## Open Questions

- **Model choice:** Is Gemini Flash adequate for translation quality, or should we start with Claude Haiku? Need to test.
- **Language detection:** Should `ai.translate()` auto-detect source language, or require it? Auto-detect is simpler for the caller but adds latency/cost if the model needs to figure it out.
- **Batch translate:** Should there be an `ai.translateBatch()` for translating multiple texts in one call? WL's translate function processes multiple posts per invocation.
