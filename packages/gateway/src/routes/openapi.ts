/**
 * OpenAPI 3.1 discovery endpoint — /openapi.json
 *
 * Canonical machine-readable API spec for agent discovery.
 * Includes x-payment-info for x402-gated endpoints and JSON schemas for all inputs/outputs.
 */

import { Router, Request, Response } from "express";
import { TIERS, SKU_PRICES } from "@run402/shared";
import type { TierName } from "@run402/shared";

const router = Router();

function buildSpec(): object {
  // --- Shared schemas ---
  const tierEnum = Object.keys(TIERS) as TierName[];

  const siwxSecurityScheme = {
    type: "apiKey",
    in: "header",
    name: "SIGN-IN-WITH-X",
    description: "CAIP-122 Sign-In-With-X header (base64-encoded JSON). Provides wallet identity for auth-only endpoints.",
  };

  const x402SecurityScheme = {
    type: "apiKey",
    in: "header",
    name: "X-Payment",
    description: "x402 payment header. The client signs a USDC payment authorization; the server settles via a facilitator.",
  };

  // --- Guidance (concise, for agents) ---
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
- SIWX endpoints: sign a CAIP-122 message with your wallet. The server returns a 402 with a SIWX challenge; sign and resend.
- REST API: use the project's anon_key or service_key as the apikey header.

## Docs
- Full CLI docs: https://run402.com/llms-cli.txt
- API docs: https://run402.com/llms.txt`;

  // --- Build tier paths ---
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const paths: Record<string, any> = {};

  for (const [tierName, tierConfig] of Object.entries(TIERS)) {
    paths[`/tiers/v1/${tierName}`] = {
      post: {
        operationId: `setTier_${tierName}`,
        summary: `Set ${tierName} tier (${tierConfig.price} USDC)`,
        description: tierConfig.description + ". Auto-detects subscribe, renew, or upgrade.",
        tags: ["tiers"],
        "x-payment-info": {
          protocols: ["x402"],
          pricingMode: "fixed",
          price: tierConfig.price,
        },
        security: [{ x402: [] }],
        requestBody: {
          required: false,
          content: {
            "application/json": {
              schema: {
                type: "object",
                description: "No body required. Payment header determines wallet identity.",
              },
            },
          },
        },
        responses: {
          "201": {
            description: "Tier subscribed",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    wallet: { type: "string", description: "Wallet address" },
                    action: { type: "string", enum: ["subscribe", "renew", "upgrade", "downgrade"], description: "Action performed" },
                    tier: { type: "string", enum: tierEnum },
                    previous_tier: { type: ["string", "null"], enum: [...tierEnum, null] },
                    lease_started_at: { type: "string", format: "date-time" },
                    lease_expires_at: { type: "string", format: "date-time" },
                    allowance_remaining_usd_micros: { type: "integer" },
                  },
                },
              },
            },
          },
          "402": { description: "Payment Required" },
        },
      },
    };
  }

  // --- Image generation ---
  const imagePrice = `$${(SKU_PRICES["image"]! / 1_000_000).toFixed(2)}`;
  paths["/generate-image/v1"] = {
    post: {
      operationId: "generateImage",
      summary: `Generate an image (${imagePrice} USDC)`,
      description: "Generate an image from a text prompt using AI. Returns base64 PNG.",
      tags: ["image"],
      "x-payment-info": {
        protocols: ["x402"],
        pricingMode: "fixed",
        price: imagePrice,
      },
      security: [{ x402: [] }],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["prompt"],
              properties: {
                prompt: { type: "string", maxLength: 1000, description: "Text prompt for image generation" },
                aspect: { type: "string", enum: ["square", "landscape", "portrait"], default: "square", description: "Aspect ratio" },
              },
            },
          },
        },
      },
      responses: {
        "200": {
          description: "Image generated",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  status: { type: "string", enum: ["ok"] },
                  aspect: { type: "string" },
                  content_type: { type: "string" },
                  image: { type: "string", description: "Base64-encoded PNG image data" },
                },
              },
            },
          },
        },
        "402": { description: "Payment Required" },
      },
    },
  };

  // --- Auth-only endpoints (SIWX, no payment) ---

  // POST /projects/v1
  paths["/projects/v1"] = {
    post: {
      operationId: "createProject",
      summary: "Create a Postgres project",
      description: "Provision a new Postgres database project. Requires active tier subscription.",
      tags: ["projects"],
      security: [{ siwx: [] }],
      requestBody: {
        required: false,
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
        "201": {
          description: "Project created",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  project_id: { type: "string" },
                  anon_key: { type: "string", description: "Public key for read-only REST access" },
                  service_key: { type: "string", description: "Admin key (bypasses RLS)" },
                  schema_slot: { type: "string" },
                },
              },
            },
          },
        },
        "402": { description: "Payment Required — SIWX wallet identity required" },
      },
    },
  };

  // POST /deployments/v1
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
                target: { type: "string", description: "Deployment target (optional)" },
                files: {
                  type: "array",
                  items: {
                    type: "object",
                    required: ["file", "data"],
                    properties: {
                      file: { type: "string", description: "File path (e.g. index.html)" },
                      data: { type: "string", description: "File content" },
                      encoding: { type: "string", enum: ["utf-8", "base64"], default: "utf-8" },
                    },
                  },
                },
              },
            },
          },
        },
      },
      responses: {
        "201": {
          description: "Site deployed",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  id: { type: "string", description: "Deployment ID" },
                  url: { type: "string", description: "Deployment URL" },
                  status: { type: "string" },
                },
              },
            },
          },
        },
        "402": { description: "Payment Required — SIWX wallet identity required" },
      },
    },
  };

  // GET /tiers/v1/status
  paths["/tiers/v1/status"] = {
    get: {
      operationId: "getTierStatus",
      summary: "Check tier subscription status",
      description: "Get the current tier, expiry, and usage for the authenticated wallet.",
      tags: ["tiers"],
      security: [{ siwx: [] }],
      responses: {
        "200": {
          description: "Tier status",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  wallet: { type: "string" },
                  tier: { type: ["string", "null"], enum: [...tierEnum, null] },
                  active: { type: "boolean" },
                  lease_started_at: { type: ["string", "null"], format: "date-time" },
                  lease_expires_at: { type: ["string", "null"], format: "date-time" },
                },
              },
            },
          },
        },
        "402": { description: "Payment Required — SIWX wallet identity required" },
      },
    },
  };

  // POST /deploy/v1
  paths["/deploy/v1"] = {
    post: {
      operationId: "bundleDeploy",
      summary: "Full-stack app deployment",
      description: "Deploy to an existing project: runs migrations, applies RLS, sets secrets, deploys functions, deploys site, claims subdomain. Requires active tier.",
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
                project_id: { type: "string", description: "Project ID (from POST /projects/v1)" },
                migrations: { type: "string", description: "SQL migrations to run" },
                rls: {
                  type: "object",
                  properties: {
                    template: { type: "string", enum: ["user_owns_rows", "public_read", "public_read_write"] },
                    tables: {
                      type: "array",
                      items: {
                        type: "object",
                        required: ["table"],
                        properties: {
                          table: { type: "string" },
                          owner_column: { type: "string" },
                        },
                      },
                    },
                  },
                },
                secrets: {
                  type: "array",
                  items: {
                    type: "object",
                    required: ["key", "value"],
                    properties: {
                      key: { type: "string" },
                      value: { type: "string" },
                    },
                  },
                },
                functions: {
                  type: "array",
                  items: {
                    type: "object",
                    required: ["name", "code"],
                    properties: {
                      name: { type: "string" },
                      code: { type: "string" },
                      config: {
                        type: "object",
                        properties: {
                          timeout: { type: "integer" },
                          memory: { type: "integer" },
                        },
                      },
                    },
                  },
                },
                files: {
                  type: "array",
                  items: {
                    type: "object",
                    required: ["file", "data"],
                    properties: {
                      file: { type: "string" },
                      data: { type: "string" },
                      encoding: { type: "string", enum: ["utf-8", "base64"] },
                    },
                  },
                },
                subdomain: { type: "string", description: "Subdomain to claim (e.g. my-app → my-app.run402.com)" },
              },
            },
          },
        },
      },
      responses: {
        "200": {
          description: "Deployment result",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  project_id: { type: "string" },
                  steps: { type: "object", description: "Results of each deployment step" },
                },
              },
            },
          },
        },
        "402": { description: "Payment Required — SIWX wallet identity required" },
      },
    },
  };

  // POST /fork/v1
  paths["/fork/v1"] = {
    post: {
      operationId: "forkApp",
      summary: "Fork a published app",
      description: "Clone a published app version (schema, site, functions) into a new project. Requires active tier.",
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
                version_id: { type: "string", description: "Published app version ID to fork" },
                name: { type: "string", description: "Name for the new project" },
                subdomain: { type: "string", description: "Subdomain to claim (optional)" },
              },
            },
          },
        },
      },
      responses: {
        "201": {
          description: "App forked",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  project_id: { type: "string" },
                  anon_key: { type: "string" },
                  service_key: { type: "string" },
                  subdomain_url: { type: ["string", "null"] },
                },
              },
            },
          },
        },
        "402": { description: "Payment Required — SIWX wallet identity required" },
      },
    },
  };

  // POST /message/v1
  paths["/message/v1"] = {
    post: {
      operationId: "sendMessage",
      summary: "Send a message to Run402",
      description: "Send a text message to Run402 developers via Telegram.",
      tags: ["messaging"],
      security: [{ siwx: [] }],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["message"],
              properties: {
                message: { type: "string", description: "Message text" },
              },
            },
          },
        },
      },
      responses: {
        "200": {
          description: "Message sent",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  status: { type: "string", enum: ["sent"] },
                },
              },
            },
          },
        },
        "402": { description: "Payment Required — SIWX wallet identity required" },
      },
    },
  };

  // POST /agent/v1/contact
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
                name: { type: "string", description: "Agent display name" },
                email: { type: "string", format: "email", description: "Contact email (optional)" },
                webhook: { type: "string", format: "uri", description: "Webhook URL, must be https (optional)" },
              },
            },
          },
        },
      },
      responses: {
        "200": {
          description: "Contact info saved",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  wallet: { type: "string" },
                  name: { type: "string" },
                  email: { type: ["string", "null"] },
                  webhook: { type: ["string", "null"] },
                  updated_at: { type: "string", format: "date-time" },
                },
              },
            },
          },
        },
        "402": { description: "Payment Required — SIWX wallet identity required" },
      },
    },
  };

  // GET /ping/v1
  paths["/ping/v1"] = {
    get: {
      operationId: "ping",
      summary: "Auth ping",
      description: "Simple authenticated ping. Returns wallet address and tier status.",
      tags: ["utility"],
      security: [{ siwx: [] }],
      responses: {
        "200": {
          description: "Pong",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  status: { type: "string", enum: ["ok"] },
                  wallet: { type: "string" },
                  tier: { type: ["string", "null"] },
                  timestamp: { type: "string", format: "date-time" },
                },
              },
            },
          },
        },
        "402": { description: "Payment Required — SIWX wallet identity required" },
      },
    },
  };

  // --- Free endpoints (no auth) ---

  // GET /tiers/v1
  paths["/tiers/v1"] = {
    get: {
      operationId: "listTiers",
      summary: "List tiers and pricing",
      description: "Returns all available tiers with pricing, limits, and descriptions. No auth required.",
      tags: ["tiers"],
      responses: {
        "200": {
          description: "Tier listing",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  tiers: {
                    type: "object",
                    additionalProperties: {
                      type: "object",
                      properties: {
                        price: { type: "string" },
                        lease_days: { type: "integer" },
                        storage_mb: { type: "integer" },
                        api_calls: { type: "integer" },
                        max_functions: { type: "integer" },
                        description: { type: "string" },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  };

  // GET /health
  paths["/health"] = {
    get: {
      operationId: "health",
      summary: "Health check",
      description: "Returns service health status for Postgres, PostgREST, S3, and CloudFront.",
      tags: ["utility"],
      responses: {
        "200": {
          description: "Service healthy",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  status: { type: "string", enum: ["healthy", "degraded"] },
                  checks: { type: "object" },
                  version: { type: "string" },
                },
              },
            },
          },
        },
      },
    },
  };

  return {
    openapi: "3.1.0",
    info: {
      title: "Run402 API",
      version: "1.0.0",
      description: "Postgres databases, static hosting, serverless functions, and image generation for AI agents. Pay-per-tier with x402 USDC micropayments on Base.",
      contact: {
        name: "Run402",
        url: "https://run402.com",
      },
      guidance,
    },
    servers: [
      { url: "https://api.run402.com", description: "Production" },
    ],
    paths,
    components: {
      securitySchemes: {
        x402: x402SecurityScheme,
        siwx: siwxSecurityScheme,
      },
    },
  };
}

// Cache the spec — it's static
let cachedSpec: object | null = null;

router.get("/openapi.json", (_req: Request, res: Response) => {
  if (!cachedSpec) cachedSpec = buildSpec();
  res.set("Cache-Control", "public, max-age=3600");
  res.json(cachedSpec);
});

export default router;
