import { resolveProjectId } from "./config.mjs";
import { getSdk } from "./sdk.mjs";
import { reportSdkError, fail } from "./sdk-errors.mjs";
import { assertKnownFlags, flagValue, normalizeArgv, positionalArgs, parseIntegerFlag, failUnknownSubcommand } from "./argparse.mjs";

const HELP = `run402 stripe — Stripe payments for your app, on the organization's own Stripe account

Usage:
  run402 stripe <group> <action> [args...]

Groups:
  account   connect | status | onboarding-link | disconnect --confirm
  checkout  create | get <checkout_session_id>
  portal    create --customer <cus_id> --return-url <url>

The organization that owns the project holds its own Stripe account, connected
to Run402's platform. Run402 charges nothing on it and never holds the money.
Onboarding links are printed exactly once and never cached.
`;

const GROUP_HELP = {
  account: `run402 stripe account — the organization's Stripe account

Usage:
  run402 stripe account connect [--country <iso>] [--business-type company|individual|non_profit] [--business-name <name>] [--support-email <email>] [--statement-descriptor <text>] [--email <email>] [--project <project_id>]
  run402 stripe account status [--project <project_id>]
  run402 stripe account onboarding-link [--return-url <url>] [--refresh-url <url>] [--project <project_id>]
  run402 stripe account disconnect --confirm [--project <project_id>]
`,
  checkout: `run402 stripe checkout — Checkout Sessions on the organization's account

Usage:
  run402 stripe checkout create --mode subscription|payment (--price <price_id> | --price-data <json>) --success-url <url> --cancel-url <url> [options] [--project <project_id>]
  run402 stripe checkout get <checkout_session_id> [--project <project_id>]
`,
  portal: `run402 stripe portal — the organization's Stripe customer portal

Usage:
  run402 stripe portal create --customer <cus_id> --return-url <url> [--project <project_id>]
`,
};

const SUB_HELP = {
  "account connect": `run402 stripe account connect — connect the organization's Stripe account (or return the one it has)

Usage:
  run402 stripe account connect [--country <iso>] [--business-type company|individual|non_profit] [--business-name <name>] [--support-email <email>] [--statement-descriptor <text>] [--email <email>] [--project <project_id>]

While onboarding is incomplete the result carries a one-time onboarding.url for
the account holder. It is printed once; hand it to the person who completes
Stripe's hosted onboarding, then run \`run402 stripe account status\`.

Example:
  run402 stripe account connect --country DE --business-type non_profit --business-name "Ruderverein" --statement-descriptor RUDERVEREIN
`,
  "account status": `run402 stripe account status — the account's state, read fresh from Stripe

Usage:
  run402 stripe account status [--project <project_id>]

Prints status (onboarding | active | restricted | disconnected), charges_enabled,
requirements, and capabilities. Never prints a link.
`,
  "account onboarding-link": `run402 stripe account onboarding-link — mint a one-time Stripe-hosted onboarding link

Usage:
  run402 stripe account onboarding-link [--return-url <url>] [--refresh-url <url>] [--project <project_id>]

URLs must be HTTPS on one of the project's own hosts or the console. The link
is printed once and expires in minutes; mint another when it is used or expired.
`,
  "account disconnect": `run402 stripe account disconnect — detach the account from the platform

Usage:
  run402 stripe account disconnect --confirm [--project <project_id>]

The Stripe account itself is unaffected; only its connection to Run402 ends.
Existing subscriptions keep billing on the organization's account, but Run402
stops receiving their events.
`,
  "checkout create": `run402 stripe checkout create — create a Checkout Session and get the URL to send the payer to

Usage:
  run402 stripe checkout create --mode subscription|payment (--price <price_id> | --price-data <json>) --success-url <url> --cancel-url <url> [options] [--project <project_id>]

Options:
  --quantity <n>               Line quantity (default 1)
  --customer <cus_id>          An existing customer on the organization's account
  --customer-email <email>     Prefill the payer's email (not with --customer)
  --client-reference-id <id>   Your own id for the payer (member:42); echoed on every event
  --metadata <json>            Up to 40 string values; keys beginning run402_ are reserved
  --trial-days <n>             Mode subscription only
  --locale <code>              A Checkout locale (de, fr-FR, auto)
  --idempotency-key <key>      The same key with the same body returns the original session

Examples:
  run402 stripe checkout create --mode subscription --price-data '{"currency":"eur","unit_amount":12000,"product_name":"Annual dues","recurring":{"interval":"year"}}' --success-url https://club.run402.app/join/done --cancel-url https://club.run402.app/join --client-reference-id member:42
  run402 stripe checkout create --mode payment --price price_123 --success-url https://club.run402.app/ok --cancel-url https://club.run402.app/no
`,
  "checkout get": `run402 stripe checkout get — a Checkout Session's outcome, read from Stripe

Usage:
  run402 stripe checkout get <checkout_session_id> [--project <project_id>]

Prints status (open | complete | expired), payment_status (paid | unpaid |
no_payment_required), the customer, subscription and payment intent ids, and
your client_reference_id and metadata.
`,
  "portal create": `run402 stripe portal create — open the customer portal for an existing customer

Usage:
  run402 stripe portal create --customer <cus_id> --return-url <url> [--project <project_id>]

Send the customer to the returned url to manage their subscription and payment
method on the organization's account.
`,
};

