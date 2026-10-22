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
import { railBalanceKeys, readOnChainBalances, sumOnChainBalances, type OnChainBalances } from "./onchain-balances.js";

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
    /** The rail's token summed over the networks it pays on (`on_chain_by_network`). */
    on_chain_usd_micros: number | null;
    /** Each of those networks, test money and real money apart; null where a read failed. */
    on_chain_by_network: Partial<OnChainBalances>;
    on_chain_token: "USDC" | "pathUSD";
    allowance_usd_micros: number | null;
    held_usd_micros: number | null;
  };
  /** `status` is derived from the gateway's `active` flag; `GET /tiers/v1/status` carries no `status` field. */
  tier: { name: string; status: "active" | "inactive"; expires: string | null } | null;
  organization_lifecycle_state: string | null;
  lease_perpetual: boolean | null;
  projects: Array<Record<string, unknown> & { project_id: string }>;
  active_project: string | null;
  target: StatusTarget;
}

export type StatusResult = LocalOnlyStatus | WalletStatus;

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
  const balanceKeys = railBalanceKeys(rail);
  const [status, onChainByNetwork] = await Promise.all([
    readRemoteStatus(r, wallet),
    readOnChainBalances(localWallet.address, balanceKeys),
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
      on_chain_usd_micros: sumOnChainBalances(onChainByNetwork, balanceKeys),
      on_chain_by_network: onChainByNetwork,
      on_chain_token: rail === "mpp" ? "pathUSD" : "USDC",
      allowance_usd_micros: hasBilling ? billing!.allowance_usd_micros : null,
      held_usd_micros: hasBilling ? (billing!.held_usd_micros ?? 0) : null,
    },
    tier: tier && tier.tier
      ? { name: tier.tier, status: tier.active === true ? "active" : "inactive", expires: tier.lease_perpetual === true ? null : tier.lease_expires_at }
      : null,
    // Lifecycle and the perpetual flag live on the organization; surfaced at the top.
    organization_lifecycle_state: tier?.organization_lifecycle_state ?? null,
    lease_perpetual: tier?.lease_perpetual ?? null,
    projects,
    active_project: activeId || null,
    target,
  };
}
