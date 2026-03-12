import { findProject, API } from "./config.mjs";

const HELP = `run402 subdomains — Manage custom subdomains

Usage:
  run402 subdomains <subcommand> [args...]

Subcommands:
  claim  <deployment_id> <name> [--project <id>]   Claim a subdomain for a deployment
  delete <name> [--project <id>]                    Release a subdomain
  list   <id>                                       List subdomains for a project

Examples:
  run402 subdomains claim dpl_abc123 myapp
  run402 subdomains claim dpl_abc123 myapp --project proj123
  run402 subdomains delete myapp
  run402 subdomains list proj123

Notes:
  - Subdomain names: 3-63 chars, lowercase alphanumeric + hyphens
  - Creates <name>.run402.com pointing to the deployment
`;

async function claim(deploymentId, name, args) {
  const opts = { project: null };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--project" && args[i + 1]) opts.project = args[++i];
  }
  const headers = { "Content-Type": "application/json" };
  if (opts.project) {
    const p = findProject(opts.project);
    headers["Authorization"] = `Bearer ${p.service_key}`;
  }
  const res = await fetch(`${API}/v1/subdomains`, {
    method: "POST",
    headers,
    body: JSON.stringify({ name, deployment_id: deploymentId }),
  });
  const data = await res.json();
  if (!res.ok) { console.error(JSON.stringify({ status: "error", http: res.status, ...data })); process.exit(1); }
  console.log(JSON.stringify(data, null, 2));
}

async function deleteSubdomain(name, args) {
  const opts = { project: null };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--project" && args[i + 1]) opts.project = args[++i];
  }
  const headers = {};
  if (opts.project) {
    const p = findProject(opts.project);
    headers["Authorization"] = `Bearer ${p.service_key}`;
  }
  const res = await fetch(`${API}/v1/subdomains/${encodeURIComponent(name)}`, {
    method: "DELETE",
    headers,
  });
  if (res.status === 204 || res.ok) {
    console.log(JSON.stringify({ status: "ok", message: `Subdomain '${name}' released.` }));
  } else {
    const data = await res.json().catch(() => ({}));
    console.error(JSON.stringify({ status: "error", http: res.status, ...data })); process.exit(1);
  }
}

async function list(projectId) {
  const p = findProject(projectId);
  const res = await fetch(`${API}/v1/subdomains`, {
    headers: { "Authorization": `Bearer ${p.service_key}` },
  });
  const data = await res.json();
  if (!res.ok) { console.error(JSON.stringify({ status: "error", http: res.status, ...data })); process.exit(1); }
  console.log(JSON.stringify(data, null, 2));
}

export async function run(sub, args) {
  if (!sub || sub === '--help' || sub === '-h') { console.log(HELP); process.exit(0); }
  switch (sub) {
    case "claim":  await claim(args[0], args[1], args.slice(2)); break;
    case "delete": await deleteSubdomain(args[0], args.slice(1)); break;
    case "list":   await list(args[0]); break;
    default:
      console.error(`Unknown subcommand: ${sub}\n`);
      console.log(HELP);
      process.exit(1);
  }
}
