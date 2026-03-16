import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { getWalletPath } from "./config.js";

export interface WalletData {
  address: string;
  privateKey: string;
  created?: string;
  funded?: boolean;
  lastFaucet?: string;
}

export function readWallet(path?: string): WalletData | null {
  const p = path ?? getWalletPath();
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf-8"));
  } catch {
    return null;
  }
}

export function saveWallet(data: WalletData, path?: string): void {
  const p = path ?? getWalletPath();
  const dir = dirname(p);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.wallet.${randomBytes(4).toString("hex")}.tmp`);
  writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  renameSync(tmp, p);
  chmodSync(p, 0o600);
}
