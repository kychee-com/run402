import { readFileSync, writeFileSync, mkdirSync, renameSync, chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { getKeystorePath } from "./config.js";

export interface StoredProject {
  anon_key: string;
  service_key: string;
  tier: string;
  expires_at: string;
}

export interface KeyStore {
  projects: Record<string, StoredProject>;
}

export function loadKeyStore(path?: string): KeyStore {
  const p = path ?? getKeystorePath();
  try {
    const data = readFileSync(p, "utf-8");
    const parsed = JSON.parse(data);
    if (parsed && typeof parsed === "object" && parsed.projects) {
      return parsed as KeyStore;
    }
    return { projects: {} };
  } catch {
    return { projects: {} };
  }
}

export function saveKeyStore(store: KeyStore, path?: string): void {
  const p = path ?? getKeystorePath();
  const dir = dirname(p);
  mkdirSync(dir, { recursive: true });

  const tmp = join(dir, `.projects.${randomBytes(4).toString("hex")}.tmp`);
  writeFileSync(tmp, JSON.stringify(store, null, 2), { mode: 0o600 });
  renameSync(tmp, p);
  chmodSync(p, 0o600);
}

export function getProject(
  projectId: string,
  path?: string,
): StoredProject | undefined {
  const store = loadKeyStore(path);
  return store.projects[projectId];
}

export function saveProject(
  projectId: string,
  project: StoredProject,
  path?: string,
): void {
  const p = path ?? getKeystorePath();
  const store = loadKeyStore(p);
  store.projects[projectId] = project;
  saveKeyStore(store, p);
}
