import { resolveProjectId } from "./config.mjs";
import { getSdk } from "./sdk.mjs";
import { reportSdkError } from "./sdk-errors.mjs";

const HELP = `run402 domains — Manage custom domains

Usage:
  run402 domains <subcommand> [args...]

Subcommands:
  add    <domain> <subdomain_name> [--project <id>]   Register a custom domain
  list   [<id>]                                        List custom domains for a project
  status <domain> [--project <id>]                     Check domain DNS/SSL status
  delete <domain> [--project <id>]                     Release a custom domain

Examples:
  run402 domains add example.com myapp
  run402 domains add example.com myapp --project prj_123
  run402 domains list
  run402 domains status example.com
  run402 domains delete example.com

Notes:
  - After adding a domain, configure DNS as shown in the response
  - Poll 'status' until the domain is active (DNS propagation ~60s)
  - The domain must CNAME to domains.run402.com (or ALIAS for apex domains)
`;

function parseProjectFlag(args) {
  let project = null;
  const rest = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--project" && args[i + 1]) { project = args[++i]; }
    else { rest.push(args[i]); }
  }
  return { project, rest };
}

async function add(args) {
  const { project, rest } = parseProjectFlag(args);
  const domain = rest[0];
  const subdomainName = rest[1];
  if (!domain || !subdomainName) { console.error("Usage: run402 domains add <domain> <subdomain_name> [--project <id>]"); process.exit(1); }
  const projectId = resolveProjectId(project);
  try {
    const data = await getSdk().domains.add(projectId, domain, subdomainName);
    console.log(JSON.stringify(data, null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

async function list(projectIdArg) {
  const projectId = resolveProjectId(projectIdArg);
  try {
    const data = await getSdk().domains.list(projectId);
    console.log(JSON.stringify(data, null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

async function status(args) {
  const { project, rest } = parseProjectFlag(args);
  const domain = rest[0];
  if (!domain) { console.error("Usage: run402 domains status <domain> [--project <id>]"); process.exit(1); }
  const projectId = resolveProjectId(project);
  try {
    const data = await getSdk().domains.status(projectId, domain);
    console.log(JSON.stringify(data, null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

async function deleteDomain(args) {
  const { project, rest } = parseProjectFlag(args);
  const domain = rest[0];
  if (!domain) { console.error("Usage: run402 domains delete <domain> [--project <id>]"); process.exit(1); }
  const projectId = resolveProjectId(project);
  try {
    await getSdk().domains.remove(domain, { projectId });
    console.log(JSON.stringify({ status: "ok", message: `Domain '${domain}' released.` }));
  } catch (err) {
    reportSdkError(err);
  }
}

export async function run(sub, args) {
  if (!sub || sub === '--help' || sub === '-h') { console.log(HELP); process.exit(0); }
  if (Array.isArray(args) && (args.includes("--help") || args.includes("-h"))) { console.log(HELP); process.exit(0); }
  switch (sub) {
    case "add":    await add(args); break;
    case "list":   await list(args[0]); break;
    case "status": await status(args); break;
    case "delete": await deleteDomain(args); break;
    default:
      console.error(`Unknown subcommand: ${sub}\n`);
      console.log(HELP);
      process.exit(1);
  }
}
