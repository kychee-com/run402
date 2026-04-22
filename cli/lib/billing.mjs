import { API } from "./config.mjs";

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
};

function parseFlag(args, flag) {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === flag && args[i + 1]) return args[i + 1];
  }
  return null;
}

async function createEmail(args) {
  const email = args[0];
  if (!email) {
    console.error(JSON.stringify({ status: "error", message: "Missing email. Usage: run402 billing create-email <email>" }));
    process.exit(1);
  }
  const res = await fetch(`${API}/billing/v1/accounts`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email }),
  });
  const data = await res.json();
  if (!res.ok) { console.error(JSON.stringify({ status: "error", http: res.status, ...data })); process.exit(1); }
  console.log(JSON.stringify(data, null, 2));
}

async function linkWallet(args) {
  const accountId = args[0];
  const wallet = args[1];
  if (!accountId || !wallet) {
    console.error(JSON.stringify({ status: "error", message: "Usage: run402 billing link-wallet <account_id> <wallet>" }));
    process.exit(1);
  }
  const res = await fetch(`${API}/billing/v1/accounts/${encodeURIComponent(accountId)}/link-wallet`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ wallet }),
  });
  const data = await res.json();
  if (!res.ok) { console.error(JSON.stringify({ status: "error", http: res.status, ...data })); process.exit(1); }
  console.log(JSON.stringify(data, null, 2));
}

async function tierCheckout(args) {
  const tier = args[0];
  if (!tier) {
    console.error(JSON.stringify({ status: "error", message: "Usage: run402 billing tier-checkout <tier> [--email <e> | --wallet <w>]" }));
    process.exit(1);
  }
  const email = parseFlag(args, "--email");
  const wallet = parseFlag(args, "--wallet");
  if (!email && !wallet) {
    console.error(JSON.stringify({ status: "error", message: "Must provide --email or --wallet" }));
    process.exit(1);
  }
  const body = email ? { email } : { wallet };
  const res = await fetch(`${API}/billing/v1/tiers/${encodeURIComponent(tier)}/checkout`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) { console.error(JSON.stringify({ status: "error", http: res.status, ...data })); process.exit(1); }
  console.log(JSON.stringify(data, null, 2));
}

async function buyPack(args) {
  const email = parseFlag(args, "--email");
  const wallet = parseFlag(args, "--wallet");
  if (!email && !wallet) {
    console.error(JSON.stringify({ status: "error", message: "Must provide --email or --wallet" }));
    process.exit(1);
  }
  const body = email ? { email } : { wallet };
  const res = await fetch(`${API}/billing/v1/email-packs/checkout`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) { console.error(JSON.stringify({ status: "error", http: res.status, ...data })); process.exit(1); }
  console.log(JSON.stringify(data, null, 2));
}

async function autoRecharge(args) {
  const accountId = args[0];
  const state = args[1];
  if (!accountId || !state || !["on", "off"].includes(state)) {
    console.error(JSON.stringify({ status: "error", message: "Usage: run402 billing auto-recharge <account_id> <on|off> [--threshold <n>]" }));
    process.exit(1);
  }
  const thresholdStr = parseFlag(args, "--threshold");
  const body = {
    billing_account_id: accountId,
    enabled: state === "on",
  };
  if (thresholdStr) body.threshold = Number(thresholdStr);
  const res = await fetch(`${API}/billing/v1/email-packs/auto-recharge`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) { console.error(JSON.stringify({ status: "error", http: res.status, ...data })); process.exit(1); }
  console.log(JSON.stringify(data, null, 2));
}

async function balance(args) {
  const id = args[0];
  if (!id) {
    console.error(JSON.stringify({ status: "error", message: "Usage: run402 billing balance <email-or-wallet>" }));
    process.exit(1);
  }
  const res = await fetch(`${API}/billing/v1/accounts/${encodeURIComponent(id)}`);
  const data = await res.json();
  if (!res.ok) { console.error(JSON.stringify({ status: "error", http: res.status, ...data })); process.exit(1); }
  console.log(JSON.stringify(data, null, 2));
}

async function history(args) {
  const id = args[0];
  if (!id) {
    console.error(JSON.stringify({ status: "error", message: "Usage: run402 billing history <email-or-wallet> [--limit <n>]" }));
    process.exit(1);
  }
  const limit = parseFlag(args, "--limit") || "50";
  const res = await fetch(`${API}/billing/v1/accounts/${encodeURIComponent(id)}/history?limit=${encodeURIComponent(limit)}`);
  const data = await res.json();
  if (!res.ok) { console.error(JSON.stringify({ status: "error", http: res.status, ...data })); process.exit(1); }
  console.log(JSON.stringify(data, null, 2));
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
