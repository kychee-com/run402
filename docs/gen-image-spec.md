# Generate Image API — Specification

## Overview

A paid image generation endpoint on Run402, gated by x402 micropayments. Callers send a text prompt and receive a generated PNG image (base64-encoded) — no signup, no API keys, just pay-per-use.

The underlying model provider is intentionally hidden from users.

## Endpoint

```
POST /v1/generate-image
```

x402 price: **$0.01 USDC** (flat, all sizes).

## Request Body

```json
{
  "prompt": "a cat wearing a top hat, watercolor style",
  "size": "1024x1024"
}
```

| Field    | Type   | Required | Default      | Description                        |
|----------|--------|----------|--------------|------------------------------------|
| `prompt` | string | Yes      | —            | Image description. Max 1000 chars. |
| `size`   | string | No       | `"1024x1024"`| One of the allowed dimensions.     |

### Allowed Sizes

| Value        | Description          |
|--------------|----------------------|
| `512x512`    | Small square         |
| `1024x1024`  | Medium square        |
| `1536x1536`  | Large square         |
| `1792x1024`  | Landscape            |
| `1024x1792`  | Portrait             |

Invalid sizes return `400 Bad Request`.

## Response

```json
{
  "image": "<base64-encoded PNG>",
  "content_type": "image/png",
  "size": "1024x1024"
}
```

Content-Type: `application/json`

## Validation & Errors

| Condition                  | Status | Response                                         |
|----------------------------|--------|--------------------------------------------------|
| Missing `prompt`           | 400    | `{"error": "prompt is required"}`                |
| Prompt exceeds 1000 chars  | 400    | `{"error": "prompt must be 1000 characters or less"}` |
| Invalid `size`             | 400    | `{"error": "invalid size, must be one of: ..."}`  |
| Model content filter       | 422    | `{"error": "image generation refused by model"}`  |
| Upstream failure           | 502    | `{"error": "image generation failed"}`            |

## Backend: OpenRouter + FLUX Schnell

- **Model**: `black-forest-labs/flux-schnell` via OpenRouter API
- **Why**: Fastest, cheapest (~$0.003/image). Best value for money.
- **Content moderation**: Rely on FLUX's built-in safety filters (no additional filtering).
- **Secret**: `ecs/python-agent-example/openrouter-api-key` in AWS Secrets Manager (us-east-1)
- **Config**: Add `OPENROUTER_API_KEY` env var to gateway config, loaded from Secrets Manager at deploy time

### OpenRouter Call

```
POST https://openrouter.ai/api/v1/images/generations
Authorization: Bearer <OPENROUTER_API_KEY>

{
  "model": "black-forest-labs/flux-schnell",
  "prompt": "...",
  "size": "1024x1024",
  "response_format": "b64_json"
}
```

The response contains `data[0].b64_json` — forward this as the `image` field in our response.

## Pricing

| Item               | Cost       |
|--------------------|------------|
| Our cost (model)   | ~$0.003    |
| x402 charge        | $0.01      |
| Margin             | ~$0.007 (~3x markup) |

Single flat price regardless of image size. Flux-schnell cost is roughly the same across sizes.

## x402 Integration

### Payment Config (in `middleware/x402.ts`)

Add to `resourceConfig`:

```typescript
resourceConfig["POST /v1/generate-image"] = {
  accepts: networks.map((network) => ({
    scheme: "exact",
    price: "$0.01",
    network,
    payTo: payTo("$0.01"),
  })),
  description: "Generate an image from a text prompt ($0.01 USDC)",
  mimeType: "application/json",
  extensions: {
    ...declareDiscoveryExtension({
      bodyType: "json",
      inputSchema: {
        type: "object",
        properties: {
          prompt: { type: "string", description: "Text prompt for image generation" },
          size: {
            type: "string",
            enum: ["512x512", "1024x1024", "1536x1536", "1792x1024", "1024x1792"],
            description: "Image dimensions (default: 1024x1024)",
          },
        },
        required: ["prompt"],
      },
      output: {
        example: {
          image: "<base64 PNG data>",
          content_type: "image/png",
          size: "1024x1024",
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
4. **Secret loading**: The OpenRouter key should be injected as an env var (`OPENROUTER_API_KEY`) in the ECS task definition, sourced from the existing Secrets Manager secret.
5. **Timeout**: OpenRouter + flux-schnell typically responds in 2-5 seconds. Set a 30s timeout on the upstream call as safety margin.
