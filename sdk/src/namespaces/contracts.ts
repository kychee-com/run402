/**
 * `contracts` namespace — AWS KMS-backed Ethereum signers.
 *
 * Signers sign smart-contract write transactions. Private keys never leave
 * KMS. Pricing: $0.04/day rental ($1.20/month) plus $0.000005 per sign.
 * Non-custodial.
 *
 * NOTE: The contracts API surface is frozen — this namespace preserves the
 * existing request/response shapes verbatim.
 */

import type { Client } from "../kernel.js";
import { LocalError, ProjectNotFound } from "../errors.js";
import { assertEvmAddress, assertStringInSet, assertWeiString } from "../validation.js";

export type EvmChain = "base-mainnet" | "base-sepolia";
const EVM_CHAINS: readonly EvmChain[] = ["base-mainnet", "base-sepolia"];

export type SignerStatus = "active" | "suspended" | "deleted";

export type ContractCallStatus = "submitted" | "confirmed" | "failed";

export interface SignerSummary {
  signer_id: string;
  address: string;
  chain: EvmChain;
  status: SignerStatus;
  balance_wei: string;
  threshold_wei: string | null;
  recovery_address: string | null;
  created_at: string;
}

export interface ListSignersResult {
  signers: SignerSummary[];
}

export interface ProvisionSignerResult {
  signer_id: string;
  address: string;
  chain: EvmChain;
  status?: SignerStatus;
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

export interface DeleteSignerResult {
  signer_id: string;
  deleted_at?: string;
  scheduled_deletion_at?: string;
}

export interface ProvisionSignerOptions {
  chain: EvmChain;
  recoveryAddress?: string;
}

export interface ContractCallOptions {
  signerId: string;
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

export interface ContractDeployOptions {
  /** The cwlt_… ID of the KMS signer that will sign + own the new contract. */
  signerId: string;
  /** The chain to deploy to. Must match the signer's chain. */
  chain: EvmChain;
  /**
   * Full creation calldata as a 0x-prefixed hex string: creation bytecode
   * concatenated with ABI-encoded constructor args (the caller does the
   * encoding via viem/ethers etc.). Non-empty, even-length, ≤ 128 KB.
   *
   * run402 does NOT compile Solidity — bring your own bytecode.
   */
  bytecode: string;
  /** Optional native-token value to attach to the deploy tx (in wei). */
  value?: string;
  /** Optional idempotency key — same key + same payload returns the existing call. */
  idempotencyKey?: string;
}

export interface ContractDeployResult extends ContractCallResult {
  /**
   * The deterministic CREATE address derived from `(signer.address, nonce)`.
   * Returned synchronously — the caller knows where the new contract will
   * live without waiting for confirmation. The reconciler verifies this
   * matches the on-chain receipt's `contractAddress` on confirmation.
   */
  contract_address: string;
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
  readonly setAlert: (projectId: string, signerId: string, thresholdWei: string) => Promise<void>;
  readonly delete: (projectId: string, signerId: string) => Promise<DeleteSignerResult>;
  readonly status: (projectId: string, callId: string) => Promise<ContractCallResult>;

  constructor(private readonly client: Client) {
    this.setAlert = this.setLowBalanceAlert.bind(this);
    this.delete = this.deleteSigner.bind(this);
    this.status = this.callStatus.bind(this);
  }

  /** Provision a new KMS-backed signer. */
  async provisionSigner(projectId: string, opts: ProvisionSignerOptions): Promise<ProvisionSignerResult> {
    assertStringInSet(opts.chain, EVM_CHAINS, "chain", "provisioning KMS signer");
    if (opts.recoveryAddress) {
      assertEvmAddress(opts.recoveryAddress, "recoveryAddress", "provisioning KMS signer");
    }
    const project = await this.client.getProject(projectId);
    if (!project) throw new ProjectNotFound(projectId, "provisioning KMS signer");
    const body: Record<string, unknown> = { chain: opts.chain };
    if (opts.recoveryAddress) body.recovery_address = opts.recoveryAddress;
    return this.client.request<ProvisionSignerResult>("/contracts/v1/signers", {
      method: "POST",
      headers: { Authorization: `Bearer ${project.service_key}` },
      body,
      context: "provisioning KMS signer",
    });
  }

  /** Get a signer's metadata + live balance. */
  async getSigner(projectId: string, signerId: string): Promise<SignerSummary> {
    const project = await this.client.getProject(projectId);
    if (!project) throw new ProjectNotFound(projectId, "fetching signer");
    return this.client.request<SignerSummary>(
      `/contracts/v1/signers/${encodeURIComponent(signerId)}`,
      {
        headers: { Authorization: `Bearer ${project.service_key}` },
        context: "fetching signer",
      },
    );
  }

  /** List all signers owned by the project, including deleted ones. */
  async listSigners(projectId: string): Promise<ListSignersResult> {
    const project = await this.client.getProject(projectId);
    if (!project) throw new ProjectNotFound(projectId, "listing signers");
    return this.client.request<ListSignersResult>("/contracts/v1/signers", {
      headers: { Authorization: `Bearer ${project.service_key}` },
      context: "listing signers",
    });
  }

