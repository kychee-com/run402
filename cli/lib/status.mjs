import { readAllowance, loadKeyStore, getActiveProjectId } from "./config.mjs";
import { getSdk } from "./sdk.mjs";
import { assertKnownFlags, hasHelp, normalizeArgv } from "./argparse.mjs";
import { getActiveProfile } from "../core-dist/config.js";
import { readMeta } from "../core-dist/profiles.js";

const HELP = `run402 status — Show full account state in one shot

Usage:
  run402 status

Displays:
  - Wallet identity (local_label, server_label, address)
  - Payment rail (x402 | mpp)
  - Balances (on_chain_usd_micros + on_chain_token, prepaid_credit_usd_micros, held_usd_micros)
  - Tier subscription (name, status, expiry)
  - Projects (from server, with fallback to local keystore)
  - Active project ID

Output is JSON. Requires an existing allowance (run 'run402 init' first).
`;

// USDC / pathUSD constants (match allowance.mjs)
const USDC_ABI = [{ name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ name: "account", type: "address" }], outputs: [{ name: "", type: "uint256" }] }];
const USDC_MAINNET = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const USDC_SEPOLIA = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const PATH_USD = "0x20c0000000000000000000000000000000000000";
const TEMPO_RPC = "https://rpc.moderato.tempo.xyz/";

/**
 * Read the on-chain wallet balance in USD micros for the current rail.
 * For x402: read Base mainnet + Base Sepolia USDC and sum funded networks.
 * For mpp:  read pathUSD on Tempo Moderato.
 * Returns null if every read fails (e.g. offline or RPC down).
 */
async function readWalletBalanceUsdMicros(rail, address) {
  try {
    const { createPublicClient, http, defineChain } = await import("viem");
    if (rail === "mpp") {
      const tempoModerato = defineChain({
        id: 42431,
        name: "Tempo Moderato",
        nativeCurrency: { name: "pathUSD", symbol: "pathUSD", decimals: 6 },
        rpcUrls: { default: { http: [TEMPO_RPC] } },
      });
      const client = createPublicClient({ chain: tempoModerato, transport: http() });
      try {
        const raw = await client.readContract({ address: PATH_USD, abi: USDC_ABI, functionName: "balanceOf", args: [address] });
        return Number(raw);
      } catch { return null; }
    }
    // x402 rail — read Base mainnet + Base Sepolia in parallel; sum any that succeed.
    const { base, baseSepolia } = await import("viem/chains");
    const mainnetClient = createPublicClient({ chain: base, transport: http() });
    const sepoliaClient = createPublicClient({ chain: baseSepolia, transport: http() });
    const [mainnet, sepolia] = await Promise.all([
      mainnetClient.readContract({ address: USDC_MAINNET, abi: USDC_ABI, functionName: "balanceOf", args: [address] }).then(Number).catch(() => null),
      sepoliaClient.readContract({ address: USDC_SEPOLIA, abi: USDC_ABI, functionName: "balanceOf", args: [address] }).then(Number).catch(() => null),
    ]);
    if (mainnet === null && sepolia === null) return null;
    return (mainnet || 0) + (sepolia || 0);
  } catch {
    return null;
  }
}

/**
 * Normalize a project entry to the agreed-on shape: always expose `project_id`
 * (matching `projects list`). The remote /wallets/v1/:wallet/projects endpoint
 * returns entries keyed as `id`, so we map them here and drop the raw `id`
 * field to avoid having two aliases for the same identity.
 */
function normalizeProject(raw) {
  if (!raw || typeof raw !== "object") return raw;
  const projectId = raw.project_id || raw.id;
  const { id: _dropId, project_id: _dropPid, ...rest } = raw;
  return { project_id: projectId, ...rest };
}

export async function run(args = []) {
  args = normalizeArgv(args);
  if (hasHelp(args)) { console.log(HELP); process.exit(0); }
  assertKnownFlags(args, ["--help", "-h"]);
  const allowance = readAllowance();
  if (!allowance) {
    console.log(JSON.stringify({ wallet: null, hint: "Run: run402 init" }));
    return;
  }

  const wallet = allowance.address.toLowerCase();
  const rail = allowance.rail || "x402";

  // Parallel API calls: tier + billing balance + server-side projects + on-chain wallet balance
  const [tier, billing, remote, walletBalance] = await Promise.all([
    getSdk().tier.status().catch(() => null),
    getSdk().billing.checkBalance(wallet).catch(() => null),
    getSdk().projects.list(wallet).catch(() => null),
    readWalletBalanceUsdMicros(rail, allowance.address),
  ]);

  // Local keystore
  const store = loadKeyStore();
  const activeId = getActiveProjectId();

  const projects = remote?.projects
    ? remote.projects.map(normalizeProject)
    : Object.keys(store.projects).map(id => ({ project_id: id }));

  // Which named wallet this state belongs to. `local_label` is the active
  // profile (default for single-wallet installs); `server_label` is the
  // cached server-side display name (null until set / when offline).
  const walletName = getActiveProfile();
  const walletMeta = readMeta(walletName);

  // GH-32 follow-up: balances are grouped under one object so the on-chain and
  // prepaid-credit numbers are unambiguous and rail-legible.
  //   - on_chain_usd_micros / on_chain_token: on-chain USDC (x402) or pathUSD
  //     (mpp), null if the RPC read failed
  //   - prepaid_credit_usd_micros / held_usd_micros: Run402-held credits,
  //     rail-independent, null when no billing account exists
  const hasBilling = billing && billing.exists !== false;
  const result = {
    wallet: {
      local_label: walletName,
      server_label: walletMeta?.label ?? null,
      address: allowance.address,
    },
    rail,
    balances: {
      on_chain_usd_micros: walletBalance,
      on_chain_token: rail === "mpp" ? "pathUSD" : "USDC",
      prepaid_credit_usd_micros: hasBilling ? billing.available_usd_micros : null,
      held_usd_micros: hasBilling ? (billing.held_usd_micros ?? 0) : null,
    },
    tier: tier && tier.tier
      ? { name: tier.tier, status: tier.status, expires: tier.lease_expires_at }
      : null,
    // v1.57: lifecycle state and the per-account escape hatch moved to the
    // billing account. Surface them at the top level so agents don't have to
    // dig into the projects array to read them.
    account_lifecycle_state: tier?.account_lifecycle_state ?? null,
    lease_perpetual: tier?.lease_perpetual ?? null,
    projects,
    active_project: activeId || null,
  };

  console.log(JSON.stringify(result, null, 2));
}