/** A value flag, or undefined when absent (flagValue answers null for an absent flag). */
function opt(parsed, flag) {
  const value = flagValue(parsed, flag);
  return value === null || value === undefined ? undefined : value;
}

function print(data) {
  console.log(JSON.stringify(data, null, 2));
}

function noteLinkOnce(url, what) {
  if (typeof url !== "string" || !url) return;
  console.error("");
  console.error(`The ${what} above is one-time and is shown ONCE; it is not cached anywhere.`);
  console.error("Hand it to the account holder now, or mint another when it has been used or expired.");
}

function parseJsonFlag(parsed, flag) {
  const raw = opt(parsed, flag);
  if (raw === undefined) return undefined;
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      fail({ code: "BAD_USAGE", message: `${flag} must be a JSON object.`, details: { flag } });
    }
    return value;
  } catch (err) {
    if (err && typeof err === "object" && "code" in err) throw err;
    return fail({ code: "BAD_USAGE", message: `${flag} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`, details: { flag } });
  }
}

function rejectExtraPositionals(rest, command) {
  if (rest.length > 0) fail({ code: "BAD_USAGE", message: `Unexpected argument for ${command}: ${rest[0]}` });
}

// ── account ──────────────────────────────────────────────────────────────────

async function accountConnect(args) {
  const parsed = normalizeArgv(args);
  const valueFlags = ["--project", "--country", "--business-type", "--business-name", "--support-email", "--statement-descriptor", "--email"];
  assertKnownFlags(parsed, [...valueFlags, "--help", "-h"], valueFlags);
  rejectExtraPositionals(positionalArgs(parsed, valueFlags), "stripe account connect");
  const projectId = resolveProjectId(flagValue(parsed, "--project"));
  const businessType = opt(parsed, "--business-type");
  if (businessType !== undefined && !["company", "individual", "non_profit"].includes(businessType)) {
    fail({ code: "BAD_USAGE", message: "--business-type must be one of company, individual, non_profit.", details: { flag: "--business-type" } });
  }
  const input = {
    country: opt(parsed, "--country"),
    businessType,
    businessName: opt(parsed, "--business-name"),
    supportEmail: opt(parsed, "--support-email"),
    statementDescriptor: opt(parsed, "--statement-descriptor"),
    email: opt(parsed, "--email"),
  };
  try {
    const account = await getSdk().projects.stripe.account.connect(projectId, input);
    print(account);
    noteLinkOnce(account?.onboarding?.url, "onboarding link");
  } catch (err) {
    reportSdkError(err);
  }
}

async function accountStatus(args) {
  const parsed = normalizeArgv(args);
  const valueFlags = ["--project"];
  assertKnownFlags(parsed, [...valueFlags, "--help", "-h"], valueFlags);
  rejectExtraPositionals(positionalArgs(parsed, valueFlags), "stripe account status");
  const projectId = resolveProjectId(flagValue(parsed, "--project"));
  try {
    print(await getSdk().projects.stripe.account.get(projectId));
  } catch (err) {
    reportSdkError(err);
  }
}

