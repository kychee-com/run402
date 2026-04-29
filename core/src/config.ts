import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, renameSync, mkdirSync } from "node:fs";

export function getApiBase(): string {
  return process.env.RUN402_API_BASE || "https://api.run402.com";
}

/**
 * API base for the deploy-v2 routes. Defaults to the same value as
 * `getApiBase()`. Set `RUN402_DEPLOY_API_BASE` to point only deploy traffic
 * elsewhere — useful when running deploy-v2 against a staging gateway while
 * the rest of the SDK still talks to production. In normal use callers
 * should not need this override.
 */
export function getDeployApiBase(): string {
  return process.env.RUN402_DEPLOY_API_BASE || getApiBase();
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
