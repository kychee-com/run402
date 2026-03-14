/**
 * EvilMe Deploy Script
 *
 * Provisions a Run402 project, creates DB tables, sets secrets,
 * deploys the function + site, claims subdomain, and pins.
 *
 * Usage: npx tsx demos/evilme/deploy.ts
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

async function walletAuthHeaders(): Promise<Record<string, string>> {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = await account.signMessage({ message: `run402:${timestamp}` });
  return {
    "X-Run402-Wallet": account.address,
    "X-Run402-Signature": signature,
    "X-Run402-Timestamp": timestamp,
  };
}

async function main() {
  console.log("=== EvilMe Deploy ===\n");

  // 0. Subscribe to tier
  console.log("0) Subscribing to prototype tier...");
  const subRes = await fetchPaid(`${BASE_URL}/tiers/v1/prototype`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  if (!subRes.ok) {
    console.error("Failed to subscribe:", subRes.status, await subRes.text());
    process.exit(1);
  }
  console.log("   Subscribed to prototype tier");

  // 1. Provision project
  console.log("\n1) Provisioning project...");
  const wHeaders = await walletAuthHeaders();
  const provRes = await fetch(`${BASE_URL}/projects/v1`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...wHeaders },
    body: JSON.stringify({ name: "evilme" }),
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

  // 2. Create DB tables
  console.log("\n2) Creating DB tables...");
  const schema = readFileSync(new URL("./schema.sql", import.meta.url), "utf-8");
  const sqlRes = await fetch(`${BASE_URL}/projects/v1/admin/${project_id}/sql`, {
    method: "POST",
    headers: { Authorization: `Bearer ${service_key}`, "Content-Type": "text/plain" },
    body: schema,
  });
  if (!sqlRes.ok) {
    console.error("Schema failed:", await sqlRes.text());
    process.exit(1);
  }
  console.log("   Tables created");

  // 3. Set secrets (OpenAI for story gen, Admin key for image gen bypass)
  console.log("\n3) Setting secrets...");
  const secretRes = await fetch(`${BASE_URL}/projects/v1/admin/${project_id}/secrets`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({ key: "OPENAI_API_KEY", value: OPENAI_API_KEY }),
  });
  if (!secretRes.ok) {
    console.error("OPENAI_API_KEY secret failed:", await secretRes.text());
    process.exit(1);
  }
  console.log("   OPENAI_API_KEY set");

  const adminSecretRes = await fetch(`${BASE_URL}/projects/v1/admin/${project_id}/secrets`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({ key: "ADMIN_KEY", value: ADMIN_KEY }),
  });
  if (!adminSecretRes.ok) {
    console.error("ADMIN_KEY secret failed:", await adminSecretRes.text());
    process.exit(1);
  }
  console.log("   ADMIN_KEY set");

  // 4. Deploy function
  console.log("\n4) Deploying function...");
  const functionCode = readFileSync(new URL("./function.js", import.meta.url), "utf-8");
  const fnRes = await fetch(`${BASE_URL}/projects/v1/admin/${project_id}/functions`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({ name: "evilme", code: functionCode }),
  });
  if (!fnRes.ok) {
    console.error("Function deploy failed:", await fnRes.text());
    process.exit(1);
  }
  const fn = await fnRes.json();
  console.log(`   Function deployed: ${fn.url}`);

  // 5. Deploy site
  console.log("\n5) Deploying site...");
  let siteHtml = readFileSync(new URL("./index.html", import.meta.url), "utf-8");
  // Inject the anon_key into the site so API calls work
  siteHtml = siteHtml.replace(
    'APIKEY = params.get("key") || "";',
    `APIKEY = params.get("key") || "${anon_key}";`,
  );

  const siteHeaders = await walletAuthHeaders();
  const siteRes = await fetch(`${BASE_URL}/deployments/v1`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...siteHeaders },
    body: JSON.stringify({
      name: "evilme",
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

  // 6. Claim subdomain
  console.log("\n6) Claiming evilme.run402.com...");
  const subRes = await fetch(`${BASE_URL}/subdomains/v1`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({ name: "evilme", deployment_id: site.id }),
  });
  if (!subRes.ok) {
    const err = await subRes.text();
    if (err.includes("already claimed")) {
      // Update existing subdomain
      await fetch(`${BASE_URL}/subdomains/v1`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({ name: "evilme", deployment_id: site.id }),
      });
      console.log("   Subdomain updated");
    } else {
      console.error("Subdomain failed:", err);
    }
  } else {
    console.log("   Subdomain claimed: https://evilme.run402.com");
  }

  // 7. Pin project
  console.log("\n7) Pinning project...");
  const pinRes = await fetch(`${BASE_URL}/projects/v1/admin/${project_id}/pin`, {
    method: "POST",
    headers: { ...authHeaders, "X-Admin-Key": ADMIN_KEY },
  });
  if (pinRes.ok) {
    console.log("   Project pinned (will not expire)");
  } else {
    console.error("   Pin failed:", await pinRes.text());
  }

  console.log("\n=== Deploy Complete ===");
  console.log(`\n  Site: https://evilme.run402.com`);
  console.log(`  Function: ${fn.url}`);
  console.log(`  Project: ${project_id}`);
  console.log(`  Anon Key: ${anon_key}`);
  console.log(`  Service Key: ${service_key.substring(0, 20)}...`);
}

main().catch(err => {
  console.error("Deploy error:", err);
  process.exit(1);
});
