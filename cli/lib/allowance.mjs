import { readAllowance, saveAllowance, ALLOWANCE_FILE, API } from "./config.mjs";

const HELP = `run402 allowance — Manage your agent allowance

Usage:
  run402 allowance <subcommand>

Subcommands:
  status    Show allowance address, network, and funding status
  create    Generate a new allowance and save it locally
  fund      Request test USDC from the Run402 faucet (Base Sepolia)
  balance   Show on-chain USDC (mainnet + testnet) and Run402 billing balance
  export    Print the allowance address (useful for scripting)
  checkout  Create a billing checkout session (--amount <usd_micros>)
  history   View billing transaction history (--limit <n>)

Notes:
  - Agent allowance is stored locally at ~/.run402/allowance.json
  - The allowance works on any EVM chain (currently Run402 uses Base Mainnet and Sepolia for testnet)
  - You need to create and fund an allowance before any x402 transaction with Run402

Examples:
  run402 allowance create
  run402 allowance status
  run402 allowance fund
  run402 allowance export
  run402 allowance checkout --amount 5000000
  run402 allowance history --limit 10
`;

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
  const w = readAllowance();
  if (!w) {
    console.log(JSON.stringify({ status: "no_wallet", message: "No agent allowance found. Run: run402 allowance create" }));
    return;
  }
  console.log(JSON.stringify({ status: "ok", address: w.address, created: w.created, funded: w.funded || false, path: ALLOWANCE_FILE }));
}

async function create() {
  if (readAllowance()) {
    console.log(JSON.stringify({ status: "error", message: "Agent allowance already exists. Use 'status' to check it." }));
    process.exit(1);
  }
  const { generatePrivateKey, privateKeyToAccount } = await loadDeps();
  const privateKey = generatePrivateKey();
  const account = privateKeyToAccount(privateKey);
  saveAllowance({ address: account.address, privateKey, created: new Date().toISOString(), funded: false });
  console.log(JSON.stringify({ status: "ok", address: account.address, message: `Agent allowance created. Stored locally at ${ALLOWANCE_FILE}` }));
}

async function fund() {
  const w = readAllowance();
  if (!w) { console.log(JSON.stringify({ status: "error", message: "No agent allowance. Run: run402 allowance create" })); process.exit(1); }

  const { createPublicClient, http, baseSepolia } = await loadDeps();
  const client = createPublicClient({ chain: baseSepolia, transport: http() });
  const before = await readUsdcBalance(client, USDC_SEPOLIA, w.address).catch(() => 0);

  const res = await fetch(`${API}/faucet/v1`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ address: w.address }) });
  const data = await res.json();
  if (!res.ok) {
    console.log(JSON.stringify({ status: "error", ...data }));
    process.exit(1);
  }

  const MAX_WAIT = 30;
  for (let i = 0; i < MAX_WAIT; i++) {
    await new Promise(r => setTimeout(r, 1000));
    const now = await readUsdcBalance(client, USDC_SEPOLIA, w.address).catch(() => before);
    if (now > before) {
      saveAllowance({ ...w, funded: true, lastFaucet: new Date().toISOString() });
      console.log(JSON.stringify({
        address: w.address,
        onchain: {
          "base-sepolia_usd_micros": now,
        },
      }, null, 2));
      return;
    }
  }

  saveAllowance({ ...w, funded: true, lastFaucet: new Date().toISOString() });
  console.log(JSON.stringify({ status: "ok", message: "Faucet request sent but balance not yet confirmed", ...data }));
}

async function readUsdcBalance(client, usdc, address) {
  const raw = await client.readContract({ address: usdc, abi: USDC_ABI, functionName: "balanceOf", args: [address] });
  return Number(raw);
}

async function balance() {
  const w = readAllowance();
  if (!w) { console.log(JSON.stringify({ status: "error", message: "No agent allowance. Run: run402 allowance create" })); process.exit(1); }

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
  const w = readAllowance();
  if (!w) { console.log(JSON.stringify({ status: "error", message: "No agent allowance." })); process.exit(1); }
  console.log(w.address);
}

async function checkout(args) {
  const w = readAllowance();
  if (!w) { console.log(JSON.stringify({ status: "error", message: "No agent allowance. Run: run402 allowance create" })); process.exit(1); }
  let amount = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--amount" && args[i + 1]) amount = parseInt(args[++i], 10);
  }
  if (!amount) { console.error(JSON.stringify({ status: "error", message: "Missing --amount <usd_micros> (e.g. --amount 5000000 for $5)" })); process.exit(1); }
  const res = await fetch(`${API}/billing/v1/checkouts`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ wallet: w.address.toLowerCase(), amount_usd_micros: amount }),
  });
  const data = await res.json();
  if (!res.ok) { console.error(JSON.stringify({ status: "error", http: res.status, ...data })); process.exit(1); }
  console.log(JSON.stringify(data, null, 2));
}

async function history(args) {
  const w = readAllowance();
  if (!w) { console.log(JSON.stringify({ status: "error", message: "No agent allowance. Run: run402 allowance create" })); process.exit(1); }
  let limit = 20;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--limit" && args[i + 1]) limit = parseInt(args[++i], 10);
  }
  const res = await fetch(`${API}/billing/v1/accounts/${w.address.toLowerCase()}/history?limit=${limit}`);
  const data = await res.json();
  if (!res.ok) { console.error(JSON.stringify({ status: "error", http: res.status, ...data })); process.exit(1); }
  console.log(JSON.stringify(data, null, 2));
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
    case "export":   await exportAddr(); break;
    case "checkout": await checkout(args); break;
    case "history":  await history(args); break;
    default:
      console.error(`Unknown subcommand: ${sub}\n`);
      console.log(HELP);
      process.exit(1);
  }
}
