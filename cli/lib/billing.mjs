import { getSdk } from "./sdk.mjs";
import { reportSdkError, fail } from "./sdk-errors.mjs";
import { assertKnownFlags, flagValue, normalizeArgv, parseIntegerFlag, positionalArgs } from "./argparse.mjs";

const HELP = `run402 billing — Email organizations and org checkouts

Usage:
  run402 billing <subcommand> [args...]

Subcommands:
  create-email <email>                     Create an email organization
  link-wallet <org_id> <wallet>            Link a wallet to an email organization
  checkout <identifier> --product <p>      Create an org checkout
  auto-recharge <org_id> <on|off> [--threshold <n>]
  balance <identifier>                     Balance by organization id (UUID), wallet (0x...), or email
  history <identifier> [--limit <n>]       Ledger history by organization id (UUID), wallet, or email

Examples:
  run402 billing create-email user@example.com
  run402 billing checkout 00000000-0000-4000-8000-000000000001 --product tier --tier hobby
  run402 billing checkout 0x1234... --product email-pack
  run402 billing checkout 0x1234... --product balance-topup --amount 5000000
  run402 billing auto-recharge org_abc on --threshold 2000
  run402 billing balance user@example.com
`;

const SUB_HELP = {
  checkout: `run402 billing checkout — Create an org checkout

Usage:
  run402 billing checkout <identifier> --product <tier|email-pack|balance-topup> [options]

Arguments:
  <identifier>        Organization id (UUID), wallet (0x...), or email.
                      Wallet/email are resolved to the organization id first.

Options:
  --product <p>       tier, email-pack, or balance-topup
  --tier <tier>       Tier name for --product tier
  --amount <n>        USD micros for --product balance-topup

Examples:
  run402 billing checkout 00000000-0000-4000-8000-000000000001 --product tier --tier hobby
  run402 billing checkout 0x1234... --product email-pack
  run402 billing checkout 0x1234... --product balance-topup --amount 5000000
`,
  "auto-recharge": `run402 billing auto-recharge — Toggle email-pack auto-recharge

Usage:
  run402 billing auto-recharge <org_id> <on|off> [--threshold <n>]

Arguments:
  <org_id>        Organization ID
  <on|off>            Enable or disable auto-recharge

Options:
  --threshold <n>     Remaining-email threshold that triggers auto-recharge

Examples:
  run402 billing auto-recharge org_abc on --threshold 2000
  run402 billing auto-recharge org_abc off
`,
  history: `run402 billing history — Show ledger history for a organization

Usage:
  run402 billing history <identifier> [--limit <n>]

Arguments:
  <identifier>        Organization id (UUID), wallet (0x...), or email.
                      Wallet/email are resolved to the organization id first.

Options:
  --limit <n>         Max entries to return (default: 50)

Auth:
  Requires SIWX from a wallet linked to the organization (signed automatically from
  the local allowance), or an admin key. Email lookups require an admin key.

Examples:
  run402 billing history user@example.com
  run402 billing history 0x1234... --limit 100
  run402 billing history 00000000-0000-4000-8000-000000000001
`,
  balance: `run402 billing balance — Show balance for a organization

Usage:
  run402 billing balance <identifier>

Arguments:
  <identifier>        Organization id (UUID), wallet (0x...), or email.
                      Wallet/email are resolved via the organization lookup.

Auth:
  Requires SIWX from a wallet linked to the organization (signed automatically from
  the local allowance), or an admin key. Email lookups require an admin key.

Examples:
  run402 billing balance user@example.com
  run402 billing balance 0x1234abcd...
  run402 billing balance 00000000-0000-4000-8000-000000000001
`,
  "create-email": `run402 billing create-email — Create an email organization

Usage:
  run402 billing create-email <email>

Arguments:
  <email>             Email address to register as a organization

Examples:
  run402 billing create-email user@example.com
`,
  "link-wallet": `run402 billing link-wallet — Link a wallet to an email organization

Usage:
  run402 billing link-wallet <org_id> <wallet>

Arguments:
  <org_id>        Organization ID (e.g. org_abc123)
  <wallet>            Wallet address (0x...) to link

Notes:
  - Tier and quotas are per-organization. Linking a wallet merges its
    spend into the organization-wide pool that already includes every project
    on this organization.
  - The response includes a 'pool_implications' block on v1.46+ gateways:
    tier, projects_in_pool_count, organization_api_calls_current,
    organization_storage_bytes_current, tier_limits, over_limit. Inspect
    'over_limit' before linking a wallet whose existing usage might push
    the merged pool past the tier cap.

Examples:
  run402 billing link-wallet org_abc123 0x1234abcd...
`,
};

function normalizeCheckoutProduct(raw) {
  if (!raw) {
    fail({
      code: "BAD_USAGE",
      message: "Missing --product.",
      hint: "Use --product tier, --product email-pack, or --product balance-topup.",
    });
  }
  const product = String(raw).replace(/-/g, "_");
  if (product === "tier" || product === "email_pack" || product === "balance_topup") {
    return product;
  }
  fail({
    code: "BAD_USAGE",
    message: `Unknown checkout product: ${raw}`,
    hint: "Use tier, email-pack, or balance-topup.",
  });
}

