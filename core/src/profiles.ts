/**
 * Named-wallet profile storage.
 *
 * A "wallet" is a whole config directory. The reserved `default` wallet lives
 * at the base config dir (zero migration for existing installs); every named
 * wallet lives under `{base}/profiles/<name>/` with its own `allowance.json`,
 * `projects.json`, and this module's non-secret `meta.json`.
 *
 * Two levels of active state, mirroring the wallet → project model:
 *   - base `{base}/config.json` `active_wallet`  — which wallet is the default
 *   - per-wallet `projects.json` `active_project_id` — which project within it
 *
 * All writes are atomic (temp-file + rename) and owner-only (0600 files,
 * 0700 dirs). `meta.json` holds only public/display data (no private key), so
 * listing and name display never need to load key material.
 */

import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  renameSync,
  chmodSync,
  existsSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import {
  getConfigBaseDir,
  getProfilesDir,
  DEFAULT_PROFILE,
  isValidProfileName,
} from "./config.js";

export interface BaseConfig {
  active_wallet?: string;
}

export interface ProfileMeta {
  name: string;
  address?: string;
  /** Cached server-side display label; null when unknown/unset. */
  label?: string | null;
  rail?: "x402" | "mpp";
  created?: string;
}

function atomicWrite(p: string, content: string, mode: number): void {
  const dir = dirname(p);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.${randomBytes(4).toString("hex")}.tmp`);
  writeFileSync(tmp, content, { mode });
  renameSync(tmp, p);
  try {
    chmodSync(p, mode);
  } catch {
    /* best-effort on non-POSIX */
  }
}

// --- base config.json (global default wallet pointer) ---

function baseConfigPath(): string {
  return join(getConfigBaseDir(), "config.json");
}

export function readBaseConfig(): BaseConfig {
  try {
    const parsed = JSON.parse(readFileSync(baseConfigPath(), "utf-8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as BaseConfig;
    }
  } catch {
    /* missing / unreadable / malformed → empty */
  }
  return {};
}

export function writeBaseConfig(cfg: BaseConfig): void {
  atomicWrite(baseConfigPath(), JSON.stringify(cfg, null, 2), 0o600);
}

/**
 * The globally-selected default wallet (set via `wallets use`), or the
 * reserved `default` when unset/invalid. This is precedence rung 4 — below the
 * flag, env var, and per-directory binding.
 */
export function getDefaultWallet(): string {
  const w = readBaseConfig().active_wallet;
  return w && (w === DEFAULT_PROFILE || isValidProfileName(w)) ? w : DEFAULT_PROFILE;
}

export function setDefaultWallet(name: string): void {
  const cfg = readBaseConfig();
  cfg.active_wallet = name;
  writeBaseConfig(cfg);
}

// --- per-profile directory + meta.json ---

/** Absolute directory for a wallet. `default` → base dir; named → profiles/<name>. */
export function profileDir(name: string): string {
  return name === DEFAULT_PROFILE ? getConfigBaseDir() : join(getProfilesDir(), name);
}

/** Create (if needed) a wallet's directory with owner-only (0700) perms. */
export function ensureProfileDir(name: string): string {
  const dir = profileDir(name);
  if (name === DEFAULT_PROFILE) {
    mkdirSync(dir, { recursive: true });
    return dir;
  }
  const profilesRoot = getProfilesDir();
  mkdirSync(profilesRoot, { recursive: true });
  try {
    chmodSync(profilesRoot, 0o700);
  } catch {
    /* best-effort */
  }
  mkdirSync(dir, { recursive: true });
  try {
    chmodSync(dir, 0o700);
  } catch {
    /* best-effort */
  }
  return dir;
}

function metaPath(name: string): string {
  return join(profileDir(name), "meta.json");
}

export function readMeta(name: string): ProfileMeta | null {
  try {
    const parsed = JSON.parse(readFileSync(metaPath(name), "utf-8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as ProfileMeta;
    }
  } catch {
    /* missing / unreadable / malformed → null */
  }
  return null;
}

export function writeMeta(name: string, meta: ProfileMeta): void {
  ensureProfileDir(name);
  atomicWrite(metaPath(name), JSON.stringify(meta, null, 2), 0o600);
}

// --- enumeration + lifecycle ---

/** True when a wallet's `allowance.json` exists on disk. */
export function profileExists(name: string): boolean {
  return existsSync(join(profileDir(name), "allowance.json"));
}

/**
 * All wallet names on disk: `default` (only if a root allowance.json exists)
 * plus every valid directory under `profiles/`.
 */
export function listProfileNames(): string[] {
  const names: string[] = [];
  if (existsSync(join(getConfigBaseDir(), "allowance.json"))) {
    names.push(DEFAULT_PROFILE);
  }
  try {
    for (const entry of readdirSync(getProfilesDir(), { withFileTypes: true })) {
      if (entry.isDirectory() && isValidProfileName(entry.name)) names.push(entry.name);
    }
  } catch {
    /* no profiles dir yet */
  }
  return names;
}

/** Delete a named wallet's directory. Refuses to remove the reserved default. */
export function removeProfile(name: string): void {
  if (name === DEFAULT_PROFILE) {
    throw new Error("Refusing to remove the reserved 'default' wallet");
  }
  rmSync(profileDir(name), { recursive: true, force: true });
}

/**
 * Move a wallet to a new name. Renaming `default` migrates the root-level
 * credential files into `profiles/<newName>/` (so a named wallet is always a
 * directory). Does NOT update the `active_wallet` pointer — the caller owns
 * that orchestration. Throws if the destination already exists or the source
 * is missing.
 */
export function renameProfile(oldName: string, newName: string): void {
  if (!isValidProfileName(newName)) {
    throw new Error(`Invalid wallet name ${JSON.stringify(newName)}.`);
  }
  if (newName === oldName) return;
  const dest = join(getProfilesDir(), newName);
  if (existsSync(dest)) {
    throw new Error(`A wallet named '${newName}' already exists.`);
  }
  mkdirSync(getProfilesDir(), { recursive: true });
  try {
    chmodSync(getProfilesDir(), 0o700);
  } catch {
    /* best-effort */
  }

  if (oldName === DEFAULT_PROFILE) {
    if (!profileExists(DEFAULT_PROFILE)) {
      throw new Error("No 'default' wallet to rename.");
    }
    mkdirSync(dest, { recursive: true });
    try {
      chmodSync(dest, 0o700);
    } catch {
      /* best-effort */
    }
    const base = getConfigBaseDir();
    for (const f of ["allowance.json", "projects.json", "meta.json"]) {
      const src = join(base, f);
      if (existsSync(src)) renameSync(src, join(dest, f));
    }
    return;
  }

  const src = join(getProfilesDir(), oldName);
  if (!existsSync(src)) {
    throw new Error(`Wallet '${oldName}' not found.`);
  }
  renameSync(src, dest);
}
