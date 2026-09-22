import { getSdk } from "./sdk.mjs";
import { reportSdkError, fail } from "./sdk-errors.mjs";
import { assertKnownFlags, normalizeArgv, positionalArgs, flagValue, failUnknownSubcommand } from "./argparse.mjs";
import { setTierAction } from "./next-actions.mjs";

const HELP = `run402 tier — Manage your Run402 tier and its lease

Usage:
  run402 tier <subcommand> [args...]

Subcommands:
  status                Show current tier, expiry, pool usage, and function caps when returned
  set <tier>            Start, renew, or upgrade the lease (the allowance first, else x402/MPP)

Tiers: prototype ($0.10 once, the free tier: no lease, never expires; covered by the testnet faucet), hobby ($5/30d), team ($20/30d)

The organization's allowance pays first. A promo code (run402 redeem <code>)
or a top-up adds to the allowance; 'tier set' settles from it with no payment
challenge and no USDC in the wallet, and the receipt says paid_with: "allowance".
Only an allowance that falls short goes to x402 / MPP, and that error names the
exact shortfall a voucher or top-up would cover.

Tier is per organization. One tier covers every project on the account;
api_calls and storage_bytes are pooled across all of them. Hobby and team
are prepaid 30-day leases that end unless renewed; nothing charges again on
its own.

The server auto-detects the action from the current tier state and reports
it as action: start | renew | upgrade:
  - No tier or expired  → start
  - Same tier, active   → renew (extends from expiry)
  - Higher tier         → upgrade (prorated refund to allowance)
  - Lower tier, active  → rejected (wait for expiry)

Examples:
  run402 tier status
  run402 tier set prototype
  run402 tier set hobby
`;

const SUB_HELP = {
  status: `run402 tier status — Show current tier and lease state

Usage:
  run402 tier status

Notes:
  - Tier and quotas are per organization. The 'pool_usage' block sums
    api_calls and storage_bytes across every project on this account
    (across every wallet linked to it), not just the requesting wallet.
  - Returns the current tier name, status, expiry, and pool usage
  - Newer gateways include function authoring caps such as max timeout,
    max memory, max scheduled functions, minimum cron interval, and current
    scheduled-function usage
  - Use 'run402 tier set <tier>' to start, renew, or upgrade the lease

Examples:
  run402 tier status
`,
  set: `run402 tier set — Set your tier: start, renew, or upgrade the lease

Usage:
  run402 tier set <tier> [--idempotency-key <key>]

Arguments:
  <tier>              One of: prototype, hobby, team

Options:
  --idempotency-key <key>  Retry-safe key: re-running the same start/renew
                           intent with this key does not double-charge. Use a
                           fresh key for a deliberate second renewal.

Tiers:
  prototype           $0.10 once, the free tier: no lease, never expires
                      (covered by the testnet faucet)
  hobby               $5/30d
  team                $20/30d

Notes:
  Tier is per organization, not per project. A successful start,
  renew, or upgrade applies immediately to every project on the account.
  Hobby and team are prepaid 30-day leases that end unless renewed;
  nothing charges again on its own.

  Server auto-detects the action from the current tier state and reports
  it as action: start | renew | upgrade:
    - No tier or expired -> start
    - Same tier, active  -> renew (extends from expiry)
    - Higher tier        -> upgrade (prorated refund to allowance)
    - Lower tier, active -> rejected (wait for expiry)
  Pays via x402 micropayments.

  After the call, the CLI refetches /tiers/v1/status and includes the
  refreshed organization-pooled usage as 'status_after' in the JSON output.

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
  assertKnownFlags(parsedArgs, ["--help", "-h"], ["--idempotency-key"]);
  const positionals = positionalArgs(parsedArgs, ["--idempotency-key"]);
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
      next_actions: [setTierAction()],
    });
  }
  // Caller-supplied idempotency key makes a retried start/renew safe from
  // double-charge. Not auto-derived: the SDK cannot tell a retry from a new
  // renewal intent (that boundary is the caller's).
  const idempotencyKey = flagValue(parsedArgs, "--idempotency-key") ?? undefined;
  try {
    const sdk = getSdk();
    const data = await sdk.tier.set(tierName, idempotencyKey ? { idempotencyKey } : {});
    let statusAfter = null;
    try {
      statusAfter = await sdk.tier.status();
    } catch {
      // Refetch failure is non-fatal; the set call already succeeded and
      // the caller has the canonical lease/payment receipt in `data`.
      statusAfter = null;
    }
    const output = statusAfter ? { ...data, status_after: statusAfter } : data;
    console.log(JSON.stringify(output, null, 2));
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
      failUnknownSubcommand("tier", sub);
  }
}
