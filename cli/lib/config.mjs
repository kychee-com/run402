/**
 * Run402 config loader — thin wrapper over core/ shared modules.
 * Adds CLI-specific behavior: process.exit() on errors.
 */

import { getApiBase, getConfigDir, getKeystorePath, getAllowancePath } from "../core-dist/config.js";
import { readAllowance as coreReadAllowance, saveAllowance as coreSaveAllowance } from "../core-dist/allowance.js";
import { loadKeyStore, getProject, saveProject, updateProject, removeProject, saveKeyStore, getActiveProjectId, setActiveProjectId } from "../core-dist/keystore.js";
import { getAllowanceAuthHeaders as coreGetAllowanceAuthHeaders } from "../core-dist/allowance-auth.js";

export const CONFIG_DIR = getConfigDir();
export const ALLOWANCE_FILE = getAllowancePath();
export const PROJECTS_FILE = getKeystorePath();
export const API = getApiBase();

export function readAllowance() {
  return coreReadAllowance();
}

export function saveAllowance(data) {
  coreSaveAllowance(data);
}

export function allowanceAuthHeaders(path) {
  const headers = coreGetAllowanceAuthHeaders(path);
  if (!headers) { console.error(JSON.stringify({ status: "error", message: "No agent allowance found. Run: run402 allowance create" })); process.exit(1); }
  return headers;
}

export function findProject(id) {
  const p = getProject(id);
  if (!p) {
    const hint = id && !id.startsWith("prj_")
      ? ` Hint: project IDs start with "prj_". Check that the argument order is <project_id> <name>.`
      : "";
    console.error(`Project ${id} not found in local registry.${hint}`);
    process.exit(1);
  }
  return p;
}

export function resolveProject(id) {
  const projectId = id || getActiveProjectId();
  if (!projectId) { console.error("Error: no project specified and no active project set. Run: run402 projects provision"); process.exit(1); }
  return findProject(projectId);
}

export function resolveProjectId(id) {
  const projectId = id || getActiveProjectId();
  if (!projectId) { console.error("Error: no project specified and no active project set. Run: run402 projects provision"); process.exit(1); }
  return projectId;
}

// Re-export core keystore functions for direct use
export { loadKeyStore, saveProject, updateProject, removeProject, saveKeyStore, getActiveProjectId, setActiveProjectId };
