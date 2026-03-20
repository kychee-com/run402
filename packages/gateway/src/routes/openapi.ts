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

  const imagePrice = `$${(SKU_PRICES["image"]! / 1_000_000).toFixed(2)}`;

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
          protocols: ["x402"],
          pricingMode: "fixed",
          price: tierConfig.price,
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
        protocols: ["x402"],
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

  // --- Auth-only (SIWX, no payment) ---

  paths["/projects/v1"] = {
    post: {
      operationId: "createProject",
      summary: "Create a Postgres project",
      description: "Provision a new Postgres database project. Requires SIWX wallet identity and active tier.",
      tags: ["projects"],
      security: [{ siwx: [] }],
      requestBody: {
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: {
                name: { type: "string", description: "Project name (auto-generated if omitted)" },
              },
            },
          },
        },
      },
      responses: {
        "201": { description: "Project created" },
        "402": { description: "SIWX wallet identity required" },
      },
    },
  };

  paths["/deployments/v1"] = {
    post: {
      operationId: "deploySite",
      summary: "Deploy a static site",
      description: "Upload and deploy static site files to a project.",
      tags: ["deployments"],
      security: [{ siwx: [] }],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["project", "files"],
              properties: {
                project: { type: "string", description: "Project ID" },
                files: { type: "array", description: "Array of { file, data, encoding? } objects" },
              },
            },
          },
        },
      },
      responses: {
        "201": { description: "Site deployed" },
        "402": { description: "SIWX wallet identity required" },
      },
    },
  };

  paths["/tiers/v1/status"] = {
    get: {
      operationId: "getTierStatus",
      summary: "Check tier subscription status",
      description: "Get the current tier, expiry, and usage for the authenticated wallet.",
      tags: ["tiers"],
      security: [{ siwx: [] }],
      responses: {
        "200": { description: "Tier status" },
        "402": { description: "SIWX wallet identity required" },
      },
    },
  };

  paths["/deploy/v1"] = {
    post: {
      operationId: "bundleDeploy",
      summary: "Full-stack app deployment",
      description: "Deploy to an existing project: runs migrations, applies RLS, sets secrets, deploys functions, deploys site, claims subdomain.",
      tags: ["deploy"],
      security: [{ siwx: [] }],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["project_id"],
              properties: {
                project_id: { type: "string" },
                migrations: { type: "string" },
                rls: { type: "object" },
                secrets: { type: "array" },
                functions: { type: "array" },
                files: { type: "array" },
                subdomain: { type: "string" },
              },
            },
          },
        },
      },
      responses: {
        "200": { description: "Deployment result" },
        "402": { description: "SIWX wallet identity required" },
      },
    },
  };

  paths["/fork/v1"] = {
    post: {
      operationId: "forkApp",
      summary: "Fork a published app",
      description: "Clone a published app version into a new project. Requires active tier.",
      tags: ["apps"],
      security: [{ siwx: [] }],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["version_id", "name"],
              properties: {
                version_id: { type: "string" },
                name: { type: "string" },
                subdomain: { type: "string" },
              },
            },
          },
        },
      },
      responses: {
        "201": { description: "App forked" },
        "402": { description: "SIWX wallet identity required" },
      },
    },
  };

  paths["/message/v1"] = {
    post: {
      operationId: "sendMessage",
      summary: "Send a message to Run402",
      description: "Send a text message to Run402 developers.",
      tags: ["messaging"],
      security: [{ siwx: [] }],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["message"],
              properties: { message: { type: "string" } },
            },
          },
        },
      },
      responses: {
        "200": { description: "Message sent" },
        "402": { description: "SIWX wallet identity required" },
      },
    },
  };

  paths["/agent/v1/contact"] = {
    post: {
      operationId: "setContact",
      summary: "Set agent contact info",
      description: "Register or update your agent's name, email, and webhook URL tied to your wallet.",
      tags: ["agent"],
      security: [{ siwx: [] }],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["name"],
              properties: {
                name: { type: "string" },
                email: { type: "string" },
                webhook: { type: "string" },
              },
            },
          },
        },
      },
      responses: {
        "200": { description: "Contact info saved" },
        "402": { description: "SIWX wallet identity required" },
      },
    },
  };

  paths["/ping/v1"] = {
    get: {
      operationId: "ping",
      summary: "Auth ping",
      description: "Authenticated ping. Returns wallet address and tier status.",
      tags: ["utility"],
      security: [{ siwx: [] }],
      responses: {
        "200": { description: "Pong" },
        "402": { description: "SIWX wallet identity required" },
      },
    },
  };

  // --- Free endpoints ---

  paths["/tiers/v1"] = {
    get: {
      operationId: "listTiers",
      summary: "List tiers and pricing",
      description: "Returns all available tiers with pricing, limits, and descriptions. No auth required.",
      tags: ["tiers"],
      responses: { "200": { description: "Tier listing" } },
    },
  };

  paths["/health"] = {
    get: {
      operationId: "health",
      summary: "Health check",
      description: "Returns service health status.",
      tags: ["utility"],
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
