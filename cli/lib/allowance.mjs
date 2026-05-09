import { readAllowance, saveAllowance, ALLOWANCE_FILE } from "./config.mjs";
import { getSdk } from "./sdk.mjs";
import { reportSdkError, fail } from "./sdk-errors.mjs";

const HELP = `run402 allowance — Manage your agent allowance

Usage:
  run402 allowance <subcommand>

Subcommands:
  status    Show allowance address, network, rail, and funding status
  create    Generate a new allowance and save it locally
  fund      Request test funds from the faucet (Base Sepolia or Tempo)
  balance   Show on-chain balances and Run402 billing balance
  export    Print the allowance address (useful for scripting)
  checkout  Create a billing checkout session (--amount <usd_micros>)
  history   View billing transaction history (--limit <n>)

Notes:
  - Agent allowance is stored locally at ~/.config/run402/allowance.json
  - The allowance works on any EVM chain (Base for x402, Tempo for MPP)
  - Use 'run402 init' for x402 or 'run402 init mpp' for MPP rail

Examples:
  run402 allowance create
  run402 allowance status
  run402 allowance fund
  run402 allowance export
  run402 allowance balance
  run402 allowance checkout --amount 5000000
  run402 allowance history --limit 10
`;

const SUB_HELP = {
  checkout: `run402 allowance checkout — Create a billing checkout session

Usage:
  run402 allowance checkout --amount <usd_micros>

Options:
  --amount <n>        Amount in USD micros (required; e.g. 5000000 for $5)

Examples:
  run402 allowance checkout --amount 5000000
  run402 allowance checkout --amount 10000000
`,
  history: `run402 allowance history — View billing transaction history

Usage:
  run402 allowance history [--limit <n>]

Options:
  --limit <n>         Max entries to return (default: 20)

Examples:
  run402 allowance history
  run402 allowance history --limit 10
`,
};

const USDC_ABI = [{ name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ name: "account", type: "address" }], outputs: [{ name: "", type: "uint256" }] }];
const USDC_MAINNET = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const USDC_SEPOLIA = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const PATH_USD = "0x20c0000000000000000000000000000000000000";
const TEMPO_RPC = "https://rpc.moderato.tempo.xyz/";

async function loadDeps() {
  const { generatePrivateKey, privateKeyToAccount } = await import("viem/accounts");
  const { createPublicClient, http, defineChain } = await import("viem");
  const { base, baseSepolia } = await import("viem/chains");
  const tempoModerato = defineChain({
    id: 42431,
    name: "Tempo Moderato",
    nativeCurrency: { name: "pathUSD", symbol: "pathUSD", decimals: 6 },
    rpcUrls: { default: { http: [TEMPO_RPC] } },
  });
  return { generatePrivateKey, privateKeyToAccount, createPublicClient, http, base, baseSepolia, tempoModerato };
}

async function status() {
  try {
    const data = await getSdk().allowance.status();
    if (!data.configured) {
      console.log(JSON.stringify({ status: "no_wallet", message: "No agent allowance found. Run: run402 allowance create" }));
      process.exit(1);
    }
    // Preserve CLI's rail field (SDK doesn't surface it; read from local allowance).
    const w = readAllowance();
    console.log(JSON.stringify({
      status: "ok",
      address: data.address,
      created: data.created,
      configured: data.configured,
      // GH-109: `funded` used to leak an on-disk marker that only tracks
      // faucet invocation, not actual pay-readiness. Renamed to `faucet_used`
      // to match its real semantics. For a true "can this account pay right
      // now" check, use `run402 allowance balance`.
      faucet_used: !!data.faucet_used,
      rail: w?.rail || "x402",
      path: data.path ?? ALLOWANCE_FILE,
    }));
  } catch (err) {
    reportSdkError(err);
  }
}

async function create() {
  try {
    const result = await getSdk().allowance.create();
    console.log(JSON.stringify({
      status: "ok",
      address: result.address,
      message: `Agent allowance created. Stored locally at ${result.path ?? ALLOWANCE_FILE}`,
    }));
  } catch (err) {
    const msg = (err instanceof Error) ? err.message : String(err);
    if (/already exists/i.test(msg)) {
      fail({
        code: "ALLOWANCE_EXISTS",
        message: "Agent allowance already exists.",
        hint: "Use 'status' to check it.",
      });
    }
    reportSdkError(err);
  }
}

