/**
 * Cosmic Forge Deploy Script
 *
 * Provisions a Run402 project, sets OPENAI_API_KEY secret,
 * deploys the function + site, claims subdomain, and pins.
 *
 * Usage: npx tsx demos/cosmicforge/deploy.ts
 */

import { config } from "dotenv";
config();

import { readFileSync } from "node:fs";
import { x402Client, wrapFetchWithPayment } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { toClientEvmSigner } from "@x402/evm";
import { privateKeyToAccount } from "viem/accounts";
import { createPublicClient, http } from "viem";
import { baseSepolia } from "viem/chains";

const BUYER_KEY = process.env.BUYER_PRIVATE_KEY as `0x${string}`;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const ADMIN_KEY = process.env.ADMIN_KEY || "";
const BASE_URL = process.env.BASE_URL || "https://api.run402.com";

if (!BUYER_KEY) { console.error("Missing BUYER_PRIVATE_KEY"); process.exit(1); }
if (!OPENAI_API_KEY) { console.error("Missing OPENAI_API_KEY"); process.exit(1); }
if (!ADMIN_KEY) { console.error("Missing ADMIN_KEY"); process.exit(1); }

const account = privateKeyToAccount(BUYER_KEY);
const publicClient = createPublicClient({ chain: baseSepolia, transport: http() });
const signer = toClientEvmSigner(account, publicClient);
const client = new x402Client();
client.register("eip155:84532", new ExactEvmScheme(signer));
const fetchPaid = wrapFetchWithPayment(fetch, client);

async function main() {
  console.log("=== Cosmic Forge Deploy ===\n");

  // 1. Provision project
  console.log("1) Provisioning project...");
  const provRes = await fetchPaid(`${BASE_URL}/v1/projects/create/prototype`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "cosmicforge" }),
  });

  if (!provRes.ok) {
    console.error("Failed to provision:", provRes.status, await provRes.text());
    process.exit(1);
  }

  const project = await provRes.json();
  const { project_id, service_key, anon_key } = project;
  console.log(`   Project: ${project_id}`);
  console.log(`   Anon key: ${anon_key.substring(0, 20)}...`);

  const authHeaders = {
    Authorization: `Bearer ${service_key}`,
    "Content-Type": "application/json",
  };

  // 2. Set OPENAI_API_KEY secret
  console.log("\n2) Setting secrets...");
  const secretRes = await fetch(`${BASE_URL}/admin/v1/projects/${project_id}/secrets`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({ key: "OPENAI_API_KEY", value: OPENAI_API_KEY }),
  });
  if (!secretRes.ok) {
    console.error("OPENAI_API_KEY secret failed:", await secretRes.text());
    process.exit(1);
  }
  console.log("   OPENAI_API_KEY set");

  // 3. Deploy function
  console.log("\n3) Deploying function...");
  const functionCode = readFileSync(new URL("./function.js", import.meta.url), "utf-8");
  const fnRes = await fetch(`${BASE_URL}/admin/v1/projects/${project_id}/functions`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({ name: "cosmicforge", code: functionCode }),
  });
  if (!fnRes.ok) {
    console.error("Function deploy failed:", await fnRes.text());
    process.exit(1);
  }
  const fn = await fnRes.json();
  console.log(`   Function deployed: ${fn.url}`);

  // 4. Deploy site
  console.log("\n4) Deploying site...");
  let siteHtml = readFileSync(new URL("./index.html", import.meta.url), "utf-8");
  // Inject the anon_key so API calls work
  siteHtml = siteHtml.replace(
    'APIKEY = params.get("key") || "";',
    `APIKEY = params.get("key") || "${anon_key}";`,
  );

  const siteRes = await fetchPaid(`${BASE_URL}/v1/deployments`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "cosmicforge",
      project: project_id,
      files: [{ file: "index.html", data: siteHtml }],
    }),
  });
  if (!siteRes.ok) {
    console.error("Site deploy failed:", siteRes.status, await siteRes.text());
    process.exit(1);
  }
  const site = await siteRes.json();
  console.log(`   Site deployed: ${site.url}`);

  // 5. Claim subdomain
  console.log("\n5) Claiming cosmit.run402.com...");
  const subRes = await fetch(`${BASE_URL}/v1/subdomains`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({ name: "cosmit", deployment_id: site.id }),
  });
  if (!subRes.ok) {
    const err = await subRes.text();
    if (err.includes("already claimed")) {
      await fetch(`${BASE_URL}/v1/subdomains`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({ name: "cosmit", deployment_id: site.id }),
      });
      console.log("   Subdomain updated");
    } else {
      console.error("Subdomain failed:", err);
    }
  } else {
    console.log("   Subdomain claimed: https://cosmit.run402.com");
  }

  // 6. Pin project
  console.log("\n6) Pinning project...");
  const pinRes = await fetch(`${BASE_URL}/admin/v1/projects/${project_id}/pin`, {
    method: "POST",
    headers: { ...authHeaders, "X-Admin-Key": ADMIN_KEY },
  });
  if (pinRes.ok) {
    console.log("   Project pinned (will not expire)");
  } else {
    console.error("   Pin failed:", await pinRes.text());
  }

  console.log("\n=== Deploy Complete ===");
  console.log(`\n  Site: https://cosmit.run402.com`);
  console.log(`  Function: ${fn.url}`);
  console.log(`  Project: ${project_id}`);
  console.log(`  Anon Key: ${anon_key}`);
  console.log(`  Service Key: ${service_key.substring(0, 20)}...`);
}

main().catch(err => {
  console.error("Deploy error:", err);
  process.exit(1);
});
