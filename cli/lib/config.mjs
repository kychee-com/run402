/**
 * Run402 config loader — thin wrapper over core/ shared modules.
 * Adds CLI-specific behavior: process.exit() on errors.
 */

import { getApiBase, getConfigDir, getKeystorePath, getAllowancePath } from "../core-dist/config.js";
import { readAllowance as coreReadAllowance, saveAllowance as coreSaveAllowance } from "../core-dist/allowance.js";
import { loadKeyStore, getProject, saveProject, updateProject, removeProject, saveKeyStore, getActiveProjectId, setActiveProjectId } from "../core-dist/keystore.js";
import { getAllowanceAuthHeaders as coreGetAllowanceAuthHeaders } from "../core-dist/allowance-auth.js";
import { fail } from "./sdk-errors.mjs";
import { initializeWalletAction, createProjectAction } from "./next-actions.mjs";

// Wallet-dependent paths are exposed as getters (preferred — they always
// reflect the active profile, even if some future code path imports this module
// before wallet resolution). Production code (init/doctor/allowance) uses these.
export function configDir() { return getConfigDir(); }
export function allowanceFile() { return getAllowancePath(); }
export function projectsFile() { return getKeystorePath(); }

// Snapshot constants, retained for backward compatibility (tests, the OpenClaw
// config re-export). These are evaluated when this module is first imported.
// That is safe in every real flow because the CLI resolves the active wallet
// (publishing RUN402_WALLET) in cli.mjs BEFORE any subcommand imports this
// module, and tests set RUN402_CONFIG_DIR before importing. New code should
// prefer the getters above.
export const CONFIG_DIR = getConfigDir();
export const ALLOWANCE_FILE = getAllowancePath();
export const PROJECTS_FILE = getKeystorePath();

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
    const hint = idStr && !String(idStr).startsWith("prj_")
      ? `project IDs start with "prj_". Check that the argument order is <project_id> <name>.`
      : undefined;
    fail({
      code: "PROJECT_NOT_FOUND",
      message: `Project ${idStr} not found in local registry.`,
      hint,
      details: { project_id: idStr, source: "local_registry" },
      next_actions: [createProjectAction()],
    });
  }
  return p;
}

export function resolveProject(id) {
  const projectId = id || getActiveProjectId();
  if (!projectId) {
    fail({
      code: "NO_ACTIVE_PROJECT",
      message: "no project specified and no active project set.",
      hint: "Run: run402 projects provision",
      next_actions: [createProjectAction()],
    });
  }
  return findProject(projectId);
}

export function resolveProjectId(id) {
  const projectId = id || getActiveProjectId();
  if (!projectId) {
    fail({
      code: "NO_ACTIVE_PROJECT",
      message: "no project specified and no active project set.",
      hint: "Run: run402 projects provision",
      next_actions: [createProjectAction()],
    });
  }
  return projectId;
}

// Re-export core keystore functions for direct use
export { loadKeyStore, saveProject, updateProject, removeProject, saveKeyStore, getActiveProjectId, setActiveProjectId };
