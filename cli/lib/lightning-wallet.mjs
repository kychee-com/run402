/**
 * The Lightning wallet on the CLI: mint the agent's budgeted wallet on
 * Run402's Hub, keep its pairing in the active profile's wallet.json
 * beside the Base key, report its balance, revoke it. Shared by
 * `run402 init lightning`, `run402 wallets lightning …`, and
 * `run402 wallets current`. The pairing secret is never printed.
 */
import { readWallet, saveWallet } from "../core-dist/wallet.js";
import { getSdk } from "./sdk.mjs";

export const LIGHTNING_MINT_TIMEOUT_MS = 45_000;

/** Public facts only: never the pairing. */
export function describeLightning(localWallet, wallet = null, balance = null) {
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
export async function readLightningBalance(localWallet) {
  const nwc = localWallet?.lightning?.nwc;
  if (!nwc) return null;
  try {
    const { NwcWallet, closeNwcConnections } = await import("#sdk/node");
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

function storePairing(localWallet, wallet) {
  const next = {
    ...localWallet,
    rail: "lightning",
    lightning: {
      wallet_id: wallet.wallet_id,
      nwc: wallet.pairing,
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
 * Ensure the active profile holds an active Lightning wallet. Returns
 * `{ localWallet, wallet, outcome }` where outcome is `stored` (pairing just
 * saved), `present` (already held locally), `minting` (the platform is still
 * minting; rerun later), `unavailable` (no Hub on this gateway), or
 * `pairing_lost` (the wallet is active but its one-time pairing was handed to
 * another machine; revoke and mint again).
 */
export async function ensureLightningWallet(options = {}) {
  let localWallet = readWallet();
  if (!localWallet) throw new Error("no local wallet configured; run `run402 init` first");
  if (localWallet.lightning?.nwc) {
    let wallet = null;
    try { wallet = await getSdk().agent.lightningWallet.get(); } catch { /* offline read is fine */ }
    if (wallet && wallet.status !== "active") return { localWallet, wallet, outcome: wallet.status };
    return { localWallet, wallet, outcome: "present" };
  }
  let wallet;
  try {
    wallet = await getSdk().agent.lightningWallet.mint({ timeoutMs: options.timeoutMs ?? LIGHTNING_MINT_TIMEOUT_MS });
  } catch (err) {
    const code = err?.body?.code ?? err?.code;
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
export async function revokeLightningWallet() {
  const localWallet = readWallet();
  let wallet = null;
  try {
    wallet = await getSdk().agent.lightningWallet.revoke();
  } catch (err) {
    const code = err?.body?.code ?? err?.code;
    if (code !== "LIGHTNING_WALLET_NOT_FOUND") throw err;
  }
  if (localWallet) {
    const { lightning: _dropped, ...rest } = localWallet;
    saveWallet({ ...rest, rail: rest.rail === "lightning" ? "x402" : rest.rail });
  }
  return wallet;
}
