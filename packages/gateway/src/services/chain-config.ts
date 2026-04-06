/**
 * Static registry of supported EVM chains for the KMS contract-wallet feature.
 *
 * Adding a chain is a code change + redeploy + new RPC URL secret in AWS
 * Secrets Manager. There is intentionally no DB-driven registry — see
 * design.md DD-3.
 */

export interface ChainConfig {
  /** Stable string used in API + DB rows (e.g. `base-mainnet`). */
  readonly name: string;
  /** EIP-155 chain id. */
  readonly chain_id: number;
  /** Native token ticker (used in display only). */
  readonly native_token: string;
  /** Block explorer base URL (no trailing slash). */
  readonly block_explorer: string;
  /** AWS Secrets Manager secret name holding the RPC URL. */
  readonly rpc_url_secret_key: string;
  /** Chainlink ETH/USD price feed contract address on this chain. */
  readonly chainlink_eth_usd_feed_address: string;
}

const _CHAINS: Record<string, ChainConfig> = {
  "base-mainnet": Object.freeze<ChainConfig>({
    name: "base-mainnet",
    chain_id: 8453,
    native_token: "ETH",
    block_explorer: "https://basescan.org",
    rpc_url_secret_key: "run402/base-mainnet-rpc-url",
    // Chainlink ETH/USD on Base mainnet
    chainlink_eth_usd_feed_address: "0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70",
  }),
  "base-sepolia": Object.freeze<ChainConfig>({
    name: "base-sepolia",
    chain_id: 84532,
    native_token: "ETH",
    block_explorer: "https://sepolia.basescan.org",
    rpc_url_secret_key: "run402/base-sepolia-rpc-url",
    // Chainlink ETH/USD on Base Sepolia
    chainlink_eth_usd_feed_address: "0x4aDC67696bA383F43DD60A9e78F2C97Fbbfc7cb1",
  }),
};

export const CHAINS: Readonly<Record<string, ChainConfig>> = Object.freeze(_CHAINS);

export function getChain(name: string): ChainConfig {
  const c = CHAINS[name];
  if (!c) {
    throw new Error(`unsupported_chain: ${name || "<empty>"}`);
  }
  return c;
}

export function listChains(): ChainConfig[] {
  return Object.values(CHAINS);
}

export function isSupportedChain(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(CHAINS, name);
}
