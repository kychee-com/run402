import { gateSecret } from "../secret-gate.js";
import type { Client } from "../kernel.js";
import { LocalError } from "../errors.js";
import type {
  AgentLightningWallet,
  AgentLightningWalletWaitOptions,
} from "./agent.types.js";

/**
 * The calling agent's Lightning wallet:
 * `POST/GET/DELETE /agent/v1/lightning-wallet`. Run402 mints one budgeted,
 * isolated sub-wallet per principal on its own Hub; the pairing secret is
 * returned exactly once. `mint()` waits for the platform-side broker by
 * default so the one call that first sees the wallet active receives the
 * pairing.
 */
export class AgentLightningWallets {
  constructor(private readonly client: Client) {}

  /**
   * Mint (idempotent per principal) and, unless `wait` is false, poll until
   * the wallet is active or the wait times out. The returned wallet carries
   * `pairing` only when this call is the one that first observed it active.
   */
  async mint(opts: AgentLightningWalletWaitOptions & { wait?: boolean } = {}): Promise<AgentLightningWallet> {
    gateSecret(this.client, "agent.lightningWallet.mint", opts);
    const first = await this.client.request<AgentLightningWallet>("/agent/v1/lightning-wallet", {
      method: "POST",
      context: "minting a Lightning wallet",
    });
    if (first.status !== "minting" || opts.wait === false) return first;
    return this.waitForActive(opts);
  }

  /** The wallet's facts; the first read of an active wallet hands out `pairing` once. */
  async get(): Promise<AgentLightningWallet> {
    gateSecret(this.client, "agent.lightningWallet.get");
    return this.client.request<AgentLightningWallet>("/agent/v1/lightning-wallet", {
      method: "GET",
      context: "reading the Lightning wallet",
    });
  }

  /** Poll `get()` until the wallet leaves `minting`. */
  async waitForActive(opts: AgentLightningWalletWaitOptions = {}): Promise<AgentLightningWallet> {
    gateSecret(this.client, "agent.lightningWallet.waitForActive", opts);
    const timeoutMs = opts.timeoutMs ?? 30_000;
    const intervalMs = opts.intervalMs ?? 2_000;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const wallet = await this.get();
      if (wallet.status !== "minting") return wallet;
      if (Date.now() + intervalMs > deadline) {
        throw new LocalError(
          `The Lightning wallet is still minting after ${Math.round(timeoutMs / 1000)} s; read it again later with agent.lightningWallet.get().`,
          "waiting for the Lightning wallet",
          { code: "LIGHTNING_WALLET_STILL_MINTING", details: { wallet_id: wallet.wallet_id } },
        );
      }
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }

  /** Revoke: the sub-wallet is deleted on the Hub and the pairing stops paying. */
  async revoke(): Promise<AgentLightningWallet> {
    return this.client.request<AgentLightningWallet>("/agent/v1/lightning-wallet", {
      method: "DELETE",
      context: "revoking the Lightning wallet",
    });
  }
}

export class Agent {
  /** The Lightning wallet: a platform-minted, budgeted wallet on Run402's Hub. */
  readonly lightningWallet: AgentLightningWallets;

  constructor(client: Client) {
    this.lightningWallet = new AgentLightningWallets(client);
  }
}
