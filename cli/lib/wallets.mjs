/**
 * run402 wallets — manage named wallets (profiles).
 *
 * A shim over `r.wallets` on `@run402/sdk/node`, which owns wallet selection
 * and the named-wallet (profile) verbs: this module parses argv, makes one SDK
 * call, and prints its JSON. `fund`, `balance`, and `lightning` act on the
 * ACTIVE wallet.
 *
 * Agent-first: JSON to stdout, structured errors to stderr, no interactive
 * prompts (destructive `rm` requires an explicit --yes).
 */

import { readFileSync } from "node:fs";
import { failUnknownSubcommand } from "./argparse.mjs";
import { fail, reportLocalOrSdkError, reportSdkError } from "./sdk-errors.mjs";
import { readWallet as readActiveWallet, saveWallet as saveActiveWallet } from "./config.mjs";
import { getSdk } from "./sdk.mjs";

const HELP = `run402 wallets — manage named wallets (profiles)

Usage:
  run402 wallets list                 List all wallets (local_label, server_label, address, rail, active)
  run402 wallets current              Show the active wallet: how it was selected, address, rail, file path, faucet use
  run402 wallets fund                 Request testnet funds from the faucet into the active wallet (Base Sepolia or Tempo)
  run402 wallets balance              The active wallet's on-chain balances, plus its organization's allowance
  run402 wallets new <name>           Create a new wallet (key stays local); 'default' creates the root wallet
  run402 wallets use <name>           Set the global default wallet
  run402 wallets rename <old> --to <new>   Rename a wallet (legacy: rename <old> <new>)
  run402 wallets bind [<name>]        Write ./.run402.json binding this directory to a wallet
  run402 wallets unbind               Remove ./.run402.json
  run402 wallets import <name> --key <path|->   Adopt an existing private key as a named wallet
  run402 wallets rm <name> --yes      Delete a wallet and its keys (requires --yes)
  run402 wallets lightning status     The active wallet's Lightning wallet (balance, budget, custody)
  run402 wallets lightning mint       Mint the Lightning wallet for the active wallet (same as init lightning)
  run402 wallets lightning revoke     Revoke it: the sub-wallet is deleted on Run402's Hub; the rail returns to x402

Selection precedence for normal commands:
  --wallet <name>  >  RUN402_WALLET  >  ./.run402.json  >  'wallets use' default  >  default

Options:
  --mpp           (new) create the wallet on the MPP rail instead of x402
  --rail <rail>   (new) x402 (default), mpp, or lightning; a lightning wallet
                  is minted on the platform by: run402 --wallet <name> init lightning
  --key <path|->  (import) read the private key from a file, or '-' for stdin
  --yes           (rm) confirm deletion

Notes:
  • The reserved 'default' wallet lives at the config-dir root; renaming it moves it under profiles/.
  • .run402.json holds only a wallet NAME (never a key) — safe to commit.
`;

function out(obj) {
  console.log(JSON.stringify(obj, null, 2));
}

function firstPositional(args) {
  return args.find((a) => a && !a.startsWith("-"));
}

function flagVal(args, flag) {
  const i = args.indexOf(flag);
  if (i === -1) return null;
  const v = args[i + 1];
  if (v === undefined || (typeof v === "string" && v.startsWith("-") && v !== "-")) {
    fail({ code: "BAD_FLAG", message: `${flag} requires a value`, details: { flag } });
  }
  return v;
}

async function call(fn) {
  try {
    out(await fn(getSdk().wallets));
  } catch (err) {
    reportLocalOrSdkError(err);
  }
}

const cmdList = () => call((w) => w.list());
const cmdCurrent = () => call((w) => w.current());

function cmdNew(args) {
  const railFlag = args.indexOf("--rail");
  const rail = railFlag >= 0 ? args[railFlag + 1] : args.includes("--mpp") ? "mpp" : "x402";
  return call((w) => w.create(firstPositional(args), { rail }));
}

const cmdUse = (args) => call((w) => w.use(firstPositional(args)));

function cmdRename(args) {
  const toFlag = flagVal(args, "--to");
  const positionals = args.filter((a, i) => a && !a.startsWith("-") && args[i - 1] !== "--to");
  return call((w) => w.rename(positionals[0], toFlag ?? positionals[1]));
}

const cmdBind = (args) => call((w) => w.bind(firstPositional(args)));
const cmdUnbind = () => call((w) => w.unbind());

function cmdImport(args) {
  // The key is read only after the SDK has accepted the name.
  return call((w) => w.import(firstPositional(args), () => {
    const keyArg = flagVal(args, "--key");
    if (!keyArg) {
      fail({ code: "BAD_USAGE", message: "--key <path|-> is required for import.", hint: "Use '-' to read the key from stdin." });
    }
    try {
      return keyArg === "-" ? readFileSync(0, "utf8") : readFileSync(keyArg, "utf8");
    } catch (e) {
      fail({ code: "FILE_NOT_FOUND", message: `Could not read key from ${keyArg === "-" ? "stdin" : keyArg}: ${e?.message}`, details: { key: keyArg } });
    }
  }));
}

