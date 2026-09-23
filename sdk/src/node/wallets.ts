/**
 * Named wallets (profiles) and wallet selection, owned by the Node SDK.
 *
 * Each named wallet is a self-contained profile directory under
 * `{config_dir}/profiles/<name>/` with its own key, project keystore, and
 * non-secret `meta.json`; the reserved `default` wallet lives at the
 * config-dir root. This module is the one implementation of:
 *
 * - the SELECTION precedence chain (`resolveWalletSelection`), highest first:
 *     1. an explicit flag value (`--wallet <name>` / `--profile <name>`)
 *     2. `RUN402_WALLET` / `RUN402_PROFILE`
 *     3. the nearest `.run402.local.json` / `.run402.json` binding, walking up
 *     4. the global default recorded by `wallets use` (base `config.json`)
 *     5. `default`
 *   An env value that disagrees with a directory binding is a hard error
 *   (`WALLET_SELECTION_CONFLICT`) unless the caller is the wallet-management
 *   surface itself, which must keep working while selection is ambiguous.
 * - the MANAGEMENT verbs on `r.wallets` (`list`, `current`, `create`, `use`,
 *   `rename`, `bind`, `unbind`, `import`, `remove`), which operate on explicit
 *   named targets and are independent of the active selection.
 *
 * The CLI (`run402 wallets …`, the `--wallet` pre-resolution in `cli.mjs`) and
 * the MCP server consume these; neither adds a precedence rule of its own.
 *
 * A rejected name is a value we know nothing about — a private key pasted
 * into `RUN402_WALLET` is a demonstrated case — so every refusal routes the
 * value through `describeRejectedValue()`: a short typo shows in full, anything
 * secret-shaped is redacted.
 */

import { join } from "node:path";
import {
  DEFAULT_PROFILE,
  getWalletPath,
  isValidProfileName,
} from "../../core-dist/config.js";
import {
  ensureProfileDir,
  getDefaultWallet,
  listProfileNames,
  profileDir,
  profileExists,
  readMeta,
  removeProfile,
  renameProfile,
  setDefaultWallet,
  writeMeta,
} from "../../core-dist/profiles.js";
import { readWallet, saveWallet } from "../../core-dist/wallet.js";
import { describeRejectedValue } from "../../core-dist/redact.js";
import { findBindingKey, readBindingFile, updateBindingFile } from "../../core-dist/binding-file.js";
import { LocalError, type NextAction } from "../errors.js";
import type { Client } from "../kernel.js";
import { Wallets, type WalletCreateResult } from "../namespaces/wallets.js";
import { gateSecret } from "../secret-gate.js";
import { initializeWalletAction } from "./local-actions.js";

const DEFAULT = DEFAULT_PROFILE;
const PRIVATE_KEY_RE = /^0x[0-9a-fA-F]{64}$/;
const CONTEXT = "managing local wallets";

/** Where the active wallet came from, highest precedence first. `config` is the global `wallets use` default. */
export type WalletSelectionSource = "flag" | "env" | "binding" | "config" | "default";

/** A flag value handed to the resolver, e.g. `{ flag: "--wallet", value: "kychon" }`; `value` undefined when the flag had none. */
export interface WalletFlag {
  flag: string;
  value: string | undefined;
}

export interface WalletSelection {
  name: string;
  source: WalletSelectionSource;
  /** The flag, env var, binding file, or `wallets use` that decided; null for the bare default. */
  sourceDetail: string | null;
}

export interface ResolveWalletSelectionOptions {
  walletFlag?: WalletFlag | null;
  env?: Record<string, string | undefined>;
  /** Directory the binding walk starts from. Default `process.cwd()`. */
  cwd?: string;
  /** Skip the env-vs-binding conflict error (the wallet-management surface itself). */
  allowConflict?: boolean;
}

/**
 * A wallet selection refused: bad name, env-vs-binding conflict, or a named
 * wallet that does not exist locally. A {@link LocalError} carrying `code`,
 * `hint`, and `details`, never exiting the process, so a caller mid-protocol
 * (the git remote helper) can report it on its own channel.
 */
export class WalletSelectionError extends LocalError {
  constructor({ code, message, hint, details }: { code: string; message: string; hint?: string; details?: unknown }) {
    super(message, "selecting a wallet", { code, ...(hint !== undefined ? { hint } : {}), ...(details !== undefined ? { details } : {}) });
    this.name = "WalletSelectionError";
  }
}

