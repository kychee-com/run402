#!/usr/bin/env node
/**
 * run402 — CLI for Run402
 * https://run402.com
 */

const [,, cmd, sub, ...rest] = process.argv;

const HELP = `run402 v1.0.0 — Full-stack backend infra for AI agents
https://run402.com

Usage:
  run402 <command> [subcommand] [options]

Commands:
  init        Set up allowance, funding, and check tier status
  allowance   Manage your agent allowance (create, fund, balance, status)
  tier        Manage tier subscription (status, set)
  projects    Manage projects (provision, list, query, inspect, delete)
  deploy      Deploy a full-stack app or static site (requires active tier)
  functions   Manage serverless functions (deploy, invoke, logs, list, delete)
  secrets     Manage project secrets (set, list, delete)
  storage     Manage file storage (upload, download, list, delete)
  sites       Deploy static sites
  subdomains  Manage custom subdomains (claim, list, delete)
  apps        Browse and manage the app marketplace
  image       Generate AI images via x402 micropayments
  message     Send messages to Run402 developers
  agent       Manage agent identity (contact info)

Run 'run402 <command> --help' for detailed usage of each command.

Examples:
  run402 allowance create
  run402 allowance fund
  run402 deploy --manifest app.json
  run402 projects list
  run402 projects sql <project_id> "SELECT * FROM users LIMIT 5"
  run402 functions deploy <project_id> my-fn --code handler.ts
  run402 secrets set <project_id> API_KEY sk-1234
  run402 image generate "a startup mascot, pixel art" --output logo.png

Getting started:
  run402 init               Set up everything in one command
  run402 tier set prototype  Subscribe to a tier
  run402 deploy --manifest app.json
`;

if (!cmd || cmd === '--help' || cmd === '-h') {
  console.log(HELP);
  process.exit(cmd ? 0 : 0);
}

switch (cmd) {
  case "init": {
    const { run } = await import("./lib/init.mjs");
    await run();
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
  case "deploy": {
    const { run } = await import("./lib/deploy.mjs");
    await run([sub, ...rest].filter(Boolean));
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
  case "storage": {
    const { run } = await import("./lib/storage.mjs");
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
  case "apps": {
    const { run } = await import("./lib/apps.mjs");
    await run(sub, rest);
    break;
  }
  case "image": {
    const { run } = await import("./lib/image.mjs");
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
  default:
    console.error(`Unknown command: ${cmd}\n`);
    console.log(HELP);
    process.exit(1);
}
