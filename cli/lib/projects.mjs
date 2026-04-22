import { readFileSync } from "fs";
import { findProject, loadKeyStore, saveProject, removeProject, API, allowanceAuthHeaders, setActiveProjectId, getActiveProjectId, resolveProjectId } from "./config.mjs";

const HELP = `run402 projects — Manage your deployed Run402 projects

Usage:
  run402 projects <subcommand> [args...]

Subcommands:
  quote                                   Show pricing tiers
  provision [--tier <tier>] [--name <n>]  Provision a new Postgres project (pays via x402)
  use   <id>                              Set the active project (used as default for other commands)
  list                                    List all your projects (IDs, URLs, active marker)
  info  [id]                              Show project details: REST URL, keys
  keys  [id]                              Print anon_key and service_key as JSON
  sql   [id] "<query>" [--file <path>] [--params '<json>']  Run a SQL query (supports parameterized queries)
  rest  [id] <table> [params]             Query a table via the REST API (PostgREST)
  usage [id]                              Show compute/storage usage for a project
  schema [id]                             Inspect the database schema
  rls   [id] <template> <tables_json>     Apply Row-Level Security policies
  delete [id]                             Immediately and irreversibly delete a project (cascade purge) and remove from local state
  pin   [id]                              Pin a project (prevents expiry/GC)
  promote-user [id] <email>               Promote a user to project_admin role
  demote-user  [id] <email>               Demote a user from project_admin role

Examples:
  run402 projects quote
  run402 projects provision --tier prototype
  run402 projects provision --tier hobby --name my-app
  run402 projects use prj_abc123
  run402 projects list
  run402 projects info abc123
  run402 projects sql abc123 "SELECT * FROM users LIMIT 5"
  run402 projects sql abc123 "SELECT * FROM users WHERE id = $1" --params '[42]'
  run402 projects sql abc123 --file setup.sql
  run402 projects rest abc123 users "limit=10&select=id,name"
  run402 projects usage abc123
  run402 projects schema abc123
  run402 projects rls abc123 public_read_authenticated_write '[{"table":"posts"}]'
  run402 projects keys abc123
  run402 projects delete abc123

Notes:
  - <id> is the project_id shown in 'run402 projects list' (prefix: 'prj_')
  - Most commands that take <id> default to the active project when omitted
    (set it with 'run402 projects use <id>'). Project IDs start with 'prj_';
    any first positional that doesn't is treated as the next argument instead.
  - 'rest' uses PostgREST query syntax (table name + optional query string)
  - 'provision' requires a funded allowance — payment is automatic via x402
  - RLS templates (prefer user_owns_rows for user-scoped data):
      user_owns_rows                    users access only their own rows (requires owner_column)
      public_read_authenticated_write   anyone reads; any authenticated user writes any row
      public_read_write_UNRESTRICTED    fully open (anon_key writes); use 'run402 deploy' with a manifest
                                        that includes "i_understand_this_is_unrestricted": true
`;

