import { defineConfig, nodeFunction } from "@run402/sdk/config";

export default defineConfig({
  functions: {
    replace: {
      wallet_stats: nodeFunction("functions/wallet-stats.js", {
        config: { timeoutSeconds: 10, memoryMb: 128 },
      }),
    },
  },
  routes: {
    replace: [
      {
        pattern: "/wallet-stats",
        methods: ["POST"],
        target: { type: "function", name: "wallet_stats" },
        pricing: {
          mode: "always",
          amount_usd_micros: 30_000,
          pay_to: "org_default_payout",
          networks: ["testnet"],
        },
      },
    ],
  },
  checks: [
    {
      name: "wallet-stats requires x402 payment",
      http: { path: "/wallet-stats", method: "POST", expect: { status: 402 } },
    },
  ],
});
