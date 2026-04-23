/**
 * Node-only x402-wrapped fetch. Reads the allowance file, checks on-chain
 * USDC balances in parallel, and returns a fetch wrapper that auto-signs 402
 * responses when the wallet has balance.
 *
 * Graceful degradation: returns null if no allowance is configured or the
 * optional payment libraries fail to load. Callers can fall back to an
 * unwrapped fetch and let 402s surface as `PaymentRequired` errors.
 *
 * Never calls `process.exit` — the SDK leaves exit-code decisions to the
 * CLI edge.
 */

import { readAllowance } from "../../core-dist/allowance.js";

type FetchFn = typeof globalThis.fetch;

const USDC_ABI = [
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;
const USDC_MAINNET = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const USDC_SEPOLIA = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";

async function checkBalance(
  publicClient: { readContract: (args: unknown) => Promise<bigint> },
  tokenAddress: string,
  walletAddress: string,
): Promise<number> {
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

export async function setupPaidFetch(): Promise<FetchFn | null> {
  const allowance = readAllowance();
  if (!allowance) return null;

  try {
    if (allowance.rail === "mpp") {
      const mppxMod = "mppx/client";
      const { Mppx, tempo } = (await import(/* webpackIgnore: true */ mppxMod)) as {
        Mppx: { create: (opts: unknown) => { fetch: FetchFn } };
        tempo: (opts: unknown) => unknown;
      };
      const { privateKeyToAccount } = await import("viem/accounts");
      const account = privateKeyToAccount(allowance.privateKey as `0x${string}`);
      const mppx = Mppx.create({
        polyfill: false,
        methods: [tempo({ account })],
      });
      return mppx.fetch;
    }

    // Default: x402 on Base + Base Sepolia
    const { privateKeyToAccount } = await import("viem/accounts");
    const { createPublicClient, http } = await import("viem");
    const { base, baseSepolia } = await import("viem/chains");
    const { x402Client, wrapFetchWithPayment } = await import("@x402/fetch");
    const { ExactEvmScheme } = await import("@x402/evm/exact/client");
    const { toClientEvmSigner } = await import("@x402/evm");

    const account = privateKeyToAccount(allowance.privateKey as `0x${string}`);
    const mainnetClient = createPublicClient({ chain: base, transport: http() });
    const sepoliaClient = createPublicClient({ chain: baseSepolia, transport: http() });

    const [mainnetBalance, sepoliaBalance] = await Promise.all([
      checkBalance(mainnetClient as never, USDC_MAINNET, allowance.address),
      checkBalance(sepoliaClient as never, USDC_SEPOLIA, allowance.address),
    ]);

    const client = new x402Client() as unknown as {
      register: (network: string, scheme: unknown) => void;
      registerPolicy: (fn: (version: number, reqs: unknown[]) => unknown[]) => void;
    };
    client.register(
      "eip155:8453",
      new ExactEvmScheme(toClientEvmSigner(account, mainnetClient as never)),
    );
    client.register(
      "eip155:84532",
      new ExactEvmScheme(toClientEvmSigner(account, sepoliaClient as never)),
    );

    if (mainnetBalance > 0 || sepoliaBalance > 0) {
      client.registerPolicy((_version, reqs) => {
        const funded = reqs.filter((r) => {
          const net = (r as { network?: string }).network;
          if (net === "eip155:8453") return mainnetBalance > 0;
          if (net === "eip155:84532") return sepoliaBalance > 0;
          return false;
        });
        return funded.length > 0 ? funded : reqs;
      });
    }

    // Read `globalThis.fetch` fresh each call so test suites that swap the
    // global fetch after setupPaidFetch has already run still see their mocks.
    const dynamicFetch: FetchFn = (input, init) => globalThis.fetch(input, init);
    return wrapFetchWithPayment(dynamicFetch, client as never) as FetchFn;
  } catch {
    return null;
  }
}

/**
 * Returns a fetch that lazily initializes the x402 wrapper on first call.
 * This lets the Node `run402()` factory remain synchronous while deferring
 * the (async) on-chain balance check until the first request.
 */
export function createLazyPaidFetch(): FetchFn {
  let cached: FetchFn | null | undefined;
  return async (input, init) => {
    if (cached === undefined) {
      cached = await setupPaidFetch();
    }
    // Read `globalThis.fetch` fresh each call so test suites that override
    // it after the SDK is constructed still see their mocks.
    if (cached) return cached(input, init);
    return globalThis.fetch(input, init);
  };
}
