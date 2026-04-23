/**
 * `contracts` namespace — AWS KMS-backed Ethereum contract wallets.
 *
 * Contract wallets sign smart-contract write transactions. Private keys
 * never leave KMS. Pricing: $0.04/day rental ($1.20/month) plus $0.000005
 * per sign. Non-custodial.
 *
 * NOTE: The contracts API surface is frozen — this namespace preserves the
 * existing request/response shapes verbatim.
 */

import type { Client } from "../kernel.js";
import { ProjectNotFound } from "../errors.js";

export type EvmChain = "base-mainnet" | "base-sepolia";

export interface ProvisionWalletOptions {
  chain: EvmChain;
  recoveryAddress?: string;
}

export interface ContractCallOptions {
  walletId: string;
  chain: EvmChain;
  contractAddress: string;
  abiFragment: unknown[];
  functionName: string;
  args: unknown[];
  value?: string;
  idempotencyKey?: string;
}

export interface ContractReadOptions {
  chain: EvmChain;
  contractAddress: string;
  abiFragment: unknown[];
  functionName: string;
  args: unknown[];
}

export class Contracts {
  constructor(private readonly client: Client) {}

  /** Provision a new KMS-backed contract wallet. */
  async provisionWallet(projectId: string, opts: ProvisionWalletOptions): Promise<unknown> {
    const project = await this.client.getProject(projectId);
    if (!project) throw new ProjectNotFound(projectId, "provisioning KMS contract wallet");
    const body: Record<string, unknown> = { chain: opts.chain };
    if (opts.recoveryAddress) body.recovery_address = opts.recoveryAddress;
    return this.client.request<unknown>("/contracts/v1/wallets", {
      method: "POST",
      headers: { Authorization: `Bearer ${project.service_key}` },
      body,
      context: "provisioning KMS contract wallet",
    });
  }

  /** Get a wallet's metadata + live balance. */
  async getWallet(projectId: string, walletId: string): Promise<unknown> {
    const project = await this.client.getProject(projectId);
    if (!project) throw new ProjectNotFound(projectId, "fetching wallet");
    return this.client.request<unknown>(
      `/contracts/v1/wallets/${encodeURIComponent(walletId)}`,
      {
        headers: { Authorization: `Bearer ${project.service_key}` },
        context: "fetching wallet",
      },
    );
  }

  /** List all wallets owned by the project, including deleted ones. */
  async listWallets(projectId: string): Promise<unknown> {
    const project = await this.client.getProject(projectId);
    if (!project) throw new ProjectNotFound(projectId, "listing wallets");
    return this.client.request<unknown>("/contracts/v1/wallets", {
      headers: { Authorization: `Bearer ${project.service_key}` },
      context: "listing wallets",
    });
  }

  /** Set or clear the recovery address used for auto-drain on day-90 deletion. */
  async setRecovery(projectId: string, walletId: string, recoveryAddress: string | null): Promise<void> {
    const project = await this.client.getProject(projectId);
    if (!project) throw new ProjectNotFound(projectId, "setting recovery address");
    await this.client.request<unknown>(
      `/contracts/v1/wallets/${encodeURIComponent(walletId)}/recovery-address`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${project.service_key}` },
        body: { recovery_address: recoveryAddress },
        context: "setting recovery address",
      },
    );
  }

  /** Set the low-balance threshold (in wei) for email alerts. */
  async setLowBalanceAlert(projectId: string, walletId: string, thresholdWei: string): Promise<void> {
    const project = await this.client.getProject(projectId);
    if (!project) throw new ProjectNotFound(projectId, "setting low-balance threshold");
    await this.client.request<unknown>(
      `/contracts/v1/wallets/${encodeURIComponent(walletId)}/alert`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${project.service_key}` },
        body: { threshold_wei: thresholdWei },
        context: "setting low-balance threshold",
      },
    );
  }

  /** Submit a smart-contract write call. Idempotent on `idempotencyKey`. */
  async call(projectId: string, opts: ContractCallOptions): Promise<unknown> {
    const project = await this.client.getProject(projectId);
    if (!project) throw new ProjectNotFound(projectId, "submitting contract call");

    const headers: Record<string, string> = { Authorization: `Bearer ${project.service_key}` };
    if (opts.idempotencyKey) headers["Idempotency-Key"] = opts.idempotencyKey;

    const body: Record<string, unknown> = {
      wallet_id: opts.walletId,
      chain: opts.chain,
      contract_address: opts.contractAddress,
      abi_fragment: opts.abiFragment,
      function_name: opts.functionName,
      args: opts.args,
    };
    if (opts.value) body.value = opts.value;

    return this.client.request<unknown>("/contracts/v1/call", {
      method: "POST",
      headers,
      body,
      context: "submitting contract call",
    });
  }

  /** Read-only smart-contract call (view/pure). No auth, no gas, no billing. */
  async read(opts: ContractReadOptions): Promise<unknown> {
    return this.client.request<unknown>("/contracts/v1/read", {
      method: "POST",
      body: {
        chain: opts.chain,
        contract_address: opts.contractAddress,
        abi_fragment: opts.abiFragment,
        function_name: opts.functionName,
        args: opts.args,
      },
      context: "reading contract",
      withAuth: false,
    });
  }

  /** Look up a previously submitted call by id. */
  async callStatus(projectId: string, callId: string): Promise<unknown> {
    const project = await this.client.getProject(projectId);
    if (!project) throw new ProjectNotFound(projectId, "fetching call status");
    return this.client.request<unknown>(
      `/contracts/v1/calls/${encodeURIComponent(callId)}`,
      {
        headers: { Authorization: `Bearer ${project.service_key}` },
        context: "fetching call status",
      },
    );
  }

  /**
   * Drain the wallet's native-token balance to a destination address.
   * Works on suspended wallets. Requires `X-Confirm-Drain: <wallet_id>`
   * confirmation header (sent automatically by the SDK).
   */
  async drain(projectId: string, walletId: string, destinationAddress: string): Promise<unknown> {
    const project = await this.client.getProject(projectId);
    if (!project) throw new ProjectNotFound(projectId, "draining wallet");
    return this.client.request<unknown>(
      `/contracts/v1/wallets/${encodeURIComponent(walletId)}/drain`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${project.service_key}`,
          "X-Confirm-Drain": walletId,
        },
        body: { destination_address: destinationAddress },
        context: "draining wallet",
      },
    );
  }

  /**
   * Schedule the KMS key for deletion (7-day AWS minimum window). Refused
   * if the wallet has on-chain balance ≥ dust — drain first.
   */
  async deleteWallet(projectId: string, walletId: string): Promise<unknown> {
    const project = await this.client.getProject(projectId);
    if (!project) throw new ProjectNotFound(projectId, "deleting wallet");
    return this.client.request<unknown>(
      `/contracts/v1/wallets/${encodeURIComponent(walletId)}`,
      {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${project.service_key}`,
          "X-Confirm-Delete": walletId,
        },
        context: "deleting wallet",
      },
    );
  }
}
