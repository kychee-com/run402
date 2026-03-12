import { readWallet, saveWallet, API } from "./config.mjs";

const HELP = `run402 wallet — Manage your x402 wallet

Usage:
  run402 wallet <subcommand>

Subcommands:
  status    Show wallet address, network, and funding status
  create    Generate a new wallet and save it locally
  fund      Request test USDC from the Run402 faucet (Base Sepolia)
  balance   Check billing balance for this wallet
  export    Print the wallet address (useful for scripting)

Notes:
  - Wallet is stored locally at ~/.run402/wallet.json
  - Network: Base Sepolia (testnet) — uses USDC for x402 payments
  - You need to create and fund a wallet before deploying or generating images

Examples:
  run402 wallet create
  run402 wallet status
  run402 wallet fund
  run402 wallet export
`;

async function loadDeps() {
  const { generatePrivateKey, privateKeyToAccount } = await import("viem/accounts");
  const { createPublicClient, http } = await import("viem");
  const { baseSepolia } = await import("viem/chains");
  return { generatePrivateKey, privateKeyToAccount, createPublicClient, http, baseSepolia };
}

async function status() {
  const w = readWallet();
  if (!w) {
    console.log(JSON.stringify({ status: "no_wallet", message: "No wallet found. Run: run402 wallet create" }));
    return;
  }
  console.log(JSON.stringify({ status: "ok", address: w.address, network: w.network || "base-sepolia", created: w.created, funded: w.funded || false }));
}

async function create() {
  if (readWallet()) {
    console.log(JSON.stringify({ status: "error", message: "Wallet already exists. Use 'status' to check it." }));
    process.exit(1);
  }
  const { generatePrivateKey, privateKeyToAccount } = await loadDeps();
  const privateKey = generatePrivateKey();
  const account = privateKeyToAccount(privateKey);
  saveWallet({ address: account.address, privateKey, network: "base-sepolia", created: new Date().toISOString(), funded: false });
  console.log(JSON.stringify({ status: "ok", address: account.address, message: "Wallet created and saved." }));
}

async function fund() {
  const w = readWallet();
  if (!w) { console.log(JSON.stringify({ status: "error", message: "No wallet. Run: run402 wallet create" })); process.exit(1); }
  const res = await fetch(`${API}/v1/faucet`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ address: w.address }) });
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
  if (!w) { console.log(JSON.stringify({ status: "error", message: "No wallet. Run: run402 wallet create" })); process.exit(1); }
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

export async function run(sub, args) {
  if (!sub || sub === '--help' || sub === '-h') {
    console.log(HELP);
    process.exit(0);
  }
  switch (sub) {
    case "status":  await status(); break;
    case "create":  await create(); break;
    case "fund":    await fund(); break;
    case "balance": await balance(); break;
    case "export":  await exportAddr(); break;
    default:
      console.error(`Unknown subcommand: ${sub}\n`);
      console.log(HELP);
      process.exit(1);
  }
}
