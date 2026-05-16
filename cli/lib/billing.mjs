import { getSdk } from "./sdk.mjs";
import { reportSdkError, fail } from "./sdk-errors.mjs";
import { assertKnownFlags, flagValue, normalizeArgv, parseIntegerFlag, positionalArgs } from "./argparse.mjs";

const HELP = `run402 billing — Email billing accounts, Stripe tier checkout, email packs

Usage:
  run402 billing <subcommand> [args...]

Subcommands:
  create-email <email>                     Create an email billing account
  link-wallet <account_id> <wallet>        Link a wallet to an email account
  tier-checkout <tier> [--email <e> | --wallet <w>]    Stripe tier checkout
  buy-email-pack [--email <e> | --wallet <w>]  Buy \$5 email pack (10,000 emails)
  auto-recharge <account_id> <on|off> [--threshold <n>]
  balance <identifier>                     Balance by email or wallet (0x...)
  history <identifier> [--limit <n>]       Ledger history by email or wallet

Examples:
  run402 billing create-email user@example.com
  run402 billing tier-checkout hobby --email user@example.com
  run402 billing buy-email-pack --wallet 0x1234...
  run402 billing auto-recharge acct_abc on --threshold 2000
  run402 billing balance user@example.com
`;

const SUB_HELP = {
  "tier-checkout": `run402 billing tier-checkout — Create a Stripe tier checkout session

Usage:
  run402 billing tier-checkout <tier> [--email <e> | --wallet <w>]

Arguments:
  <tier>              Tier name (e.g. hobby, pro)

Options:
  --email <e>         Email billing account to charge
  --wallet <w>        Wallet address (0x...) to associate with the checkout

Examples:
  run402 billing tier-checkout hobby --email user@example.com
  run402 billing tier-checkout pro --wallet 0x1234...
`,
  "buy-email-pack": `run402 billing buy-email-pack — Buy a $5 email pack (10,000 emails)

Usage:
  run402 billing buy-email-pack [--email <e> | --wallet <w>]

Options:
  --email <e>         Email billing account to charge
  --wallet <w>        Wallet address (0x...) to associate with the purchase

Examples:
  run402 billing buy-email-pack --email user@example.com
  run402 billing buy-email-pack --wallet 0x1234...
`,
  "auto-recharge": `run402 billing auto-recharge — Toggle email-pack auto-recharge

Usage:
  run402 billing auto-recharge <account_id> <on|off> [--threshold <n>]

Arguments:
  <account_id>        Billing account ID
  <on|off>            Enable or disable auto-recharge

Options:
  --threshold <n>     Remaining-email threshold that triggers auto-recharge

Examples:
  run402 billing auto-recharge acct_abc on --threshold 2000
  run402 billing auto-recharge acct_abc off
`,
  history: `run402 billing history — Show ledger history for an email or wallet

Usage:
  run402 billing history <identifier> [--limit <n>]

Arguments:
  <identifier>        Email address or wallet (0x...)

Options:
  --limit <n>         Max entries to return (default: 50)

Examples:
  run402 billing history user@example.com
  run402 billing history 0x1234... --limit 100
`,
  balance: `run402 billing balance — Show balance for an email or wallet

Usage:
  run402 billing balance <identifier>

Arguments:
  <identifier>        Email address or wallet (0x...)

Examples:
  run402 billing balance user@example.com
  run402 billing balance 0x1234abcd...
`,
  "create-email": `run402 billing create-email — Create an email billing account

Usage:
  run402 billing create-email <email>

Arguments:
  <email>             Email address to register as a billing account

Examples:
  run402 billing create-email user@example.com
`,
  "link-wallet": `run402 billing link-wallet — Link a wallet to an email billing account

Usage:
  run402 billing link-wallet <account_id> <wallet>

Arguments:
  <account_id>        Billing account ID (e.g. acct_abc123)
  <wallet>            Wallet address (0x...) to link

Notes:
  - Tier and quotas are per-billing-account. Linking a wallet merges its
    spend into the account-wide pool that already includes every project
    on this billing account.
  - The response includes a 'pool_implications' block on v1.46+ gateways:
    tier, projects_in_pool_count, account_api_calls_current,
    account_storage_bytes_current, tier_limits, over_limit. Inspect
    'over_limit' before linking a wallet whose existing usage might push
    the merged pool past the tier cap.

Examples:
  run402 billing link-wallet acct_abc123 0x1234abcd...
`,
};

