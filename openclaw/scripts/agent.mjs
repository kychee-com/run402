#!/usr/bin/env node
/**
 * Run402 agent — manage agent identity.
 *
 * Usage:
 *   node agent.mjs contact --name <name> [--email <email>] [--webhook <url>]
 */

import { readWallet, API, WALLET_FILE } from "./config.mjs";
import { existsSync } from "fs";

async function contact(extraArgs) {
  let name = null, email = null, webhook = null;
  for (let i = 0; i < extraArgs.length; i++) {
    if (extraArgs[i] === "--name" && extraArgs[i + 1]) name = extraArgs[++i];
    if (extraArgs[i] === "--email" && extraArgs[i + 1]) email = extraArgs[++i];
    if (extraArgs[i] === "--webhook" && extraArgs[i + 1]) webhook = extraArgs[++i];
  }
  if (!name) { console.error(JSON.stringify({ status: "error", message: "Missing --name <name>" })); process.exit(1); }
  if (!existsSync(WALLET_FILE)) {
    console.error(JSON.stringify({ status: "error", message: "No wallet found. Run: node wallet.mjs create && node wallet.mjs fund" }));
    process.exit(1);
  }

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

  const body = { name };
  if (email) body.email = email;
  if (webhook) body.webhook = webhook;

  const res = await fetchPaid(`${API}/agent/v1/contact`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) { console.error(JSON.stringify({ status: "error", http: res.status, ...data })); process.exit(1); }
  console.log(JSON.stringify(data, null, 2));
}

const [cmd, ...args] = process.argv.slice(2);
switch (cmd) {
  case "contact": await contact(args); break;
  default:
    console.log("Usage: node agent.mjs contact --name <name> [--email <email>] [--webhook <url>]");
    process.exit(1);
}