async function fund() {
  const w = readAllowance();
  if (!w) {
    fail({
      code: "NO_ALLOWANCE",
      message: "No agent allowance.",
      hint: "Run: run402 allowance create",
    });
  }

  if (w.rail === "mpp") {
    // Tempo Moderato faucet — instant, no polling needed
    const { createPublicClient, http, tempoModerato } = await loadDeps();
    const client = createPublicClient({ chain: tempoModerato, transport: http() });
    const before = await readUsdcBalance(client, PATH_USD, w.address).catch(() => 0);

    const res = await fetch(TEMPO_RPC, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "tempo_fundAddress", params: [w.address], id: 1 }),
    });
    const data = await res.json();
    if (data.error) {
      fail({
        code: "FAUCET_FAILED",
        message: data.error.message || "Tempo faucet failed",
        details: { rail: "mpp" },
      });
    }

    // Re-read balance once (instant confirmation)
    const now = await readUsdcBalance(client, PATH_USD, w.address).catch(() => before);
    saveAllowance({ ...w, funded: true, lastFaucet: new Date().toISOString() });
    console.log(JSON.stringify({
      address: w.address,
      rail: "mpp",
      onchain: {
        "tempo-moderato_pathusd_micros": now,
      },
    }, null, 2));
    return;
  }

  // Default: Base Sepolia faucet (existing behavior)
  const { createPublicClient, http, baseSepolia } = await loadDeps();
  const client = createPublicClient({ chain: baseSepolia, transport: http() });
  const before = await readUsdcBalance(client, USDC_SEPOLIA, w.address).catch(() => 0);

  let data;
  try {
    data = await getSdk().allowance.faucet(w.address);
  } catch (err) {
    reportSdkError(err);
  }

  const MAX_WAIT = 30;
  for (let i = 0; i < MAX_WAIT; i++) {
    await new Promise(r => setTimeout(r, 1000));
    const now = await readUsdcBalance(client, USDC_SEPOLIA, w.address).catch(() => before);
    if (now > before) {
      saveAllowance({ ...w, funded: true, lastFaucet: new Date().toISOString() });
      console.log(JSON.stringify({
        address: w.address,
        rail: w.rail || "x402",
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
  if (!w) {
    fail({
      code: "NO_ALLOWANCE",
      message: "No agent allowance.",
      hint: "Run: run402 allowance create",
    });
  }

  const { createPublicClient, http, base, baseSepolia, tempoModerato } = await loadDeps();
  const mainnetClient = createPublicClient({ chain: base, transport: http() });
  const sepoliaClient = createPublicClient({ chain: baseSepolia, transport: http() });
  const tempoClient = createPublicClient({ chain: tempoModerato, transport: http() });

  const [mainnetUsdc, sepoliaUsdc, tempoPathUsd, billingRes] = await Promise.all([
    readUsdcBalance(mainnetClient, USDC_MAINNET, w.address).catch(() => null),
    readUsdcBalance(sepoliaClient, USDC_SEPOLIA, w.address).catch(() => null),
    readUsdcBalance(tempoClient, PATH_USD, w.address).catch(() => null),
    getSdk().billing.checkBalance(w.address).catch(() => null),
  ]);

  console.log(JSON.stringify({
    address: w.address,
    rail: w.rail || "x402",
    onchain: {
      "base-mainnet_usd_micros": mainnetUsdc,
      "base-sepolia_usd_micros": sepoliaUsdc,
      "tempo-moderato_pathusd_micros": tempoPathUsd,
    },
    run402: billingRes ? { balance_usd_micros: billingRes.available_usd_micros } : "no billing account",
  }, null, 2));
}

async function exportAddr() {
  try {
    const address = await getSdk().allowance.export();
    console.log(address);
  } catch {
    fail({ code: "NO_ALLOWANCE", message: "No agent allowance." });
  }
}

async function checkout(args) {
  const w = readAllowance();
  if (!w) {
    fail({
      code: "NO_ALLOWANCE",
      message: "No agent allowance.",
      hint: "Run: run402 allowance create",
    });
  }
  let amount = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--amount" && args[i + 1]) amount = parseInt(args[++i], 10);
  }
  if (!amount) {
    fail({
      code: "BAD_USAGE",
      message: "Missing --amount <usd_micros>",
      hint: "e.g. --amount 5000000 for $5",
    });
  }
  try {
    const data = await getSdk().billing.createCheckout(w.address, amount);
    console.log(JSON.stringify(data, null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

async function history(args) {
  const w = readAllowance();
  if (!w) {
    fail({
      code: "NO_ALLOWANCE",
      message: "No agent allowance.",
      hint: "Run: run402 allowance create",
    });
  }
  let limit = 20;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--limit" && args[i + 1]) limit = parseInt(args[++i], 10);
  }
  try {
    const data = await getSdk().billing.history(w.address, limit);
    console.log(JSON.stringify(data, null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

export async function run(sub, args) {
  if (!sub || sub === '--help' || sub === '-h') {
    console.log(HELP);
    process.exit(0);
  }
  if (Array.isArray(args) && (args.includes("--help") || args.includes("-h"))) {
    console.log(SUB_HELP[sub] || HELP);
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