async function checkout(args) {
  const parsedArgs = normalizeArgv(args);
  const valueFlags = ["--product", "--tier", "--amount"];
  assertKnownFlags(parsedArgs, [...valueFlags, "--help", "-h"], valueFlags);
  const positionals = positionalArgs(parsedArgs, valueFlags);
  const identifier = positionals[0];
  if (positionals.length > 1) {
    fail({ code: "BAD_USAGE", message: `Unexpected argument for billing checkout: ${positionals[1]}` });
  }
  if (!identifier) {
    fail({
      code: "BAD_USAGE",
      message: "Missing <identifier>.",
      hint: "run402 billing checkout <identifier> --product <tier|email-pack|balance-topup>",
    });
  }
  const product = normalizeCheckoutProduct(flagValue(parsedArgs, "--product"));
  let checkoutRequest;
  if (product === "tier") {
    const tier = flagValue(parsedArgs, "--tier");
    if (!tier) {
      fail({
        code: "BAD_USAGE",
        message: "Missing --tier for tier checkout.",
        hint: "run402 billing checkout <identifier> --product tier --tier hobby",
      });
    }
    checkoutRequest = { product: "tier", tier };
  } else if (product === "email_pack") {
    checkoutRequest = { product: "email_pack" };
  } else {
    const amountRaw = flagValue(parsedArgs, "--amount");
    if (amountRaw === null) {
      fail({
        code: "BAD_USAGE",
        message: "Missing --amount for balance-topup checkout.",
        hint: "run402 billing checkout <identifier> --product balance-topup --amount 5000000",
      });
    }
    checkoutRequest = {
      product: "balance_topup",
      amountUsdMicros: parseIntegerFlag("--amount", amountRaw, { min: 1 }),
    };
  }
  try {
    const org = await getSdk().billing.lookupOrganization(identifier);
    const data = await getSdk().billing.createCheckout(org.org_id, checkoutRequest);
    console.log(JSON.stringify(data, null, 2));
  } catch (err) {
    reportSdkError(err);
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
    const data = await getSdk().billing.createEmailOrganization(email);
    console.log(JSON.stringify(data, null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

async function linkWallet(args) {
  const parsedArgs = normalizeArgv(args);
  assertKnownFlags(parsedArgs, ["--help", "-h"]);
  const positionals = positionalArgs(parsedArgs);
  const organizationId = positionals[0];
  const wallet = positionals[1];
  if (positionals.length > 2) {
    fail({ code: "BAD_USAGE", message: `Unexpected argument for billing link-wallet: ${positionals[2]}` });
  }
  if (!organizationId || !wallet) {
    fail({
      code: "BAD_USAGE",
      message: "Missing <org_id> and/or <wallet>.",
      hint: "run402 billing link-wallet <org_id> <wallet>",
    });
  }
  try {
    const data = await getSdk().billing.linkWallet(organizationId, wallet);
    const output = {
      status: data?.status ?? "ok",
      org_id: data?.org_id ?? organizationId,
      wallet: data?.wallet ?? wallet.toLowerCase(),
      ...(data?.pool_implications ? { pool_implications: data.pool_implications } : {}),
    };
    console.log(JSON.stringify(output, null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

async function autoRecharge(args) {
  const parsedArgs = normalizeArgv(args);
  const valueFlags = ["--threshold"];
  assertKnownFlags(parsedArgs, [...valueFlags, "--help", "-h"], valueFlags);
  const positionals = positionalArgs(parsedArgs, valueFlags);
  const organizationId = positionals[0];
  const state = positionals[1];
  if (positionals.length > 2) {
    fail({ code: "BAD_USAGE", message: `Unexpected argument for billing auto-recharge: ${positionals[2]}` });
  }
  if (!organizationId || !state || !["on", "off"].includes(state)) {
    fail({
      code: "BAD_USAGE",
      message: "Missing <org_id> and/or <on|off>.",
      hint: "run402 billing auto-recharge <org_id> <on|off> [--threshold <n>]",
    });
  }
  const thresholdStr = flagValue(parsedArgs, "--threshold");
  const threshold = parsedArgs.includes("--threshold")
    ? parseIntegerFlag("--threshold", thresholdStr, { min: 0 })
    : undefined;
  try {
    await getSdk().billing.setAutoRecharge({
      organizationId: organizationId,
      enabled: state === "on",
      threshold,
    });
    console.log(JSON.stringify({ org_id: organizationId, enabled: state === "on", updated: true }));
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
      message: "Missing <identifier>.",
      hint: "run402 billing balance <org-id | wallet | email>",
    });
  }
  try {
    const data = await getSdk().billing.getOrganization(id);
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
      message: "Missing <identifier>.",
      hint: "run402 billing history <org-id | wallet | email> [--limit <n>]",
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
    case "checkout": await checkout(args); break;
    case "auto-recharge": await autoRecharge(args); break;
    case "balance": await balance(args); break;
    case "history": await history(args); break;
    default:
      console.error(`Unknown subcommand: ${sub}\n`);
      console.log(HELP);
      process.exit(1);
  }
}
