import { readFileSync, writeFileSync, mkdirSync, renameSync, chmodSync, rmdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { getKeystorePath } from "./config.js";

export interface StoredProject {
  anon_key: string;
  service_key: string;
  site_url?: string;
  deployed_at?: string;
  last_deployment_id?: string;
}

export interface KeyStore {
  active_project_id?: string;
  previous_active_project_id?: string;
  projects: Record<string, StoredProject>;
}

function withFileLock<T>(
  path: string,
  fn: () => T,
  { retries = 200, delayMs = 20 }: { retries?: number; delayMs?: number } = {},
): T {
  const lockDir = path + ".lock";
  mkdirSync(dirname(path), { recursive: true });
  for (let i = 0; i < retries; i++) {
    try {
      mkdirSync(lockDir, { mode: 0o700 });
    } catch (e: unknown) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw e;
      const until = Date.now() + delayMs;
      while (Date.now() < until) { /* spin */ }
      continue;
    }
    try {
      return fn();
    } finally {
      try { rmdirSync(lockDir); } catch { /* best-effort */ }
    }
  }
  throw new Error(`Could not acquire keystore lock after ${retries} retries: ${lockDir}`);
}

/**
 * Load the keystore from disk.
 * Auto-migrates legacy formats:
 * - Array format (CLI legacy): [{project_id, ...}] → {projects: {id: {...}}}
 * - Old field name: expires_at → lease_expires_at
 */
export function loadKeyStore(path?: string): KeyStore {
  const p = path ?? getKeystorePath();
  try {
    const data = readFileSync(p, "utf-8");
    const parsed = JSON.parse(data);

    if (Array.isArray(parsed)) {
      const projects: Record<string, StoredProject> = {};
      for (const item of parsed) {
        if (item.project_id) {
          projects[item.project_id] = {
            anon_key: item.anon_key,
            service_key: item.service_key,
            ...(item.site_url && { site_url: item.site_url }),
            ...(item.deployed_at && { deployed_at: item.deployed_at }),
          };
        }
      }
      return { projects };
    }

    if (parsed && typeof parsed === "object" && parsed.projects) {
      for (const proj of Object.values(parsed.projects)) {
        const rec = proj as Record<string, unknown>;
        delete rec.tier;
        delete rec.lease_expires_at;
        delete rec.expires_at;
      }
      return {
        ...(parsed.active_project_id && { active_project_id: parsed.active_project_id }),
        ...(parsed.previous_active_project_id && { previous_active_project_id: parsed.previous_active_project_id }),
        projects: parsed.projects,
      } as KeyStore;
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
  withFileLock(p, () => {
    const store = loadKeyStore(p);
    store.projects[projectId] = project;
    saveKeyStore(store, p);
  });
}

export function updateProject(
  projectId: string,
  update: Partial<StoredProject>,
  path?: string,
): void {
  const p = path ?? getKeystorePath();
  withFileLock(p, () => {
    const store = loadKeyStore(p);
    const existing = store.projects[projectId];
    if (existing) {
      store.projects[projectId] = { ...existing, ...update };
      saveKeyStore(store, p);
    }
  });
}

export function removeProject(
  projectId: string,
  path?: string,
): void {
  const p = path ?? getKeystorePath();
  withFileLock(p, () => {
    const store = loadKeyStore(p);
    delete store.projects[projectId];
    if (store.active_project_id === projectId) {
      const fallback = store.previous_active_project_id;
      if (fallback && fallback !== projectId && store.projects[fallback]) {
        store.active_project_id = fallback;
      } else {
        delete store.active_project_id;
      }
      delete store.previous_active_project_id;
    }
    saveKeyStore(store, p);
  });
}

export function getActiveProjectId(path?: string): string | undefined {
  const store = loadKeyStore(path);
  return store.active_project_id;
}

export function setActiveProjectId(
  projectId: string,
  path?: string,
): void {
  const p = path ?? getKeystorePath();
  withFileLock(p, () => {
    const store = loadKeyStore(p);
    if (store.active_project_id && store.active_project_id !== projectId) {
      store.previous_active_project_id = store.active_project_id;
    }
    store.active_project_id = projectId;
    saveKeyStore(store, p);
  });
}