async function accountOnboardingLink(args) {
  const parsed = normalizeArgv(args);
  const valueFlags = ["--project", "--return-url", "--refresh-url"];
  assertKnownFlags(parsed, [...valueFlags, "--help", "-h"], valueFlags);
  rejectExtraPositionals(positionalArgs(parsed, valueFlags), "stripe account onboarding-link");
  const projectId = resolveProjectId(flagValue(parsed, "--project"));
  try {
    const link = await getSdk().projects.stripe.onboardingLinks.create(projectId, {
      returnUrl: opt(parsed, "--return-url"),
      refreshUrl: opt(parsed, "--refresh-url"),
    });
    print(link);
    noteLinkOnce(link?.url, "onboarding link");
  } catch (err) {
    reportSdkError(err);
  }
}

async function accountDisconnect(args) {
  const parsed = normalizeArgv(args);
  const valueFlags = ["--project"];
  assertKnownFlags(parsed, [...valueFlags, "--confirm", "--help", "-h"], valueFlags);
  rejectExtraPositionals(positionalArgs(parsed, valueFlags), "stripe account disconnect");
  if (!parsed.includes("--confirm")) {
    fail({
      code: "CONFIRMATION_REQUIRED",
      message: "Disconnecting detaches the organization's Stripe account from Run402 (the Stripe account itself is unaffected). Re-run with --confirm to proceed.",
      hint: "run402 stripe account disconnect --confirm [--project <project_id>]",
    });
  }
  const projectId = resolveProjectId(flagValue(parsed, "--project"));
  try {
    print(await getSdk().projects.stripe.account.disconnect(projectId));
  } catch (err) {
    reportSdkError(err);
  }
}

async function account(args) {
  const [accountAction, ...rest] = Array.isArray(args) ? args : [];
  if (rest.includes("--help") || rest.includes("-h")) {
    const help = SUB_HELP[`account ${accountAction}`];
    if (help) { console.log(help); process.exit(0); }
  }
  if (accountAction === "connect") return accountConnect(rest);
  if (accountAction === "status") return accountStatus(rest);
  if (accountAction === "onboarding-link") return accountOnboardingLink(rest);
  if (accountAction === "disconnect") return accountDisconnect(rest);
  return failUnknownSubcommand("stripe account", accountAction);
}

// ── checkout ─────────────────────────────────────────────────────────────────

function checkoutLineItem(parsed) {
  const price = opt(parsed, "--price");
  const priceData = parseJsonFlag(parsed, "--price-data");
  if ((price === undefined) === (priceData === undefined)) {
    fail({ code: "BAD_USAGE", message: "Pass exactly one of --price <price_id> or --price-data <json>.", hint: "run402 stripe checkout create --help" });
  }
  const quantity = parseIntegerFlag("--quantity", opt(parsed, "--quantity"), { min: 1, max: 999, def: 1 });
  return price !== undefined ? { price, quantity } : { price_data: priceData, quantity };
}

function checkoutOptions(parsed) {
  const customer = opt(parsed, "--customer");
  const customerEmail = opt(parsed, "--customer-email");
  if (customer !== undefined && customerEmail !== undefined) {
    fail({ code: "BAD_USAGE", message: "Pass --customer or --customer-email, not both.", details: { flag: "--customer-email" } });
  }
  const trialDays = opt(parsed, "--trial-days");
  return {
    customer,
    customerEmail,
    clientReferenceId: opt(parsed, "--client-reference-id"),
    metadata: parseJsonFlag(parsed, "--metadata"),
    locale: opt(parsed, "--locale"),
    idempotencyKey: opt(parsed, "--idempotency-key"),
    subscription: trialDays === undefined ? undefined : { trial_period_days: parseIntegerFlag("--trial-days", trialDays, { min: 1, max: 730 }) },
  };
}

