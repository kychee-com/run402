/**
 * The agent's Lightning wallet on the local machine: mint the budgeted wallet
 * on Run402's Hub, keep its pairing in the active profile's `wallet.json`
 * beside the Base key, report its balance, revoke it. Shared by `r.init`
 * (`run402 init lightning`) and `run402 wallets lightning …`. The pairing
 * secret is never returned by anything here.
 */

import { readWallet, saveWallet, type WalletData } from "../../core-dist/wallet.js";
import { LocalError } from "../errors.js";
import type { AgentLightningWallet } from "../namespaces/agent.types.js";

export const LIGHTNING_MINT_TIMEOUT_MS = 45_000;

type LightningAgent = {
  lightningWallet: {
    mint(opts?: { timeoutMs?: number }): Promise<AgentLightningWallet>;
    get(): Promise<AgentLightningWallet>;
    revoke(): Promise<unknown>;
  };
};

export interface LightningBalance {
  balance_sats: number;
  budget_remaining_sats: number | null;
}

export interface LightningDescription {
  wallet_id: string | null;
  status: string | null;
  custody: "run402_hub";
  custody_note: string;
  lightning_address: string | null;
  budget_sats: number | null;
  starter_sats: number | null;
  has_pairing: boolean;
  minted_at: string | null;
  balance_sats?: number;
  budget_remaining_sats?: number | null;
}

export type LightningOutcome = "stored" | "present" | "minting" | "unavailable" | "pairing_lost" | string;

export interface EnsureLightningResult {
  localWallet: WalletData;
  wallet: AgentLightningWallet | null;
  outcome: LightningOutcome;
  error?: unknown;
}

/** Public facts only: never the pairing. */
export function describeLightning(
  localWallet: WalletData | null | undefined,
  wallet: Partial<AgentLightningWallet> | null = null,
  balance: LightningBalance | null = null,
): LightningDescription | null {
  const local = localWallet?.lightning ?? null;
  if (!local && !wallet) return null;
  return {
    wallet_id: wallet?.wallet_id ?? local?.wallet_id ?? null,
    status: wallet?.status ?? (local ? "active" : null),
    custody: "run402_hub",
    custody_note: "The sats sit on Run402's Lightning Hub; this wallet is a budgeted connection to them, not self-custody.",
    lightning_address: wallet?.lightning_address ?? local?.lightning_address ?? null,
    budget_sats: wallet?.budget_sats ?? local?.budget_sats ?? null,
    starter_sats: wallet?.starter_sats ?? local?.starter_sats ?? null,
    has_pairing: Boolean(local?.nwc),
    minted_at: local?.minted_at ?? wallet?.activated_at ?? null,
    ...(balance ? balance : {}),
  };
}

/** Balance and remaining budget over NWC, best-effort (null on any failure). */
export async function readLightningBalance(localWallet: WalletData | null | undefined): Promise<LightningBalance | null> {
  const nwc = localWallet?.lightning?.nwc;
  if (!nwc) return null;
  try {
    const { NwcWallet, closeNwcConnections } = await import("./nwc.js");
    const wallet = new NwcWallet(nwc, { timeoutMs: 15_000 });
    const [balance_sats, budget] = await Promise.all([wallet.getBalanceSats(), wallet.getBudgetSats().catch(() => null)]);
    closeNwcConnections();
    return {
      balance_sats,
      budget_remaining_sats: budget && budget.totalSats !== null ? budget.totalSats - budget.usedSats : null,
    };
  } catch {
    return null;
  }
}

function storePairing(localWallet: WalletData, wallet: AgentLightningWallet): WalletData {
  const next: WalletData = {
    ...localWallet,
    rail: "lightning",
    lightning: {
      wallet_id: wallet.wallet_id,
      nwc: wallet.pairing!,
      lightning_address: wallet.lightning_address ?? null,
      budget_sats: wallet.budget_sats,
      starter_sats: wallet.starter_sats,
      custody: "run402_hub",
      minted_at: wallet.activated_at ?? new Date().toISOString(),
    },
  };
  saveWallet(next);
  return next;
}

/**
 * Ensure the active profile holds an active Lightning wallet. `outcome` is
 * `stored` (pairing just saved), `present` (already held locally), `minting`
 * (the platform is still minting; rerun later), `unavailable` (no Hub on this
 * gateway), `pairing_lost` (active, but its one-time pairing went to another
 * machine: revoke and mint again), or the wallet's own non-active status.
 */
export async function ensureLightningWallet(agent: LightningAgent, options: { timeoutMs?: number } = {}): Promise<EnsureLightningResult> {
  let localWallet = readWallet();
  if (!localWallet) {
    throw new LocalError("no local wallet configured; run `run402 init` first", "ensuring the Lightning wallet", { code: "LIGHTNING_WALLET_FAILED" });
  }
  if (localWallet.lightning?.nwc) {
    let wallet: AgentLightningWallet | null = null;
    try { wallet = await agent.lightningWallet.get(); } catch { /* an offline read is fine */ }
    if (wallet && wallet.status !== "active") return { localWallet, wallet, outcome: wallet.status };
    return { localWallet, wallet, outcome: "present" };
  }
  let wallet: AgentLightningWallet;
  try {
    wallet = await agent.lightningWallet.mint({ timeoutMs: options.timeoutMs ?? LIGHTNING_MINT_TIMEOUT_MS });
  } catch (err) {
    const code = (err as { body?: { code?: string } })?.body?.code ?? (err as { code?: string })?.code;
    if (code === "LIGHTNING_WALLET_NOT_AVAILABLE") return { localWallet, wallet: null, outcome: "unavailable", error: err };
    if (code === "LIGHTNING_WALLET_STILL_MINTING") return { localWallet, wallet: null, outcome: "minting", error: err };
    throw err;
  }
  if (wallet.status === "minting") return { localWallet, wallet, outcome: "minting" };
  if (wallet.status !== "active") return { localWallet, wallet, outcome: wallet.status };
  if (typeof wallet.pairing !== "string") return { localWallet, wallet, outcome: "pairing_lost" };
  localWallet = storePairing(localWallet, wallet);
  return { localWallet, wallet, outcome: "stored" };
}

/** Revoke on the platform and forget the pairing locally; the rail returns to x402. */
export async function revokeLightningWallet(agent: LightningAgent): Promise<unknown> {
  const localWallet = readWallet();
  let wallet: unknown = null;
  try {
    wallet = await agent.lightningWallet.revoke();
  } catch (err) {
    const code = (err as { body?: { code?: string } })?.body?.code ?? (err as { code?: string })?.code;
    if (code !== "LIGHTNING_WALLET_NOT_FOUND") throw err;
  }
  if (localWallet) {
    const { lightning: _dropped, ...rest } = localWallet;
    saveWallet({ ...rest, rail: rest.rail === "lightning" ? "x402" : rest.rail });
  }
  return wallet;
}
