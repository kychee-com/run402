/**
 * Node credential provider — wraps the local project-key cache + allowance-auth.
 * Reads `credentials/project-keys.v1.json` (or an explicit `keystorePath`),
 * signs SIWX headers from the allowance private key, and serves project
 * anon/service keys from disk only for operations classified as credential-
 * required.
 */

import { randomBytes, createECDH } from "node:crypto";
import { keccak_256 } from "@noble/hashes/sha3.js";
import {
  getProject as coreGetProject,
  loadKeyStore as coreLoadKeyStore,
  saveProject as coreSaveProject,
  updateProject as coreUpdateProject,
  removeProject as coreRemoveProject,
} from "../../core-dist/keystore.js";
import {
  getActiveProjectId,
  setActiveProjectId,
} from "../../core-dist/profile-state.js";
import { getAllowanceAuthHeaders } from "../../core-dist/allowance-auth.js";
import { readAllowance as coreReadAllowance, saveAllowance as coreSaveAllowance } from "../../core-dist/allowance.js";
import {
  getAllowancePath as coreGetAllowancePath,
  getActiveProfile,
  getApiBase,
  getProfileStatePath as coreGetProfileStatePath,
  getProjectCredentialsPath as coreGetProjectCredentialsPath,
} from "../../core-dist/config.js";
import { readMeta } from "../../core-dist/profiles.js";
import { loadLiveControlPlaneSession } from "../../core-dist/control-plane-session.js";
import { loadLiveApproval, hashControlPlaneSession } from "../../core-dist/write-auth-session.js";
import type { AllowanceData, AuthRequestMeta, CredentialsProvider, ProjectKeys, WalletIdentity } from "../credentials.js";

/** Where credential resolution runs — selects the default `authMode`. */
export type CredentialSurface = "cli" | "mcp" | "sdk";
/** How a request's credentials are chosen. `auto` = wallet, else operator (control-plane) session. */
export type AuthMode = "auto" | "wallet" | "operator" | "none";

export interface NodeCredentialsOptions {
  allowancePath?: string;
  /** Local project-key credential cache path. Defaults to credentials/project-keys.v1.json. */
  keystorePath?: string;
  /** Non-secret profile state path for active project pointers. Defaults to state.json. */
  profileStatePath?: string;
  /** Default is `wallet` (no ambient operator authority); `cli` opts into `auto`. */
  surface?: CredentialSurface;
  /** Explicit override; otherwise derived from `surface`. */
  authMode?: AuthMode;
}

export class NodeCredentialsProvider implements CredentialsProvider {
  constructor(private readonly options: NodeCredentialsOptions = {}) {}

  /** Effective credential mode. Explicit `authMode` wins; else `cli → auto`, everything else → `wallet`. */
  private resolveAuthMode(): AuthMode {
    return this.options.authMode ?? (this.options.surface === "cli" ? "auto" : "wallet");
  }

  /**
   * Deterministic credential resolution — selects exactly one credential class
   * and never silently falls back to another after a failure.
   *
   * - `wallet` (default; the MCP/agent path): only the SIWX allowance. NEVER
   *   reads the control-plane session or operator-approval caches, so a human's
   *   ambient authority cannot leak into an agent tool call.
   * - `auto` (CLI): SIWX allowance if present; otherwise the live control-plane
   *   session, plus an `X-Run402-Write-Auth` approval ONLY when the request's
   *   `(capability, target)` exactly matches a cached, origin/session-bound
   *   approval. A gated write with no match is sent cp-bearer-only and fails
   *   closed with `WRITE_AUTH_REQUIRED`.
   */
  async getAuth(path: string, metadata?: AuthRequestMeta): Promise<Record<string, string> | null> {
    const mode = this.resolveAuthMode();
    if (mode === "none") return null;

    const wallet = getAllowanceAuthHeaders(path, this.options.allowancePath);
    if (mode === "wallet") return wallet ? { ...wallet } : null;
    if (mode === "auto" && wallet) return { ...wallet };

    // operator mode, or auto with no wallet: the control-plane session principal.
    const cp = loadLiveControlPlaneSession();
    if (!cp) return wallet ? { ...wallet } : null;

    const headers: Record<string, string> = {
      Authorization: `Bearer ${cp.control_plane_session_token}`,
    };
    // Capability+target-matched approval attachment (never blanket).
    if (metadata?.capability && metadata.target) {
      const approval = loadLiveApproval({
        apiOrigin: this.apiOrigin(),
        cpSessionHash: hashControlPlaneSession(cp.control_plane_session_token),
        capability: metadata.capability,
        target: metadata.target,
      });
      if (approval) headers["X-Run402-Write-Auth"] = `Bearer ${approval.write_auth_token}`;
    }
    return headers;
  }

