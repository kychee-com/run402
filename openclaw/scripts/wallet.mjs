#!/usr/bin/env node
/**
 * Run402 wallet manager — persistent wallet for OpenClaw agents.
 *
 * Usage:
 *   node wallet.mjs status          # Show address, balance, network
 *   node wallet.mjs create          # Generate and save a new wallet (fails if one exists)
 *   node wallet.mjs fund            # Request testnet USDC from faucet
 *   node wallet.mjs export          # Print wallet address (safe for sharing)
 */

import { readWallet, saveWallet, API } from "./config.mjs";

async function loadDeps() {
  const { generatePrivateKey, privateKeyToAccount } = await import("viem/accounts");
  const { createPublicClient, http } = await import("viem");
  const { baseSepolia } = await import("viem/chains");
  return { generatePrivateKey, privateKeyToAccount, createPublicClient, http, baseSepolia };
}

async function status() {
  const w = readWallet();
  if (!w) {
    console.log(JSON.stringify({ status: "no_wallet", message: "No wallet found. Run: node wallet.mjs create" }));
    return;
  }
  console.log(JSON.stringify({
    status: "ok",
    address: w.address,
    network: w.network || "base-sepolia",
    created: w.created,
    funded: w.funded || false,
  }));
}

async function create() {
  if (readWallet()) {
    console.log(JSON.stringify({ status: "error", message: "Wallet already exists. Use 'status' to check it." }));
    process.exit(1);
  }
  const { generatePrivateKey, privateKeyToAccount } = await loadDeps();
  const privateKey = generatePrivateKey();
  const account = privateKeyToAccount(privateKey);
  saveWallet({
    address: account.address,
    privateKey,
    network: "base-sepolia",
    created: new Date().toISOString(),
    funded: false,
  });
  console.log(JSON.stringify({ status: "ok", address: account.address, message: "Wallet created and saved." }));
}

async function fund() {
  const w = readWallet();
  if (!w) {
    console.log(JSON.stringify({ status: "error", message: "No wallet. Run: node wallet.mjs create" }));
    process.exit(1);
  }
  const res = await fetch(`${API}/v1/faucet`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ address: w.address }),
  });
  const data = await res.json();
  if (res.ok) {
    saveWallet({ ...w, funded: true, lastFaucet: new Date().toISOString() });
    console.log(JSON.stringify({ status: "ok", ...data }));
  } else {
    console.log(JSON.stringify({ status: "error", ...data }));
    process.exit(1);
  }
}

async function balance() {
  const w = readWallet();
  if (!w) { console.log(JSON.stringify({ status: "error", message: "No wallet. Run: node wallet.mjs create" })); process.exit(1); }
  const res = await fetch(`${API}/v1/billing/accounts/${w.address.toLowerCase()}`);
  const data = await res.json();
  if (!res.ok) { console.error(JSON.stringify({ status: "error", http: res.status, ...data })); process.exit(1); }
  console.log(JSON.stringify(data, null, 2));
}

async function exportAddr() {
  const w = readWallet();
  if (!w) { console.log(JSON.stringify({ status: "error", message: "No wallet." })); process.exit(1); }
  console.log(w.address);
}

const cmd = process.argv[2];
switch (cmd) {
  case "status": await status(); break;
  case "create": await create(); break;
  case "fund": await fund(); break;
  case "balance": await balance(); break;
  case "export": await exportAddr(); break;
  default:
    console.log("Usage: node wallet.mjs <status|create|fund|balance|export>");
    process.exit(1);
}
