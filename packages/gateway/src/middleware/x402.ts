import { paymentMiddlewareFromHTTPServer, x402ResourceServer, x402HTTPResourceServer } from "@x402/express";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { createFacilitatorConfig } from "@coinbase/x402";
import { declareDiscoveryExtension, bazaarResourceServerExtension } from "@x402/extensions";
import { TIERS, SKU_PRICES } from "@run402/shared";
import Stripe from "stripe";
import {
  SELLER_ADDRESS,
  MAINNET_NETWORK,
  TESTNET_NETWORK,
  CDP_API_KEY_ID,
  CDP_API_KEY_SECRET,
  FACILITATOR_PROVIDER,
  FACILITATOR_URL,
  STRIPE_SECRET_KEY,
  ADMIN_KEY,
} from "../config.js";
import type { TierName } from "@run402/shared";
import { getBillingAccount, debitAllowance } from "../services/billing.js";
import { extractWalletFromPaymentHeader, recordWallet } from "../utils/wallet.js";
import { createHash } from "node:crypto";
import type { Request, Response, NextFunction } from "express";

// --- Stripe payTo machinery ---

const validPayToAddresses = new Set<string>();

/**
 * Factory: returns a dynamic payTo function that creates a Stripe PaymentIntent
 * and extracts the crypto deposit address.  On retry (payment header present)
 * it validates the `to` address against the in-memory cache.
 */
function createPayToAddressFactory(priceStr: string) {
  const dollars = parseFloat(priceStr.replace("$", ""));
  const amountInCents = Math.max(1, Math.round(dollars * 100));

  const stripe = new Stripe(STRIPE_SECRET_KEY);

  return async function createPayToAddress(context: { paymentHeader?: string }): Promise<string> {
    // Retry call: validate address from payment header
    if (context.paymentHeader) {
      const decoded = JSON.parse(
        Buffer.from(context.paymentHeader, "base64").toString(),
      );
      const toAddress = decoded.payload?.authorization?.to;

      if (toAddress && typeof toAddress === "string") {
        // Normalize to lowercase — Stripe returns lowercase, but EIP-55 checksum may differ.
        // Must return lowercase to match the original 402 response (deepEqual comparison).
        const normalized = toAddress.toLowerCase();
        if (!validPayToAddresses.has(normalized)) {
          throw new Error("Invalid payTo address: not found in server cache");
        }
        return normalized;
      }
      throw new Error("PaymentIntent did not return expected crypto deposit details");
    }

    // First call: create PaymentIntent → deposit address
    const paymentIntent = await stripe.paymentIntents.create({
      amount: amountInCents,
      currency: "usd",
      payment_method_types: ["crypto"],
      payment_method_data: {
        type: "crypto",
      },
      payment_method_options: {
        crypto: {
          // @ts-expect-error — Stripe crypto payments beta (types not yet stable)
          mode: "custom",
        },
      },
      confirm: true,
    });

    if (
      !paymentIntent.next_action ||
      !("crypto_collect_deposit_details" in paymentIntent.next_action)
    ) {
      throw new Error("PaymentIntent did not return expected crypto deposit details");
    }

    const depositDetails = (paymentIntent.next_action as Record<string, Record<string, Record<string, Record<string, string>>>>).crypto_collect_deposit_details;
    const payToAddress: string = depositDetails.deposit_addresses.base.address;

    console.log(
      `Stripe PaymentIntent ${paymentIntent.id}: $${(amountInCents / 100).toFixed(2)} → ${payToAddress}`,
    );

    validPayToAddresses.add(payToAddress.toLowerCase());
    return payToAddress;
  };
}

// --- Middleware builder ---

/**
 * Build x402 payment middleware.
 * Reads FACILITATOR_PROVIDER to select CDP or Stripe facilitator.
 */
