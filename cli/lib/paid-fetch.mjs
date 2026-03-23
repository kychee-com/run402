/**
 * Shared payment wrapper for CLI commands that need paid fetch.
 * Branches on allowance rail:
 *   - "mpp": uses mppx.fetch (Tempo pathUSD)
 *   - "x402" (default): uses @x402/fetch (Base USDC)
 *
 * Checks on-chain balances at setup time and selects funded networks.
 */

import { readAllowance, ALLOWANCE_FILE } from "./config.mjs";
import { existsSync } from "fs";

const USDC_ABI = [{ name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ name: "account", type: "address" }], outputs: [{ name: "", type: "uint256" }] }];
const USDC_MAINNET = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const USDC_SEPOLIA = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const PATH_USD = "0x20c0000000000000000000000000000000000000";
const TEMPO_RPC = "https://rpc.moderato.tempo.xyz/";

async function checkBalance(publicClient, tokenAddress, walletAddress) {
  try {
    const raw = await publicClient.readContract({
      address: tokenAddress,
      abi: USDC_ABI,
      functionName: "balanceOf",
      args: [walletAddress],
    });
    return Number(raw);
  } catch {
    return 0;
  }
}

export async function setupPaidFetch() {
  if (!existsSync(ALLOWANCE_FILE)) {
    console.error(JSON.stringify({ status: "error", message: "No agent allowance found. Run: run402 allowance create && run402 allowance fund" }));
    process.exit(1);
  }
  const allowance = readAllowance();
  const { privateKeyToAccount } = await import("viem/accounts");
  const account = privateKeyToAccount(allowance.privateKey);

  if (allowance.rail === "mpp") {
    const { createPublicClient, http, defineChain } = await import("viem");
    const tempoModerato = defineChain({
      id: 42431,
      name: "Tempo Moderato",
      nativeCurrency: { name: "pathUSD", symbol: "pathUSD", decimals: 6 },
      rpcUrls: { default: { http: [TEMPO_RPC] } },
    });
    const tempoClient = createPublicClient({ chain: tempoModerato, transport: http() });
    const balance = await checkBalance(tempoClient, PATH_USD, allowance.address);
    if (balance === 0) {
      console.error(JSON.stringify({
        status: "error",
        message: `No pathUSD balance on Tempo Moderato (0). Fund your wallet: run402 allowance fund`,
      }));
      process.exit(1);
    }

    const { Mppx, tempo } = await import("mppx/client");
    const mppx = Mppx.create({
      polyfill: false,
      methods: [tempo({ account })],
    });
    return mppx.fetch;
  }

  // Default: x402
  const { createPublicClient, http } = await import("viem");
  const { base, baseSepolia } = await import("viem/chains");
  const { x402Client, wrapFetchWithPayment } = await import("@x402/fetch");
  const { ExactEvmScheme } = await import("@x402/evm/exact/client");
  const { toClientEvmSigner } = await import("@x402/evm");

  const mainnetClient = createPublicClient({ chain: base, transport: http() });
  const sepoliaClient = createPublicClient({ chain: baseSepolia, transport: http() });

  // Check balances in parallel
  const [mainnetBalance, sepoliaBalance] = await Promise.all([
    checkBalance(mainnetClient, USDC_MAINNET, allowance.address),
    checkBalance(sepoliaClient, USDC_SEPOLIA, allowance.address),
  ]);

  if (mainnetBalance === 0 && sepoliaBalance === 0) {
    console.error(JSON.stringify({
      status: "error",
      message: `No USDC balance on any supported network (Base: $${(mainnetBalance / 1e6).toFixed(2)}, Base Sepolia: $${(sepoliaBalance / 1e6).toFixed(2)}). Fund your wallet or run: run402 allowance fund`,
    }));
    process.exit(1);
  }

  const client = new x402Client();
  client.register("eip155:8453", new ExactEvmScheme(toClientEvmSigner(account, mainnetClient)));
  client.register("eip155:84532", new ExactEvmScheme(toClientEvmSigner(account, sepoliaClient)));

  // Policy: only allow networks where the wallet has funds
  client.registerPolicy((_version, reqs) => {
    const funded = reqs.filter((r) => {
      if (r.network === "eip155:8453") return mainnetBalance > 0;
      if (r.network === "eip155:84532") return sepoliaBalance > 0;
      return false;
    });
    return funded.length > 0 ? funded : reqs;
  });

  return wrapFetchWithPayment(fetch, client);
}
