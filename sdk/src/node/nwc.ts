/**
 * The agent's Lightning wallet over Nostr Wallet Connect (NIP-47): the
 * budgeted sub-wallet Run402 minted on its Hub (`run402 init lightning`), or
 * any wallet the agent pairs. The protocol (pairing URIs, NIP-44 v2, signed
 * events, the relay connection) is `@run402/nwc`; this module adds the wallet
 * verbs the Lightning rail needs. The pairing URI carries the client's secret
 * key: nothing here logs or returns it.
 *
 * Node ≥ 22 (global `WebSocket`).
 */
import { NwcError, createNwcRelayPool, nwcRequest, parseNwcUri, type NwcConnection, type NwcTransport } from "@run402/nwc";

export { NWC_TRANSPORT_ERROR_CODES, NwcError, parseNwcUri, type NwcConnection, type NwcTransport } from "@run402/nwc";

const DEFAULT_TIMEOUT_MS = 30_000;

/** Nostr wire time: unix seconds (the protocol's own field name). */
export type UnixSeconds = number;

// The default pool closes an idle socket after 1.5 s, so a one-shot CLI
// process exits promptly; long-lived callers keep it warm by talking.
const pool = createNwcRelayPool();

/** Closes every standing relay connection (process exit, tests). */
export function closeNwcConnections(): void {
  pool.close();
}

/** The agent-side wallet verbs the Lightning rail needs. Amounts are in sats. */
export class NwcWallet {
  private readonly connection: NwcConnection;

  constructor(pairingUri: string, private readonly options: { timeoutMs?: number; transport?: NwcTransport } = {}) {
    this.connection = parseNwcUri(pairingUri);
  }

  private call<T = Record<string, unknown>>(method: string, params: Record<string, unknown>): Promise<T> {
    return nwcRequest<T>(this.connection, method, params, {
      timeoutMs: this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      transport: this.options.transport ?? pool.transport,
    });
  }

  /** The node behind the pairing: its network name, pubkey, and permitted methods. */
  async getInfo(): Promise<{ network: string | null; pubkey: string | null; methods: string[] }> {
    const result = await this.call<{ network?: string; pubkey?: string; methods?: unknown }>("get_info", {});
    return {
      network: typeof result.network === "string" ? result.network.toLowerCase() : null,
      pubkey: typeof result.pubkey === "string" ? result.pubkey.toLowerCase() : null,
      methods: Array.isArray(result.methods) ? result.methods.map(String) : [],
    };
  }

  async getBalanceSats(): Promise<number> {
    const result = await this.call<{ balance?: number }>("get_balance", {});
    return Math.floor(Number(result.balance ?? 0) / 1_000);
  }

  /** Remaining budget in sats, or null when the wallet has no budget. */
  async getBudgetSats(): Promise<{ usedSats: number; totalSats: number | null; renewsAtSeconds: UnixSeconds | null } | null> {
    let result: Record<string, unknown>;
    try {
      result = await this.call("get_budget", {});
    } catch (error) {
      if (error instanceof NwcError && (error.code === "NOT_IMPLEMENTED" || error.code === "RESTRICTED")) return null;
      throw error;
    }
    const total = result["total_budget"];
    if (total === undefined || total === null) return null;
    const renews = result["renews_at"];
    return {
      usedSats: Math.floor(Number(result["used_budget"] ?? 0) / 1_000),
      totalSats: Math.floor(Number(total) / 1_000),
      renewsAtSeconds: typeof renews === "number" ? renews : null,
    };
  }

  /** Pays a BOLT11 invoice; returns the preimage (hex) the wallet reports. */
  async payInvoice(bolt11: string): Promise<{ preimage: string; feesPaidMsat: number | null }> {
    const result = await this.call<{ preimage?: string; fees_paid?: number }>("pay_invoice", { invoice: bolt11 });
    const preimage = typeof result.preimage === "string" ? result.preimage.toLowerCase() : "";
    if (!/^[0-9a-f]{64}$/.test(preimage)) throw new NwcError("BAD_RESPONSE", "pay_invoice returned no preimage");
    return { preimage, feesPaidMsat: typeof result.fees_paid === "number" ? result.fees_paid : null };
  }

  /** Looks an invoice up by payment hash; a settled outgoing payment carries its preimage. */
  async lookupInvoice(paymentHash: string): Promise<{ state: string | null; preimage: string | null } | null> {
    try {
      const result = await this.call<{ state?: string; preimage?: string }>("lookup_invoice", { payment_hash: paymentHash });
      const preimage = typeof result.preimage === "string" && /^[0-9a-f]{64}$/i.test(result.preimage) ? result.preimage.toLowerCase() : null;
      return { state: typeof result.state === "string" ? result.state.toLowerCase() : null, preimage };
    } catch (error) {
      if (error instanceof NwcError && error.code === "NOT_FOUND") return null;
      throw error;
    }
  }
}
