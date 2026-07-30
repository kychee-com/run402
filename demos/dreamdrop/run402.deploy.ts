import { defineConfig, dir, nodeFunction, sqlFile } from "@run402/sdk/config";

export default defineConfig(({ env }) => ({
  project: env.get("RUN402_PROJECT_ID"),
  database: {
    migrations: [sqlFile("run402/db/001_dreamdrops.sql")],
    expose: {
      version: "1",
      tables: [
        { name: "dreamdrops", expose: true, policy: "public_read_authenticated_write" },
      ],
      views: [],
      rpcs: [],
    },
  },
  site: {
    replace: dir(".wasp/out/web-app/build"),
    public_paths: { mode: "implicit" },
  },
  functions: {
    replace: {
      "dreamdrop-generator": nodeFunction("run402/functions/dreamdrop-generator.mjs", {
        config: { timeoutSeconds: 60, memoryMb: 512 },
      }),
    },
  },
  subdomains: { set: ["dreamdrop-wasp"] },
  routes: {
    replace: [
      {
        pattern: "/api/dreamdrops",
        methods: ["GET"],
        target: { type: "function", name: "dreamdrop-generator" },
      },
      {
        pattern: "/api/dreamdrops/create",
        methods: ["POST"],
        target: { type: "function", name: "dreamdrop-generator" },
      },
      {
        pattern: "/api/dreamdrops/remix",
        methods: ["POST"],
        target: { type: "function", name: "dreamdrop-generator" },
      },
      {
        pattern: "/api/dreamdrops/email",
        methods: ["POST"],
        target: { type: "function", name: "dreamdrop-generator" },
      },
      {
        pattern: "/agent/remix",
        methods: ["POST"],
        target: { type: "function", name: "dreamdrop-generator" },
        pricing: {
          mode: "always",
          amount_usd_micros: 50_000,
          pay_to: "org_default_payout",
          networks: ["mainnet", "testnet"],
        },
      },
    ],
  },
}));