function envName(env: Record<string, string | undefined>): string | null {
  const raw = env.RUN402_WALLET ?? env.RUN402_PROFILE;
  return typeof raw === "string" && raw.trim() ? raw.trim() : null;
}

function assertValidSelectionName(name: string, origin: string): void {
  if (name === DEFAULT || isValidProfileName(name)) return;
  throw new WalletSelectionError({
    code: "BAD_WALLET_NAME",
    message: `Invalid wallet name ${JSON.stringify(describeRejectedValue(name))} (from ${origin}).`,
    hint: "Wallet names must match /^[a-z0-9][a-z0-9_-]{0,63}$/ (lowercase letters, digits, '_' and '-'). If a private key or other secret ended up here, it does not belong in a NAME field — see `run402 wallets import` — and should be treated as compromised.",
    details: { name: describeRejectedValue(name), origin },
  });
}

/** Nearest wallet binding walking up from `startDir` to the filesystem root. */
export function findWalletBinding(startDir: string): { wallet: string; file: string } | null {
  const hit = findBindingKey(startDir, "wallet");
  return hit ? { wallet: hit.value, file: hit.file } : null;
}

/**
 * The one precedence chain. Pure: reads the environment it is handed, the
 * binding files above `cwd`, and the global default; never prompts, never
 * exits. Throws {@link WalletSelectionError}.
 */
export function resolveWalletSelection({
  walletFlag,
  env = process.env,
  cwd = process.cwd(),
  allowConflict = false,
}: ResolveWalletSelectionOptions = {}): WalletSelection {
  if (walletFlag) {
    if (walletFlag.value === undefined || walletFlag.value === "") {
      throw new WalletSelectionError({ code: "BAD_FLAG", message: `${walletFlag.flag} requires a value`, details: { flag: walletFlag.flag } });
    }
    assertValidSelectionName(walletFlag.value, walletFlag.flag);
    return { name: walletFlag.value, source: "flag", sourceDetail: walletFlag.flag };
  }

  const fromEnv = envName(env);
  const binding = findWalletBinding(cwd);

  if (fromEnv && binding && fromEnv !== binding.wallet && !allowConflict) {
    // Runs BEFORE the name check, so an unvalidated (possibly secret-shaped)
    // env value reaches here whenever a binding exists: redact it the same
    // way. The binding's value comes from a committed file whose writer
    // validated it.
    throw new WalletSelectionError({
      code: "WALLET_SELECTION_CONFLICT",
      message: `Ambiguous wallet: RUN402_WALLET=${describeRejectedValue(fromEnv)} but ${binding.file} selects '${binding.wallet}'.`,
      hint: "Resolve with one of: pass --wallet <name>, unset RUN402_WALLET, or run402 wallets unbind.",
      details: { env_wallet: describeRejectedValue(fromEnv), binding_wallet: binding.wallet, binding_file: binding.file },
    });
  }

  if (fromEnv) {
    assertValidSelectionName(fromEnv, "RUN402_WALLET");
    return { name: fromEnv, source: "env", sourceDetail: "RUN402_WALLET" };
  }
  if (binding) {
    assertValidSelectionName(binding.wallet, binding.file);
    return { name: binding.wallet, source: "binding", sourceDetail: binding.file };
  }
  const globalDefault = getDefaultWallet();
  if (globalDefault && globalDefault !== DEFAULT) return { name: globalDefault, source: "config", sourceDetail: "wallets use" };
  return { name: DEFAULT, source: "default", sourceDetail: null };
}

function looksLikeAddress(s: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(s);
}

/**
 * Fail closed when a non-default selection names a wallet that does not exist
 * locally. Throws {@link WalletSelectionError} `WALLET_NOT_FOUND`.
 */
export function assertWalletExists({ name, source }: Pick<WalletSelection, "name" | "source">): void {
  if (name === DEFAULT) return;
  if (profileExists(name)) return;
  // A bare 64-hex private key satisfies the name charset, so this path can
  // still see key material: echo an address (public) or a short plain name,
  // redact anything else.
  const shown = describeRejectedValue(name);
  const hint = looksLikeAddress(name)
    ? `'${name}' looks like an address. For billing use: run402 billing ... --wallet-address ${name}`
    : shown === name
      ? `Run 'run402 wallets list' to see wallets, or 'run402 wallets new ${name}' to create it.`
      : "Run 'run402 wallets list' to see wallets. This value was not shown because it looks like a secret rather than a wallet name — if a private key or other credential landed here, treat it as compromised.";
  throw new WalletSelectionError({
    code: "WALLET_NOT_FOUND",
    message: `No local wallet named '${shown}'.`,
    hint,
    details: { wallet: shown, source },
  });
}

