import { getSdk } from "./sdk.mjs";
import { reportSdkError } from "./sdk-errors.mjs";

const HELP = `run402 tier — Manage your Run402 tier subscription

Usage:
  run402 tier <subcommand> [args...]

Subcommands:
  status                Show current tier (tier name, status, expiry)
  set <tier>            Subscribe, renew, or upgrade (pays via x402)

Tiers: prototype ($0.10/7d), hobby ($5/30d), team ($20/30d)

The server auto-detects the action based on your allowance state:
  - No tier or expired  → subscribe
  - Same tier, active   → renew (extends from expiry)
  - Higher tier         → upgrade (prorated refund to allowance)
  - Lower tier, active  → rejected (wait for expiry)

Examples:
  run402 tier status
  run402 tier set prototype
  run402 tier set hobby
`;

async function status() {
  try {
    const data = await getSdk().tier.status();
    console.log(JSON.stringify(data, null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

async function set(tierName) {
  if (!tierName) { console.error(JSON.stringify({ status: "error", message: "Usage: run402 tier set <prototype|hobby|team>" })); process.exit(1); }
  try {
    const data = await getSdk().tier.set(tierName);
    console.log(JSON.stringify(data, null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

export async function run(sub, args) {
  if (!sub || sub === '--help' || sub === '-h') {
    console.log(HELP);
    process.exit(0);
  }
  if (Array.isArray(args) && (args.includes("--help") || args.includes("-h"))) {
    console.log(HELP);
    process.exit(0);
  }
  switch (sub) {
    case "status": await status(); break;
    case "set":    await set(args[0]); break;
    default:
      console.error(`Unknown subcommand: ${sub}\n`);
      console.log(HELP);
      process.exit(1);
  }
}
