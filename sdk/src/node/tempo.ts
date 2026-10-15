/**
 * The two Tempo chains MPP on Tempo pays on (spec `mpp-tempo-client-surface`).
 *
 * Run402 offers both on every Tempo-priced SKU, in an order that states its
 * preference: mainnet first on paid SKUs, Moderato first on the free prototype
 * tier. pathUSD lives at the same address on both. Tempo has no native gas
 * token; the sender pays its transaction fee in a stablecoin, so a payment
 * needs a little pathUSD beyond the price.
 */

export const PATH_USD = "0x20c0000000000000000000000000000000000000" as const;

export interface TempoChain {
  id: number;
  /** CAIP-2 network id, as payment requirements and errors name it. */
  network: `eip155:${number}`;
  name: string;
  rpcUrl: string;
  /** The key this chain's balance is reported under in CLI and SDK JSON. */
  balanceKey: "tempo_mainnet_pathusd_micros" | "tempo_moderato_pathusd_micros";
  testnet: boolean;
}

export const TEMPO_MAINNET: TempoChain = {
  id: 4217,
  network: "eip155:4217",
  name: "Tempo",
  rpcUrl: "https://rpc.tempo.xyz",
  balanceKey: "tempo_mainnet_pathusd_micros",
  testnet: false,
};

export const TEMPO_MODERATO: TempoChain = {
  id: 42431,
  network: "eip155:42431",
  name: "Tempo Moderato",
  rpcUrl: "https://rpc.moderato.tempo.xyz",
  balanceKey: "tempo_moderato_pathusd_micros",
  testnet: true,
};

export const TEMPO_CHAINS: readonly TempoChain[] = [TEMPO_MAINNET, TEMPO_MODERATO];

export function tempoChainById(id: unknown): TempoChain | null {
  return TEMPO_CHAINS.find((chain) => chain.id === Number(id)) ?? null;
}

/**
 * pathUSD (USD micros) a payment needs beyond the price, for the sender's
 * Tempo transaction fee.
 */
export const TEMPO_FEE_HEADROOM_USD_MICROS = 5_000n;

/** The outcome of one Tempo testnet faucet request. */
export type TempoFaucetOutcome =
  | { funded: true }
  | { funded: false; message: string };

/**
 * Ask a Tempo testnet's faucet (the `tempo_fundAddress` JSON-RPC method on
 * the chain's own node) to fund `address` with test pathUSD. The faucet
 * settles on-chain after it answers, so a balance read right after may still
 * show zero; callers poll. The one place the SDK, `r.init()`, and the CLI's
 * `wallets fund` all request Tempo test money. Network failures propagate;
 * a faucet refusal is `{ funded: false, message }`.
 */
export async function requestTempoFaucet(address: string, chain: TempoChain = TEMPO_MODERATO): Promise<TempoFaucetOutcome> {
  if (!chain.testnet) {
    return { funded: false, message: `${chain.name} is a mainnet; it has no faucet` };
  }
  const res = await fetch(chain.rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method: "tempo_fundAddress", params: [address], id: 1 }),
  });
  const data = (await res.json().catch(() => null)) as { result?: unknown; error?: { message?: string } } | null;
  if (data?.result) return { funded: true };
  return { funded: false, message: data?.error?.message || "Tempo faucet failed" };
}
