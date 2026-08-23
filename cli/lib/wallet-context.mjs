/**
 * Active-wallet (profile) resolution for the CLI edge.
 *
 * Runs at the top of cli.mjs BEFORE any subcommand module (and therefore
 * before cli/lib/config.mjs snapshots its paths) is loaded. Resolves which
 * named wallet a command operates on, sets `process.env.RUN402_WALLET` so all
 * core path functions resolve under it. Core itself stays env-only — the
 * `--wallet` flag and the per-directory `.run402.json` binding are translated
 * into the env var here, at the edge.
 *
 * Precedence (highest first):
 *   1. --wallet <name> / --profile <name>   (flag)
 *   2. RUN402_WALLET / RUN402_PROFILE        (env)
 *   3. nearest .run402.local.json/.run402.json (directory binding, walk up)
 *   4. config.json active_wallet              (global `wallets use`)
 *   5. "default"                              (root wallet)
 *
 * The flag is also the conflict resolver: when env and binding name different
 * wallets and no flag is given, that is a hard error (not a silent pick).
 */

import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fail } from "./sdk-errors.mjs";
import { isValidProfileName } from "../core-dist/config.js";
import { getDefaultWallet, profileExists, readMeta, profileDir } from "../core-dist/profiles.js";
import { readAllowance } from "../core-dist/allowance.js";

const DEFAULT = "default";
const BINDING_FILE = ".run402.json";
const GLOBAL_FLAGS = new Set(["--wallet", "--profile"]);
// The `wallets` group is the management + escape surface — it must work even
// when selection is ambiguous (so you can `wallets unbind`), and it validates
// its own positional targets. `init` creates wallets, so it must not fail
// closed on a not-yet-existing name.
const CONFLICT_EXEMPT = new Set(["wallets"]);
const EXISTENCE_EXEMPT = new Set(["wallets", "init", "doctor"]);

/**
 * Split the global --wallet/--profile flag (and its value) out of argv so the
 * subcommand never sees it. Pure: no core imports, no side effects. Returns
 * the cleaned argv and the selected flag (`{ flag, value }` or null). Last
 * occurrence wins. A missing value is left as `value: undefined` for
 * resolveWallet to reject with a precise error.
 */
export function splitWalletFlag(rawArgv = []) {
  const argv = [];
  let flag = null;
  for (let i = 0; i < rawArgv.length; i++) {
    const a = rawArgv[i];
    if (typeof a === "string" && a.startsWith("--") && a.includes("=")) {
      const name = a.slice(0, a.indexOf("="));
      if (GLOBAL_FLAGS.has(name)) {
        flag = { flag: name, value: a.slice(a.indexOf("=") + 1) };
        continue;
      }
    }
    if (typeof a === "string" && GLOBAL_FLAGS.has(a)) {
      const next = rawArgv[i + 1];
      if (next === undefined || (typeof next === "string" && next.startsWith("-"))) {
        flag = { flag: a, value: undefined };
      } else {
        flag = { flag: a, value: next };
        i += 1;
      }
      continue;
    }
    argv.push(a);
  }
  return { argv, walletFlag: flag };
}

function readBindingKeyFrom(dir, key) {
  // .run402.local.json (gitignored personal override) beats .run402.json.
  for (const fname of [".run402.local.json", ".run402.json"]) {
    const p = join(dir, fname);
    try {
      const parsed = JSON.parse(readFileSync(p, "utf8"));
      const v = parsed?.[key];
      if (typeof v === "string" && v.trim()) return { value: v.trim(), file: p };
    } catch {
      /* missing / unreadable / malformed → skip */
    }
  }
  return null;
}

/** Path of the committed binding file for a directory. */
export function bindingFilePath(dir = process.cwd()) {
  return join(dir, BINDING_FILE);
}

