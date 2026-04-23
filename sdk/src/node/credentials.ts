/**
 * Node credential provider — wraps the local keystore + allowance-auth.
 * Reproduces today's CLI/MCP behavior: reads `~/.config/run402/keystore.json`
 * (or `RUN402_CONFIG_DIR` override), signs SIWX headers from the allowance
 * private key, and serves project anon/service keys from disk.
 */

import { randomBytes, createECDH } from "node:crypto";
import { keccak_256 } from "@noble/hashes/sha3.js";
import {
  getProject as coreGetProject,
  saveProject as coreSaveProject,
  updateProject as coreUpdateProject,
  removeProject as coreRemoveProject,
  setActiveProjectId,
  getActiveProjectId,
} from "../../core-dist/keystore.js";
import { getAllowanceAuthHeaders } from "../../core-dist/allowance-auth.js";
import { readAllowance as coreReadAllowance, saveAllowance as coreSaveAllowance } from "../../core-dist/allowance.js";
import { getAllowancePath as coreGetAllowancePath } from "../../core-dist/config.js";
import type { AllowanceData, CredentialsProvider, ProjectKeys } from "../credentials.js";

export class NodeCredentialsProvider implements CredentialsProvider {
  constructor(private readonly options: { allowancePath?: string; keystorePath?: string } = {}) {}

  async getAuth(path: string): Promise<Record<string, string> | null> {
    const headers = getAllowanceAuthHeaders(path, this.options.allowancePath);
    return headers ? { ...headers } : null;
  }

  async getProject(id: string): Promise<ProjectKeys | null> {
    const p = coreGetProject(id, this.options.keystorePath);
    return p ?? null;
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
    setActiveProjectId(id, this.options.keystorePath);
  }

  async getActiveProject(): Promise<string | null> {
    return getActiveProjectId(this.options.keystorePath) ?? null;
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
}
