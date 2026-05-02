import { readAllowance, loadKeyStore, getActiveProjectId, API } from "./config.mjs";
import { getAllowanceAuthHeaders } from "../core-dist/allowance-auth.js";
import { assertKnownFlags, hasHelp, normalizeArgv } from "./argparse.mjs";

const HELP = `run402 status — Show full account state in one shot

Usage:
  run402 status

Displays:
  - Allowance address and funding status
  - Wallet on-chain USDC/pathUSD balance (wallet_balance_usd_micros)
  - Billing balance (available + held)
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
    console.log(JSON.stringify({ status: "no_allowance", message: "No agent allowance found. Run: run402 init" }));
    process.exit(1);
  }

  const wallet = allowance.address.toLowerCase();
  const authHeaders = getAllowanceAuthHeaders("/tiers/v1/status");
  const rail = allowance.rail || "x402";

  // Parallel API calls: tier + billing balance + server-side projects + on-chain wallet balance
  const [tierRes, balanceRes, projectsRes, walletBalance] = await Promise.all([
    authHeaders
      ? fetch(`${API}/tiers/v1/status`, { headers: { ...authHeaders } }).catch(() => null)
      : null,
    fetch(`${API}/billing/v1/accounts/${wallet}`).catch(() => null),
    fetch(`${API}/wallets/v1/${wallet}/projects`).catch(() => null),
    readWalletBalanceUsdMicros(rail, allowance.address),
  ]);

  const tier = tierRes?.ok ? await tierRes.json() : null;
  const billing = balanceRes?.ok ? await balanceRes.json() : null;
  const remote = projectsRes?.ok ? await projectsRes.json() : null;

  // Local keystore
  const store = loadKeyStore();
  const activeId = getActiveProjectId();

  const projects = remote?.projects
    ? remote.projects.map(normalizeProject)
    : Object.keys(store.projects).map(id => ({ project_id: id }));

  const result = {
    allowance: {
      address: allowance.address,
      funded: allowance.funded || false,
    },
    rail,
    tier: tier && tier.tier
      ? { name: tier.tier, status: tier.status, expires: tier.lease_expires_at }
      : null,
    // GH-32: `balance` used to mean the billing-account balance, which
    // confused people who expected their on-chain wallet balance. Split into
    // two unambiguous fields:
    //   - billing: credits held by Run402 (available + held), null if no account
    //   - wallet_balance_usd_micros: on-chain USDC/pathUSD, null if RPC fails
    billing: billing && billing.exists
      ? { available_usd_micros: billing.available_usd_micros, held_usd_micros: billing.held_usd_micros }
      : null,
    wallet_balance_usd_micros: walletBalance,
    projects,
    active_project: activeId || null,
  };

  console.log(JSON.stringify(result, null, 2));
}
