/**
 * `wallets` namespace — the agent's local wallet and its server-side label.
 *
 * `status`, `create`, and `export` touch the local wallet file (`wallet.json`)
 * through optional provider methods; sandbox providers that don't implement
 * them report `{configured: false}` or throw a descriptive error. `faucet`
 * requests testnet USDC into the wallet and works in any environment.
 *
 * The label is the cross-machine / WEB-visible human name for a wallet (e.g.
 * "kychon"), stored server-side keyed by the wallet address and authenticated
 * by the wallet's SIWX signature. It is display metadata only — never key
 * material, no custody.
 *
 * Both label methods are intentionally BEST-EFFORT: they swallow errors (including a
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

import { gateSecret } from "../secret-gate.js";
import type { Client } from "../kernel.js";
import type { WalletData } from "../credentials.js";
import { LocalError } from "../errors.js";

export interface WalletStatusResult {
  address: string;
  created?: string;
  /**
   * True once the faucet has been invoked on this wallet. This tracks
   * "faucet has been used," not "account can pay right now" — the two diverge
   * once funds are spent or expire. Callers wanting a real pay-readiness
   * check should call `wallets balance`.
   */
  faucet_used?: boolean;
  lastFaucet?: string;
  path?: string;
  /** The persisted payment rail (`x402` when unset). */
  rail?: "x402" | "mpp" | "lightning";
  /** The Lightning wallet, without its pairing secret. */
  lightning?: {
    wallet_id: string;
    lightning_address: string | null;
    budget_sats: number;
    starter_sats: number;
    custody: "run402_hub";
    has_pairing: true;
    minted_at: string;
  };
  /** true when the local provider holds a wallet, false otherwise. */
  configured: boolean;
}

export interface WalletCreateResult {
  address: string;
  created: string;
  path?: string;
}

export interface FaucetResult {
  /** Present on gateways that wait for on-chain confirmation. */
  fundingStatus?: "confirmed";
  transactionHash: string;
  /** Display-formatted amount, e.g. `"0.25"`. Computed from `amountUsdMicros`. */
  amount: string;
  /** Raw amount in micro-USD (1_000_000 = $1.00). */
  amountUsdMicros: number;
  token: string;
  network: string;
}

export interface FaucetOptions {
  address?: string;
  idempotencyKey?: string;
}

interface FaucetWireBody {
  funding_status?: "confirmed";
  transaction_hash: string;
  amount_usd_micros: number;
  token: string;
  network: string;
}

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
      { method: "POST", context: "setting wallet label", withAuth: true, body: { label } },
    );
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

export class Wallets {
  constructor(private readonly client: Client) {}

  /** Inspect the local wallet. Returns `{configured: false}` when absent. */
  async status(): Promise<WalletStatusResult> {
    const reader = this.client.credentials.readWallet;
    if (!reader) {
      return { address: "", configured: false };
    }
    const data = await reader.call(this.client.credentials);
    if (!data) return { address: "", configured: false };
    return {
      address: data.address,
      created: data.created,
      // Map the on-disk `funded` marker (which only tracks faucet invocations)
      // to `faucet_used` in the output. `!!` coerces undefined → false so
      // callers can branch cleanly.
      faucet_used: !!data.funded,
      lastFaucet: data.lastFaucet,
      path: this.client.credentials.getWalletPath?.call(this.client.credentials),
      rail: data.rail ?? "x402",
      ...(data.lightning
        ? {
          lightning: {
            wallet_id: data.lightning.wallet_id,
            lightning_address: data.lightning.lightning_address,
            budget_sats: data.lightning.budget_sats,
            starter_sats: data.lightning.starter_sats,
            custody: data.lightning.custody,
            has_pairing: true as const,
            minted_at: data.lightning.minted_at,
          },
        }
        : {}),
      configured: true,
    };
  }

