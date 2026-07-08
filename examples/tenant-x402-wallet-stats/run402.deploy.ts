import { defineConfig, file, nodeFunction } from "@run402/sdk/config";

export default defineConfig({
  site: {
    replace: {
      "index.html": file("static/index.html", { contentType: "text/html; charset=utf-8" }),
    },
  },
  functions: {
    replace: {
      "wallet-stats": nodeFunction("functions/wallet-stats.js", {
        config: { timeoutSeconds: 10, memoryMb: 128 },
      }),
    },
  },
  subdomains: { set: ["tenant-x402-wallet-stats-20260708"] },
  routes: {
    replace: [
      {
        pattern: "/wallet-stats",
        methods: ["POST"],
        target: { type: "function", name: "wallet-stats" },
        pricing: {
          mode: "always",
          amount_usd_micros: 30_000,
          pay_to: "org_default_payout",
          networks: ["testnet"],
        },
      },
    ],
  },
});
