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
import { join } from "node:path";
import { fail } from "./sdk-errors.mjs";
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
import { readAllowance, saveAllowance } from "../core-dist/allowance.js";
import { getSdk } from "./sdk.mjs";

const DEFAULT = "default";
const PRIVATE_KEY_RE = /^0x[0-9a-fA-F]{64}$/;

const HELP = `run402 wallets — manage named wallets (profiles)

Usage:
  run402 wallets list                 List all wallets (name, label, address, rail, active)
  run402 wallets current              Show the resolved active wallet + how it was selected
  run402 wallets new <name>           Create a new named wallet (key stays local)
  run402 wallets use <name>           Set the global default wallet
  run402 wallets rename <old> <new>   Rename a wallet (migrates the default's files when old=default)
  run402 wallets bind [<name>]        Write ./.run402.json binding this directory to a wallet
  run402 wallets unbind               Remove ./.run402.json
  run402 wallets import <name> --key <path|->   Adopt an existing private key as a named wallet
  run402 wallets rm <name> --yes      Delete a wallet and its keys (requires --yes)

Selection precedence for normal commands:
  --wallet <name>  >  RUN402_WALLET  >  ./.run402.json  >  'wallets use' default  >  default

Options:
  --mpp           (new) create the wallet on the MPP rail instead of x402
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

function requireName(name, what = "wallet name") {
  if (!name) fail({ code: "BAD_USAGE", message: `Missing ${what}.`, hint: "run402 wallets --help" });
  if (name === DEFAULT) return name;
  if (!isValidProfileName(name)) {
    fail({
      code: "BAD_WALLET_NAME",
      message: `Invalid ${what} ${JSON.stringify(name)}.`,
      hint: "Names must match /^[a-z0-9][a-z0-9_-]{0,63}$/ (lowercase letters, digits, '_' and '-').",
      details: { name },
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
      const a = readAllowance(join(profileDir(name), "allowance.json"));
      address = a?.address ?? null;
      rail = rail ?? a?.rail ?? null;
    } catch {
      /* best-effort */
    }
  }
  return { name, label, address, address_short: shortAddr(address), rail, active: name === active };
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

function cmdCurrent() {
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
  if (info.label && info.label !== name) {
    warnings.push({
      code: "WALLET_LABEL_DRIFT",
      message: `Local name '${name}' differs from the server label '${info.label}'.`,
      hint: "Run 'run402 wallets rename' to reconcile.",
    });
  }
  out({
    name,
    source: ctx?.source ?? "unknown",
    source_detail: ctx?.sourceDetail ?? null,
    address: info.address,
    label: info.label,
    warnings,
  });
}

async function cmdNew(args) {
  const name = requireName(args.find((a) => a && !a.startsWith("-")));
  if (name === DEFAULT) {
    fail({ code: "BAD_WALLET_NAME", message: "'default' is reserved. Use 'run402 init' for the default wallet.", details: { name } });
  }
  if (profileExists(name)) {
    fail({ code: "WALLET_EXISTS", message: `A wallet named '${name}' already exists.`, hint: "run402 wallets list", details: { name } });
  }
  const rail = args.includes("--mpp") ? "mpp" : "x402";
  const { generatePrivateKey, privateKeyToAccount } = await import("viem/accounts");
  const privateKey = generatePrivateKey();
  const address = privateKeyToAccount(privateKey).address;
  const created = new Date().toISOString();
  ensureProfileDir(name);
  saveAllowance({ address, privateKey, created, funded: false, rail }, join(profileDir(name), "allowance.json"));
  writeMeta(name, { name, address, label: name, rail, created });
  await maybePushLabel(name, name, address);
  out({ name, address, rail, created: true, next: `run402 wallets use ${name}  (or --wallet ${name} <command>)` });
}

function cmdUse(args) {
  const name = requireName(args.find((a) => a && !a.startsWith("-")));
  if (name !== DEFAULT && !profileExists(name)) {
    fail({ code: "WALLET_NOT_FOUND", message: `No local wallet named '${name}'.`, hint: "run402 wallets list", details: { name } });
  }
  setDefaultWallet(name);
  out({ name, active: true });
}

async function cmdRename(args) {
  const positionals = args.filter((a) => a && !a.startsWith("-"));
  const oldName = requireName(positionals[0], "old wallet name");
  const newName = requireName(positionals[1], "new wallet name");
  if (newName === DEFAULT) {
    fail({ code: "BAD_WALLET_NAME", message: "Cannot rename a wallet to the reserved name 'default'.", details: { name: newName } });
  }
  if (!profileExists(oldName)) {
    fail({ code: "WALLET_NOT_FOUND", message: `No local wallet named '${oldName}'.`, hint: "run402 wallets list", details: { name: oldName } });
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
      address = readAllowance(join(profileDir(newName), "allowance.json"))?.address ?? null;
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
  const file = join(process.cwd(), ".run402.json");
  writeFileSync(file, JSON.stringify({ wallet: name }, null, 2) + "\n");
  const result = {
    wallet: name,
    file: ".run402.json",
    bound: true,
    safe_to_commit: true,
    note: "Safe to commit — contains no secrets, only the wallet name.",
  };
  if (name !== DEFAULT && !profileExists(name)) {
    result.warning = `No local wallet named '${name}' yet — create it with 'run402 wallets new ${name}'.`;
  }
  out(result);
}

function cmdUnbind() {
  const file = join(process.cwd(), ".run402.json");
  const existed = existsSync(file);
  if (existed) rmSync(file, { force: true });
  out({ file: ".run402.json", unbound: existed });
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
  saveAllowance({ address, privateKey, created, funded: false, rail: "x402" }, join(profileDir(name), "allowance.json"));
  writeMeta(name, { name, address, label: name, rail: "x402", created });
  await maybePushLabel(name, name, address);
  out({ name, address, imported: true });
}

function cmdRm(args) {
  const name = requireName(args.find((a) => a && !a.startsWith("-")));
  if (name === DEFAULT) {
    fail({ code: "WALLET_PROTECTED", message: "Refusing to remove the reserved 'default' wallet.", details: { name } });
  }
  if (!profileExists(name)) {
    fail({ code: "WALLET_NOT_FOUND", message: `No local wallet named '${name}'.`, hint: "run402 wallets list", details: { name } });
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
  out({ name, removed: true });
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
 * Best-effort server-side label push. Signs with the TARGET wallet's allowance
 * (not the active one) so a just-created/renamed wallet can set its own label.
 *
 * ON by default — the gateway label endpoint is live, and the display label is
 * what makes the wallet name show up cross-machine and in the operator console
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
      allowancePath: join(profileDir(name), "allowance.json"),
      keystorePath: join(profileDir(name), "projects.json"),
    });
    await sdk.wallets.setLabel(address, label);
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
    default:
      fail({ code: "BAD_USAGE", message: `Unknown wallets subcommand: ${sub}`, hint: "run402 wallets --help" });
  }
}