const SUB_HELP = {
  provision: `run402 projects provision — Provision a new Postgres project

Usage:
  run402 projects provision [--tier <tier>] [--name <name>]

Options:
  --tier <tier>       Tier for the new project (default: prototype)
  --name <name>       Human-readable name for the project

Notes:
  - Payment is automatic via x402; requires a funded allowance
  - The new project becomes the active project after provisioning

Examples:
  run402 projects provision
  run402 projects provision --tier prototype
  run402 projects provision --tier hobby --name my-app
`,
  sql: `run402 projects sql — Run a SQL query against a project's database

Usage:
  run402 projects sql [id] "<query>" [options]
  run402 projects sql [id] --file <path> [options]

Arguments:
  [id]                Project ID (defaults to the active project if omitted;
                      must start with 'prj_' — any other first arg is treated
                      as the query instead)
  <query>             Inline SQL query (quote it to preserve spaces)

Options:
  --file <path>       Read SQL from a file instead of an inline query
  --params '<json>'   JSON array of parameters for a parameterized query

Examples:
  run402 projects sql abc123 "SELECT * FROM users LIMIT 5"
  run402 projects sql abc123 "SELECT * FROM users WHERE id = $1" --params '[42]'
  run402 projects sql abc123 --file setup.sql
`,
};

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
  const authHeaders = allowanceAuthHeaders("/projects/v1");
  const body = { tier: opts.tier };
  if (opts.name) body.name = opts.name;
  const res = await fetch(`${API}/projects/v1`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders },
    body: JSON.stringify(body),
  });
  // Content-type aware parsing: gateways (ALB, CloudFront, etc.) return HTML on
  // 502/504/etc., which would otherwise crash res.json() with SyntaxError (GH-84).
  const contentType = res.headers.get("content-type") || "";
  let data = null;
  let parseError = null;
  let bodyText = null;
  if (contentType.includes("application/json")) {
    try {
      data = await res.json();
    } catch (e) {
      parseError = e;
      try { bodyText = await res.text(); } catch { bodyText = ""; }
    }
  } else {
    try { bodyText = await res.text(); } catch { bodyText = ""; }
  }
  if (!res.ok || parseError || data === null) {
    const err = { status: "error", http: res.status, content_type: contentType || null };
    if (data && typeof data === "object") {
      Object.assign(err, data);
    } else {
      const preview = typeof bodyText === "string" ? bodyText.slice(0, 500) : "";
      err.body_preview = preview;
      if (parseError) err.parse_error = "response body was not valid JSON";
    }
    console.error(JSON.stringify(err));
    process.exit(1);
  }
  // Save project credentials locally and set as active
  if (data.project_id) {
    saveProject(data.project_id, {
      anon_key: data.anon_key, service_key: data.service_key,
      deployed_at: new Date().toISOString(),
    });
    setActiveProjectId(data.project_id);
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
  const activeId = store.active_project_id;
  console.log(JSON.stringify(entries.map(([id, p]) => ({ project_id: id, active: id === activeId, site_url: p.site_url, deployed_at: p.deployed_at })), null, 2));
}

async function info(projectId) {
  const p = findProject(projectId);
  console.log(JSON.stringify({
    project_id: projectId,
    rest_url: `${API}/rest/v1`,
    anon_key: p.anon_key,
    service_key: p.service_key,
    site_url: p.site_url || null,
    deployed_at: p.deployed_at || null,
  }, null, 2));
}

async function keys(projectId) {
  const p = findProject(projectId);
  console.log(JSON.stringify({ project_id: projectId, anon_key: p.anon_key, service_key: p.service_key }, null, 2));
}

async function sqlCmd(projectId, args = []) {
  const p = findProject(projectId);
  let file = null;
  let query = null;
  let paramsRaw = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--file" && args[i + 1]) { file = args[++i]; }
    else if (args[i] === "--params" && args[i + 1]) { paramsRaw = args[++i]; }
    else if (!query && !args[i].startsWith("--")) { query = args[i]; }
  }
  const sql = file ? readFileSync(file, "utf-8") : query;
  if (!sql) { console.error(JSON.stringify({ status: "error", message: "Missing SQL query. Provide inline or use --file <path>" })); process.exit(1); }
  let params;
  if (paramsRaw) {
    try { params = JSON.parse(paramsRaw); } catch { console.error(JSON.stringify({ status: "error", message: "Invalid JSON for --params. Expected a JSON array, e.g. '[42, \"hello\"]'" })); process.exit(1); }
    if (!Array.isArray(params)) { console.error(JSON.stringify({ status: "error", message: "--params must be a JSON array, e.g. '[42, \"hello\"]'" })); process.exit(1); }
  }
  const useParams = params && params.length > 0;
  const headers = { "Authorization": `Bearer ${p.service_key}`, "Content-Type": useParams ? "application/json" : "text/plain" };
  const body = useParams ? JSON.stringify({ sql, params }) : sql;
  const res = await fetch(`${API}/projects/v1/admin/${projectId}/sql`, { method: "POST", headers, body });
  const data = await res.json();
  if (!res.ok) { console.error(JSON.stringify({ status: "error", http: res.status, ...data })); process.exit(1); }
  console.log(JSON.stringify(data, null, 2));
}

