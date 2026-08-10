import { getSdk } from "./sdk.mjs";
import { reportSdkError, fail } from "./sdk-errors.mjs";
import { assertKnownFlags, normalizeArgv, positionalArgs } from "./argparse.mjs";

const HELP = `run402 redeem — Redeem a promo code for run402 credit

Usage:
  run402 redeem <code> [--json]

A promo code credits your organization with run402 prepaid credit. That credit
spends like any other prepaid balance — a tier purchase settles from it with no
on-chain payment.

Notes:
  - Order does not matter. This works as your very first authenticated call
    (the organization is created on demand) or long after 'run402 init'.
  - Codes are forgiving: case-insensitive and hyphens are optional, so
    'R402-K8F3-Q2W9' and 'r402k8f3q2w9' are the same code.
  - Retrying is safe. A repeat by the same organization returns the original
    result with "already_redeemed": true and never credits twice.
  - Being in a grace state does not block you. Redeeming is how an owner funds
    a renewal, so it is never gated.
  - One gift per organization: past the lifetime ceiling you get 403
    PROMO_LIMIT_REACHED with the exact numbers.

To fold this into first-time setup instead, use:
  run402 init --voucher <code>

Examples:
  run402 redeem R402-K8F3-Q2W9
  run402 redeem r402k8f3q2w9
`;

export async function run(args = []) {
  const parsedArgs = normalizeArgv(args);
  if (parsedArgs.includes("--help") || parsedArgs.includes("-h")) {
    console.log(HELP);
    process.exit(0);
  }
  assertKnownFlags(parsedArgs, ["--help", "-h"], []);
  const positionals = positionalArgs(parsedArgs, []);
  if (positionals.length > 1) {
    fail({
      code: "BAD_USAGE",
      message: `Unexpected argument for redeem: ${positionals[1]}`,
      hint: "Use `run402 redeem <code>`.",
    });
  }
  const code = positionals[0];
  if (!code) {
    fail({
      code: "BAD_USAGE",
      message: "Missing <code>.",
      hint: "run402 redeem <code>  (e.g. run402 redeem R402-K8F3-Q2W9)",
    });
  }

  try {
    const data = await getSdk().vouchers.redeem(code);
    // Progress to stderr, JSON to stdout — the pipe contract. The one-liner
    // exists because the interesting fact (money arrived) is otherwise buried
    // in a field a human skims past.
    console.error("");
    console.error(
      `  Voucher    ${usd(data.amount_usd_micros)} credited` +
        `${data.already_redeemed ? " (already redeemed " + data.redeemed_at + " — no second credit)" : ""}`,
    );
    console.error(`  Balance    ${usd(data.balance_usd_micros)} available`);
    const next = Array.isArray(data.next_actions) ? data.next_actions.find((a) => a?.cli) : null;
    if (next?.cli) console.error(`\n  Next: ${next.cli}`);
    console.error("");
    console.log(JSON.stringify(data, null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

function usd(micros) {
  return `$${(Number(micros ?? 0) / 1_000_000).toFixed(2)}`;
}
