import { homedir } from "node:os";
import { join } from "node:path";

export function getApiBase(): string {
  return process.env.RUN402_API_BASE || "https://api.run402.com";
}

export function getKeystorePath(): string {
  const configDir =
    process.env.RUN402_CONFIG_DIR || join(homedir(), ".config", "run402");
  return join(configDir, "projects.json");
}
