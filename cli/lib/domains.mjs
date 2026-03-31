import { resolveProject, API } from "./config.mjs";

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
  const p = resolveProject(project);
  const res = await fetch(`${API}/domains/v1`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${p.service_key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ domain, subdomain_name: subdomainName }),
  });
  const data = await res.json();
  if (!res.ok) { console.error(JSON.stringify({ status: "error", http: res.status, ...data })); process.exit(1); }
  console.log(JSON.stringify(data, null, 2));
}

async function list(projectId) {
  const p = resolveProject(projectId);
  const res = await fetch(`${API}/domains/v1`, {
    headers: { "Authorization": `Bearer ${p.service_key}` },
  });
  const data = await res.json();
  if (!res.ok) { console.error(JSON.stringify({ status: "error", http: res.status, ...data })); process.exit(1); }
  console.log(JSON.stringify(data, null, 2));
}

async function status(args) {
  const { project, rest } = parseProjectFlag(args);
  const domain = rest[0];
  if (!domain) { console.error("Usage: run402 domains status <domain> [--project <id>]"); process.exit(1); }
  const p = resolveProject(project);
  const res = await fetch(`${API}/domains/v1/${encodeURIComponent(domain)}`, {
    headers: { "Authorization": `Bearer ${p.service_key}` },
  });
  const data = await res.json();
  if (!res.ok) { console.error(JSON.stringify({ status: "error", http: res.status, ...data })); process.exit(1); }
  console.log(JSON.stringify(data, null, 2));
}

async function deleteDomain(args) {
  const { project, rest } = parseProjectFlag(args);
  const domain = rest[0];
  if (!domain) { console.error("Usage: run402 domains delete <domain> [--project <id>]"); process.exit(1); }
  const p = resolveProject(project);
  const res = await fetch(`${API}/domains/v1/${encodeURIComponent(domain)}`, {
    method: "DELETE",
    headers: { "Authorization": `Bearer ${p.service_key}` },
  });
  if (res.status === 204 || res.ok) {
    console.log(JSON.stringify({ status: "ok", message: `Domain '${domain}' released.` }));
  } else {
    const data = await res.json().catch(() => ({}));
    console.error(JSON.stringify({ status: "error", http: res.status, ...data })); process.exit(1);
  }
}

export async function run(sub, args) {
  if (!sub || sub === '--help' || sub === '-h') { console.log(HELP); process.exit(0); }
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
