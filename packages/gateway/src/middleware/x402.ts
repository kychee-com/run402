import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { createFacilitatorConfig } from "@coinbase/x402";
import { TIERS } from "@agentdb/shared";
import { SELLER_ADDRESS, MAINNET_NETWORK, TESTNET_NETWORK, CDP_API_KEY_ID, CDP_API_KEY_SECRET } from "../config.js";
import type { TierName } from "@agentdb/shared";

/**
 * Build x402 payment middleware.
 * Uses CDP facilitator for both Base mainnet and Base Sepolia.
 */
export function createPaymentMiddleware() {
  const facilitatorClient = new HTTPFacilitatorClient(
    createFacilitatorConfig(CDP_API_KEY_ID, CDP_API_KEY_SECRET),
  );

  const networks = [MAINNET_NETWORK, TESTNET_NETWORK];

  // Build resource config for each tier
  const resourceConfig: Record<string, any> = {};

  for (const [tierName, tierConfig] of Object.entries(TIERS)) {
    resourceConfig[`POST /v1/projects/create/${tierName}`] = {
      accepts: networks.map((network) => ({
        scheme: "exact",
        price: tierConfig.price,
        network,
        payTo: SELLER_ADDRESS,
      })),
      description: tierConfig.description,
      mimeType: "application/json",
    };
  }

  // GET /v1/ping — paid health check ($0.001) for agents to verify x402 works
  resourceConfig["GET /v1/ping"] = {
    accepts: networks.map((network) => ({
      scheme: "exact",
      price: "$0.001",
      network,
      payTo: SELLER_ADDRESS,
    })),
    description: "Paid ping — validates x402 payment flow ($0.001 USDC)",
    mimeType: "application/json",
  };

  // POST /v1/projects — default route uses prototype pricing
  resourceConfig["POST /v1/projects"] = {
    accepts: networks.map((network) => ({
      scheme: "exact",
      price: TIERS.prototype.price,
      network,
      payTo: SELLER_ADDRESS,
    })),
    description: "Create a new AgentDB project (Prototype tier — default)",
    mimeType: "application/json",
  };

  const server = new x402ResourceServer(facilitatorClient);
  for (const network of networks) {
    server.register(network as `${string}:${string}`, new ExactEvmScheme());
  }

  return paymentMiddleware(resourceConfig, server);
}
