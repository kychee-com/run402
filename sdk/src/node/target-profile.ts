import {
  DEFAULT_API_BASE,
  getActiveProfile,
  getApiBase,
  getApiBaseSource,
  getApiTargetKind,
  getConfigDir,
} from "../../core-dist/config.js";
import { loadKeyStore, type StoredProject } from "../../core-dist/keystore.js";
import { LocalError } from "../errors.js";

export type Run402TargetKind = "cloud" | "core" | "unknown";
export type Run402TargetRequirement = "any" | "cloud" | "core";

export interface Run402TargetProfileEnvAliases {
  projectId?: readonly string[];
  anonKey?: readonly string[];
  serviceKey?: readonly string[];
}

export interface ResolveRun402TargetProfileOptions {
  env?: Record<string, string | undefined>;
  projectId?: string;
  anonKey?: string;
  serviceKey?: string;
  envAliases?: Run402TargetProfileEnvAliases;
  requiredTarget?: Run402TargetRequirement;
  requireProject?: boolean;
  requireAnonKey?: boolean;
  requireServiceKey?: boolean;
}

export interface Run402TargetProfileSources {
  apiBase: "env" | "profile" | "default";
  project?: string;
  anonKey?: string;
  serviceKey?: string;
}

export interface Run402TargetProfile {
  profile: string;
  configDir: string;
  apiBase: string;
  apiBaseSource: "env" | "profile" | "default";
  targetKind: Run402TargetKind;
  isCore: boolean;
  projectId?: string;
  project?: StoredProject;
  anonKey?: string;
  serviceKey?: string;
  sources: Run402TargetProfileSources;
}

const DEFAULT_ENV_ALIASES: Required<Run402TargetProfileEnvAliases> = {
  projectId: ["RUN402_PROJECT_ID"],
  anonKey: ["RUN402_ANON_KEY"],
  serviceKey: ["RUN402_SERVICE_KEY"],
};

const CONTEXT = "resolving Run402 target profile";

export function resolveRun402TargetProfile(
  options: ResolveRun402TargetProfileOptions = {},
): Run402TargetProfile {
  const env = options.env ?? process.env;
  const aliases = mergeAliases(options.envAliases);
  const store = loadKeyStore();
  const apiBase = getApiBase();
  const apiBaseSource = getApiBaseSource();
  const configuredKind = getApiTargetKind();
  const targetKind = effectiveTargetKind(apiBase, configuredKind, apiBaseSource);
  const isCore = targetKind === "core";

  const projectFromEnv = firstEnv(env, aliases.projectId);
  const projectId = firstString(options.projectId, projectFromEnv?.value, store.active_project_id);
  const project = projectId ? store.projects[projectId] : undefined;
  const anonFromEnv = firstEnv(env, aliases.anonKey);
  const serviceFromEnv = firstEnv(env, aliases.serviceKey);
  const anonKey = firstString(options.anonKey, anonFromEnv?.value, project?.anon_key);
  const serviceKey = firstString(options.serviceKey, serviceFromEnv?.value, project?.service_key);

  const requiredTarget = options.requiredTarget ?? "any";
  if (requiredTarget !== "any" && targetKind !== requiredTarget) {
    throw new LocalError(
      `Run402 target must be ${requiredTarget}, but resolved ${targetKind} (${apiBase}).`,
      CONTEXT,
      {
        code: "RUN402_TARGET_MISMATCH",
        details: { required_target: requiredTarget, target_kind: targetKind, api_base: apiBase },
      },
    );
  }
  if (options.requireProject && !projectId) {
    throw new LocalError(
      "No active Run402 project found. Run `run402 projects provision --name my-app` or set RUN402_PROJECT_ID.",
      CONTEXT,
      { code: "RUN402_TARGET_PROJECT_REQUIRED" },
    );
  }
  if (options.requireAnonKey && !anonKey) {
    throw new LocalError(
      "No Run402 anon key found. Run `run402 projects provision --name my-app`, or set RUN402_ANON_KEY.",
      CONTEXT,
      { code: "RUN402_TARGET_ANON_KEY_REQUIRED", details: { project_id: projectId ?? null } },
    );
  }
  if (options.requireServiceKey && !serviceKey) {
    throw new LocalError(
      "No Run402 service key found. Run `run402 projects provision --name my-app`, or set RUN402_SERVICE_KEY.",
      CONTEXT,
      { code: "RUN402_TARGET_SERVICE_KEY_REQUIRED", details: { project_id: projectId ?? null } },
    );
  }

  return {
    profile: getActiveProfile(),
    configDir: getConfigDir(),
    apiBase,
    apiBaseSource,
    targetKind,
    isCore,
    ...(projectId ? { projectId } : {}),
    ...(project ? { project } : {}),
    ...(anonKey ? { anonKey } : {}),
    ...(serviceKey ? { serviceKey } : {}),
    sources: {
      apiBase: apiBaseSource,
      ...(projectId
        ? { project: options.projectId ? "option:projectId" : projectFromEnv?.source ?? "profile:active_project_id" }
        : {}),
      ...(anonKey
        ? { anonKey: options.anonKey ? "option:anonKey" : anonFromEnv?.source ?? "profile:projects.json" }
        : {}),
      ...(serviceKey
        ? { serviceKey: options.serviceKey ? "option:serviceKey" : serviceFromEnv?.source ?? "profile:projects.json" }
        : {}),
    },
  };
}

function mergeAliases(
  aliases: Run402TargetProfileEnvAliases | undefined,
): Required<Run402TargetProfileEnvAliases> {
  return {
    projectId: [...(aliases?.projectId ?? []), ...DEFAULT_ENV_ALIASES.projectId],
    anonKey: [...(aliases?.anonKey ?? []), ...DEFAULT_ENV_ALIASES.anonKey],
    serviceKey: [...(aliases?.serviceKey ?? []), ...DEFAULT_ENV_ALIASES.serviceKey],
  };
}

function effectiveTargetKind(
  apiBase: string,
  configuredKind: Run402TargetKind,
  apiBaseSource: Run402TargetProfile["apiBaseSource"],
): Run402TargetKind {
  if (apiBaseSource === "env") return inferTargetKindFromApiBase(apiBase);
  if (configuredKind !== "unknown") return configuredKind;
  return inferTargetKindFromApiBase(apiBase);
}

function inferTargetKindFromApiBase(apiBase: string): Run402TargetKind {
  if (stripSlash(apiBase) === stripSlash(DEFAULT_API_BASE)) return "cloud";
  try {
    return new URL(apiBase).protocol === "http:" ? "core" : "cloud";
  } catch {
    return "unknown";
  }
}

function stripSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function firstString(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}

function firstEnv(
  env: Record<string, string | undefined>,
  names: readonly string[],
): { value: string; source: string } | null {
  for (const name of names) {
    const value = firstString(env[name]);
    if (value) return { value, source: `env:${name}` };
  }
  return null;
}
