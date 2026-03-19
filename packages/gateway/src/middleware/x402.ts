import { paymentMiddlewareFromHTTPServer, x402ResourceServer, x402HTTPResourceServer } from "@x402/express";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { createFacilitatorConfig } from "@coinbase/x402";
import { declareDiscoveryExtension, bazaarResourceServerExtension } from "@x402/extensions";
import { siwxResourceServerExtension, declareSIWxExtension, parseSIWxHeader, validateSIWxMessage, verifySIWxSignature } from "@x402/extensions/sign-in-with-x";
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
import { getWalletTier } from "../services/wallet-tiers.js";
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
      unpaidResponseBody: async () => ({
        contentType: "application/json",
        body: {
          error: "Payment required",
          message: `To set tier '${tierName}', include x402 payment of ${tierConfig.price} USDC. If this tier is already active, payment will renew the subscription.`,
          tier: tierName,
          price: tierConfig.price,
        },
      }),
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
        ...declareSIWxExtension({ statement: "Sign in to Run402" }),
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

  // --- Auth-only endpoints (SIWX identity required, no payment) ---
  // accepts: [] signals "identity required, no payment" per x402 spec.
  // Server returns 402 with SIWX challenge; client signs and sends SIGN-IN-WITH-X.
  const authOnlyEndpoints = [
    { route: "POST /projects/v1", description: "Create a new Postgres project (requires active tier)" },
    { route: "POST /deployments/v1", description: "Deploy a static site" },
    { route: "GET /tiers/v1/status", description: "Check your tier subscription status" },
    { route: "POST /message/v1", description: "Send a message to an agent" },
    { route: "POST /agent/v1/contact", description: "Set your agent contact info" },
    { route: "GET /ping/v1", description: "Auth-only ping" },
    { route: "POST /deploy/v1", description: "Full-stack app deployment (requires active tier)" },
    { route: "POST /fork/v1", description: "Fork an app (requires active tier)" },
  ];

  for (const { route, description } of authOnlyEndpoints) {
    resourceConfig[route] = {
      accepts: [],
      description,
      extensions: {
        ...declareSIWxExtension({ statement: "Sign in to Run402", network: networks }),
      },
    };
  }

  const server = new x402ResourceServer(facilitatorClient);
  server.registerExtension(bazaarResourceServerExtension);
  server.registerExtension(siwxResourceServerExtension);
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

  // SIWX auth hook: for auth-only routes (accepts: []), validate the SIWX
  // signature and grant access. walletAuth downstream handles wallet extraction + tier checks.
  httpServer.onProtectedRequest(createSIWxAuthOnlyHook(resourceConfig));

  // Track allowance debit results per-request (keyed by payment header)
  // so the wrapper middleware can set response headers and req.walletAddress after the x402 library calls next().
  const allowanceResults = new Map<string, { remaining: number; wallet: string }>();

  // Track whether paying wallet has contact info (keyed by payment header).
  // true = has contact, false = no contact (should hint).
  const contactCheckResults = new Map<string, boolean>();

  // Track wallet tier info for tier routes — used to augment 402 responses with context.
  // Keyed by payment header hash; populated in onProtectedRequest, consumed in wrapper.
  const tierContextResults = new Map<string, { wallet: string; tier: string | null; active: boolean; lease_expires_at: string | null }>();

  // Tier context: when a tier endpoint is hit, check wallet's current tier status
  // so 402 responses can explain "already active" instead of being cryptic.
  httpServer.onProtectedRequest(async (context) => {
    if (!context.paymentHeader) return;

    // Only for tier endpoints
    const tierMatch = context.path.match(/^\/tiers\/v1\/(\w+)$/);
    if (!tierMatch) return;

    const wallet = extractWalletFromPaymentHeader(context.paymentHeader);
    if (!wallet) return;

    try {
      const tierInfo = await getWalletTier(wallet);
      tierContextResults.set(context.paymentHeader, {
        wallet,
        tier: tierInfo.tier,
        active: tierInfo.active,
        lease_expires_at: tierInfo.lease_expires_at as string | null,
      });
    } catch {
      // Best effort — don't block payment flow
    }
  });

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

    // Stash result for the wrapper to read when setting response headers + req.walletAddress
    allowanceResults.set(context.paymentHeader, { remaining: result.remaining, wallet });

    console.log(`Allowance debit: ${wallet} → ${price.sku} ($${(price.amountUsdMicros / 1_000_000).toFixed(4)}) remaining=$${(result.remaining / 1_000_000).toFixed(4)}`);

    return { grantAccess: true as const };
  });

  const x402Middleware = paymentMiddlewareFromHTTPServer(httpServer);

  // Wrapper middleware: adds X-Run402-Settlement-Rail and X-Run402-Allowance-Remaining headers.
  // Also augments 402 responses on tier routes with helpful context (e.g. "tier already active").
  return async (req: Request, res: Response, next: NextFunction) => {
    const paymentHeader = (req.headers["payment-signature"] || req.headers["x-payment"] || req.headers["x-402-payment"]) as string | undefined;

    if (paymentHeader) {
      // Set req.walletAddress for downstream routes when allowance rail is used.
      // Without this, routes like project creation wouldn't know which wallet paid.
      if (allowanceResults.has(paymentHeader)) {
        req.walletAddress = allowanceResults.get(paymentHeader)!.wallet;
      }

      // Intercept res.json to augment 402 responses on tier routes with wallet context.
      const tierMatch = req.path.match(/^\/tiers\/v1\/(\w+)$/);
      if (tierMatch && tierMatch[1] && tierMatch[1] !== "status") {
        const requestedTier = tierMatch[1] as TierName;
        const realJson = res.json.bind(res);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- augmenting x402 response body
        res.json = function (body: any) {
          if (res.statusCode === 402 && body && typeof body === "object") {
            // Augment empty or sparse 402 body with helpful tier context
            const tierConfig = TIERS[requestedTier];
            if (tierConfig) {
              body.error = body.error || "Payment required";
              body.message = `Payment of ${tierConfig.price} USDC required to set tier '${requestedTier}'.`;
              body.tier = requestedTier;
              body.price = tierConfig.price;
            }
            // If we identified the wallet's current tier, include that info
            const tierCtx = tierContextResults.get(paymentHeader);
            if (tierCtx) {
              tierContextResults.delete(paymentHeader);
              if (tierCtx.active && tierCtx.tier === requestedTier) {
                body.message = `Tier '${requestedTier}' is already active on this wallet (expires ${tierCtx.lease_expires_at}). Payment will renew the subscription.`;
              } else if (tierCtx.active && tierCtx.tier) {
                body.message = `Wallet is currently on '${tierCtx.tier}' tier (expires ${tierCtx.lease_expires_at}). Payment of ${TIERS[requestedTier]?.price} USDC will switch to '${requestedTier}'.`;
              }
              body.current_tier = tierCtx.tier;
              body.current_tier_active = tierCtx.active;
              body.lease_expires_at = tierCtx.lease_expires_at;
            }
          }
          return realJson(body);
        } as Response["json"];
      }

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
        tierContextResults.delete(paymentHeader);
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

/**
 * SIWX auth-only hook — validates SIWX signatures for routes with accepts: [].
 * Exported for testing.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createSIWxAuthOnlyHook(resourceConfig: Record<string, any>) {
  return async (context: { method: string; path: string; adapter: { getHeader: (name: string) => string | undefined; getUrl: () => string } }) => {
    const routeKey = `${context.method.toUpperCase()} ${context.path}`;
    const config = resourceConfig[routeKey];
    if (!config || !Array.isArray(config.accepts) || config.accepts.length > 0) return;

    const siwxHeader = context.adapter.getHeader("sign-in-with-x") || context.adapter.getHeader("SIGN-IN-WITH-X");
    if (!siwxHeader) return;

    try {
      const payload = parseSIWxHeader(siwxHeader);
      const resourceUri = context.adapter.getUrl();
      const validation = await validateSIWxMessage(payload, resourceUri);
      if (!validation.valid) return;

      const verification = await verifySIWxSignature(payload);
      if (!verification.valid || !verification.address) return;

      recordWallet(verification.address.toLowerCase(), "siwx");
      return { grantAccess: true as const };
    } catch {
      return;
    }
  };
}
