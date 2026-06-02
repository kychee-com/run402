import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, renameSync, mkdirSync, chmodSync } from "node:fs";

const DEFAULT_API_BASE = "https://api.run402.com";

/**
 * Validate a user-supplied API base URL. Throws a clear error message that
 * names the env var when the URL is malformed or uses a scheme other than
 * http(s). Empty string is treated as "set but empty" (almost always a
 * templating mishap) and emits a stderr warning before falling back to
 * `fallback`.
 *
 * Returns the validated URL string (unchanged) or `null` if the env var was
 * unset.
 */
function validateApiBase(envVar: string, raw: string | undefined, fallback: string): string | null {
  if (raw == null) return null;
  if (raw === "") {
    process.stderr.write(
      `warning: ${envVar} is set but empty - using default. Unset the env var to suppress this warning.\n`,
    );
    return fallback;
  }
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(
      `${envVar} is not a valid URL: ${JSON.stringify(raw)}. Expected an http(s) URL like https://api.run402.com.`,
    );
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") {
    throw new Error(
      `${envVar} must use http(s):, got ${u.protocol} (full value: ${JSON.stringify(raw)}).`,
    );
  }
  return raw;
}

export function getApiBase(): string {
  const validated = validateApiBase("RUN402_API_BASE", process.env.RUN402_API_BASE, DEFAULT_API_BASE);
  return validated ?? DEFAULT_API_BASE;
}

/**
 * API base for the deploy-v2 routes. Defaults to the same value as
 * `getApiBase()`. Set `RUN402_DEPLOY_API_BASE` to point only deploy traffic
 * elsewhere — useful when running deploy-v2 against a staging gateway while
 * the rest of the SDK still talks to production. In normal use callers
 * should not need this override.
 */
export function getDeployApiBase(): string {
  const fallback = getApiBase();
  const validated = validateApiBase("RUN402_DEPLOY_API_BASE", process.env.RUN402_DEPLOY_API_BASE, fallback);
  return validated ?? fallback;
}

/**
 * The base credential directory — the root under which the `default` wallet
 * lives directly and named wallets live under `profiles/<name>/`. This is the
 * value `RUN402_CONFIG_DIR` overrides; profiles nest *within* it.
 */
export function getConfigBaseDir(): string {
  return process.env.RUN402_CONFIG_DIR || join(homedir(), ".config", "run402");
}

export const DEFAULT_PROFILE = "default";

// Filesystem-safe wallet/profile name. Lowercase only (avoids collisions on
// case-insensitive filesystems like macOS), starts alphanumeric, then
// alphanumeric/underscore/hyphen, max 64 chars. The CLI edge enforces this for
// nice UX; core re-checks it as a defense-in-depth guard so a hostile
// `RUN402_WALLET`/`RUN402_PROFILE` cannot traverse outside the profiles dir.
const PROFILE_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export function isValidProfileName(name: string): boolean {
  return PROFILE_NAME_RE.test(name);
}

/**
 * Guard against path traversal from the profile env vars. The reserved
 * `default` profile is always allowed (it maps to the base dir). Any other
 * name must pass the filesystem-safe pattern; otherwise we throw rather than
 * silently resolve a surprising path.
 */
function assertSafeProfileName(name: string): void {
  if (name === DEFAULT_PROFILE) return;
  if (!isValidProfileName(name)) {
    throw new Error(
      `Invalid wallet/profile name ${JSON.stringify(name)}. ` +
        "Names must match /^[a-z0-9][a-z0-9_-]{0,63}$/ (lowercase letters, digits, '_' and '-'). " +
        "Check the RUN402_WALLET / RUN402_PROFILE env var.",
    );
  }
}

/**
 * The active wallet/profile name from the environment. `RUN402_WALLET` is
 * canonical; `RUN402_PROFILE` is accepted as an alias. Empty/unset → the
 * reserved `default`. The CLI edge resolves the `--wallet` flag and any
 * per-directory `.run402.json` binding into `RUN402_WALLET` *before* dispatch,
 * so core stays env-only and never reads argv or cwd.
 */
export function getActiveProfile(): string {
  const raw = process.env.RUN402_WALLET ?? process.env.RUN402_PROFILE;
  const name = raw == null ? "" : raw.trim();
  if (!name) return DEFAULT_PROFILE;
  assertSafeProfileName(name);
  return name;
}

/** Directory holding all named wallets: `{base}/profiles`. */
export function getProfilesDir(): string {
  return join(getConfigBaseDir(), "profiles");
}

/**
 * The effective config directory for the *active* wallet. The `default` wallet
 * resolves to the base dir (zero migration for existing single-wallet
 * installs); any named wallet resolves to `{base}/profiles/<name>`. Because
 * keystore, allowance, and meta paths all derive from this, switching the
 * profile env var moves the whole wallet bundle atomically — and the SDK/MCP
 * inherit profile selection for free.
 */
export function getConfigDir(): string {
  const base = getConfigBaseDir();
  const profile = getActiveProfile();
  return profile === DEFAULT_PROFILE ? base : join(base, "profiles", profile);
}

export function getKeystorePath(): string {
  return join(getConfigDir(), "projects.json");
}

export function getAllowancePath(): string {
  if (process.env.RUN402_ALLOWANCE_PATH) return process.env.RUN402_ALLOWANCE_PATH;
  const dir = getConfigDir();
  const newPath = join(dir, "allowance.json");
  const oldPath = join(dir, "wallet.json");
  // Auto-migrate from wallet.json → allowance.json. renameSync preserves the
  // source file's mode, so a legacy world-readable wallet.json (mode 0644)
  // would otherwise carry that mode forward and leave the private key
  // world-readable on a shared machine. Tighten to 0600 after the rename.
  if (!existsSync(newPath) && existsSync(oldPath)) {
    mkdirSync(dir, { recursive: true });
    renameSync(oldPath, newPath);
    try {
      chmodSync(newPath, 0o600);
    } catch {
      // Best-effort (e.g. Windows / exotic filesystems). Read-time self-heal
      // in readAllowance() is the backstop.
    }
  }
  return newPath;
}
