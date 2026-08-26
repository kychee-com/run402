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

Commands, grouped by when you reach for them:

SET UP — get an agent funded and entitled
  init        Set up allowance, funding, and check tier status (x402 default)
  init mpp    Set up with MPP payment rail (Tempo Moderato testnet)
  wallets     Manage multiple named wallets (list, new, use, rename, bind, import)
  allowance   Manage your agent allowance (create, fund, balance, status)
  tier        Manage tier subscription (status, set)
  redeem      Redeem a promo code for run402 credit
  pay         Call an arbitrary x402-priced URL with a bounded payment

BUILD & SHIP — the app and everything it serves
  up          Provision/link/deploy the current app with SDK orchestration
  projects    Manage projects (provision, list, get, sql, delete)
  repos       Vault-only hosted encrypted repos, zero deploy ceremony (create, list, delete)
  deploy      Unified deploy operations (requires active tier)
  apply       Alias for deploy apply; supports --rehearse for migration rehearsal
  functions   Manage serverless functions (deploy, invoke, logs, list, delete)
  secrets     Manage project secrets (set, list, delete)
  sites       Deploy static sites
  assets      Direct-to-S3 asset storage (put, get, ls, rm, sign, diagnose) — up to 5 TiB
  domains     Manage ProjectDomain lifecycle (connect, check, repair, wait)
  subdomains  Manage custom subdomains (claim, list, delete)

OPERATE — what happened, and is it healthy
  events      What happened to your project since you last looked (cursored feed)
  errors      Grouped error fingerprints + a promote/revert verdict (release-baselined)
  logs        Fetch function logs by request id (--request-id req_...)
  status      Show full account state (allowance, balance, tier, projects)
  doctor      Health and config diagnostics (JSON by default; includes --buzz preflight)
  service     Run402 service health and availability (status, health)
  snapshots   Create/list/restore/delete project data snapshots
  branches    Create/list/renew/delete contained project branches

COORDINATE — work alongside other agents and humans
  messages    Room-visible messages between agents (send/list/get/ack)
  rooms       Arrive in a room, see who is live, leave when done
  claims      Say what you're working on before you collide (advisory)
  escalations Page a human when you judge you need one (raise/list/ack)
  feedback    Send feedback to the Run402 developers (free with an active tier)

AUTHORITY — who may act, and with what credential
  credentials Manage local credential material (project-keys)
  delegates   Scoped deploy credentials for agents (create, list, revoke, rotate)
  grants      Per-project capability grants for agent/CI principals (create, revoke)
  org         Org membership, invites & audit (whoami, list, member, invite, audit)
  identity    Public proof-backed external agent identity links
  auth        Manage project user authentication (magic link, passwords, settings)
  ci          Link GitHub Actions OIDC deploy bindings
  operator    Operator (human/email) session — login, then overview across your wallets

DELIVER — reach a human when something happens
  deliveries     Did a notification actually land (list, get)
  contacts       Where a human is reachable — paging ladder + Telegram (list, add, connect, rm, preferences)
  subscriptions  Which events go where (add, list, rm)
  webhook-secret Rotate the operator webhook signing secret
  email          Send template-based emails from your project

PLATFORM — everything else, and the things still finding a home
  admin       Platform-admin operations (lease-perpetual, archive, reactivate)
  billing     Email organizations, Stripe tier checkout, email packs
  contracts   KMS signers ($0.04/day rental + $0.000005/sign)
  jobs        Submit and inspect platform-managed jobs
  transfer    Two-party project transfer (init, preview, list, accept, cancel)
  cloud       Cloud portability archive export (archives create/download/status)
  archives    Inspect and verify portable project archives locally
  gitvault    Host-blind encrypted Git remote (init/status/push/policy/compact/prune/verify/mirror/recover)
  buzz        Buzz human/community/agent control-plane workflows
  apps        Browse and manage the app marketplace
  ai          AI translation and moderation tools
  image       Generate AI images via x402 or MPP micropayments
  cdn         CloudFront CDN diagnostics (wait-fresh) for public asset URLs
  cache       Inspect and invalidate the SSR origin cache (inspect, invalidate)
  agent       Manage agent identity (contact info)
  core        Local Run402 Core import helpers
  dev         Run Astro dev with Run402 env + credentials in scope

Global options (any command):
  --wallet <name>   Select a named wallet for this command (see 'run402 wallets')
                    Also: RUN402_WALLET env, or a ./.run402.json directory binding.

Run 'run402 <command> --help' for detailed usage of each command.

