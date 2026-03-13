/**
 * Deploy just the site + subdomain for an existing EvilMe project.
 * Usage: PROJECT_ID=... SERVICE_KEY=... ANON_KEY=... npx tsx demos/evilme/deploy-site.ts
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
const PROJECT_ID = process.env.PROJECT_ID!;
const SERVICE_KEY = process.env.SERVICE_KEY!;
const ANON_KEY = process.env.ANON_KEY!;
const ADMIN_KEY = process.env.ADMIN_KEY || "";
const BASE_URL = process.env.BASE_URL || "https://api.run402.com";

const account = privateKeyToAccount(BUYER_KEY);
const publicClient = createPublicClient({ chain: baseSepolia, transport: http() });
const signer = toClientEvmSigner(account, publicClient);
const client = new x402Client();
client.register("eip155:84532", new ExactEvmScheme(signer));
const fetchPaid = wrapFetchWithPayment(fetch, client);

const authHeaders = {
  Authorization: `Bearer ${SERVICE_KEY}`,
  "Content-Type": "application/json",
};

async function main() {
  // Deploy site
  console.log("Deploying site...");
  let siteHtml = readFileSync(new URL("./index.html", import.meta.url), "utf-8");
  siteHtml = siteHtml.replace(
    'APIKEY = params.get("key") || "";',
    `APIKEY = params.get("key") || "${ANON_KEY}";`,
  );

  const siteRes = await fetchPaid(`${BASE_URL}/deployments/v1`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "evilme",
      project: PROJECT_ID,
      files: [{ file: "index.html", data: siteHtml }],
    }),
  });
  console.log("Status:", siteRes.status);
  const siteText = await siteRes.text();
  console.log("Body:", siteText);

  if (!siteRes.ok) {
    console.error("Site deploy failed");
    process.exit(1);
  }

  const site = JSON.parse(siteText);
  console.log(`Site deployed: ${site.url}`);

  // Claim subdomain
  console.log("\nClaiming evilme.run402.com...");
  const subRes = await fetch(`${BASE_URL}/subdomains/v1`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({ name: "evilme", deployment_id: site.id }),
  });
  console.log("Subdomain:", subRes.status, await subRes.text());

  // Pin project
  if (ADMIN_KEY) {
    console.log("\nPinning project...");
    const pinRes = await fetch(`${BASE_URL}/projects/v1/admin/${PROJECT_ID}/pin`, {
      method: "POST",
      headers: { ...authHeaders, "X-Admin-Key": ADMIN_KEY },
    });
    console.log("Pin:", pinRes.status, await pinRes.text());
  }

  console.log("\n=== Done ===");
  console.log(`Site: https://evilme.run402.com`);
}

main().catch(err => { console.error(err); process.exit(1); });
