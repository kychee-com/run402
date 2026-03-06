# Generate Image API — Specification

## Overview

A paid image generation endpoint on Run402, gated by x402 micropayments. Callers send a text prompt and receive a generated PNG image (base64-encoded) — no signup, no API keys, just pay-per-use.

The underlying model provider is intentionally hidden from users.

## Endpoint

```
POST /v1/generate-image
```

x402 price: **$0.03 USDC** (flat, all aspect ratios).

## Request Body

```json
{
  "prompt": "a cat wearing a top hat, watercolor style",
  "aspect": "square"
}
```

| Field    | Type   | Required | Default      | Description                        |
|----------|--------|----------|--------------|------------------------------------|
| `prompt` | string | Yes      | —            | Image description. Max 1000 chars. |
| `aspect` | string | No       | `"square"`   | One of the allowed aspect ratios.  |

### Allowed Aspect Ratios

| Value        | Ratio | Description          |
|--------------|-------|----------------------|
| `square`     | 1:1   | Square (default)     |
| `landscape`  | 16:9  | Wide landscape       |
| `portrait`   | 9:16  | Tall portrait        |

Invalid aspect ratios return `400 Bad Request`.

## Response

```json
{
  "image": "<base64-encoded PNG>",
  "content_type": "image/png",
  "aspect": "square"
}
```

Content-Type: `application/json`

## Validation & Errors

| Condition                  | Status | Response                                         |
|----------------------------|--------|--------------------------------------------------|
| Missing `prompt`           | 400    | `{"error": "prompt is required"}`                |
| Prompt exceeds 1000 chars  | 400    | `{"error": "prompt must be 1000 characters or less"}` |
| Invalid `aspect`           | 400    | `{"error": "invalid aspect, must be one of: ..."}`|
| Model content filter       | 422    | `{"error": "image generation refused by model"}`  |
| Upstream failure           | 502    | `{"error": "image generation failed"}`            |

## Backend: OpenRouter

- **Model**: `black-forest-labs/flux.2-klein-4b` via OpenRouter API (currently deployed: `google/gemini-2.5-flash-image`)
- **Why**: Cheapest available at $0.014/image flat. 2-5s response time.
- **Endpoint**: `POST https://openrouter.ai/api/v1/chat/completions` with `modalities: ["image"]`
- **Content moderation**: Rely on model's built-in safety filters (no additional filtering).
- **Secret**: `agentdb/openrouter-api-key` in AWS Secrets Manager (us-east-1)
- **Config**: `OPENROUTER_API_KEY` env var in ECS task definition, sourced from Secrets Manager

### OpenRouter Call

```
POST https://openrouter.ai/api/v1/chat/completions
Authorization: Bearer <OPENROUTER_API_KEY>

{
  "model": "black-forest-labs/flux.2-klein-4b",
  "messages": [{"role": "user", "content": "..."}],
  "modalities": ["image"],
  "image_config": {"width": 1024, "height": 1024}
}
```

Response contains `choices[0].message.images[]` (or `choices[0].message.content[]`) with `type: "image_url"` entries. The `image_url.url` is a data URI (`data:image/png;base64,...`). Extract the base64 portion.

Actual cost per request is in `usage.cost` (USD). Detailed breakdown in `usage.cost_details`.

### Model Cost Research (2026-03-06)

All models tested with a simple prompt at default size. Costs are **actual billed amounts** from `usage.cost`, not estimates from listed per-token pricing (which can differ significantly).

| Model | Actual $/image | Speed | Notes |
|-------|---------------|-------|-------|
| **black-forest-labs/flux.2-klein-4b** | **$0.014** | 3-5s | Cheapest. Flat rate, all sizes. |
| sourceful/riverflow-v2-fast | $0.020 | 10s | |
| sourceful/riverflow-v2-fast-preview | $0.030 | 10s | |
| black-forest-labs/flux.2-pro | $0.030 | 8s | |
| sourceful/riverflow-v2-standard-preview | $0.035 | 10s | |
| google/gemini-2.5-flash-image | $0.039 | 8s | Currently deployed |
| bytedance-seed/seedream-4.5 | $0.040 | 10s | |
| openai/gpt-5-image-mini | $0.040 | <1s | Fastest |
| black-forest-labs/flux.2-flex | $0.050 | 10s | |
| google/gemini-3.1-flash-image-preview | $0.068 | 10s | |
| black-forest-labs/flux.2-max | $0.070 | 10s | |
| sourceful/riverflow-v2-max-preview | $0.075 | 10s | |
| google/gemini-3-pro-image-preview | $0.136 | 3s | |
| sourceful/riverflow-v2-pro | $0.150 | 10s | |
| openai/gpt-5-image | $0.191 | <1s | |

**flux.2-klein-4b aspect ratio test** (cost varies slightly by ratio):

