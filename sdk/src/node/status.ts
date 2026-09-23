/**
 * `r.status()` — the organization's state in one read, owned by the Node
 * SDK: the active wallet (`local_label`, `server_label`, address), its rail,
 * on-chain and allowance balances, the tier and its lease, the projects
 * (server-side, falling back to the local key cache), the active project, and
 * the API target. This is the LOCAL view — which wallet this machine acts as —
 * combined with the reads that wallet can make; it never returns key material.
 *
 * With no local wallet the answer is the bare local state (`wallet: null`,
 * the locally known projects, the active project, the target) plus the next
 * command; Run402 Core targets can still report it without a wallet.
 * `run402 status` is a shim over this.
 */

import {
  getActiveProfile,
  getApiBase,
  getApiBaseSource,
  getApiTargetKind,
} from "../../core-dist/config.js";
import { readLocalWallet } from "./wallets.js";
import { getActiveProjectId, loadKeyStore } from "../../core-dist/keystore.js";
import { readMeta } from "../../core-dist/profiles.js";
import type { Run402 } from "../index.js";
import { readRemoteStatus } from "./remote-status.js";

const USDC_ABI = [{ name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ name: "account", type: "address" }], outputs: [{ name: "", type: "uint256" }] }] as const;
const USDC_MAINNET = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const USDC_SEPOLIA = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const PATH_USD = "0x20c0000000000000000000000000000000000000";
const TEMPO_RPC = "https://rpc.moderato.tempo.xyz/";

export interface StatusTarget {
  api_base: string;
  api_base_source: "env" | "profile" | "default";
  kind: "cloud" | "core" | "unknown";
}

/** No local wallet: the local facts and the next command. */
export interface LocalOnlyStatus {
  wallet: null;
  target: StatusTarget;
  projects: Array<{ project_id: string }>;
  active_project: string | null;
  hint: string;
}

/** A local wallet: the organization's state as that wallet sees it. */
export interface WalletStatus {
  wallet: { local_label: string; server_label: string | null; address: string };
  rail: string;
  remote_status: unknown;
  next_actions: unknown;
  projects_source: "remote" | "local_cache";
  balances: {
    on_chain_usd_micros: number | null;
    on_chain_token: "USDC" | "pathUSD";
    allowance_usd_micros: number | null;
    held_usd_micros: number | null;
  };
  tier: { name: string; status: string; expires: string | null } | null;
  organization_lifecycle_state: string | null;
  lease_perpetual: boolean | null;
  projects: Array<Record<string, unknown> & { project_id: string }>;
  active_project: string | null;
  target: StatusTarget;
}

export type StatusResult = LocalOnlyStatus | WalletStatus;

/**
 * The wallet's on-chain balance in USD micros for its rail: USDC on Base
 * mainnet plus Base Sepolia (x402), or pathUSD on Tempo Moderato (mpp).
 * Null when every read fails.
 */
async function readWalletBalanceUsdMicros(rail: string, address: string): Promise<number | null> {
  try {
    const { createPublicClient, http, defineChain } = await import("viem");
    if (rail === "mpp") {
      const tempoModerato = defineChain({
        id: 42431,
        name: "Tempo Moderato",
        nativeCurrency: { name: "pathUSD", symbol: "pathUSD", decimals: 6 },
        rpcUrls: { default: { http: [TEMPO_RPC] } },
      });
      const client = createPublicClient({ chain: tempoModerato, transport: http() });
      try {
        const raw = await client.readContract({ address: PATH_USD, abi: USDC_ABI, functionName: "balanceOf", args: [address as `0x${string}`] });
        return Number(raw);
      } catch {
        return null;
      }
    }
    const { base, baseSepolia } = await import("viem/chains");
    const mainnetClient = createPublicClient({ chain: base, transport: http() });
    const sepoliaClient = createPublicClient({ chain: baseSepolia, transport: http() });
    const [mainnet, sepolia] = await Promise.all([
      mainnetClient.readContract({ address: USDC_MAINNET, abi: USDC_ABI, functionName: "balanceOf", args: [address as `0x${string}`] }).then(Number).catch(() => null),
      sepoliaClient.readContract({ address: USDC_SEPOLIA, abi: USDC_ABI, functionName: "balanceOf", args: [address as `0x${string}`] }).then(Number).catch(() => null),
    ]);
    if (mainnet === null && sepolia === null) return null;
    return (mainnet || 0) + (sepolia || 0);
  } catch {
    return null;
  }
}

/** Always expose `project_id` (the remote listing keys entries as `id`), never both. */
function normalizeProject(raw: Record<string, unknown>): Record<string, unknown> & { project_id: string } {
  if (!raw || typeof raw !== "object") return raw;
  const projectId = (raw.project_id || raw.id) as string;
  const { id: _dropId, project_id: _dropPid, ...rest } = raw;
  return { project_id: projectId, ...rest };
}

export async function runStatus(r: Run402): Promise<StatusResult> {
  const localWallet = readLocalWallet();
  const target: StatusTarget = {
    api_base: getApiBase(),
    api_base_source: getApiBaseSource(),
    kind: getApiTargetKind(),
  };
  if (!localWallet) {
    const store = loadKeyStore();
    return {
      wallet: null,
      target,
      projects: Object.keys(store.projects).map((id) => ({ project_id: id })),
      active_project: getActiveProjectId() || null,
      hint: target.kind === "core" ? "Run: run402 projects provision --name my-app" : "Run: run402 init",
    };
  }

  const wallet = localWallet.address.toLowerCase();
  const rail = localWallet.rail || "x402";

  // Tier, allowance, and the membership-scoped project inventory, beside the
  // on-chain balance, all best-effort.
  const [status, walletBalance] = await Promise.all([
    readRemoteStatus(r, wallet),
    readWalletBalanceUsdMicros(rail, localWallet.address),
  ]);
  const { tier, billing, remote } = status as unknown as {
    tier: Record<string, any> | null;
    billing: Record<string, any> | null;
    remote: { projects?: Array<Record<string, unknown>> } | null;
    availability: unknown;
    next_actions: unknown;
  };

  const store = loadKeyStore();
  const activeId = getActiveProjectId();
  const projects = remote?.projects
    ? remote.projects.map(normalizeProject)
    : Object.keys(store.projects).map((id) => ({ project_id: id }));

  const walletName = getActiveProfile();
  const walletMeta = readMeta(walletName);
  const hasBilling = billing && billing.exists !== false;
  return {
    wallet: {
      local_label: walletName,
      server_label: walletMeta?.label ?? null,
      address: localWallet.address,
    },
    rail,
    remote_status: (status as { availability: unknown }).availability,
    next_actions: (status as { next_actions: unknown }).next_actions,
    projects_source: remote ? "remote" : "local_cache",
    balances: {
      on_chain_usd_micros: walletBalance,
      on_chain_token: rail === "mpp" ? "pathUSD" : "USDC",
      allowance_usd_micros: hasBilling ? billing!.allowance_usd_micros : null,
      held_usd_micros: hasBilling ? (billing!.held_usd_micros ?? 0) : null,
    },
    tier: tier && tier.tier
      ? { name: tier.tier, status: tier.status, expires: tier.lease_perpetual === true ? null : tier.lease_expires_at }
      : null,
    // Lifecycle and the perpetual flag live on the organization; surfaced at the top.
    organization_lifecycle_state: tier?.organization_lifecycle_state ?? null,
    lease_perpetual: tier?.lease_perpetual ?? null,
    projects,
    active_project: activeId || null,
    target,
  };
}
