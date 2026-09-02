/**
 * `cold-start.mjs` — the minimal x402/Base-Sepolia cold-start chain
 * (kygit-handoff design D5): allowance → faucet → one x402 prototype
 * payment. `repos create` (and so `kygit create`) folds this in when it is
 * refused `NO_ACTIVE_TIER`, so `kygit create` on a genuinely fresh machine
 * ends with a vault, no human signup, no cloud dashboard.
 *
 * This is the SAME shape `run402 init` already walks (allowance create →
 * balance check → faucet → tier), factored down to the x402/Base-Sepolia
 * default rail only (MPP/Tempo is `init`'s own separate concern — an agent
 * hitting NO_ACTIVE_TIER mid-`repos create` gets the default rail, not a
 * rail-selection prompt). `init.mjs`'s own richer flow (voucher redemption,
 * rail switching, astro scaffolding, its own help/exit-code contract) is
 * untouched; this module does not replace it, only the one path `repos
 * create` needs when it discovers there is no tier and nothing else has
 * set one up yet.
 */
import { readAllowance, saveAllowance } from "./config.mjs";
import { getSdk } from "./sdk.mjs";

const USDC_ABI = [{ name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ name: "account", type: "address" }], outputs: [{ name: "", type: "uint256" }] }];
const USDC_SEPOLIA = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";

/**
 * @param {(line: string) => void} announce Called once per step, so the
 *   caller can print each one it took (client-surface spec: "announcing
 *   each step").
 * @returns {Promise<{allowance_created: boolean, faucet_requested: boolean, tier: object|null}>}
 */
export async function foldColdStartChain(announce = () => {}) {
  const out = { allowance_created: false, faucet_requested: false, tier: null };

  let allowance = readAllowance();
  if (!allowance) {
    const { generatePrivateKey, privateKeyToAccount } = await import("viem/accounts");
    const privateKey = generatePrivateKey();
    const account = privateKeyToAccount(privateKey);
    allowance = { address: account.address, privateKey, created: new Date().toISOString(), funded: false, rail: "x402" };
    saveAllowance(allowance);
    out.allowance_created = true;
    announce(`allowance created: ${allowance.address}`);
  }

  const { createPublicClient, http } = await import("viem");
  const { baseSepolia } = await import("viem/chains");
  const client = createPublicClient({ chain: baseSepolia, transport: http() });
  let balance = 0;
  try {
    balance = Number(await client.readContract({ address: USDC_SEPOLIA, abi: USDC_ABI, functionName: "balanceOf", args: [allowance.address] }));
  } catch {
    /* an RPC hiccup here is not fatal — the tier purchase below will surface a real payment failure if the balance really is zero */
  }
  if (balance === 0) {
    announce("balance is 0 — requesting the testnet faucet");
    // The faucet is throttled (0.25 USDC / 24h): a throttle refusal is
    // surfaced with its wait and NEVER retried silently (client-surface
    // spec) — this call is not wrapped in a swallowing catch.
    await getSdk().allowance.faucet(allowance.address);
    out.faucet_requested = true;
    announce("faucet requested — waiting briefly for on-chain confirmation");
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      try {
        balance = Number(await client.readContract({ address: USDC_SEPOLIA, abi: USDC_ABI, functionName: "balanceOf", args: [allowance.address] }));
        if (balance > 0) break;
      } catch {
        /* keep polling */
      }
    }
    saveAllowance({ ...allowance, funded: true, lastFaucet: new Date().toISOString() });
  }

  announce("subscribing to the prototype tier (one x402 testnet payment, perpetual)");
  out.tier = await getSdk().tier.set("prototype");
  announce(`prototype tier active${out.tier?.status === "already_active" ? " (already active)" : ""}`);
  return out;
}
