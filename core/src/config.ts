import { homedir } from "node:os";
import { join } from "node:path";

export function getApiBase(): string {
  return process.env.RUN402_API_BASE || "https://api.run402.com";
}

export function getConfigDir(): string {
  return process.env.RUN402_CONFIG_DIR || join(homedir(), ".config", "run402");
}

export function getKeystorePath(): string {
  return join(getConfigDir(), "projects.json");
}

export function getWalletPath(): string {
  return join(getConfigDir(), "wallet.json");
}
