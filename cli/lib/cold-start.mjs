/**
 * `cold-start.mjs` — the minimal x402/Base-Sepolia cold-start chain
 * (kygit-handoff design D5): wallet → faucet → one x402 prototype
 * payment. `repos create` folds this in when it is
 * refused `NO_ACTIVE_TIER`, so `run402 repos create` on a genuinely fresh machine
 * ends with a vault, no human signup, no cloud dashboard.
 *
 * This is the SAME shape `run402 init` already walks (create the wallet →
 * balance check → faucet → tier), factored down to the x402/Base-Sepolia
 * default rail only (MPP/Tempo is `init`'s own separate concern — an agent
 * hitting NO_ACTIVE_TIER mid-`repos create` gets the default rail, not a
 * rail-selection prompt). `init.mjs`'s own richer flow (voucher redemption,
 * rail switching, astro scaffolding, its own help/exit-code contract) is
 * untouched; this module does not replace it, only the one path `repos
 * create` needs when it discovers there is no tier and nothing else has
 * set one up yet.
 *
 * add-room-invite design D9 splits the funded-wallet half (wallet →
 * faucet-if-empty → brief settlement poll) out as {@link ensureFundedWallet}
 * — `rooms join <key>` needs exactly that half, with NO tier purchase and NO
 * project creation (the claim itself is the one x402 payment that funds the
 * onboarding). {@link foldColdStartChain} is now their composition —
 * `ensureFundedWallet` followed by the tier step — so every EXISTING caller
 * (`repos create`/`resume`/`join`) is unchanged.
 */
import { readWallet, saveWallet } from "./config.mjs";
import { getSdk } from "./sdk.mjs";

const USDC_ABI = [{ name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ name: "account", type: "address" }], outputs: [{ name: "", type: "uint256" }] }];
const USDC_SEPOLIA = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";

/**
 * Wallet → faucet-if-empty → brief settlement poll. NO tier purchase, no
 * project creation — the caller decides what (if anything) to pay for next.
 *
 * @param {(line: string) => void} announce Called once per step, so the
 *   caller can print each one it took (client-surface spec: "announcing
 *   each step").
 * @returns {Promise<{wallet_created: boolean, faucet_requested: boolean, address: string}>}
 */
export async function ensureFundedWallet(announce = () => {}) {
  const out = { wallet_created: false, faucet_requested: false, address: "" };

  let localWallet = readWallet();
  if (!localWallet) {
    const { generatePrivateKey, privateKeyToAccount } = await import("viem/accounts");
    const privateKey = generatePrivateKey();
    const account = privateKeyToAccount(privateKey);
    localWallet = { address: account.address, privateKey, created: new Date().toISOString(), funded: false, rail: "x402" };
    saveWallet(localWallet);
    out.wallet_created = true;
    announce(`wallet created: ${localWallet.address}`);
  }
  out.address = localWallet.address;

  const { createPublicClient, http } = await import("viem");
  const { baseSepolia } = await import("viem/chains");
  const client = createPublicClient({ chain: baseSepolia, transport: http() });
  let balance = 0;
  try {
    balance = Number(await client.readContract({ address: USDC_SEPOLIA, abi: USDC_ABI, functionName: "balanceOf", args: [localWallet.address] }));
  } catch {
    /* an RPC hiccup here is not fatal — the payment below will surface a real failure if the balance really is zero */
  }
  if (balance === 0) {
    announce("balance is 0 — requesting the testnet faucet");
    // The faucet is throttled (0.25 USDC / 24h): a throttle refusal is
    // surfaced with its wait and NEVER retried silently (client-surface
    // spec) — this call is not wrapped in a swallowing catch.
    await getSdk().wallets.faucet(localWallet.address);
    out.faucet_requested = true;
    announce("faucet requested — waiting briefly for on-chain confirmation");
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      try {
        balance = Number(await client.readContract({ address: USDC_SEPOLIA, abi: USDC_ABI, functionName: "balanceOf", args: [localWallet.address] }));
        if (balance > 0) break;
      } catch {
        /* keep polling */
      }
    }
    saveWallet({ ...localWallet, funded: true, lastFaucet: new Date().toISOString() });
  }

  return out;
}

/**
 * `ensureFundedWallet` + the tier step. Unchanged from before the split —
 * every existing caller (`repos create`/`resume`/`join`) keeps working with
 * no edits.
 *
 * @param {(line: string) => void} announce Called once per step.
 * @returns {Promise<{wallet_created: boolean, faucet_requested: boolean, tier: object|null}>}
 */
export async function foldColdStartChain(announce = () => {}) {
  const funded = await ensureFundedWallet(announce);

  announce("setting the prototype tier (one x402 testnet payment; the free tier, no lease)");
  const tier = await getSdk().tier.set("prototype");
  announce(`prototype tier active${tier?.status === "already_active" ? " (already active)" : ""}`);
  return { wallet_created: funded.wallet_created, faucet_requested: funded.faucet_requested, tier };
}