/** The environment variable carrying the published selection's provenance. */
export const ACTIVE_WALLET_CONTEXT_ENV = "RUN402_ACTIVE_WALLET_JSON";

export interface ActiveWalletContext {
  name: string;
  source: WalletSelectionSource;
  sourceDetail: string | null;
  binding: { wallet: string; file: string } | null;
  envName: string | null;
  diverged: boolean;
}

export interface SelectWalletOptions extends ResolveWalletSelectionOptions {
  /** Skip the fail-closed existence check (surfaces that create wallets). */
  allowMissing?: boolean;
}

/**
 * Resolve, fail closed, and PUBLISH the selection to `env` so every core path
 * function resolves under it: `RUN402_WALLET` names the wallet and
 * `RUN402_ACTIVE_WALLET_JSON` carries how it was chosen (read back by
 * `r.wallets.current()`, since the env var alone no longer can say). Call
 * once per process, before any client reads a path.
 */
export function selectWallet(opts: SelectWalletOptions = {}): WalletSelection {
  const env = (opts.env ?? process.env) as Record<string, string | undefined>;
  const cwd = opts.cwd ?? process.cwd();
  const fromEnv = envName(env);
  const binding = findWalletBinding(cwd);
  const resolved = resolveWalletSelection({ ...opts, env, cwd });
  if (!opts.allowMissing) assertWalletExists(resolved);
  env.RUN402_WALLET = resolved.name;
  const context: ActiveWalletContext = {
    name: resolved.name,
    source: resolved.source,
    sourceDetail: resolved.sourceDetail,
    binding: binding ? { wallet: binding.wallet, file: binding.file } : null,
    envName: fromEnv,
    diverged: !!(fromEnv && binding && fromEnv !== binding.wallet),
  };
  env[ACTIVE_WALLET_CONTEXT_ENV] = JSON.stringify(context);
  return resolved;
}

/** The published selection context, or null when no surface published one. */
export function readActiveWalletContext(env: Record<string, string | undefined> = process.env): ActiveWalletContext | null {
  try {
    const parsed = JSON.parse(env[ACTIVE_WALLET_CONTEXT_ENV] || "");
    return parsed && typeof parsed === "object" ? (parsed as ActiveWalletContext) : null;
  } catch {
    return null;
  }
}

// ── management ──────────────────────────────────────────────────────────────

export type WalletRail = "x402" | "mpp" | "lightning";

export interface WalletDescriptor {
  local_label: string;
  server_label: string | null;
  address: string | null;
  address_short: string | null;
  rail: string | null;
  active: boolean;
}

export interface WalletWarning {
  code: string;
  message: string;
  hint: string;
}

export interface CurrentWalletResult {
  local_label: string;
  source: WalletSelectionSource | "unknown";
  source_detail: string | null;
  address: string | null;
  server_label: string | null;
  configured: boolean;
  created: string | null;
  rail: string | null;
  faucet_used: boolean;
  path: string;
  next_actions?: NextAction[];
  warnings: WalletWarning[];
}

export interface CreatedWalletProfile {
  local_label: string;
  address: string;
  rail: WalletRail;
  created: true;
  /** The first next action's command, kept beside `next_actions` for plain readers. */
  next: string;
  next_actions: NextAction[];
}

export interface WalletBindResult {
  wallet: string;
  file: ".run402.json";
  bound: true;
  safe_to_commit: true;
  note: string;
  binding: Record<string, unknown> | null;
  warning?: string;
}

export interface WalletUnbindResult {
  file: ".run402.json";
  unbound: boolean;
  removed: boolean;
  binding: Record<string, unknown> | null;
}

/** Builds a client signing as another named wallet (the label push signs as its target). */
export type WalletClientFactory = (paths: { walletPath: string; keystorePath: string }) => {
  wallet(address: string): { setLabel(label: string): Promise<{ ok: boolean }> };
};

function shortAddr(a: string | null | undefined): string | null {
  return typeof a === "string" && a.length >= 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a ?? null;
}

