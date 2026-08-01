import { LocalError } from "../errors.js";

export const APPROVED_LIGHTNING_WALLET_PROVIDER =
  "alby_hub_lnd_fixed_fee_v1" as const;
export const APPROVED_ALBY_HUB_COMMIT =
  "32af89bc8c6626d6b8cf35c53c1b2fcdc38950ec" as const;

export type LightningWalletNetwork = "regtest" | "mainnet";

export type LightningWalletPaymentState =
  | "settled"
  | "pending"
  | "failed"
  | "unknown";

export interface LightningWalletPaymentResult {
  state: LightningWalletPaymentState;
  paymentHash: string;
  walletRequestId: string | null;
  invoiceAmountMsat: number | null;
  feesPaidMsat: number | null;
  totalDebitMsat: number | null;
  /** Immediate credential material. The buyer keeps it in memory only. */
  preimageHex?: string;
  providerReference?: string | null;
  failureCode?: string | null;
}

export interface PreparedLightningWalletPayment {
  walletRequestId: string;
  providerFeeCeilingMsat: number;
  dispatch(): Promise<LightningWalletPaymentResult>;
}

export interface LightningWalletAdapter {
  readonly alias: `nwc:${string}`;
  readonly provider: typeof APPROVED_LIGHTNING_WALLET_PROVIDER;
  readonly providerCommit: typeof APPROVED_ALBY_HUB_COMMIT;
  readonly backend: "lnd";
  readonly feePolicy: "max_1pct_or_10000msat";
  readonly network: LightningWalletNetwork;
  readonly payeeNodePubkeys: readonly string[];
  readonly atomicFeeCap: true;

  preparePayment(input: {
    invoice: string;
    paymentHash: string;
    invoiceAmountMsat: number;
    authorizedMaxFeeMsat: number;
  }): Promise<PreparedLightningWalletPayment>;

  lookupPayment(input: {
    paymentHash: string;
    walletRequestId?: string | null;
  }): Promise<LightningWalletPaymentResult>;
}

export function albyHubProviderFeeCeilingMsat(invoiceAmountMsat: number): number {
  if (!Number.isSafeInteger(invoiceAmountMsat) || invoiceAmountMsat <= 0) {
    throw lightningWalletError("LIGHTNING_INVOICE_AMOUNT_INVALID");
  }
  return Math.max(Math.ceil(invoiceAmountMsat / 100), 10_000);
}

export function assertApprovedLightningWalletAdapter(
  adapter: LightningWalletAdapter,
): void {
  if (adapter.provider !== APPROVED_LIGHTNING_WALLET_PROVIDER ||
      adapter.providerCommit !== APPROVED_ALBY_HUB_COMMIT ||
      adapter.backend !== "lnd" || adapter.feePolicy !== "max_1pct_or_10000msat" ||
      adapter.atomicFeeCap !== true ||
      (adapter.network !== "regtest" && adapter.network !== "mainnet") ||
      !/^nwc:[a-z0-9][a-z0-9_-]{0,63}$/.test(adapter.alias) ||
      adapter.payeeNodePubkeys.length === 0 ||
      adapter.payeeNodePubkeys.some((key) => !/^(02|03)[0-9a-f]{64}$/i.test(key))) {
    throw lightningWalletError("PAYMENT_WALLET_ADAPTER_NOT_APPROVED");
  }
}

function lightningWalletError(code: string): LocalError {
  return new LocalError(code, "using Lightning payment wallet", { code });
}
