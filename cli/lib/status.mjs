/**
 * run402 status — the CLI edge of `r.status()` (`@run402/sdk/node`), which
 * assembles the local view (wallet, rail, balances, tier, projects, active
 * project, API target). This module prints it: JSON by default, or the
 * compact `--human` rendering.
 */
import { getSdk } from "./sdk.mjs";
import { fail, reportLocalOrSdkError } from "./sdk-errors.mjs";
import { assertKnownFlags, hasHelp, normalizeArgv } from "./argparse.mjs";

const HELP = `run402 status — Show full organization state in one shot

Usage:
  run402 status [--json|--human]

Displays:
  - Wallet identity (local_label, server_label, address)
  - Payment rail (x402 | mpp)
  - Balances (on_chain_usd_micros + on_chain_token, allowance_usd_micros, held_usd_micros)
  - Tier and lease (name, status, expiry)
  - Projects (from server, with fallback to local keystore)
  - Active project ID
  - Active API target

Output is JSON by default. --json is accepted as a compatibility no-op.
--human renders a compact human summary instead (wallet, API target, tier,
active project, balance, and the next action); it cannot be combined with
--json.
Run402 Cloud status requires a wallet; Core target status can still report
local project state without one.
`;

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
  let result;
  try {
    result = await getSdk().status();
  } catch (err) {
    reportLocalOrSdkError(err);
    return;
  }
  if (human) {
    console.log(formatStatusHuman(result));
    return;
  }
  // The no-wallet view has always printed compact; the wallet view pretty.
  console.log(result.wallet ? JSON.stringify(result, null, 2) : JSON.stringify(result));
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
    lines.push("Wallet:   none (no local wallet on this machine)");
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
    const allowance = usdFromMicros(result.balances.allowance_usd_micros);
    if (allowance) parts.push(`${allowance} allowance`);
    if (parts.length) lines.push(`Balance:  ${parts.join(", ")}`);
  }
  lines.push(`Next:     ${statusNextAction(result)}`);
  return lines.join("\n");
}
