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
import { LocalError, ProjectNotFound } from "../errors.js";

export type EvmChain = "base-mainnet" | "base-sepolia";

export type ContractWalletStatus = "active" | "suspended" | "deleted";

export type ContractCallStatus = "submitted" | "confirmed" | "failed";

export interface ContractWalletSummary {
  wallet_id: string;
  address: string;
  chain: EvmChain;
  status: ContractWalletStatus;
  balance_wei: string;
  threshold_wei: string | null;
  recovery_address: string | null;
  created_at: string;
}

export interface ListWalletsResult {
  wallets: ContractWalletSummary[];
}

export interface ProvisionWalletResult {
  wallet_id: string;
  address: string;
  chain: EvmChain;
  status?: ContractWalletStatus;
  balance_wei?: string;
  threshold_wei?: string | null;
  recovery_address?: string | null;
  created_at?: string;
}

export interface ContractCallResult {
  call_id: string;
  status: ContractCallStatus;
  tx_hash: string | null;
  gas_used?: string | null;
  gas_cost_usd_micros?: string | null;
  receipt?: unknown;
}

export interface ContractReadResult {
  result: unknown;
}

export interface DrainResult {
  call_id: string;
  status: ContractCallStatus;
  tx_hash: string | null;
}

export interface DeleteWalletResult {
  wallet_id: string;
  deleted_at?: string;
  scheduled_deletion_at?: string;
}

export interface ProvisionWalletOptions {
  chain: EvmChain;
  recoveryAddress?: string;
}

export interface ContractCallOptions {
  walletId: string;
  chain: EvmChain;
  contractAddress?: string;
  to?: string;
  abiFragment?: unknown[];
  abi?: unknown[];
  functionName?: string;
  fn?: string;
  args: unknown[];
  value?: string;
  idempotencyKey?: string;
}

export interface ContractReadOptions {
  chain: EvmChain;
  contractAddress?: string;
  to?: string;
  abiFragment?: unknown[];
  abi?: unknown[];
  functionName?: string;
  fn?: string;
  args: unknown[];
}

export class Contracts {
  readonly setAlert: (projectId: string, walletId: string, thresholdWei: string) => Promise<void>;
  readonly delete: (projectId: string, walletId: string) => Promise<DeleteWalletResult>;
  readonly status: (projectId: string, callId: string) => Promise<ContractCallResult>;

  constructor(private readonly client: Client) {
    this.setAlert = this.setLowBalanceAlert.bind(this);
    this.delete = this.deleteWallet.bind(this);
    this.status = this.callStatus.bind(this);
  }

  /** Provision a new KMS-backed contract wallet. */
  async provisionWallet(projectId: string, opts: ProvisionWalletOptions): Promise<ProvisionWalletResult> {
    const project = await this.client.getProject(projectId);
    if (!project) throw new ProjectNotFound(projectId, "provisioning KMS contract wallet");
    const body: Record<string, unknown> = { chain: opts.chain };
    if (opts.recoveryAddress) body.recovery_address = opts.recoveryAddress;
    return this.client.request<ProvisionWalletResult>("/contracts/v1/wallets", {
      method: "POST",
      headers: { Authorization: `Bearer ${project.service_key}` },
      body,
      context: "provisioning KMS contract wallet",
    });
  }

  /** Get a wallet's metadata + live balance. */
  async getWallet(projectId: string, walletId: string): Promise<ContractWalletSummary> {
    const project = await this.client.getProject(projectId);
    if (!project) throw new ProjectNotFound(projectId, "fetching wallet");
    return this.client.request<ContractWalletSummary>(
      `/contracts/v1/wallets/${encodeURIComponent(walletId)}`,
      {
        headers: { Authorization: `Bearer ${project.service_key}` },
        context: "fetching wallet",
      },
    );
  }

  /** List all wallets owned by the project, including deleted ones. */
  async listWallets(projectId: string): Promise<ListWalletsResult> {
    const project = await this.client.getProject(projectId);
    if (!project) throw new ProjectNotFound(projectId, "listing wallets");
    return this.client.request<ListWalletsResult>("/contracts/v1/wallets", {
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
  async call(projectId: string, opts: ContractCallOptions): Promise<ContractCallResult> {
    const project = await this.client.getProject(projectId);
    if (!project) throw new ProjectNotFound(projectId, "submitting contract call");

    const contractAddress = opts.contractAddress ?? opts.to;
    const abiFragment = opts.abiFragment ?? opts.abi;
    const functionName = opts.functionName ?? opts.fn;
    if (!contractAddress) {
      throw new LocalError("contracts.call requires contractAddress (or 'to')", "submitting contract call");
    }
    if (!abiFragment) {
      throw new LocalError("contracts.call requires abiFragment (or 'abi')", "submitting contract call");
    }
    if (!functionName) {
      throw new LocalError("contracts.call requires functionName (or 'fn')", "submitting contract call");
    }

    const headers: Record<string, string> = { Authorization: `Bearer ${project.service_key}` };
    if (opts.idempotencyKey) headers["Idempotency-Key"] = opts.idempotencyKey;

    const body: Record<string, unknown> = {
      wallet_id: opts.walletId,
      chain: opts.chain,
      contract_address: contractAddress,
      abi_fragment: abiFragment,
      function_name: functionName,
      args: opts.args,
    };
    if (opts.value) body.value = opts.value;

    return this.client.request<ContractCallResult>("/contracts/v1/call", {
      method: "POST",
      headers,
      body,
      context: "submitting contract call",
    });
  }

  /** Read-only smart-contract call (view/pure). No auth, no gas, no billing. */
  async read(opts: ContractReadOptions): Promise<ContractReadResult> {
    const contractAddress = opts.contractAddress ?? opts.to;
    const abiFragment = opts.abiFragment ?? opts.abi;
    const functionName = opts.functionName ?? opts.fn;
    if (!contractAddress) {
      throw new LocalError("contracts.read requires contractAddress (or 'to')", "reading contract");
    }
    if (!abiFragment) {
      throw new LocalError("contracts.read requires abiFragment (or 'abi')", "reading contract");
    }
    if (!functionName) {
      throw new LocalError("contracts.read requires functionName (or 'fn')", "reading contract");
    }

    return this.client.request<ContractReadResult>("/contracts/v1/read", {
      method: "POST",
      body: {
        chain: opts.chain,
        contract_address: contractAddress,
        abi_fragment: abiFragment,
        function_name: functionName,
        args: opts.args,
      },
      context: "reading contract",
      withAuth: false,
    });
  }

  /** Look up a previously submitted call by id. */
  async callStatus(projectId: string, callId: string): Promise<ContractCallResult> {
    const project = await this.client.getProject(projectId);
    if (!project) throw new ProjectNotFound(projectId, "fetching call status");
    return this.client.request<ContractCallResult>(
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
  async drain(projectId: string, walletId: string, destinationAddress: string): Promise<DrainResult> {
    const project = await this.client.getProject(projectId);
    if (!project) throw new ProjectNotFound(projectId, "draining wallet");
    return this.client.request<DrainResult>(
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
   * if the wallet has on-chain balance >= dust — drain first.
   */
  async deleteWallet(projectId: string, walletId: string): Promise<DeleteWalletResult> {
    const project = await this.client.getProject(projectId);
    if (!project) throw new ProjectNotFound(projectId, "deleting wallet");
    return this.client.request<DeleteWalletResult>(
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
