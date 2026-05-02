/**
 * Run402 config loader — thin wrapper over core/ shared modules.
 * Adds CLI-specific behavior: process.exit() on errors.
 */

import { getApiBase, getConfigDir, getKeystorePath, getAllowancePath } from "../core-dist/config.js";
import { readAllowance as coreReadAllowance, saveAllowance as coreSaveAllowance } from "../core-dist/allowance.js";
import { loadKeyStore, getProject, saveProject, updateProject, removeProject, saveKeyStore, getActiveProjectId, setActiveProjectId } from "../core-dist/keystore.js";
import { getAllowanceAuthHeaders as coreGetAllowanceAuthHeaders } from "../core-dist/allowance-auth.js";
import { fail } from "./sdk-errors.mjs";

export const CONFIG_DIR = getConfigDir();
export const ALLOWANCE_FILE = getAllowancePath();
export const PROJECTS_FILE = getKeystorePath();
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
      details: { path: ALLOWANCE_FILE },
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
    });
  }
  return projectId;
}

// Re-export core keystore functions for direct use
export { loadKeyStore, saveProject, updateProject, removeProject, saveKeyStore, getActiveProjectId, setActiveProjectId };