function badUsage(message: string, hint?: string, details?: unknown): LocalError {
  return new LocalError(message, CONTEXT, { code: "BAD_USAGE", ...(hint !== undefined ? { hint } : {}), ...(details !== undefined ? { details } : {}) });
}

function requireName(name: string | undefined | null, what = "wallet name"): string {
  if (!name) throw badUsage(`Missing ${what}.`, "run402 wallets --help");
  if (name === DEFAULT) return name;
  if (!isValidProfileName(name)) {
    throw new LocalError(`Invalid ${what} ${JSON.stringify(describeRejectedValue(name))}.`, CONTEXT, {
      code: "BAD_WALLET_NAME",
      hint: "Names must match /^[a-z0-9][a-z0-9_-]{0,63}$/ (lowercase letters, digits, '_' and '-').",
      details: { name: describeRejectedValue(name) },
    });
  }
  return name;
}

function walletNotFound(name: string): LocalError {
  return new LocalError(`No local wallet named '${describeRejectedValue(name)}'.`, CONTEXT, {
    code: "WALLET_NOT_FOUND",
    hint: "run402 wallets list",
    details: { name: describeRejectedValue(name) },
  });
}

function profileWalletPath(name: string): string {
  return join(profileDir(name), "wallet.json");
}

function walletInfo(name: string, active: string): WalletDescriptor {
  const meta = readMeta(name);
  let address = meta?.address ?? null;
  let rail: string | null = meta?.rail ?? null;
  const label = meta?.label ?? null;
  if (!address) {
    try {
      const w = readWallet(profileWalletPath(name));
      address = w?.address ?? null;
      rail = rail ?? w?.rail ?? null;
    } catch {
      /* best-effort */
    }
  }
  return { local_label: name, server_label: label, address, address_short: shortAddr(address), rail, active: name === active };
}

/**
 * `r.wallets` on the Node entry: the isomorphic local-wallet and label verbs
 * plus the named-wallet (profile) management verbs.
 */
export class NodeWallets extends Wallets {
  readonly #client: Client;
  readonly #clientFor: WalletClientFactory | undefined;

  constructor(client: Client, opts: { clientFor?: WalletClientFactory } = {}) {
    super(client);
    this.#client = client;
    this.#clientFor = opts.clientFor;
  }

