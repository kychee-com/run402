#!/usr/bin/env node
/**
 * run402 — CLI for Run402
 * https://run402.com
 */

import { readFileSync } from "node:fs";

const rawArgv = process.argv.slice(2);

const { version } = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8")
);

const HELP = `run402 v${version} — Full-stack backend infra for AI agents
https://run402.com

Usage:
  run402 <command> [subcommand] [options]

Commands:
  init        Set up allowance, funding, and check tier status (x402 default)
  init mpp    Set up with MPP payment rail (Tempo Moderato testnet)
  status      Show full account state (allowance, balance, tier, projects)
  wallets     Manage multiple named wallets (list, new, use, rename, bind, import)
  allowance   Manage your agent allowance (create, fund, balance, status)
  tier        Manage tier subscription (status, set)
  projects    Manage projects (provision, list, query, inspect, delete)
  admin       Platform-admin operations (lease-perpetual, archive, reactivate)
  deploy      Unified deploy operations (requires active tier)
  ci          Link GitHub Actions OIDC deploy bindings
  transfer    Two-party project transfer (init, preview, list, accept, cancel)
  jobs        Submit and inspect fixed platform-managed jobs
  functions   Manage serverless functions (deploy, invoke, logs, list, delete)
  secrets     Manage project secrets (set, list, delete)
  assets      Direct-to-S3 asset storage (put, get, ls, rm, sign, diagnose) — up to 5 TiB
  sites       Deploy static sites
  cdn         CloudFront CDN diagnostics (wait-fresh) for public asset URLs
  subdomains  Manage custom subdomains (claim, list, delete)
  domains     Manage custom domains (add, list, status, delete)
  apps        Browse and manage the app marketplace
  ai          AI translation and moderation tools
  image       Generate AI images via x402 or MPP micropayments
  email       Send template-based emails from your project
  message     Send messages to Run402 developers
  auth        Manage project user authentication (magic link, passwords, settings)
  sender-domain  Manage custom email sender domain (register, status, remove)
  billing     Email billing accounts, Stripe tier checkout, email packs
  contracts   KMS contract wallets ($0.04/day rental + $0.000005/sign)
  agent       Manage agent identity (contact info)
  operator    Operator (human/email) session — login, then overview across your wallets
  service     Run402 service health and availability (status, health)
  cache       Inspect and invalidate the SSR origin cache (inspect, invalidate)
  doctor      Health and config diagnostics (machine-readable with --json)
  dev         Run Astro dev with Run402 env + credentials in scope
  logs        Fetch function logs by request id (--request-id req_...)

Global options (any command):
  --wallet <name>   Select a named wallet for this command (see 'run402 wallets')
                    Also: RUN402_WALLET env, or a ./.run402.json directory binding.

Run 'run402 <command> --help' for detailed usage of each command.

Examples:
  run402 allowance create
  run402 allowance fund
  run402 deploy apply --manifest app.json
  run402 jobs submit --file job.json
  run402 projects list
  run402 projects sql <project_id> "SELECT * FROM users LIMIT 5"
  run402 functions deploy <project_id> my-fn --file handler.ts
  run402 secrets set <project_id> API_KEY sk-1234
  run402 image generate "a startup mascot, pixel art" --output logo.png

Getting started:
  run402 init               Set up with x402 (Base Sepolia)
  run402 init mpp           Set up with MPP (Tempo Moderato)
  run402 tier set prototype  Subscribe to a tier
  run402 deploy apply --manifest app.json
  run402 ci link github --project prj_... --manifest run402.deploy.json
`;

const first = rawArgv[0];

if (first === '--version' || first === '-v') {
  console.log(version);
  process.exit(0);
}

if (first === undefined || first === '--help' || first === '-h') {
  console.log(HELP);
  process.exit(0);
}

// Resolve the active wallet/profile from the global --wallet/--profile flag,
// env, and any per-directory .run402.json binding BEFORE dispatch loads a
// subcommand (whose config.mjs snapshots credential paths). splitWalletFlag
// also strips the global flag so subcommands never see it.
const { splitWalletFlag, applyWalletSelection } = await import("./lib/wallet-context.mjs");
const { argv, walletFlag } = splitWalletFlag(rawArgv);
const [cmd, sub, ...rest] = argv;

try {
  applyWalletSelection({
    walletFlag,
    cmd,
    cwd: process.cwd(),
    env: process.env,
    quiet: rawArgv.includes("--quiet"),
  });
  await dispatch();
} catch (err) {
  // Surface env/config errors (e.g. invalid RUN402_API_BASE, bad RUN402_WALLET)
  // as a clean JSON envelope on stderr instead of a raw stack trace. We import
  // the helper lazily so a broken env doesn't fail this catch handler too.
  const { fail } = await import("./lib/sdk-errors.mjs");
  fail({
    code: "BAD_ENV",
    message: err && err.message ? err.message : String(err),
    hint: typeof err?.message === "string" && err.message.includes("RUN402_API_BASE")
      ? "Check the RUN402_API_BASE env var."
      : undefined,
  });
}

