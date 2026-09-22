/**
 * run402 wallets — manage named wallets (profiles).
 *
 * Each named wallet is a self-contained profile directory under
 * `{config_dir}/profiles/<name>/` with its own key, project keystore, and
 * non-secret meta.json. The reserved `default` wallet lives at the config-dir
 * root (zero migration). Selection (which wallet a normal command uses) is
 * resolved at the CLI edge — see wallet-context.mjs. These subcommands operate
 * on EXPLICIT named targets via core's path-aware helpers, so they are
 * independent of the active selection.
 *
 * Agent-first: JSON to stdout, structured errors to stderr, no interactive
 * prompts (destructive `rm` requires an explicit --yes).
 */

import { writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { failUnknownSubcommand } from "./argparse.mjs";
import { join } from "node:path";
import { fail, reportSdkError } from "./sdk-errors.mjs";
import { walletFile, readWallet as readActiveWallet, saveWallet as saveActiveWallet } from "./config.mjs";
import { isValidProfileName, getActiveProfile } from "../core-dist/config.js";
import {
  listProfileNames,
  profileExists,
  profileDir,
  readMeta,
  writeMeta,
  ensureProfileDir,
  removeProfile,
  renameProfile,
  getDefaultWallet,
  setDefaultWallet,
} from "../core-dist/profiles.js";
import { readWallet, saveWallet } from "../core-dist/wallet.js";
import { describeRejectedValue } from "../core-dist/redact.js";
import { getSdk } from "./sdk.mjs";
import { readBindingFile, updateBindingFile } from "./wallet-context.mjs";
import { initializeWalletAction } from "./next-actions.mjs";

const DEFAULT = "default";
const PRIVATE_KEY_RE = /^0x[0-9a-fA-F]{64}$/;

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

function shortAddr(a) {
  return typeof a === "string" && a.length >= 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a ?? null;
}

function out(obj) {
  console.log(JSON.stringify(obj, null, 2));
}

// See core-dist/redact.js's doc comment: a
// value that fails this check may be a secret pasted into a name argument
// by mistake, so it must never be echoed verbatim — describeRejectedValue()
// still shows a short/plain typo in full.
function requireName(name, what = "wallet name") {
  if (!name) fail({ code: "BAD_USAGE", message: `Missing ${what}.`, hint: "run402 wallets --help" });
  if (name === DEFAULT) return name;
  if (!isValidProfileName(name)) {
    fail({
      code: "BAD_WALLET_NAME",
      message: `Invalid ${what} ${JSON.stringify(describeRejectedValue(name))}.`,
      hint: "Names must match /^[a-z0-9][a-z0-9_-]{0,63}$/ (lowercase letters, digits, '_' and '-').",
      details: { name: describeRejectedValue(name) },
    });
  }
  return name;
}

function walletInfo(name, active) {
  const meta = readMeta(name);
  let address = meta?.address ?? null;
  let rail = meta?.rail ?? null;
  const label = meta?.label ?? null;
  if (!address) {
    try {
      const a = readWallet(join(profileDir(name), "wallet.json"));
      address = a?.address ?? null;
      rail = rail ?? a?.rail ?? null;
    } catch {
      /* best-effort */
    }
  }
  return { local_label: name, server_label: label, address, address_short: shortAddr(address), rail, active: name === active };
}

function activeContext() {
  try {
    const ctx = JSON.parse(process.env.RUN402_ACTIVE_WALLET_JSON || "");
    if (ctx && typeof ctx === "object") return ctx;
  } catch {
    /* not set / malformed */
  }
  return null;
}

function cmdList() {
  const active = getActiveProfile();
  out(listProfileNames().map((n) => walletInfo(n, active)));
}

async function cmdCurrent() {
  const ctx = activeContext();
  const name = ctx?.name ?? getActiveProfile();
  const info = walletInfo(name, name);
  const warnings = [];
  if (ctx?.diverged && ctx.binding) {
    warnings.push({
      code: "WALLET_SELECTION_CONFLICT",
      message: `RUN402_WALLET=${ctx.envName} but ${ctx.binding.file} selects '${ctx.binding.wallet}'.`,
      hint: "Resolve with: --wallet <name>, unset RUN402_WALLET, or run402 wallets unbind.",
    });
  }
  if (info.server_label && info.server_label !== name) {
    warnings.push({
      code: "WALLET_LABEL_DRIFT",
      message: `Local label '${name}' differs from the server label '${info.server_label}'.`,
      hint: "Run 'run402 wallets rename' to reconcile.",
    });
  }
  // The active wallet's own file: when it was created, its persisted rail, and
  // whether the faucet has been used on it. `faucet_used` tracks faucet
  // invocation, not pay-readiness — `run402 wallets balance` reads real funds.
  let local = null;
  try {
    local = await getSdk().wallets.status();
  } catch (err) {
    reportSdkError(err);
  }
  out({
    local_label: name,
    source: ctx?.source ?? "unknown",
    source_detail: ctx?.sourceDetail ?? null,
    address: local?.configured ? local.address : info.address,
    server_label: info.server_label,
    configured: !!local?.configured,
    created: local?.created ?? null,
    rail: local?.configured ? local.rail ?? "x402" : info.rail,
    faucet_used: !!local?.faucet_used,
    path: local?.path ?? walletFile(),
    ...(local?.configured ? {} : { next_actions: [initializeWalletAction()] }),
    warnings,
  });
}

async function cmdNew(args) {
  const name = requireName(args.find((a) => a && !a.startsWith("-")));
  if (profileExists(name)) {
    fail({ code: "WALLET_EXISTS", message: `A wallet named '${name}' already exists.`, hint: "run402 wallets list", details: { name } });
  }
  const railFlag = args.indexOf("--rail");
  const requested = railFlag >= 0 ? args[railFlag + 1] : args.includes("--mpp") ? "mpp" : "x402";
  if (!["x402", "mpp", "lightning"].includes(requested)) {
    fail({ code: "BAD_USAGE", message: "--rail must be x402, mpp, or lightning", details: { rail: requested } });
  }
  const rail = requested;
  const { generatePrivateKey, privateKeyToAccount } = await import("viem/accounts");
  const privateKey = generatePrivateKey();
  const address = privateKeyToAccount(privateKey).address;
  const created = new Date().toISOString();
  ensureProfileDir(name);
  saveWallet({ address, privateKey, created, funded: false, rail }, join(profileDir(name), "wallet.json"));
  // The reserved `default` wallet lives at the config-dir root and carries no
  // server label; a named wallet mirrors its name as the label.
  if (name === DEFAULT) {
    writeMeta(name, { name, address, rail, created });
  } else {
    writeMeta(name, { name, address, label: name, rail, created });
    await maybePushLabel(name, name, address);
  }
  // requireName constrains aliases to shell-safe lowercase identifiers.
  const command = rail === "lightning"
    ? `run402 --wallet ${name} init lightning`
    : name === DEFAULT ? "run402 wallets fund" : `run402 wallets use ${name}`;
  const why = rail === "lightning"
    ? "Initialize this Lightning wallet."
    : name === DEFAULT ? "Fund the wallet you just created from the testnet faucet." : "Select the wallet you just created.";
  out({ local_label: name, address, rail, created: true, next: command, next_actions: [{ type: "run_command", command, why }] });
}

function cmdUse(args) {
  const name = requireName(args.find((a) => a && !a.startsWith("-")));
  if (name !== DEFAULT && !profileExists(name)) {
    // `name` already passed requireName's charset check, but a bare (no
    // "0x") 64-hex private key satisfies that charset too — describeRejectedValue()
    // is the backstop against echoing it here.
    fail({ code: "WALLET_NOT_FOUND", message: `No local wallet named '${describeRejectedValue(name)}'.`, hint: "run402 wallets list", details: { name: describeRejectedValue(name) } });
  }
  setDefaultWallet(name);
  out({ local_label: name, active: true });
}

async function cmdRename(args) {
  const toFlag = flagVal(args, "--to");
  const positionals = args.filter((a, i) => a && !a.startsWith("-") && args[i - 1] !== "--to");
  const oldName = requireName(positionals[0], "old wallet name");
  const newName = requireName(toFlag ?? positionals[1], "new wallet name");
  if (newName === DEFAULT) {
    fail({ code: "BAD_WALLET_NAME", message: "Cannot rename a wallet to the reserved name 'default'.", details: { name: newName } });
  }
  if (!profileExists(oldName)) {
    fail({ code: "WALLET_NOT_FOUND", message: `No local wallet named '${describeRejectedValue(oldName)}'.`, hint: "run402 wallets list", details: { name: describeRejectedValue(oldName) } });
  }
  try {
    renameProfile(oldName, newName);
  } catch (e) {
    fail({ code: "WALLET_RENAME_FAILED", message: e?.message ?? "rename failed", details: { from: oldName, to: newName } });
  }
  if (getDefaultWallet() === oldName) setDefaultWallet(newName);
  const meta = readMeta(newName) ?? {};
  let address = meta.address ?? null;
  if (!address) {
    try {
      address = readWallet(join(profileDir(newName), "wallet.json"))?.address ?? null;
    } catch {
      /* best-effort */
    }
  }
  writeMeta(newName, { ...meta, name: newName, label: newName, ...(address ? { address } : {}) });
  await maybePushLabel(newName, newName, address);
  out({ from: oldName, to: newName, renamed: true });
}

function cmdBind(args) {
  let name = args.find((a) => a && !a.startsWith("-"));
  name = name ? requireName(name) : getActiveProfile();
  // MERGE, never clobber: the same file carries `org`/`room` from `org bind`.
  const { contents } = updateBindingFile(process.cwd(), { wallet: name });
  const result = {
    wallet: name,
    file: ".run402.json",
    bound: true,
    safe_to_commit: true,
    note: "Safe to commit — contains no secrets, only the wallet name.",
    binding: contents,
  };
  if (name !== DEFAULT && !profileExists(name)) {
    result.warning = `No local wallet named '${name}' yet — create it with 'run402 wallets new ${name}'.`;
  }
  out(result);
}

function cmdUnbind() {
  // Removes only the WALLET key. An `org`/`room` binding in the same file
  // belongs to another tier and must survive; the file is deleted only when
  // unbinding leaves nothing behind.
  const had = readBindingFile(process.cwd()).wallet !== undefined;
  const { contents, removed } = updateBindingFile(process.cwd(), { wallet: null });
  out({ file: ".run402.json", unbound: had, removed, binding: contents });
}

async function cmdImport(args) {
  const name = requireName(args.find((a) => a && !a.startsWith("-")));
  if (name === DEFAULT) {
    fail({ code: "BAD_WALLET_NAME", message: "'default' is reserved.", details: { name } });
  }
  if (profileExists(name)) {
    fail({ code: "WALLET_EXISTS", message: `A wallet named '${name}' already exists.`, details: { name } });
  }
  const keyArg = flagVal(args, "--key");
  if (!keyArg) {
    fail({ code: "BAD_USAGE", message: "--key <path|-> is required for import.", hint: "Use '-' to read the key from stdin." });
  }
  let raw;
  try {
    raw = keyArg === "-" ? readFileSync(0, "utf8") : readFileSync(keyArg, "utf8");
  } catch (e) {
    fail({ code: "FILE_NOT_FOUND", message: `Could not read key from ${keyArg === "-" ? "stdin" : keyArg}: ${e?.message}`, details: { key: keyArg } });
  }
  const privateKey = raw.trim();
  if (!PRIVATE_KEY_RE.test(privateKey)) {
    fail({ code: "BAD_PRIVATE_KEY", message: "Key must be a 0x-prefixed 64-hex secp256k1 private key.", details: { name } });
  }
  const { privateKeyToAccount } = await import("viem/accounts");
  let address;
  try {
    address = privateKeyToAccount(privateKey).address;
  } catch (e) {
    fail({ code: "BAD_PRIVATE_KEY", message: `Invalid private key: ${e?.message}`, details: { name } });
  }
  const created = new Date().toISOString();
  ensureProfileDir(name);
  saveWallet({ address, privateKey, created, funded: false, rail: "x402" }, join(profileDir(name), "wallet.json"));
  writeMeta(name, { name, address, label: name, rail: "x402", created });
  await maybePushLabel(name, name, address);
  out({ local_label: name, address, imported: true });
}

function cmdRm(args) {
  const name = requireName(args.find((a) => a && !a.startsWith("-")));
  if (name === DEFAULT) {
    fail({ code: "WALLET_PROTECTED", message: "Refusing to remove the reserved 'default' wallet.", details: { name } });
  }
  if (!profileExists(name)) {
    fail({ code: "WALLET_NOT_FOUND", message: `No local wallet named '${describeRejectedValue(name)}'.`, hint: "run402 wallets list", details: { name: describeRejectedValue(name) } });
  }
  if (!args.includes("--yes")) {
    fail({
      code: "CONFIRMATION_REQUIRED",
      message: `Removing wallet '${name}' deletes its private key and project keystore. This cannot be undone.`,
      hint: `Re-run with --yes to confirm: run402 wallets rm ${name} --yes`,
      details: { name },
    });
  }
  removeProfile(name);
  if (getDefaultWallet() === name) setDefaultWallet(DEFAULT);
  out({ local_label: name, removed: true });
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

/**
 * Best-effort server-side label push. Signs with the TARGET wallet's key
 * (not the active one) so a just-created/renamed wallet can set its own label.
 *
 * ON by default — the gateway label endpoint is live, and the display label is
 * what makes the wallet name show up cross-machine and in the console
 * (WEB). Set `RUN402_WALLET_LABEL_SYNC=0` to disable (fully-offline wallet ops,
 * or hermetic tests). The local folder name is always the source of truth; this
 * only mirrors the display label to the server. Always best-effort — `setLabel`
 * swallows its own errors and this never throws, so wallet creation/rename stays
 * fully functional offline.
 */
async function maybePushLabel(name, label, address) {
  if (process.env.RUN402_WALLET_LABEL_SYNC === "0") return;
  if (!address) return;
  try {
    const sdk = getSdk({
      walletPath: join(profileDir(name), "wallet.json"),
      keystorePath: join(profileDir(name), "projects.json"),
    });
    await sdk.wallet(address).setLabel(label);
  } catch {
    /* best-effort — never block the local operation */
  }
}

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
  const { ensureLightningWallet, revokeLightningWallet, describeLightning, readLightningBalance } = await import("./lightning-wallet.mjs");
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
      const result = await ensureLightningWallet();
      const balance = result.outcome === "stored" || result.outcome === "present" ? await readLightningBalance(result.localWallet) : null;
      out({ outcome: result.outcome, rail: result.localWallet.rail ?? "x402", lightning: describeLightning(result.localWallet, result.wallet, balance) });
      return;
    }
    if (action === "revoke") {
      const wallet = await revokeLightningWallet();
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
