import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, chmodSync, rmdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { getLegacyProjectsPath, getProjectCredentialsPath } from "./config.js";
import {
  clearActiveProjectId as clearProfileActiveProjectId,
  getActiveProjectId as getProfileActiveProjectId,
  recordMigration,
  setActiveProjectId as setProfileActiveProjectId,
} from "./profile-state.js";

export interface StoredProject {
  anon_key: string;
  service_key: string;
  site_url?: string;
  deployed_at?: string;
  last_deployment_id?: string;
  cached_at?: string;
  source?: string;
}

export interface KeyStore {
  version?: 1;
  source?: "local_cache";
  active_project_id?: string;
  previous_active_project_id?: string;
  projects: Record<string, StoredProject>;
  migrated_from?: string;
  migrated_at?: string;
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

function normalizeParsedKeyStore(parsed: unknown): KeyStore {
  if (Array.isArray(parsed)) {
    const projects: Record<string, StoredProject> = {};
    for (const item of parsed) {
      if (item.project_id) {
        projects[item.project_id] = {
          anon_key: item.anon_key,
          service_key: item.service_key,
          ...(item.site_url && { site_url: item.site_url }),
          ...(item.deployed_at && { deployed_at: item.deployed_at }),
          cached_at: new Date().toISOString(),
          source: "legacy_projects_json",
        };
      }
    }
    return { version: 1, source: "local_cache", projects };
  }

  if (parsed && typeof parsed === "object" && "projects" in parsed) {
    const obj = parsed as Record<string, unknown>;
    const rawProjects =
      obj.projects && typeof obj.projects === "object" && !Array.isArray(obj.projects)
        ? (obj.projects as Record<string, StoredProject>)
        : {};
    const projects: Record<string, StoredProject> = {};
    for (const [id, proj] of Object.entries(rawProjects)) {
      const rec = { ...(proj as unknown as Record<string, unknown>) };
      delete rec.tier;
      delete rec.lease_expires_at;
      delete rec.expires_at;
      projects[id] = rec as unknown as StoredProject;
    }
    return {
      version: 1,
      source: "local_cache",
      ...(typeof obj.active_project_id === "string" && { active_project_id: obj.active_project_id }),
      ...(typeof obj.previous_active_project_id === "string" && { previous_active_project_id: obj.previous_active_project_id }),
      projects,
      ...(typeof obj.migrated_from === "string" && { migrated_from: obj.migrated_from }),
      ...(typeof obj.migrated_at === "string" && { migrated_at: obj.migrated_at }),
    };
  }

  return { version: 1, source: "local_cache", projects: {} };
}

function loadParsedKeyStore(path: string): KeyStore {
  try {
    return normalizeParsedKeyStore(JSON.parse(readFileSync(path, "utf-8")));
  } catch {
    return { version: 1, source: "local_cache", projects: {} };
  }
}

function migrateLegacyProjectsJson(targetPath: string): void {
  const legacyPath = getLegacyProjectsPath();
  if (existsSync(targetPath) || !existsSync(legacyPath)) return;

  const legacy = loadParsedKeyStore(legacyPath);
  const migratedAt = new Date().toISOString();
  const cache: KeyStore = {
    version: 1,
    source: "local_cache",
    projects: legacy.projects,
    migrated_from: legacyPath,
    migrated_at: migratedAt,
  };
  saveKeyStore(cache, targetPath);
  if (legacy.active_project_id) {
    setProfileActiveProjectId(legacy.active_project_id);
  }
  recordMigration("projects_json_import", {
    legacy_path: legacyPath,
    cache_path: targetPath,
    project_count: Object.keys(legacy.projects).length,
    imported_at: migratedAt,
  });
}

/**
 * Load the project-key credential cache from disk.
 * Auto-imports legacy `projects.json` formats into the new cache path when using
 * the default location:
 * - Array format (CLI legacy): [{project_id, ...}] → {projects: {id: {...}}}
 * - Object format: {active_project_id, projects} → credentials cache + state.json
 * - Old metadata fields: tier/expires_at/lease_expires_at are stripped
 */
export function loadKeyStore(path?: string): KeyStore {
  const p = path ?? getProjectCredentialsPath();
  if (!path) migrateLegacyProjectsJson(p);
  return loadParsedKeyStore(p);
}

export function saveKeyStore(store: KeyStore, path?: string): void {
  const p = path ?? getProjectCredentialsPath();
  const dir = dirname(p);
  mkdirSync(dir, { recursive: true });

  const cache = {
    version: 1,
    source: "local_cache",
    ...(store.migrated_from ? { migrated_from: store.migrated_from } : {}),
    ...(store.migrated_at ? { migrated_at: store.migrated_at } : {}),
    projects: store.projects,
  };
  const tmp = join(dir, `.project-keys.${randomBytes(4).toString("hex")}.tmp`);
  writeFileSync(tmp, JSON.stringify(cache, null, 2), { mode: 0o600 });
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
  const p = path ?? getProjectCredentialsPath();
  withFileLock(p, () => {
    const store = loadKeyStore(p);
    store.projects[projectId] = { ...project, cached_at: project.cached_at ?? new Date().toISOString() };
    saveKeyStore(store, p);
  });
}

export function updateProject(
  projectId: string,
  update: Partial<StoredProject>,
  path?: string,
): void {
  const p = path ?? getProjectCredentialsPath();
  withFileLock(p, () => {
    const store = loadKeyStore(p);
    const existing = store.projects[projectId];
    if (existing) {
      store.projects[projectId] = { ...existing, ...update, cached_at: existing.cached_at ?? new Date().toISOString() };
      saveKeyStore(store, p);
    }
  });
}

export function removeProject(
  projectId: string,
  path?: string,
): void {
  const p = path ?? getProjectCredentialsPath();
  withFileLock(p, () => {
    const store = loadKeyStore(p);
    delete store.projects[projectId];
    saveKeyStore(store, p);
  });
  if (!path) clearProfileActiveProjectId(projectId);
}

export function getActiveProjectId(path?: string): string | undefined {
  return getProfileActiveProjectId(path);
}

export function setActiveProjectId(
  projectId: string,
  path?: string,
): void {
  setProfileActiveProjectId(projectId, path);
}
