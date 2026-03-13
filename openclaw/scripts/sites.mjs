#!/usr/bin/env node
/**
 * Run402 sites — deploy static sites.
 *
 * Usage:
 *   node sites.mjs deploy --name <name> --manifest <file> [--project <id>] [--target <target>]
 *   cat manifest.json | node sites.mjs deploy --name <name>
 */

import { readFileSync, existsSync } from "fs";
import { readWallet, API, WALLET_FILE } from "./config.mjs";

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf-8");
}

async function deploy(extraArgs) {
  const opts = { name: null, manifest: null, project: undefined, target: undefined };
  for (let i = 0; i < extraArgs.length; i++) {
    if (extraArgs[i] === "--name" && extraArgs[i + 1]) opts.name = extraArgs[++i];
    if (extraArgs[i] === "--manifest" && extraArgs[i + 1]) opts.manifest = extraArgs[++i];
    if (extraArgs[i] === "--project" && extraArgs[i + 1]) opts.project = extraArgs[++i];
    if (extraArgs[i] === "--target" && extraArgs[i + 1]) opts.target = extraArgs[++i];
  }
  if (!opts.name) { console.error(JSON.stringify({ status: "error", message: "Missing --name <name>" })); process.exit(1); }
  if (!existsSync(WALLET_FILE)) {
    console.error(JSON.stringify({ status: "error", message: "No wallet found. Run: node wallet.mjs create && node wallet.mjs fund" }));
    process.exit(1);
  }

  const manifest = opts.manifest ? JSON.parse(readFileSync(opts.manifest, "utf-8")) : JSON.parse(await readStdin());
  const body = { name: opts.name, files: manifest.files };
  if (opts.project) body.project = opts.project;
  if (opts.target) body.target = opts.target;

  const wallet = readWallet();
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

  const res = await fetchPaid(`${API}/deployments/v1`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) { console.error(JSON.stringify({ status: "error", http: res.status, ...data })); process.exit(1); }
  console.log(JSON.stringify(data, null, 2));
}

async function status(deploymentId) {
  if (!deploymentId) { console.error(JSON.stringify({ status: "error", message: "Missing deployment ID" })); process.exit(1); }
  const res = await fetch(`${API}/deployments/v1/${deploymentId}`);
  const data = await res.json();
  if (!res.ok) { console.error(JSON.stringify({ status: "error", http: res.status, ...data })); process.exit(1); }
  console.log(JSON.stringify(data, null, 2));
}

const [cmd, ...args] = process.argv.slice(2);
switch (cmd) {
  case "deploy": await deploy(args); break;
  case "status": await status(args[0]); break;
  default:
    console.log("Usage: node sites.mjs <deploy|status> [args...]");
    process.exit(1);
}
