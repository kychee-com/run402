/**
 * `allowance` namespace — the agent's local wallet.
 *
 * `status`, `create`, `export` touch the local allowance file via optional
 * provider methods. Sandbox providers that don't implement those throw a
 * descriptive error at runtime.
 *
 * `faucet` is an API call (request testnet USDC) and works in any environment.
 */

import type { Client } from "../kernel.js";
import type { AllowanceData } from "../credentials.js";

export interface AllowanceStatusResult {
  address: string;
  created?: string;
  funded?: boolean;
  lastFaucet?: string;
  path?: string;
  /** true when the local provider holds an allowance, false otherwise. */
  configured: boolean;
}

export interface AllowanceCreateResult {
  address: string;
  created: string;
  path?: string;
}

export interface FaucetResult {
  transactionHash: string;
  amount: string;
  token: string;
  network: string;
}

export class Allowance {
  constructor(private readonly client: Client) {}

  /** Inspect the local allowance. Returns `{configured: false}` when absent. */
  async status(): Promise<AllowanceStatusResult> {
    const reader = this.client.credentials.readAllowance;
    if (!reader) {
      return { address: "", configured: false };
    }
    const data = await reader.call(this.client.credentials);
    if (!data) return { address: "", configured: false };
    return {
      address: data.address,
      created: data.created,
      funded: data.funded,
      lastFaucet: data.lastFaucet,
      path: this.client.credentials.getAllowancePath?.call(this.client.credentials),
      configured: true,
    };
  }

  /**
   * Generate a new allowance keypair and persist it. Throws when the
   * provider already holds an allowance (don't overwrite silently) or
   * when the provider doesn't support local allowance management.
   */
  async create(): Promise<AllowanceCreateResult> {
    const reader = this.client.credentials.readAllowance;
    const creator = this.client.credentials.createAllowance;
    const saver = this.client.credentials.saveAllowance;
    if (!creator || !saver) {
      throw new Error(
        "This credential provider does not support allowance creation. Use @run402/sdk/node for local allowance management.",
      );
    }
    if (reader) {
      const existing = await reader.call(this.client.credentials);
      if (existing) {
        throw new Error(
          `Allowance already exists at ${
            this.client.credentials.getAllowancePath?.call(this.client.credentials) ?? "(local path unknown)"
          }. Delete it manually to regenerate.`,
        );
      }
    }
    const data: AllowanceData = await creator.call(this.client.credentials);
    await saver.call(this.client.credentials, data);
    return {
      address: data.address,
      created: data.created ?? new Date().toISOString(),
      path: this.client.credentials.getAllowancePath?.call(this.client.credentials),
    };
  }

  /** Return the allowance address (safe to share). Throws if none is configured. */
  async export(): Promise<string> {
    const reader = this.client.credentials.readAllowance;
    if (!reader) {
      throw new Error("This credential provider does not expose the local allowance.");
    }
    const data = await reader.call(this.client.credentials);
    if (!data) {
      throw new Error("No agent allowance is configured.");
    }
    return data.address;
  }

  /**
   * Request testnet USDC from the Run402 faucet. When `address` is omitted,
   * the SDK uses the provider's local allowance address. Updates the
   * allowance's `funded` flag on success.
   */
  async faucet(address?: string): Promise<FaucetResult> {
    let resolvedAddress = address;
    if (!resolvedAddress) {
      const reader = this.client.credentials.readAllowance;
      if (!reader) {
        throw new Error("No address provided and no local allowance is available.");
      }
      const data = await reader.call(this.client.credentials);
      if (!data) {
        throw new Error("No address provided and no agent allowance is configured.");
      }
      resolvedAddress = data.address;
    }

    const result = await this.client.request<FaucetResult>("/faucet/v1", {
      method: "POST",
      body: { address: resolvedAddress },
      withAuth: false,
      context: "requesting faucet funds",
    });

    // Best-effort update of the local allowance's funded/lastFaucet fields.
    const reader = this.client.credentials.readAllowance;
    const saver = this.client.credentials.saveAllowance;
    if (reader && saver) {
      try {
        const data = await reader.call(this.client.credentials);
        if (data) {
          await saver.call(this.client.credentials, {
            ...data,
            funded: true,
            lastFaucet: new Date().toISOString(),
          });
        }
      } catch {
        // non-fatal — the on-chain transfer succeeded
      }
    }

    return result;
  }
}