async function rest(projectId, table, queryParams) {
  const p = findProject(projectId);
  const res = await fetch(`${API}/rest/v1/${table}${queryParams ? '?' + queryParams : ''}`, { headers: { "apikey": p.anon_key } });
  const data = await res.json();
  if (!res.ok) { console.error(JSON.stringify({ status: "error", http: res.status, ...data })); process.exit(1); }
  console.log(JSON.stringify(data, null, 2));
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

async function use(projectId) {
  if (!projectId) { console.error("Usage: run402 projects use <project_id>"); process.exit(1); }
  findProject(projectId); // verify it exists
  setActiveProjectId(projectId);
  console.log(JSON.stringify({ status: "ok", active_project_id: projectId }));
}

async function pin(projectId) {
  if (!projectId) { console.error(JSON.stringify({ status: "error", message: "Usage: run402 projects pin <project_id>" })); process.exit(1); }
  const p = findProject(projectId);
  const res = await fetch(`${API}/projects/v1/admin/${projectId}/pin`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${p.service_key}` },
  });
  const data = await res.json();
  if (!res.ok) { console.error(JSON.stringify({ status: "error", http: res.status, ...data })); process.exit(1); }
  console.log(JSON.stringify(data, null, 2));
}

async function promoteUser(projectId, email) {
  if (!email) { console.error(JSON.stringify({ status: "error", message: "Usage: run402 projects promote-user <project_id> <email>" })); process.exit(1); }
  const p = findProject(projectId);
  const res = await fetch(`${API}/projects/v1/admin/${projectId}/promote-user`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${p.service_key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ email }),
  });
  const data = await res.json();
  if (!res.ok) { console.error(JSON.stringify({ status: "error", http: res.status, ...data })); process.exit(1); }
  console.log(JSON.stringify(data, null, 2));
}

async function demoteUser(projectId, email) {
  if (!email) { console.error(JSON.stringify({ status: "error", message: "Usage: run402 projects demote-user <project_id> <email>" })); process.exit(1); }
  const p = findProject(projectId);
  const res = await fetch(`${API}/projects/v1/admin/${projectId}/demote-user`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${p.service_key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ email }),
  });
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

// Resolve a positional project_id argument with active-project fallback (GH-102).
// Heuristic: real project IDs start with "prj_". If args[0] is missing OR
// doesn't start with "prj_", fall back to the active project and return the
// full args array as remaining positionals. Otherwise consume args[0] as the
// project_id and return args.slice(1) as remaining positionals.
function resolvePositionalProject(args) {
  const first = Array.isArray(args) ? args[0] : undefined;
  if (typeof first === "string" && first.startsWith("prj_")) {
    return { projectId: first, rest: args.slice(1) };
  }
  return { projectId: resolveProjectId(null), rest: Array.isArray(args) ? args : [] };
}

export async function run(sub, args) {
  if (!sub || sub === '--help' || sub === '-h') {
    console.log(HELP);
    process.exit(0);
  }
  if (Array.isArray(args) && (args.includes("--help") || args.includes("-h"))) {
    console.log(SUB_HELP[sub] || HELP);
    process.exit(0);
  }
  switch (sub) {
    case "quote":     await quote(); break;
    case "provision": await provision(args); break;
    case "use":       await use(args[0]); break;
    case "list":      await list(); break;
    case "info":      { const { projectId } = resolvePositionalProject(args); await info(projectId); break; }
    case "keys":      { const { projectId } = resolvePositionalProject(args); await keys(projectId); break; }
    case "sql":       { const { projectId, rest } = resolvePositionalProject(args); await sqlCmd(projectId, rest); break; }
    case "rest":      { const { projectId, rest: restArgs } = resolvePositionalProject(args); await rest(projectId, restArgs[0], restArgs[1]); break; }
    case "usage":     { const { projectId } = resolvePositionalProject(args); await usage(projectId); break; }
    case "schema":    { const { projectId } = resolvePositionalProject(args); await schema(projectId); break; }
    case "rls":       { const { projectId, rest } = resolvePositionalProject(args); await rls(projectId, rest[0], rest[1]); break; }
    case "delete":    { const { projectId } = resolvePositionalProject(args); await deleteProject(projectId); break; }
    case "pin":       { const { projectId } = resolvePositionalProject(args); await pin(projectId); break; }
    case "promote-user": { const { projectId, rest } = resolvePositionalProject(args); await promoteUser(projectId, rest[0]); break; }
    case "demote-user":  { const { projectId, rest } = resolvePositionalProject(args); await demoteUser(projectId, rest[0]); break; }
    default:
      console.error(`Unknown subcommand: ${sub}\n`);
      console.log(HELP);
      process.exit(1);
  }
}
