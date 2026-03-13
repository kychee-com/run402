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

const USDC_ABI = [{ name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ name: "account", type: "address" }], outputs: [{ name: "", type: "uint256" }] }];
const USDC_MAINNET = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const USDC_SEPOLIA = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";

async function loadDeps() {
  const { generatePrivateKey, privateKeyToAccount } = await import("viem/accounts");
  const { createPublicClient, http } = await import("viem");
  const { base, baseSepolia } = await import("viem/chains");
  return { generatePrivateKey, privateKeyToAccount, createPublicClient, http, base, baseSepolia };
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
  const res = await fetch(`${API}/faucet/v1`, {
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

async function readUsdcBalance(client, usdc, address) {
  const raw = await client.readContract({ address: usdc, abi: USDC_ABI, functionName: "balanceOf", args: [address] });
  return Number(raw);
}

async function balance() {
  const w = readWallet();
  if (!w) { console.log(JSON.stringify({ status: "error", message: "No wallet. Run: node wallet.mjs create" })); process.exit(1); }

  const { createPublicClient, http, base, baseSepolia } = await loadDeps();
  const mainnetClient = createPublicClient({ chain: base, transport: http() });
  const sepoliaClient = createPublicClient({ chain: baseSepolia, transport: http() });

  const [mainnetUsdc, sepoliaUsdc, billingRes] = await Promise.all([
    readUsdcBalance(mainnetClient, USDC_MAINNET, w.address).catch(() => null),
    readUsdcBalance(sepoliaClient, USDC_SEPOLIA, w.address).catch(() => null),
    fetch(`${API}/billing/v1/accounts/${w.address.toLowerCase()}`),
  ]);

  const billing = billingRes.ok ? await billingRes.json() : null;

  console.log(JSON.stringify({
    address: w.address,
    onchain: {
      "base-mainnet_usd_micros": mainnetUsdc,
      "base-sepolia_usd_micros": sepoliaUsdc,
    },
    run402: billing ? { balance_usd_micros: billing.available_usd_micros } : "no billing account",
  }, null, 2));
}

async function exportAddr() {
  const w = readWallet();
  if (!w) { console.log(JSON.stringify({ status: "error", message: "No wallet." })); process.exit(1); }
  console.log(w.address);
}

async function checkout(extraArgs) {
  const w = readWallet();
  if (!w) { console.log(JSON.stringify({ status: "error", message: "No wallet. Run: node wallet.mjs create" })); process.exit(1); }
  let amount = null;
  for (let i = 0; i < extraArgs.length; i++) {
    if (extraArgs[i] === "--amount" && extraArgs[i + 1]) amount = parseInt(extraArgs[++i], 10);
  }
  if (!amount) { console.error(JSON.stringify({ status: "error", message: "Missing --amount <usd_micros>" })); process.exit(1); }
  const res = await fetch(`${API}/billing/v1/checkouts`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ wallet: w.address.toLowerCase(), amount_usd_micros: amount }),
  });
  const data = await res.json();
  if (!res.ok) { console.error(JSON.stringify({ status: "error", http: res.status, ...data })); process.exit(1); }
  console.log(JSON.stringify(data, null, 2));
}

async function history(extraArgs) {
  const w = readWallet();
  if (!w) { console.log(JSON.stringify({ status: "error", message: "No wallet. Run: node wallet.mjs create" })); process.exit(1); }
  let limit = 20;
  for (let i = 0; i < extraArgs.length; i++) {
    if (extraArgs[i] === "--limit" && extraArgs[i + 1]) limit = parseInt(extraArgs[++i], 10);
  }
  const res = await fetch(`${API}/billing/v1/accounts/${w.address.toLowerCase()}/history?limit=${limit}`);
  const data = await res.json();
  if (!res.ok) { console.error(JSON.stringify({ status: "error", http: res.status, ...data })); process.exit(1); }
  console.log(JSON.stringify(data, null, 2));
}

const [cmd, ...args] = process.argv.slice(2);
switch (cmd) {
  case "status": await status(); break;
  case "create": await create(); break;
  case "fund": await fund(); break;
  case "balance": await balance(); break;
  case "export": await exportAddr(); break;
  case "checkout": await checkout(args); break;
  case "history": await history(args); break;
  default:
    console.log("Usage: node wallet.mjs <status|create|fund|balance|export|checkout|history>");
    process.exit(1);
}
