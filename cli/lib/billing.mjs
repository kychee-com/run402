import { getSdk } from "./sdk.mjs";
import { reportSdkError, fail } from "./sdk-errors.mjs";
import { assertAllowedValue, assertKnownFlags, flagValue, normalizeArgv, parseIntegerFlag, positionalArgs, failUnknownSubcommand } from "./argparse.mjs";
import { takeOrgPositional, requireRest } from "./org-context.mjs";

const HELP = `run402 billing — Email organizations and org checkouts

Usage:
  run402 billing <subcommand> [args...]

Subcommands:
  create-email <email>                     Create an email organization
  link-wallet [<org_id>] <wallet_address>  Link a wallet to an email organization
  checkout <identifier> --product <p>      Create an org checkout
  topup <identifier> --sats <n> [--wait] [--qr <file.png>]   Top up the allowance over Lightning (a bolt11 invoice; --qr also writes a scannable PNG)
  auto-recharge [<org_id>] <on|off> [--threshold <n>]
  metering [<org_id>] [--enable --cap <usd> | --disable] [--standing-order <on|off>] [--threshold <usd>] [--recharge <usd>]
                                           Metered usage under one monthly cap (no flags: show it)
  card setup [<org_id>] [--return-url <url>]   A one-time link to save a card for the standing order
  balance <identifier>                     The allowance, by organization id (UUID), wallet (0x...), or email
  history <identifier> [--limit <n>]       Ledger history by organization id (UUID), wallet, or email

Examples:
  run402 billing create-email user@example.com
  run402 billing checkout 00000000-0000-4000-8000-000000000001 --product tier --tier hobby
  run402 billing checkout 0x1234... --product email-pack
  run402 billing checkout 0x1234... --product balance-topup --amount 5000000
  run402 billing topup 0x1234... --sats 2000 --wait
  run402 billing topup 0x1234... --sats 2000 --qr /tmp/invoice.png   # also write the invoice as a scannable PNG
  run402 billing auto-recharge org_abc on --threshold 2000
  run402 billing metering --enable --cap 50                 # metered usage, at most $50 this month
  run402 billing card setup                                 # then: metering --standing-order on
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
  run402 billing auto-recharge [<org_id>] <on|off> [--threshold <n>]

Arguments:
  <org_id>        Organization ID
  <on|off>            Enable or disable auto-recharge

Options:
  --threshold <n>     Remaining-email threshold that triggers auto-recharge

Examples:
  run402 billing auto-recharge org_abc on --threshold 2000
  run402 billing auto-recharge org_abc off
`,
  metering: `run402 billing metering — Metered usage under one monthly cap

Usage:
  run402 billing metering [<org_id>]                                  Show the metering block
  run402 billing metering [<org_id>] --enable --cap <usd> [options]   Turn metered usage on
  run402 billing metering [<org_id>] --disable                        Turn it off (keeps the cap and the card)

Arguments:
  <org_id>                Organization ID (optional; else --org, RUN402_ORG, the .run402.json binding, orgs use)

Options:
  --enable                Turn metered usage on (needs a live hobby or team lease)
  --disable               Turn metered usage off
  --cap <usd>             The monthly cap in US dollars (at least 1; required the first time)
  --standing-order <on|off>   The card standing order that refills the allowance under the same cap
  --threshold <usd>       Refill when the allowance falls below this (at least 5; default 10)
  --recharge <usd>        How much each refill adds (at least 5; default 20)

Notes:
  - Storage and vault bytes above the lease's included pools cost a published price
    per GB-month (prorated by the UTC day), API calls above the included amount a
    price per million, charged daily from the allowance and never past the cap in a
    UTC month. Prices: run402 projects quote (the "metered" block).
  - When the allowance or the cap cannot cover a day, metering suspends: nothing is
    deleted, everything keeps serving, the flat pool applies again. Fund the
    allowance, raise the cap, or save a card, and it resumes.
  - --standing-order on needs a saved card: run402 billing card setup.
  - Dollar flags take whole or decimal dollars (--cap 50, --threshold 12.50).

Examples:
  run402 billing metering
  run402 billing metering --enable --cap 50
  run402 billing metering --standing-order on --threshold 10 --recharge 20
  run402 billing metering 00000000-0000-4000-8000-000000000001 --disable
`,
  card: `run402 billing card — The saved card behind the standing order

Usage:
  run402 billing card setup [<org_id>] [--return-url <url>]

Arguments:
  <org_id>                Organization ID (optional; else --org, RUN402_ORG, the .run402.json binding, orgs use)

Options:
  --return-url <url>      Where the browser lands after the card is saved (a run402.com or localhost URL)

Notes:
  - Prints { org_id, setup_url, expires_at }. A person opens setup_url in a browser
    and saves a card; the card is stored by the payment processor and never reaches
    Run402 or this CLI. Then: run402 billing metering --standing-order on.
  - Billing role or higher on the organization; a grant key is refused.

Examples:
  run402 billing card setup
  run402 billing card setup 00000000-0000-4000-8000-000000000001 --return-url http://localhost:3000/billing
`,
  history: `run402 billing history — Show ledger history for a organization

Usage:
  run402 billing history <identifier> [--limit <n>] [--after <cursor>]

Arguments:
  <identifier>        Organization id (UUID), wallet (0x...), or email.
                      Wallet/email are resolved to the organization id first.

Options:
  --limit <n>         Max entries to return (default: 50)
  --after <cursor>    Opaque keyset cursor (next_cursor from a prior page)

Auth:
  Requires SIWX from a wallet linked to the organization (signed automatically from
  the local wallet), or an admin key. Email lookups require an admin key.

Examples:
  run402 billing history user@example.com
  run402 billing history 0x1234... --limit 100
  run402 billing history 00000000-0000-4000-8000-000000000001
`,
  balance: `run402 billing balance — Show an organization's allowance

Usage:
  run402 billing balance <identifier>

Arguments:
  <identifier>        Organization id (UUID), wallet (0x...), or email.
                      Wallet/email are resolved via the organization lookup.

Auth:
  Requires SIWX from a wallet linked to the organization (signed automatically from
  the local wallet), or an admin key. Email lookups require an admin key.

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
  run402 billing link-wallet [<org_id>] <wallet_address>

Arguments:
  <org_id>        Organization ID (e.g. org_abc123)
  <wallet_address>    Wallet address (0x...) to link

Notes:
  - Tier and quotas are per-organization. Linking a wallet merges its
    spend into the organization-wide pool that already includes every project
    on this organization.
  - The response includes a 'pool_implications' block on v1.46+ gateways:
    tier, projects_in_pool_count, org_api_calls_current,
    org_storage_bytes_current, tier_limits, over_limit. Inspect
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

// lightning-cash-topup: "top up N sats" → one invoice, optionally waited on.
// stdout stays one JSON doc per step (the pipe contract); the human-facing
// invoice line and the receipt go to stderr.
async function topup(args) {
  const parsedArgs = normalizeArgv(args);
  const valueFlags = ["--sats", "--timeout", "--idempotency-key", "--qr"];
  assertKnownFlags(parsedArgs, [...valueFlags, "--wait", "--help", "-h"], valueFlags);
  const positionals = positionalArgs(parsedArgs, valueFlags);
  const identifier = positionals[0];
  if (!identifier || positionals.length > 1) {
    fail({ code: "BAD_USAGE", message: "Usage: run402 billing topup <identifier> --sats <n> [--wait]", hint: "run402 billing topup 0x1234... --sats 2000 --wait" });
  }
  const satsRaw = flagValue(parsedArgs, "--sats");
  const sats = Number(satsRaw);
  if (satsRaw === null || !Number.isSafeInteger(sats) || sats <= 0) {
    fail({ code: "BAD_FLAG", message: "--sats must be a positive whole number of satoshis (100–1000000).", details: { flag: "--sats" } });
  }
  const timeoutRaw = flagValue(parsedArgs, "--timeout");
  const timeoutMs = timeoutRaw === null ? 600_000 : Number(timeoutRaw) * 1000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    fail({ code: "BAD_FLAG", message: "--timeout must be a positive number of seconds.", details: { flag: "--timeout" } });
  }
  try {
    const sdk = getSdk();
    const org = await sdk.billing.lookupOrganization(identifier);
    const created = await sdk.billing.createLightningTopup(org.org_id, {
      amountSats: sats,
      idempotencyKey: flagValue(parsedArgs, "--idempotency-key") ?? undefined,
    });
    console.log(JSON.stringify(created, null, 2));
    console.error(`Invoice for ${created.amount_sats} sats (≈ $${(created.amount_usd_micros / 1_000_000).toFixed(2)} at the quoted rate), expires ${created.invoice_expires_at}.`);
    console.error(`Pay it from any Lightning wallet:\n  lightning:${created.bolt11}`);
    const qrPath = flagValue(parsedArgs, "--qr");
    if (qrPath) {
      // Uppercase bolt11 in a `LIGHTNING:` URI is what wallets and the BOLT11
      // spec recommend for QR: alphanumeric mode, a third fewer modules.
      const { toFile } = await import("qrcode");
      await toFile(qrPath, `LIGHTNING:${created.bolt11.toUpperCase()}`, { type: "png", width: 512, margin: 2, errorCorrectionLevel: "M" });
      console.error(`QR written to ${qrPath} — post the image where the payer can scan it.`);
    }
    if (!parsedArgs.includes("--wait")) {
      console.error(`Then read it: run402 billing topup is one-shot; poll GET /orgs/v1/${org.org_id}/checkouts/${created.topup_id} (or rerun with --wait).`);
      return;
    }
    let announced = false;
    const final = await sdk.billing.waitForTopup(org.org_id, created.topup_id, {
      timeoutMs,
      onPoll: () => { if (!announced) { announced = true; console.error("Waiting for the payment…"); } },
    });
    console.log(JSON.stringify(final, null, 2));
    if (final.status === "paid" || final.status === "paid_late") {
      console.error(`Received — ${final.amount_sats} sats added $${(final.amount_usd_micros / 1_000_000).toFixed(2)} to the allowance${final.status === "paid_late" ? " (paid after the invoice expired; still credited)" : ""}.`);
    } else if (final.status === "expired") {
      console.error("No payment was observed before the invoice expired. If you already paid, it still credits on its own (the gateway keeps checking for an hour after expiry) — read the top-up again, or rerun with the same --idempotency-key. Otherwise mint a fresh one with the same command.");
      process.exitCode = 2;
    } else {
      console.error("Timed out still pending — a payment that lands later still credits (up to an hour after expiry); poll the top-up.");
      process.exitCode = 2;
    }
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
  assertKnownFlags(parsedArgs, ["--org", "--address", "--help", "-h"], ["--org", "--address"]);
  const walletFlag = flagValue(parsedArgs, "--address");
  const { orgId: organizationId, rest } = await takeOrgPositional(parsedArgs, ["--org", "--address"], { cmd: "billing" });
  const count = walletFlag ? 0 : 1;
  requireRest(rest, {
    min: count, max: count,
    command: "run402 billing link-wallet [<org_id>] <wallet_address>",
    missing: "Missing <wallet_address> (positional, or --address).",
  });
  const wallet = walletFlag ?? rest[0];
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
  const valueFlags = ["--org", "--threshold", "--state"];
  assertKnownFlags(parsedArgs, [...valueFlags, "--help", "-h"], valueFlags);
  const stateFlag = flagValue(parsedArgs, "--state");
  // Local validation FIRST — a malformed --threshold is refused before any org
  // resolution (which may cost a network hop via --project).
  const thresholdStr = flagValue(parsedArgs, "--threshold");
  const threshold = parsedArgs.includes("--threshold")
    ? parseIntegerFlag("--threshold", thresholdStr, { min: 0 })
    : undefined;
  const { orgId: organizationId, rest } = await takeOrgPositional(parsedArgs, valueFlags, { cmd: "billing" });
  const count = stateFlag ? 0 : 1;
  requireRest(rest, {
    min: count, max: count,
    command: "run402 billing auto-recharge [<org_id>] --state <on|off> [--threshold <n>]",
    missing: "Missing <on|off> (positional, or --state).",
  });
  const state = stateFlag ?? rest[0];
  if (!["on", "off"].includes(state)) {
    fail({
      code: "BAD_USAGE",
      message: `Expected on|off, got ${JSON.stringify(state)}.`,
      hint: "run402 billing auto-recharge [<org_id>] --state <on|off> [--threshold <n>]",
    });
  }
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

// prepaid-metered-usage: whole or decimal US dollars → micro-dollars, exactly
// (string arithmetic, so `--cap 0.1` is 100000 and never 99999.999…).
function parseUsdFlag(name, raw) {
  if (raw === null || raw === undefined) {
    fail({ code: "BAD_FLAG", message: `${name} requires a US-dollar amount (for example ${name} 50 or ${name} 12.50)`, details: { flag: name } });
  }
  const text = String(raw).trim().replace(/^\$/, "");
  const m = /^(\d+)(?:\.(\d{1,6}))?$/.exec(text);
  if (!m) {
    fail({ code: "BAD_FLAG", message: `${name} must be whole or decimal US dollars (up to 6 decimals), got: ${raw}`, details: { flag: name, value: String(raw) } });
  }
  const micros = Number(m[1]) * 1_000_000 + Number((m[2] ?? "").padEnd(6, "0"));
  if (!Number.isSafeInteger(micros) || micros <= 0) {
    fail({ code: "BAD_FLAG", message: `${name} must be a positive US-dollar amount, got: ${raw}`, details: { flag: name, value: String(raw) } });
  }
  return micros;
}

async function metering(args) {
  const parsedArgs = normalizeArgv(args);
  const valueFlags = ["--org", "--cap", "--standing-order", "--threshold", "--recharge"];
  assertKnownFlags(parsedArgs, [...valueFlags, "--enable", "--disable", "--help", "-h"], valueFlags);
  const enable = parsedArgs.includes("--enable");
  const disable = parsedArgs.includes("--disable");
  if (enable && disable) {
    fail({ code: "BAD_USAGE", message: "Pass --enable or --disable, not both.", hint: "run402 billing metering [<org_id>] [--enable --cap <usd> | --disable]" });
  }
  // Local validation FIRST — a malformed dollar amount is refused before any
  // org resolution or network hop.
  const capUsdMicros = parsedArgs.includes("--cap") ? parseUsdFlag("--cap", flagValue(parsedArgs, "--cap")) : undefined;
  const thresholdUsdMicros = parsedArgs.includes("--threshold") ? parseUsdFlag("--threshold", flagValue(parsedArgs, "--threshold")) : undefined;
  const rechargeUsdMicros = parsedArgs.includes("--recharge") ? parseUsdFlag("--recharge", flagValue(parsedArgs, "--recharge")) : undefined;
  const standingRaw = flagValue(parsedArgs, "--standing-order");
  if (standingRaw !== null) assertAllowedValue(standingRaw, ["on", "off"], "--standing-order");
  const { orgId: organizationId, rest } = await takeOrgPositional(parsedArgs, valueFlags, { cmd: "billing" });
  requireRest(rest, {
    min: 0, max: 0,
    command: "run402 billing metering [<org_id>] [--enable --cap <usd> | --disable] [--standing-order <on|off>] [--threshold <usd>] [--recharge <usd>]",
  });
  const touchesStandingOrder = standingRaw !== null || thresholdUsdMicros !== undefined || rechargeUsdMicros !== undefined;
  const writes = enable || disable || capUsdMicros !== undefined || touchesStandingOrder;
  try {
    const sdk = getSdk();
    // A setting flag without --enable/--disable (or a standing-order amount
    // without on|off) keeps the current state for the part it does not name,
    // so `--standing-order on` alone never turns metering off.
    const needsCurrent = !writes || !(enable || disable) || (touchesStandingOrder && standingRaw === null);
    const current = needsCurrent ? await sdk.billing.getMetering(organizationId) : null;
    if (!writes) {
      console.log(JSON.stringify({ org_id: organizationId, metering: current }, null, 2));
      return;
    }
    const enabled = enable ? true : disable ? false : (current?.enabled ?? false);
    const standingOrder = touchesStandingOrder
      ? {
          enabled: standingRaw !== null ? standingRaw === "on" : (current?.standing_order?.enabled ?? false),
          thresholdUsdMicros,
          rechargeUsdMicros,
        }
      : undefined;
    const data = await sdk.billing.setMetering({ organizationId, enabled, capUsdMicros, standingOrder });
    console.log(JSON.stringify(data, null, 2));
    if (data?.metering?.suspended_reason) {
      console.error(`Metering is suspended (${data.metering.suspended_reason}): fund the allowance, raise the cap, or save a card; it resumes on the next daily pass.`);
    }
  } catch (err) {
    reportSdkError(err);
  }
}

// prepaid-metered-usage: `billing card <action>`; the one action is `setup`.
async function card(args) {
  const action = Array.isArray(args) ? args[0] : undefined;
  if (action !== "setup") {
    failUnknownSubcommand("billing card", action, { label: "billing card" });
  }
  const parsedArgs = normalizeArgv(args.slice(1));
  const valueFlags = ["--org", "--return-url"];
  assertKnownFlags(parsedArgs, [...valueFlags, "--help", "-h"], valueFlags);
  const returnUrl = flagValue(parsedArgs, "--return-url");
  const { orgId: organizationId, rest } = await takeOrgPositional(parsedArgs, valueFlags, { cmd: "billing" });
  requireRest(rest, { min: 0, max: 0, command: "run402 billing card setup [<org_id>] [--return-url <url>]" });
  try {
    const data = await getSdk().billing.createCardSetup(organizationId, { returnUrl: returnUrl ?? undefined });
    console.log(JSON.stringify(data, null, 2));
    console.error(`Open setup_url in a browser to save a card for this organization (the link expires ${data.expires_at}); then run402 billing metering --standing-order on.`);
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
      hint: "run402 billing balance <org_id | wallet | email>",
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
  const valueFlags = ["--limit", "--after"];
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
      hint: "run402 billing history <org_id | wallet | email> [--limit <n>] [--after <cursor>]",
    });
  }
  const limit = parsedArgs.includes("--limit")
    ? parseIntegerFlag("--limit", flagValue(parsedArgs, "--limit"), { min: 1 })
    : 50;
  const after = flagValue(parsedArgs, "--after");
  try {
    const data = await getSdk().billing.getHistory(id, { limit, after: after ?? undefined });
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
    case "topup": await topup(args); break;
    case "auto-recharge": await autoRecharge(args); break;
    case "metering": await metering(args); break;
    case "card": await card(args); break;
    case "balance": await balance(args); break;
    case "history": await history(args); break;
    default:
      failUnknownSubcommand("billing", sub);
  }
}
