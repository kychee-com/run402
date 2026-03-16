/**
 * Run402 config loader — thin wrapper over core/ shared modules.
 * Adds CLI-specific behavior: process.exit() on errors.
 */

import { getApiBase, getConfigDir, getKeystorePath, getWalletPath } from "../../core/dist/config.js";
import { readWallet as coreReadWallet, saveWallet as coreSaveWallet } from "../../core/dist/wallet.js";
import { getWalletAuthHeaders } from "../../core/dist/wallet-auth.js";
import { loadKeyStore, getProject, saveProject, removeProject, saveKeyStore } from "../../core/dist/keystore.js";

export const CONFIG_DIR = getConfigDir();
export const WALLET_FILE = getWalletPath();
export const PROJECTS_FILE = getKeystorePath();
export const API = getApiBase();

export function readWallet() {
  return coreReadWallet();
}

export function saveWallet(data) {
  coreSaveWallet(data);
}

export async function walletAuthHeaders() {
  const headers = getWalletAuthHeaders();
  if (!headers) { console.error(JSON.stringify({ status: "error", message: "No wallet found. Run: run402 wallet create" })); process.exit(1); }
  return headers;
}

export function findProject(id) {
  const p = getProject(id);
  if (!p) { console.error(`Project ${id} not found in local registry.`); process.exit(1); }
  return p;
}

// Re-export core keystore functions for direct use
export { loadKeyStore, saveProject, removeProject, saveKeyStore };
