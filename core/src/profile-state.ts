import { readFileSync, writeFileSync, mkdirSync, renameSync, chmodSync, rmdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { getActiveProfile, getApiBase, getProfileStatePath } from "./config.js";

export interface ActiveProjectScope {
  api_base?: string;
  principal?: string | null;
  profile?: string;
}

export interface ActiveProjectState {
  project_id: string;
  previous_project_id?: string;
  api_base: string;
  principal?: string | null;
  profile: string;
  updated_at: string;
}

export interface ProfileState {
  version?: 1;
  active_project_id?: string;
  previous_active_project_id?: string;
  active_projects?: Record<string, ActiveProjectState>;
  migrations?: Record<string, unknown>;
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
  throw new Error(`Could not acquire profile-state lock after ${retries} retries: ${lockDir}`);
}

export function loadProfileState(path?: string): ProfileState {
  const p = path ?? getProfileStatePath();
  try {
    const parsed = JSON.parse(readFileSync(p, "utf-8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as ProfileState;
  } catch {
    return {};
  }
}

export function saveProfileState(state: ProfileState, path?: string): void {
  const p = path ?? getProfileStatePath();
  const dir = dirname(p);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.state.${randomBytes(4).toString("hex")}.tmp`);
  writeFileSync(tmp, JSON.stringify({ version: 1, ...state }, null, 2), { mode: 0o600 });
  renameSync(tmp, p);
  chmodSync(p, 0o600);
}

export function defaultActiveProjectScope(scope: ActiveProjectScope = {}): Required<Pick<ActiveProjectScope, "api_base" | "profile">> & Pick<ActiveProjectScope, "principal"> {
  return {
    api_base: scope.api_base ?? getApiBase(),
    profile: scope.profile ?? getActiveProfile(),
    principal: scope.principal ?? null,
  };
}

export function activeProjectScopeKey(scope: ActiveProjectScope = {}): string {
  const resolved = defaultActiveProjectScope(scope);
  return JSON.stringify({
    api_base: resolved.api_base,
    profile: resolved.profile,
    principal: resolved.principal ?? "unknown",
  });
}

export function getActiveProjectId(path?: string, scope: ActiveProjectScope = {}): string | undefined {
  const state = loadProfileState(path);
  const key = activeProjectScopeKey(scope);
  return state.active_projects?.[key]?.project_id ?? state.active_project_id;
}

export function setActiveProjectId(projectId: string, path?: string, scope: ActiveProjectScope = {}): void {
  const p = path ?? getProfileStatePath();
  withFileLock(p, () => {
    const state = loadProfileState(p);
    const key = activeProjectScopeKey(scope);
    const resolved = defaultActiveProjectScope(scope);
    const current = state.active_projects?.[key]?.project_id ?? state.active_project_id;
    const previous = current && current !== projectId ? current : undefined;
    state.active_projects = state.active_projects ?? {};
    state.active_projects[key] = {
      project_id: projectId,
      ...(previous ? { previous_project_id: previous } : {}),
      api_base: resolved.api_base,
      principal: resolved.principal ?? null,
      profile: resolved.profile,
      updated_at: new Date().toISOString(),
    };
    state.active_project_id = projectId;
    if (previous) state.previous_active_project_id = previous;
    else delete state.previous_active_project_id;
    saveProfileState(state, p);
  });
}

export function clearActiveProjectId(projectId: string, path?: string, scope: ActiveProjectScope = {}): void {
  const p = path ?? getProfileStatePath();
  withFileLock(p, () => {
    const state = loadProfileState(p);
    const key = activeProjectScopeKey(scope);
    const scoped = state.active_projects?.[key];
    if (scoped?.project_id === projectId && state.active_projects) {
      if (scoped.previous_project_id) {
        state.active_projects[key] = {
          ...scoped,
          project_id: scoped.previous_project_id,
          previous_project_id: undefined,
          updated_at: new Date().toISOString(),
        };
      } else {
        delete state.active_projects[key];
      }
    }
    if (state.active_project_id === projectId) {
      if (state.previous_active_project_id && state.previous_active_project_id !== projectId) {
        state.active_project_id = state.previous_active_project_id;
      } else {
        delete state.active_project_id;
      }
      delete state.previous_active_project_id;
    }
    saveProfileState(state, p);
  });
}

export function recordMigration(marker: string, value: unknown, path?: string): void {
  const p = path ?? getProfileStatePath();
  withFileLock(p, () => {
    const state = loadProfileState(p);
    state.migrations = { ...(state.migrations ?? {}), [marker]: value };
    saveProfileState(state, p);
  });
}
