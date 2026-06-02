/**
 * `wallets` namespace — server-side wallet display label.
 *
 * The label is the cross-machine / WEB-visible human name for a wallet (e.g.
 * "kychon"), stored server-side keyed by the wallet address and authenticated
 * by the wallet's allowance signature. It is display metadata only — never key
 * material, no custody.
 *
 * Both methods are intentionally BEST-EFFORT: they swallow errors (including a
 * not-yet-deployed endpoint / 404 / offline) and return a null/`ok:false`
 * sentinel instead of throwing. This lets `run402 wallets new|rename|import`
 * stay fully functional locally and before the gateway endpoint ships — the
 * local folder name is always the source of truth; the server label is a
 * mirror that catches up.
 */

import type { Client } from "../kernel.js";

interface WalletLabelPayload {
  address?: string;
  label?: string | null;
}

export class Wallets {
  constructor(private readonly client: Client) {}

  /**
   * Read a wallet's server-side label, or null on any error (unset, 404,
   * offline). Public read — no auth required.
   */
  async getLabel(address: string): Promise<string | null> {
    try {
      const res = await this.client.request<WalletLabelPayload>(
        `/wallets/v1/${encodeURIComponent(address)}/label`,
        { context: "reading wallet label", withAuth: false },
      );
      return res?.label ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Set a wallet's server-side label. Signed by the wallet's allowance
   * (withAuth). Returns `{ ok: true }` on success, `{ ok: false }` on any
   * failure — never throws, so callers don't need try/catch around an offline
   * best-effort sync.
   */
  async setLabel(address: string, label: string): Promise<{ ok: boolean }> {
    try {
      await this.client.request(
        `/wallets/v1/${encodeURIComponent(address)}/label`,
        { method: "PUT", context: "setting wallet label", withAuth: true, body: { label } },
      );
      return { ok: true };
    } catch {
      return { ok: false };
    }
  }
}