export function createPaymentMiddleware() {
  const useStripe = FACILITATOR_PROVIDER === "stripe";

  const facilitatorClient = useStripe
    ? new HTTPFacilitatorClient({ url: FACILITATOR_URL })
    : new HTTPFacilitatorClient(createFacilitatorConfig(CDP_API_KEY_ID, CDP_API_KEY_SECRET));

  // Stripe facilitator (x402.org) only supports Base Sepolia for now
  const networks = useStripe ? [TESTNET_NETWORK] : [MAINNET_NETWORK, TESTNET_NETWORK];

  // Helper: payTo value for a given price
  const payTo = (price: string) =>
    useStripe ? createPayToAddressFactory(price) : SELLER_ADDRESS;

  // Build resource config for each tier
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- x402 resource config shape is defined by @x402/express
  const resourceConfig: Record<string, any> = {};

  for (const [tierName, tierConfig] of Object.entries(TIERS)) {
    resourceConfig[`POST /v1/projects/create/${tierName}`] = {
      accepts: networks.map((network) => ({
        scheme: "exact",
        price: tierConfig.price,
        network,
        payTo: payTo(tierConfig.price),
      })),
      description: tierConfig.description,
      mimeType: "application/json",
      extensions: {
        ...declareDiscoveryExtension({
          bodyType: "json",
          inputSchema: {
            type: "object",
            properties: { name: { type: "string", description: "Project name" } },
            required: ["name"],
          },
          output: {
            example: {
              project_id: "prj_...",
              anon_key: "eyJ...",
              service_key: "eyJ...",
              schema_slot: "s0001",
              lease_expires_at: "2026-03-08T00:00:00Z",
            },
          },
        }),
      },
    };
  }

  // POST /v1/deploy/:tier — bundle deploy (tier-priced)
  for (const [tierName, tierConfig] of Object.entries(TIERS)) {
    resourceConfig[`POST /v1/deploy/${tierName}`] = {
      accepts: networks.map((network) => ({
        scheme: "exact",
        price: tierConfig.price,
        network,
        payTo: payTo(tierConfig.price),
      })),
      description: `Bundle deploy — one-call full-stack app (${tierConfig.description})`,
      mimeType: "application/json",
      extensions: {
        ...declareDiscoveryExtension({
          bodyType: "json",
          inputSchema: {
            type: "object",
            properties: {
              name: { type: "string", description: "App name" },
              migrations: { type: "string", description: "SQL migrations (optional)" },
              functions: { type: "array", description: "Functions to deploy (optional)" },
              site: { type: "array", description: "Site files to deploy (optional)" },
              subdomain: { type: "string", description: "Custom subdomain (optional)" },
            },
            required: ["name"],
          },
          output: {
            example: {
              project_id: "prj_...",
              anon_key: "eyJ...",
              service_key: "eyJ...",
              site_url: "https://myapp.run402.com",
              functions: [{ name: "checkout", url: "https://api.run402.com/functions/v1/checkout" }],
            },
          },
        }),
      },
    };
  }

  // POST /v1/fork/:tier — fork a published app (tier-priced)
  for (const [tierName, tierConfig] of Object.entries(TIERS)) {
    resourceConfig[`POST /v1/fork/${tierName}`] = {
      accepts: networks.map((network) => ({
        scheme: "exact",
        price: tierConfig.price,
        network,
        payTo: payTo(tierConfig.price),
      })),
      description: `Fork a published app — independent copy with fresh backend (${tierConfig.description})`,
      mimeType: "application/json",
      extensions: {
        ...declareDiscoveryExtension({
          bodyType: "json",
          inputSchema: {
            type: "object",
            properties: {
              version_id: { type: "string", description: "App version ID to fork" },
              name: { type: "string", description: "Name for the forked app" },
              subdomain: { type: "string", description: "Custom subdomain (optional)" },
            },
            required: ["version_id", "name"],
          },
          output: {
            example: {
              project_id: "prj_...",
              anon_key: "eyJ...",
              service_key: "eyJ...",
              source_version_id: "ver_...",
              readiness: "ready",
            },
          },
        }),
      },
    };
  }

  // GET /v1/ping — paid health check ($0.001) for agents to verify x402 works
  resourceConfig["GET /v1/ping"] = {
    accepts: networks.map((network) => ({
      scheme: "exact",
      price: "$0.001",
      network,
      payTo: payTo("$0.001"),
    })),
    description: "Paid ping — validates x402 payment flow ($0.001 USDC)",
    mimeType: "application/json",
    extensions: {
      ...declareDiscoveryExtension({
        output: { example: { pong: true } },
      }),
    },
  };

  // POST /v1/deployments — static site deployment ($0.05)
  resourceConfig["POST /v1/deployments"] = {
    accepts: networks.map((network) => ({
      scheme: "exact",
      price: "$0.05",
      network,
      payTo: payTo("$0.05"),
    })),
    description: "Deploy a static site — Vercel-compatible inlined file upload ($0.05 USDC)",
    mimeType: "application/json",
    extensions: {
      ...declareDiscoveryExtension({
        bodyType: "json",
        inputSchema: {
          type: "object",
          properties: {
            name: { type: "string", description: "Site name" },
            project: { type: "string", description: "Optional project ID to link deployment" },
            target: { type: "string", description: "Deployment target (e.g. 'production')" },
            files: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  file: { type: "string", description: "File path (e.g. 'index.html')" },
                  data: { type: "string", description: "File content" },
                  encoding: { type: "string", description: "'utf-8' (default) or 'base64'" },
                },
                required: ["file", "data"],
              },
            },
          },
          required: ["name", "files"],
        },
        output: {
          example: {
            id: "dpl_1709337600000_a1b2c3",
            name: "my-site",
            url: "https://dpl-1709337600000-a1b2c3.sites.run402.com",
            status: "READY",
            files_count: 2,
            total_size: 4096,
          },
        },
      }),
    },
  };

  // POST /v1/message — paid developer contact ($0.01)
  resourceConfig["POST /v1/message"] = {
    accepts: networks.map((network) => ({
      scheme: "exact",
      price: "$0.01",
      network,
      payTo: payTo("$0.01"),
    })),
    description: "Send a message to Run402 developers ($0.01 USDC)",
    mimeType: "application/json",
    extensions: {
      ...declareDiscoveryExtension({
        bodyType: "json",
        inputSchema: {
          type: "object",
          properties: { message: { type: "string", description: "Message text" } },
          required: ["message"],
        },
        output: { example: { status: "sent" } },
      }),
    },
  };

  // POST /v1/generate-image — image generation ($0.03)
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

  // POST /v1/projects — default route uses prototype pricing
  resourceConfig["POST /v1/projects"] = {
    accepts: networks.map((network) => ({
      scheme: "exact",
      price: TIERS.prototype.price,
      network,
      payTo: payTo(TIERS.prototype.price),
    })),
    description: "Create a new AgentDB project (Prototype tier — default)",
    mimeType: "application/json",
    extensions: {
      ...declareDiscoveryExtension({
        bodyType: "json",
        inputSchema: {
          type: "object",
          properties: { name: { type: "string", description: "Project name" } },
          required: ["name"],
        },
        output: {
          example: {
            project_id: "prj_...",
            anon_key: "eyJ...",
            service_key: "eyJ...",
            schema_slot: "s0001",
            lease_expires_at: "2026-03-08T00:00:00Z",
          },
        },
      }),
    },
  };

  const server = new x402ResourceServer(facilitatorClient);
  server.registerExtension(bazaarResourceServerExtension);
  for (const network of networks) {
    server.register(network as `${string}:${string}`, new ExactEvmScheme());
  }

  const httpServer = new x402HTTPResourceServer(server, resourceConfig);

  // Admin key bypass: pinned apps calling our own paid endpoints
  if (ADMIN_KEY) {
    httpServer.onProtectedRequest(async (context) => {
      const adminKey = context.adapter.getHeader("x-admin-key");
      if (adminKey && adminKey === ADMIN_KEY) {
        return { grantAccess: true };
      }
    });
  }

  // Track allowance debit results per-request (keyed by payment header)
  // so the wrapper middleware can set response headers after the x402 library calls next().
  const allowanceResults = new Map<string, { remaining: number }>();

  // Allowance rail: debit allowance balance instead of on-chain settlement
  httpServer.onProtectedRequest(async (context) => {
    if (!context.paymentHeader) return;
    const wallet = extractWalletFromPaymentHeader(context.paymentHeader);
    if (!wallet) return;

    recordWallet(wallet, "x402");

    // Check if wallet has a billing account with balance
    const account = await getBillingAccount(wallet);
    if (!account || account.status !== "active") return;

    // Resolve price for this request
    const price = resolveSkuPrice(context.method, context.path);
    if (!price) return;

    // Check sufficient balance
    if (account.available_usd_micros < price.amountUsdMicros) return;

    // Debit allowance
    const headerHash = createHash("sha256").update(context.paymentHeader).digest("hex");
    const result = await debitAllowance(wallet, price.amountUsdMicros, price.sku, headerHash);
    if (!result) return; // Insufficient balance (race condition), fall through to x402

    // Stash result for the wrapper to read when setting response headers
    allowanceResults.set(context.paymentHeader, { remaining: result.remaining });

    console.log(`Allowance debit: ${wallet} → ${price.sku} ($${(price.amountUsdMicros / 1_000_000).toFixed(4)}) remaining=$${(result.remaining / 1_000_000).toFixed(4)}`);

    return { grantAccess: true as const };
  });

  const x402Middleware = paymentMiddlewareFromHTTPServer(httpServer);

  // Wrapper middleware: adds X-Run402-Settlement-Rail and X-Run402-Allowance-Remaining headers.
  return async (req: Request, res: Response, next: NextFunction) => {
    const paymentHeader = req.header("payment-signature") || req.header("x-payment");

    if (paymentHeader) {
      // Intercept writeHead to inject settlement headers before the response is sent.
      // For the allowance path: x402 returns no-payment-required → next() → route handler → writeHead fires.
      // For the x402 path: x402 buffers writeHead, runs settlement, then replays through our wrapper.
      const realWriteHead = res.writeHead;
      let headersInjected = false;

      res.writeHead = function (this: Response, ...args: Parameters<Response["writeHead"]>) {
        if (!headersInjected) {
          headersInjected = true;
          if (allowanceResults.has(paymentHeader)) {
            const result = allowanceResults.get(paymentHeader)!;
            allowanceResults.delete(paymentHeader);
            res.setHeader("X-Run402-Settlement-Rail", "allowance");
            res.setHeader("X-Run402-Allowance-Remaining", String(result.remaining));
          } else if (res.statusCode < 400) {
            // Native x402 path succeeded
            res.setHeader("X-Run402-Settlement-Rail", "x402");
          }
        }
        return realWriteHead.apply(this, args);
      } as Response["writeHead"];

      // Safety net: clean up the Map entry if the connection closes before writeHead fires
      res.on("close", () => {
        allowanceResults.delete(paymentHeader);
      });
    }

    x402Middleware(req, res, next);
  };
}

