/** `run402.agent` — the calling agent principal's own control-plane facts. */

export type AgentLightningWalletStatus = "minting" | "active" | "revoking" | "revoked" | "failed";

/**
 * An agent principal's Lightning wallet: one budgeted, isolated sub-wallet on
 * Run402's Hub (`custody: "run402_hub"`). `pairing` is present exactly once,
 * on the response that first hands it out; store it in the local profile and
 * never send it back to Run402.
 */
export interface AgentLightningWallet {
  wallet_id: string;
  status: AgentLightningWalletStatus;
  network: "regtest" | "signet" | "mainnet";
  custody: "run402_hub";
  custody_note?: string;
  lightning_address: string | null;
  budget_sats: number;
  starter_sats: number;
  has_pairing: boolean;
  pairing?: string;
  pairing_claimed_at: string | null;
  failure_reason: string | null;
  created_at: string;
  activated_at: string | null;
  revoked_at: string | null;
  next_actions?: Array<{ type: string; why: string; call?: string }>;
}

export interface AgentLightningWalletWaitOptions {
  /** How long to poll for the broker to activate the wallet (default 30 s). */
  timeoutMs?: number;
  /** Poll interval (default 2 s). */
  intervalMs?: number;
}
