import { getSdk } from "./sdk.mjs";
import { reportSdkError, fail } from "./sdk-errors.mjs";
import { assertKnownFlags, normalizeArgv, positionalArgs } from "./argparse.mjs";

const HELP = `run402 tier — Manage your Run402 tier subscription

Usage:
  run402 tier <subcommand> [args...]

Subcommands:
  status                Show current tier (tier name, status, expiry)
  set <tier>            Subscribe, renew, or upgrade (pays via x402)

Tiers: prototype ($0.10/7d, free with testnet faucet), hobby ($5/30d), team ($20/30d)

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

const SUB_HELP = {
  status: `run402 tier status — Show current tier subscription state

Usage:
  run402 tier status

Notes:
  - Returns the current tier name, status, and expiry
  - Use 'run402 tier set <tier>' to subscribe, renew, or upgrade

Examples:
  run402 tier status
`,
  set: `run402 tier set — Subscribe, renew, or upgrade your tier

Usage:
  run402 tier set <tier>

Arguments:
  <tier>              One of: prototype, hobby, team

Tiers:
  prototype           $0.10/7d (free with testnet faucet)
  hobby               $5/30d
  team                $20/30d

Notes:
  Server auto-detects action based on current allowance state:
    - No tier or expired -> subscribe
    - Same tier, active  -> renew (extends from expiry)
    - Higher tier        -> upgrade (prorated refund to allowance)
    - Lower tier, active -> rejected (wait for expiry)
  Pays via x402 micropayments.

Examples:
  run402 tier set prototype
  run402 tier set hobby
`,
};

async function status(args = []) {
  const parsedArgs = normalizeArgv(args);
  assertKnownFlags(parsedArgs, ["--help", "-h"]);
  const extra = positionalArgs(parsedArgs);
  if (extra.length > 0) {
    fail({
      code: "BAD_USAGE",
      message: `Unexpected argument for tier status: ${extra[0]}`,
      hint: "Use `run402 tier status`.",
    });
  }
  try {
    const data = await getSdk().tier.status();
    console.log(JSON.stringify(data, null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

async function set(args = []) {
  const parsedArgs = normalizeArgv(args);
  assertKnownFlags(parsedArgs, ["--help", "-h"]);
  const positionals = positionalArgs(parsedArgs);
  if (positionals.length > 1) {
    fail({
      code: "BAD_USAGE",
      message: `Unexpected argument for tier set: ${positionals[1]}`,
      hint: "Use `run402 tier set <prototype|hobby|team>`.",
    });
  }
  const tierName = positionals[0];
  if (!tierName) {
    fail({
      code: "BAD_USAGE",
      message: "Missing <tier>.",
      hint: "run402 tier set <prototype|hobby|team>",
    });
  }
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
    console.log(SUB_HELP[sub] || HELP);
    process.exit(0);
  }
  switch (sub) {
    case "status": await status(args); break;
    case "set":    await set(args); break;
    default:
      console.error(`Unknown subcommand: ${sub}\n`);
      console.log(HELP);
      process.exit(1);
  }
}
