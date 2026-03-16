/**
 * Run402 config loader — thin wrapper over core/ shared modules.
 * Adds CLI-specific behavior: process.exit() on errors.
 */

import { getApiBase, getConfigDir, getKeystorePath, getAllowancePath } from "../../core/dist/config.js";
import { readAllowance as coreReadAllowance, saveAllowance as coreSaveAllowance } from "../../core/dist/allowance.js";
import { getAllowanceAuthHeaders } from "../../core/dist/allowance-auth.js";
import { loadKeyStore, getProject, saveProject, removeProject, saveKeyStore } from "../../core/dist/keystore.js";

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

export async function allowanceAuthHeaders() {
  const headers = getAllowanceAuthHeaders();
  if (!headers) { console.error(JSON.stringify({ status: "error", message: "No agent allowance found. Run: run402 allowance create" })); process.exit(1); }
  return headers;
}

export function findProject(id) {
  const p = getProject(id);
  if (!p) { console.error(`Project ${id} not found in local registry.`); process.exit(1); }
  return p;
}

// Re-export core keystore functions for direct use
export { loadKeyStore, saveProject, removeProject, saveKeyStore };
