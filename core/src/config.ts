import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, renameSync, mkdirSync } from "node:fs";

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

export function getConfigDir(): string {
  return process.env.RUN402_CONFIG_DIR || join(homedir(), ".config", "run402");
}

export function getKeystorePath(): string {
  return join(getConfigDir(), "projects.json");
}

export function getAllowancePath(): string {
  if (process.env.RUN402_ALLOWANCE_PATH) return process.env.RUN402_ALLOWANCE_PATH;
  const dir = getConfigDir();
  const newPath = join(dir, "allowance.json");
  const oldPath = join(dir, "wallet.json");
  // Auto-migrate from wallet.json → allowance.json
  if (!existsSync(newPath) && existsSync(oldPath)) {
    mkdirSync(dir, { recursive: true });
    renameSync(oldPath, newPath);
  }
  return newPath;
}