  /** API origin used to bind/look-up approvals (matches the ceremony's mint origin). */
  private apiOrigin(): string {
    try {
      return new URL(getApiBase()).origin;
    } catch {
      return getApiBase();
    }
  }

  async getProjectCredentials(id: string): Promise<ProjectKeys | null> {
    const p = coreGetProject(id, this.options.keystorePath);
    return p ?? null;
  }

  async listProjectCredentials(): Promise<Record<string, ProjectKeys>> {
    return coreLoadKeyStore(this.options.keystorePath).projects;
  }

  async getProject(id: string): Promise<ProjectKeys | null> {
    return this.getProjectCredentials(id);
  }

  async saveProject(id: string, project: ProjectKeys): Promise<void> {
    coreSaveProject(id, project, this.options.keystorePath);
  }

  async updateProject(id: string, patch: Partial<ProjectKeys>): Promise<void> {
    coreUpdateProject(id, patch, this.options.keystorePath);
  }

  async removeProject(id: string): Promise<void> {
    coreRemoveProject(id, this.options.keystorePath);
  }

  async setActiveProject(id: string): Promise<void> {
    setActiveProjectId(id, this.options.profileStatePath, this.activeScope());
  }

  async getActiveProject(): Promise<string | null> {
    return getActiveProjectId(this.options.profileStatePath, this.activeScope()) ?? null;
  }

  async readAllowance(): Promise<AllowanceData | null> {
    return coreReadAllowance(this.options.allowancePath) ?? null;
  }

  async saveAllowance(data: AllowanceData): Promise<void> {
    coreSaveAllowance(data, this.options.allowancePath);
  }

  async createAllowance(): Promise<AllowanceData> {
    const privateKeyBytes = randomBytes(32);
    const privateKey = `0x${privateKeyBytes.toString("hex")}`;

    const ecdh = createECDH("secp256k1");
    ecdh.setPrivateKey(privateKeyBytes);
    const uncompressedPubKey = ecdh.getPublicKey();
    // Strip the 04 uncompressed-point prefix before hashing.
    const pubKeyBody = uncompressedPubKey.subarray(1);
    const hash = keccak_256(pubKeyBody);
    const addressBytes = hash.slice(-20);
    const address = `0x${Buffer.from(addressBytes).toString("hex")}`;

    return {
      address,
      privateKey,
      created: new Date().toISOString(),
      funded: false,
    };
  }

  getAllowancePath(): string {
    return this.options.allowancePath ?? coreGetAllowancePath();
  }

  getProjectCredentialCacheInfo() {
    const profile = getActiveProfile();
    return {
      source: "local_cache" as const,
      cache_path: this.options.keystorePath ?? coreGetProjectCredentialsPath(),
      wallet: profile,
      profile,
    };
  }

  getProfileStatePath(): string {
    return this.options.profileStatePath ?? coreGetProfileStatePath();
  }

  private activeScope() {
    const allowance = coreReadAllowance(this.options.allowancePath);
    return {
      api_base: getApiBase(),
      profile: getActiveProfile(),
      principal: allowance?.address ?? null,
    };
  }

  async getWalletIdentity(): Promise<WalletIdentity | null> {
    const name = getActiveProfile();
    const meta = readMeta(name);
    let address = meta?.address ?? null;
    if (!address) {
      address = coreReadAllowance(this.options.allowancePath)?.address ?? null;
    }
    return { name, address, label: meta?.label ?? null };
  }
}