async function checkoutCreate(args) {
  const parsed = normalizeArgv(args);
  const valueFlags = [
    "--project", "--mode", "--price", "--price-data", "--quantity", "--success-url", "--cancel-url",
    "--customer", "--customer-email", "--client-reference-id", "--metadata", "--trial-days", "--locale", "--idempotency-key",
  ];
  assertKnownFlags(parsed, [...valueFlags, "--help", "-h"], valueFlags);
  rejectExtraPositionals(positionalArgs(parsed, valueFlags), "stripe checkout create");
  const projectId = resolveProjectId(flagValue(parsed, "--project"));
  const mode = opt(parsed, "--mode");
  if (mode !== "subscription" && mode !== "payment") {
    fail({ code: "BAD_USAGE", message: "--mode must be subscription or payment.", details: { flag: "--mode" } });
  }
  const successUrl = opt(parsed, "--success-url");
  const cancelUrl = opt(parsed, "--cancel-url");
  if (!successUrl || !cancelUrl) {
    fail({ code: "BAD_USAGE", message: "Required flags: --success-url, --cancel-url.", hint: "Both must be HTTPS on one of the project's own hosts or the console." });
  }
  const lineItem = checkoutLineItem(parsed);
  const options = checkoutOptions(parsed);
  try {
    print(await getSdk().projects.stripe.checkoutSessions.create(projectId, { mode, lineItems: [lineItem], successUrl, cancelUrl, ...options }));
  } catch (err) {
    reportSdkError(err);
  }
}

async function checkoutGet(args) {
  const parsed = normalizeArgv(args);
  const valueFlags = ["--project"];
  assertKnownFlags(parsed, [...valueFlags, "--help", "-h"], valueFlags);
  const rest = positionalArgs(parsed, valueFlags);
  const checkoutSessionId = rest[0];
  if (!checkoutSessionId) fail({ code: "BAD_USAGE", message: "Missing <checkout_session_id>.", hint: "run402 stripe checkout get <checkout_session_id> [--project <project_id>]" });
  rejectExtraPositionals(rest.slice(1), "stripe checkout get");
  const projectId = resolveProjectId(flagValue(parsed, "--project"));
  try {
    print(await getSdk().projects.stripe.checkoutSessions.get(projectId, checkoutSessionId));
  } catch (err) {
    reportSdkError(err);
  }
}

async function checkout(args) {
  const [checkoutAction, ...rest] = Array.isArray(args) ? args : [];
  if (rest.includes("--help") || rest.includes("-h")) {
    const help = SUB_HELP[`checkout ${checkoutAction}`];
    if (help) { console.log(help); process.exit(0); }
  }
  if (checkoutAction === "create") return checkoutCreate(rest);
  if (checkoutAction === "get") return checkoutGet(rest);
  return failUnknownSubcommand("stripe checkout", checkoutAction);
}

// ── portal ───────────────────────────────────────────────────────────────────

async function portalCreate(args) {
  const parsed = normalizeArgv(args);
  const valueFlags = ["--project", "--customer", "--return-url"];
  assertKnownFlags(parsed, [...valueFlags, "--help", "-h"], valueFlags);
  rejectExtraPositionals(positionalArgs(parsed, valueFlags), "stripe portal create");
  const customer = opt(parsed, "--customer");
  const returnUrl = opt(parsed, "--return-url");
  if (!customer || !returnUrl) {
    fail({ code: "BAD_USAGE", message: "Required flags: --customer, --return-url.", hint: "run402 stripe portal create --customer <cus_id> --return-url <url>" });
  }
  const projectId = resolveProjectId(flagValue(parsed, "--project"));
  try {
    print(await getSdk().projects.stripe.portalSessions.create(projectId, { customer, returnUrl }));
  } catch (err) {
    reportSdkError(err);
  }
}

async function portal(args) {
  const [portalAction, ...rest] = Array.isArray(args) ? args : [];
  if (rest.includes("--help") || rest.includes("-h")) {
    const help = SUB_HELP[`portal ${portalAction}`];
    if (help) { console.log(help); process.exit(0); }
  }
  if (portalAction === "create") return portalCreate(rest);
  return failUnknownSubcommand("stripe portal", portalAction);
}

// ── dispatch ─────────────────────────────────────────────────────────────────

const GROUPS = ["account", "checkout", "portal"];

export async function run(sub, args) {
  if (!sub || sub === "--help" || sub === "-h") { console.log(HELP); process.exit(0); }
  const argv = Array.isArray(args) ? args : [];
  // The groups dispatch with `if` (not `case`) so the sync test inventories
  // their leaf actions through the `<group>Action === "..."` comparisons.
  if (GROUPS.includes(sub)) {
    const [action] = argv;
    if (!action || action === "--help" || action === "-h") { console.log(GROUP_HELP[sub]); process.exit(0); }
    if (sub === "account") return account(argv);
    if (sub === "checkout") return checkout(argv);
    return portal(argv);
  }
  failUnknownSubcommand("stripe", sub, { extraSubcommands: GROUPS });
}
