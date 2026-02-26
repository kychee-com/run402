import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { TIERS } from "@agentdb/shared";
import { SELLER_ADDRESS, FACILITATOR_URL, NETWORK } from "../config.js";
import type { TierName } from "@agentdb/shared";

/**
 * Build x402 payment middleware.
 * Gates project creation at tier-specific prices.
 * Renewal uses the same pricing.
 */
export function createPaymentMiddleware() {
  const facilitatorClient = new HTTPFacilitatorClient({ url: FACILITATOR_URL });

  // Build resource config for each tier
  const resourceConfig: Record<string, any> = {};

  // POST /v1/projects — priced per tier (default to hobby if no tier specified)
  // The tier is specified in the request body, but x402 needs a single price per route.
  // We use the hobby tier price as default; agents specify tier in body.
  // For testnet, we also support prototype at $0.10.
  for (const [tierName, tierConfig] of Object.entries(TIERS)) {
    resourceConfig[`POST /v1/projects/create/${tierName}`] = {
      accepts: [
        {
          scheme: "exact",
          price: tierConfig.price,
          network: NETWORK,
          payTo: SELLER_ADDRESS,
        },
      ],
      description: tierConfig.description,
      mimeType: "application/json",
    };
  }

  // POST /v1/projects — default route uses hobby pricing
  resourceConfig["POST /v1/projects"] = {
    accepts: [
      {
        scheme: "exact",
        price: TIERS.prototype.price,
        network: NETWORK,
        payTo: SELLER_ADDRESS,
      },
    ],
    description: "Create a new AgentDB project (Prototype tier — default)",
    mimeType: "application/json",
  };

  return paymentMiddleware(
    resourceConfig,
    new x402ResourceServer(facilitatorClient).register(NETWORK as `${string}:${string}`, new ExactEvmScheme()),
  );
}
