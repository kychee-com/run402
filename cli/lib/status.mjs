import { readRemoteStatus } from "#sdk/node";
import {
  readAllowance,
  loadKeyStore,
  getActiveProjectId,
  apiBase,
  apiBaseSource,
  apiTargetKind,
} from "./config.mjs";
import { getSdk } from "./sdk.mjs";
import { fail } from "./sdk-errors.mjs";
import { assertKnownFlags, hasHelp, normalizeArgv } from "./argparse.mjs";
import { getActiveProfile } from "../core-dist/config.js";
import { readMeta } from "../core-dist/profiles.js";

const HELP = `run402 status — Show full organization state in one shot

Usage:
  run402 status [--json|--human]

Displays:
  - Wallet identity (local_label, server_label, address)
  - Payment rail (x402 | mpp)
  - Balances (on_chain_usd_micros + on_chain_token, prepaid_credit_usd_micros, held_usd_micros)
  - Tier and lease (name, status, expiry)
  - Projects (from server, with fallback to local keystore)
  - Active project ID
  - Active API target

Output is JSON by default. --json is accepted as a compatibility no-op.
--human renders a compact human summary instead (wallet, API target, tier,
active project, balance, and the next action); it cannot be combined with
--json.
Run402 Cloud status requires an allowance; Core target status can still report
local project state without one.
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
  assertKnownFlags(args, ["--help", "-h", "--json", "--human"]);
  const human = args.includes("--human");
  if (human && args.includes("--json")) {
    fail({
      code: "BAD_USAGE",
      message: "--human cannot be combined with --json.",
      details: { flags: args.filter((arg) => arg === "--human" || arg === "--json") },
      hint: "JSON is the default; drop --json to keep it, or keep --human alone for the rendered view.",
    });
  }
  const allowance = readAllowance();
  const target = {
    api_base: apiBase(),
    api_base_source: apiBaseSource(),
    kind: apiTargetKind(),
  };
  if (!allowance) {
    const store = loadKeyStore();
    const bare = {
      wallet: null,
      target,
      projects: Object.keys(store.projects).map(id => ({ project_id: id })),
      active_project: getActiveProjectId() || null,
      hint: target.kind === "core" ? "Run: run402 projects provision --name my-app" : "Run: run402 init",
    };
    if (human) {
      console.log(formatStatusHuman(bare));
      return;
    }
    console.log(JSON.stringify(bare));
    return;
  }

  const wallet = allowance.address.toLowerCase();
  const rail = allowance.rail || "x402";

  // Parallel API calls: tier + billing balance + server-side projects + on-chain wallet balance.
  // projects.list() is the membership-scoped named inventory (project-findability);
  // SIWX wallet auth is signed from the allowance. Best-effort — a missing
  // allowance yields null and we fall back to the local keystore below.
  const [status, walletBalance] = await Promise.all([
    readRemoteStatus(getSdk(), wallet),
    readWalletBalanceUsdMicros(rail, allowance.address),
  ]);
  const { tier, billing, remote } = status;

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

  // Balances are grouped under one object so the on-chain and
  // prepaid-credit numbers are unambiguous and rail-legible.
  //   - on_chain_usd_micros / on_chain_token: on-chain USDC (x402) or pathUSD
  //     (mpp), null if the RPC read failed
  //   - prepaid_credit_usd_micros / held_usd_micros: Run402-held credits,
  //     rail-independent, null when no organization exists
  const hasBilling = billing && billing.exists !== false;
  const result = {
    wallet: {
      local_label: walletName,
      server_label: walletMeta?.label ?? null,
      address: allowance.address,
    },
    rail,
    remote_status: status.availability,
    next_actions: status.next_actions,
    projects_source: remote ? "remote" : "local_cache",
    balances: {
      on_chain_usd_micros: walletBalance,
      on_chain_token: rail === "mpp" ? "pathUSD" : "USDC",
      prepaid_credit_usd_micros: hasBilling ? billing.available_usd_micros : null,
      held_usd_micros: hasBilling ? (billing.held_usd_micros ?? 0) : null,
    },
    tier: tier && tier.tier
      ? { name: tier.tier, status: tier.status, expires: tier.lease_perpetual === true ? null : tier.lease_expires_at }
      : null,
    // v1.57: lifecycle state and the per-organization escape hatch moved to the
    // organization. Surface them at the top level so agents don't have to
    // dig into the projects array to read them.
    organization_lifecycle_state: tier?.organization_lifecycle_state ?? null,
    lease_perpetual: tier?.lease_perpetual ?? null,
    projects,
    active_project: activeId || null,
    target,
  };

  if (human) {
    console.log(formatStatusHuman(result));
    return;
  }
  console.log(JSON.stringify(result, null, 2));
}

function usdFromMicros(micros) {
  if (typeof micros !== "number" || !Number.isFinite(micros)) return null;
  return `$${(micros / 1_000_000).toFixed(2)}`;
}

/**
 * The one next action for the human view, derived from the same state the
 * JSON carries. Mirrors `init`: `run402 up -y` sets the prototype tier
 * itself as part of the first deploy, so a tier-less account gets ONE command.
 */
function statusNextAction(result) {
  if (!result.wallet) {
    return result.hint?.replace(/^Run:\s*/, "") ?? "run402 init";
  }
  if (result.remote_status?.tier?.state === "unavailable") return "Check connectivity/authentication and retry run402 status; tier state is unavailable.";
  if (!result.tier) {
    return "run402 up -y  (sets the prototype tier, free on testnet, as part of the first deploy; or: run402 tier set prototype)";
  }
  if (!result.active_project) {
    return "run402 up --name <name> -y  (or select an existing project: run402 projects use <project_id>)";
  }
  return "run402 up -y  (redeploys the active project from run402.json)";
}

/**
 * Compact human rendering of the status payload — the same style as
 * `run402 up --human`: one fact per line, the next action last. The JSON
 * shape is untouched; this only formats it.
 */
export function formatStatusHuman(result) {
  const lines = [];
  if (!result.wallet) {
    lines.push("Wallet:   none (no allowance on this machine)");
  } else {
    const label = result.wallet.server_label
      ? `${result.wallet.local_label} (${result.wallet.server_label})`
      : result.wallet.local_label;
    lines.push(`Wallet:   ${label} ${result.wallet.address}`);
    if (result.rail) lines.push(`Rail:     ${result.rail}`);
  }
  lines.push(`API:      ${result.target.api_base} (${result.target.kind}, ${result.target.api_base_source})`);
  if (result.wallet) {
    if (result.tier) {
      const lifecycle = result.organization_lifecycle_state ? `, org ${result.organization_lifecycle_state}` : "";
      const expiry = result.lease_perpetual === true
        ? ", perpetual"
        : (result.tier.expires ? `, expires ${result.tier.expires}` : "");
      lines.push(`Tier:     ${result.tier.name} (${result.tier.status}${lifecycle}${expiry})`);
    } else {
      lines.push(result.remote_status?.tier?.state === "unavailable" ? "Tier:     unavailable (remote status failed)" : "Tier:     none");
    }
  }
  const projects = Array.isArray(result.projects) ? result.projects : [];
  if (result.active_project) {
    const active = projects.find((p) => p?.project_id === result.active_project);
    const site = active?.site_url ? ` ${active.site_url}` : "";
    lines.push(`Project:  ${result.active_project}${site}`);
  } else {
    lines.push(`Project:  none active${projects.length ? ` (${projects.length} known)` : ""}`);
  }
  if (result.balances) {
    const parts = [];
    const onChain = usdFromMicros(result.balances.on_chain_usd_micros);
    if (onChain) parts.push(`${onChain} ${result.balances.on_chain_token} on-chain`);
    const credit = usdFromMicros(result.balances.prepaid_credit_usd_micros);
    if (credit) parts.push(`${credit} prepaid credit`);
    if (parts.length) lines.push(`Balance:  ${parts.join(", ")}`);
  }
  lines.push(`Next:     ${statusNextAction(result)}`);
  return lines.join("\n");
}
