/**
 * The `--wallet` edge of the CLI: what has to happen before any subcommand
 * module (and so before `cli/lib/config.mjs` snapshots credential paths) is
 * loaded, and how a wallet-selection refusal is reported.
 *
 * The selection itself — the precedence chain (flag, RUN402_WALLET, the
 * nearest .run402(.local).json binding, the global `wallets use` default,
 * `default`), the env-vs-binding conflict, and the fail-closed existence
 * check — is the Node SDK's (`resolveWalletSelection`, `assertWalletExists`,
 * `selectWallet`). This module adds only:
 *   - reading `--wallet` / `--profile` off argv (`splitWalletFlag`);
 *   - which commands must keep working while selection is ambiguous or names
 *     a wallet that does not exist yet (the wallet-management group, `init`,
 *     `doctor`);
 *   - translating a `WalletSelectionError` into `fail()` for the CLI, while
 *     `git-remote-run402` (which must never `process.exit()` mid-stream)
 *     catches the same error and reports it through its own channel;
 *   - the opt-in stderr provenance line.
 */

import { join } from "node:path";
import { fail } from "./sdk-errors.mjs";
import { profileDir, readMeta } from "../core-dist/profiles.js";
import { readWallet } from "../core-dist/wallet.js";
import {
  findBindingKey,
  bindingFilePath,
  readBindingFile,
  updateBindingFile,
} from "../core-dist/binding-file.js";
import {
  WalletSelectionError,
  assertWalletExists,
  findWalletBinding,
  resolveWalletSelection,
  selectWallet,
} from "#sdk/node";

export { findBindingKey, bindingFilePath, readBindingFile, updateBindingFile, WalletSelectionError };

const DEFAULT = "default";
const GLOBAL_FLAGS = new Set(["--wallet", "--profile"]);
// `repos` owns `--profile` itself (the AWS credential profile for a BYO
// destination, a mirror, or a recovery source), so under that command only
// `--wallet` selects the wallet; RUN402_WALLET and the directory binding still
// apply.
const OWNS_PROFILE_FLAG = new Set(["repos"]);
// The `wallets` group is the management + escape surface — it must work even
// when selection is ambiguous (so you can `wallets unbind`), and it validates
// its own positional targets. `init` creates wallets, so it must not fail
// closed on a not-yet-existing name.
const CONFLICT_EXEMPT = new Set(["wallets"]);
const EXISTENCE_EXEMPT = new Set(["wallets", "init", "doctor"]);

/**
 * Split the global --wallet/--profile flag (and its value) out of argv so the
 * subcommand never sees it — except `--profile` under a command that owns the
 * flag (OWNS_PROFILE_FLAG), which is passed through untouched. Pure. Returns
 * the cleaned argv and the selected flag (`{ flag, value }` or null). Last
 * occurrence wins. A missing value is left as `value: undefined` for the
 * resolver to reject with a precise error.
 */
export function splitWalletFlag(rawArgv = []) {
  const argv = [];
  let flag = null;
  // The command word: the first positional that is not the value of a global flag.
  let first;
  for (let i = 0; i < rawArgv.length && first === undefined; i++) {
    const a = rawArgv[i];
    if (typeof a !== "string" || a.startsWith("-")) continue;
    if (i > 0 && GLOBAL_FLAGS.has(rawArgv[i - 1])) continue;
    first = a;
  }
  const ownsProfile = OWNS_PROFILE_FLAG.has(first);
  const isGlobal = (name) => GLOBAL_FLAGS.has(name) && !(ownsProfile && name === "--profile");
  for (let i = 0; i < rawArgv.length; i++) {
    const a = rawArgv[i];
    if (typeof a === "string" && a.startsWith("--") && a.includes("=")) {
      const name = a.slice(0, a.indexOf("="));
      if (isGlobal(name)) {
        flag = { flag: name, value: a.slice(a.indexOf("=") + 1) };
        continue;
      }
    }
    if (typeof a === "string" && isGlobal(a)) {
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

/** Nearest wallet binding walking up from `startDir` to the filesystem root. */
export function findBinding(startDir) {
  return findWalletBinding(startDir);
}

/**
 * The SDK's selection for command `cmd` (a non-CLI caller passes none), throwing
 * {@link WalletSelectionError}. `git-remote-run402` composes this directly so a
 * refusal never exits mid-protocol.
 */
export function resolveWalletCore({ walletFlag, env = {}, cwd = process.cwd(), cmd } = {}) {
  return resolveWalletSelection({ walletFlag, env, cwd, allowConflict: CONFLICT_EXEMPT.has(cmd) });
}

/** Fail closed on a missing wallet unless `cmd` creates or manages wallets; throws {@link WalletSelectionError}. */
export function enforceWalletExistsCore(resolved, cmd) {
  if (EXISTENCE_EXEMPT.has(cmd)) return;
  assertWalletExists(resolved);
}

function failSelection(err) {
  if (err instanceof WalletSelectionError) fail(err);
  throw err;
}

/** {@link resolveWalletCore}, `fail()` on a refusal. */
export function resolveWallet(opts) {
  try {
    return resolveWalletCore(opts);
  } catch (err) {
    return failSelection(err);
  }
}

/** {@link enforceWalletExistsCore}, `fail()` on a refusal. */
export function enforceWalletExists(resolved, cmd) {
  try {
    enforceWalletExistsCore(resolved, cmd);
  } catch (err) {
    failSelection(err);
  }
}

function shortAddr(a) {
  return typeof a === "string" && a.length >= 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}

/** Best-effort address for display: meta.json (no key) first, wallet second. */
function walletAddress(name) {
  const meta = readMeta(name);
  if (meta?.address) return meta.address;
  try {
    return readWallet(join(profileDir(name), "wallet.json"))?.address ?? null;
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
 * Resolve, fail closed, and publish the selection to the environment (the
 * SDK's `selectWallet`), then the optional provenance line.
 */
export function applyWalletSelection({ walletFlag, cmd, cwd = process.cwd(), env = process.env, quiet = false } = {}) {
  let resolved;
  try {
    resolved = selectWallet({
      walletFlag,
      env,
      cwd,
      allowConflict: CONFLICT_EXEMPT.has(cmd),
      allowMissing: EXISTENCE_EXEMPT.has(cmd),
    });
  } catch (err) {
    failSelection(err);
  }
  emitProvenance(resolved, {
    cmd,
    quiet,
    showProvenance: env.RUN402_WALLET_PROVENANCE === "1",
  });
  return resolved;
}
