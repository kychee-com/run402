/**
 * OpenAPI discovery — /openapi.json
 *
 * Serves a discovery-optimized OpenAPI spec for agent tools like x402scan.
 * The full spec is at run402.com/openapi.json; this serves a minimal version
 * compatible with Zod v4 strict parsing (unknown keys cause parse failure).
 */

import { Router, Request, Response } from "express";
import { TIERS, SKU_PRICES } from "@run402/shared";

const router = Router();

function buildSpec(): object {
  const guidance = `Run402 is a pay-per-use backend for AI agents: Postgres databases, static hosting, serverless functions, and image generation. All payments use x402 USDC micropayments on Base.

## Quick start
1. Install the CLI: npm install -g run402
2. Create an allowance: run402 init
3. Subscribe to prototype tier (FREE, testnet USDC): run402 tier set prototype
4. Provision a project: run402 projects provision --name "my-app"
5. Deploy: run402 deploy --manifest app.json

## Payment model
- Tier subscriptions (prototype $0.10 testnet, hobby $5, team $20) unlock all platform features.
- Image generation is $0.03 per call (x402 micropayment).
- Auth-only endpoints (projects, deploys, messages) require SIWX wallet identity but no payment.

## Auth
- x402 endpoints: include a payment header (handled automatically by the CLI or x402 client libraries).
- SIWX endpoints: sign a CAIP-122 message with your wallet.
- REST API: use the project's anon_key or service_key as the apikey header.

## Docs
- Full CLI docs: https://run402.com/llms-cli.txt
- Full OpenAPI: https://run402.com/openapi.json`;

  const imagePrice = (SKU_PRICES["image"]! / 1_000_000).toFixed(2);

  // Helper: build an operation object with only fields the discovery schema expects.
  // Zod v4 strict mode rejects unknown keys, so we must only include:
  // operationId?, summary?, description?, tags?[], security?[], parameters?[{in,name,schema?,required?}],
  // requestBody?{required?,content:{[mime]:{schema?}}}, responses?{}, x-payment-info?{}
  type Op = {
    operationId?: string;
    summary?: string;
    description?: string;
    tags?: string[];
    security?: Record<string, string[]>[];
    parameters?: { in: string; name: string; schema?: unknown; required?: boolean }[];
    requestBody?: { required?: boolean; content: Record<string, { schema?: unknown }> };
    responses?: Record<string, unknown>;
    "x-payment-info"?: { pricingMode: string; price?: string; minPrice?: string; maxPrice?: string; protocols?: string[] };
  };

  const paths: Record<string, Record<string, Op>> = {};

  // --- Paid: per-tier endpoints ---
  for (const [tierName, tierConfig] of Object.entries(TIERS)) {
    paths[`/tiers/v1/${tierName}`] = {
      post: {
        operationId: `setTier_${tierName}`,
        summary: `Set ${tierName} tier (${tierConfig.price} USDC)`,
        description: `${tierConfig.description}. Auto-detects subscribe, renew, or upgrade.`,
        tags: ["tiers"],
        security: [{ x402: [] }],
        "x-payment-info": {
          protocols: ["x402", "mpp"],
          pricingMode: "fixed",
          price: tierConfig.price.replace("$", ""),
        },
        requestBody: {
          content: {
            "application/json": {
              schema: {
                type: "object",
                description: "No body required. Payment header determines wallet identity and tier action.",
              },
            },
          },
        },
        responses: {
          "201": { description: "Tier subscribed" },
          "200": { description: "Tier renewed or upgraded" },
          "402": { description: "Payment Required" },
        },
      },
    };
  }

  // --- Paid: image generation ---
  paths["/generate-image/v1"] = {
    post: {
      operationId: "generateImage",
      summary: `Generate an image (${imagePrice} USDC)`,
      description: "Generate an image from a text prompt using AI. Returns base64 PNG.",
      tags: ["image"],
      security: [{ x402: [] }],
      "x-payment-info": {
        protocols: ["x402", "mpp"],
        pricingMode: "fixed",
        price: imagePrice,
      },
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["prompt"],
              properties: {
                prompt: { type: "string", maxLength: 1000, description: "Text prompt for image generation" },
                aspect: { type: "string", enum: ["square", "landscape", "portrait"], description: "Aspect ratio (default: square)" },
              },
            },
          },
        },
      },
      responses: {
        "200": { description: "Image generated" },
        "402": { description: "Payment Required" },
      },
    },
  };

  // Auth-only (SIWX) routes are omitted from this discovery spec — they use
  // accepts: [] which x402scan rejects. Full API spec: https://run402.com/openapi.json

  // --- Free endpoints ---

  paths["/tiers/v1"] = {
    get: {
      operationId: "listTiers",
      summary: "List tiers and pricing",
      description: "Returns all available tiers with pricing, limits, and descriptions. No auth required.",
      tags: ["tiers"],
      security: [],
      responses: { "200": { description: "Tier listing" } },
    },
  };

  paths["/health"] = {
    get: {
      operationId: "health",
      summary: "Health check",
      description: "Returns service health status.",
      tags: ["utility"],
      security: [],
      responses: { "200": { description: "Service healthy" } },
    },
  };

  return {
    openapi: "3.1.0",
    info: {
      title: "Run402 API",
      version: "2.0.0",
      description: "Full-stack infrastructure for AI agents. Postgres, REST API, auth, file storage, static site hosting, serverless functions. Pay-per-tier via x402 USDC on Base.",
      guidance,
    },
    servers: [{ url: "https://api.run402.com" }],
    "x-service-info": {
      categories: ["compute", "data", "developer-tools", "storage"],
      docs: {
        homepage: "https://run402.com",
        apiReference: "https://run402.com/openapi.json",
      },
    },
    paths,
  };
}

let cachedSpec: object | null = null;

router.get("/openapi.json", (_req: Request, res: Response) => {
  if (!cachedSpec) cachedSpec = buildSpec();
  res.set("Cache-Control", "public, max-age=3600");
  res.json(cachedSpec);
});

export default router;