  /**
   * Generate a new wallet keypair and persist it. Throws when the
   * provider already holds a wallet (don't overwrite silently) or
   * when the provider doesn't support local wallet management.
   */
  async create(): Promise<WalletCreateResult> {
    gateSecret(this.client, "wallets.create");
    const reader = this.client.credentials.readWallet;
    const creator = this.client.credentials.createWallet;
    const saver = this.client.credentials.saveWallet;
    if (!creator || !saver) {
      throw new LocalError(
        "This credential provider does not support wallet creation. Use @run402/sdk/node for local wallet management.",
        "creating wallet",
      );
    }
    if (reader) {
      const existing = await reader.call(this.client.credentials);
      if (existing) {
        throw new LocalError(
          `Wallet already exists at ${
            this.client.credentials.getWalletPath?.call(this.client.credentials) ?? "(local path unknown)"
          }. Delete it manually to regenerate.`,
          "creating wallet",
        );
      }
    }
    const data: WalletData = await creator.call(this.client.credentials);
    await saver.call(this.client.credentials, data);
    return {
      address: data.address,
      created: data.created ?? new Date().toISOString(),
      path: this.client.credentials.getWalletPath?.call(this.client.credentials),
    };
  }

  /** Return the wallet address (safe to share). Throws if none is configured. */
  async export(): Promise<string> {
    const reader = this.client.credentials.readWallet;
    if (!reader) {
      throw new LocalError(
        "This credential provider does not expose the local wallet.",
        "exporting wallet",
      );
    }
    const data = await reader.call(this.client.credentials);
    if (!data) {
      throw new LocalError("No local wallet is configured.", "exporting wallet");
    }
    return data.address;
  }

  /**
   * Request testnet USDC from the Run402 faucet. When `address` is omitted,
   * the SDK uses the provider's local wallet address. Updates the
   * wallet's internal `funded` marker on success (surfaced as
   * `faucet_used` in `status()`).
   */
  async faucet(addressOrOptions?: string | FaucetOptions): Promise<FaucetResult> {
    const opts: FaucetOptions = typeof addressOrOptions === "string"
      ? { address: addressOrOptions }
      : addressOrOptions ?? {};
    let resolvedAddress = opts.address;
    if (!resolvedAddress) {
      const reader = this.client.credentials.readWallet;
      if (!reader) {
        throw new LocalError(
          "No address provided and no local wallet is available.",
          "requesting faucet funds",
        );
      }
      const data = await reader.call(this.client.credentials);
      if (!data) {
        throw new LocalError(
          "No address provided and no local wallet is configured.",
          "requesting faucet funds",
        );
      }
      resolvedAddress = data.address;
    }

    // Wire shape is snake_case (`transaction_hash`, `amount_usd_micros`);
    // normalize to the typed camelCase surface.
    const wire = await this.client.request<FaucetWireBody>("/faucet/v1", {
      method: "POST",
      ...(opts.idempotencyKey ? { headers: { "Idempotency-Key": opts.idempotencyKey } } : {}),
      body: { address: resolvedAddress },
      withAuth: false,
      context: "requesting faucet funds",
    });
    const result: FaucetResult = {
      ...(wire.funding_status ? { fundingStatus: wire.funding_status } : {}),
      transactionHash: wire.transaction_hash,
      amountUsdMicros: wire.amount_usd_micros,
      amount: (wire.amount_usd_micros / 1_000_000).toFixed(2),
      token: wire.token,
      network: wire.network,
    };

    // Best-effort update of the local wallet's funded/lastFaucet fields.
    const reader = this.client.credentials.readWallet;
    const saver = this.client.credentials.saveWallet;
    if (reader && saver) {
      try {
        const data = await reader.call(this.client.credentials);
        if (data) {
          await saver.call(this.client.credentials, {
            ...data,
            funded: true,
            lastFaucet: new Date().toISOString(),
          });
        }
      } catch {
        // non-fatal — the on-chain transfer succeeded
      }
    }

    return result;
  }

  /**
   * Read a wallet's server-side label, or null on any error (unset, 404,
   * offline). Public read — no auth required.
   */
  async getLabel(address: string): Promise<string | null> {
    return readLabel(this.client, address);
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