/**
 * Map a request method+path to a price in micro-USD.
 * Uses tier prices for project/deploy/fork endpoints, SKU_PRICES for others.
 */
function resolveSkuPrice(method: string, path: string): { sku: string; amountUsdMicros: number } | null {

  // Tier-priced endpoints: POST /v1/projects/create/:tier, POST /v1/deploy/:tier, POST /v1/fork/:tier
  const tierMatch = path.match(/^\/v1\/(?:projects\/create|deploy|fork)\/(\w+)$/);
  if (tierMatch && tierMatch[1]) {
    const tierName = tierMatch[1] as TierName;
    if (TIERS[tierName]) {
      return { sku: `tier_${tierName}`, amountUsdMicros: TIERS[tierName].priceUsdMicros };
    }
  }

  // POST /v1/projects (default prototype)
  if (method === "POST" && path === "/v1/projects") {
    return { sku: "tier_prototype", amountUsdMicros: TIERS.prototype.priceUsdMicros };
  }

  // SKU-priced endpoints
  if (method === "GET" && path === "/v1/ping") {
    return { sku: "ping", amountUsdMicros: SKU_PRICES["ping"]! };
  }
  if (method === "POST" && path === "/v1/message") {
    return { sku: "message", amountUsdMicros: SKU_PRICES["message"]! };
  }
  if (method === "POST" && path === "/v1/generate-image") {
    return { sku: "image", amountUsdMicros: SKU_PRICES["image"]! };
  }
  if (method === "POST" && path === "/v1/deployments") {
    return { sku: "deployment", amountUsdMicros: SKU_PRICES["deployment"]! };
  }

  return null;
}
