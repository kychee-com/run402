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
import { pool } from "../db/pool.js";
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
 *
 * Pay-per-tier model: x402 gates only POST /tiers/v1/:tier + generate-image.
 * All other endpoints use walletAuth (free with active tier).
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

  // Build resource config — only x402-gated endpoints
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- x402 resource config shape is defined by @x402/express
  const resourceConfig: Record<string, any> = {};

  // --- Tier endpoints (x402-gated) ---
  // POST /tiers/v1/:tier — auto-detects subscribe, renew, or upgrade

  for (const [tierName, tierConfig] of Object.entries(TIERS)) {
    resourceConfig[`POST /tiers/v1/${tierName}`] = {
      accepts: networks.map((network) => ({
        scheme: "exact",
        price: tierConfig.price,
        network,
        payTo: payTo(tierConfig.price),
      })),
      description: `Set ${tierName} tier (${tierConfig.price} USDC) — auto-detects subscribe/renew/upgrade`,
      mimeType: "application/json",
      extensions: {
        ...declareDiscoveryExtension({
          output: {
            example: {
              wallet: "0x...",
              action: "subscribe",
              tier: tierName,
              lease_expires_at: "2026-04-08T00:00:00Z",
            },
          },
        }),
      },
    };
  }

  // --- Per-call paid endpoints (still x402-gated) ---

  // POST /generate-image/v1 — image generation ($0.03)
  resourceConfig["POST /generate-image/v1"] = {
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

  // Track whether paying wallet has contact info (keyed by payment header).
  // true = has contact, false = no contact (should hint).
  const contactCheckResults = new Map<string, boolean>();

  // Allowance rail: debit allowance balance instead of on-chain settlement
  httpServer.onProtectedRequest(async (context) => {
    if (!context.paymentHeader) return;
    const wallet = extractWalletFromPaymentHeader(context.paymentHeader);
    if (!wallet) return;

    recordWallet(wallet, "x402");

    // Fire non-blocking contact check (result used by writeHead interceptor for hint header)
    pool.query(
      `SELECT 1 FROM internal.agent_contacts WHERE wallet_address = $1`,
      [wallet],
    ).then((r) => {
      contactCheckResults.set(context.paymentHeader!, r.rows.length > 0);
    }).catch(() => {
      // On error, don't set hint — fail open
    });

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
    const paymentHeader = (req.headers["payment-signature"] || req.headers["x-payment"] || req.headers["x-402-payment"]) as string | undefined;

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
          // Hint: suggest setting contact info if wallet has none
          if (contactCheckResults.has(paymentHeader)) {
            if (!contactCheckResults.get(paymentHeader)) {
              res.setHeader("X-Run402-Hint", "set-contact");
            }
            contactCheckResults.delete(paymentHeader);
          }
        }
        return realWriteHead.apply(this, args);
      } as Response["writeHead"];

      // Safety net: clean up the Map entries if the connection closes before writeHead fires
      res.on("close", () => {
        allowanceResults.delete(paymentHeader);
        contactCheckResults.delete(paymentHeader);
      });
    }

    x402Middleware(req, res, next);
  };
}

/**
 * Map a request method+path to a price in micro-USD.
 * Pay-per-tier: only POST /tiers/v1/:tier + generate-image have prices.
 */
function resolveSkuPrice(method: string, path: string): { sku: string; amountUsdMicros: number } | null {

  // Tier endpoint: POST /tiers/v1/:tier
  const tierMatch = path.match(/^\/tiers\/v1\/(\w+)$/);
  if (tierMatch && tierMatch[1] && tierMatch[1] !== "status") {
    const tierName = tierMatch[1] as TierName;
    if (TIERS[tierName]) {
      return { sku: `tier_${tierName}`, amountUsdMicros: TIERS[tierName].priceUsdMicros };
    }
  }

  // Per-call: generate-image
  if (method === "POST" && path === "/generate-image/v1") {
    return { sku: "image", amountUsdMicros: SKU_PRICES["image"]! };
  }

  return null;
}
