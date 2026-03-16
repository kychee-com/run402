/**
 * Social Todo Deploy Script
 *
 * Provisions a Run402 project, creates DB tables, deploys the site,
 * claims subdomain, and pins. Uses Google OAuth social login only.
 *
 * Usage: npx tsx demos/social-todo/deploy.ts
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
const ADMIN_KEY = process.env.ADMIN_KEY || "";
const BASE_URL = process.env.BASE_URL || "https://api.run402.com";

if (!BUYER_KEY) { console.error("Missing BUYER_PRIVATE_KEY"); process.exit(1); }
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
  console.log("=== Social Todo Deploy ===\n");

  // 0. Subscribe to tier
  console.log("0) Subscribing to prototype tier...");
  const tierRes = await fetchPaid(`${BASE_URL}/tiers/v1/prototype`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  if (!tierRes.ok) {
    console.error("Failed to subscribe:", tierRes.status, await tierRes.text());
    process.exit(1);
  }
  console.log("   Subscribed to prototype tier");

  // 1. Provision project
  console.log("\n1) Provisioning project...");
  const wHeaders = await walletAuthHeaders();
  const provRes = await fetch(`${BASE_URL}/projects/v1`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...wHeaders },
    body: JSON.stringify({ name: "social-todo" }),
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

  // 2. Create DB tables + RLS
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
  console.log("   Tables + RLS created");

  // 3. Deploy site
  console.log("\n3) Deploying site...");
  let siteHtml = readFileSync(new URL("./index.html", import.meta.url), "utf-8");
  // Inject API base and anon key
  siteHtml = siteHtml.replace(
    "const API = window.__API_BASE__ || '';",
    `const API = window.__API_BASE__ || '${BASE_URL}';`,
  );
  siteHtml = siteHtml.replace(
    "const ANON_KEY = window.__ANON_KEY__ || '';",
    `const ANON_KEY = window.__ANON_KEY__ || '${anon_key}';`,
  );

  const siteHeaders = await walletAuthHeaders();
  const siteRes = await fetch(`${BASE_URL}/deployments/v1`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...siteHeaders },
    body: JSON.stringify({
      name: "social-todo",
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

  // 4. Claim subdomain
  console.log("\n4) Claiming social-todo.run402.com...");
  const subRes = await fetch(`${BASE_URL}/subdomains/v1`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({ name: "social-todo", deployment_id: site.id }),
  });
  if (!subRes.ok) {
    const err = await subRes.text();
    if (err.includes("already claimed")) {
      await fetch(`${BASE_URL}/subdomains/v1`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({ name: "social-todo", deployment_id: site.id }),
      });
      console.log("   Subdomain updated");
    } else {
      console.error("Subdomain failed:", err);
    }
  } else {
    console.log("   Subdomain claimed: https://social-todo.run402.com");
  }

  // 5. Pin project
  console.log("\n5) Pinning project...");
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
  console.log(`\n  Site: https://social-todo.run402.com`);
  console.log(`  Project: ${project_id}`);
  console.log(`  Anon Key: ${anon_key}`);
  console.log(`  Service Key: ${service_key.substring(0, 20)}...`);
}

main().catch(err => {
  console.error("Deploy error:", err);
  process.exit(1);
});
