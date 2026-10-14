/**
 * The wallet's on-chain token balances, one per network a rail pays on, under
 * the snake_case keys `run402 wallets balance`, `run402 status`, and
 * `run402 init` share (spec `status-account-balances`). Test money and real
 * money are separate keys: a sum alone would hide which one the wallet holds.
 *
 * Every read is best-effort: a network whose read fails is `null`, never 0.
 */
import { PATH_USD, TEMPO_MAINNET, TEMPO_MODERATO, type TempoChain } from "./tempo.js";

const BALANCE_OF_ABI = [{ name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ name: "account", type: "address" }], outputs: [{ name: "", type: "uint256" }] }] as const;
const USDC_MAINNET = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const USDC_SEPOLIA = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";

export interface OnChainBalances {
  /** USDC on Base mainnet, USD micros. */
  base_mainnet_usd_micros: number | null;
  /** USDC on Base Sepolia (test money), USD micros. */
  base_sepolia_usd_micros: number | null;
  /** pathUSD on Tempo mainnet, USD micros. */
  tempo_mainnet_pathusd_micros: number | null;
  /** pathUSD on Tempo Moderato (test money), USD micros. */
  tempo_moderato_pathusd_micros: number | null;
}

export type OnChainBalanceKey = keyof OnChainBalances;

export const ALL_ON_CHAIN_BALANCE_KEYS: readonly OnChainBalanceKey[] = [
  "base_mainnet_usd_micros",
  "base_sepolia_usd_micros",
  "tempo_mainnet_pathusd_micros",
  "tempo_moderato_pathusd_micros",
];

/**
 * The networks a rail pays on: Tempo for `mpp`; Base for `x402` and for
 * `lightning`, whose fallback is x402.
 */
export function railBalanceKeys(rail: string | null | undefined): OnChainBalanceKey[] {
  return rail === "mpp"
    ? ["tempo_mainnet_pathusd_micros", "tempo_moderato_pathusd_micros"]
    : ["base_mainnet_usd_micros", "base_sepolia_usd_micros"];
}

/** Reads one network's balance in USD micros; throws when the read fails. */
export type BalanceReader = (key: OnChainBalanceKey, address: string) => Promise<number>;

async function defaultReader(): Promise<BalanceReader> {
  const { createPublicClient, defineChain, http } = await import("viem");
  const { base, baseSepolia } = await import("viem/chains");
  const tempo = (chain: TempoChain) => defineChain({
    id: chain.id,
    name: chain.name,
    nativeCurrency: { name: "pathUSD", symbol: "pathUSD", decimals: 6 },
    rpcUrls: { default: { http: [chain.rpcUrl] } },
  });
  const targets: Record<OnChainBalanceKey, { chain: unknown; token: string }> = {
    base_mainnet_usd_micros: { chain: base, token: USDC_MAINNET },
    base_sepolia_usd_micros: { chain: baseSepolia, token: USDC_SEPOLIA },
    tempo_mainnet_pathusd_micros: { chain: tempo(TEMPO_MAINNET), token: PATH_USD },
    tempo_moderato_pathusd_micros: { chain: tempo(TEMPO_MODERATO), token: PATH_USD },
  };
  return async (key, address) => {
    const { chain, token } = targets[key];
    const client = createPublicClient({ chain: chain as Parameters<typeof createPublicClient>[0]["chain"], transport: http() });
    const raw = await client.readContract({
      address: token as `0x${string}`,
      abi: BALANCE_OF_ABI,
      functionName: "balanceOf",
      args: [address as `0x${string}`],
    });
    return Number(raw);
  };
}

/** Read the given networks in parallel; a failed read is `null`. */
export async function readOnChainBalances(
  address: string,
  keys: readonly OnChainBalanceKey[] = ALL_ON_CHAIN_BALANCE_KEYS,
  reader?: BalanceReader,
): Promise<Partial<OnChainBalances>> {
  let read: BalanceReader;
  try {
    read = reader ?? await defaultReader();
  } catch {
    return Object.fromEntries(keys.map((key) => [key, null]));
  }
  const values = await Promise.all(keys.map((key) => read(key, address).catch(() => null)));
  return Object.fromEntries(keys.map((key, i) => [key, values[i]]));
}

/** The sum over `keys`, or null when every one of them is unknown. */
export function sumOnChainBalances(balances: Partial<OnChainBalances>, keys: readonly OnChainBalanceKey[]): number | null {
  const known = keys.map((key) => balances[key]).filter((value): value is number => typeof value === "number");
  return known.length === 0 ? null : known.reduce((total, value) => total + value, 0);
}
