/**
 * Run402 config loader — thin wrapper over core/ shared modules.
 * Adds CLI-specific behavior: process.exit() on errors.
 */

import {
  getApiBase,
  getApiBaseSource,
  getApiTargetKind,
  getActiveProfile,
  getConfigDir,
  getLegacyProjectsPath,
  getProfileStatePath,
  getProjectCredentialsPath,
  getAllowancePath,
  configureApiBase,
  isCoreApiTarget,
  readApiTargetConfig,
} from "../core-dist/config.js";
import { readAllowance as coreReadAllowance, saveAllowance as coreSaveAllowance } from "../core-dist/allowance.js";
import { loadKeyStore, getProject, saveProject, updateProject, removeProject, saveKeyStore, getActiveProjectId, setActiveProjectId } from "../core-dist/keystore.js";
import { getAllowanceAuthHeaders as coreGetAllowanceAuthHeaders } from "../core-dist/allowance-auth.js";
import { fail } from "./sdk-errors.mjs";
import { initializeWalletAction, selectProjectAction } from "./next-actions.mjs";

// Wallet-dependent paths are exposed as getters (preferred — they always
// reflect the active profile, even if some future code path imports this module
// before wallet resolution). Production code (init/doctor/allowance) uses these.
export function configDir() { return getConfigDir(); }
export function allowanceFile() { return getAllowancePath(); }
export function projectCredentialsFile() { return getProjectCredentialsPath(); }
export function profileStateFile() { return getProfileStatePath(); }
export function legacyProjectsFile() { return getLegacyProjectsPath(); }
export function projectsFile() { return projectCredentialsFile(); }
export function apiBase() { return getApiBase(); }
export function apiBaseSource() { return getApiBaseSource(); }
export function apiTargetKind() { return getApiTargetKind(); }
export function coreTarget() { return isCoreApiTarget(); }
export function activeProfile() { return getActiveProfile(); }

// Snapshot constants, retained for backward compatibility (tests, the OpenClaw
// config re-export). These are evaluated when this module is first imported.
// That is safe in every real flow because the CLI resolves the active wallet
// (publishing RUN402_WALLET) in cli.mjs BEFORE any subcommand imports this
// module, and tests set RUN402_CONFIG_DIR before importing. New code should
// prefer the getters above.
export const CONFIG_DIR = getConfigDir();
export const ALLOWANCE_FILE = getAllowancePath();
export const PROJECTS_FILE = getProjectCredentialsPath();
export const PROJECT_CREDENTIALS_FILE = getProjectCredentialsPath();
export const PROFILE_STATE_FILE = getProfileStatePath();

// API base is independent of the active wallet, so a module-load snapshot is safe.
export const API = getApiBase();

/**
 * Wraps core's `readAllowance()` and converts the malformed-shape throw
 * (GH-194) into the canonical CLI failure envelope. Without this guard, every
 * CLI subcommand that touches the allowance leaks a Node stack trace and
 * source paths the moment a user has a malformed `allowance.json`.
 *
 * The unparseable-JSON case still returns `null` (matching the historical
 * "no_allowance" UX); only valid-JSON-but-wrong-shape becomes a structured
 * error with `code: BAD_ALLOWANCE_FILE`.
 */
export function readAllowance() {
  try {
    return coreReadAllowance();
  } catch (err) {
    fail({
      code: "BAD_ALLOWANCE_FILE",
      message: err?.message ?? "allowance.json is malformed",
      hint: "Back up ~/.config/run402/allowance.json and run 'run402 init' to recreate it.",
      details: { path: allowanceFile() },
      next_actions: [initializeWalletAction()],
    });
  }
}

export function saveAllowance(data) {
  coreSaveAllowance(data);
}

export function allowanceAuthHeaders(path) {
  const headers = coreGetAllowanceAuthHeaders(path);
  if (!headers) {
    fail({
      code: "NO_ALLOWANCE",
      message: "No agent allowance found.",
      hint: "Run: run402 allowance create",
      next_actions: [initializeWalletAction()],
    });
  }
  return headers;
}

export function findProject(id) {
  const p = getProject(id);
  if (!p) {
    const idStr = id ?? "";
    fail({
      code: "PROJECT_CREDENTIAL_NOT_FOUND",
      message: `No local project credentials cached for ${idStr}.`,
      hint: "Use a principal-auth command, or import project keys with `run402 credentials project-keys import --project <id> --service-key-stdin`.",
      details: { project_id: idStr, source: "local_cache", cache_path: projectCredentialsFile(), wallet: activeProfile(), profile: activeProfile() },
      next_actions: [{
        type: "run_command",
        command: `run402 credentials project-keys status --project ${idStr || "<id>"}`,
        why: "Inspect the local project-key cache without revealing secrets.",
      }],
    });
  }
  return p;
}

export function resolveProject(id) {
  const projectId = id || process.env.RUN402_PROJECT_ID || getActiveProjectId();
  if (!projectId) {
    fail({
      code: "PROJECT_REQUIRED",
      message: "no project specified and no active project set.",
      hint: "Pass --project <id>, set RUN402_PROJECT_ID, or run: run402 projects use <id>",
      next_actions: [selectProjectAction()],
    });
  }
  return findProject(projectId);
}

export function resolveProjectId(id) {
  const projectId = id || process.env.RUN402_PROJECT_ID || getActiveProjectId();
  if (!projectId) {
    fail({
      code: "PROJECT_REQUIRED",
      message: "no project specified and no active project set.",
      hint: "Pass --project <id>, set RUN402_PROJECT_ID, or run: run402 projects use <id>",
      next_actions: [selectProjectAction()],
    });
  }
  return projectId;
}

// Re-export core keystore functions for direct use
export {
  configureApiBase,
  isCoreApiTarget,
  readApiTargetConfig,
  getProject,
  loadKeyStore,
  saveProject,
  updateProject,
  removeProject,
  saveKeyStore,
  getActiveProjectId,
  setActiveProjectId,
};