/** Parse a directory's committed binding file, or `{}` when absent/unreadable. */
export function readBindingFile(dir = process.cwd()) {
  try {
    const parsed = JSON.parse(readFileSync(bindingFilePath(dir), "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * MERGE keys into a directory's binding file. A `null` value removes its key;
 * a file left with no keys is deleted rather than committed empty.
 *
 * The file is shared by tiers (`wallet` from `wallets bind`, `org`/`room` from
 * `org bind`) and unknown keys are preserved, so one tier can never clobber
 * another's binding — which a whole-file write did until this existed.
 */
export function updateBindingFile(dir, patch) {
  const file = bindingFilePath(dir);
  const next = { ...readBindingFile(dir) };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null || v === undefined) delete next[k];
    else next[k] = v;
  }
  if (Object.keys(next).length === 0) {
    const existed = existsSync(file);
    if (existed) rmSync(file, { force: true });
    return { file, contents: null, removed: existed };
  }
  writeFileSync(file, JSON.stringify(next, null, 2) + "\n");
  return { file, contents: next, removed: false };
}

/**
 * Nearest binding carrying `key`, walking up from `startDir` to the root.
 *
 * Keys bind INDEPENDENTLY (add-cli-current-org, design D7): a file declaring
 * only `org` leaves wallet resolution untouched, and each key resolves at the
 * nearest file that carries it — so `/work/.run402.json` may supply the org
 * while `/work/api/.run402.json` supplies the wallet. Unknown keys are ignored,
 * which is what makes older CLIs forward-compatible with these files.
 */
export function findBindingKey(startDir, key) {
  let dir = resolve(startDir);
  for (;;) {
    const hit = readBindingKeyFrom(dir, key);
    if (hit) return hit;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Nearest wallet binding walking up from `startDir` to the filesystem root. */
export function findBinding(startDir) {
  const hit = findBindingKey(startDir, "wallet");
  return hit ? { wallet: hit.value, file: hit.file } : null;
}

function assertValidName(name, origin) {
  if (name === DEFAULT || isValidProfileName(name)) return;
  fail({
    code: "BAD_WALLET_NAME",
    message: `Invalid wallet name ${JSON.stringify(name)} (from ${origin}).`,
    hint: "Wallet names must match /^[a-z0-9][a-z0-9_-]{0,63}$/ (lowercase letters, digits, '_' and '-').",
    details: { name, origin },
  });
}

/** Pure precedence resolution + conflict detection. Returns { name, source, sourceDetail }. */
export function resolveWallet({ walletFlag, env = {}, cwd = process.cwd(), cmd } = {}) {
  if (walletFlag) {
    if (walletFlag.value === undefined || walletFlag.value === "") {
      fail({ code: "BAD_FLAG", message: `${walletFlag.flag} requires a value`, details: { flag: walletFlag.flag } });
    }
    assertValidName(walletFlag.value, walletFlag.flag);
    return { name: walletFlag.value, source: "flag", sourceDetail: walletFlag.flag };
  }

  const envRaw = env.RUN402_WALLET ?? env.RUN402_PROFILE;
  const envName = typeof envRaw === "string" && envRaw.trim() ? envRaw.trim() : null;
  const binding = findBinding(cwd);

  if (envName && binding && envName !== binding.wallet && !CONFLICT_EXEMPT.has(cmd)) {
    fail({
      code: "WALLET_SELECTION_CONFLICT",
      message: `Ambiguous wallet: RUN402_WALLET=${envName} but ${binding.file} selects '${binding.wallet}'.`,
      hint: "Resolve with one of: pass --wallet <name>, unset RUN402_WALLET, or run402 wallets unbind.",
      details: { env_wallet: envName, binding_wallet: binding.wallet, binding_file: binding.file },
    });
  }

  if (envName) {
    assertValidName(envName, "RUN402_WALLET");
    return { name: envName, source: "env", sourceDetail: "RUN402_WALLET" };
  }
  if (binding) {
    assertValidName(binding.wallet, binding.file);
    return { name: binding.wallet, source: "binding", sourceDetail: binding.file };
  }
  const def = getDefaultWallet();
  if (def && def !== DEFAULT) return { name: def, source: "config", sourceDetail: "wallets use" };
  return { name: DEFAULT, source: "default", sourceDetail: null };
}

function looksLikeAddress(s) {
  return typeof s === "string" && /^0x[a-fA-F0-9]{40}$/.test(s);
}

/** Fail closed when a non-default selection names a wallet that does not exist locally. */
export function enforceWalletExists({ name, source }, cmd) {
  if (name === DEFAULT) return;
  if (EXISTENCE_EXEMPT.has(cmd)) return;
  if (profileExists(name)) return;
  const hint = looksLikeAddress(name)
    ? `'${name}' looks like an address. For billing use: run402 billing ... --wallet-address ${name}`
    : `Run 'run402 wallets list' to see wallets, or 'run402 wallets new ${name}' to create it.`;
  fail({
    code: "WALLET_NOT_FOUND",
    message: `No local wallet named '${name}'.`,
    hint,
    details: { wallet: name, source },
  });
}

function shortAddr(a) {
  return typeof a === "string" && a.length >= 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}

/** Best-effort address for display: meta.json (no key) first, allowance second. */
function walletAddress(name) {
  const meta = readMeta(name);
  if (meta?.address) return meta.address;
  try {
    return readAllowance(join(profileDir(name), "allowance.json"))?.address ?? null;
  } catch {
    return null;
  }
}

/** Emit the stderr provenance line for non-default selections when explicitly requested. */
export function emitProvenance({ name, source, sourceDetail }, { cmd, quiet, showProvenance = false } = {}) {
  if (!showProvenance) return;
  if (quiet) return;
  if (name === DEFAULT) return;
  if (cmd === "wallets") return; // the wallets group reports its own context
  const where =
    source === "env" ? "RUN402_WALLET" :
    source === "config" ? "wallets use" :
    sourceDetail || source;
  const addr = walletAddress(name);
  const addrPart = addr ? ` (${shortAddr(addr)})` : "";
  process.stderr.write(`  ↪ wallet: ${name}${addrPart}   ← ${where}\n`);
}

/**
 * Orchestrate edge resolution: resolve → fail-closed → publish to the env so
 * core paths resolve → provenance. Returns the resolved selection.
 */
export function applyWalletSelection({ walletFlag, cmd, cwd = process.cwd(), env = process.env, quiet = false } = {}) {
  // Capture the pre-resolution signals so `wallets current` can report
  // provenance and any env-vs-binding divergence (it can't recompute them once
  // we overwrite RUN402_WALLET below).
  const envRaw = env.RUN402_WALLET ?? env.RUN402_PROFILE;
  const envName = typeof envRaw === "string" && envRaw.trim() ? envRaw.trim() : null;
  const binding = findBinding(cwd);

  const resolved = resolveWallet({ walletFlag, env, cwd, cmd });
  enforceWalletExists(resolved, cmd);

  // Publish to the env so all core path functions resolve under this wallet.
  env.RUN402_WALLET = resolved.name;
  env.RUN402_ACTIVE_WALLET_JSON = JSON.stringify({
    name: resolved.name,
    source: resolved.source,
    sourceDetail: resolved.sourceDetail,
    binding: binding ? { wallet: binding.wallet, file: binding.file } : null,
    envName,
    diverged: !!(envName && binding && envName !== binding.wallet),
  });

  emitProvenance(resolved, {
    cmd,
    quiet,
    showProvenance: env.RUN402_WALLET_PROVENANCE === "1",
  });
  return resolved;
}
