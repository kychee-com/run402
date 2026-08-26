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

import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fail } from "./sdk-errors.mjs";
import { isValidProfileName } from "../core-dist/config.js";
import { getDefaultWallet, profileExists, readMeta, profileDir } from "../core-dist/profiles.js";
import { readAllowance } from "../core-dist/allowance.js";
// The binding file is a CHECKOUT-LEVEL CONTRACT read by more than one surface,
// so its reader lives in core — `run402-mcp` ships core/dist but not cli/, and
// two readers of one file format is exactly the drift worth not having.
// Re-exported here under the names the rest of the CLI already imports.
import {
  findBindingKey,
  bindingFilePath,
  readBindingFile,
  BINDING_FILE,
} from "../core-dist/binding-file.js";

export { findBindingKey, bindingFilePath, readBindingFile };

const DEFAULT = "default";
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

/** Nearest wallet binding walking up from `startDir` to the filesystem root. */
export function findBinding(startDir) {
  const hit = findBindingKey(startDir, "wallet");
  return hit ? { wallet: hit.value, file: hit.file } : null;
}

/**
 * Thrown by the `*Core` functions below instead of calling `fail()` directly
 * — carries the exact `{code, message, hint, details}` shape `fail()`
 * expects, so a caller that CAN safely call `process.exit()` (the CLI, at
 * the top of `cli.mjs`, before any protocol stream has started) does
 * `fail(err)` verbatim, and a caller that CANNOT (`git-remote-run402` — see
 * that file's own header: `process.exit()` mid-stream can truncate a
 * pending stdout write on a pipe) catches it and reports through its own
 * non-exiting error path instead.
 */
export class WalletSelectionError extends Error {
  constructor({ code, message, hint, details }) {
    super(message);
    this.name = "WalletSelectionError";
    this.code = code;
    this.hint = hint;
    this.details = details;
  }
}

function assertValidNameCore(name, origin) {
  if (name === DEFAULT || isValidProfileName(name)) return;
  throw new WalletSelectionError({
    code: "BAD_WALLET_NAME",
    message: `Invalid wallet name ${JSON.stringify(name)} (from ${origin}).`,
    hint: "Wallet names must match /^[a-z0-9][a-z0-9_-]{0,63}$/ (lowercase letters, digits, '_' and '-').",
    details: { name, origin },
  });
}

function assertValidName(name, origin) {
  try {
    assertValidNameCore(name, origin);
  } catch (err) {
    if (err instanceof WalletSelectionError) fail(err);
    throw err;
  }
}

/**
 * Pure precedence resolution + conflict detection — no flag layer, never
 * prompts, never calls `fail()`/`process.exit()`. Returns
 * `{ name, source, sourceDetail }` or throws {@link WalletSelectionError}.
 *
 * Shared verbatim by `resolveWallet` below (the CLI wrapper: `--wallet` flag
 * layered on top, failures routed through `fail()`) AND by
 * `git-remote-run402` (no flag layer — the helper has no argv flags at all
 * — failures routed through its own protocol-safe error reporting). This is
 * THE fix for kychee-com/run402#558: before it, `git-remote-run402` called
 * `getSdk()` directly and ran no wallet selection at all, so a `.run402.json`
 * binding — and even the global `wallets use` default — silently never
 * reached it; only the `RUN402_WALLET` env layer worked.
 *
 * Precedence beneath an optional flag (highest first): `RUN402_WALLET` /
 * `RUN402_PROFILE` env > nearest `.run402.local.json`/`.run402.json` binding
 * (walked from `cwd`, which callers choose deliberately — see this file's
 * own module doc and `git-remote-run402`'s "WHICH REPOSITORY" note: the
 * binding walk must start from the REPOSITORY directory when one is
 * resolvable, cwd only for repository-free commands) > `wallets use` global
 * default > `"default"`. env-vs-binding disagreement is a hard error unless
 * `cmd` is conflict-exempt (`wallets`) — same rule for every caller.
 */
export function resolveWalletCore({ walletFlag, env = {}, cwd = process.cwd(), cmd } = {}) {
  if (walletFlag) {
    if (walletFlag.value === undefined || walletFlag.value === "") {
      throw new WalletSelectionError({ code: "BAD_FLAG", message: `${walletFlag.flag} requires a value`, details: { flag: walletFlag.flag } });
    }
    assertValidNameCore(walletFlag.value, walletFlag.flag);
    return { name: walletFlag.value, source: "flag", sourceDetail: walletFlag.flag };
  }

  const envRaw = env.RUN402_WALLET ?? env.RUN402_PROFILE;
  const envName = typeof envRaw === "string" && envRaw.trim() ? envRaw.trim() : null;
  const binding = findBinding(cwd);

  if (envName && binding && envName !== binding.wallet && !CONFLICT_EXEMPT.has(cmd)) {
    throw new WalletSelectionError({
      code: "WALLET_SELECTION_CONFLICT",
      message: `Ambiguous wallet: RUN402_WALLET=${envName} but ${binding.file} selects '${binding.wallet}'.`,
      hint: "Resolve with one of: pass --wallet <name>, unset RUN402_WALLET, or run402 wallets unbind.",
      details: { env_wallet: envName, binding_wallet: binding.wallet, binding_file: binding.file },
    });
  }

  if (envName) {
    assertValidNameCore(envName, "RUN402_WALLET");
    return { name: envName, source: "env", sourceDetail: "RUN402_WALLET" };
  }
  if (binding) {
    assertValidNameCore(binding.wallet, binding.file);
    return { name: binding.wallet, source: "binding", sourceDetail: binding.file };
  }
  const def = getDefaultWallet();
  if (def && def !== DEFAULT) return { name: def, source: "config", sourceDetail: "wallets use" };
  return { name: DEFAULT, source: "default", sourceDetail: null };
}

/** CLI wrapper over {@link resolveWalletCore}: identical resolution, `fail()` on error. */
export function resolveWallet(opts) {
  try {
    return resolveWalletCore(opts);
  } catch (err) {
    if (err instanceof WalletSelectionError) fail(err);
    throw err;
  }
}

function looksLikeAddress(s) {
  return typeof s === "string" && /^0x[a-fA-F0-9]{40}$/.test(s);
}

/**
 * Fail-closed check that a non-default, non-exempt selection names a wallet
 * that actually exists locally — pure, throws {@link WalletSelectionError}.
 * `cmd` is `undefined` for a non-CLI caller (`git-remote-run402`), which
 * matches neither `EXISTENCE_EXEMPT` entry, so the check always runs there.
 */
export function enforceWalletExistsCore({ name, source }, cmd) {
  if (name === DEFAULT) return;
  if (EXISTENCE_EXEMPT.has(cmd)) return;
  if (profileExists(name)) return;
  const hint = looksLikeAddress(name)
    ? `'${name}' looks like an address. For billing use: run402 billing ... --wallet-address ${name}`
    : `Run 'run402 wallets list' to see wallets, or 'run402 wallets new ${name}' to create it.`;
  throw new WalletSelectionError({
    code: "WALLET_NOT_FOUND",
    message: `No local wallet named '${name}'.`,
    hint,
    details: { wallet: name, source },
  });
}

/** CLI wrapper over {@link enforceWalletExistsCore}: identical check, `fail()` on error. */
export function enforceWalletExists(resolved, cmd) {
  try {
    enforceWalletExistsCore(resolved, cmd);
  } catch (err) {
    if (err instanceof WalletSelectionError) fail(err);
    throw err;
  }
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
