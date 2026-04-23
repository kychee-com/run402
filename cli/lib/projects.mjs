import { readFileSync } from "fs";
import { findProject, loadKeyStore, API, allowanceAuthHeaders, resolveProjectId } from "./config.mjs";
import { getSdk } from "./sdk.mjs";
import { reportSdkError } from "./sdk-errors.mjs";

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
  rls   [id] <template> <tables_json>     ⚠ DEPRECATED (sunset 2026-05-23) - use 'apply-expose' instead
  apply-expose [id] <manifest_json>       Apply a declarative authorization manifest (supersedes 'rls')
  apply-expose [id] --file <path>         Apply a manifest from a JSON file
  get-expose   [id]                       Get the current authorization manifest
  delete [id]                             Immediately and irreversibly delete a project (cascade purge) and remove from local state
  pin   [id]                              Pin a project (admin only; project owners get 403 admin_required)
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
  run402 projects apply-expose abc123 --file manifest.json
  run402 projects get-expose abc123
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
  - 'rls' is deprecated (sunset 2026-05-23) — migrate to 'apply-expose'.
    The expose manifest declares the full authorization surface (tables, views,
    RPCs) in one convergent call. Tables not listed with expose:true are dark
    by default. Sample manifest:
      {"version":"1",
       "tables":[{"name":"posts","expose":true,"policy":"user_owns_rows","owner_column":"user_id","force_owner_on_insert":true}],
       "views":[],
       "rpcs":[]}
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
  try {
    const data = await getSdk().projects.getQuote();
    console.log(JSON.stringify(data, null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

async function provision(args) {
  const opts = { tier: "prototype", name: undefined };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--tier" && args[i + 1]) opts.tier = args[++i];
    if (args[i] === "--name" && args[i + 1]) opts.name = args[++i];
  }
  // Preserve the aggressive early exit when no allowance is configured —
  // gives the user a more specific prompt than the SDK's 401/402 path.
  allowanceAuthHeaders("/projects/v1");

  try {
    const data = await getSdk().projects.provision({ tier: opts.tier, name: opts.name });
    console.log(JSON.stringify(data, null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

async function rls(projectId, template, tablesJson) {
  let tables;
  try {
    tables = JSON.parse(tablesJson);
  } catch {
    console.error(JSON.stringify({ status: "error", message: "Invalid JSON for tables argument" }));
    process.exit(1);
  }
  try {
    const data = await getSdk().projects.setupRls(projectId, { template, tables });
    console.log(JSON.stringify(data, null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

async function applyExpose(projectId, args = []) {
  const p = findProject(projectId);
  let file = null;
  let inline = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--file" && args[i + 1]) { file = args[++i]; }
    else if (!inline && !args[i].startsWith("--")) { inline = args[i]; }
  }
  const raw = file ? readFileSync(file, "utf-8") : inline;
  if (!raw) {
    console.error(JSON.stringify({ status: "error", message: "Missing manifest. Provide inline JSON or use --file <path>" }));
    process.exit(1);
  }
  let manifest;
  try { manifest = JSON.parse(raw); }
  catch { console.error(JSON.stringify({ status: "error", message: "Invalid JSON for manifest" })); process.exit(1); }
  const res = await fetch(`${API}/projects/v1/admin/${projectId}/expose`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${p.service_key}`, "Content-Type": "application/json" },
    body: JSON.stringify(manifest),
  });
  const data = await res.json();
  if (!res.ok) { console.error(JSON.stringify({ status: "error", http: res.status, ...data })); process.exit(1); }
  console.log(JSON.stringify(data, null, 2));
}

async function getExpose(projectId) {
  const p = findProject(projectId);
  const res = await fetch(`${API}/projects/v1/admin/${projectId}/expose`, {
    headers: { "Authorization": `Bearer ${p.service_key}` },
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
  try {
    const data = await getSdk().projects.info(projectId);
    console.log(JSON.stringify({
      project_id: projectId,
      rest_url: `${API}/rest/v1`,
      anon_key: data.anon_key,
      service_key: data.service_key,
      site_url: data.site_url || null,
      deployed_at: data.deployed_at || null,
    }, null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

async function keys(projectId) {
  try {
    const data = await getSdk().projects.keys(projectId);
    console.log(JSON.stringify({ project_id: projectId, anon_key: data.anon_key, service_key: data.service_key }, null, 2));
  } catch (err) {
    reportSdkError(err);
  }
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
  try {
    const data = await getSdk().projects.getUsage(projectId);
    console.log(JSON.stringify(data, null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

async function schema(projectId) {
  try {
    const data = await getSdk().projects.getSchema(projectId);
    console.log(JSON.stringify(data, null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

async function use(projectId) {
  if (!projectId) { console.error("Usage: run402 projects use <project_id>"); process.exit(1); }
  try {
    await getSdk().projects.use(projectId);
    console.log(JSON.stringify({ status: "ok", active_project_id: projectId }));
  } catch (err) {
    reportSdkError(err);
  }
}

async function pin(projectId) {
  if (!projectId) { console.error(JSON.stringify({ status: "error", message: "Usage: run402 projects pin <project_id>" })); process.exit(1); }
  try {
    const data = await getSdk().projects.pin(projectId);
    console.log(JSON.stringify(data, null, 2));
  } catch (err) {
    reportSdkError(err);
  }
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
  try {
    await getSdk().projects.delete(projectId);
    console.log(JSON.stringify({ status: "ok", message: `Project ${projectId} deleted.` }));
  } catch (err) {
    reportSdkError(err);
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
    case "apply-expose": { const { projectId, rest } = resolvePositionalProject(args); await applyExpose(projectId, rest); break; }
    case "get-expose":   { const { projectId } = resolvePositionalProject(args); await getExpose(projectId); break; }
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