async function dispatch() {
switch (cmd) {
  case "init": {
    const { run } = await import("./lib/init.mjs");
    await run([sub, ...rest].filter(Boolean));
    break;
  }
  case "status": {
    const { run } = await import("./lib/status.mjs");
    await run([sub, ...rest].filter(Boolean));
    break;
  }
  case "wallets": {
    const { run } = await import("./lib/wallets.mjs");
    await run(sub, rest);
    break;
  }
  case "allowance": {
    const { run } = await import("./lib/allowance.mjs");
    await run(sub, rest);
    break;
  }
  case "tier": {
    const { run } = await import("./lib/tier.mjs");
    await run(sub, rest);
    break;
  }
  case "projects": {
    const { run } = await import("./lib/projects.mjs");
    await run(sub, rest);
    break;
  }
  case "admin": {
    const { run } = await import("./lib/admin.mjs");
    await run(sub, rest);
    break;
  }
  case "deploy": {
    const { run } = await import("./lib/deploy.mjs");
    await run([sub, ...rest].filter(Boolean));
    break;
  }
  case "ci": {
    const { run } = await import("./lib/ci.mjs");
    await run(sub, rest);
    break;
  }
  case "transfer": {
    const { run } = await import("./lib/transfer.mjs");
    await run(sub, rest);
    break;
  }
  case "jobs": {
    const { run } = await import("./lib/jobs.mjs");
    await run(sub, rest);
    break;
  }
  case "functions": {
    const { run } = await import("./lib/functions.mjs");
    await run(sub, rest);
    break;
  }
  case "secrets": {
    const { run } = await import("./lib/secrets.mjs");
    await run(sub, rest);
    break;
  }
  case "assets": {
    const { run } = await import("./lib/assets.mjs");
    await run(sub, rest);
    break;
  }
  case "cdn": {
    const { run } = await import("./lib/cdn.mjs");
    await run(sub, rest);
    break;
  }
  case "sites": {
    const { run } = await import("./lib/sites.mjs");
    await run(sub, rest);
    break;
  }
  case "subdomains": {
    const { run } = await import("./lib/subdomains.mjs");
    await run(sub, rest);
    break;
  }
  case "domains": {
    const { run } = await import("./lib/domains.mjs");
    await run(sub, rest);
    break;
  }
  case "apps": {
    const { run } = await import("./lib/apps.mjs");
    await run(sub, rest);
    break;
  }
  case "ai": {
    const { run } = await import("./lib/ai.mjs");
    await run(sub, rest);
    break;
  }
  case "image": {
    const { run } = await import("./lib/image.mjs");
    await run(sub, rest);
    break;
  }
  case "email": {
    const { run } = await import("./lib/email.mjs");
    await run(sub, rest);
    break;
  }
  case "message": {
    const { run } = await import("./lib/message.mjs");
    await run(sub, rest);
    break;
  }
  case "agent": {
    const { run } = await import("./lib/agent.mjs");
    await run(sub, rest);
    break;
  }
  case "operator": {
    const { run } = await import("./lib/operator.mjs");
    await run(sub, rest);
    break;
  }
  case "auth": {
    const { run } = await import("./lib/auth.mjs");
    await run(sub, rest);
    break;
  }
  case "sender-domain": {
    const { run } = await import("./lib/sender-domain.mjs");
    await run(sub, rest);
    break;
  }
  case "billing": {
    const { run } = await import("./lib/billing.mjs");
    await run(sub, rest);
    break;
  }
  case "contracts": {
    const { run } = await import("./lib/contracts.mjs");
    await run(sub, rest);
    break;
  }
  case "service": {
    const { run } = await import("./lib/service.mjs");
    await run(sub, rest);
    break;
  }
  case "cache": {
    const { run } = await import("./lib/cache.mjs");
    await run(sub, rest);
    break;
  }
  case "doctor": {
    const { run } = await import("./lib/doctor.mjs");
    await run(sub, rest);
    break;
  }
  case "notifications": {
    const { run } = await import("./lib/notifications.mjs");
    await run(sub, rest);
    break;
  }
  case "webhook-secret": {
    const { runWebhookSecret } = await import("./lib/notifications.mjs");
    await runWebhookSecret(sub, rest);
    break;
  }
  case "logs": {
    const { run } = await import("./lib/logs.mjs");
    await run(sub, rest);
    break;
  }
  case "dev": {
    const { run } = await import("./lib/dev.mjs");
    await run(sub, rest);
    break;
  }
  default:
    console.error(`Unknown command: ${cmd}\n`);
    console.log(HELP);
    process.exit(1);
}
}
