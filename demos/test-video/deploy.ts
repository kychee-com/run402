/**
 * Test Video Deploy Script
 *
 * Deploys a Remotion-rendered video as a Run402 static site.
 * Provisions project, uploads video, deploys site, claims subdomain.
 *
 * Usage: npx tsx demos/test-vid/deploy.ts
 */

import { config } from "dotenv";
config();

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { x402Client, wrapFetchWithPayment } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { toClientEvmSigner } from "@x402/evm";
import { privateKeyToAccount } from "viem/accounts";
import { createPublicClient, http } from "viem";
import { baseSepolia } from "viem/chains";
import { createSIWxPayload, encodeSIWxHeader } from "@x402/extensions/sign-in-with-x";

const BUYER_KEY = process.env.BUYER_PRIVATE_KEY as `0x${string}`;
const ADMIN_KEY = process.env.ADMIN_KEY || "";
const BASE_URL = process.env.BASE_URL || "https://api.run402.com";
const STATE_FILE = new URL("./state.json", import.meta.url);

if (!BUYER_KEY) { console.error("Missing BUYER_PRIVATE_KEY"); process.exit(1); }
if (!ADMIN_KEY) { console.error("Missing ADMIN_KEY"); process.exit(1); }

function loadState(): { project_id?: string; service_key?: string } {
  try {
    if (existsSync(STATE_FILE)) return JSON.parse(readFileSync(STATE_FILE, "utf-8"));
  } catch {}
  return {};
}
function saveState(s: { project_id: string; service_key: string }) {
  writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}

const account = privateKeyToAccount(BUYER_KEY);
const publicClient = createPublicClient({ chain: baseSepolia, transport: http() });
const signer = toClientEvmSigner(account, publicClient);
const client = new x402Client();
client.register("eip155:84532", new ExactEvmScheme(signer));
const fetchPaid = wrapFetchWithPayment(fetch, client);

async function siwxHeaders(uri: string): Promise<Record<string, string>> {
  const info = {
    domain: new URL(BASE_URL).hostname,
    uri,
    statement: "Sign in to Run402",
    version: "1",
    nonce: crypto.randomUUID().replace(/-/g, ''),
    issuedAt: new Date().toISOString(),
    expirationTime: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
    chainId: "eip155:84532",
    type: "eip191" as const,
  };
  const payload = await createSIWxPayload(info, account);
  return { "SIGN-IN-WITH-X": encodeSIWxHeader(payload) };
}

async function main() {
  console.log("=== Test Video Deploy ===\n");

  // 0. Subscribe to tier
  console.log("0) Subscribing to prototype tier...");
  const tierRes = await fetchPaid(`${BASE_URL}/tiers/v1/prototype`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  if (!tierRes.ok) {
    const text = await tierRes.text();
    if (!text.includes("already")) {
      console.error("Failed to subscribe:", tierRes.status, text);
      process.exit(1);
    }
    console.log("   Already subscribed");
  } else {
    console.log("   Subscribed to prototype tier");
  }

  // 1. Provision or reuse project
  const state = loadState();
  let project_id: string;
  let service_key: string;

  if (state.project_id && state.service_key) {
    console.log("\n1) Reusing existing project...");
    project_id = state.project_id;
    service_key = state.service_key;
    console.log(`   Project: ${project_id}`);
  } else {
    console.log("\n1) Provisioning new project...");
    const provHeaders = await siwxHeaders(`${BASE_URL}/projects/v1`);
    const provRes = await fetch(`${BASE_URL}/projects/v1`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...provHeaders },
      body: JSON.stringify({ name: "test-vid" }),
    });

    if (!provRes.ok) {
      console.error("Failed to provision:", provRes.status, await provRes.text());
      process.exit(1);
    }

    const project = await provRes.json();
    project_id = project.project_id;
    service_key = project.service_key;
    saveState({ project_id, service_key });
    console.log(`   Project: ${project_id} (saved to state.json)`);
  }

  const authHeaders = {
    Authorization: `Bearer ${service_key}`,
    "Content-Type": "application/json",
  };

  // 2. Deploy site (pure HTML/CSS/JS animation, no video file needed)
  console.log("\n2) Deploying site...");
  const siteHtml = readFileSync(new URL("./index.html", import.meta.url), "utf-8");

  const deployHeaders = await siwxHeaders(`${BASE_URL}/deployments/v1`);
  const siteRes = await fetch(`${BASE_URL}/deployments/v1`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...deployHeaders },
    body: JSON.stringify({
      project: project_id,
      files: [
        { file: "index.html", data: siteHtml },
      ],
    }),
  });

  if (!siteRes.ok) {
    console.error("Site deploy failed:", siteRes.status, await siteRes.text());
    process.exit(1);
  }

  const site = await siteRes.json();
  console.log(`   Site deployed: ${site.url}`);
  console.log(`   Deployment: ${JSON.stringify(site)}`);

  // 4. Claim subdomain
  console.log("\n4) Claiming test-vid.run402.com...");
  const subRes = await fetch(`${BASE_URL}/subdomains/v1`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({ name: "test-vid", deployment_id: site.deployment_id }),
  });
  if (!subRes.ok) {
    const err = await subRes.text();
    if (err.includes("already claimed")) {
      // Update existing
      await fetch(`${BASE_URL}/subdomains/v1`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({ name: "test-vid", deployment_id: site.deployment_id }),
      });
      console.log("   Subdomain updated");
    } else {
      console.error("Subdomain failed:", err);
    }
  } else {
    console.log("   Subdomain claimed: https://test-vid.run402.com");
  }

  // 5. Pin project
  console.log("\n5) Pinning project...");
  const pinRes = await fetch(`${BASE_URL}/projects/v1/admin/${project_id}/pin`, {
    method: "POST",
    headers: { ...authHeaders, "X-Admin-Key": ADMIN_KEY },
  });
  if (pinRes.ok) {
    console.log("   Project pinned");
  } else {
    console.error("   Pin failed:", await pinRes.text());
  }

  console.log("\n=== Deploy Complete ===");
  console.log(`\n  Site: https://test-vid.run402.com`);
  console.log(`  Project: ${project_id}`);
}

main().catch(err => {
  console.error("Deploy failed:", err);
  process.exit(1);
});
