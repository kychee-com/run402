import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, renameSync, mkdirSync } from "node:fs";

export function getApiBase(): string {
  return process.env.RUN402_API_BASE || "https://api.run402.com";
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
