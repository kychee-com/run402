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
 *
 * Canonical call shape is the wallet-scoped handle: `r.wallet(address)` →
 * `.getLabel()` / `.setLabel(label)`. The two-string `r.wallets.setLabel(address,
 * label)` form is deprecated (see the `sdk-call-shape-conventions` change).
 */

import type { Client } from "../kernel.js";
import { deprecatePositional } from "../deprecate.js";

interface WalletLabelPayload {
  address?: string;
  label?: string | null;
}

/** Shared read impl — used by both `Wallets.getLabel` and `ScopedWallet.getLabel`. */
async function readLabel(client: Client, address: string): Promise<string | null> {
  try {
    const res = await client.request<WalletLabelPayload>(
      `/wallets/v1/${encodeURIComponent(address)}/label`,
      { context: "reading wallet label", withAuth: false },
    );
    return res?.label ?? null;
  } catch {
    return null;
  }
}

/** Shared write impl — used by both `Wallets.setLabel` and `ScopedWallet.setLabel`. */
async function putLabel(client: Client, address: string, label: string): Promise<{ ok: boolean }> {
  try {
    await client.request(
      `/wallets/v1/${encodeURIComponent(address)}/label`,
      { method: "PUT", context: "setting wallet label", withAuth: true, body: { label } },
    );
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

export class Wallets {
  constructor(private readonly client: Client) {}

  /**
   * Read a wallet's server-side label, or null on any error (unset, 404,
   * offline). Public read — no auth required.
   */
  async getLabel(address: string): Promise<string | null> {
    return readLabel(this.client, address);
  }

  /**
   * Set a wallet's server-side label. Signed by the wallet's allowance
   * (withAuth). Returns `{ ok: true }` on success, `{ ok: false }` on any
   * failure — never throws, so callers don't need try/catch around an offline
   * best-effort sync.
   *
   * @deprecated The two-string positional form is swap-prone. Use
   * `r.wallet(address).setLabel(label)` instead.
   */
  async setLabel(address: string, label: string): Promise<{ ok: boolean }> {
    deprecatePositional("wallets.setLabel", "use r.wallet(address).setLabel(label)");
    return putLabel(this.client, address, label);
  }
}

/**
 * Wallet-scoped sub-client returned by `r.wallet(address)`. Binds the address
 * so neither label method takes it as a swappable positional. Lazy — no key or
 * network access at construction.
 */
export class ScopedWallet {
  constructor(private readonly client: Client, private readonly address: string) {}

  /** Read this wallet's server-side label, or null. */
  getLabel(): Promise<string | null> {
    return readLabel(this.client, this.address);
  }

  /** Set this wallet's server-side label. Best-effort; never throws. */
  setLabel(label: string): Promise<{ ok: boolean }> {
    return putLabel(this.client, this.address, label);
  }
}