Examples:
  run402 up --name my-app -y
  run402 allowance create
  run402 allowance fund
  run402 pay https://seller.example/resource --max-usd 0.05
  run402 deploy apply --manifest app.json
  run402 apply --manifest app.json --rehearse --json
  run402 snapshots list --project prj_...
  run402 branches create --project prj_... --ttl-days 7 --json
  run402 cloud archives create --project prj_... --wait --output ./project.r402ar --json
  run402 core projects import ./project.r402ar --name imported-project --env-file ./required.env --json
  run402 jobs submit --file job.json
  run402 projects list
  run402 projects sql "SELECT * FROM users LIMIT 5" --project <project_id>
  run402 functions deploy my-fn --file handler.ts --project <project_id>
  run402 secrets set API_KEY --value sk-1234 --project <project_id>
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
  case "up": {
    const { run } = await import("./lib/up.mjs");
    await run([sub, ...rest].filter(Boolean));
    break;
  }
  case "init": {
    const { run } = await import("./lib/init.mjs");
    await run([sub, ...rest].filter(Boolean));
    break;
  }
  case "pay": {
    const { run } = await import("./lib/pay.mjs");
    await run([sub, ...rest].filter(Boolean));
    break;
  }
  case "redeem": {
    const { run } = await import("./lib/redeem.mjs");
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
  case "credentials": {
    const { run } = await import("./lib/credentials.mjs");
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
  case "repos": {
    const { run } = await import("./lib/repos.mjs");
    await run(sub, rest);
    break;
  }
  case "apply": {
    const { runDeployV2 } = await import("./lib/deploy-v2.mjs");
    await runDeployV2("apply", [sub, ...rest].filter(Boolean));
    break;
  }
  case "snapshots": {
    const { run } = await import("./lib/snapshots.mjs");
    await run(sub, rest);
    break;
  }
  case "branches": {
    const { run } = await import("./lib/branches.mjs");
    await run(sub, rest);
    break;
  }
  case "admin": {
    const { run } = await import("./lib/admin.mjs");
    await run(sub, rest);
    break;
  }
  case "cloud": {
    const { run } = await import("./lib/cloud.mjs");
    await run(sub, rest);
    break;
  }
  case "archives": {
    const { run } = await import("./lib/archives.mjs");
    await run(sub, rest);
    break;
  }
  case "core": {
    const { run } = await import("./lib/core.mjs");
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
  case "org": {
    const { run } = await import("./lib/org.mjs");
    await run(sub, rest);
    break;
  }
  case "identity": {
    const { run } = await import("./lib/identity.mjs");
    await run(sub, rest);
    break;
  }
  case "buzz": {
    const { run } = await import("./lib/buzz.mjs");
    await run(sub, rest);
    break;
  }
  case "grants": {
    const { run } = await import("./lib/grants.mjs");
    await run(sub, rest);
    break;
  }
  case "delegates": {
    const { run } = await import("./lib/delegates.mjs");
    await run(sub, rest);
    break;
  }
  case "events": {
    const { run } = await import("./lib/events.mjs");
    await run(sub, rest);
    break;
  }
  case "messages": {
    const { run } = await import("./lib/messages.mjs");
    await run(sub, rest);
    break;
  }
  case "rooms": {
    const { run } = await import("./lib/rooms.mjs");
    await run(sub, rest);
    break;
  }
  case "claims": {
    const { run } = await import("./lib/claims.mjs");
    await run(sub, rest);
    break;
  }
  case "gitvault": {
    const { run } = await import("./lib/gitvault.mjs");
    await run(sub, rest);
    break;
  }
  case "escalations": {
    const { run } = await import("./lib/escalations.mjs");
    await run(sub, rest);
    break;
  }
  case "errors": {
    const { run } = await import("./lib/errors.mjs");
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
  case "feedback": {
    const { run } = await import("./lib/feedback.mjs");
    await run(sub, rest);
    break;
  }
  // `message` is RESERVED, not merely renamed: it is being kept free for
  // addressed agent/human messaging. Aliasing it to feedback would cement the
  // old meaning on the exact noun that is about to mean something else.
  case "message": {
    const { fail } = await import("./lib/sdk-errors.mjs");
    fail({
      code: "COMMAND_REMOVED",
      message: "`run402 message` was renamed to `run402 feedback`.",
      hint: "run402 feedback send \"<text>\"",
      details: { was: "message", now: "feedback", reserved: "the `message` noun is reserved for addressed agent/human messaging" },
      next_actions: [
        { type: "edit_request", command: "run402 feedback send \"<text>\"", why: "Send feedback to the Run402 developers." },
        { type: "edit_request", command: "run402 messages send \"<text>\"", why: "Message the other agents working in this room." },
        { type: "edit_request", command: "run402 escalations raise \"<text>\"", why: "Page a human and wait for a named one to take it." },
      ],
    });
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
  case "deliveries": {
    const { run } = await import("./lib/deliveries.mjs");
    await run(sub, rest);
    break;
  }
  case "contacts": {
    const { run } = await import("./lib/contacts.mjs");
    await run(sub, rest);
    break;
  }
  case "subscriptions": {
    const { run } = await import("./lib/subscriptions.mjs");
    await run(sub, rest);
    break;
  }
  case "notifications": {
    const { run } = await import("./lib/notifications.mjs");
    await run(sub, rest);
    break;
  }
  case "webhook-secret": {
    const { run } = await import("./lib/webhook-secret.mjs");
    await run(sub, rest);
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
  default: {
    const { fail } = await import("./lib/sdk-errors.mjs");
    // Did-you-mean candidates: manifest families ∪ the allowlisted skipped
    // families — together these cover every case in this switch (the
    // cli-conventions gate keeps them in lockstep), so no second list.
    const { COMMAND_MANIFEST, SKIPPED_FAMILIES } = await import("./lib/command-manifest.mjs");
    const { closestWord } = await import("./lib/argparse.mjs");
    const families = new Set([
      ...COMMAND_MANIFEST.map((entry) => entry.path[0]),
      ...Object.keys(SKIPPED_FAMILIES),
    ]);
    const closest = typeof cmd === "string" ? closestWord(cmd, [...families]) : null;
    fail({
      code: "UNKNOWN_COMMAND",
      message: closest
        ? `Unknown command: ${cmd}. Did you mean ${closest}?`
        : `Unknown command: ${cmd}`,
      hint: "Run `run402 --help` for the command list.",
      details: { command: cmd, closest: closest ? [closest] : [] },
    });
  }
}
}