  /** Set or clear the recovery address used for auto-drain on day-90 deletion. */
  async setRecovery(projectId: string, signerId: string, recoveryAddress: string | null): Promise<void> {
    if (recoveryAddress !== null) {
      assertEvmAddress(recoveryAddress, "recoveryAddress", "setting recovery address");
    }
    const project = await this.client.getProject(projectId);
    if (!project) throw new ProjectNotFound(projectId, "setting recovery address");
    await this.client.request<unknown>(
      `/contracts/v1/signers/${encodeURIComponent(signerId)}/recovery-address`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${project.service_key}` },
        body: { recovery_address: recoveryAddress },
        context: "setting recovery address",
      },
    );
  }

  /** Set the low-balance threshold (in wei) for email alerts. */
  async setLowBalanceAlert(projectId: string, signerId: string, thresholdWei: string): Promise<void> {
    assertWeiString(thresholdWei, "thresholdWei", "setting low-balance threshold");
    const project = await this.client.getProject(projectId);
    if (!project) throw new ProjectNotFound(projectId, "setting low-balance threshold");
    await this.client.request<unknown>(
      `/contracts/v1/signers/${encodeURIComponent(signerId)}/alert`,
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
    assertStringInSet(opts.chain, EVM_CHAINS, "chain", "submitting contract call");
    assertEvmAddress(contractAddress, "contractAddress", "submitting contract call");

    const project = await this.client.getProject(projectId);
    if (!project) throw new ProjectNotFound(projectId, "submitting contract call");

    const headers: Record<string, string> = { Authorization: `Bearer ${project.service_key}` };
    if (opts.idempotencyKey) headers["Idempotency-Key"] = opts.idempotencyKey;

    const body: Record<string, unknown> = {
      signer_id: opts.signerId,
      chain: opts.chain,
      contract_address: contractAddress,
      abi_fragment: abiFragment,
      function_name: functionName,
      args: opts.args,
    };
    if (opts.value !== undefined) {
      assertWeiString(opts.value, "value", "submitting contract call");
      body.value = opts.value;
    }

    return this.client.request<ContractCallResult>("/contracts/v1/call", {
      method: "POST",
      headers,
      body,
      context: "submitting contract call",
    });
  }

  /**
   * Deploy a contract from the signer (KMS-signs a contract-creation tx).
   *
   * The `bytecode` is the full creation calldata — creation bytecode
   * concatenated with ABI-encoded constructor args (the caller does the
   * encoding via viem/ethers etc.; run402 does NOT compile Solidity).
   *
   * Returns synchronously with the deterministic CREATE address derived
   * from `(signer.address, nonce)` — no need to wait for confirmation
   * to know where the contract will live. Reconciler verifies on receipt.
   *
   * Same pricing as `call`: chain gas at-cost + $0.000005 KMS sign fee.
   * Idempotent on `idempotencyKey`.
   */
  async deploy(projectId: string, opts: ContractDeployOptions): Promise<ContractDeployResult> {
    if (typeof opts.bytecode !== "string" || opts.bytecode.length === 0) {
      throw new LocalError("contracts.deploy requires non-empty bytecode (hex string)", "deploying contract");
    }
    if (!/^0x[0-9a-fA-F]+$/.test(opts.bytecode)) {
      throw new LocalError("contracts.deploy bytecode must be 0x-prefixed hex", "deploying contract");
    }
    if (opts.bytecode.length % 2 !== 0) {
      throw new LocalError("contracts.deploy bytecode must be even-length hex", "deploying contract");
    }
    const MAX_BYTES = 128 * 1024;
    if ((opts.bytecode.length - 2) / 2 > MAX_BYTES) {
      throw new LocalError(`contracts.deploy bytecode exceeds ${MAX_BYTES}-byte cap`, "deploying contract");
    }
    assertStringInSet(opts.chain, EVM_CHAINS, "chain", "deploying contract");

    const project = await this.client.getProject(projectId);
    if (!project) throw new ProjectNotFound(projectId, "deploying contract");

    const headers: Record<string, string> = { Authorization: `Bearer ${project.service_key}` };
    if (opts.idempotencyKey) headers["Idempotency-Key"] = opts.idempotencyKey;

    const body: Record<string, unknown> = {
      signer_id: opts.signerId,
      chain: opts.chain,
      bytecode: opts.bytecode,
    };
    if (opts.value !== undefined) {
      assertWeiString(opts.value, "value", "deploying contract");
      body.value = opts.value;
    }

    return this.client.request<ContractDeployResult>("/contracts/v1/deploy", {
      method: "POST",
      headers,
      body,
      context: "deploying contract",
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
    assertStringInSet(opts.chain, EVM_CHAINS, "chain", "reading contract");
    assertEvmAddress(contractAddress, "contractAddress", "reading contract");

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
   * Drain the signer's native-token balance to a destination address.
   * Works on suspended signers. Requires `X-Confirm-Drain: <signer_id>`
   * confirmation header (sent automatically by the SDK).
   */
  async drain(projectId: string, signerId: string, destinationAddress: string): Promise<DrainResult> {
    assertEvmAddress(destinationAddress, "destinationAddress", "draining signer");
    const project = await this.client.getProject(projectId);
    if (!project) throw new ProjectNotFound(projectId, "draining signer");
    return this.client.request<DrainResult>(
      `/contracts/v1/signers/${encodeURIComponent(signerId)}/drain`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${project.service_key}`,
          "X-Confirm-Drain": signerId,
        },
        body: { destination_address: destinationAddress },
        context: "draining signer",
      },
    );
  }

  /**
   * Schedule the KMS key for deletion (7-day AWS minimum window). Refused
   * if the signer has on-chain balance >= dust — drain first.
   */
  async deleteSigner(projectId: string, signerId: string): Promise<DeleteSignerResult> {
    const project = await this.client.getProject(projectId);
    if (!project) throw new ProjectNotFound(projectId, "deleting signer");
    return this.client.request<DeleteSignerResult>(
      `/contracts/v1/signers/${encodeURIComponent(signerId)}`,
      {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${project.service_key}`,
          "X-Confirm-Delete": signerId,
        },
        context: "deleting signer",
      },
    );
  }
}
