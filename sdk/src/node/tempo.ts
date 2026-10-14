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