const cmdRm = (args) => call((w) => w.remove(firstPositional(args), { confirm: args.includes("--yes") }));

export async function run(sub, args = []) {
  const rest = Array.isArray(args) ? args : [];
  if (!sub || sub === "--help" || sub === "-h" || rest.includes("--help") || rest.includes("-h")) {
    console.log(HELP);
    return;
  }
  switch (sub) {
    case "list": return cmdList();
    case "current": return cmdCurrent();
    case "new": return cmdNew(rest);
    case "use": return cmdUse(rest);
    case "rename": return cmdRename(rest);
    case "bind": return cmdBind(rest);
    case "unbind": return cmdUnbind();
    case "import": return cmdImport(rest);
    case "rm": return cmdRm(rest);
    case "fund": return cmdFund();
    case "balance": return cmdBalance();
    case "lightning": return cmdLightning(rest);
    default:
      failUnknownSubcommand("wallets", sub);
  }
}

// ── lightning ────────────────────────────────────────────────────────────────
// The Lightning wallet of the ACTIVE wallet (mpp-lightning-over-nwc).
// The pairing secret stays in wallet.json and is never printed.
async function cmdLightning(args) {
  const action = args.find((a) => a && !a.startsWith("-")) ?? "status";
  const { ensureLightningWallet, revokeLightningWallet, describeLightning, readLightningBalance } = await import("#sdk/node");
  const { readWallet } = await import("../core-dist/wallet.js");
  try {
    if (action === "status") {
      const localWallet = readWallet();
      if (!localWallet) fail({ code: "NO_WALLET", message: "No local wallet configured for this wallet.", hint: "run402 init lightning" });
      let wallet = null;
      try { wallet = await getSdk().agent.lightningWallet.get(); } catch (err) {
        const code = err?.body?.code ?? err?.code;
        if (code !== "LIGHTNING_WALLET_NOT_FOUND") throw err;
      }
      const balance = await readLightningBalance(localWallet);
      const lightning = describeLightning(localWallet, wallet, balance);
      out({ rail: localWallet.rail ?? "x402", lightning, ...(lightning ? {} : { hint: "run402 init lightning" }) });
      return;
    }
    if (action === "mint") {
      const result = await ensureLightningWallet(getSdk().agent);
      const balance = result.outcome === "stored" || result.outcome === "present" ? await readLightningBalance(result.localWallet) : null;
      out({ outcome: result.outcome, rail: result.localWallet.rail ?? "x402", lightning: describeLightning(result.localWallet, result.wallet, balance) });
      return;
    }
    if (action === "revoke") {
      const wallet = await revokeLightningWallet(getSdk().agent);
      out({ revoked: true, status: wallet?.status ?? "revoked", rail: "x402", next: "run402 init lightning  (mint again once the deletion completes)" });
      return;
    }
    failUnknownSubcommand("wallets lightning", action);
  } catch (err) {
    reportSdkError(err);
  }
}

// ── fund / balance (the ACTIVE wallet) ─────────────────────────────────────

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

async function cmdFund() {
  const w = readActiveWallet();
  if (!w) {
    fail({
      code: "NO_WALLET",
      message: "No local wallet.",
      hint: "Run: run402 init",
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
    saveActiveWallet({ ...w, funded: true, lastFaucet: new Date().toISOString() });
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
    data = await getSdk().wallets.faucet(w.address);
  } catch (err) {
    reportSdkError(err);
  }

  const MAX_WAIT = 30;
  for (let i = 0; i < MAX_WAIT; i++) {
    await new Promise(r => setTimeout(r, 1000));
    const now = await readUsdcBalance(client, USDC_SEPOLIA, w.address).catch(() => before);
    if (now > before) {
      saveActiveWallet({ ...w, funded: true, lastFaucet: new Date().toISOString() });
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

  saveActiveWallet({ ...w, funded: true, lastFaucet: new Date().toISOString() });
  console.log(JSON.stringify({ ...data, balance_confirmed: false, hint: "Faucet request sent but on-chain balance not yet confirmed" }));
}

async function readUsdcBalance(client, usdc, address) {
  const raw = await client.readContract({ address: usdc, abi: USDC_ABI, functionName: "balanceOf", args: [address] });
  return Number(raw);
}

async function cmdBalance() {
  const w = readActiveWallet();
  if (!w) {
    fail({
      code: "NO_WALLET",
      message: "No local wallet.",
      hint: "Run: run402 init",
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
    allowance_usd_micros: billingRes ? billingRes.allowance_usd_micros : null,
  }, null, 2));
}
