import { findProject, loadKeyStore, saveProject, removeProject, API, walletAuthHeaders } from "./config.mjs";

const HELP = `run402 projects — Manage your deployed Run402 projects

Usage:
  run402 projects <subcommand> [args...]

Subcommands:
  quote                                   Show pricing tiers
  provision [--tier <tier>] [--name <n>]  Provision a new Postgres project (pays via x402)
  list                                    List all your projects (IDs, tiers, URLs, expiry)
  sql   <id> "<query>"                    Run a SQL query against a project's Postgres DB
  rest  <id> <table> [params]             Query a table via the REST API (PostgREST)
  usage <id>                              Show compute/storage usage for a project
  schema <id>                             Inspect the database schema
  rls   <id> <template> <tables_json>     Apply Row-Level Security policies
  delete <id>                             Delete a project and remove it from local state

Examples:
  run402 projects quote
  run402 projects provision --tier prototype
  run402 projects provision --tier hobby --name my-app
  run402 projects list
  run402 projects sql abc123 "SELECT * FROM users LIMIT 5"
  run402 projects rest abc123 users "limit=10&select=id,name"
  run402 projects usage abc123
  run402 projects schema abc123
  run402 projects rls abc123 public_read '[{"table":"posts"}]'
  run402 projects delete abc123

Notes:
  - <id> is the project_id shown in 'run402 projects list'
  - 'rest' uses PostgREST query syntax (table name + optional query string)
  - 'provision' requires a funded wallet — payment is automatic via x402
  - RLS templates: user_owns_rows, public_read, public_read_write
`;

async function quote() {
  const res = await fetch(`${API}/tiers/v1`);
  const data = await res.json();
  if (!res.ok) { console.error(JSON.stringify({ status: "error", http: res.status, ...data })); process.exit(1); }
  console.log(JSON.stringify(data, null, 2));
}

async function provision(args) {
  const opts = { tier: "prototype", name: undefined };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--tier" && args[i + 1]) opts.tier = args[++i];
    if (args[i] === "--name" && args[i + 1]) opts.name = args[++i];
  }
  const authHeaders = await walletAuthHeaders();
  const body = { tier: opts.tier };
  if (opts.name) body.name = opts.name;
  const res = await fetch(`${API}/projects/v1`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) { console.error(JSON.stringify({ status: "error", http: res.status, ...data })); process.exit(1); }
  // Save project credentials locally
  if (data.project_id) {
    saveProject(data.project_id, {
      anon_key: data.anon_key, service_key: data.service_key,
      tier: data.tier, lease_expires_at: data.lease_expires_at,
      deployed_at: new Date().toISOString(),
    });
  }
  console.log(JSON.stringify(data, null, 2));
}

async function rls(projectId, template, tablesJson) {
  const p = findProject(projectId);
  const tables = JSON.parse(tablesJson);
  const res = await fetch(`${API}/projects/v1/admin/${projectId}/rls`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${p.service_key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ template, tables }),
  });
  const data = await res.json();
  if (!res.ok) { console.error(JSON.stringify({ status: "error", http: res.status, ...data })); process.exit(1); }
  console.log(JSON.stringify(data, null, 2));
}

async function list() {
  const store = loadKeyStore();
  const entries = Object.entries(store.projects);
  if (entries.length === 0) { console.log(JSON.stringify({ status: "ok", projects: [], message: "No projects yet." })); return; }
  console.log(JSON.stringify(entries.map(([id, p]) => ({ project_id: id, tier: p.tier, site_url: p.site_url, lease_expires_at: p.lease_expires_at, deployed_at: p.deployed_at })), null, 2));
}

async function sqlCmd(projectId, query) {
  const p = findProject(projectId);
  const res = await fetch(`${API}/projects/v1/admin/${projectId}/sql`, { method: "POST", headers: { "Authorization": `Bearer ${p.service_key}`, "Content-Type": "text/plain" }, body: query });
  console.log(JSON.stringify(await res.json(), null, 2));
}

async function rest(projectId, table, queryParams) {
  const p = findProject(projectId);
  const res = await fetch(`${API}/rest/v1/${table}${queryParams ? '?' + queryParams : ''}`, { headers: { "apikey": p.anon_key } });
  console.log(JSON.stringify(await res.json(), null, 2));
}

async function usage(projectId) {
  const p = findProject(projectId);
  const res = await fetch(`${API}/projects/v1/admin/${projectId}/usage`, { headers: { "Authorization": `Bearer ${p.service_key}` } });
  const data = await res.json();
  if (!res.ok) { console.error(JSON.stringify({ status: "error", http: res.status, ...data })); process.exit(1); }
  console.log(JSON.stringify(data, null, 2));
}

async function schema(projectId) {
  const p = findProject(projectId);
  const res = await fetch(`${API}/projects/v1/admin/${projectId}/schema`, { headers: { "Authorization": `Bearer ${p.service_key}` } });
  const data = await res.json();
  if (!res.ok) { console.error(JSON.stringify({ status: "error", http: res.status, ...data })); process.exit(1); }
  console.log(JSON.stringify(data, null, 2));
}

async function deleteProject(projectId) {
  const p = findProject(projectId);
  const res = await fetch(`${API}/projects/v1/${projectId}`, { method: "DELETE", headers: { "Authorization": `Bearer ${p.service_key}` } });
  if (res.status === 204 || res.ok) {
    removeProject(projectId);
    console.log(JSON.stringify({ status: "ok", message: `Project ${projectId} deleted.` }));
  } else {
    const data = await res.json().catch(() => ({}));
    console.error(JSON.stringify({ status: "error", http: res.status, ...data })); process.exit(1);
  }
}

export async function run(sub, args) {
  if (!sub || sub === '--help' || sub === '-h') {
    console.log(HELP);
    process.exit(0);
  }
  switch (sub) {
    case "quote":     await quote(); break;
    case "provision": await provision(args); break;
    case "list":      await list(); break;
    case "sql":       await sqlCmd(args[0], args[1]); break;
    case "rest":      await rest(args[0], args[1], args[2]); break;
    case "usage":     await usage(args[0]); break;
    case "schema":    await schema(args[0]); break;
    case "rls":       await rls(args[0], args[1], args[2]); break;
    case "delete":    await deleteProject(args[0]); break;
    default:
      console.error(`Unknown subcommand: ${sub}\n`);
      console.log(HELP);
      process.exit(1);
  }
}
