import { paymentMiddlewareFromHTTPServer, x402ResourceServer, x402HTTPResourceServer } from "@x402/express";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { createFacilitatorConfig } from "@coinbase/x402";
import { declareDiscoveryExtension, bazaarResourceServerExtension } from "@x402/extensions";
import { TIERS } from "@run402/shared";
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
} from "../config.js";
import type { TierName } from "@run402/shared";
import { getWalletSubscription } from "../services/stripe-subscriptions.js";
import { extractWalletFromPaymentHeader } from "../utils/wallet.js";

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

  // Subscription bypass: skip x402 settlement for wallets with active Stripe subscriptions
  if (STRIPE_SECRET_KEY) {
    httpServer.onProtectedRequest(async (context) => {
      if (!context.paymentHeader) return;
      const wallet = extractWalletFromPaymentHeader(context.paymentHeader);
      if (!wallet) return;
      const sub = await getWalletSubscription(wallet);
      if (sub?.status === "active") {
        console.log(`Subscription bypass: ${wallet} → ${sub.tier}`);
        return { grantAccess: true };
      }
    });
  }

  return paymentMiddlewareFromHTTPServer(httpServer);
}
