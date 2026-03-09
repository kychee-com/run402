import { config } from "dotenv";
config();

import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { x402Client, wrapFetchWithPayment } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { toClientEvmSigner } from "@x402/evm";
import { privateKeyToAccount } from "viem/accounts";
import { createPublicClient, http } from "viem";
import { baseSepolia } from "viem/chains";

const BUYER_KEY = process.env.BUYER_PRIVATE_KEY as `0x${string}`;
const ADMIN_KEY = process.env.ADMIN_KEY || "";
const BASE_URL = process.env.BASE_URL || "https://api.run402.com";
const EXISTING_PROJECT = process.env.KRELLO_PROJECT_ID || "";
const EXISTING_SERVICE_KEY = process.env.KRELLO_SERVICE_KEY || "";
const EXISTING_ANON_KEY = process.env.KRELLO_ANON_KEY || "";
const APP_URL = "https://krello.run402.com";

if (!BUYER_KEY) {
  console.error("Missing BUYER_PRIVATE_KEY");
  process.exit(1);
}
if (!ADMIN_KEY) {
  console.error("Missing ADMIN_KEY");
  process.exit(1);
}

const account = privateKeyToAccount(BUYER_KEY);
const publicClient = createPublicClient({ chain: baseSepolia, transport: http() });
const signer = toClientEvmSigner(account, publicClient as never);
const client = new x402Client();
client.register("eip155:84532", new ExactEvmScheme(signer));
const fetchPaid = wrapFetchWithPayment(fetch, client);

const rootDir = dirname(fileURLToPath(import.meta.url));
const siteDir = join(rootDir, "site");

async function main() {
  console.log("=== Krello Deploy ===\n");

  let projectId = EXISTING_PROJECT;
  let serviceKey = EXISTING_SERVICE_KEY;
  let anonKey = EXISTING_ANON_KEY;

  if (projectId && serviceKey && anonKey) {
    console.log("1) Reusing existing project...");
    console.log(`   Project: ${projectId}`);
  } else {
    console.log("1) Provisioning project...");
    const response = await fetchPaid(`${BASE_URL}/v1/projects/create/prototype`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "krello" }),
    });
    if (!response.ok) {
      console.error("Project creation failed:", response.status, await response.text());
      process.exit(1);
    }
    const body = await response.json();
    projectId = body.project_id;
    serviceKey = body.service_key;
    anonKey = body.anon_key;
    console.log(`   Project: ${projectId}`);
  }

  const authHeaders = {
    Authorization: `Bearer ${serviceKey}`,
    "Content-Type": "application/json",
  };

  console.log("\n2) Applying schema...");
  const schema = readFileSync(join(rootDir, "schema.sql"), "utf-8");
  const sqlResponse = await fetch(`${BASE_URL}/admin/v1/projects/${projectId}/sql`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${serviceKey}`,
      "Content-Type": "text/plain",
    },
    body: schema,
  });
  if (!sqlResponse.ok) {
    console.error("Schema apply failed:", sqlResponse.status, await sqlResponse.text());
    process.exit(1);
  }
  console.log("   Schema ready");

  console.log("\n3) Setting app secrets...");
  await setSecret(projectId, serviceKey, "KRELLO_APP_URL", APP_URL);
  console.log("   KRELLO_APP_URL set");

  console.log("\n4) Deploying function...");
  const functionCode = readFileSync(join(rootDir, "function.js"), "utf-8");
  const functionResponse = await fetch(`${BASE_URL}/admin/v1/projects/${projectId}/functions`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({
      name: "krello",
      code: functionCode,
      config: { timeout: 30, memory: 256 },
    }),
  });
  if (!functionResponse.ok) {
    console.error("Function deploy failed:", functionResponse.status, await functionResponse.text());
    process.exit(1);
  }
  const deployedFunction = await functionResponse.json();
  console.log(`   Function deployed: ${deployedFunction.url}`);

  console.log("\n5) Deploying site...");
  const siteFiles = loadSiteFiles(anonKey);
  const siteResponse = await fetchPaid(`${BASE_URL}/v1/deployments`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "krello",
      project: projectId,
      files: siteFiles,
    }),
  });
  if (!siteResponse.ok) {
    console.error("Site deploy failed:", siteResponse.status, await siteResponse.text());
    process.exit(1);
  }
  const site = await siteResponse.json();
  console.log(`   Deployment: ${site.id}`);

  console.log("\n6) Claiming krello.run402.com...");
  const subdomainResponse = await fetch(`${BASE_URL}/v1/subdomains`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({ name: "krello", deployment_id: site.id }),
  });
  if (!subdomainResponse.ok) {
    console.error("Subdomain claim failed:", subdomainResponse.status, await subdomainResponse.text());
    process.exit(1);
  }
  console.log("   Subdomain active");

  console.log("\n7) Publishing forkable version...");
  const publishResponse = await fetch(`${BASE_URL}/admin/v1/projects/${projectId}/publish`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({
      visibility: "public",
      fork_allowed: true,
      description: "Beautiful Trello-style collaboration app for run402 with multi-user boards, invite links, rich cards, and export/duplicate flows.",
      tags: ["kanban", "boards", "collaboration", "auth", "starter", "trello", "run402"],
    }),
  });
  if (!publishResponse.ok) {
    console.error("Publish failed:", publishResponse.status, await publishResponse.text());
    process.exit(1);
  }
  const published = await publishResponse.json();
  console.log(`   Version: ${published.id}`);

  console.log("\n8) Pinning project...");
  const pinResponse = await fetch(`${BASE_URL}/admin/v1/projects/${projectId}/pin`, {
    method: "POST",
    headers: { ...authHeaders, "X-Admin-Key": ADMIN_KEY },
  });
  if (!pinResponse.ok) {
    console.error("Pin failed:", pinResponse.status, await pinResponse.text());
    process.exit(1);
  }
  console.log("   Project pinned");

  console.log("\n=== Krello Live ===");
  console.log(`Site: ${APP_URL}`);
  console.log(`Project: ${projectId}`);
  console.log(`Version: ${published.id}`);
  console.log(`Anon Key: ${anonKey}`);
  console.log(`Service Key: ${serviceKey}`);
}

function loadSiteFiles(anonKey: string) {
  const files: Array<{ file: string; data: string }> = [];

  function walk(currentDir: string) {
    for (const entry of readdirSync(currentDir)) {
      const absolute = join(currentDir, entry);
      const stats = statSync(absolute);
      if (stats.isDirectory()) {
        walk(absolute);
        continue;
      }

      let data = readFileSync(absolute, "utf-8");
      if (entry === "index.html") {
        data = data.replace('apikey: "",', `apikey: "${anonKey}",`);
        data = data.replace('apiBase: "https://api.run402.com",', `apiBase: "${BASE_URL}",`);
      }

      files.push({
        file: relative(siteDir, absolute).replace(/\\/g, "/"),
        data,
      });
    }
  }

  walk(siteDir);
  return files;
}

async function setSecret(projectId: string, serviceKey: string, key: string, value: string) {
  const response = await fetch(`${BASE_URL}/admin/v1/projects/${projectId}/secrets`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${serviceKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ key, value }),
  });
  if (!response.ok) {
    throw new Error(await response.text());
  }
}

main().catch((error) => {
  console.error("Deploy error:", error);
  process.exit(1);
});
