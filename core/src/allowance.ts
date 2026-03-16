import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { getAllowancePath } from "./config.js";

export interface AllowanceData {
  address: string;
  privateKey: string;
  created?: string;
  funded?: boolean;
  lastFaucet?: string;
}

export function readAllowance(path?: string): AllowanceData | null {
  const p = path ?? getAllowancePath();
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf-8"));
  } catch {
    return null;
  }
}

export function saveAllowance(data: AllowanceData, path?: string): void {
  const p = path ?? getAllowancePath();
  const dir = dirname(p);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.allowance.${randomBytes(4).toString("hex")}.tmp`);
  writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  renameSync(tmp, p);
  chmodSync(p, 0o600);
}