| Config | Cost | Output Dimensions | Image Size | Time |
|--------|------|-------------------|-----------|------|
| 1:1 | $0.017 | 1920x1920 | ~1.8 MB | 4-10s |
| 3:2 (landscape) | $0.016 | 1920x1280 | ~887 KB | 4s |
| 2:3 (portrait) | $0.016 | 1280x1920 | ~1.3 MB | 6s |
| 4:3 | $0.016 | 1920x1440 | ~1.1 MB | 4s |
| 16:9 (wide) | $0.015 | 1920x1072 | ~765 KB | 5s |
| 9:16 (tall) | $0.015 | 1072x1920 | ~1.5 MB | 3s |

Notes:
- `image_size` parameter (0.5K/1K/2K) is **ignored** by flux.2-klein — always outputs ~1920px on longest side
- Cost ranges from $0.015-$0.017 depending on pixel count (aspect ratio)
- With `width`/`height` params instead of `aspect_ratio`, the model ignores them and outputs 1024x768

**Key finding**: Listed per-token pricing on OpenRouter does NOT reflect actual billing for image generation. For example, gemini-2.5-flash-image lists $2.5/M completion tokens (implying ~$0.003/image for 1290 tokens), but actually bills $0.039. Image-only models like flux.2 use flat per-request pricing that is accurate.

### OpenRouter image_config API

Size is controlled via `image_config`, NOT `width`/`height`:

```json
{
  "image_config": {
    "aspect_ratio": "16:9",
    "image_size": "1K"
  }
}
```

Available aspect ratios: `1:1`, `2:3`, `3:2`, `3:4`, `4:3`, `4:5`, `5:4`, `9:16`, `16:9`, `21:9`.
Available image sizes: `0.5K`, `1K`, `2K`, `4K` (model-dependent, flux.2-klein ignores this).

**Implementation note**: Our `ALLOWED_SIZES` (e.g. `1024x1024`) should map to aspect ratios:
- `512x512`, `1024x1024`, `1536x1536` → `1:1`
- `1792x1024` → `16:9` (closest)
- `1024x1792` → `9:16` (closest)

## Pricing

| Item               | Cost       |
|--------------------|------------|
| Our cost (model)   | $0.015–$0.017 (flux.2-klein, varies by aspect ratio) |
| x402 charge        | $0.03 |
| Margin             | $0.013–$0.015 (~45-50%) |

Single flat price regardless of image size — all tested models charge the same across sizes.

## x402 Integration

### Payment Config (in `middleware/x402.ts`)

Add to `resourceConfig`:

```typescript
resourceConfig["POST /v1/generate-image"] = {
  accepts: networks.map((network) => ({
    scheme: "exact",
    price: "$0.03",
    network,
    payTo: payTo("$0.03"),
  })),
  description: "Generate an image from a text prompt ($0.03 USDC)",
  mimeType: "application/json",
  extensions: {
    ...declareDiscoveryExtension({
      bodyType: "json",
      inputSchema: {
        type: "object",
        properties: {
          prompt: { type: "string", description: "Text prompt for image generation" },
          aspect: {
            type: "string",
            enum: ["square", "landscape", "portrait"],
            description: "Aspect ratio (default: square)",
          },
        },
        required: ["prompt"],
      },
      output: {
        example: {
          image: "<base64 PNG data>",
          content_type: "image/png",
          aspect: "square",
        },
      },
    }),
  },
};
```

### Discovery (`.well-known/x402`)

Add `https://api.run402.com/v1/generate-image` to the resources array.

### Idempotency

Add `app.post("/v1/generate-image", idempotencyMiddleware)` before x402 middleware in `server.ts`.

## Code Structure

### New Files

- `packages/gateway/src/routes/generate-image.ts` — route handler
- `packages/gateway/src/services/generate-image.ts` — OpenRouter API client

### Modified Files

- `packages/gateway/src/config.ts` — add `OPENROUTER_API_KEY` export
- `packages/gateway/src/middleware/x402.ts` — add resource config entry
- `packages/gateway/src/server.ts` — import route, add idempotency middleware, add to discovery

## Implementation Notes

1. **No model name exposed**: Response does not include model name, provider, or any hint about the backend. Error messages are generic.
2. **Output format**: Always PNG. No format negotiation.
3. **Single image only**: No batch/count parameter. One prompt = one image.
4. **Secret loading**: `OPENROUTER_API_KEY` env var in ECS task definition, sourced from `agentdb/openrouter-api-key` in Secrets Manager.
5. **Timeout**: 30s timeout on the upstream call. Most models respond in 3-10s.
6. **Response parsing**: OpenRouter returns images in `message.images[]` or `message.content[]` as `image_url` parts with `data:image/png;base64,...` URLs. The service handles both formats.
