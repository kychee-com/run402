#!/usr/bin/env node
/**
 * Run402 deploy — bundle deploy a full-stack app.
 *
 * Usage:
 *   node deploy.mjs --manifest manifest.json
 *   echo '{"name":"app","site":[...]}' | node deploy.mjs
 *
 * Manifest JSON fields (passed to POST /deploy/v1):
 *   name, migrations, rls, secrets, functions, site, subdomain
 */

import { readFileSync, existsSync, mkdirSync, writeFileSync } from "fs";
import { readWallet, loadProjects, API, WALLET_FILE, PROJECTS_FILE } from "./config.mjs";

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { manifest: null };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--manifest" && args[i + 1]) opts.manifest = args[++i];
  }
  return opts;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf-8");
}

function saveProject(project) {
  const projects = loadProjects();
  projects.push({
    project_id: project.project_id,
    anon_key: project.anon_key,
    service_key: project.service_key,
    tier: project.tier,
    lease_expires_at: project.lease_expires_at,
    site_url: project.site_url || project.subdomain_url,
    deployed_at: new Date().toISOString(),
  });
  const dir = PROJECTS_FILE.replace(/\/[^/]+$/, "");
  mkdirSync(dir, { recursive: true });
  writeFileSync(PROJECTS_FILE, JSON.stringify(projects, null, 2), { mode: 0o600 });
}

async function main() {
  const opts = parseArgs();

  if (!existsSync(WALLET_FILE)) {
    console.error(JSON.stringify({ status: "error", message: "No wallet found. Run: node wallet.mjs create && node wallet.mjs fund" }));
    process.exit(1);
  }
  const wallet = readWallet();

  let manifest;
  if (opts.manifest) {
    manifest = JSON.parse(readFileSync(opts.manifest, "utf-8"));
  } else {
    manifest = JSON.parse(await readStdin());
  }

  const { privateKeyToAccount } = await import("viem/accounts");
  const { createPublicClient, http } = await import("viem");
  const { baseSepolia } = await import("viem/chains");
  const { x402Client, wrapFetchWithPayment } = await import("@x402/fetch");
  const { ExactEvmScheme } = await import("@x402/evm/exact/client");
  const { toClientEvmSigner } = await import("@x402/evm");

  const account = privateKeyToAccount(wallet.privateKey);
  const publicClient = createPublicClient({ chain: baseSepolia, transport: http() });
  const signer = toClientEvmSigner(account, publicClient);
  const client = new x402Client();
  client.register("eip155:84532", new ExactEvmScheme(signer));
  const fetchPaid = wrapFetchWithPayment(fetch, client);

  const res = await fetchPaid(`${API}/deploy/v1`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(manifest),
  });

  const result = await res.json();
  if (!res.ok) {
    console.error(JSON.stringify({ status: "error", http: res.status, ...result }));
    process.exit(1);
  }

  saveProject(result);
  console.log(JSON.stringify(result, null, 2));
}

main();
