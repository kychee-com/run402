import {
  createWalletClient,
  createPublicClient,
  http,
  parseUnits,
  encodeFunctionData,
  isAddress,
  type Address,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { FAUCET_TREASURY_KEY, FAUCET_DRIP_AMOUNT, FAUCET_REFILL_INTERVAL, CDP_API_KEY_ID, CDP_API_KEY_SECRET } from "../config.js";

// Base Sepolia USDC (Circle test token)
const USDC_ADDRESS: Address = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const USDC_DECIMALS = 6;

// Minimal ERC-20 ABI for transfer + balanceOf
const ERC20_ABI = [
  {
    name: "transfer",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

// Use `any` to avoid type conflicts between viem versions (direct vs transitive via @x402/evm)
let walletClient: any = null;
let publicClient: any = null;
let treasuryAddress: Address | null = null;

// Mutex for serializing drip transactions (avoids nonce conflicts)
let dripQueue: Promise<void> = Promise.resolve();

function ensureClients() {
  if (walletClient) return;
  if (!FAUCET_TREASURY_KEY) {
    throw new Error("FAUCET_TREASURY_KEY not configured");
  }

  const account = privateKeyToAccount(FAUCET_TREASURY_KEY as `0x${string}`);
  treasuryAddress = account.address;

  walletClient = createWalletClient({
    account,
    chain: baseSepolia,
    transport: http(),
  });

  publicClient = createPublicClient({
    chain: baseSepolia,
    transport: http(),
  });
}

/**
 * Send a USDC drip to the given address.
 * Serialized via promise queue to avoid nonce conflicts.
 */
export async function sendDrip(to: Address): Promise<string> {
  ensureClients();

  // Serialize via queue
  const result = new Promise<string>((resolve, reject) => {
    dripQueue = dripQueue.then(async () => {
      try {
        const amount = parseUnits(FAUCET_DRIP_AMOUNT, USDC_DECIMALS);

        // Check treasury balance
        const balance = await publicClient!.readContract({
          address: USDC_ADDRESS,
          abi: ERC20_ABI,
          functionName: "balanceOf",
          args: [treasuryAddress!],
        });

        if (balance < amount) {
          throw Object.assign(new Error("Treasury USDC balance too low"), { code: "TREASURY_LOW" });
        }

        // Send ERC-20 transfer
        const hash = await walletClient!.sendTransaction({
          to: USDC_ADDRESS,
          data: encodeFunctionData({
            abi: ERC20_ABI,
            functionName: "transfer",
            args: [to, amount],
          }),
        });

        resolve(hash);
      } catch (err) {
        reject(err);
      }
    });
  });

  return result;
}

/**
 * Refill treasury via CDP faucet (requests USDC + ETH).
 */
export async function refillTreasury(): Promise<void> {
  ensureClients();

  if (!CDP_API_KEY_ID || !CDP_API_KEY_SECRET) {
    console.warn("  Faucet refill: CDP API keys not configured, skipping");
    return;
  }

  try {
    const { CdpClient } = await import("@coinbase/cdp-sdk");
    const cdp = new CdpClient({
      apiKeyId: CDP_API_KEY_ID,
      apiKeySecret: CDP_API_KEY_SECRET,
    });

    // Request USDC
    await cdp.evm.requestFaucet({
      address: treasuryAddress!,
      network: "base-sepolia",
      token: "usdc",
    });
    console.log(`  Faucet refill: requested USDC for ${treasuryAddress}`);

    // Request ETH for gas
    await cdp.evm.requestFaucet({
      address: treasuryAddress!,
      network: "base-sepolia",
      token: "eth",
    });
    console.log(`  Faucet refill: requested ETH for ${treasuryAddress}`);
  } catch (err: any) {
    console.error(`  Faucet refill failed: ${err.message}`);
  }
}

let refillInterval: ReturnType<typeof setInterval> | null = null;

export function startFaucetRefill(): void {
  if (!FAUCET_TREASURY_KEY) {
    console.log("  Faucet: disabled (no FAUCET_TREASURY_KEY)");
    return;
  }

  // Initialize clients eagerly so startup fails fast on bad key
  ensureClients();
  console.log(`  Faucet: treasury ${treasuryAddress}`);

  // Refill immediately on startup
  refillTreasury();

  // Then refill on interval
  refillInterval = setInterval(refillTreasury, FAUCET_REFILL_INTERVAL);
  console.log(`  Faucet refill: every ${Math.round(FAUCET_REFILL_INTERVAL / 60000)}m`);
}

export function stopFaucetRefill(): void {
  if (refillInterval) {
    clearInterval(refillInterval);
    refillInterval = null;
  }
}

export { isAddress, USDC_ADDRESS, treasuryAddress };