  /** The selection in force: the one a surface published, else resolved fresh from the environment and cwd. */
  #selection(): { name: string; context: ActiveWalletContext | null; resolved: WalletSelection | null } {
    const context = readActiveWalletContext();
    if (context) return { name: context.name, context, resolved: null };
    const resolved = resolveWalletSelection({ allowConflict: true });
    return { name: resolved.name, context: null, resolved };
  }

  /** Every local wallet, without loading any private key. */
  async list(): Promise<WalletDescriptor[]> {
    const active = this.#selection().name;
    return listProfileNames().map((name: string) => walletInfo(name, active));
  }

  /** The active wallet: its name, how it was selected, and the local wallet file's facts. */
  async current(): Promise<CurrentWalletResult> {
    const { name, context, resolved } = this.#selection();
    const info = walletInfo(name, name);
    const warnings: WalletWarning[] = [];
    const binding = context ? context.binding : findWalletBinding(process.cwd());
    const fromEnv = context ? context.envName : envName(process.env);
    const diverged = context ? context.diverged : !!(fromEnv && binding && fromEnv !== binding.wallet);
    if (diverged && binding) {
      warnings.push({
        code: "WALLET_SELECTION_CONFLICT",
        message: `RUN402_WALLET=${fromEnv} but ${binding.file} selects '${binding.wallet}'.`,
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
    // `faucet_used` tracks faucet invocation, not pay-readiness.
    const local = await this.status();
    return {
      local_label: name,
      source: context?.source ?? resolved?.source ?? "unknown",
      source_detail: context ? context.sourceDetail ?? null : resolved?.sourceDetail ?? null,
      address: local?.configured ? local.address : info.address,
      server_label: info.server_label,
      configured: !!local?.configured,
      created: local?.created ?? null,
      rail: local?.configured ? local.rail ?? "x402" : info.rail,
      faucet_used: !!local?.faucet_used,
      path: local?.path ?? getWalletPath(),
      ...(local?.configured ? {} : { next_actions: [initializeWalletAction()] }),
      warnings,
    };
  }

  /**
   * With no name: create the ACTIVE profile's wallet file (the isomorphic
   * behaviour). With a name: create a new named wallet (its key stays local)
   * on `rail` (default `x402`); `default` creates the root wallet. Refused on
   * the sandbox surface: it writes a private key.
   */
  override create(): Promise<WalletCreateResult>;
  override create(name: string, opts?: { rail?: string }): Promise<CreatedWalletProfile>;
  override async create(name?: string, opts: { rail?: string } = {}): Promise<WalletCreateResult | CreatedWalletProfile> {
    if (name === undefined) return super.create();
    gateSecret(this.#client, "wallets.create", name, opts);
    const label = requireName(name);
    if (profileExists(label)) {
      throw new LocalError(`A wallet named '${label}' already exists.`, CONTEXT, { code: "WALLET_EXISTS", hint: "run402 wallets list", details: { name: label } });
    }
    const requested = opts.rail ?? "x402";
    if (!["x402", "mpp", "lightning"].includes(requested)) {
      throw badUsage("--rail must be x402, mpp, or lightning", undefined, { rail: requested });
    }
    const rail = requested as WalletRail;
    const { generatePrivateKey, privateKeyToAccount } = await import("viem/accounts");
    const privateKey = generatePrivateKey();
    const address = privateKeyToAccount(privateKey).address;
    const created = new Date().toISOString();
    ensureProfileDir(label);
    saveWallet({ address, privateKey, created, funded: false, rail }, profileWalletPath(label));
    // The reserved `default` wallet carries no server label; a named wallet mirrors its name.
    if (label === DEFAULT) {
      writeMeta(label, { name: label, address, rail: rail as "x402" | "mpp", created });
    } else {
      writeMeta(label, { name: label, address, label, rail: rail as "x402" | "mpp", created });
      await this.#pushLabel(label, label, address);
    }
    // requireName constrains names to shell-safe lowercase identifiers.
    const command = rail === "lightning"
      ? `run402 --wallet ${label} init lightning`
      : label === DEFAULT ? "run402 wallets fund" : `run402 wallets use ${label}`;
    const why = rail === "lightning"
      ? "Initialize this Lightning wallet."
      : label === DEFAULT ? "Fund the wallet you just created from the testnet faucet." : "Select the wallet you just created.";
    return { local_label: label, address, rail, created: true, next: command, next_actions: [{ type: "run_command", command, why }] };
  }

  /** Set the global default wallet (`wallets use`). */
  async use(name: string): Promise<{ local_label: string; active: true }> {
    const label = requireName(name);
    if (label !== DEFAULT && !profileExists(label)) throw walletNotFound(label);
    setDefaultWallet(label);
    return { local_label: label, active: true };
  }

  /** Rename a wallet; renaming `default` moves it under `profiles/`. */
  async rename(oldName: string, newName: string): Promise<{ from: string; to: string; renamed: true }> {
    const from = requireName(oldName, "old wallet name");
    const to = requireName(newName, "new wallet name");
    if (to === DEFAULT) {
      throw new LocalError("Cannot rename a wallet to the reserved name 'default'.", CONTEXT, { code: "BAD_WALLET_NAME", details: { name: to } });
    }
    if (!profileExists(from)) throw walletNotFound(from);
    try {
      renameProfile(from, to);
    } catch (e) {
      throw new LocalError((e as Error)?.message ?? "rename failed", CONTEXT, { code: "WALLET_RENAME_FAILED", details: { from, to } });
    }
    if (getDefaultWallet() === from) setDefaultWallet(to);
    const meta = readMeta(to) ?? { name: to };
    let address = meta.address ?? null;
    if (!address) {
      try {
        address = readWallet(profileWalletPath(to))?.address ?? null;
      } catch {
        /* best-effort */
      }
    }
    writeMeta(to, { ...meta, name: to, label: to, ...(address ? { address } : {}) });
    await this.#pushLabel(to, to, address);
    return { from, to, renamed: true };
  }

  /** Bind a directory (default cwd) to a wallet by writing its name into `./.run402.json`. */
  async bind(name?: string, opts: { cwd?: string } = {}): Promise<WalletBindResult> {
    const label = name ? requireName(name) : this.#selection().name;
    // MERGE, never clobber: the same file carries `org`/`room` from `orgs bind`.
    const { contents } = updateBindingFile(opts.cwd ?? process.cwd(), { wallet: label });
    const result: WalletBindResult = {
      wallet: label,
      file: ".run402.json",
      bound: true,
      safe_to_commit: true,
      note: "Safe to commit — contains no secrets, only the wallet name.",
      binding: contents,
    };
    if (label !== DEFAULT && !profileExists(label)) {
      result.warning = `No local wallet named '${label}' yet — create it with 'run402 wallets new ${label}'.`;
    }
    return result;
  }

  /** Remove only the `wallet` key from `./.run402.json`; the file goes when nothing else is left in it. */
  async unbind(opts: { cwd?: string } = {}): Promise<WalletUnbindResult> {
    const dir = opts.cwd ?? process.cwd();
    const had = readBindingFile(dir).wallet !== undefined;
    const { contents, removed } = updateBindingFile(dir, { wallet: null });
    return { file: ".run402.json", unbound: had, removed, binding: contents };
  }

  /**
   * Adopt an existing private key as a new named wallet. `privateKey` may be a
   * function, called only after the name checks pass, so a caller reading the
   * key from a file or stdin reads nothing for a refused name. Refused on the
   * sandbox surface: its input is a private key.
   */
  async import(name: string, privateKey: string | (() => string)): Promise<{ local_label: string; address: string; imported: true }> {
    gateSecret(this.#client, "wallets.import", name);
    const label = requireName(name);
    if (label === DEFAULT) {
      throw new LocalError("'default' is reserved.", CONTEXT, { code: "BAD_WALLET_NAME", details: { name: label } });
    }
    if (profileExists(label)) {
      throw new LocalError(`A wallet named '${label}' already exists.`, CONTEXT, { code: "WALLET_EXISTS", details: { name: label } });
    }
    const key = (typeof privateKey === "function" ? privateKey() : privateKey).trim();
    if (!PRIVATE_KEY_RE.test(key)) {
      throw new LocalError("Key must be a 0x-prefixed 64-hex secp256k1 private key.", CONTEXT, { code: "BAD_PRIVATE_KEY", details: { name: label } });
    }
    const { privateKeyToAccount } = await import("viem/accounts");
    let address: string;
    try {
      address = privateKeyToAccount(key as `0x${string}`).address;
    } catch (e) {
      throw new LocalError(`Invalid private key: ${(e as Error)?.message}`, CONTEXT, { code: "BAD_PRIVATE_KEY", details: { name: label } });
    }
    const created = new Date().toISOString();
    ensureProfileDir(label);
    saveWallet({ address, privateKey: key, created, funded: false, rail: "x402" }, profileWalletPath(label));
    writeMeta(label, { name: label, address, label, rail: "x402", created });
    await this.#pushLabel(label, label, address);
    return { local_label: label, address, imported: true };
  }

  /** Delete a named wallet and its keys. Requires `{ confirm: true }`; `default` is protected. */
  async remove(name: string, opts: { confirm?: boolean } = {}): Promise<{ local_label: string; removed: true }> {
    const label = requireName(name);
    if (label === DEFAULT) {
      throw new LocalError("Refusing to remove the reserved 'default' wallet.", CONTEXT, { code: "WALLET_PROTECTED", details: { name: label } });
    }
    if (!profileExists(label)) throw walletNotFound(label);
    if (opts.confirm !== true) {
      throw new LocalError(`Removing wallet '${label}' deletes its private key and project keystore. This cannot be undone.`, CONTEXT, {
        code: "CONFIRMATION_REQUIRED",
        hint: `Re-run with --yes to confirm: run402 wallets rm ${label} --yes`,
        details: { name: label },
      });
    }
    removeProfile(label);
    if (getDefaultWallet() === label) setDefaultWallet(DEFAULT);
    return { local_label: label, removed: true };
  }

  /**
   * Best-effort server-side label push, signed with the TARGET wallet's key
   * so a just-created or renamed wallet can set its own label. On by default;
   * `RUN402_WALLET_LABEL_SYNC=0` disables it. Never throws: the local folder
   * name is the source of truth and the server label only mirrors it.
   */
  async #pushLabel(name: string, label: string, address: string | null): Promise<void> {
    if (process.env.RUN402_WALLET_LABEL_SYNC === "0") return;
    if (!address || !this.#clientFor) return;
    try {
      const sibling = this.#clientFor({ walletPath: profileWalletPath(name), keystorePath: join(profileDir(name), "projects.json") });
      await sibling.wallet(address).setLabel(label);
    } catch {
      /* best-effort — never block the local operation */
    }
  }
}