function requireSingleBillingIdentifier(email, wallet) {
  if (email && wallet) {
    fail({
      code: "BAD_USAGE",
      message: "Provide either --email or --wallet, not both.",
      hint: "[--email <e> | --wallet <w>]",
    });
  }
  if (!email && !wallet) {
    fail({
      code: "BAD_USAGE",
      message: "Must provide --email or --wallet",
      hint: "[--email <e> | --wallet <w>]",
    });
  }
}

async function createEmail(args) {
  const parsedArgs = normalizeArgv(args);
  assertKnownFlags(parsedArgs, ["--help", "-h"]);
  const positionals = positionalArgs(parsedArgs);
  const email = positionals[0];
  if (positionals.length > 1) {
    fail({ code: "BAD_USAGE", message: `Unexpected argument for billing create-email: ${positionals[1]}` });
  }
  if (!email) {
    fail({
      code: "BAD_USAGE",
      message: "Missing email.",
      hint: "run402 billing create-email <email>",
    });
  }
  try {
    const data = await getSdk().billing.createEmailAccount(email);
    console.log(JSON.stringify(data, null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

async function linkWallet(args) {
  const parsedArgs = normalizeArgv(args);
  assertKnownFlags(parsedArgs, ["--help", "-h"]);
  const positionals = positionalArgs(parsedArgs);
  const accountId = positionals[0];
  const wallet = positionals[1];
  if (positionals.length > 2) {
    fail({ code: "BAD_USAGE", message: `Unexpected argument for billing link-wallet: ${positionals[2]}` });
  }
  if (!accountId || !wallet) {
    fail({
      code: "BAD_USAGE",
      message: "Missing <account_id> and/or <wallet>.",
      hint: "run402 billing link-wallet <account_id> <wallet>",
    });
  }
  try {
    const data = await getSdk().billing.linkWallet(accountId, wallet);
    const output = {
      status: data?.status ?? "ok",
      billing_account_id: data?.billing_account_id ?? accountId,
      wallet: data?.wallet ?? wallet.toLowerCase(),
      ...(data?.pool_implications ? { pool_implications: data.pool_implications } : {}),
    };
    console.log(JSON.stringify(output, null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

async function tierCheckout(args) {
  const parsedArgs = normalizeArgv(args);
  const valueFlags = ["--email", "--wallet"];
  assertKnownFlags(parsedArgs, [...valueFlags, "--help", "-h"], valueFlags);
  const positionals = positionalArgs(parsedArgs, valueFlags);
  const tier = positionals[0];
  if (positionals.length > 1) {
    fail({ code: "BAD_USAGE", message: `Unexpected argument for billing tier-checkout: ${positionals[1]}` });
  }
  if (!tier) {
    fail({
      code: "BAD_USAGE",
      message: "Missing <tier>.",
      hint: "run402 billing tier-checkout <tier> [--email <e> | --wallet <w>]",
    });
  }
  const email = flagValue(parsedArgs, "--email");
  const wallet = flagValue(parsedArgs, "--wallet");
  requireSingleBillingIdentifier(email, wallet);
  try {
    const data = await getSdk().billing.tierCheckout(tier, { email: email ?? undefined, wallet: wallet ?? undefined });
    console.log(JSON.stringify(data, null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

async function buyPack(args) {
  const parsedArgs = normalizeArgv(args);
  const valueFlags = ["--email", "--wallet"];
  assertKnownFlags(parsedArgs, [...valueFlags, "--help", "-h"], valueFlags);
  const extra = positionalArgs(parsedArgs, valueFlags);
  if (extra.length > 0) {
    fail({ code: "BAD_USAGE", message: `Unexpected argument for billing buy-email-pack: ${extra[0]}` });
  }
  const email = flagValue(parsedArgs, "--email");
  const wallet = flagValue(parsedArgs, "--wallet");
  requireSingleBillingIdentifier(email, wallet);
  try {
    const data = await getSdk().billing.buyEmailPack({ email: email ?? undefined, wallet: wallet ?? undefined });
    console.log(JSON.stringify(data, null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

async function autoRecharge(args) {
  const parsedArgs = normalizeArgv(args);
  const valueFlags = ["--threshold"];
  assertKnownFlags(parsedArgs, [...valueFlags, "--help", "-h"], valueFlags);
  const positionals = positionalArgs(parsedArgs, valueFlags);
  const accountId = positionals[0];
  const state = positionals[1];
  if (positionals.length > 2) {
    fail({ code: "BAD_USAGE", message: `Unexpected argument for billing auto-recharge: ${positionals[2]}` });
  }
  if (!accountId || !state || !["on", "off"].includes(state)) {
    fail({
      code: "BAD_USAGE",
      message: "Missing <account_id> and/or <on|off>.",
      hint: "run402 billing auto-recharge <account_id> <on|off> [--threshold <n>]",
    });
  }
  const thresholdStr = flagValue(parsedArgs, "--threshold");
  const threshold = parsedArgs.includes("--threshold")
    ? parseIntegerFlag("--threshold", thresholdStr, { min: 0 })
    : undefined;
  try {
    await getSdk().billing.setAutoRecharge({
      billingAccountId: accountId,
      enabled: state === "on",
      threshold,
    });
    console.log(JSON.stringify({ status: "ok", billing_account_id: accountId, enabled: state === "on" }));
  } catch (err) {
    reportSdkError(err);
  }
}

async function balance(args) {
  const parsedArgs = normalizeArgv(args);
  assertKnownFlags(parsedArgs, ["--help", "-h"]);
  const positionals = positionalArgs(parsedArgs);
  const id = positionals[0];
  if (positionals.length > 1) {
    fail({ code: "BAD_USAGE", message: `Unexpected argument for billing balance: ${positionals[1]}` });
  }
  if (!id) {
    fail({
      code: "BAD_USAGE",
      message: "Missing <email-or-wallet>.",
      hint: "run402 billing balance <email-or-wallet>",
    });
  }
  try {
    const data = await getSdk().billing.getAccount(id);
    console.log(JSON.stringify(data, null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

async function history(args) {
  const parsedArgs = normalizeArgv(args);
  const valueFlags = ["--limit"];
  assertKnownFlags(parsedArgs, [...valueFlags, "--help", "-h"], valueFlags);
  const positionals = positionalArgs(parsedArgs, valueFlags);
  const id = positionals[0];
  if (positionals.length > 1) {
    fail({ code: "BAD_USAGE", message: `Unexpected argument for billing history: ${positionals[1]}` });
  }
  if (!id) {
    fail({
      code: "BAD_USAGE",
      message: "Missing <email-or-wallet>.",
      hint: "run402 billing history <email-or-wallet> [--limit <n>]",
    });
  }
  const limit = parsedArgs.includes("--limit")
    ? parseIntegerFlag("--limit", flagValue(parsedArgs, "--limit"), { min: 1 })
    : 50;
  try {
    const data = await getSdk().billing.getHistory(id, limit);
    console.log(JSON.stringify(data, null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

export async function run(sub, args) {
  if (!sub || sub === "--help" || sub === "-h") { console.log(HELP); process.exit(0); }
  if (Array.isArray(args) && (args.includes("--help") || args.includes("-h"))) { console.log(SUB_HELP[sub] || HELP); process.exit(0); }
  switch (sub) {
    case "create-email": await createEmail(args); break;
    case "link-wallet": await linkWallet(args); break;
    case "tier-checkout": await tierCheckout(args); break;
    case "buy-email-pack": await buyPack(args); break;
    case "auto-recharge": await autoRecharge(args); break;
    case "balance": await balance(args); break;
    case "history": await history(args); break;
    default:
      console.error(`Unknown subcommand: ${sub}\n`);
      console.log(HELP);
      process.exit(1);
  }
}
