import { findProject, resolveProjectId, API } from "./config.mjs";

const HELP = `run402 sender-domain — Manage custom email sender domain

Usage:
  run402 sender-domain <subcommand> [args...]

Subcommands:
  register <domain> [--project <id>]   Register a custom sender domain (returns DNS records)
  status [--project <id>]              Check domain verification status
  remove [--project <id>]              Remove custom sender domain
  inbound-enable <domain> [--project <id>]   Enable inbound email (requires DKIM-verified)
  inbound-disable <domain> [--project <id>]  Disable inbound email

Examples:
  run402 sender-domain register kysigned.com
  run402 sender-domain status
  run402 sender-domain remove
  run402 sender-domain inbound-enable kysigned.com
  run402 sender-domain inbound-disable kysigned.com
`;

function parseFlag(args, flag) {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === flag && args[i + 1]) return args[i + 1];
  }
  return null;
}

async function register(args) {
  let domain = null;
  let projectOpt = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--project" && args[i + 1]) { projectOpt = args[++i]; }
    else if (!args[i].startsWith("--") && !domain) { domain = args[i]; }
  }
  const projectId = resolveProjectId(projectOpt);
  const p = findProject(projectId);

  if (!domain) {
    console.error(JSON.stringify({ status: "error", message: "Missing domain. Usage: run402 sender-domain register <domain>" }));
    process.exit(1);
  }

  const res = await fetch(`${API}/email/v1/domains`, {
    method: "POST",
    headers: { apikey: p.service_key, "Content-Type": "application/json" },
    body: JSON.stringify({ domain }),
  });
  const data = await res.json();
  if (!res.ok) {
    console.error(JSON.stringify({ status: "error", http: res.status, ...data }));
    process.exit(1);
  }
  console.log(JSON.stringify(data, null, 2));
}

async function status(args) {
  const projectId = resolveProjectId(parseFlag(args, "--project"));
  const p = findProject(projectId);

  const res = await fetch(`${API}/email/v1/domains`, {
    headers: { apikey: p.service_key },
  });
  const data = await res.json();
  if (!res.ok) {
    console.error(JSON.stringify({ status: "error", http: res.status, ...data }));
    process.exit(1);
  }
  console.log(JSON.stringify(data, null, 2));
}

async function remove(args) {
  const projectId = resolveProjectId(parseFlag(args, "--project"));
  const p = findProject(projectId);

  const res = await fetch(`${API}/email/v1/domains`, {
    method: "DELETE",
    headers: { apikey: p.service_key },
  });
  const data = await res.json();
  if (!res.ok) {
    console.error(JSON.stringify({ status: "error", http: res.status, ...data }));
    process.exit(1);
  }
  console.log(JSON.stringify(data));
}

async function inboundToggle(action, args) {
  let domain = null;
  let projectOpt = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--project" && args[i + 1]) { projectOpt = args[++i]; }
    else if (!args[i].startsWith("--") && !domain) { domain = args[i]; }
  }
  const projectId = resolveProjectId(projectOpt);
  const p = findProject(projectId);

  if (!domain) {
    console.error(JSON.stringify({ status: "error", message: `Missing domain. Usage: run402 sender-domain inbound-${action} <domain>` }));
    process.exit(1);
  }

  const method = action === "enable" ? "POST" : "DELETE";
  const res = await fetch(`${API}/email/v1/domains/inbound`, {
    method,
    headers: { apikey: p.service_key, "Content-Type": "application/json" },
    body: JSON.stringify({ domain }),
  });
  const data = await res.json();
  if (!res.ok) {
    console.error(JSON.stringify({ status: "error", http: res.status, ...data }));
    process.exit(1);
  }
  console.log(JSON.stringify(data, null, 2));
}

export async function run(sub, args) {
  if (!sub || sub === "--help" || sub === "-h") { console.log(HELP); process.exit(0); }
  switch (sub) {
    case "register": await register(args); break;
    case "status": await status(args); break;
    case "remove": await remove(args); break;
    case "inbound-enable": await inboundToggle("enable", args); break;
    case "inbound-disable": await inboundToggle("disable", args); break;
    default:
      console.error(`Unknown subcommand: ${sub}\n`);
      console.log(HELP);
      process.exit(1);
  }
}
